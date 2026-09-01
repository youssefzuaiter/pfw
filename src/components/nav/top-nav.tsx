"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "../theme/theme-toggle";
import { isNavItemActive, PRIMARY_NAV_ITEMS } from "./nav-items";
import { SignOutButton } from "./sign-out-button";

/** Desktop-only (`md:` breakpoint and up) — see MobileNav for the small-screen equivalent. */
export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 hidden border-b border-border bg-surface/80 backdrop-blur md:block">
      <nav aria-label="Primary" className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <Link
          href="/dashboard"
          className="rounded-md font-display text-lg font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          PFW
        </Link>
        <ul className="flex flex-1 items-center gap-1 text-sm font-medium">
          {PRIMARY_NAV_ITEMS.map((item) => {
            const active = isNavItemActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? "bg-accent/10 text-accent" : "text-muted hover:text-fg"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <Link
          href="/settings"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Settings
        </Link>
        <SignOutButton />
        <ThemeToggle />
      </nav>
    </header>
  );
}
