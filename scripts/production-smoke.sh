#!/usr/bin/env bash
# Post-deploy smoke check for a live PFW deployment (AGENTS.md §3yy).
#
#   scripts/production-smoke.sh https://pfw-xxxx-youssev-s-team.vercel.app
#
# CI proves the code; this proves the DEPLOYMENT — the one thing
# `npm run check` structurally cannot: a build that passes every test can
# still be broken on the live site by an env var that is missing, rotated,
# or mis-scoped in the Vercel dashboard (§3pp's stated gap). Every check
# below is something an env-var problem would break first, and every
# check is unauthenticated on purpose: this script holds no session, no
# secret, nothing — it only ever asks the questions any visitor could.
#
# Exit code is the verdict (0 = healthy), so a workflow fails when the
# deployment does. Plain bash + curl: no dependencies, runnable by hand.
set -u

if [ $# -ne 1 ]; then
  echo "usage: $0 <deployment-url>" >&2
  exit 2
fi
BASE="${1%/}"
FAILED=0
CURL=(curl --silent --show-error --max-time 30 --location-trusted)

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }

echo "Smoke-testing $BASE"

# 1. The readiness probe: a real SELECT 1 through the DAL, so this is the
#    database URL, the runtime role and its password all working together.
body=$("${CURL[@]}" -w '\n%{http_code}' "$BASE/api/health/ready" 2>&1)
code=${body##*$'\n'}; body=${body%$'\n'*}
if [ "$code" = "200" ] && [[ "$body" == *'"status":"ok"'* ]]; then
  pass "/api/health/ready → 200 {\"status\":\"ok\"} (database reachable)"
else
  fail "/api/health/ready → HTTP $code, body: ${body:0:200}"
fi

# 2. A public page renders (the whole Next runtime, fonts, env-derived
#    config) and the per-request CSP nonce is stamped — AUTH_SECRET and
#    the CSP proxy both had to work for this line to exist.
headers=$("${CURL[@]}" -D - -o /tmp/pfw-smoke-login.html "$BASE/login" 2>&1)
code=$(printf '%s' "$headers" | awk 'toupper($1) ~ /^HTTP\// {c=$2} END {print c}')
if [ "$code" = "200" ] && grep -q "Sign in" /tmp/pfw-smoke-login.html; then
  pass "/login → 200 and renders the sign-in form"
else
  fail "/login → HTTP $code (or no sign-in form in the body)"
fi
if printf '%s' "$headers" | grep -qi "^content-security-policy:.*'nonce-"; then
  pass "CSP header present with a per-request nonce"
else
  fail "CSP header missing or without a nonce"
fi
rm -f /tmp/pfw-smoke-login.html

# 3. The auth gate is alive: a protected page redirects to /login, and a
#    protected API answers 401, never 200 — a regression here would mean
#    the proxy's allowlist or session verification is broken.
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' --max-redirs 0 "$BASE/dashboard" 2>/dev/null)
loc=$("${CURL[@]}" -o /dev/null -w '%{redirect_url}' --max-redirs 0 "$BASE/dashboard" 2>/dev/null)
if [ "$code" = "307" ] && [[ "$loc" == *"/login"* ]]; then
  pass "/dashboard unauthenticated → 307 to /login"
else
  fail "/dashboard unauthenticated → HTTP $code → '$loc' (expected 307 to /login)"
fi
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/notifications" 2>/dev/null)
if [ "$code" = "401" ]; then
  pass "/api/notifications unauthenticated → 401"
else
  fail "/api/notifications unauthenticated → HTTP $code (expected 401)"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "SMOKE CHECK FAILED for $BASE" >&2
  exit 1
fi
echo "Smoke check passed for $BASE"
