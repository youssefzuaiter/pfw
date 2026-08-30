import { create } from "zustand";
import { zkVaultLock } from "../workers/zk-vault-worker-client";

/**
 * Tracks whether the zero-knowledge vault is unlocked for the current
 * browser session (AGENTS.md §3m, §3x) — no `persist` middleware, nothing
 * written to `localStorage`/`sessionStorage`. Reloading the page or
 * navigating away and back loses this on purpose: persisting anything
 * durable about a passphrase-derived unlock state would undercut the
 * reason this scheme exists.
 *
 * This store used to hold the derived `CryptoKey` itself. It no longer
 * does — the key now lives only inside `zk-crypto.worker.ts`'s own
 * memory (§3x), a separate V8 isolate that ordinary main-thread JS (this
 * store included) has no way to read. This store is now just the
 * main-thread-visible mirror of "is that worker's key currently active",
 * kept here (rather than plain component state) because several
 * unrelated components — `SecureNotesPanel`, `ContributionNote`,
 * `AddContributionForm` — all need to react to the same unlock/lock
 * transitions.
 */
type ZkVaultState = {
  unlocked: boolean;
  unlock: () => void;
  lock: () => void;
};

export const useZkVaultStore = create<ZkVaultState>((set) => ({
  unlocked: false,
  unlock: () => set({ unlocked: true }),
  lock: () => {
    void zkVaultLock();
    set({ unlocked: false });
  },
}));
