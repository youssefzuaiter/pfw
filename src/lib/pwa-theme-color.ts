/**
 * The PWA's `<meta name="theme-color">` value (`src/app/layout.tsx`'s
 * `viewport` export) and `public/manifest.json`'s `theme_color`/
 * `background_color` all need to agree, and none of the three can read
 * `globals.css`'s `--pfw-*` custom properties — a meta tag and a static
 * JSON manifest are both evaluated with no CSS context at all, the same
 * reasoning `src/server/email/auth-emails.ts` already documents for why
 * it's the one other allowed exception in
 * `tests/guards/no-untokenized-hex.test.ts`. Kept in its own narrow file
 * (rather than allowlisting all of `layout.tsx`) so the guard still
 * protects everything else in that file.
 *
 * This is the app's actual dark-navy brand color (`--pfw-bg`'s dark
 * value), not `/trading`'s separately-fixed neutral palette — a PWA's
 * theme color applies to the whole installed app, not one subtree.
 * `manifest.json` can't import this constant (it's static JSON, not
 * TypeScript) — update both by hand if this ever changes.
 */
export const PWA_THEME_COLOR = "#080e1c";
