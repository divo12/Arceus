import React from "react";
import type { TodayView } from "../contracts/views.js";
import { Sentence, Subline, Kicker, Section, Foot, Item, MemoryQuote, Pip, Empty } from "../components/primitives.js";
import { QuickExecute } from "../components/QuickExecute.js";

export function TodayPage({ v, onRefresh }: { v: TodayView; onRefresh: () => void }) {
  return (
    <div className="col">
      <Kicker text={v.kicker} />
      <Sentence text={v.headline} />
      <Subline text={v.subline} live />

      {v.mode === "bootstrap" && (
        <QuickExecute
          hint="Bootstraps a company on first run, then asks the CEO to plan + execute."
          onDone={onRefresh}
        />
      )}

      <Section title="Needs you">
        {v.needs.length === 0 ? (
          <Empty>Nothing waiting on you.</Empty>
        ) : v.needs.map(d => (
          <Item key={d.id}
            who={<><Pip kind={d.pip} />{d.who}</>}
            ask={d.ask} why={d.why}
            actions={[{ label: d.primaryAction, primary: true }, { label: "Hold" }]}
          />
        ))}
      </Section>

      <Section title="Right now">
        {v.working.length === 0 ? (
          <Empty>The company is quiet.</Empty>
        ) : v.working.map(w => (
          <Item key={w.agentId}
            who={<><Pip kind={w.pip} />{w.who}</>}
            ask={w.ask} why={w.why}
            actions={[{ label: "Open thread", primary: true }, { label: "Pause" }]}
          />
        ))}
      </Section>

      {v.forming.length > 0 && (
        <Section title="Memory in flight">
          {v.forming.map((m, i) => <MemoryQuote key={i} text={m.text} cite={m.cite} />)}
        </Section>
      )}

      <Foot>working {v.working.length} &middot; needs you {v.needs.length}</Foot>
    </div>
  );
}
