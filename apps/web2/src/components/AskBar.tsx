import React, { useState } from "react";
import { api } from "../lib/api.js";

/**
 * AskBar — pinned to the bottom of the shell. Sends a message to the CEO
 * via POST /api/chat/ceo, or wipes the company on the literal `/reset`.
 */
export function AskBar({
  companyName,
  onAfter,
}: {
  companyName: string;
  onAfter: () => void;
}) {
  const [text, setText] = useState("");
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
        await api.post("/api/chat/ceo", { message: msg });
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
      {error && <div className="ask-bar-error">{error}</div>}
    </div>
  );
}
