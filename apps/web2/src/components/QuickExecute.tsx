import React, { useState } from "react";
import { api } from "../lib/api.js";

/**
 * QuickExecute — calls POST /api/quick-execute with `{ idea }`.
 * The API will bootstrap a company if needed, generate strategy,
 * apply org chart, and start the heartbeat. One textarea, one button.
 */
export function QuickExecute({
  hint,
  onDone,
}: {
  hint: string;
  onDone: () => void;
}) {
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = idea.trim().length >= 5;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      const trimmed = idea.trim();
      if (trimmed === "/reset") {
        await api.delete("/api/company");
      } else {
        await api.post("/api/quick-execute", { idea: trimmed });
      }
      setIdea("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qx">
      <div className="qx-label">Quick execute</div>
      <textarea
        value={idea}
        onChange={(e) => { setIdea(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder="Describe an idea — the company will plan and execute it…"
      />
      <div className="qx-row">
        <span className="qx-hint">{hint}</span>
        <button onClick={submit} disabled={!ready || busy}>
          {busy ? "Executing…" : "Execute"}
        </button>
      </div>
      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
