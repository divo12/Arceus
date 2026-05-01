import React from "react";
import type { SkillsView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, Item, List, Pip, Empty } from "../components/primitives.js";

export function SkillsPage({ v, onPromote }: { v: SkillsView; onPromote: (id: string) => void }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} live />

      <Section title="Forming now">
        {v.forming.length === 0 ? (
          <Empty>No skills forming. Agents will draft them as they work.</Empty>
        ) : v.forming.map(s => (
          <Item key={s.id}
            who={<><Pip kind={s.pip} />{s.who}</>}
            ask={s.ask} why={s.why}
            actions={[
              { label: "Read draft", primary: true },
              { label: "See attempts" },
              ...(s.canPromote ? [{ label: "Promote", onClick: () => { onPromote(s.id); } }] : []),
            ]}
          />
        ))}
      </Section>

      <Section title="In the library">
        {v.library.length === 0 ? (
          <Empty>The library is empty.</Empty>
        ) : (
          <List rows={v.library.map(s => ({
            role: s.version, doing: s.name, verb: s.usage,
          }))} />
        )}
      </Section>

      <Section title="How a skill evolves">
        <List rows={v.lifecycle.map(l => ({ role: l.step, doing: l.what, verb: l.state }))} />
      </Section>

      <Foot>{v.foot}</Foot>
    </div>
  );
}
