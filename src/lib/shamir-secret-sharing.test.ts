import { describe, expect, it } from "vitest";
import { combineShares, decodeShare, encodeShare, splitSecret, type Share } from "./shamir-secret-sharing";

function textSecret(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function textFromSecret(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function subset<T>(items: T[], indices: number[]): T[] {
  return indices.map((i) => items[i]);
}

describe("splitSecret / combineShares", () => {
  it("reconstructs the exact secret from exactly `threshold` shares", () => {
    const secret = textSecret("the master vault key material, 32 bytes-ish");
    const shares = splitSecret(secret, 5, 3);

    const reconstructed = combineShares(subset(shares, [0, 2, 4]));
    expect(textFromSecret(reconstructed)).toBe(textFromSecret(secret));
  });

  it("reconstructs correctly from any distinct subset of `threshold` shares, not just one", () => {
    const secret = textSecret("emergency-vault-master-key-00000000000000");
    const shares = splitSecret(secret, 6, 4);

    const subsetsToTry = [
      [0, 1, 2, 3],
      [2, 3, 4, 5],
      [0, 2, 4, 5],
      [1, 3, 4, 5],
    ];
    for (const indices of subsetsToTry) {
      expect(textFromSecret(combineShares(subset(shares, indices)))).toBe(textFromSecret(secret));
    }
  });

  it("reconstructs correctly with MORE than threshold shares supplied", () => {
    const secret = textSecret("more-shares-than-strictly-needed");
    const shares = splitSecret(secret, 5, 3);

    expect(textFromSecret(combineShares(shares))).toBe(textFromSecret(secret));
  });

  it("produces the WRONG secret (not a thrown error) from fewer than threshold shares — the information-theoretic security property", () => {
    const secret = textSecret("insufficient-shares-must-not-leak-this");
    const shares = splitSecret(secret, 5, 3);

    const reconstructed = combineShares(subset(shares, [0, 1]));
    expect(textFromSecret(reconstructed)).not.toBe(textFromSecret(secret));
  });

  it("never throws on an insufficient set of shares, across many independent attempts — regression for an odd-length-hex crash in the reconstructed-secret decode path", () => {
    // secrets.js-grempe strips a leading marker bit on combine(); for a
    // WRONG reconstruction (too few real shares) that strip doesn't
    // necessarily land on a byte boundary, which used to make this
    // module's own hex decoder throw instead of just returning garbage
    // bytes. Repeated with fresh randomness each time since the failure
    // was intermittent (only odd-length output triggered it).
    for (let attempt = 0; attempt < 50; attempt++) {
      const secret = textSecret(`attempt-${attempt}-some secret bytes`);
      const shares = splitSecret(secret, 5, 3);
      expect(() => combineShares(subset(shares, [0, 1]))).not.toThrow();
    }
  });

  it("works for a single-byte secret and arbitrary binary content, including a leading zero byte", () => {
    const secret = new Uint8Array([0, 1, 255, 128, 42]);
    const shares = splitSecret(secret, 3, 2);
    const reconstructed = combineShares(subset(shares, [0, 2]));
    expect(Array.from(reconstructed)).toEqual(Array.from(secret));
  });

  it("generates exactly totalShares shares with distinct ids between 1 and totalShares", () => {
    const shares = splitSecret(textSecret("x"), 7, 4);
    expect(shares).toHaveLength(7);
    expect(new Set(shares.map((s) => s.index)).size).toBe(7);
    for (const share of shares) {
      expect(share.index).toBeGreaterThanOrEqual(1);
      expect(share.index).toBeLessThanOrEqual(7);
    }
  });

  it("every real-32-byte-vault-key share comes out the same fixed length regardless of key content — no differential size leakage in this app's actual usage", () => {
    const keyA = new Uint8Array(32).fill(0);
    const keyB = crypto.getRandomValues(new Uint8Array(32));
    const lengthsA = splitSecret(keyA, 5, 3).map((s) => s.value.length);
    const lengthsB = splitSecret(keyB, 5, 3).map((s) => s.value.length);
    expect(new Set([...lengthsA, ...lengthsB]).size).toBe(1);
  });

  it("rejects an empty secret", () => {
    expect(() => splitSecret(new Uint8Array(0), 3, 2)).toThrow(RangeError);
  });

  it.each([
    [1, 2],
    [256, 2],
    [1.5, 2],
  ])("rejects an invalid totalShares=%p threshold=%p", (totalShares, threshold) => {
    expect(() => splitSecret(textSecret("x"), totalShares, threshold)).toThrow(RangeError);
  });

  it("rejects a threshold greater than totalShares", () => {
    expect(() => splitSecret(textSecret("x"), 3, 4)).toThrow(RangeError);
  });

  it("rejects threshold < 2 (a 1-of-N 'share' would just be the secret in disguise)", () => {
    expect(() => splitSecret(textSecret("x"), 3, 1)).toThrow(RangeError);
  });

  it("combineShares rejects fewer than 2 shares", () => {
    expect(() => combineShares([{ index: 1, value: new Uint8Array([1]) }])).toThrow(RangeError);
  });

  it("combineShares rejects duplicate share indices", () => {
    const a: Share = { index: 1, value: new Uint8Array([1, 2]) };
    const b: Share = { index: 1, value: new Uint8Array([3, 4]) };
    expect(() => combineShares([a, b])).toThrow(RangeError);
  });
});

describe("encodeShare / decodeShare", () => {
  it("round-trips a share through encode/decode", () => {
    const share: Share = { index: 42, value: new Uint8Array([0, 1, 2, 254, 255]) };
    const decoded = decodeShare(encodeShare(share));
    expect(decoded.index).toBe(share.index);
    expect(Array.from(decoded.value)).toEqual(Array.from(share.value));
  });

  it("round-trips real split shares through encode/decode and still reconstructs", () => {
    const secret = textSecret("round-trip-through-strings");
    const shares = splitSecret(secret, 5, 3);
    const encoded = shares.map(encodeShare);
    const decoded = encoded.map(decodeShare);
    expect(textFromSecret(combineShares(subset(decoded, [0, 1, 2])))).toBe(textFromSecret(secret));
  });

  it("tolerates surrounding whitespace (a beneficiary pasting from an email/note)", () => {
    const share: Share = { index: 1, value: new Uint8Array([9, 9, 9]) };
    const decoded = decodeShare(`  ${encodeShare(share)}  \n`);
    expect(decoded.index).toBe(1);
  });

  it("rejects a malformed string", () => {
    expect(() => decodeShare("not-a-share-at-all")).toThrow(RangeError);
  });

  it("rejects the wrong format version", () => {
    const share: Share = { index: 1, value: new Uint8Array([1, 2, 3]) };
    const encoded = encodeShare(share).replace("dms-share1", "dms-share2");
    expect(() => decodeShare(encoded)).toThrow(RangeError);
  });

  it("rejects a tampered/corrupted value (checksum mismatch)", () => {
    const share: Share = { index: 1, value: new Uint8Array([1, 2, 3, 4]) };
    const encoded = encodeShare(share);
    const parts = encoded.split(":");
    // Flip a character mid-string (not the last character of the value
    // segment, which can land on a base64 padding bit that doesn't
    // actually change the decoded bytes).
    const middle = Math.floor(parts[2].length / 2);
    const flipped = parts[2][middle] === "A" ? "B" : "A";
    parts[2] = parts[2].slice(0, middle) + flipped + parts[2].slice(middle + 1);
    expect(() => decodeShare(parts.join(":"))).toThrow(/checksum/i);
  });

  it("rejects an out-of-range index", () => {
    expect(() => encodeShare({ index: 0, value: new Uint8Array([1]) })).toThrow(RangeError);
    expect(() => encodeShare({ index: 256, value: new Uint8Array([1]) })).toThrow(RangeError);
  });
});
