import React, { useMemo, useState } from "react";
import type { TeamView } from "../contracts/views.js";
import type { RawAgent, RawAuditEvent } from "../lib/api.js";
import { Sentence, Subline, Kicker } from "../components/primitives.js";

function statusBadge(a: RawAgent): { cls: string; text: string } {
  const rs = a.session?.runtimeStatus ?? a.status ?? "idle";
  if (rs === "running" || rs === "active") return { cls: "green", text: rs };
  if (a.session?.awaiting) return { cls: "amber", text: "awaiting" };
  return { cls: "", text: rs };
}

function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const sec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function TeamPage({ v, agents, audit }: { v: TeamView; agents: RawAgent[]; audit: RawAuditEvent[] }) {
  const sorted = useMemo(() => [...agents].sort((a, b) => {
    const ar = a.session?.runtimeStatus === "running" || a.session?.runtimeStatus === "active" ? 0 : 1;
    const br = b.session?.runtimeStatus === "running" || b.session?.runtimeStatus === "active" ? 0 : 1;
    if (ar !== br) return ar - br;
    return (a.role ?? "").localeCompare(b.role ?? "");
  }), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(sorted[0]?.id ?? null);
  const selected = sorted.find(a => a.id === selectedId) ?? null;

  const recentForAgent = useMemo(() => {
    if (!selected) return [];
    return audit
      .filter(e => e.agentRole === selected.role || (e.detail?.agentId as string | undefined) === selected.id)
      .slice(0, 25);
  }, [audit, selected]);

  return (
    <div className="col wide">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} live />

      <div className="md">
        <div className="md-list">
          {sorted.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>No agents.</div>
          ) : sorted.map(a => {
            const sb = statusBadge(a);
            const live = a.session?.runtimeStatus === "running" || a.session?.runtimeStatus === "active";
            return (
              <div
                key={a.id}
                className={`md-list-row${selectedId === a.id ? " selected" : ""}`}
                onClick={() => { setSelectedId(a.id); }}
              >
                <span className={`pip ${live ? (a.session?.awaiting ? "amber" : "green") : ""} ${live ? "live" : ""}`} />
                <div>
                  <div className="title-line">{a.name}</div>
                  <div className="meta-line">{a.role}{a.title ? ` · ${a.title}` : ""}</div>
                </div>
                <span className={`badge ${sb.cls}`}>{sb.text}</span>
              </div>
            );
          })}
        </div>

        <div className="md-detail">
          {!selected ? (
            <div className="empty-pane">Select an agent.</div>
          ) : (
            <>
              <h3>{selected.name}</h3>
              <span className="id">{selected.id}</span>

              <div className="kv">
                <span className="k">role</span>           <span className="v">{selected.role}</span>
                <span className="k">title</span>          <span className="v">{selected.title ?? <em className="muted">—</em>}</span>
                <span className="k">status</span>         <span className={`v ${statusBadge(selected).cls}`}>{statusBadge(selected).text}</span>
                <span className="k">runtime</span>        <span className="v">{selected.session?.runtimeStatus ?? "—"}</span>
                <span className="k">last event</span>     <span className="v">{selected.session?.lastEventAt ? `${timeAgo(selected.session.lastEventAt)} ago` : "—"}</span>
                <span className="k">active task</span>    <span className="v">{selected.session?.activeTaskId ?? <em className="muted">none</em>}</span>
                <span className="k">awaiting</span>       <span className={`v ${selected.session?.awaiting ? "amber" : "muted"}`}>{selected.session?.awaiting ?? "—"}</span>
              </div>

              <div className="h" style={{ marginTop: 20 }}>recent activity <span className="h-meta">{recentForAgent.length} events</span></div>
              {recentForAgent.length === 0 ? (
                <div className="empty">No events for this agent yet.</div>
              ) : (
                <ul className="feed">
                  {recentForAgent.map(e => (
                    <li key={e.id}>
                      <span className="ts">{new Date(e.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                      <span className="body"><strong>{e.eventType}</strong>{e.summary ? ` · ${e.summary}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="h" style={{ marginTop: 20 }}>raw</div>
              <pre className="code">{JSON.stringify(selected, null, 2)}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
