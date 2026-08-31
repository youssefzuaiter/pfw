"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Transport-only Web Serial hook for talking to a locally-connected
 * hardware key (see arduino/pfw-hardware-key/pfw-hardware-key.ino).
 *
 * Deliberately does NOT verify anything. This hook's only job is moving
 * bytes over USB serial — it hands back whatever the device returns,
 * unexamined. Signature verification must happen server-side, against a
 * secret the browser never holds (src/server/env.ts is the only
 * legitimate reader of that kind of value, per AGENTS.md §1 law #6) —
 * a client-side "looks valid" check is not a security boundary, since
 * the JS making that call is fully readable and reproducible by whoever
 * is trying to bypass it. Treat every byte this hook returns as
 * untrusted input, exactly like a request body.
 */

export const CHALLENGE_LENGTH_BYTES = 32;
export const RESPONSE_LENGTH_BYTES = 32; // HMAC-SHA256 output, matching the sketch
const DEFAULT_BAUD_RATE = 115_200;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5_000;

export type ArduinoSerialStatus = "unsupported" | "idle" | "connecting" | "connected" | "signing" | "error";

export interface SendChallengeOptions {
  responseLength?: number;
  timeoutMs?: number;
}

export interface UseArduinoSerialResult {
  status: ArduinoSerialStatus;
  isSupported: boolean;
  error: string | null;
  /** Must be called from a real user gesture (e.g. a button's onClick) — the Web Serial spec requires it for `requestPort()`. */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Writes `challenge` (exactly CHALLENGE_LENGTH_BYTES) and returns the device's raw response. Throws on mismatch, timeout, or no connection. */
  sendChallenge: (challenge: Uint8Array, options?: SendChallengeOptions) => Promise<Uint8Array>;
}

/** `crypto.getRandomValues`-backed nonce generator — a fresh challenge must never be reused, or a captured response could be replayed. */
export function createRandomChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CHALLENGE_LENGTH_BYTES));
}

async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  length: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let received = 0;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    // Cancelling resolves any pending/future read() with { done: true }
    // instead of hanging forever — the loop below turns that into a
    // clear timeout error rather than a silent stall.
    reader.cancel(new Error("timeout")).catch(() => {});
  }, timeoutMs);

  try {
    while (received < length) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(
          timedOut
            ? `Timed out waiting for the hardware key's response (${received}/${length} bytes received).`
            : `Hardware key closed the connection early (${received}/${length} bytes received).`,
        );
      }
      // The protocol is strictly one 32-byte response per challenge, so
      // any bytes beyond `length` in this chunk would mean the device
      // sent more than expected — drop them rather than let them bleed
      // into whatever read happens next.
      const take = Math.min(value.length, length - received);
      out.set(value.subarray(0, take), received);
      received += take;
    }
  } finally {
    clearTimeout(timer);
  }

  return out;
}

export function useArduinoSerial(): UseArduinoSerialResult {
  const isSupported = typeof navigator !== "undefined" && "serial" in navigator;

  const [status, setStatus] = useState<ArduinoSerialStatus>(isSupported ? "idle" : "unsupported");
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<SerialPort | null>(null);
  const busyRef = useRef(false);

  const teardown = useCallback(() => {
    portRef.current = null;
    busyRef.current = false;
  }, []);

  const openPort = useCallback(
    async (port: SerialPort) => {
      await port.open({ baudRate: DEFAULT_BAUD_RATE });
      portRef.current = port;
      setStatus("connected");
      setError(null);

      const onDisconnect = () => {
        teardown();
        setStatus("idle");
        port.removeEventListener("disconnect", onDisconnect);
      };
      port.addEventListener("disconnect", onDisconnect);
    },
    [teardown],
  );

  // A port the user already authorized in a previous session can be
  // reopened without a new gesture (only navigator.serial.requestPort()
  // needs one) — this is what lets a page reload keep working without
  // re-prompting the picker every time. Only auto-reopens when exactly
  // one previously-authorized port exists; with more than one, the user
  // picks explicitly via connect().
  useEffect(() => {
    if (!isSupported) return;
    let cancelled = false;

    navigator.serial!.getPorts().then(async (ports) => {
      if (cancelled || ports.length !== 1) return;
      try {
        await openPort(ports[0]);
      } catch {
        // Left disconnected — the device may be unplugged or in use
        // elsewhere; the user can retry via connect().
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount, intentionally not re-running on openPort identity changes
  }, [isSupported]);

  const connect = useCallback(async () => {
    if (!isSupported) return;
    setStatus("connecting");
    setError(null);
    try {
      const port = await navigator.serial!.requestPort();
      await openPort(port);
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        // User dismissed the device picker — not a real error.
        setStatus("idle");
        return;
      }
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to connect to the hardware key.");
    }
  }, [isSupported, openPort]);

  const disconnect = useCallback(async () => {
    const port = portRef.current;
    teardown();
    setStatus("idle");
    setError(null);
    if (port) {
      await port.close().catch(() => {});
    }
  }, [teardown]);

  const sendChallenge = useCallback(
    async (challenge: Uint8Array, options?: SendChallengeOptions): Promise<Uint8Array> => {
      const port = portRef.current;
      if (!port || status === "unsupported" || status === "idle" || status === "connecting") {
        throw new Error("No hardware key connected — call connect() first.");
      }
      if (challenge.length !== CHALLENGE_LENGTH_BYTES) {
        throw new RangeError(`Challenge must be exactly ${CHALLENGE_LENGTH_BYTES} bytes, got ${challenge.length}.`);
      }
      if (busyRef.current) {
        throw new Error("A challenge is already in flight on this connection.");
      }
      if (!port.writable || !port.readable) {
        throw new Error("Hardware key port has no open read/write streams.");
      }

      busyRef.current = true;
      setStatus("signing");

      const responseLength = options?.responseLength ?? RESPONSE_LENGTH_BYTES;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;

      const writer = port.writable.getWriter();
      const reader = port.readable.getReader();
      try {
        await writer.write(challenge);
        return await readExactly(reader, responseLength, timeoutMs);
      } finally {
        reader.releaseLock();
        writer.releaseLock();
        busyRef.current = false;
        setStatus((current) => (current === "signing" ? "connected" : current));
      }
    },
    [status],
  );

  // Best-effort close on unmount — mirrors the WebGL-context and
  // Worker-termination cleanup discipline elsewhere in this app
  // (AGENTS.md §3f, §3y): a serial connection left open across an
  // unmounted component holds the OS-level port lock indefinitely.
  useEffect(() => {
    return () => {
      portRef.current?.close().catch(() => {});
    };
  }, []);

  return { status, isSupported, error, connect, disconnect, sendChallenge };
}
