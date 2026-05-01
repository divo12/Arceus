import React from "react";
import type { TeamView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, Item, List, Pip, Empty } from "../components/primitives.js";

export function TeamPage({ v }: { v: TeamView }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} />

      <Section title={`Working now · ${v.working.length}`}>
        {v.working.length === 0 ? (
          <Empty>Nobody is working right now.</Empty>
        ) : v.working.map(w => (
          <Item key={w.agentId}
            who={<><Pip kind={w.pip} />{w.who}</>}
            ask={w.ask} why={w.why}
            actions={[{ label: "Open thread", primary: true }, { label: "Pause" }]}
          />
        ))}
      </Section>

      <Section title={`Resting · ${v.resting.length}`}>
        <List rows={v.resting.map(r => ({
          role: r.role, doing: r.name, verb: r.idleFor,
        }))} />
      </Section>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
