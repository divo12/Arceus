import React from "react";
import type { NarrativeText } from "../contracts/view.js";

export function Sentence({ text }: { text: NarrativeText }) {
  // Split on the first period: first clause = ink, rest = quiet.
  const idx = text.text.indexOf(". ");
  if (idx < 0) return <h1 className="sentence">{text.text}</h1>;
  return (
    <h1 className="sentence">
      {text.text.slice(0, idx + 1)}{" "}
      <span className="quiet">{text.text.slice(idx + 2)}</span>
    </h1>
  );
}

export function Subline({ text, live }: { text: NarrativeText; live?: boolean }) {
  return (
    <p className="subline">
      {live && <span className="dot" />}
      <span>{text.text}</span>
    </p>
  );
}

export function Kicker({ text }: { text: string }) {
  return <div className="date">{text}</div>;
}

export function H({ children }: { children: React.ReactNode }) {
  return <h3 className="h">{children}</h3>;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <H>{title}</H>
      {children}
    </section>
  );
}

export function Foot({ children }: { children: React.ReactNode }) {
  return <div className="foot">{children}</div>;
}

export function Pip({ kind }: { kind: "green" | "amber" | "none" }) {
  return <span className={`pip${kind === "none" ? "" : " " + kind}`} />;
}

export interface ItemAction { label: string; primary?: boolean; onClick?: () => void }
export function Item(props: {
  who: React.ReactNode;
  ask: NarrativeText;
  why: NarrativeText;
  actions?: ItemAction[];
}) {
  return (
    <div className="item">
      <div className="who">{props.who}</div>
      <p className="ask">{props.ask.text}</p>
      <p className="why">{props.why.text}</p>
      {props.actions && props.actions.length > 0 && (
        <div className="acts">
          {props.actions.map((a, i) => (
            <a
              key={i}
              className={a.primary ? "primary" : ""}
              onClick={(e) => { e.preventDefault(); a.onClick?.(); }}
            >
              {a.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function List({
  rows,
}: {
  rows: { role: string; doing: string; verb: string; muted?: boolean }[];
}) {
  if (rows.length === 0) return <div className="empty">Nothing here yet.</div>;
  return (
    <ul className="list">
      {rows.map((r, i) => (
        <li key={i}>
          <span className="role">{r.role}</span>
          <span className={`doing${r.muted ? " muted" : ""}`}>{r.doing}</span>
          <span className="verb">{r.verb}</span>
        </li>
      ))}
    </ul>
  );
}

export function MemoryQuote({ text, cite }: { text: string; cite: string }) {
  return (
    <>
      <blockquote className="memory">{text}</blockquote>
      <p className="memory-cite">{cite}</p>
    </>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error">{message}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
