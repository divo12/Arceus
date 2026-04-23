---
name: decision-logging
description: When making a non-obvious choice mid-beat, log the rationale via memory_add_learning. Preserves the "why" for future sprints.
role: all
trigger: about to commit to a non-obvious decision (architectural pick, prioritization override, scope tradeoff) that future-you might question
---

# Decision Logging

The choice you make today is obvious to you. In 3 sprints, no one will remember why. Decision logging is how future-you understands past-you.

## When this fires

- Picked a library / framework / pattern where another choice was reasonable
- Prioritized task X over task Y when the ranking was close
- Cut scope in a specific way (what's in vs what's out)
- Overrode a framework output (e.g., RICE said X, you picked Y)
- Chose a workaround over a root-cause fix
- Accepted a known limitation rather than addressing it

Not this skill when: decision was purely mechanical (followed the plan exactly) or trivial (naming a variable). Those don't earn a log.

## What a good decision log captures

Four fields, kept short:

### 1. The decision (1 sentence)

What you actually chose. Name the specific option.

- Good: "Chose Fastify over Express for the new gateway service."
- Bad: "Made some server choices."

### 2. The alternatives considered

What you didn't pick. Name 1-2 concrete alternatives.

- Good: "Alternatives: Express (familiar, but slower), Hapi (richer but heavier)."
- Bad: "Other options existed."

### 3. The decisive reason

Why THIS over THAT. One crisp sentence.

- Good: "Fastify's schema-first approach fits our typed-envelope contract; 2× Express's throughput on our synthetic benchmark."
- Bad: "It seemed better."

### 4. What would change the decision

The condition under which future-you (or someone else) should revisit:

- Good: "Revisit if: our team doubles and onboarding friction on Fastify outweighs throughput; or if Express 6 ships with native schema support."
- Bad: "Might change later."

## The emit

```
memory_add_learning({
  content: "<decision>. Alternatives: <list>. Why: <reason>. Revisit if: <trigger>.",
  kind: "static",
  tags: ["decision-log", "<domain>"]  // e.g. "architecture", "scope", "process"
})
```

Keep the content under 300 characters if possible. Log title should be searchable by future-you.

## Examples across roles

### CEO — scope call

```
"Cut 'analytics dashboard' from Sprint 6 to accelerate auth. Alternatives: split into 2 sprints (rejected: loses momentum). Why: auth is the blocker for enterprise deals per board call. Revisit if: analytics comes up in customer calls 3+ times by Sprint 8."
```

### CTO — dependency pick

```
"Chose pgvector over Pinecone for embeddings. Alternatives: Pinecone (managed, expensive), Weaviate (heavier ops). Why: pgvector keeps data in our existing Postgres; avoids new infra; <100K embeddings we don't need dedicated vector DB. Revisit if: we exceed 1M embeddings or need sub-10ms p99."
```

### PM — prioritization override

```
"Shipped Feature B over Feature A this sprint despite RICE showing A higher. Alternatives: follow RICE. Why: customer commitment on B that would erode trust if slipped. Revisit if: B's adoption is low — would signal RICE was right."
```

### Dev — workaround

```
"Added retry loop around `external-auth-api` calls (3 attempts with backoff). Alternatives: fix root cause (likely theirs). Why: we don't control that API; their team estimated 2 sprints to fix. Revisit if: their team ships the fix OR retry rate exceeds 10% of requests (indicating their reliability regressed)."
```

### QA — accepted limitation

```
"Skipped cross-browser testing on Firefox for this sprint's features. Alternatives: run full matrix. Why: we ship with 3% Firefox traffic; cost of full matrix outweighs benefit. Revisit if: Firefox traffic > 10% or bug reports cluster in Firefox."
```

## Heuristics

- **Log at decision time, not later.** You won't remember the alternatives you considered by the end of the sprint.
- **Log close calls, not clear wins.** A decision that was 70/30 obvious doesn't need a log; one that was 51/49 does.
- **Revisit conditions are the point.** Without "revisit if," the log is just history. With it, it's a trigger for future review.
- **Short > long.** 3 sentences the team will read > 3 paragraphs no one will.
- **Don't log to justify.** The audience is future-you, not a judge. Honest tradeoffs > defensive explanations.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Team repeats past-settled debates | Decisions not logged; no shared history | Log every non-obvious call |
| Logs exist but not findable | Poor tagging | Standardize tags: `decision-log` + domain tag |
| Logs are defensive / one-sided | Written for audience of judges | Reframe: writing for future-you |
| Revisit conditions never trigger review | No one checks them | Periodic audit: walk decision logs quarterly |

## Anti-patterns

- **Logging trivial choices.** "Named the variable `userId` instead of `id`." No one cares.
- **Logging after the fact.** Reconstruction ≠ record. Log at the moment of decision.
- **"We considered everything and picked this."** Non-specific. Name the alternatives.
- **Missing the revisit condition.** Without it, the log is a museum piece.
- **Using the log to blame.** "We had to do X because Y refused to do Z." Keep logs blame-free; focus on information.
- **Over-tagging so nothing is findable.** 3 tags max: `decision-log` + domain + optional project.
