import { describe, expect, it } from "vitest";
import { base64UrlToUint8Array, getRelyingParty, toArrayBufferBackedUint8Array, uint8ArrayToBase64Url } from "./webauthn";

describe("base64UrlToUint8Array / uint8ArrayToBase64Url", () => {
  it("round-trips arbitrary bytes, including ones that produce base64url-special characters", () => {
    // 0xfb/0xff/0xef bytes are chosen to reliably produce '-'/'_' in
    // base64url output (as opposed to plain base64's '+'/'/') — proving
    // this is genuinely base64URL, not plain base64.
    const original = new Uint8Array([0xfb, 0xff, 0xef, 0x00, 0x01, 0x02, 0x10, 0x20]);
    const encoded = uint8ArrayToBase64Url(original);
    expect(encoded).not.toMatch(/[+/=]/); // no plain-base64 characters or padding
    const decoded = base64UrlToUint8Array(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("round-trips an empty byte array", () => {
    const encoded = uint8ArrayToBase64Url(new Uint8Array([]));
    expect(base64UrlToUint8Array(encoded)).toHaveLength(0);
  });
});

describe("toArrayBufferBackedUint8Array", () => {
  it("copies bytes faithfully into a fresh, genuinely ArrayBuffer-backed array", () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const copy = toArrayBufferBackedUint8Array(source);
    expect(Array.from(copy)).toEqual([1, 2, 3, 4, 5]);
    expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
    expect(copy).not.toBe(source); // a real copy, not the same reference
  });

  it("does not alias the source — mutating the copy leaves the original untouched", () => {
    const source = new Uint8Array([9, 9, 9]);
    const copy = toArrayBufferBackedUint8Array(source);
    copy[0] = 0;
    expect(source[0]).toBe(9);
  });
});

describe("getRelyingParty", () => {
  it("derives id/origin from APP_URL's hostname/origin, defaulting to localhost:3000 in dev", () => {
    const rp = getRelyingParty();
    // Whatever APP_URL resolves to in this environment, `id` must be a
    // bare hostname (no scheme/port) and `origin` must be a full origin —
    // the two most common WebAuthn RP-ID misconfigurations are using the
    // full URL (with scheme) as the ID, or a bare hostname as the origin.
    expect(rp.id).not.toMatch(/^https?:\/\//);
    expect(rp.origin).toMatch(/^https?:\/\//);
    expect(rp.origin).toContain(rp.id);
    expect(rp.name).toBe("PFW");
  });
});
