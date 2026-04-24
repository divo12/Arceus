# Spec 26 + 27 — Implementation Gap Analysis

**Status:** Audit · **Owner:** Platform · **Last Updated:** 2026-04-25
**Inputs:** [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md), [`26-tool-catalog-integration.md`](./26-tool-catalog-integration.md), [`26-implement.md`](./26-implement.md), [`27-tool-catalog-integration-continued.md`](./27-tool-catalog-integration-continued.md), [`27-implement.md`](./27-implement.md), [`26-27-23-implementation-plan.md`](./26-27-23-implementation-plan.md)
**Scope:** Identify the gap between what specs 24 + 26 + 27 describe and what currently lives on `opencode-skills/mcp-integration` (post commit `18eb21a` baseline + subsequent landing).

---

## 0. TL;DR

**Scope:** §1 Task, §2 Artifact, §3 Sprint, §4 Approval, §5 Meeting, §8 Workspace, §9 Context, §10 Board, §11 Execution. **Excluded** (tracked separately): §6 Memory (hippocampus engine + `memory_handoff` already live; rest deferred), §7 Skills admin (scheduler-driven pipeline, see `24-defer.md §SE`).

| Layer | Spec target | Implemented | Gap |
|---|---|---|---|
| **MCP-registered tools** (LLM-visible, in scope) | ~56 across §1–§5 + §8–§11 | **23** | **−33** |
| **HTTP routes** (API callable, in scope) | ~56 with routes | **46** | **−10** |
| **Tools missing entirely** (no route, no MCP) | — | — | **21** |
| **Orphan routes** (route exists, no MCP wrapper) | — | — | **12** |

> Plus **1 bonus live MCP tool** (`memory_handoff`) in parked §6 — live and working; just not counted against the in-scope roadmap target.

**Headline:** spec-26 §1 (task lifecycle) is mostly shipped; §2 (artifacts), §3 (sprints), §4 (approvals), §5 (meetings) shipped partially — routes landed, most MCP wrappers didn't. Spec-27 §8 (workspace), §9 (context), §10 (board), §11 (execution) largely unimplemented at the MCP layer.

**Cleanup still pending:** `artifact_persist` and `task_attach_artifact` should be retired per spec-26 but remain live.

---

## 1. Per-category status

Legend:
- ✅ **Live MCP** — tool registered + route working
- 🟨 **Route only** — HTTP endpoint exists; no MCP wrapper yet (LLM can't call it directly)
- ❌ **Missing** — neither route nor MCP tool
- ➖ **Retired** — supposed to be removed (spec-26 cleanup)
- 🔄 **Needs mod** — tool exists but needs contract change per spec

### §1 — Task lifecycle (spec target: 15 tools)

| # | Tool | MCP | Route | Spec change | Status |
|---|---|:-:|:-:|:-:|---|
| 1 | `task_claim` | ✅ | ✅ | + `deps_unmet` error cause | ✅ **Live** (verify error-cause shape) |
| 2 | `task_complete` | ✅ | ✅ | — | ✅ **Live** |
| 3 | `task_verify` | ✅ | ✅ | — | ✅ **Live** |
| 4 | `task_block` | ✅ | ✅ | — | ✅ **Live** |
| 5 | `task_create` | ✅ | ✅ | + `referenceArtifactIds[]` | 🔄 **Verify contract** |
| 6 | `task_update` | ✅ | ✅ | + `referenceArtifactIds[]` | 🔄 **Verify contract** |
| 7 | `task_hydrate_from_spec` | ✅ | ✅ | — | ✅ **Live** |
| 8 | `task_get` | ❌ | ❌ | + `includeProgress` flag | ❌ **MISSING** |
| 9 | `task_get_preview_path` | ❌ | ❌ | — | ❌ **MISSING** |
| 10 | `task_list_progress` | ❌ | ❌ | — | ❌ **MISSING** |
| 11 | `task_clear_progress` | ❌ | ❌ | — | ❌ **MISSING** |
| 12 | `task_append_command` | ❌ | ❌ | — | ❌ **MISSING** (plan said "live" but not registered) |
| 13 | `task_append_plan_step` | ✅ | ✅ | — | ✅ **Live** |
| 14 | `task_append_result` | ✅ | ✅ | — | ✅ **Live** |
| 15 | `task_report_bug` | ❌ | ❌ | new | ❌ **MISSING** |
| — | `task_attach_artifact` | ✅ | ✅ | ➖ retire | ⚠️ **Live but should retire** |
| — | `task_update_progress` | ✅ | ✅ | — | ⚠️ **Live — not in catalog; keep or rename?** |
| — | `task_set_preview_url` | ✅ | ✅ | — | ⚠️ **Live — not in catalog; keep or rename?** |

**§1 score:** 7/15 live, 6 missing, 2 need verification, 1 retirement pending.

### §2 — Artifact management (spec target: 4)

| # | Tool | MCP | Route | Spec change | Status |
|---|---|:-:|:-:|:-:|---|
| 1 | `artifact_create` | ✅ | ✅ | + `attachToTaskIds[]`, sync DB | 🔄 **Verify contract** |
| 2 | `artifact_get` | ❌ | ❌ | new | ❌ **MISSING** |
| 3 | `artifact_list_sprint` | ❌ | ❌ | new | ❌ **MISSING** |
| 4 | `artifact_write_to_workspace` | ✅ | ✅ | — | ✅ **Live** |
| — | `artifact_persist` | ✅ | — | ➖ retire | ⚠️ **Live but should retire** |

**§2 score:** 2/4 live, 2 missing, 1 retirement pending.

### §3 — Sprint lifecycle (spec target: 6)

| # | Tool | MCP | Route | Status |
|---|---|:-:|:-:|---|
| 1 | `sprint_create` | ✅ | ✅ | ✅ **Live** |
| 2 | `sprint_get_active` | ❌ | ✅ | 🟨 **Route only** |
| 3 | `sprint_check_completion` | ❌ | ❌ | ❌ **MISSING** |
| 4 | `sprint_run_qa_gate` | ❌ | ❌ | ❌ **MISSING** |
| 5 | `sprint_run_final_gate` | ❌ | ❌ | ❌ **MISSING** |
| 6 | `sprint_finalize` | ❌ | ❌ | ❌ **MISSING** |

**§3 score:** 1/6 live, 1 route-only, 4 missing.

### §4 — Approval flow (spec target: 4)

| # | Tool | MCP | Route | Spec change | Status |
|---|---|:-:|:-:|:-:|---|
| 1 | `approval_request` | ✅ | ✅ | types 5 → 7, allowlist +ceo/+cto | 🔄 **Verify contract** |
| 2 | `approval_get` | ❌ | ❌ | new | ❌ **MISSING** |
| 3 | `approval_update` | ❌ | ❌ | new | ❌ **MISSING** |
| 4 | `approval_decide` | ❌ | ❌ | new | ❌ **MISSING** |

**§4 score:** 1/4 live, 3 missing.

### §5 — Meeting lifecycle (spec target: 4 MCP)

| # | Tool | MCP | Route | Spec change | Status |
|---|---|:-:|:-:|:-:|---|
| 1 | `meeting_record` | ✅ | ✅ | sync DB write | 🔄 **Verify sync flip** |
| 2 | `meeting_get` | ❌ | ✅ | new | 🟨 **Route only** |
| 3 | `meeting_request_decision` | ❌ | ✅ | new | 🟨 **Route only** |
| 4 | `meeting_contribute` | ❌ | ✅ | new | 🟨 **Route only** |

**§5 score:** 1/4 live MCP, 3 route-only.

> **§6 Memory and §7 Skills admin are out of scope for this gap analysis.**
> §6 is covered by the hippocampus engine + the `memory_handoff` MCP tool
> that already shipped (live); the remaining `memory_search` +
> `memory_add_learning` are deferred pending the hippocampus public
> `search()` method. §7 is scheduler-driven pipeline territory (spec 28 +
> [`24-defer.md §SE`](./24-defer.md)). Both tracked separately; not part of
> first-ship roadmap.

### §8 — Workspace (spec target: 11, mixed MCP + role-custom)

| # | Tool | Surface | MCP | Route | Status |
|---|---|---|:-:|:-:|---|
| 1 | `workspace_checkpoint` | MCP | ✅ | ✅ | ✅ **Live** |
| 2 | `workspace_probe_preview` | MCP | ✅ | ✅ | ✅ **Live** |
| 3 | `workspace_get_preview_url` | MCP | ❌ | ❌ | ❌ **MISSING** |
| 4 | `workspace_get_build_health` | MCP | ❌ | ❌ | ❌ **MISSING** |
| 5 | `workspace_check_exports` | MCP | ❌ | ❌ | ❌ **MISSING** |
| 6 | `workspace_verify_baseline` | MCP | ❌ | ❌ | ❌ **MISSING** |
| 7 | `workspace_run_typecheck` | Role-custom | — | — | ❌ **MISSING** (needs `.opencode/tool/developer/run_typecheck.ts`) |
| 8 | `workspace_capture_browser_probe` | Role-custom | — | — | ❌ **MISSING** (needs `.opencode/tool/qa/capture_browser_probe.ts`) |
| 9 | `workspace_collect_evidence` | Role-custom | — | — | ❌ **MISSING** |
| 10 | `workspace_run_acceptance_suite` | Role-custom | — | — | ❌ **MISSING** |
| 11 | `workspace_diff_against_criteria` | Role-custom | — | — | ❌ **MISSING** |

**§8 score:** 2/11 live. 9 missing (4 MCP + 5 role-custom bundle tools).

### §9 — Company / agent context (spec target: 4)

| # | Tool | MCP | Route | Status |
|---|---|:-:|:-:|---|
| 1 | `company_get_summary` | ❌ | ✅ | 🟨 **Route only** |
| 2 | `agent_list_sessions` | ❌ | ✅ | 🟨 **Route only** |
| 3 | `execution_get` | ❌ | ✅ | 🟨 **Route only** |
| 4 | `company_update_status` | ❌ | ✅ | 🟨 **Route only** |

**§9 score:** 0/4 MCP. All 4 routes landed but zero MCP wrappers — **quick win category**.

### §10 — Board / comms (spec target: 2)

| # | Tool | MCP | Route | Status |
|---|---|:-:|:-:|---|
| 1 | `board_post_message` | ❌ | ❌ | ❌ **MISSING** |
| 2 | `board_list_messages` | ❌ | ❌ | ❌ **MISSING** |

**§10 score:** 0/2. Entire category unimplemented.

### §11 — Execution control (spec target: 4)

| # | Tool | MCP | Route | Status |
|---|---|:-:|:-:|---|
| 1 | `execution_complete_cycle` | ❌ | ✅ | 🟨 **Route only** |
| 2 | `execution_pause_for_review` | ❌ | ✅ | 🟨 **Route only** (route named `/pause`) |
| 3 | `execution_reconcile_post_review` | ❌ | ✅ | 🟨 **Route only** (route named `/reconcile`) |
| 4 | `execution_stop` | ❌ | ✅ | 🟨 **Route only** |

**§11 score:** 0/4 MCP. All 4 routes landed — **quick win category** alongside §9.

### §13 — Trust / audit (spec target: 0 — dropped)

Correctly not implemented. Dropped per spec 27 §6.2 as policy-exfil risk. Admin dashboard (future follow-on) for human reads.

### §14 — Planning / reasoning (spec target: 0 — dropped)

Correctly not implemented. Replaced by `plan-task-graph` + `plan-health-review` skills (both shipped in commit `c5c8725`). Two standalone LLM call sites (`generateWorkflowTaskPlan`, `classifyTaskSkills`) still need deletion — pending code cleanup.

### §15 — Reports / briefs (spec target: 0 — consolidated)

Correctly not implemented. Templates live in skills; calls go through `artifact_create`.

### §16 — Misc / identity (spec target: 0 — dropped)

Correctly not implemented. `beat_watchdog_reset` hook missing per spec 27 §3.2 (still need to add `PostToolUse` hook on every tool call → `resetBeatWatchdog(beatId)`).

---

## 2. Summary by action class

### Orphan routes (12) — low-effort MCP wrapping

Each needs a short tool file in `packages/arceus-mcp/src/tools/`. Estimated 1-2 hours each; total ~1-2 days:

1. `sprint_get_active` → `GET /sprints/active`
2. `meeting_get` → `GET /meetings/:id`
3. `meeting_request_decision` → `POST /meetings/request-decision`
4. `meeting_contribute` → `POST /meetings/:id/contribute`
5. `company_get_summary` → `GET /company/summary`
6. `agent_list_sessions` → `GET /agents/sessions`
7. `execution_get` → `GET /execution`
8. `company_update_status` → `POST /company/status`
9. `execution_complete_cycle` → `POST /execution/complete-cycle`
10. `execution_pause_for_review` → `POST /execution/pause`
11. `execution_reconcile_post_review` → `POST /execution/reconcile`
12. `execution_stop` → `POST /execution/stop`

### Missing — needs both route + MCP wrapper (21 tools)

By category:

- **Task (6):** `task_get`, `task_get_preview_path`, `task_list_progress`, `task_clear_progress`, `task_append_command`, `task_report_bug`
- **Artifact (2):** `artifact_get`, `artifact_list_sprint`
- **Sprint (4):** `sprint_check_completion`, `sprint_run_qa_gate`, `sprint_run_final_gate`, `sprint_finalize`
- **Approval (3):** `approval_get`, `approval_update`, `approval_decide`
- **Workspace MCP (4):** `workspace_get_preview_url`, `workspace_get_build_health`, `workspace_check_exports`, `workspace_verify_baseline`
- **Board (2):** `board_post_message`, `board_list_messages`

### Missing — role-custom bundle (5 tools)

Need new `.opencode/tool/<role>/*.ts` files (developer bundle + qa bundle):

- `workspace_run_typecheck` (developer)
- `workspace_capture_browser_probe` (qa)
- `workspace_collect_evidence` (qa)
- `workspace_run_acceptance_suite` (qa)
- `workspace_diff_against_criteria` (qa)

### Contract verification needed (5 tools)

Live but may not match the post-spec-26 contract:

- `task_claim` — verify `deps_unmet` error cause with `{missing: [taskIds]}` detail
- `task_create` — verify `referenceArtifactIds?: string[]` param accepted
- `task_update` — verify `referenceArtifactIds?: string[]` param accepted
- `artifact_create` — verify `attachToTaskIds: string[]` (array, not single `taskId`) + sync DB write
- `meeting_record` — verify sync DB write (not fire-and-forget)
- `approval_request` — verify types 5 → 7, allowlist adds `ceo` + `cto`

### Cleanup pending

**Retire per spec 26:**
- `artifact_persist` MCP registration
- `task_attach_artifact` MCP registration

**Delete per spec 27 §14 / philosophy §2.5:**
- `generateWorkflowTaskPlan` at `apps/api/src/tasks/planner.ts:91`
- `classifyTaskSkills` at `apps/api/src/skills/classifier.ts:34`

### Not-yet-added hooks

**§16 requires:** `beat_watchdog_reset` PostToolUse hook in `.opencode/plugin/arceus.ts`

---

## 3. Recommended ordering

### Phase A — Close orphan-route gap (1–2 days)

Wrap all 12 routes as MCP tools. Zero new backend work; pure adapter layer. Unblocks 12 tools across §3/§5/§9/§11 immediately.

### Phase B — Contract verification sweep (0.5 day)

Diff the 5 live-but-uncertain tools against their spec contracts. Either confirm they match or file fix PRs.

### Phase C — Cleanup retirements (0.5 day)

- Drop `artifact_persist` + `task_attach_artifact` MCP registrations
- Return 410 Gone on corresponding routes for 2 weeks
- Delete anti-pattern standalone calls (`generateWorkflowTaskPlan`, `classifyTaskSkills`)

### Phase D — Fill §1/§2/§4 gaps (2–3 days)

High-value reads + writes:
- Tasks: `task_get`, `task_report_bug`, `task_append_command`, 3 progress tools
- Artifacts: `artifact_get`, `artifact_list_sprint`
- Approvals: `approval_get`, `approval_update`, `approval_decide`

### Phase E — Sprint gates (2–3 days)

The §3 gate trio (`sprint_check_completion`, `sprint_run_qa_gate`, `sprint_run_final_gate`, `sprint_finalize`) — needed for sprint close.

### Phase F — Board surface (1–2 days)

`board_post_message` + `board_list_messages` — CEO-only; straightforward.

### Phase G — Workspace MCP tools (2–3 days)

4 remaining MCP tools in §8: preview URL read, build health, exports check, baseline verify.

### Phase H — Workspace role-custom bundle (3–4 days)

5 QA + dev role-custom tools. Need Playwright (qa bundle) + TypeScript Program cache (dev bundle).

### Phase I — Hooks + plugin polish (0.5 day)

Add `beat_watchdog_reset` PostToolUse hook. Review allowlist per-role configs match catalog.

**Total effort estimate: ~12–17 engineering days (single-threaded).** Parallelizable across 2-3 streams.

### Out of scope (tracked separately)

- §6 Memory tools (`memory_search`, `memory_add_learning`) — deferred; `memory_handoff` already live
- §7 Skills admin (7 SL tools) — spec 28 (background signal pipelines); [`24-defer.md §SE`](./24-defer.md)
- §12 Governance reads — closed per spec 27 (no implementation needed)
- §13 Trust/audit — dropped (admin dashboard follow-on, not tool work)

---

## 4. Risks + notes

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Orphan routes have subtly different contracts than their spec MCP wrappers | Medium | Low-Medium | Verify request/response shapes when wrapping; fix routes first if drifted |
| `artifact_persist` retirement breaks live agents calling it | Low | Medium | 410 Gone window; `tool_retired` error cause with `replacement` pointer |
| Live `task_attach_artifact` callers have no migration | Medium | Medium | Check agent `.md` files for calls; migrate to `task_create.referenceArtifactIds` |
| Some "live" tools may have drifted behavior across the rebase | Low | Medium | Re-run integration tests after each batch of MCP wrappings |

### Notes for implementers

- The wrapping pattern is well-established — copy `task.ts` or `artifact.ts` structure for new tool files.
- Use `deriveIdempotencyKey(ctx.beatId, <tool_name>, args)` for any mutation.
- Return `toMcpContent(res.data)` uniformly.
- Remember to update per-role allowlists in `apps/api/workspace/.opencode/agent/<role>.md` when adding tools.
- The HTTP routes already use shared helpers (`route-helpers.ts`) from Phase 1 of the implementation plan.

---

## 5. Cross-references

- [`../agent-redesign/05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md) — authoritative spec for the target tool surface
- [`../agent-redesign/07-memory-and-skills-philosophy.md`](../agent-redesign/07-memory-and-skills-philosophy.md) — why §6/§7 look the way they do
- [`26-tool-catalog-integration.md`](./26-tool-catalog-integration.md) — spec for §1–§5 (high-level)
- [`26-implement.md`](./26-implement.md) — spec for §1–§5 (per-tool Zod + routes)
- [`27-tool-catalog-integration-continued.md`](./27-tool-catalog-integration-continued.md) — spec for §6–§16 (high-level)
- [`27-implement.md`](./27-implement.md) — spec for §6–§16 (per-tool detail)
- [`26-27-23-implementation-plan.md`](./26-27-23-implementation-plan.md) — upstream's own phased plan (7 phases, Days 1–7)
- [`24-defer.md`](./24-defer.md) — why §7 skills admin and §M memory SVC are deferred/not-built

## 6. Updates

This doc is a point-in-time snapshot (2026-04-24, post `18eb21a`). Re-audit after each major commit batch. Could be auto-generated in future — the `registerTool(...)` calls and route definitions are both grep-able for a simple diff tool.

---

## 7. Follow-up audit — 2026-04-25 (Spec 24 + contract re-verification)

Second-pair-of-eyes pass. Adds spec-24 coverage (the cofounder's audit focused on §1–§16 of `05-tool-catalog`; spec 24's facilitator architecture wasn't scored). Also re-verifies the five "contract verification needed" items in §2 by reading the live code.

### 7.1 Spec 24 — Facilitator SVC status

Spec 24's *outcome* (kill the 3 cold `structuredCompletion` calls + the 5-min polling loop) shipped — but via a different architecture than the spec called for. The skill+SVC pattern is **not implemented**.

| Spec 24 deliverable | Status | Evidence |
|---|---|---|
| Multi-turn Facilitator session replacing `synthesizeMeeting` + `resolveMeeting` + `buildDailySyncBrief` | ✅ **Done** | [`apps/api/src/meetings/facilitator.ts`](../../apps/api/src/meetings/facilitator.ts) — `runFacilitatorSession()` runs 3 phases (synthesize → resolve → brief) over a single `facilitator_agent` session via `runInternalAgentPrompt` |
| Direct `runPromptText` per participant (replaces 5-min polling) | ✅ **Done** | [`apps/api/src/server.ts:138`](../../apps/api/src/server.ts#L138) — `collectContributions` calls `runPromptText(role, sessionId, soul.systemPrompt, prompt)` per agent |
| Meeting-type-aware contribution prompts (standup / escalation / eval_triggered) | ❌ **Missing** | The prompt in `server.ts:155–162` is a single generic template with `meeting.type.replace(/_/g, " ")` interpolated — no `switch (meeting.type)` per spec §4 |
| `facilitator-chair-service` subagent (`.opencode/agent/facilitator-chair-service.md`) | ❌ **Missing** | No `facilitator-*-service.md` exists under `.opencode/agent/` |
| `facilitator-contributor-service` subagent | ❌ **Missing** | Same |
| Per-employee `permission.task: { facilitator-*-service: allow/deny }` | ❌ **Missing** | No subagent → no gating to wire |
| `meeting-chair-playbook` skill | 🟨 **Seeded** | [`.arceus/skills-seed/meeting-chair-playbook/`](../../.arceus/skills-seed/meeting-chair-playbook/) exists but has no subagent to invoke via `Task()` |
| `meeting-contribution-drafter` skill | 🟨 **Seeded** | [`.arceus/skills-seed/meeting-contribution-drafter/`](../../.arceus/skills-seed/meeting-contribution-drafter/) — same condition |
| `ARCEUS_SVC_ENABLED` feature flag | ❌ **Missing** | `grep ARCEUS_SVC_ENABLED` → 0 hits in code |
| `meeting_record` synchronous DB write (kills fire-and-forget; spec 24 §20.7) | ❌ **Not done** | [`apps/api/src/persistence/store.ts:325`](../../apps/api/src/persistence/store.ts#L325) `upsertMeeting` → `replaceState` → `void schedulePersistedCompanyState(...)` (line 43) — fire-and-forget for everything including meetings |
| Phase-4 cleanup: delete `synthesizeMeeting`/`resolveMeeting`/`generateContribution` | ❌ **Not done** | [`apps/api/src/meetings/synthesis.ts`](../../apps/api/src/meetings/synthesis.ts) and [`resolution.ts`](../../apps/api/src/meetings/resolution.ts) still present and exported |
| Remove `meeting_contribution:` checklist action | ❌ **Not done** | Still referenced at [`apps/api/src/heartbeats/checklist-executor.ts:214`](../../apps/api/src/heartbeats/checklist-executor.ts#L214) |
| `meeting_request_decision` MCP tool (P3 orchestrated decision meetings) | ❌ **Missing** | Route exists ([`meetings.routes.ts:208`](../../apps/api/src/routes/internal-mcp/meetings.routes.ts#L208)); MCP wrapper not in [`packages/arceus-mcp/src/tools/meeting.ts`](../../packages/arceus-mcp/src/tools/meeting.ts) |
| `meeting_contribute` MCP tool | ❌ **Missing** | Route exists ([`meetings.routes.ts:259`](../../apps/api/src/routes/internal-mcp/meetings.routes.ts#L259)); no MCP wrapper |
| `meeting_get` MCP tool | ❌ **Missing** | Route exists ([`meetings.routes.ts:193`](../../apps/api/src/routes/internal-mcp/meetings.routes.ts#L193)); no MCP wrapper |

**Bottom line:** Spec 24 P0–P2 *value* delivered (no more polling, single facilitator session). P1 (subagents + skills + permission gating), P3 (orchestrated decisions), and P4 (cutover/cleanup) **not done**. The system is currently in a hybrid state — new in-process facilitator + legacy modules co-resident.

### 7.2 Re-verification of "contract verification needed" items (§2)

The cofounder's table flagged 5 items as needing verification. Checked each by reading the live code today:

| Tool | Spec contract | Live state | Verdict |
|---|---|---|---|
| `task_claim` | Returns `{status:"error", error:{cause:"deps_unmet", missing:[ids]}}` | Route returns `cause: "deps_unmet"` ([`tasks.routes.ts:426`](../../apps/api/src/routes/internal-mcp/tasks.routes.ts#L426)); `deps_unmet` is in `errorCause` enum + status map ([`envelope.ts:44,80`](../../apps/api/src/routes/internal-mcp/envelope.ts#L44)). MCP wrapper at [`task.ts:190`](../../packages/arceus-mcp/src/tools/task.ts#L190) just forwards. | ✅ **Matches** |
| `task_create` | Adds `referenceArtifactIds?: string[]` | Route accepts it ([`tasks.routes.ts:88`](../../apps/api/src/routes/internal-mcp/tasks.routes.ts#L88)); **MCP wrapper does not declare it in `inputSchema`** ([`task.ts:101–124`](../../packages/arceus-mcp/src/tools/task.ts#L101)) — agents calling via MCP can't pass it | 🔄 **Partial — MCP schema lags** |
| `task_update` | Adds `referenceArtifactIds?: string[]` | Route accepts it ([`tasks.routes.ts:97`](../../apps/api/src/routes/internal-mcp/tasks.routes.ts#L97)); **MCP wrapper schema does not include it** ([`task.ts:124`](../../packages/arceus-mcp/src/tools/task.ts#L124)) | 🔄 **Partial — MCP schema lags** |
| `artifact_create` | `attachToTaskIds: string[]` (replaces `taskId`); **synchronous DB write** | Route schema has `attachToTaskIds` and falls back to legacy `taskId` ([`artifacts.routes.ts:69,100`](../../apps/api/src/routes/internal-mcp/artifacts.routes.ts#L69)). **MCP wrapper still uses single `taskId`** ([`artifact.ts:23`](../../packages/arceus-mcp/src/tools/artifact.ts#L23)). **Persistence still fire-and-forget** via `replaceState`. | 🔄 **MCP schema lags + sync-write NOT done** |
| `meeting_record` | Synchronous DB write | Same fire-and-forget path as artifacts (`upsertMeeting` → `replaceState` → `schedulePersistedCompanyState`). | ❌ **Sync-write NOT done** |
| `approval_request` | Types **5 → 7** (add `architecture_change`, `scope_change`); allowlist adds `ceo` + `cto` | MCP tool still declares **5 types** at [`approval.ts:20`](../../packages/arceus-mcp/src/tools/approval.ts#L20): `["strategy","hire","meeting_blocker","external_action","tool_governance"]` — no `architecture_change`/`scope_change`. Allowlist broadening not verified here. | ❌ **MCP schema NOT updated** |

**Pattern:** Routes were updated to the new contracts; **MCP tool wrappers were left on the old schemas**. Agents calling via MCP cannot exercise the new params — they have to hit the HTTP route directly, which they don't normally do. This is a single common cause for several gap-analysis flags.

### 7.3 Additional concrete findings beyond §2

1. **Sync-DB-write flip is architecturally absent, not just per-tool**
   The store's `replaceState` ([`store.ts:48`](../../apps/api/src/persistence/store.ts#L48)) unconditionally calls `persistState()` which is fire-and-forget. Per-tool fixes (`writeArtifactSync`, `writeMeetingSync`) from spec 26 §3.3 were never added. Any spec calling for "sync DB write" needs a new write path, not a flip on an existing call. **This is a foundation gap, not a per-tool gap.**

2. **`task_get` route exists but is not registered as MCP tool**
   Route at [`tasks.routes.ts:445`](../../apps/api/src/routes/internal-mcp/tasks.routes.ts#L445), accepts `?includeProgress=`. Adding the MCP wrapper would knock out the §1 "task_get + task_get_progress merger" item with one short tool file.

3. **`task_report_bug` route exists but is not registered as MCP tool**
   Route at [`tasks.routes.ts:488`](../../apps/api/src/routes/internal-mcp/tasks.routes.ts#L488). Same one-tool-file fix.

4. **Spec 27 §14 anti-pattern deletions — status not yet checked**
   `generateWorkflowTaskPlan` (`apps/api/src/tasks/planner.ts:91`) and `classifyTaskSkills` (`apps/api/src/skills/classifier.ts:34`) — confirm at next audit pass.

5. **Spec 27 §16 `beat_watchdog_reset` PostToolUse hook — confirmed missing**
   `grep PostToolUse|watchdog` in [`.opencode/plugin/arceus.ts`](../../.opencode/plugin/arceus.ts) → 0 hits. The doc already calls this out in §2; flagging here that nothing has changed.

### 7.4 Updated phase recommendation

The cofounder's Phase A (orphan-route MCP wrapping) is **the right starting point**, but it should explicitly include:

- **A.1** — Wrap the 12 orphan routes from §2 (unchanged from existing recommendation)
- **A.2** — Update existing MCP wrapper schemas in `task.ts`, `artifact.ts`, `approval.ts` to expose the new params/enum values that already work at the route layer:
  - `task_create` + `task_update`: add `referenceArtifactIds: z.array(z.string()).max(10).optional()`
  - `artifact_create`: replace `taskId` with `attachToTaskIds: z.array(z.string()).max(10).optional()` (keep `taskId` as deprecated fallback for one release)
  - `approval_request`: extend type enum to 7 values
- **A.3** — Spec 24 P3 (`meeting_request_decision` + `meeting_contribute` MCP wrappers) lands as a direct byproduct of A.1; adding a thin "meeting-type-aware prompt switch" in `server.ts:collectContributions` is a 30-line edit with high ROI.

**Cost:** Roughly identical to the existing Phase A estimate (1–2 days) — A.2 is just additive Zod fields in already-touched files.

### 7.5 New deferred bucket — Spec 24 architectural rework

The skill+SVC architecture (subagents + `Task()` invocation + per-tier `permission.task`) deserves an explicit "park or pursue" decision:

- **Park option:** The current in-process facilitator works. Two sprints of stable meetings means the architectural rework is unnecessary — book the LoC savings, mark spec 24 P1/P3/P4 as "superseded by in-process facilitator", and move on.
- **Pursue option:** The token-savings argument from spec 24 §2 (~1,080 tokens/role × 8 roles vs ~30 tokens/role for skill manifests) is real and recurring. If meeting volume scales, the savings compound.

Recommend **park** until either (a) per-beat token budgets become a measurable bottleneck, or (b) the broader skill+SVC pattern (Memory SVC, Planner SVC) gets revived from `24-defer.md`. Promote facilitator subagents *after* one of those, not before.

### 7.6 Single-line summary

- Spec 24: outcome shipped, architecture not. Park P1/P3/P4 unless skill+SVC revives.
- Spec 26: routes ~85% / MCP wrappers ~42% / **sync-DB-write 0%** (foundation gap, not per-tool).
- Spec 27: routes for §9/§10/§11 ✅, **MCP wrappers 0%** for them, §8 mostly empty, watchdog hook missing.
- Common cause for many flags: **routes updated, MCP tool schemas left behind**. Cheap to close.
