// Minimal ambient augmentation of next-auth's `User` type — the officially
// documented Auth.js pattern for extending its types (module augmentation,
// not a custom wrapper type), covering exactly the one field this app's
// `authorize()`/`jwt()` callbacks actually pass through
// (`src/server/auth/auth.ts`, Punch List Tier 2 item 2's server-side JWT
// revocation). `next-auth`'s own `JWT`/`Session["user"]` types already
// carry a `[key: string]: unknown` index signature (verified against the
// installed package's own `.d.ts` before relying on it — see auth.ts's own
// doc comment), so only `User` — which has no such index signature —
// needs augmenting here for `authorize()`'s return object to type-check
// without a cast.
import "next-auth";

declare module "next-auth" {
  interface User {
    tokenVersion?: number;
  }
}
