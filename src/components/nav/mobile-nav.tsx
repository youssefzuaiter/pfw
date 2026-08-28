"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isNavItemActive, MOBILE_MORE_ITEMS, MOBILE_PRIMARY_ITEMS } from "./nav-items";

// Deliberately narrow (real anchors/buttons only) — this dialog's content
// is fixed (a Close button + a grid of nav links), not arbitrary markup,
// so it doesn't need to handle every ARIA-focusable edge case.
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled])";

/** Mobile-only (hidden at the `md:` breakpoint and up) — see TopNav for desktop. */
export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // A real ARIA `dialog` is expected to (1) receive focus when it opens,
  // (2) trap Tab/Shift+Tab within itself while open, and (3) hand focus
  // back to whatever opened it on close — a Phase 7 keyboard-navigation
  // audit caught this drawer doing none of the three (focus stayed on
  // whatever was focused behind the overlay, and Tab could reach controls
  // hidden under it). All three are handled here rather than relying on
  // the overlay's visual coverage alone.
  useEffect(() => {
    if (!moreOpen) return;

    const dialogNode = dialogRef.current;
    const firstFocusable = dialogNode?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMore();
        return;
      }
      if (event.key !== "Tab" || !dialogNode) return;

      const focusable = Array.from(dialogNode.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moreOpen]);

  function openMore() {
    setMoreOpen(true);
  }

  function closeMore() {
    setMoreOpen(false);
    moreButtonRef.current?.focus();
  }

  const moreActive = MOBILE_MORE_ITEMS.some((item) => isNavItemActive(pathname, item.href));

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-20 flex items-end md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={closeMore}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="More navigation"
            className="relative w-full rounded-t-2xl border-t border-border bg-surface p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">More</p>
              <button
                type="button"
                onClick={closeMore}
                className="rounded-md px-2 py-1 text-sm font-medium text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>
            <ul className="grid grid-cols-2 gap-2">
              {MOBILE_MORE_ITEMS.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={closeMore}
                    className="block rounded-md border border-border px-3 py-2 text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {MOBILE_PRIMARY_ITEMS.map((item) => {
          const active = isNavItemActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <button
          ref={moreButtonRef}
          type="button"
          onClick={openMore}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={`flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            moreActive ? "text-accent" : "text-muted"
          }`}
        >
          More
        </button>
      </nav>
    </>
  );
}
