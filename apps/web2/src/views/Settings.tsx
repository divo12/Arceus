import React from "react";
import type { SettingsView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, List, Empty } from "../components/primitives.js";

export function SettingsPage({
  v,
  heartbeatRunning,
  onToggleHeartbeat,
  onReset,
}: {
  v: SettingsView;
  heartbeatRunning: boolean;
  onToggleHeartbeat: () => void;
  onReset: () => void;
}) {
  const groups = [
    { title: "Company", group: "company" as const },
    { title: "Budget",  group: "budget" as const },
    { title: "Trust",   group: "trust" as const },
  ];
  const confirmReset = () => {
    if (window.confirm("Wipe the company? This deletes all agents, sprints, tasks, memories, and skills.")) {
      onReset();
    }
  };

  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} />

      <div style={{ margin: "0 0 56px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className={`toggle${heartbeatRunning ? " on" : ""}`}
          onClick={onToggleHeartbeat}
        >
          Heartbeat: {heartbeatRunning ? "live — click to pause" : "paused — click to start"}
        </button>
        <button className="toggle" onClick={confirmReset} style={{ color: "var(--amber)", borderColor: "var(--amber)" }}>
          Reset company (DELETE /api/company)
        </button>
      </div>

      {groups.map(g => {
        const rows = v.rows.filter(r => r.group === g.group);
        return (
          <Section key={g.group} title={g.title}>
            {rows.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <List rows={rows.map(r => ({ role: r.label, doing: r.value, verb: r.verb }))} />
            )}
          </Section>
        );
      })}

      <Foot>{v.foot}</Foot>
    </div>
  );
}

