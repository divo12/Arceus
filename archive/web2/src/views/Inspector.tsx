import React, { useEffect, useState } from "react";
import type { Pulse } from "../contracts/views.js";
import type { RawAgent, RawAuditEvent } from "../lib/api.js";
import { api } from "../lib/api.js";
import { Sentence, Subline, Kicker, Foot } from "../components/primitives.js";

type StatBucket = Record<string, unknown>;
interface HeartbeatEntry {
  id?: string;
  occurredAt?: string;
  beatNumber?: number;
  beatCount?: number;
  durationMs?: number;
  status?: string;
  [k: string]: unknown;
}

export function InspectorPage(props: {
  pulse: Pulse;
  agents: RawAgent[];
  audit: RawAuditEvent[];
  heartbeatRunning: boolean;
  onToggleHeartbeat: () => void;
}) {
  const { pulse, agents, audit, heartbeatRunning, onToggleHeartbeat } = props;
  const [stats, setStats] = useState<StatBucket | null>(null);
  const [hbHistory, setHbHistory] = useState<HeartbeatEntry[] | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [hbErr, setHbErr] = useState<string | null>(null);

  const refresh = () => {
    api.get<StatBucket>("/api/inspector/stats")
      .then(s => { setStats(s); setStatsErr(null); })
      .catch(e => { setStatsErr(String(e instanceof Error ? e.message : e)); });
    api.get<HeartbeatEntry[] | { history: HeartbeatEntry[] }>("/api/heartbeat/history")
      .then(h => {
        const arr = Array.isArray(h) ? h : (h.history ?? []);
        setHbHistory(arr); setHbErr(null);
      })
      .catch(e => { setHbErr(String(e instanceof Error ? e.message : e)); });
  };

  useEffect(() => { refresh(); }, [pulse.beatCount]);

  const byCategory: Record<string, number> = {};
  for (const e of audit) {
    const k = e.category ?? "uncategorised";
    byCategory[k] = (byCategory[k] ?? 0) + 1;
  }

  return (
    <div className="col wide">
      <Kicker text="inspector" />
      <Sentence text={{ text: "Whitebox view. Heartbeat, buffers, telemetry, raw events.", kind: "label", authorAgentId: null, generatedAt: new Date().toISOString(), sourceBeatId: null }} />
      <Subline text={{ text: `pulse #${pulse.beatCount} · ${pulse.lastBeatAgo}`, kind: "label", authorAgentId: null, generatedAt: new Date().toISOString(), sourceBeatId: null }} live />

      <div className="toolbar">
        <button className={`toggle${heartbeatRunning ? " on" : ""}`} onClick={onToggleHeartbeat}>
          {heartbeatRunning ? "heartbeat on" : "heartbeat off"}
        </button>
        <button className="chip" onClick={refresh}>refresh</button>
        <span className="stretch" />
        <span className="chip" style={{ cursor: "default" }}>last {pulse.lastBeatAgo}</span>
      </div>

      <div className="h">live state</div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="k">heartbeat</div>
          <div className={`v ${pulse.heartbeatRunning ? "green" : ""}`}>{pulse.heartbeatRunning ? "running" : "stopped"}</div>
          <div className="sub">beat #{pulse.beatCount}</div>
        </div>
        <div className="stat-card">
          <div className="k">agents live</div>
          <div className="v">{pulse.agentLive}<span className="sub" style={{ display: "inline", marginLeft: 6 }}>/ {pulse.agentTotal}</span></div>
          <div className="sub">{pulse.awaitingCount} awaiting</div>
        </div>
        <div className="stat-card">
          <div className="k">audit events</div>
          <div className="v">{pulse.auditTotal.toLocaleString()}</div>
          <div className="sub">in buffer</div>
        </div>
        <div className="stat-card">
          <div className="k">last beat</div>
          <div className="v">{pulse.lastBeatAgo}</div>
          <div className="sub">{pulse.lastBeatAt ?? "never"}</div>
        </div>
      </div>

      <div className="h">events by category</div>
      <div className="kv">
        {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
          <React.Fragment key={k}>
            <span className="k">{k}</span>
            <span className="v">{n}</span>
          </React.Fragment>
        ))}
        {Object.keys(byCategory).length === 0 && <span className="v muted">no events</span>}
      </div>

      <div className="h">/api/inspector/stats {statsErr && <span className="h-meta" style={{ color: "var(--red)" }}>{statsErr}</span>}</div>
      {stats ? (
        <pre className="code">{JSON.stringify(stats, null, 2)}</pre>
      ) : !statsErr ? (
        <div className="empty">loading…</div>
      ) : null}

      <div className="h" style={{ marginTop: 18 }}>/api/heartbeat/history {hbErr && <span className="h-meta" style={{ color: "var(--red)" }}>{hbErr}</span>}</div>
      {hbHistory ? (
        hbHistory.length === 0 ? (
          <div className="empty">no heartbeat history yet.</div>
        ) : (
          <ul className="feed">
            {hbHistory.slice(0, 30).map((h, i) => (
              <li key={h.id ?? i}>
                <span className="ts">{h.occurredAt ? new Date(h.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</span>
                <span className="body">
                  <strong>#{h.beatNumber ?? h.beatCount ?? i}</strong>
                  {h.status ? ` · ${h.status}` : ""}
                  {typeof h.durationMs === "number" ? ` · ${h.durationMs}ms` : ""}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : !hbErr ? (
        <div className="empty">loading…</div>
      ) : null}

      <div className="h" style={{ marginTop: 18 }}>agents — raw</div>
      <pre className="code">{JSON.stringify(agents, null, 2)}</pre>

      <Foot>inspector · {pulse.auditTotal} events · heartbeat {pulse.heartbeatRunning ? "on" : "off"}</Foot>
    </div>
  );
}
