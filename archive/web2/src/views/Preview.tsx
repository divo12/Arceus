import React from "react";
import type { PreviewView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, Item, List, Pip, Empty } from "../components/primitives.js";

export function PreviewPage({ v }: { v: PreviewView }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} />

      <Section title="Live">
        {v.live.length === 0 ? (
          <Empty>No live builds yet.</Empty>
        ) : v.live.map(b => (
          <Item key={b.id}
            who={<><Pip kind={b.pip} />{b.who}</>}
            ask={b.ask} why={b.why}
            actions={[
              ...(b.publicUrl ? [{ label: "Open", primary: true }] : []),
              { label: "See diff" },
              ...(b.canRollback ? [{ label: "Roll back" }] : []),
            ]}
          />
        ))}
      </Section>

      <Section title="Recent deploys">
        <List rows={v.recent.map(r => ({ role: r.ts, doing: r.what, verb: r.verb }))} />
      </Section>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
