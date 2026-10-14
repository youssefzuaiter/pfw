import { describe, expect, it, vi } from "vitest";
import { sendNtfy } from "./ntfy-client";

const TOPIC = "pfw-test-topic-abc123";
const MESSAGE = { title: "PFW: large expense", message: "Large expense: MİGROS -₺4,500.00", priority: 3 as const, click: "https://pfw.example/dashboard" };

describe("sendNtfy", () => {
  it("POSTs JSON with the topic in the body to ntfy.sh's root, nowhere else", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await sendNtfy(TOPIC, MESSAGE, fetchMock)).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.sh");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ topic: TOPIC, ...MESSAGE });
  });

  it("refuses a topic that is not a bare ntfy.sh name, without sending", async () => {
    const fetchMock = vi.fn();
    for (const topic of ["https://ntfy.sh/pfw-test-topic-abc123", "short", "../../admin/x-y-z-w"]) {
      expect(await sendNtfy(topic, MESSAGE, fetchMock)).toEqual({ ok: false, error: "not a valid ntfy.sh topic" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a rate limit and other statuses without throwing", async () => {
    expect(await sendNtfy(TOPIC, MESSAGE, vi.fn().mockResolvedValue(new Response("", { status: 429 })))).toEqual({
      ok: false,
      error: "ntfy.sh is rate-limiting this server (429)",
    });
    expect(await sendNtfy(TOPIC, MESSAGE, vi.fn().mockResolvedValue(new Response("", { status: 500 })))).toEqual({
      ok: false,
      error: "ntfy.sh answered 500",
    });
  });

  it("never puts the topic or the message into an error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(`fetch failed for ${TOPIC}: ${MESSAGE.message}`));
    const outcome = await sendNtfy(TOPIC, MESSAGE, fetchMock);
    expect(outcome).toEqual({ ok: false, error: "could not reach ntfy.sh (TypeError)" });
  });

  it("gives up after five seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      );
      const pending = sendNtfy(TOPIC, MESSAGE, fetchMock);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ ok: false, error: "ntfy.sh did not answer within 5s" });
    } finally {
      vi.useRealTimers();
    }
  });
});
