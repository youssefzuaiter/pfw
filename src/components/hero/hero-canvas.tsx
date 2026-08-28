"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HeroFallback } from "./hero-fallback";
import { supportsWebGL } from "./supports-webgl";

// R3F/three touch `window`/WebGL at module scope, so this must never be
// part of the server render — `ssr: false` keeps it out of the RSC
// payload entirely rather than rendering-then-discarding it.
const HeroScene = dynamic(() => import("./hero-scene").then((mod) => mod.HeroScene), { ssr: false });

function subscribeToReducedMotionChange(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// The server can't know either of these — no `window`, no real display —
// so both server snapshots fail safe toward the static gradient rather
// than toward spinning up a 3D scene. `useSyncExternalStore` (not an
// effect + setState, same reasoning as ThemeToggle) is what lets the
// client's first hydration pass reuse this same safe value with no
// hydration-mismatch warning, then immediately re-render with the real
// client-detected value right after.
function getReducedMotionServerSnapshot(): boolean {
  return true;
}

// WebGL support never changes over a page's lifetime, so this "store"
// never notifies — it exists purely to get the same safe
// server-snapshot/client-snapshot split as reduced-motion above, via the
// same sanctioned API instead of an effect + setState.
function subscribeNever() {
  return () => {};
}

function getWebglSnapshot(): boolean {
  return supportsWebGL();
}

function getWebglServerSnapshot(): boolean {
  return false;
}

/**
 * The entry-surface hero. Renders the R3F particle scene only when all of
 * the following hold, falling back to a static CSS gradient otherwise:
 *  - client-hydrated (avoids any SSR/hydration mismatch around window/WebGL)
 *  - `prefers-reduced-motion: reduce` is NOT set
 *  - the browser actually supports WebGL
 * Even when mounted, the scene only *animates* (calls `invalidate()`) while
 * an IntersectionObserver reports it's actually in the viewport — see
 * ParticleField.
 */
export function HeroCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotionChange,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
  const webglOk = useSyncExternalStore(subscribeNever, getWebglSnapshot, getWebglServerSnapshot);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), {
      threshold: 0.01,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const showStaticFallback = reducedMotion || !webglOk;

  return (
    <div ref={containerRef} className="h-full w-full">
      {showStaticFallback ? <HeroFallback /> : <HeroScene active={isVisible} />}
    </div>
  );
}
