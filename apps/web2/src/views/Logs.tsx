import React from "react";
import type { LogsView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, List, Empty } from "../components/primitives.js";

export function LogsPage({ v }: { v: LogsView }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} live />

      <Section title="Beats">
        {v.rows.length === 0 ? (
          <Empty>No events yet.</Empty>
        ) : (
          <List rows={v.rows.map(r => ({
            role: r.ts, doing: r.what, verb: r.tool ? `tool: ${r.tool}` : "—",
          }))} />
        )}
      </Section>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
