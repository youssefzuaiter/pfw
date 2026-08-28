/**
 * Blocking inline script that applies a stored theme preference before
 * first paint, avoiding a flash of the wrong theme on reload. This is
 * the ONE place in the app allowed to use `dangerouslySetInnerHTML`
 * (tests/guards/no-dangerous-html.test.ts allowlists this exact file) —
 * the content is a hardcoded string literal with zero dynamic
 * interpolation of any request/user data, so there is nothing here an
 * attacker could ever control; the guard's purpose (stopping unsanitized
 * data from becoming executable HTML) doesn't apply to a static literal.
 *
 * `nonce` comes from the CSP nonce infrastructure in src/proxy.ts — see
 * AGENTS.md §3 for why the root layout has to be dynamically rendered
 * for this nonce to actually reach the script tag.
 */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = window.localStorage.getItem("pfw-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {}
})();
`;

export function ThemeInitScript({ nonce }: { nonce: string | undefined }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
}
