import React from "react";
import type { MemoryView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, List, MemoryQuote, Empty } from "../components/primitives.js";

export function MemoryPage({ v }: { v: MemoryView }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} />

      <Section title="Forming now">
        {v.forming.length === 0 ? (
          <Empty>No drafts in flight.</Empty>
        ) : v.forming.map(f => <MemoryQuote key={f.id} text={f.text} cite={f.cite} />)}
      </Section>

      <Section title="Recent lessons">
        <List rows={v.recent.map(r => ({ role: r.role, doing: r.text, verb: r.verb }))} />
      </Section>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
