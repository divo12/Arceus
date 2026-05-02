import React from "react";
import type { MeetingsView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, Item, Empty } from "../components/primitives.js";

export function MeetingsPage({ v }: { v: MeetingsView }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} />

      <Section title="Recent">
        {v.meetings.length === 0 ? (
          <Empty>No meetings yet.</Empty>
        ) : v.meetings.map(m => (
          <Item key={m.id}
            who={m.who}
            ask={m.ask}
            why={m.why}
            actions={m.hasTranscript ? [{ label: "Read transcript", primary: true }] : []}
          />
        ))}
      </Section>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
