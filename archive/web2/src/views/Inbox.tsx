import React from "react";
import type { InboxView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, Item, List, Pip, Empty } from "../components/primitives.js";

export function InboxPage({ v }: { v: InboxView }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} />

      <Section title="Waiting">
        {v.waiting.length === 0 ? (
          <Empty>Inbox is clear.</Empty>
        ) : v.waiting.map(w => (
          <Item key={w.id}
            who={<><Pip kind={w.pip} />{w.who}</>}
            ask={w.ask} why={w.why}
            actions={[{ label: "Approve", primary: true }, { label: "Hold" }]}
          />
        ))}
      </Section>

      <Section title="Cleared today">
        <List rows={v.cleared.map(c => ({ role: c.ts, doing: c.what, verb: c.verb }))} />
      </Section>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
