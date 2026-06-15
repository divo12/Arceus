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

2. **Contradiction detection** ✅ DONE (07f8f49)
   - `findDirectiveConflicts` (board-directives.ts) flags opposing-polarity directives
     on the same topic (token-overlap + avoid-vs-positive); `renderBoardDirectivesBlock`
     appends a "⚠ CONFLICTING board directives — resolve with the board BEFORE planning"
     pairing. Flows into the CEO prompt via the existing injection (no new wiring).
   - TDD: 15/15 (polarity/agreement/unrelated/two-avoids + a wiring test proving
     buildCeoOperatingPrompt surfaces the conflict). Pure heuristic; fuzzy value
     conflicts (dark-vs-light theme) deferred to a future LLM layer.

3. **Board directives → every role's beat** ✅ DONE (9ea2a3e)
   - `renderCompanyState` (the role-agnostic per-beat renderer in beat-context-builder.ts)
     now injects `buildBoardDirectivesBlock` so developer/designer/PM/tester all honor
     the owner's standing constraints + see conflicts, not just the CEO. `loadBeatRenderContext`
     gained a bounded board_messages fetch in its Promise.all batch. TDD 3/3 + existing
     beat-context-builder.test.ts 5/5 (added board_messages mock). Touches every beat →
     live regression-watched.
   - NOTE superseded: the original #3 idea (Hippocampus per-role retrieval formatting) is
     deferred — MMR recall already exists; lower ROI than fanning directives to all roles.

   _Follow-up (#4 candidate):_ durable directives — board_messages stores ALL chat roles,
   so the recent-N window can drop an early board directive. A board-ROLE-only query makes
   directives survive indefinitely.

4. **Directive-aware flow-test** ✅ DONE (6a828b1) — the browser flow-tester receives a checklist of the board's standing directives and verifies the live product honors each (violations → ISSUES → CEO next-sprint suggestion via the existing routing). buildDirectiveChecklistForQA pure+tested; wired into flow-test.ts goal. Closes directives → built → VERIFIED.

5. **Durable board directives** ✅ DONE (2c118e1) — listBoardRoleMessages (role='board' only, cap 300) feeds directive extraction in loadBeatRenderContext, so an early directive never ages out behind agent/CEO chatter. TDD: beat-context test proves an OLD directive still surfaces.

6. **Memory-write discipline** ✅ DONE (3f757cb) — isWorthRemembering / filterMemorableFacts (company-runtime/memory-quality.ts) drops empty/too-short (<10 char) + low-confidence (<0.35) extracted facts before they become permanent Hippocampus memory; wired into extractMeetingMemories. TDD 7/7. ORIGINAL note: the "would another agent need this?" test +
   UPDATE-vs-APPEND + compress-when-full, applied to role-memory / handoff writes.

5. **Recurring health probe** — extend the flow-tester (currently sprint-finalize only)
   to a scheduled probe of live previews → CEO next-sprint suggestions.

7. **Epistemic discipline seed skill** ✅ DONE (4b899d0) — .arceus/skills-seed/epistemic-discipline (role: ceo/cto/pm/tester): classify the problem TYPE first + tag every claim KNOW/INFER/GUESS. Flows through the seed→registry→materialize pipeline. TDD: seed-contract test (resolvable roles + KNOW/INFER/GUESS body).

---

**ALL 7 ROADMAP COMPONENTS SHIPPED + DEPLOYED.** The board-directives feature (1-5) + memory-write gate (6) + epistemic-discipline skill (7) are complete. Remaining open follow-ups are refinements (LLM directive extractor, fuzzy value conflicts, recurring health probe).

## Explicitly NOT doing (out of scope / already have)
- Firecracker microVMs, revenue-aware auto-rollback, BYO-MCP marketplace, vertical
  template marketplace — big bets, not aligned.
- Already in Arceus: autonomous loop (heartbeat), browser automation + vision
  (flow-tester), tool gating/trust bands, per-company secret injection, circuit
  breakers, multi-tenancy, deploy-resilience, skills.md (registry + materialized).

## Post-roadmap refinements (same loop)
- **Value-conflict detection** ✅ (5d3c428) — findDirectiveConflicts now catches dark-vs-light-theme style opposing VALUES, not just opposing polarity.
- **Role-memory write gate** ✅ (920982b) — isSubstantiveMemoryContent extends Component 6 to applyMemoryModification (meetings/effects.ts).
- **Recurring health probe** ✅ (f9d36ef) — opt-in (HEALTH_PROBE_ENABLED) between-sprints product probe → CEO suggestions; pure selectCompaniesDueForProbe policy + scheduler. Off by default.
- **Hybrid lexical+semantic recall** ✅ (84d3564) — Polsia retrieval-pipeline idea. Hippocampus ranked recall on vectors+tier+MMR only, so an exact-term match could lose to a higher-similarity but lexically-unrelated memory. Added pure RRF + keyword-overlap primitives (hippocampus/engines/hybrid-rank.ts) and fused a keyword ranking into the semantic ranking inside rankAndSelect when queryText is set; prepareAgentContext defaults queryText to the task description. Safe no-ops (no query / no overlap → vector-only behavior). TDD 11/11; full-workspace typecheck green.
- **Expiry-aware recall** ✅ (cb3bd9e) — correctness fix. Recall filtered deletedAt but not expiresAt, so expired temporal facts leaked into prompts between GC sweeps (and the GC-less in-memory fallback never expired anything). Pure isMemoryLive predicate + drop expired candidates as step 0 of rankAndSelect (fail-open on unparseable timestamps) + authoritative (expiresAt IS NULL OR expiresAt > now()) guard in pgvector dynamic searchByEmbedding. TDD 5/5.
- **Value-ranked retention** ✅ (b246386) — "memory fills up → keep decisions, drop chatter." Agent memory was capped at the 100 newest by createdAt, so a durable static decision was silently evicted by recent low-value notes. Pure selectMemoriesToRetain (hippocampus/engines/retention.ts) scores by type durability (static/delegation > procedural > dynamic/priming) + confidence + team-visibility, recency tiebreak, newest-first output; beat-context-builder over-fetches a 300 pool and retains the 100 most valuable. TDD 6/6; builder tests unchanged.
- **Retrieval-time content dedup** ✅ (eb27a6e) — write-side dedup only collapses within one batch, so the same fact via two sources/stores surfaced twice (and MMR can't diversify the no-embedding fallback). Pure dedupeCandidatesByContent (collapse modulo case/punct, keep strongest copy — decayedScore for dynamic else similarity) as a pre-rank step in rankAndSelect. TDD 5/5.

### Recall-quality suite milestone
The Hippocampus recall pipeline is now: **expiry-filter → content-dedup → boost → keyword-fusion (RRF) → MMR**, plus value-ranked retention at the context-builder layer. Consolidated verification: full hippocampus suite 27/27 (8 files), api recall tests 9/9, full-workspace typecheck green on every commit, prod healthy (all breakers closed). The high-value, cleanly-TDD-able recall slices from the teardown are now covered.

- _Remaining / deliberately deferred:_ LLM directive extractor for fuzzy phrasings (LLM-dependent — not cleanly TDD-able); access-based memory reinforcement (write-on-read side effect per recalled memory per beat — heavy + not cleanly TDD-able as a pure unit, deferred).

## Flagged (out of theme, spawned as background task)
- best-effort supabase artifact-blob upload trips the SHARED supabase breaker → flips /health to degraded even though artifact content is safe in postgres (task_cbf209e7). Resilience-wiring concern, not memory/quality.
