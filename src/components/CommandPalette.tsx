"use client";

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "cmdk";
import { setNonce } from "get-nonce";
import { ArrowLeftRight, LineChart, PiggyBank, Radar, Receipt, TrendingUp, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type PaletteDestination = {
  href: string;
  label: string;
  icon: LucideIcon;
};

// Same six destinations the dashboard's own quick-links grid surfaces
// (`src/app/(finance)/dashboard/_components/quick-links-grid.tsx`),
// same icon per destination — one visual vocabulary for "this icon means
// this screen" everywhere it appears, not a second, different mapping
// here.
const DESTINATIONS: PaletteDestination[] = [
  { href: "/budgets", label: "Budget", icon: PiggyBank },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/transactions/subscriptions", label: "Subscriptions", icon: Radar },
  { href: "/trading", label: "Trading", icon: LineChart },
  { href: "/analytics", label: "Retirement", icon: TrendingUp },
  { href: "/trading/tax", label: "Tax", icon: Receipt },
];

/**
 * Global `Cmd+K` (`Ctrl+K` on non-Mac) command palette, mounted once in
 * the root layout so it's reachable from both the `(finance)` and
 * `/trading` shells alike. Routing-only for now, per the Phase 2 ask —
 * no fuzzy action registry beyond the six named destinations.
 */
export function CommandPalette({ nonce }: { nonce?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // The dialog's underlying `react-remove-scroll` body-scroll-lock
  // injects a `<style>` tag at open time — this app's strict CSP has no
  // `style-src 'unsafe-inline'`, so that tag needs the same per-request
  // nonce `ThemeInitScript` already receives from `headers()` in the
  // root layout, or the browser silently drops the whole rule (verified
  // against `react-style-singleton`'s own source, which reads exactly
  // this `get-nonce` global before falling back to no nonce at all).
  useEffect(() => {
    if (nonce) setNonce(nonce);
  }, [nonce]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function navigateTo(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      contentClassName="fixed left-1/2 top-24 z-50 w-full max-w-md -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
    >
      <CommandInput
        placeholder="Jump to…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-muted"
      />
      <CommandList className="max-h-80 overflow-y-auto p-2">
        <CommandEmpty className="px-2 py-6 text-center text-sm text-muted">No matching screen.</CommandEmpty>
        <CommandGroup heading="Go to" className="text-xs font-medium uppercase tracking-wide text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          {DESTINATIONS.map((destination) => {
            const Icon = destination.icon;
            return (
              <CommandItem
                key={destination.href}
                value={destination.label}
                onSelect={() => navigateTo(destination.href)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-fg aria-selected:bg-accent/10 aria-selected:text-accent"
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {destination.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
