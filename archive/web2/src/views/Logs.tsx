import React, { useMemo, useState } from "react";
import type { LogsView } from "../contracts/views.js";
import type { RawAuditEvent } from "../lib/api.js";
import { Sentence, Subline, Kicker, Foot, Empty } from "../components/primitives.js";

export function LogsPage({ v, audit }: { v: LogsView; audit: RawAuditEvent[] }) {
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => [...audit].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)), [audit]);
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of audit) if (e.category) set.add(e.category);
    return [...set].sort();
  }, [audit]);

  const f = filter.trim().toLowerCase();
  const filtered = sorted.filter(e => {
    if (category && e.category !== category) return false;
    if (!f) return true;
    return (
      e.eventType.toLowerCase().includes(f) ||
      (e.summary ?? "").toLowerCase().includes(f) ||
      (e.agentRole ?? "").toLowerCase().includes(f) ||
      (e.category ?? "").toLowerCase().includes(f) ||
      e.id.toLowerCase().includes(f)
    );
  });

  const toggle = (id: string) => {
    setExpanded(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="col wide">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} live />

      <div className="toolbar">
        <input
          className="filter-input"
          placeholder="filter (eventType, summary, role, id)…"
          value={filter}
          onChange={e => { setFilter(e.target.value); }}
        />
        <button className={`chip${category === null ? " on" : ""}`} onClick={() => { setCategory(null); }}>all</button>
        {categories.map(c => (
          <button key={c} className={`chip${category === c ? " on" : ""}`} onClick={() => { setCategory(c); }}>{c}</button>
        ))}
        <span className="stretch" />
        <span className="chip" style={{ cursor: "default" }}>{filtered.length}/{audit.length}</span>
      </div>

      {filtered.length === 0 ? (
        <Empty>No events match.</Empty>
      ) : (
        <ul className="log-rows">
          {filtered.map(e => {
            const open = expanded.has(e.id);
            return (
              <li key={e.id} className={`log-row${open ? " expanded" : ""}`}>
                <div className="head" onClick={() => { toggle(e.id); }}>
                  <span className="ts">{new Date(e.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className="cat">{e.category ?? "—"}</span>
                  <span className="what">{e.eventType}{e.summary ? ` · ${e.summary}` : ""}</span>
                  <span className="tool">{e.agentRole ?? (e.detail?.tool!) ?? ""}</span>
                </div>
                {open && (
                  <div className="body">
                    <pre className="code">{JSON.stringify(e, null, 2)}</pre>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Foot>{v.foot}</Foot>
    </div>
  );
}
