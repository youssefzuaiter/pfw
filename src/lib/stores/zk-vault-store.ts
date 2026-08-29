import { create } from "zustand";

/**
 * Holds the derived zero-knowledge key for the current browser session
 * only (AGENTS.md §3m) — no `persist` middleware, nothing written to
 * `localStorage`/`sessionStorage`. Reloading the page or navigating away
 * and back loses the key on purpose: persisting a key derived from a
 * master passphrase anywhere durable would undercut the reason this
 * scheme exists. The `CryptoKey` itself is also non-extractable
 * (`src/lib/zk-crypto.ts`'s `deriveZkKey`), so even code that could read
 * this store can use the key to encrypt/decrypt but can never pull the
 * raw key bytes back out of it.
 */
type ZkVaultState = {
  key: CryptoKey | null;
  unlock: (key: CryptoKey) => void;
  lock: () => void;
};

export const useZkVaultStore = create<ZkVaultState>((set) => ({
  key: null,
  unlock: (key) => set({ key }),
  lock: () => set({ key: null }),
}));
