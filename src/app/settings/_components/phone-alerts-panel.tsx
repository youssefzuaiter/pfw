"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { NTFY_ORIGIN, TOPIC_RULE, parseNtfyTopic } from "../../../lib/ntfy-topic";

export type PhoneAlertSettingsView = { topicHint: string; largeExpenseAgorot: number; includeDetails: boolean };

type Busy = "enable" | "save" | "test" | "disable" | null;

const INPUT =
  "rounded-md border border-border bg-elevated px-2 py-1.5 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function shekels(agorot: number): string {
  return (agorot / 100).toFixed(2).replace(/\.00$/, "");
}

/**
 * Phone alerts through ntfy.sh (AGENTS.md §3qqq). The topic is shown in full
 * exactly once, right after it is set, so it can be typed into the ntfy app;
 * afterwards only its last four characters, the same as the server returns.
 * Says plainly where the messages go before anything is turned on.
 */
export function PhoneAlertsPanel({ initial }: { initial: PhoneAlertSettingsView | null }) {
  const [settings, setSettings] = useState<PhoneAlertSettingsView | null>(initial);
  const [newTopic, setNewTopic] = useState<string | null>(null);
  const [topicInput, setTopicInput] = useState("");
  const [threshold, setThreshold] = useState(initial ? shekels(initial.largeExpenseAgorot) : "1000");
  const [includeDetails, setIncludeDetails] = useState(initial?.includeDetails ?? true);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function call(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : "Something went wrong");
    return json;
  }

  async function handleEnable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = topicInput.trim();
    if (typed !== "" && parseNtfyTopic(typed) === null) {
      setMessage({ tone: "error", text: `Use a topic name of ${TOPIC_RULE}.` });
      return;
    }
    setBusy("enable");
    setMessage(null);
    try {
      const json = await call("/api/phone-alerts", "POST", typed === "" ? {} : { topic: typed });
      const next = {
        topicHint: String(json.topicHint),
        largeExpenseAgorot: Number(json.largeExpenseAgorot),
        includeDetails: Boolean(json.includeDetails),
      };
      setSettings(next);
      setThreshold(shekels(next.largeExpenseAgorot));
      setIncludeDetails(next.includeDetails);
      setNewTopic(String(json.topic));
      setTopicInput("");
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not turn alerts on" });
    } finally {
      setBusy(null);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setMessage(null);
    try {
      const json = await call("/api/phone-alerts", "PATCH", { largeExpense: threshold.trim(), includeDetails });
      setSettings({ topicHint: String(json.topicHint), largeExpenseAgorot: Number(json.largeExpenseAgorot), includeDetails: Boolean(json.includeDetails) });
      setMessage({ tone: "ok", text: "Saved." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not save" });
    } finally {
      setBusy(null);
    }
  }

  async function handleTestClick() {
    setBusy("test");
    setMessage(null);
    try {
      await call("/api/phone-alerts/test", "POST");
      setMessage({ tone: "ok", text: "Test alert sent. It should reach your phone within a few seconds." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "The test alert was not sent" });
    } finally {
      setBusy(null);
    }
  }

  async function handleDisableClick() {
    setBusy("disable");
    setMessage(null);
    try {
      await call("/api/phone-alerts", "DELETE");
      setSettings(null);
      setNewTopic(null);
      setMessage({ tone: "ok", text: "Phone alerts are off. You can unsubscribe in the ntfy app." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not turn alerts off" });
    } finally {
      setBusy(null);
    }
  }

  function handleTopicChange(event: ChangeEvent<HTMLInputElement>) {
    setTopicInput(event.currentTarget.value);
  }

  function handleThresholdChange(event: ChangeEvent<HTMLInputElement>) {
    setThreshold(event.currentTarget.value);
  }

  function handleDetailsChange(event: ChangeEvent<HTMLInputElement>) {
    setIncludeDetails(event.currentTarget.checked);
  }

  const enableForm = (
    <form onSubmit={handleEnable} className="flex flex-col gap-2">
      <label htmlFor="phone-alert-topic" className="text-xs text-muted">
        Your own topic (optional — leave empty and PFW makes a random one)
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="phone-alert-topic"
          value={topicInput}
          onChange={handleTopicChange}
          placeholder="e.g. my-pfw-alerts-7f3k9"
          autoComplete="off"
          spellCheck={false}
          className={`${INPUT} w-64 max-w-full`}
        />
        <button type="submit" disabled={busy !== null} className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          {busy === "enable" && <Spinner />} {settings ? "Change topic" : "Turn on phone alerts"}
        </button>
      </div>
    </form>
  );

  return (
    <section aria-labelledby="phone-alerts-heading" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div>
        <h3 id="phone-alerts-heading" className="text-sm font-semibold text-fg">
          Phone alerts
        </h3>
        <p className="mt-1 text-xs text-muted">
          Once a night PFW checks for an envelope that went overdrawn, a large expense, a statement that is overdue for
          import, and Emergency Vault notices, and sends one notification through ntfy.sh. Install the free ntfy app and
          subscribe to your topic. ntfy.sh is a public service: anyone who knows the topic can read the messages, so keep
          it secret, and turn details off to send only a count.
        </p>
      </div>

      {newTopic && (
        <div className="rounded-md border border-border bg-elevated p-3 text-xs text-fg" role="status">
          <p>
            Subscribe to this topic in the ntfy app. It is shown only now:
          </p>
          <p className="mt-1 break-all font-tabular-figures text-sm">{newTopic}</p>
          <a
            href={`${NTFY_ORIGIN}/${newTopic}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Or open it on ntfy.sh in this browser
          </a>
        </div>
      )}

      {settings === null ? (
        enableForm
      ) : (
        <>
          <p className="text-xs text-fg">
            On — topic ending <span className="font-tabular-figures">{settings.topicHint}</span>
          </p>
          <form onSubmit={handleSave} className="flex flex-col gap-2">
            <label htmlFor="phone-alert-threshold" className="text-xs text-muted">
              Alert me about any single expense of at least (₪)
            </label>
            <input
              id="phone-alert-threshold"
              value={threshold}
              onChange={handleThresholdChange}
              inputMode="decimal"
              className={`${INPUT} w-40`}
            />
            <label className="flex items-center gap-2 text-xs text-fg">
              <input
                type="checkbox"
                checked={includeDetails}
                onChange={handleDetailsChange}
                className="h-4 w-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              Include merchant names and amounts in the notification
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={busy !== null} className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                {busy === "save" && <Spinner />} Save
              </button>
              <button type="button" onClick={handleTestClick} disabled={busy !== null} className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                {busy === "test" && <Spinner />} Send test alert
              </button>
              <button type="button" onClick={handleDisableClick} disabled={busy !== null} className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                {busy === "disable" && <Spinner />} Turn off
              </button>
            </div>
          </form>
          {enableForm}
        </>
      )}

      {message && (
        <p className={`text-xs ${message.tone === "ok" ? "text-positive" : "text-negative"}`} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
