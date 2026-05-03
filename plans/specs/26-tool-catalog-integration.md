# Spec 26 — Tool Catalog Integration for §1–§5

**Status:** Plan · **Owner:** Platform · **Last Updated:** 2026-04-23
**Depends on:** Spec 12 (Heartbeat), Spec 13 (Governance Gateway), Spec 25 (Agent Auth + Idempotency)
**Coordinates with:** Spec 24 (Facilitator SVC) — this spec ships the deterministic MCP layer; spec 24 ships the subagent layer for §5 meetings
**Scope:** Build the deterministic MCP tool surface for sections §1–§5 of [`05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md) — task lifecycle, artifacts, sprints, approvals, meetings. Skill-invoked operations + subagents for §5 meetings ship in parallel under spec 24.

---

## 0. TL;DR

Five categories, **33 MCP tools total** (all deterministic reads/writes; no SVC wrappers here). This spec defines:

- Per-tool Zod schemas + HTTP routes + MCP registrations
- Per-role allowlist config
- 8 new capabilities (tools not live today)
- 6 allowlist broadenings (add roles to existing tools)
- Consolidations that replace multiple legacy endpoints
- Sync-DB-write flip for `meeting_record` + `artifact_create` (retires fire-and-forget)
- Tests + observability

Shipped in **5 phases, one per category**. Each phase independently deployable.

| Category | Tools | Live today | New | Modified |
|---|---|---|---|---|
| §1 Task lifecycle | 15 | 13 | 2 (`task_report_bug`, `task_hydrate_from_spec`) | 1 (`task_claim` returns `deps_unmet` cause; `task_get` gains `includeProgress`) |
| §2 Artifact management | 4 | 1 (artifact_create) | 3 (`artifact_get`, `artifact_list_sprint`, `artifact_write_to_workspace` — last is live but undocumented) | 1 (`artifact_create` adds `attachToTaskIds`, sync-persist) |
| §3 Sprint lifecycle | 6 | 1 (`sprint_create`) | 5 | 0 |
| §4 Approval flow | 4 | 1 (`approval_request`) | 3 | 1 (`approval_request` expands 5 → 7 types; allowlist 3 → 5 roles) |
| §5 Meeting lifecycle | 4 MCP | 1 (`meeting_record`) | 3 | 1 (`meeting_record` sync-DB-write + CTO added) |
| **Total** | **33** | **17** | **16 new / broadened** | **4 modified contracts** |

Plus: cross-cutting edits to `task_create`/`task_update` (add `referenceArtifactIds`).

---

## 1. Context — what's already in place

Per my audit while walking §1–§5:

### Live and working
- Heartbeat runtime (`apps/api/src/orchestration/run-beat.ts`)
- Beat context + session-context map
- MCP server with 22+ deterministic tools registered
- 8 employee agent files (`mode: primary`) with per-role tool allowlists
- Pattern B CEO sprint-proposal routing (commit `80de168`)
- `memory_handoff` (live; needs allowlist wiring per 05 §6 — not this spec's scope)

### Live with known issues (this spec closes)
- `meeting_record` persists via fire-and-forget (`replaceState` → `schedulePersistedCompanyState`). Anti-pattern #11. Fix: sync DB write.
- `artifact_create` has optional `taskId` param but not `taskIds` array; also fire-and-forget persist. Fix: `attachToTaskIds` array + sync DB.
- `approval_request` allowlist has `mkt, pm, sl` — missing `ceo, cto` needed for hierarchy (CEO→board, CTO→CEO).

### Not live (this spec builds)
- `artifact_get`, `artifact_list_sprint` (reads — missing entirely)
- `artifact_write_to_workspace` (live tool, not in 05; add to doc + role allowlists)
- `task_update`, `task_hydrate_from_spec`, `task_append_result` (live in some agent allowlists, not in 05)
- `task_report_bug` (05 plan, not built)
- Sprint gates + read ops (§3.2–§3.5)
- Approval CRUD (§4.2–§4.5)
- Meeting reads + request/contribute (§5.2–§5.4)

---

## 2. Per-category specification

### §1 — Task lifecycle (15 tools)

**Live (13):** `task_claim`, `task_complete`, `task_verify`, `task_block`, `task_create`, `task_update`, `task_hydrate_from_spec`, `task_get`, `task_get_preview_path`, `task_list_progress`, `task_clear_progress`, `task_append_command`, `task_append_plan_step`, `task_append_result` (most are live in agent allowlists; verify each has an MCP registration)

**New (2):** `task_report_bug`, and extending `task_get` with `includeProgress` flag (replaces `task_get_progress`)

**Modifications:**

- `task_claim` — **change return shape** to include `{status:"error", error:{cause:"deps_unmet", missing:[taskIds]}}` when dependencies unmet. Replaces the need for `task_inspect_readiness`.
- `task_get` — **add `includeProgress: boolean` param**. When true, returns `{...task, progress:{planSteps, commands, percentComplete}}`. Retires `task_get_progress`.
- `task_create` — **add `referenceArtifactIds?: string[]` param**. Attaches existing artifacts to the new task at creation. Replaces standalone `task_attach_artifact`.
- `task_update` — **add `referenceArtifactIds?: string[]` param** (replacement semantics). Enables re-wiring of attachments.

**Per-role allowlist** (matches 05 §1):

| Role | Tools |
|---|---|
| `ceo` | `task_create`, `task_update`, `task_hydrate_from_spec`, `task_get`, `task_list_progress`, `task_append_plan_step`, `task_report_bug` |
| `cto` | as ceo + `task_clear_progress`, `task_inspect_readiness` (keep for now — dropped in 05 but kept for live wiring) |
| `pm` | as cto |
| `dev` | `task_claim`, `task_complete`, `task_block`, `task_get`, `task_get_preview_path`, `task_append_command`, `task_append_plan_step`, `task_append_result`, `task_report_bug` |
| `qa` | dev's + `task_verify` |
| `ui`, `mkt` | `task_claim`, `task_complete`, `task_block`, `task_get`, `task_append_result`, `task_report_bug` |
| `sl` | `task_claim`, `task_complete`, `task_block`, `task_get`, `task_append_command`, `task_append_result` |

**Retire at P1 cutover:**
- `task_inspect_readiness` — information served by `task_claim` error cause + `task_get.dependsOnTaskIds`
- `task_get_progress` — merged into `task_get`
- `task_decompose` — never built; redundant with spec-24-defer Planner

### §2 — Artifact management (4 tools)

**Live (2, need documenting):** `artifact_create`, `artifact_write_to_workspace`

**New (2):** `artifact_get`, `artifact_list_sprint`

**Modifications:**

- `artifact_create` — change `taskId?: string` to `attachToTaskIds?: string[]`; **sync DB write** (retire fire-and-forget — coordinates with spec 24 §20.7 fix)
- `artifact_write_to_workspace` — **broaden allowlist** if needed; confirm `dev, ui_designer, marketing` (already live per ceo.md audit)

**Retire at P2 cutover:**
- `artifact_attach_to_task` (was in 05 §2, never built) — folded into `artifact_create.attachToTaskIds` + `task_create.referenceArtifactIds`
- `task_attach_artifact` (live but duplicate) — same fold
- `artifact_persist` (live, bandwidth-cost tool) — removed; always-persist model

**Per-role allowlist:**

| Role | Tools |
|---|---|
| dev, qa, ui, mkt, cto | `artifact_create`, `artifact_get`, `artifact_write_to_workspace` (dev/ui/mkt only) |
| ceo, cto, pm | `artifact_get`, `artifact_list_sprint` |
| all | `artifact_get` |

### §3 — Sprint lifecycle (6 tools)

**Live (1):** `sprint_create` (ceo only, commit `80de168`)

**New (5):** `sprint_get_active`, `sprint_check_completion`, `sprint_run_qa_gate`, `sprint_run_final_gate`, `sprint_finalize`

**Contract details:**

- `sprint_check_completion` — returns `{total, completed, verified, blocked, failed, remainingRequired, readyToFinalize: boolean}`
- `sprint_run_qa_gate` — qa agent tool. Returns `{passed, failed, failingTasks, logs}`. **Does not auto-demote task statuses** — QA agent reads and decides.
- `sprint_run_final_gate` — cto agent tool. Returns `{buildOk, integrationOk, exportManifestValid, previewStable, errors}`. Same read-only principle.
- `sprint_finalize` — ceo only. Tags workspace (`sprint-N`), archives sprint record, schedules next.

**Retire at P3 cutover:**
- `sprint_propose` (never built; absorbed into `sprint_create`)
- `sprint_begin_execution` (never built; absorbed)

### §4 — Approval flow (4 tools)

**Live (1):** `approval_request` — allowlist `mkt, pm, sl`, 5 types

**New (3):** `approval_get`, `approval_update`, `approval_decide`

**Modifications:**

- `approval_request`:
  - **Broaden allowlist** `mkt, pm, sl` → **`ceo, cto, pm, mkt, sl`** (add ceo + cto for CEO→board, CTO→CEO paths)
  - **Expand types** from 5 to 7: add `architecture_change` (CEO-approver, CTO-requester), `scope_change` (CEO-approver, PM/CTO-requester)
  - Server-side type→approver routing table (new code)

- `approval_get` — **dual-purpose read**. If `approvalId` given: single approval. Otherwise filter args `{status?, filedByMe?, pendingMyDecision?, since?, limit?}` return list. Replaces the need for a separate `approval_list`.

- `approval_decide` — **ceo only**. **Type-gated policy**. CEO can decide `architecture_change`, `scope_change`, `meeting_blocker`, `tool_governance`. Returns 403 `not_authorized` for board-only types (`strategy`, `hire`, `external_action`).

**Retire at P4 cutover:**
- `approval_auto_approve_all` (was in 05 §4, never built) — anti-pattern
- `approval_list` (in 05, replaced by `approval_get` filter args)

### §5 — Meeting lifecycle (4 MCP tools)

This section is **coordinated with spec 24**, which ships the Facilitator subagents + 2 skills for the skill-invoked operations. This spec ships only the 4 deterministic MCP tools.

**Live (1):** `meeting_record` — allowlist `ceo, pm, sl`, fat schema, fire-and-forget persist

**New (3):** `meeting_get`, `meeting_request_decision`, `meeting_contribute`

**Modifications:**

- `meeting_record`:
  - **Broaden allowlist** `ceo, pm, sl` → **`ceo, cto, pm, sl`** (add CTO for architecture meetings)
  - **Sync DB write** — retires fire-and-forget (spec 24 §20.7)
  - Fat schema unchanged (meta + agenda + decisions + learnings + taskModifications + memoryModifications)

- `meeting_get` — read by ID
- `meeting_request_decision` — opens async decision meeting: creates `open_meeting` row + fires `task_create({kind:"meeting_contribute"})` delegations. Returns immediately.
- `meeting_contribute` — attaches position artifact to an open meeting. Deterministic `{meetingId, artifactId}` link.

**Retire at P5 cutover:**
- `meeting_list_available_tools` (in 05, never built) — overengineered
- `meeting_get_specialist_context` (in 05, subagent-internal only)
- `meeting_run`, `meeting_generate_daily_brief`, `meeting_draft_contribution`, `meeting_resolve_decision` (in original 05) — replaced by skill+Task under spec 24

---

## 3. Cross-cutting concerns

### 3.1 Idempotency

All non-GET mutations require `Idempotency-Key` header per **spec 25**. This spec's tool wrappers use `deriveIdempotencyKey(beatId, toolName, body)` (stable content-hash), NOT `randomUUID()`. The per-tool wrappers in `packages/arceus-mcp/src/tools/*.ts` need the post-spec-25 pattern.

### 3.2 Error envelope shape

Every tool returns `ToolResult<T>`:

```typescript
{
  status: "success" | "error" | "partial",
  summary: string,
  data: T | null,
  error: null | { cause: string, message: string }
}
```

New error causes introduced by this spec:
- `deps_unmet` — `task_claim` failed, missing dependencies
- `body_mismatch` — idempotency key replayed with different body
- `type_not_allowed` — `approval_decide` called on board-only type
- `approval_not_pending` — decide/update on already-decided approval
- `sprint_not_executing` — gates called on wrong sprint state

### 3.3 Sync DB persistence

Both `meeting_record` and `artifact_create` flip from fire-and-forget (`schedulePersistedCompanyState`) to **synchronous DB write** within the same transaction as the in-memory snapshot update.

Pattern:

```typescript
export function writeArtifactSync(a: Artifact): void {
  withTransaction(async (txn) => {
    await txn.insertArtifact(a);                 // DB write
    replaceState(snap => ({ ...snap, artifacts: [...snap.artifacts, a] })); // in-memory
    // Both land or both fail
  });
}
```

Pre-existing fire-and-forget path preserved for OTHER snapshot writes (non-critical) pending broader cleanup in spec 24 §20.7.

### 3.4 Reference-artifact wiring

`task_create` and `task_update` both accept `referenceArtifactIds: string[]`. Under the hood, these write to a `task_artifact_references` table (or JSONB column on task). Implementation detail, not visible to callers.

---

## 4. Phase plan

5 phases, one per category. Each independently deployable.

| Phase | Scope | Exit criterion |
|---|---|---|
| **P1 — Task lifecycle** | Ship `task_report_bug`; modify `task_claim`/`task_get`/`task_create`/`task_update`; retire `task_inspect_readiness`, `task_get_progress` | All 15 tools registered + allowlisted; old tools return `410 Gone` with pointer to replacement |
| **P2 — Artifacts** | Ship `artifact_get`, `artifact_list_sprint`; modify `artifact_create` (`attachToTaskIds` + sync DB); retire `artifact_persist`, `artifact_attach_to_task`, `task_attach_artifact` | Artifacts persist to DB synchronously; create-with-attach works atomically |
| **P3 — Sprint** | Ship 5 new sprint tools; retire `sprint_propose`/`sprint_begin_execution` placeholders | QA + CTO agents can run gates; CEO can finalize |
| **P4 — Approvals** | Ship 3 new approval tools; expand types to 7; broaden `approval_request` allowlist; type-gated `approval_decide` | Hierarchical approval path works end-to-end (CEO→board; CTO→CEO) |
| **P5 — Meetings (MCP side)** | Ship `meeting_get`, `meeting_request_decision`, `meeting_contribute`; flip `meeting_record` to sync DB; broaden `meeting_record` allowlist (+ cto) | Integrates with spec 24 P2; meeting polling loop scheduled for removal |

**Parallel tracks:** P1 and P2 can ship simultaneously (independent). P3/P4/P5 serial.

**Spec 24 coordination:** Spec 24 P2 depends on Spec 26 P5's MCP tools. Ship 26 P5 first or alongside.

---

## 5. File manifest

```
packages/arceus-mcp/src/tools/
  task.ts                         MODIFIED (register new tools; update existing)
  artifact.ts                     MODIFIED (update attachToTaskIds; register get/list)
  sprint.ts                       MODIFIED (register 5 new sprint tools)
  approval.ts                     MODIFIED (register 3 new; expand types)
  meeting.ts                      MODIFIED (register 3 new; sync-DB semantics)

apps/api/src/routes/internal-mcp/
  tasks.routes.ts                 MODIFIED (claim returns deps_unmet; task_get includeProgress)
  artifacts.routes.ts             MODIFIED (GET + list routes; attachToTaskIds)
  sprints.routes.ts               MODIFIED (gate + finalize routes)
  approvals.routes.ts             MODIFIED (get/update/decide routes; type enum; type→approver routing)
  meetings.routes.ts              MODIFIED (get + request-decision + contribute routes; sync DB)

apps/api/src/tasks/
  mutations.ts                    MODIFIED (deps_unmet check in claim; referenceArtifactIds wiring)
  claim.ts                        MODIFIED (structured error for unmet deps)

apps/api/src/artifacts/
  persistence.ts                  MODIFIED (always-persist; attachToTaskIds)

apps/api/src/approvals/
  routing.ts                      NEW — type→approver table + enforcement
  decide.ts                       NEW — type-gated decide logic

apps/api/src/sprints/
  gates.ts                        NEW — sprint_run_qa_gate + sprint_run_final_gate

apps/api/src/meetings/
  pipeline.ts                     MODIFIED (meeting_record sync-DB; open_meeting for orchestrated)

apps/api/src/persistence/store.ts MODIFIED (sync DB paths for meetings + artifacts)

.opencode/agent/config.ts         MODIFIED (ALL_ARCEUS_TOOLS adds new tools; per-role allowlists)
.opencode/agent/*.md (all 8)      MODIFIED (per-role tools: true/false updates)

packages/contracts/src/
  approvals.ts                    MODIFIED (type enum 5 → 7; decide schema)
  meetings.ts                     (unchanged — fat schema stays)
  tasks.ts                        MODIFIED (referenceArtifactIds, includeProgress result shape)
  artifacts.ts                    MODIFIED (attachToTaskIds)

test/
  tasks.test.ts                   NEW + existing
  artifacts.test.ts               NEW
  sprints.test.ts                 NEW
  approvals.test.ts               NEW
  meetings.test.ts                MODIFIED
  integration/
    task-lifecycle-e2e.test.ts    NEW
    artifact-lifecycle-e2e.test.ts NEW
    sprint-finalize-e2e.test.ts   NEW
    approval-hierarchy-e2e.test.ts NEW
    meeting-mcp-surface.test.ts   NEW (MCP-only; full meeting flow is spec 24's test)
```

**Estimated LOC:** +1,400 new, −300 retired (task_inspect_readiness, task_get_progress, artifact_attach_to_task, artifact_persist, approval_auto_approve_all, meeting_list_available_tools + helpers). Net +1,100.

---

## 6. Testing

### 6.1 Per-tool unit tests

- Zod schema validates happy + edge cases (empty arrays, bad types)
- Error-cause envelope returned correctly for each failure mode
- Idempotency key content-hash derivation stable across retries

### 6.2 Per-category integration

- **Task lifecycle:** claim → complete → verify roundtrip; deps_unmet reject; bug report creates new task
- **Artifacts:** create-with-attach; get; list-sprint pagination; write-to-workspace materializes file
- **Sprint:** create → gates → finalize with status transitions
- **Approval:** request each type → routing lands in correct queue → decide/reject/update
- **Meeting MCP:** record fat schema → get by id; request_decision creates delegations; contribute attaches

### 6.3 Cross-cutting

- **Idempotency:** retry-safe for every mutation (spec 25 parity)
- **Allowlist:** per-role tool visibility correct
- **Sync DB:** meeting_record + artifact_create row appears immediately in Postgres (not async)
- **Live fixtures:** ensure existing agent flows (CEO sprint_create, etc.) don't regress

### 6.4 Retirement

- `task_inspect_readiness` / `task_get_progress` / `artifact_persist` / etc. — old routes return `410 Gone` with pointer
- Snapshot tests: tools removed from `ALL_ARCEUS_TOOLS`

---

## 7. Observability

Audit events (per spec 25):

- `tool_invoked` — `{role, tool, callId, input_hash}`
- `tool_returned` — `{callId, status, durationMs, errorCause?}`

Category-specific:
- **Sprint:** log gate verdicts + any task state flips from gate outcomes
- **Approval:** log routing decision (board vs CEO) + type gate hits
- **Meeting:** log sync-DB write latency (target p95 < 100ms)

Dashboards:
- Per-tool call volume
- Per-tool error-cause frequency
- Fire-and-forget → sync-DB latency comparison during cutover
- Approval queue depth + age

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| `sync DB write` on `meeting_record` adds latency to chair's beat | Measure during P5; DB round-trip should be <50ms. If higher, investigate before flip |
| Expanding `approval_request` types breaks existing callers | Backward-compatible: old 5 types all still accepted. New types additive. Tests confirm. |
| `task_claim` error-cause change breaks existing error handlers | Old callers already expect `error.cause` generic; new `deps_unmet` is an added value, not breaking |
| Agent allowlist changes (e.g. adding CEO to approval_request) surface tool that agent doesn't know to use | OK — unused tools don't cause issues; agents learn via skill docs or examples |
| Retirement of `task_inspect_readiness` breaks callers | 410 Gone + replacement-hint in error message; two-sprint deprecation window before deletion |

---

## 9. Success criteria

- [ ] All 33 tools registered in `packages/arceus-mcp/src/tools/` with Zod schemas
- [ ] All routes in `apps/api/src/routes/internal-mcp/*.routes.ts` with idempotency + envelope contract
- [ ] Per-role allowlists in `.opencode/agent/*.md` updated per §2 matrices
- [ ] `meeting_record` + `artifact_create` land in Postgres synchronously (DB row exists before tool returns)
- [ ] Approval hierarchy end-to-end: CEO can `approval_decide` on `architecture_change`; rejected with `type_not_allowed` on `strategy`
- [ ] Task claim with unmet deps returns `{error: {cause: "deps_unmet", missing: [...]}}` — no separate inspect needed
- [ ] `task_get({includeProgress: true})` returns plan + command log alongside task
- [ ] Integration tests green end-to-end for all 5 categories
- [ ] Retired tools return 410 Gone (not 404)
- [ ] Spec 24 P2 (meetings subagent work) unblocked

---

## 10. Out of scope

- §6 Memory operations — parked (see [`24-defer.md`](./24-defer.md) §M)
- §7–§16 — later specs
- Facilitator subagents + skills (spec 24)
- Skill-evolution scheduler (parked)
- Planner SVC (parked)
- Plan-Health SVC (parked)
- Hippocampus cleanup PR (tracked separately)
- `GOVERNANCE_ENABLED = false` flip (tracked separately)

---

## 11. Coordination table

| Concern | This spec | Spec 24 | Spec 25 | Other |
|---|---|---|---|---|
| Task MCP tools | ✓ | — | — | — |
| Artifact MCP tools | ✓ | — | — | — |
| Sprint MCP tools | ✓ | — | — | — |
| Approval MCP tools | ✓ | — | — | — |
| Meeting MCP tools (4 deterministic) | ✓ | — | — | — |
| Meeting skill-invoked ops (4) | — | ✓ | — | — |
| Facilitator subagents | — | ✓ | — | — |
| Meeting contribution collection | — | ✓ | — | — |
| Idempotency key scheme | — | — | ✓ | — |
| Bearer token hardening | — | — | ✓ | — |
| Session identity gating | — | — | ✓ | — |
| Memory SVC | — | — | — | Parked (24-defer §M) |
| Skill-Evolution backend | — | — | — | Parked (24-defer §SE) |
| Planner SVC | — | — | — | Parked (24-defer §P) |
| Plan-Health | — | — | — | Parked (24-defer §PH) |

---

## 12. References

- Source of tool-by-tool detail: [`../agent-redesign/05-tool-catalog.md §1–§5`](../agent-redesign/05-tool-catalog.md)
- Philosophy of surface decisions (MCP vs custom vs SVC): [`../agent-redesign/04-ops-by-surface.md`](../agent-redesign/04-ops-by-surface.md)
- Auth + idempotency foundation: [`25-agent-auth-idempotency.md`](./25-agent-auth-idempotency.md)
- Facilitator subagent work: [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md)
- Parked SVC designs: [`24-defer.md`](./24-defer.md)
- In-repo: `packages/arceus-mcp/src/tools/*.ts` (MCP tool registry)
- In-repo: `apps/api/src/routes/internal-mcp/*.routes.ts` (HTTP routes)
- In-repo: `.opencode/agent/*.md` (per-role allowlists)
- In-repo: `packages/contracts/src/*.ts` (shared type schemas)
