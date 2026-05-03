import React, { useState } from "react";
import { api } from "../lib/api.js";

type Mode = "ask" | "instruct" | "store";

const MODE_LABELS: Record<Mode, string> = {
  ask: "Ask",
  instruct: "Instruct",
  store: "Store",
};

const MODE_HINTS: Record<Mode, string> = {
  ask: "Read-only Q&A — Avery can't create tasks or write memory.",
  instruct: "Full toolkit — Avery can spawn tasks, meetings, and approvals.",
  store: "Memory only — Avery captures a fact for the team's shared notes.",
};

/**
 * AskBar — pinned to the bottom of the shell. Sends a message to the CEO
 * via POST /api/chat/messages with the chosen mode (Spec 35 §3), or
 * wipes the company on the literal `/reset`.
 *
 * The mode segmented control narrows tools server-side at the OpenCode
 * `tools` filter, so the LLM physically can't pick a forbidden tool —
 * the #1 failure mode of free-form agentic chat.
 */
export function AskBar({
  companyName,
  onAfter,
}: {
  companyName: string;
  onAfter: () => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true); setError(null);
    try {
      if (msg === "/reset") {
        await api.delete("/api/company");
      } else {
        // Drain the SSE stream — for v1 we don't render tokens here,
        // we just wait for the whole turn so onAfter() can refresh.
        const res = await fetch("/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg, mode }),
        });
        if (!res.ok || !res.body) {
          throw new Error(`Chat send failed (${res.status})`);
        }
        // Drain — the api streams SSE; we don't care about events here.
        const reader = res.body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      setText("");
      onAfter();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ask-bar">
      <form onSubmit={submit}>
        <input
          type="text"
          value={text}
          onChange={(e) => { setText(e.target.value); }}
          placeholder={busy ? "Sending…" : `Talk to ${companyName}…`}
          autoComplete="off"
          disabled={busy}
        />
        <span className="hint">⌘↵</span>
      </form>
      <div className="ask-bar-modes" role="radiogroup" aria-label="Chat mode">
        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={`ask-bar-mode ${mode === m ? "is-active" : ""}`}
            onClick={() => { setMode(m); }}
            title={MODE_HINTS[m]}
            disabled={busy}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
        <span className="ask-bar-mode-hint">{MODE_HINTS[mode]}</span>
      </div>
      {error && <div className="ask-bar-error">{error}</div>}
    </div>
  );
}
