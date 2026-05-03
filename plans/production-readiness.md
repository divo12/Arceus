# Production Readiness — Testable Chunks

Goal: divide the system into independently testable chunks ahead of the production date. Each chunk has concrete acceptance criteria. Work the **Suggested attack order** (bottom of file) one chunk at a time.

Conventions:
- `[ ]` = not started, `[~]` = in progress, `[x]` = passing acceptance.
- "Acceptance" is the executable / observable outcome, not the implementation.
- "Gap" calls out where today's behavior is known to diverge.

---

## A. CEO Chat (human ↔ Avery)

- [ ] **A1. Vision → Hiring → First Sprint (cold-start)**
  - Submit fresh idea → strategy generated → approval raised → user approves → 8 agents hired → Sprint 1 created with tasks → first non-CEO beat fires.
  - Acceptance: end-to-end in <2 min; no orphan approvals; all 8 roles seeded.

- [ ] **A2. Free-form CEO conversation**
  - "what's the system doing?", "show me Sprint 1 status", "remember we hate dark mode" → CEO uses `sprint_get_active`, `task_list`, `memory_*` tools.
  - Acceptance: tool calls visible in Langfuse; memory writes land in dynamic tier and are retrievable next turn.

- [ ] **A3. Approvals as first-class UX**
  - CEO raises `approval_request` → web UI surfaces a global indicator → user decides → requesting agent's next beat sees decision.
  - Acceptance: pending-approval count visible on every page; expired approvals auto-close; decision propagates within one tick.
  - Gap: today approvals only show on a tab, not as a global header badge.

- [ ] **A4. CEO ↔ heartbeat collision**
  - While user is streaming chat with Avery, CEO heartbeat must skip cleanly (`isCeoStreaming()`).
  - Acceptance: no shared OpenCode session corruption; chat completes without "session busy".

---

## B. Sprint lifecycle

- [ ] **B1. Heartbeat-only execution (no orchestrator branches)**
  - Audit `apps/api/src` and `packages/company-runtime/src` for any code path that creates tasks, sprints, meetings, or memories outside (a) agent tool calls, (b) user REST actions, (c) seed/bootstrap.
  - Acceptance: no "if condition then create" in heartbeat/scheduler. Turn the audit into a CI guard script.

- [ ] **B2. Sprint completion gate**
  - Tester runs verification → tasks terminal → CEO beat → `sprint_check_completion` → `sprint_finalize` → `sprint_create` for next sprint.
  - Acceptance: no manual nudging; transitions in audit ledger; no duplicate planning tasks.

- [ ] **B3. OpenCode internal tasks as subtasks**
  - When developer runs OpenCode and OpenCode decomposes work via its `todo` tool, those become Arceus subtasks under the parent.
  - Acceptance: `task_append_plan_step` called per OpenCode todo; UI renders nested checklist; closing parent requires all subtasks done.
  - Gap: today opencode runs are opaque blobs.

- [ ] **B4. Sprint atomicity (open audit item F-350)**
  - `createSprintWithTasks` must be atomic across N task INSERTs.
  - Acceptance: kill DB mid-create → sprint either fully exists or doesn't; no orphan tasks.

---

## C. Tasks (typed DoD + evidence)

- [ ] **C1. Typed Definition of Done**
  - Each task kind (`spec`, `code`, `test`, `verification`, `governance`, `preview`) gets a Zod schema for `definitionOfDone` and required `evidence`.
  - Acceptance: `task_complete` rejects payloads missing required evidence; UI shows DoD checklist per task.

- [ ] **C2. Beat side-effects manifest**
  - Every beat record stores: lines added/removed, files touched, tools called (count + names), child meetings/approvals/memories, total cost, total tokens.
  - Acceptance: beat detail page shows a single "side-effects" panel; queryable via `/api/heartbeat/history`.
  - Gap: today this is scattered across 3 sinks.

- [ ] **C3. Artifact provenance**
  - Every artifact links to (beatId, taskId, agentRole, ts). Conventional storage path.
  - Acceptance: clicking artifact in UI jumps to source beat; orphan artifacts flagged.

- [ ] **C4. Task claim/release race**
  - Two beats can't claim same task; releaseClaim on beat failure; stranded-sweeper picks beats >30min.
  - Acceptance: chaos test — kill api mid-beat, restart, claim released within 5-min sweeper window.

---

## D. Memory (Hippocampus)

- [ ] **D1. Tool use timing**
  - Agents call `memory_recall` at beat start, `memory_remember` only for genuinely new info (not echoing context).
  - Acceptance: stable write rate per beat; recall latency <500ms.

- [ ] **D2. Retrieval relevance**
  - "what did we decide about offline mode last sprint?" returns the actual decision memory, not noise.
  - Acceptance: top-3 hit-rate ≥80% on a curated 20-question eval set.

- [ ] **D3. Team-wide / shared memory ("the sharepoint question")**
  - Confirm CEO/CTO/PM read from same dynamic tier per company, or per-agent silos.
  - Acceptance: Lin remembers something → Avery's next beat sees it. If not, build it.

- [ ] **D4. Four-tier discipline**
  - Static (soul/profile) — never written by agents.
  - Procedural (skills) — only written by skills-lead via ATA.
  - Dynamic (facts/decisions) — written by all.
  - Priming (recent context) — auto-rotated, never manually written.
  - Acceptance: writes to wrong tier rejected with clear error.

---

## E. Skills (ATA pipeline)

- [ ] **E1. Skill propose → teach → activate**
  - Pattern detected → Skills Lead proposes → user approves → skill activated → next relevant beat actually uses it.
  - Acceptance: end-to-end in one sprint cycle; activation propagates to all eligible roles' allowlists.

- [ ] **E2. Skill attribution**
  - Beat that used skill X gets X attributed in trace; usage_count increments.
  - Acceptance: `/api/skills/:id` `usage_count` matches audit ledger.

---

## F. Preview / Build / Release

- [ ] **F1. Preview trigger timing**
  - Preview spins up at "build verified" milestone, not before.
  - Acceptance: preview URL appears on task only after build+test pass; not on draft commits.

- [ ] **F2. Context handoff to developer**
  - Developer beat receives: spec, prior commits, failing tests, preview URL.
  - Acceptance: rendered prompt contains all four explicitly (greppable in Langfuse).

- [ ] **F3. Git flow**
  - Each completed code task → commit `[task_xxx] title` → push to feature branch → PR opened by tester after verification.
  - Acceptance: `git log` traceable to task IDs; no commits without task linkage.

- [ ] **F4. Build/release isolation**
  - Builds in `productWorkspace/`, not arceus repo; failure doesn't break orchestrator.
  - Acceptance: kill build mid-flight → arceus api still healthy.

---

## G. Governance / Trust

- [ ] **G1. Trust band updates**
  - Trust changes only on: verified completion (+), bug report (-), failed verification (-), reverted commit (-).
  - Acceptance: every trust change has a `cause` field pointing to the triggering event; no time-decay or noise.

- [ ] **G2. Trust-band → autonomy**
  - Low trust → more approvals required; high trust → fewer.
  - Acceptance: novice-band agent can't complete code task without tester verification; expert can self-verify small changes.

---

## H. Meetings

- [ ] **H1. Trigger discipline**
  - Meetings only on (a) sprint kickoff, (b) sprint review, (c) escalation threshold, (d) explicit agent request.
  - Acceptance: no cron-style meetings; every meeting has a traceable trigger event.

- [ ] **H2. Outcomes are typed**
  - Result schema: `decisions[]`, `actionItems[]` (each → task), `unresolved[]`.
  - Acceptance: `meeting_complete` rejects free-form summary without structured outcome.

- [ ] **H3. Escalation path**
  - Stuck task → developer requests meeting with CTO → meeting concludes with decision → unblocks task.
  - Acceptance: end-to-end test produces unblock within 2 beats of meeting close.

- [ ] **H4. Recording / replay**
  - Full transcript stored; user can replay agent contributions in order.
  - Acceptance: UI replay view exists; transcript matches Langfuse traces.

---

## I. Cost & Budget

- [ ] **I1. Per-beat budget enforcement**
  - Beat exceeding token/cost cap killed cleanly (not orphaned).
  - Acceptance: synthetic runaway beat → killed within budget; task released; audit shows reason.

- [ ] **I2. Per-sprint budget**
  - Sprint cost forecast vs actual visible; CEO notified at 80%.
  - Acceptance: forecast within 20% of actual on completed sprints.

- [ ] **I3. Kill-switch**
  - One env var or UI button stops all heartbeats globally; resume cleanly.
  - Acceptance: `POST /api/admin/pause` → next tick is no-op; `resume` → next tick fires.

---

## J. Observability

- [ ] **J1. Single entry point discipline**
  - All events go through `observability.logEvent`; no direct sink writes.
  - Acceptance: CI grep guard rejects direct `pino`/`langfuse`/`auditLedger` imports outside the observability layer.

- [ ] **J2. Sink fan-out correctness**
  - One event → expected sinks (not all 5 every time). Audit ledger has only categorized events.
  - Acceptance: schema-level test: each event variant declares its sink set; producers can't bypass.

- [ ] **J3. Langfuse trace tree per beat**
  - One beat = one root trace with prompt/completion/tool-call children.
  - Acceptance: random-sample 20 beats, each has complete tree, no orphan spans.

---

## K. Resilience / Persistence

- [ ] **K1. Pattern A discipline (row-lock RMW)**
  - Every `update*` mutation uses `db.transaction` + `lockForUpdate` + `findByIdHydrated` + `upsert`.
  - Acceptance: lint/grep guard; concurrent-update chaos test produces no lost writes.

- [ ] **K2. Pattern B status-guard transitions**
  - Sprint/meeting/task status transitions use status-guarded UPDATE; lost races handled by caller.
  - Acceptance: concurrent finalize attempts → exactly one succeeds, others get clean error.

- [ ] **K3. Process-loss retry**
  - Kill api during beat → restart → beat marked process-lost → retried (up to N) → completes or fails cleanly.
  - Acceptance: `process_loss_retry_count` increments; no infinite retry loop.

- [ ] **K4. Stranded run sweeper**
  - 30+min "running" beats marked failed; claims released; next beat picks up.
  - Acceptance: synthetic stuck beat → sweeper handles in next 5-min window.

---

## L. Multi-company / Reset

- [ ] **L1. Active company switching**
  - Switching company in UI cleanly swaps context; no leaked state.
  - Acceptance: heartbeats for company A don't fire while B is active; data fully isolated.

- [ ] **L2. Company reset**
  - "Reset company" wipes tasks/sprints/meetings/memories/skills back to seed; doesn't break api.
  - Acceptance: post-reset, can re-onboard from scratch with no errors.

---

## M. UI surfaces (web2)

- [ ] **M1. Logs view (firehose)** — every event renders without dropping; pagination under load.
- [ ] **M2. Audit view (curated)** — sequence numbers monotonic; category filter works.
- [ ] **M3. Sprint board** — interactions reflect DB state; no stale renders.
- [ ] **M4. Chat** — streaming works; reconnect on disconnect; history persists.
- [ ] **M5. Memory browser** — view/edit/delete per tier; export.
- [ ] **M6. Approval inbox** — one place for all pending; one-click approve/reject.

---

## N. Sharp-edge angles

- [ ] **N1. Skills Lead bootstrap loop** — hired by default? Proposes first skill in sprint 0?
- [ ] **N2. CTO ↔ Developer escalation (force-complete)** — exercise the existing path.
- [ ] **N3. Tester gate fairness** — max-rejection escalation, not infinite reject.
- [ ] **N4. Bug-report flow** — `task_report_bug` creates linked follow-up task.
- [ ] **N5. OpenCode session GC** — orphaned processes after kill; memory leak risk.
- [ ] **N6. Workspace symlink integrity** — `productWorkspace/.opencode/skills` always resolves (Windows-fragile).
- [ ] **N7. Web2 → API proxy** — prod build doesn't hardcode `:4000`.
- [ ] **N8. Drift test** — `packages/db/tests/drift.test.ts` runs in CI before any release.
- [ ] **N9. Verification gate** — `apps/api/src/verification-gate.test.ts` ditto.
- [ ] **N10. Husky / bun dependency** — committers need bun installed; document or remove.

---

## Suggested attack order (next 24h)

Highest leverage → lowest. One chunk at a time; mark `[~]` when starting, `[x]` when acceptance is met.

1. **B1 + B2** — heartbeat-only audit + sprint completion gate.
2. **C1 + C2** — typed DoD and beat side-effects manifest.
3. **A3** — approvals as global UI element.
4. **D3** — confirm/build team-wide memory.
5. **F1 + F2** — preview timing and developer context handoff.
6. **H1 + H2** — meeting triggers and typed outcomes.
7. **G1** — trust band updates only on real signals.
8. **I3** — kill-switch (production safety net).
9. **J1** — observability single-entry CI guard.
10. **K3 + K4** — process-loss + sweeper chaos tests.
