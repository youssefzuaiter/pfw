"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";

const MAX_TILT_DEGREES = 8;

function supportsTilt(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  );
}

/**
 * CSS 3D tilt (spec Section 5's "3D Rules"): max 8 degrees, gated to
 * `(hover: hover) and (pointer: fine)` AND `prefers-reduced-motion:
 * no-preference`. Both gates are re-checked on every pointer move rather
 * than once at mount, since neither a touch/coarse-pointer device nor a
 * reduced-motion preference can be relied on to stay fixed for the
 * component's lifetime, and — unlike a CSS animation or transition — a
 * JS pointermove handler keeps firing regardless of any `@media` query,
 * so the gate has to live in the handler itself, before any transform is
 * ever applied.
 *
 * Never wrap a card that shows a live financial figure being read —
 * only category names, calls-to-action, or other non-numeric chrome.
 */
export function TiltCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  const cardRef = useRef<HTMLDivElement>(null);

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const card = cardRef.current;
    if (!card || !supportsTilt()) return;

    const rect = card.getBoundingClientRect();
    const relativeX = (event.clientX - rect.left) / rect.width - 0.5;
    const relativeY = (event.clientY - rect.top) / rect.height - 0.5;
    const rotateY = relativeX * MAX_TILT_DEGREES * 2;
    const rotateX = -relativeY * MAX_TILT_DEGREES * 2;
    card.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  }

  function handlePointerLeave() {
    if (cardRef.current) cardRef.current.style.transform = "";
  }

  return (
    <div className="uv-tilt-wrapper">
      <div
        ref={cardRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        className={`uv-tilt-card ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
