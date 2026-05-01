import React, { useMemo, useState } from "react";
import type { SprintView } from "../contracts/views.js";
import type { RawAgent, RawTask } from "../lib/api.js";
import { Sentence, Subline, Kicker, Foot } from "../components/primitives.js";

export function SprintPage({ v, tasks, agents }: { v: SprintView; tasks: RawTask[]; agents: RawAgent[] }) {
  const agentById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const [selectedId, setSelectedId] = useState<string | null>(v.rows[0]?.id ?? null);

  const rawSelected = tasks.find(t => t.id === selectedId) ?? null;
  const rowSelected = v.rows.find(r => r.id === selectedId) ?? null;

  return (
    <div className="col wide">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} live />

      <div className="progress" aria-label="sprint progress">
        <span style={{ width: `${v.progressPct}%` }} />
      </div>

      <div className="md">
        <div className="md-list">
          {v.rows.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>No tasks.</div>
          ) : v.rows.map(r => {
            const cls = r.status === "done" ? "amber" : r.status === "now" ? "green" : "";
            return (
              <div
                key={r.id}
                className={`md-list-row${selectedId === r.id ? " selected" : ""}`}
                onClick={() => { setSelectedId(r.id); }}
              >
                <span className={`pip ${r.status === "now" ? "green live" : r.status === "done" ? "" : ""}`} />
                <div>
                  <div className="title-line" style={r.status === "done" ? { textDecoration: "line-through", color: "var(--ink-2)" } : undefined}>{r.title}</div>
                  <div className="meta-line">{r.role}{r.agent ? ` · ${r.agent}` : ""} · {r.verb}</div>
                </div>
                <span className={`badge ${cls}`}>{r.status}</span>
              </div>
            );
          })}
        </div>

        <div className="md-detail">
          {!rawSelected ? (
            <div className="empty-pane">Select a task.</div>
          ) : (
            <>
              <h3>{rawSelected.title ?? "(untitled)"}</h3>
              <span className="id">{rawSelected.id}</span>

              <div className="kv">
                <span className="k">status</span>          <span className="v">{rawSelected.status ?? "—"}</span>
                <span className="k">execution</span>       <span className="v">{rawSelected.executionStatus ?? "—"}</span>
                <span className="k">role</span>            <span className="v">{rawSelected.assignedRole ?? "—"}</span>
                <span className="k">agent</span>           <span className="v">{rawSelected.assignedAgentId ? `${agentById.get(rawSelected.assignedAgentId)?.name ?? "?"} · ${rawSelected.assignedAgentId}` : <em className="muted">unassigned</em>}</span>
                <span className="k">sprint</span>          <span className="v">{rawSelected.sprintId ?? "—"}</span>
                {rowSelected && <>
                  <span className="k">verb</span>          <span className="v">{rowSelected.verb}</span>
                </>}
              </div>

              <div className="h">raw</div>
              <pre className="code">{JSON.stringify(rawSelected, null, 2)}</pre>
            </>
          )}
        </div>
      </div>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
