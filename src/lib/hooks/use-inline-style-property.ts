"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Sets one CSS property on `ref.current` imperatively through the CSSOM
 * (`element.style.setProperty`) instead of React's `style` prop.
 *
 * Why this exists (AGENTS.md §3x): this app's CSP (src/proxy.ts) carries
 * no `unsafe-inline` for `style-src`, and CSP's inline-style restriction
 * is enforced against the HTML `style="..."` ATTRIBUTE specifically —
 * which is exactly what React's `style` prop becomes in the
 * server-rendered HTML this app ships for every first paint (there's no
 * CSSOM on the server to set a property through instead). The nonce on
 * `style-src` only ever covers `<style>` elements, never that attribute;
 * CSP3's one attribute-level opt-in, `'unsafe-hashes'`, can't help here
 * either, since these values (a live upload/OCR progress percentage, a
 * portfolio allocation share) change on every render and can't be
 * pre-hashed. Verified by hand with a real browser (a plain `style=`
 * HTML attribute IS blocked under this policy; `element.style.property =
 * value` from already-trusted, already-loaded script is NOT — CSP has no
 * hook into CSSOM property assignment at all) — this hook is that second,
 * unblocked path, and the standard escape hatch for genuinely dynamic
 * inline styling under a strict CSP.
 */
export function useInlineStyleProperty<T extends HTMLElement>(
  ref: RefObject<T | null>,
  property: string,
  value: string,
): void {
  useLayoutEffect(() => {
    ref.current?.style.setProperty(property, value);
  }, [ref, property, value]);
}
