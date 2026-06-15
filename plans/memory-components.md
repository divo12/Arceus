# Arceus memory/quality components (from the Polsia teardown)

Goal: take the genuinely-applicable ideas from the Polsia transcript and build them
into Arceus **one at a time** — each fully wired, TDD'd, and e2e-verified before the
next. Ranked by value ÷ effort; only the ideas Arceus doesn't already have.

## Roadmap

1. **Standing board directives → CEO context** ✅ DONE (aa87d2a)
   - `apps/api/src/agents/board-directives.ts`: distills board-role chat into deduped
     standing directives (always/avoid/constraint/prefer); rendered into the CEO's
     per-beat context (`ceo.ts buildSnapshotContext`) with a "flag conflicts, don't
     silently override" instruction.
   - TDD: `board-directives.test.ts` 8/8 (extraction/dedup/render + a wiring test
     proving `buildCeoOperatingPrompt` injects directives). Pure, no migration.
   - Follow-ups (later components): LLM extractor + true topic-supersession;
     persistence beyond the bounded chat window (dedicated board-role query);
     active contradiction detection (#2).

2. **Contradiction detection** — when a new board request conflicts with a standing
   directive, the CEO says "last sprint you said X — still want that?" instead of
   silently overriding. Builds on #1's directive list. (LLM check on the rare path.)

3. **Per-role context assembly** — Hippocampus recall already does embed → vector →
   MMR. Add agent-aware *formatting* so each role gets context filtered for its needs
   (dev→tech, designer→brand/design). (RRF/hybrid is marginal — MMR already there.)

4. **Memory-write discipline** — the "would another agent need this?" test +
   UPDATE-vs-APPEND + compress-when-full, applied to role-memory / handoff writes.

5. **Recurring health probe** — extend the flow-tester (currently sprint-finalize only)
   to a scheduled probe of live previews → CEO next-sprint suggestions.

6. **KNOW/INFER/GUESS + problem-classification** — a prompt-discipline seed skill for
   CEO/reviewers (pairs with the superpowers skills).

## Explicitly NOT doing (out of scope / already have)
- Firecracker microVMs, revenue-aware auto-rollback, BYO-MCP marketplace, vertical
  template marketplace — big bets, not aligned.
- Already in Arceus: autonomous loop (heartbeat), browser automation + vision
  (flow-tester), tool gating/trust bands, per-company secret injection, circuit
  breakers, multi-tenancy, deploy-resilience, skills.md (registry + materialized).
