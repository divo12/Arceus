# Spec 28 — Gap-Closure Implementation Plan

**Status:** Plan · **Owner:** Platform · **Last Updated:** 2026-04-25
**Closes:** [`28-spec-26-27-gap-analysis.md`](./28-spec-26-27-gap-analysis.md) §2 + §7
**Touches specs:** 24 (P1/P3/P4 — partial), 26 (§1–§5 wrappers + sync-DB foundation), 27 (§8–§11 wrappers + watchdog hook)

---

## 0. TL;DR

Nine phases, **A → I**, ordered by dependency × ROI. Each phase is independently shippable behind its existing feature flag (no new flags). Aggregate effort estimate: **~12–17 engineering days** single-threaded; ~7–9 days with two streams.

| Phase | Theme | Effort | Blocks |
|---|---|---|---|
| **A** | MCP wrapper catch-up (orphan routes + schema lag) | 1.5 d | unblocks B, F, H |
| **B** | Sync-DB-write foundation (`writeArtifactSync`, `writeMeetingSync`) | 1 d | required by C |
| **C** | Cleanup retirements (`task_attach_artifact`, `artifact_persist`, anti-pattern call deletes) | 0.5 d | none |
| **D** | Tasks §1 fill (5 missing tools) | 1 d | none |
| **E** | Sprint gates §3 (4 new gate/finalize tools) | 2 d | none |
| **F** | Approvals §4 (`approval_get`, `_update`, `_decide` + 7-type enum) | 1 d | A.2 |
| **G** | Workspace MCP §8 (4 reads) | 1.5 d | none |
| **H** | Workspace role-custom bundle §8 (qa+dev) | 3 d | A |
| **I** | Watchdog hook §16 + meeting-type-aware prompts (spec 24 §4) | 0.5 d | none |

Out of scope (parked): Spec 24 P1/P3/P4 architectural rework (subagents + skill+SVC); §6 memory tools; §7 skills admin; §13 trust/audit.

---

## 1. Phase A — MCP wrapper catch-up

**Scope.** Bring MCP tool wrappers in sync with routes that already work. Two halves:

### A.1 — Wrap 12 orphan routes (1 d)

Create or extend MCP wrappers in `packages/arceus-mcp/src/tools/` for each route that exists but has no `server.registerTool(...)` call. Pattern: copy existing tool block → adjust path + Zod schema → derive idempotency key.

| # | Tool name | Existing route | Tool file |
|---|---|---|---|
| 1 | `sprint_get_active` | `GET /sprints/active` | `sprint.ts` |
| 2 | `meeting_get` | `GET /meetings/:id` | `meeting.ts` |
| 3 | `meeting_request_decision` | `POST /meetings/:id/request-decision` | `meeting.ts` |
| 4 | `meeting_contribute` | `POST /meetings/:id/contribute` | `meeting.ts` |
| 5 | `company_get_summary` | `GET /company/summary` | `company.ts` (NEW file) |
| 6 | `agent_list_sessions` | `GET /agents/sessions` | `company.ts` |
| 7 | `execution_get` | `GET /execution` | `execution.ts` (NEW file) |
| 8 | `company_update_status` | `POST /company/status` | `company.ts` |
| 9 | `execution_complete_cycle` | `POST /execution/complete-cycle` | `execution.ts` |
| 10 | `execution_pause_for_review` | `POST /execution/pause` | `execution.ts` |
| 11 | `execution_reconcile_post_review` | `POST /execution/reconcile` | `execution.ts` |
| 12 | `execution_stop` | `POST /execution/stop` | `execution.ts` |

Register the new files in `packages/arceus-mcp/src/server.ts` (or wherever `registerArtifactTools` etc. are hooked up).

**Per-role allowlist edits** in [`.opencode/agent/config.ts`](../../.opencode/agent/config.ts) `ALL_ARCEUS_TOOLS` + each `.opencode/agent/<role>.md` per spec 26 §2 / spec 27 §2.2–§2.4.

**Exit criterion:** Each new tool callable from agent session; integration test sends one call per tool, asserts envelope shape.

### A.2 — Update existing wrapper schemas to match routes (0.5 d)

Routes accept new params; MCP schemas don't.

| File | Edit |
|---|---|
| `packages/arceus-mcp/src/tools/task.ts` (`task_create` block) | Add `referenceArtifactIds: z.array(z.string()).max(10).optional()` to `inputSchema`; pass through in body |
| `packages/arceus-mcp/src/tools/task.ts` (`task_update` block) | Same |
| `packages/arceus-mcp/src/tools/artifact.ts` (`artifact_create` block) | Replace `taskId: z.string().optional()` with `attachToTaskIds: z.array(z.string()).max(10).optional()`; **keep** `taskId` for one release cycle, marked deprecated in description |
| `packages/arceus-mcp/src/tools/approval.ts` (`approval_request` block) | Extend type enum: `["strategy","hire","meeting_blocker","external_action","tool_governance","architecture_change","scope_change"]` |

**Exit criterion:** `task_create({referenceArtifactIds:["a1"]})` from an agent attaches the artifact at creation; `approval_request({type:"architecture_change"})` succeeds.

---

## 2. Phase B — Sync-DB-write foundation

**Foundational, not per-tool.** Per §7.3, `replaceState` unconditionally schedules persistence as fire-and-forget. Spec 26 §3.3 needs a parallel **synchronous** write path for critical entities.

### B.1 — Add `writeMeetingSync` + `writeArtifactSync` (1 d)

In [`apps/api/src/persistence/store.ts`](../../apps/api/src/persistence/store.ts):

```typescript
export async function writeMeetingSync(meeting: Meeting): Promise<Meeting> {
  // 1. DB write (await) via @arceus/db
  await db.insertOrUpdateMeeting(meeting);
  // 2. THEN update in-memory snapshot
  upsertMeeting(meeting);
  return meeting;
}

export async function writeArtifactSync(artifact: Artifact): Promise<Artifact> {
  await db.insertOrUpdateArtifact(artifact);
  upsertArtifact(artifact);
  return artifact;
}
```

Wire from:
- [`apps/api/src/routes/internal-mcp/meetings.routes.ts`](../../apps/api/src/routes/internal-mcp/meetings.routes.ts) `POST /meetings` — replace existing `recordMeeting()`-then-flush sequence with `await writeMeetingSync(...)`
- [`apps/api/src/routes/internal-mcp/artifacts.routes.ts`](../../apps/api/src/routes/internal-mcp/artifacts.routes.ts) `POST /artifacts` — same

**No global flip of `replaceState`.** Other snapshot writes stay fire-and-forget; only meetings + artifacts go sync, per spec 26 §3.3.

**Exit criterion:** kill the API process immediately after a `meeting_record` call completes → on restart the meeting row exists. Same for artifacts.

---

## 3. Phase C — Cleanup retirements

### C.1 — Drop deprecated MCP registrations (0.25 d)

| Tool | File | Replacement |
|---|---|---|
| `artifact_persist` | `packages/arceus-mcp/src/tools/artifact.ts:60–80` | Always-persist via `writeArtifactSync`; no replacement tool needed |
| `task_attach_artifact` | `packages/arceus-mcp/src/tools/task.ts:172–187` | `task_create.referenceArtifactIds` / `task_update.referenceArtifactIds` (lands in A.2) |

Routes return `410 Gone` with `tool_retired` cause + `replacement` field for two weeks, then routes deleted.

### C.2 — Delete anti-pattern standalone calls (0.25 d)

Per spec 27 §14:
- `apps/api/src/tasks/planner.ts:91` — delete `generateWorkflowTaskPlan`. CTO uses `plan-task-graph` skill in-beat.
- `apps/api/src/skills/classifier.ts:34` — delete `classifyTaskSkills`. Replaced by progressive-disclosure catalog (already shipped per recent edits to `beat-context-builder.ts`).

Remove all callers; verify no dangling imports via `tsc`.

**Exit criterion:** `grep "generateWorkflowTaskPlan\|classifyTaskSkills"` → 0 hits in `apps/api/src/`.

---

## 4. Phase D — Tasks §1 fill

Five missing MCP tools; routes for two already exist (orphan), three need both route + wrapper.

| Tool | Route status | Action |
|---|---|---|
| `task_get` | ✅ Route at [`tasks.routes.ts:445`](../../apps/api/src/routes/internal-mcp/tasks.routes.ts#L445) | Add MCP wrapper with `taskId: z.string()`, `includeProgress: z.boolean().optional()` |
| `task_report_bug` | ✅ Route at [`tasks.routes.ts:488`](../../apps/api/src/routes/internal-mcp/tasks.routes.ts#L488) | Add MCP wrapper |
| `task_get_preview_path` | ❌ Missing | Add route + wrapper. Returns `{previewPath, previewUrl, lastProbedAt}` for a task |
| `task_list_progress` | ❌ Missing | Add route + wrapper. Returns array of plan-step + command entries |
| `task_clear_progress` | ❌ Missing | Add route + wrapper. CTO/PM only — clears `task.progress.*` arrays |
| `task_append_command` | ❌ Missing | Add route + wrapper. Already has thin tool file at `.opencode/tool/task_append_command.ts` — wrap as MCP and retire role-custom version |

Per-role allowlist updates in `.opencode/agent/<role>.md` per spec 26 §2.1 table.

**Exit criterion:** Developer agent calls `task_get({taskId, includeProgress:true})` and receives `{progress:{planSteps, commands, percentComplete}}`.

---

## 5. Phase E — Sprint gates §3

Four new tools; routes likely landed (verify), MCP wrappers needed.

### E.1 — Verify/build routes (1 d)

| Tool | Route shape | Owner role |
|---|---|---|
| `sprint_check_completion` | `GET /sprints/:id/completion` returns `{total, completed, verified, blocked, failed, remainingRequired, readyToFinalize}` | ceo, cto, pm |
| `sprint_run_qa_gate` | `POST /sprints/:id/qa-gate` runs configured QA suite, returns `{passed, failed, failingTasks, logs}` (read-only — no status mutations) | qa (tester) |
| `sprint_run_final_gate` | `POST /sprints/:id/final-gate` runs build + integration + export-manifest + preview probe; returns `{buildOk, integrationOk, exportManifestValid, previewStable, errors}` | cto |
| `sprint_finalize` | `POST /sprints/:id/finalize` tags workspace, archives sprint record, schedules next | ceo |

New backend logic in [`apps/api/src/sprints/gates.ts`](../../apps/api/src/sprints/) (NEW file) per spec 26 §5 file manifest.

### E.2 — Wrap as MCP tools (0.5 d)

Add to `packages/arceus-mcp/src/tools/sprint.ts`. Idempotency keys via existing helper.

### E.3 — Allowlist + agent prompts (0.5 d)

Update `.opencode/agent/{ceo,cto,tester,pm}.md` with new tools.

**Exit criterion:** End-of-sprint scenario: CEO calls `sprint_check_completion` → all green → CEO calls `sprint_finalize` → workspace tagged `sprint-N`, next sprint scheduled.

---

## 6. Phase F — Approvals §4

Three new MCP tools; A.2 already extends `approval_request` types. Type-gated decide logic exists at [`approvals.routes.ts:198`](../../apps/api/src/routes/internal-mcp/approvals.routes.ts#L198).

| Tool | Route status | Wrapper |
|---|---|---|
| `approval_get` | ✅ Route at [`approvals.routes.ts:131`](../../apps/api/src/routes/internal-mcp/approvals.routes.ts#L131) | Add MCP wrapper. Args: `approvalId?: string`, OR filter `{status?, filedByMe?, pendingMyDecision?, since?, limit?}`. Single dual-purpose endpoint per spec 26 §2 §4. |
| `approval_update` | ❌ Missing | Add `PATCH /approvals/:id` for filer to amend before decision; add wrapper |
| `approval_decide` | ✅ Route at [`approvals.routes.ts:167`](../../apps/api/src/routes/internal-mcp/approvals.routes.ts#L167) | Add MCP wrapper. CEO only. Returns 403 `not_authorized` for board-only types. |

**Exit criterion:** CTO files `approval_request({type:"architecture_change"})` → CEO calls `approval_get({pendingMyDecision:true})` → CEO calls `approval_decide({approvalId, decision:"approved"})` → approval row updated, audit logged.

---

## 7. Phase G — Workspace MCP §8

Four read-side tools. New routes + wrappers.

| Tool | Logic | Roles |
|---|---|---|
| `workspace_get_preview_url` | Read `task.previewUrl` from DB | dev, qa |
| `workspace_get_build_health` | Read cached `{lastBuildOk, lastTypecheckOk, lastTestOk, since, errorsFirstN}` | dev, qa, cto |
| `workspace_check_exports` | AST parse of a module path; verify expected exports list | dev, qa |
| `workspace_verify_baseline` | Composite call: typecheck + smoke tests + preview probe; returns `{ok, failures}` | dev, qa, cto |

Health cache lives in [`apps/api/src/workspace/`](../../apps/api/src/) — shared with the existing probe machinery.

**Exit criterion:** Beat-start probe: agent calls `workspace_verify_baseline()` and gets a typed pass/fail with first 3 errors per failure category.

---

## 8. Phase H — Workspace role-custom bundle §8

Five role-custom tools (not MCP — bundled into agent process via `.opencode/tool/<role>/*.ts`).

| Tool | Owner | Implementation |
|---|---|---|
| `workspace_run_typecheck` | developer | Incremental TS compiler API; in-process Program cache (high-frequency: 5–20×/beat) |
| `workspace_capture_browser_probe` | qa | Playwright headless: navigate → screenshot → console + network + DOM snapshot bundle |
| `workspace_collect_evidence` | qa | Bundle captures into `evidence-{taskId}.zip` artifact, returns artifactId |
| `workspace_run_acceptance_suite` | qa | Reads `task.acceptanceCriteria.suite` ref, runs configured suite |
| `workspace_diff_against_criteria` | qa | Single-shot LLM call: observed behavior diff vs `task.acceptanceCriteria`. Returns `{matches, gaps, unexpected}` |

**Exit criterion:** QA agent end-to-end on one task: `capture_browser_probe` → `collect_evidence` → `diff_against_criteria` → `task_verify` or `task_block`.

---

## 9. Phase I — Hooks + spec 24 §4 polish

### I.1 — `beat_watchdog_reset` PostToolUse hook (0.25 d)

In [`.opencode/plugin/arceus.ts`](../../.opencode/plugin/arceus.ts):

```typescript
export const PostToolUse = async (ctx: PostToolUseContext) => {
  if (ctx.beatId) {
    await fetch(`${ARCEUS_API}/api/internal/v1/beats/${ctx.beatId}/watchdog-reset`, {
      method: "POST",
    });
  }
};
```

Plus the receiving route in [`apps/api/src/routes/internal-mcp/beats.routes.ts`](../../apps/api/src/routes/internal-mcp/beats.routes.ts) (one new endpoint that bumps the beat's `lastActivityAt`).

### I.2 — Meeting-type-aware contribution prompts (0.25 d)

In [`apps/api/src/server.ts:138 collectContributions`](../../apps/api/src/server.ts#L138), replace the single generic prompt with the 3-branch switch from spec 24 §4 (`daily_sync` | `escalation` | `eval_triggered`). Default falls through to current generic template for unknown types.

**Exit criterion:** An eval-failure-triggered meeting contains contributions that explicitly cite the failing eval; an escalation meeting's contributions reference the escalation context.

---

## 10. Sequencing + parallelism

```
Day 1     Day 2     Day 3     Day 4     Day 5     Day 6     Day 7     Day 8
┌───────────────────┐
│  A.1  │  A.2  │ B │
└───────┴───────┴───┘
                    ┌─────┐
                    │  C  │
                    └─────┘
                          ┌──────┐
                          │  D   │
                          └──────┘
                                 ┌────────────┐
                                 │     E      │
                                 └────────────┘
                                              ┌──────┐
                                              │  F   │
                                              └──────┘
                                                     ┌────────┐
                                                     │   G    │
                                                     └────────┘
                                                              ┌─────────────┐
                                                              │      H      │ (separate stream)
                                                              └─────────────┘
                                                                            ┌──┐
                                                                            │ I│
                                                                            └──┘
```

**Two streams cut to ~8 days:**
- Stream 1 (backend-heavy): A → B → C → E → G
- Stream 2 (agent-prompt + role-custom): D → F → H → I

**Hard ordering rules:**
- C requires A.2 (`referenceArtifactIds` lands first so `task_attach_artifact` callers have a migration target)
- F benefits from A.2 (7-type enum) — easier to ship together
- B before any test asserting durability of meetings/artifacts
- I.2 isolated; can ship anytime

---

## 11. Per-phase exit checklist (collected)

Used by the implementer; one tickbox per phase before merging.

- [ ] **A.1** — `meeting_get` + `meeting_request_decision` + `meeting_contribute` + `execution_get` + `company_get_summary` + 7 others callable from a developer agent session
- [ ] **A.2** — `task_create({referenceArtifactIds})` works end-to-end; `approval_request({type:"architecture_change"})` accepted
- [ ] **B** — Process kill after `meeting_record` returns → restart shows row in DB
- [ ] **C** — `tsc` clean after deletes; `artifact_persist` + `task_attach_artifact` return 410
- [ ] **D** — `task_get` returns `{...task, progress}` when `includeProgress:true`
- [ ] **E** — End-of-sprint flow: gates run → finalize → workspace tagged
- [ ] **F** — CEO can decide non-board approval types; receives `not_authorized` on board types
- [ ] **G** — `workspace_verify_baseline` returns typed pass/fail
- [ ] **H** — QA loop fully role-custom (no MCP for typecheck/probe/etc.)
- [ ] **I** — Beat watchdog stops false-firing during long tool sequences; eval-triggered meetings cite eval

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Routes drifted from spec 26/27 contracts during the long lag — wrapping a wrong-shape route ships a wrong-shape tool | Phase A.1 starts each tool with a contract diff: `curl` the route → compare to spec → fix route first if drifted |
| Sync-DB-write (B) introduces latency on hot paths | Only meetings + artifacts go sync; both are low-frequency. Existing fire-and-forget stays for the rest |
| Anti-pattern call deletions (C.2) discover unexpected callers | `tsc --noEmit` + grep across `apps/`, `packages/`, `.opencode/` before merge |
| Role-custom bundle (H) diverges from MCP §8 reads (G) | Share a single `WorkspaceHealthCache` module; both surfaces read from it |
| `beat_watchdog_reset` hook hammers the API on tool-heavy beats | Debounce to 1×/sec per beat in the plugin; receive endpoint is a single in-memory write |

---

## 13. Out of scope

Tracked but explicitly **not** in this plan:

- **Spec 24 P1/P3/P4** — facilitator subagents + skill+SVC + permission gating. Parked per spec-28 §7.5; revisit only if (a) per-beat token budgets bottleneck or (b) Memory-SVC / Planner-SVC revive
- **§6 Memory tools** (`memory_search`, `memory_add_learning`) — deferred; depends on hippocampus public `search()` method
- **§7 Skills admin tools** — depends on Skill-Evolution SVC backend, see [`24-defer.md §SE`](./24-defer.md)
- **§13 Trust/audit reads** — dropped per spec 27 (admin dashboard track instead)
- **CompanyState fire-and-forget global flip** — out of scope; per-tool sync-write only

---

## 14. Cross-references

- [`28-spec-26-27-gap-analysis.md`](./28-spec-26-27-gap-analysis.md) — the gap audit this plan closes
- [`26-implement.md`](./26-implement.md) — per-tool Zod schemas for §1–§5 (lift contracts from here)
- [`27-implement.md`](./27-implement.md) — per-tool detail for §6–§16
- [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md) — meeting-type-aware prompts come from §4
- [`../agent-redesign/05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md) — authoritative target tool surface
