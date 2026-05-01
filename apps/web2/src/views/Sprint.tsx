import React from "react";
import type { SprintView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Foot, Empty } from "../components/primitives.js";

const STATUS_LABEL: Record<"now" | "next" | "done", string> = {
  now: "Now",
  next: "Next",
  done: "Done",
};

export function SprintPage({ v }: { v: SprintView }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} />

      <div className="progress"><span style={{ width: `${v.progressPct}%` }} /></div>

      {v.rows.length === 0 ? (
        <Empty>No tasks in this sprint yet.</Empty>
      ) : (
        <ul className="sprint-rows">
          {v.rows.map(r => (
            <li key={r.id} className={`sprint-row sprint-row-${r.status}`}>
              <span className={`sprint-pip pip-${r.status}`} />
              <span className="sprint-status">{STATUS_LABEL[r.status]}</span>
              <span className="sprint-title">{r.title}</span>
              <span className="sprint-meta">{r.role}</span>
              <span className="sprint-verb">{r.verb}</span>
            </li>
          ))}
        </ul>
      )}

      <Foot>{v.foot}</Foot>
    </div>
  );
}
