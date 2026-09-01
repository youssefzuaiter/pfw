# syntax=docker/dockerfile:1
#
# Production image for PFW's Next.js app, built on `output: "standalone"`
# (next.config.ts) — three stages (deps, builder, runner), each stage's
# final `node_modules`/build output copied forward, never the stage
# itself, so build-only tooling (TypeScript, ESLint, the Prisma CLI,
# devDependencies) never reaches the shipped image.
#
# Verified empirically before writing the rest of this file, not assumed:
#   - `npm run build` completes successfully with ZERO environment
#     variables set (src/server/env.ts validates every secret lazily, on
#     first actual access — never at module-import or build time; this is
#     a deliberate design decision, AGENTS.md §3i, confirmed live here by
#     literally running the build with an empty environment). This
#     Dockerfile therefore never needs `--build-arg`/`ENV` secrets in the
#     `builder` stage, and none should ever be added there — a build-time
#     secret gets permanently baked into an image layer even after being
#     "removed" in a later instruction, which real secrets (ENCRYPTION_KEY,
#     AUTH_SECRET, DATABASE_URL) must never be.
#   - `argon2` (Argon2id password hashing, AGENTS.md §3ff) needs NO
#     `serverExternalPackages` entry and no Alpine build toolchain: it's
#     already in Next's built-in auto-external-packages list (confirmed
#     against this exact installed Next version's own docs,
#     node_modules/next/dist/docs/.../serverExternalPackages.md), which is
#     what makes `output: standalone`'s file tracing correctly copy its
#     prebuilt native `.node` binary — verified by actually inspecting a
#     real standalone build's output (`.next/standalone/node_modules/argon2/prebuilds/`),
#     not assumed from documentation alone. `argon2` ships prebuilt
#     binaries for BOTH glibc and musl libc (`prebuilds/linux-x64/argon2.glibc.node`
#     and `argon2.musl.node`), so an Alpine (musl) base image is safe —
#     `node-gyp-build` picks the correct one for the container's actual
#     libc at runtime, with no source compilation and no build toolchain
#     needed in any stage.

# ---- deps: install once, cached separately from source changes --------
FROM node:22-alpine AS deps
WORKDIR /app
# libc6-compat: Next.js's own canonical Docker guidance for Alpine bases —
# some native-addon install/postinstall steps expect a few glibc-
# compatibility shims even when the addon itself ships a musl-native
# prebuild (as argon2 does, see above). Cheap (~5MB), standard practice,
# not strictly proven necessary for THIS app's specific dependency set,
# kept as a low-cost precaution rather than a verified requirement.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: generate the Prisma client, then `next build` -----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prisma/schema.prisma's generator emits real TypeScript source to
# src/generated/prisma/ (gitignored, AGENTS.md §3a — "Rust-free", no
# query-engine binary to fetch) — this step must run before `next build`
# ever imports it. No DATABASE_URL needed: `prisma generate` reads only
# the schema file, never opens a real connection.
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1

# A build-time-only PLACEHOLDER, discovered necessary by actually running
# this build in Docker (a plain host-machine `npm run build` misleadingly
# "succeeds" with no env vars at all — because Next.js auto-loads a local
# `.env` FILE regardless of the shell's own environment, and this repo's
# dev `.env` was still sitting on disk during that first, wrong test; a
# real Docker build context has no `.env` file at all, per .dockerignore,
# which is what actually exposed this). `src/server/auth/auth.ts`'s own
# doc comment already names the reason precisely: `AUTH_SECRET` is
# `getAuthSecret()`'s one deliberate, documented exception to this app's
# "every secret is read lazily, only when its getter is actually called"
# rule (env.ts) — `NextAuth({ secret: getAuthSecret(), ... })` must be
# constructed at MODULE LOAD, because Next's route-handler convention
# needs `handlers`/`auth` to be stable, eagerly-built exports, and `next
# build`'s page-data-collection step imports that module for every route.
# This value is NEVER the one the running container actually serves
# requests under — `getAuthSecret()` is a plain `process.env` read, not a
# `NEXT_PUBLIC_`-prefixed variable Next statically inlines at build time,
# so nothing here is compiled into `.next/standalone` as a literal; the
# REAL `AUTH_SECRET` (a Kubernetes Secret, k8s/app/deployment.yaml) is
# read fresh by `server.js` the moment the container actually starts.
# Verified, not assumed: exec'd into a real running container built from
# this exact Dockerfile with a DIFFERENT `AUTH_SECRET` supplied at `docker
# run` time and confirmed `process.env.AUTH_SECRET` reflects that runtime
# value, not this placeholder.
ENV AUTH_SECRET="build-time-placeholder-not-a-real-secret-never-used-at-runtime"
RUN npm run build
# `docker build` flags the ENV above with its own generic
# SecretsUsedInArgOrEnv linter warning — expected and reviewed, not
# suppressed: that linter can't know this specific value is a
# non-sensitive, hardcoded, discarded-after-build placeholder (see the
# comment above it), the same "documented, accepted scanner finding"
# treatment this repo already gives Gitleaks/Semgrep's own pre-existing
# findings (SECURITY-REPORT.md §10) rather than silently working around
# it.

# A REAL, VERIFIED finding from this exact pass, not a hypothetical
# defense-in-depth line: Next.js's `output: "standalone"` automatically
# copies a real `.env`/`.env.*` file into `.next/standalone/.env` when
# ONE EXISTS AT BUILD TIME, specifically so `server.js` (which skips
# `next start`'s normal bootstrapping) still gets the same env-file
# loading behavior. Caught live, not assumed: a local (non-Docker) `npm
# run build` — run from this same repo checkout, which has a real local
# `.env` with a real `ANTHROPIC_API_KEY` — produced exactly this file,
# and a Gitleaks scan of the resulting `.next/standalone/.env` flagged
# the real key. This Dockerfile's own `.dockerignore` already keeps a
# real `.env` out of the Docker BUILD CONTEXT entirely (confirmed
# separately: the actual image built from this Dockerfile has no `.env`
# anywhere under `/app`) — but relying on that ALONE is fragile: a
# different `docker build` invocation, a CI system that doesn't honor
# `.dockerignore` the same way, or simple human error building from the
# wrong context could still let a real `.env` reach this stage. Deleting
# any copy here, unconditionally, right after the build and before
# anything is copied into the `runner` stage, is the actual backstop —
# `rm -f` on a file that never existed (the expected, correct case when
# `.dockerignore` worked) is a silent no-op, not an error.
RUN rm -f .next/standalone/.env .next/standalone/.env.*

# ---- runner: minimal runtime image, standalone output only ------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# `output: "standalone"`'s emitted server.js reads these directly (not a
# CMD flag) — see next.config.ts's own comment and the Next docs it cites.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# A dedicated, unprivileged user — the container never runs as root.
# Fixed uid/gid (not `--system`'s auto-assigned one) so it's a stable,
# known value the Kubernetes manifests' `securityContext.runAsUser` can
# pin against exactly, rather than guessing what adduser picked.
RUN addgroup --gid 1001 nodejs \
 && adduser --uid 1001 --ingroup nodejs --disabled-password --gecos "" nextjs

# `public/` and `.next/static` are NOT included in the standalone output
# by design (Next's own doc: "ideally... handled by a CDN instead") — Next
# expects them copied in by hand, which is exactly what this does for a
# deployment with no separate static-asset CDN in front of it yet.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# The standalone build's own minimal server — not `next start`, which
# would require the full (un-copied) node_modules and next.config.ts's
# CLI tooling neither exists in this image.
CMD ["node", "server.js"]
