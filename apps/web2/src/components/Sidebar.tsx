import React from "react";
import type { Shell } from "../contracts/views.js";
import type { TabId } from "../contracts/view.js";

const GROUP_LABELS = {
  company: "company",
  knowledge: "knowledge",
  "for-you": "for you",
} as const;

export function Sidebar({
  shell,
  active,
  onSelect,
}: {
  shell: Shell;
  active: TabId;
  onSelect: (id: TabId) => void;
}) {
  const groups: { key: keyof typeof GROUP_LABELS; tabs: Shell["tabs"] }[] = [
    { key: "company",   tabs: shell.tabs.filter(t => t.group === "company") },
    { key: "knowledge", tabs: shell.tabs.filter(t => t.group === "knowledge") },
    { key: "for-you",   tabs: shell.tabs.filter(t => t.group === "for-you" && t.id !== "settings") },
  ];
  const settings = shell.tabs.find(t => t.id === "settings");
  const p = shell.pulse;

  return (
    <nav className="rail">
      {shell.brand ? (
        <div className="brand">
          <div className="logo">{shell.brand.initial}</div>
          <div className="name">{shell.brand.name}<span className="quiet">.</span></div>
        </div>
      ) : (
        <div className="brand brand-empty">
          <div className="logo logo-empty" />
          <div className="name name-empty">no company</div>
        </div>
      )}

      {groups.map(g => (
        <React.Fragment key={g.key}>
          <div className="group-label">{GROUP_LABELS[g.key]}</div>
          {g.tabs.map(t => (
            <button
              key={t.id}
              className={`tab${active === t.id ? " active" : ""}`}
              onClick={() => { onSelect(t.id); }}
            >
              <span>{t.label}</span>
              {t.live ? <span className="dot" /> : t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        </React.Fragment>
      ))}

      <div className="spacer" />
      {settings && (
        <button
          className={`tab${active === "settings" ? " active" : ""}`}
          onClick={() => { onSelect("settings"); }}
        >
          <span>{settings.label}</span>
        </button>
      )}

      <div className="footer">
        <div className="row">
          <span className="k">
            <span className={`pulse-dot${p.heartbeatRunning ? " live" : ""}`} />
            heartbeat
          </span>
          <span className="v">{p.heartbeatRunning ? `#${p.beatCount}` : "off"}</span>
        </div>
        <div className="row">
          <span className="k">agents</span>
          <span className="v">{p.agentLive}/{p.agentTotal}{p.awaitingCount ? ` ·${p.awaitingCount}w` : ""}</span>
        </div>
        <div className="row">
          <span className="k">events</span>
          <span className="v">{p.auditTotal.toLocaleString()}</span>
        </div>
        <div className="row" style={{ marginTop: 4, opacity: 0.7 }}>
          <span className="k">{shell.ceo.initials} · ceo</span>
          <span className="v">{shell.version}</span>
        </div>
      </div>
    </nav>
  );
}
