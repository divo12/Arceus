# Spec 27 — Tool Catalog Integration for §8–§16 (continued)

**Status:** Plan · **Owner:** Platform · **Last Updated:** 2026-04-23
**Depends on:** Spec 12 (Heartbeat), Spec 13 (Governance Gateway), Spec 24 (Facilitator SVC + skills), Spec 25 (Agent Auth + Idempotency), **Spec 26 (Tool Catalog Integration for §1–§5)**
**Continuation of:** Spec 26. This spec completes the tool surface by covering every remaining non-deferred category of [`05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md).
**Coordinates with:** Spec 24-defer (Memory + Skill-Evolution SVC backends — deferred; spec 27 does NOT block on them)

---

## 0. TL;DR

Spec 26 shipped **33 MCP tools for §1–§5**. Spec 27 ships **everything
else** — 21 kept tools across §8–§11, the drops + replacements for
§13/§14/§16, and three cross-cutting surface changes (two new skills,
one new hook, one new progressive-disclosure mechanism). Three
categories remain explicitly parked.

| Category | Kept | Dropped | Net | Mechanism |
|---|---|---|---|---|
| §8 Workspace | **11** | 11 | — | OpenCode built-ins (`read`/`write`/`edit`/`grep`/`glob`/`bash`) replace the 11 drops |
| §9 Company / agent context | **4** | 4 | — | Redundant reads merged into `execution_get`; boot-only fns moved to §19 internal |
| §10 Board / comms | **2** | 2 | — | `board_read_inbox` folded into `board_list_messages({sinceSprint})`; `board_post_message` PM row dropped |
| §11 Execution control | **4** | 1 | — | `execution_approve_sprint` retired in favor of `sprint_finalize` (§3, spec 26) |
| §13 Trust / audit | **0** | 6 | — | All LLM-facing reads dropped (policy-exfil); writes stay in hooks; reads via admin dashboard (out of scope) |
| §14 Planning | **0** | 5 | — | Replaced by 2 new skills + 2 anti-pattern function deletions. No Planner SVC built. |
| §15 Reports / briefs | **0** | 3 | — | Collapsed into `artifact_create` + per-role brief-template skills (already in §17) |
| §16 Misc / identity | **0** | 5 | — | Plugin-boot plumbing, middleware, hook concerns — never were LLM tools |
| **Total** | **21** | **37** | — | — |

Plus five cross-cutting changes, each an atomic commit behind its own
feature flag:

1. **Progressive-disclosure skill catalog** — `buildBeatContext` injects `{id, trigger, one_liner}` for every skill the role has; agent picks by calling the `skill` built-in with the chosen ID. Retires the `classifyTaskSkills` pre-call.
2. **Two new skills materialized** — `plan-task-graph` (cto, pm), `plan-health-review` (cto) from `.arceus/skills-seed/`.
3. **New plugin hook** — `beat_watchdog_reset` (PostToolUse on every tool call). Replaces dropped `beat_heartbeat` MCP tool.
4. **Two anti-pattern deletions** — `generateWorkflowTaskPlan`, `classifyTaskSkills` removed outright.
5. **Three internal-op homes** — `GET /api/health` (plugin boot), `cpLoadAgentContext` (identity injection, already live), `deriveIdempotencyKey` (spec 25 middleware, already live). All three replace dropped §16 tools — none new code, just formal documentation in §19.

**Shipped in 6 phases, one per category/concern**, independently
deployable behind `ARCEUS_TOOL_V2_*` feature flags. Phase order and
dependencies in §5.

### Post-spec-27 arc

| Stage | Tools | Skills | Hooks | SVCs |
|---|---|---|---|---|
| Pre-walk baseline | 118 | 19 | 7 | 6 |
| Post spec 26 | 118 | 19 | 7 | 6 |
| **Post spec 27** | **81** | **21** | **8** | **4** |

Net: **−37 tools (~11,100 tokens/beat across role catalogs), +2 skills,
+1 hook, −2 SVCs**, plus 2 standalone `structuredCompletion` calls
deleted.

---

## 1. Context — what's already in place

Per the audit during the §8–§16 walk:

### 1.1 Live and working
- Spec 26 MCP tools (§1–§5, 33 tools).
- OpenCode built-ins (`read`, `write`, `edit`, `grep`, `glob`, `bash`, `webfetch`, `skill`, `task`) enabled on every agent via `.opencode/agent/<role>.md`.
- Heartbeat runtime + beat context + session-context map.
- `recordSkillUsage` hook (`tool.execute.after` on `skill` tool) — already fueling EMA.
- Facilitator chair/contributor SVC split (spec 24).
- Hippocampus writer path + `memory_handoff` governed tool.

### 1.2 Live with known issues (this spec closes)

| Issue | File | Fix |
|---|---|---|
| `classifyTaskSkills` runs a standalone `structuredCompletion` before every beat (anti-pattern #9) | `apps/api/src/skills/classifier.ts:34` | **Delete.** Replaced by progressive-disclosure catalog. |
| `generateWorkflowTaskPlan` is a standalone `structuredCompletion` that bypasses CTO session | `apps/api/src/tasks/planner.ts:91` | **Delete.** CTO runs `plan-task-graph` skill in-beat. |
| Some workspace MCP tools (`workspace_read_file` etc.) duplicate OpenCode built-ins | `packages/arceus-mcp/src/tools/workspace/*` | Drop 11 MCP registrations; enforce via `permission.bash`. |
| No watchdog reset on tool activity — stall detector false-fires | `.opencode/plugin/arceus.ts` | New PostToolUse hook. |

### 1.3 Not live (this spec builds)

- 11 custom workspace tools (some live, some only scaffolded; see §2.1)
- 4 company/agent context tools (2 merged from existing pair; see §2.2)
- 2 board/comms tools (1 existing unchanged; 1 existing gets PM row removed; see §2.3)
- 4 execution-control tools (new; see §2.4)
- `beat_watchdog_reset` hook (new)
- Progressive-disclosure catalog injection logic (new code in `buildBeatContext`)
- 2 new skills materialized into every company's `.opencode/skills/`

### 1.4 What's deferred (out of scope)

Three categories remain explicitly parked — **spec 27 does not touch them**:

| § | Status | Resume trigger |
|---|---|---|
| §6 Memory tools | Parked | User raises when Memory SVC design solidifies |
| §7 Skills admin tools | Parked | Depends on Skill-Evolution SVC backend (24-defer §SE) |
| §12 Governance reads | Stalled | Only if a concrete runtime SL scenario surfaces (memory note: `stall_05_section_12_governance_reads.md`) |

---

## 2. Per-category specification

### §8 — Workspace (11 kept MCP + role-custom tools)

**Live today:** `workspace_checkpoint`, `workspace_probe_preview`,
`workspace_get_preview_url`. The other 8 are scaffolded or planned.

**Kept list:**

| # | Tool | Roles | Surface | New/Live | What it does |
|---|---|---|---|---|---|
| 1 | `workspace_checkpoint` | dev, sl | MCP | Live | Git commit + Supabase bundle upload + task-state link, atomic |
| 2 | `workspace_probe_preview` | dev, qa | MCP | Live | HTTP probe of live preview URL with bounded timeout (renamed from `workspace_preview_probe`) |
| 3 | `workspace_get_preview_url` | dev, qa | MCP | Live | Reads task→preview-URL DB mapping |
| 4 | `workspace_get_build_health` | dev, qa, cto | MCP | New | Returns cached `{lastBuildOk, lastTypecheckOk, lastTestOk, since, errorsFirstN}` |
| 5 | `workspace_check_exports` | dev, qa | MCP | New | AST-level verification that a module exports the expected public API |
| 6 | `workspace_verify_baseline` | dev, qa, cto | MCP | New | Composite beat-start check: typecheck + basic tests + preview probe |
| 7 | `workspace_run_typecheck` | dev | Role-custom (`.opencode/tool/developer/run_typecheck.ts`) | New | Incremental typecheck with in-process cache; fires 5–20×/beat |
| 8 | `workspace_capture_browser_probe` | qa | Role-custom (`.opencode/tool/qa/capture_browser_probe.ts`) | New | Playwright: navigate + screenshot + console + network + DOM snapshot |
| 9 | `workspace_collect_evidence` | qa | Role-custom | New | Bundles captures into a QA evidence artifact |
| 10 | `workspace_run_acceptance_suite` | qa | Role-custom | New | Runs the task's configured acceptance tests with task-aware assertions |
| 11 | `workspace_diff_against_criteria` | qa | Role-custom | New | Single-shot LLM diff: observed behavior vs task acceptance criteria. Returns `{matches, gaps, unexpected}` |

**Dropped (11) — use OpenCode built-ins:**

| Was | Use instead |
|---|---|
| `workspace_read_file` | `read({filePath})` (built-in) |
| `workspace_write_file` | `write({filePath, content})` (built-in) |
| `workspace_edit_file` | `edit({filePath, oldString, newString})` (built-in) |
| `workspace_grep` | `grep({pattern, path?, include?})` (built-in) |
| `workspace_list_files` | `glob({pattern})` (built-in) |
| `workspace_diff` | `bash("git diff")` or `bash("git diff HEAD~1")` |
| `workspace_run_command` | `bash({command})` with per-role `permission.bash` allowlist |
| `workspace_get_head` | `bash("git rev-parse HEAD")` |
| `workspace_init_git` | `bash("git init")` (one-time provisioning) |
| `workspace_commit` | Merged into `workspace_checkpoint` (all canonical commits go through checkpoint) |
| `workspace_create_tag` | `bash("git tag sprint-N")` (CEO calls once per sprint at finalize) |
| `workspace_install_package` | `bash("bun add <pkg>")` with `permission.bash: ask` for `bun add*` |

**Per-role `permission.bash` allowlist:**

Replaces the custom `workspace_run_command` governance. Each agent's
`.opencode/agent/<role>.md` declares which bash patterns are allowed.
Default `"*": "deny"` for every role. See §2.1.1 of the implementable
edition for the per-role pattern table.

**Retired contracts:**

- `workspace_preview_probe` (old name) — rename to `workspace_probe_preview` across docs + configs. The live MCP registration already uses `probe_preview`; this spec makes the rename canonical.

### §9 — Company / agent context (4 tools)

| Tool | Roles | Live/New | What it does |
|---|---|---|---|
| `company_get_summary` | ceo, cto, pm | New | Pure DB read: `{name, goal, strategy, status, activeSprint, budgetCents, spentCents}` |
| `agent_list_sessions` | ceo, pm | New | Oversight read: `{role, beatId, currentTaskId?, startedAt, elapsedMs}[]` across active beats |
| `execution_get` | ceo, cto, pm | Modified (merged) | `{executionCycleId, phase, status, startedAt, pausedAt?, reason?}`. **Merges former `execution_get_active` + `execution_get_status`.** |
| `company_update_status` | ceo | New | Writes `company.status` (free-form string ≤ 500 chars). Audit-logged. |

**Dropped (4):**

- `agent_get_context` — every beat's context arrives via the user prompt at `session.prompt` start. Re-fetching mid-beat is a no-op. SVCs that need a role's memory slice use the internal `memory_format_for_prompt` inside their own session.
- `company_bootstrap` — boot-only; fires once at company creation. Moved to §19 internal.
- `company_set_active_sprint` — redundant with sprint lifecycle. `sprint_create` activates atomically; manual re-activation of a completed sprint is destructive → approval flow, not a casual tool call.
- `execution_get_status` — merged into `execution_get`.

### §10 — Board / comms (2 tools)

> **Two auto-flows stay live and need no tool:**
> - **Inbound** (board → CEO): `streamBoardMessageToCeo` → `snapshot.chatMessages` → next CEO beat surfaces it via `buildBeatContext.recentBoardMessages`.
> - **Outbound conversational** (CEO → board): CEO's session stream IS the response, rendered live + auto-packaged via `recordCeoCardMeeting`.
>
> Tools are for **proactive structured emissions** (typed cards) and **history pagination** — what the auto-flows don't cover.

| Tool | Roles | Live/New | What it does |
|---|---|---|---|
| `board_post_message` | ceo | Modified | Proactive outbound. Body: `{content, cardType?, cardData?}` for typed cards from `chatMessageCardTypeSchema` (strategy_proposal, status_update, sprint_proposal, etc). PM allowlist row removed. |
| `board_list_messages` | ceo | New | Paginated read beyond the recent-5 window `buildBeatContext` injects. Args: `{since?, sinceSprint?, role?, cardType?, limit?}`. `sinceSprint` filter **replaces** the standalone `board_read_inbox` tool. |

**Dropped (2):**

- `board_read_inbox` — merged into `board_list_messages` via `sinceSprint` filter.
- PM row on `board_post_message` — PM reports to CEO internally; board-facing messages route through CEO only. If PM needs board visibility, they escalate via `memory_handoff({targets:["ceo"]})` or `approval_request`.

**Explicitly not added:**

- `board_mark_read` / `board_acknowledge` — reading is implicit (CEO sees the message in beat context).
- `board_post_status` / `board_post_strategy_proposal` (per-cardType split) — would explode the surface quadratically. One tool + `cardType` enum is simpler.

### §11 — Execution control (4 tools)

> **Execution cycle** = the outer loop spanning one or more sprints with optional board-review intermissions. Status enum: `executing | awaiting_board_review | paused | done | error`. No separate `execution_start` — `sprint_create` atomically flips status to `executing` (commit `80de168`).

| Tool | Roles | Live/New | What it does |
|---|---|---|---|
| `execution_complete_cycle` | ceo | New | Finalize cycle: status → `done`, record completion meeting, close active beats. Distinct from `sprint_finalize` — closing a sprint is one event; closing a cycle may span multiple sprints. |
| `execution_pause_for_review` | ceo, cto | New | Pause pending human board review. Status → `awaiting_board_review`; blocks new beat dispatch. Args: `{reason, expectedResumeCondition}`. |
| `execution_reconcile_post_review` | ceo | New | Resume after board input. Args: `{nextAction: "resume"\|"restart_sprint"\|"complete_cycle"\|"stop", reason}`. Enum forces concrete follow-on. |
| `execution_stop` | ceo | New | Emergency abort. Status → `error` or `stopped`. Graceful cleanup of in-flight beats; requires explicit re-enable. |

**Dropped (1):**

- `execution_approve_sprint` — redundant with `sprint_finalize` (§3 / spec 26). Both closed a sprint with the same side effects. `sprint_finalize` wins.

### §13 — Trust / audit (0 tools — all dropped)

Every row in §13 was an LLM-facing read of trust-score or audit-ledger
state. **All are policy-exfil surfaces** — they let the agent map
coverage of what it's allowed to do, probe its own standing, or
surveille peers. Legitimate work belongs in two places:

1. **Writes via hooks** — `tool.execute.after` → `auditAgent` + `adjustTrust`. Already planned in §18.2 (spec 26 adjacency).
2. **Reads via admin dashboard** — `GET /api/admin/audit`, `GET /api/admin/trust`. Consumed by humans outside the agent loop. Not part of this spec; tracked as `doc: admin-audit-dashboard` follow-on.

**Dropped (6):** `trust_get_agent_score`, `trust_list_scores`,
`audit_self_recent`, `audit_query_recent`, `audit_attest`,
`audit_request_review`.

**Replacement surface:** None at the LLM level. Hooks for writers, admin
dashboard for reads.

### §14 — Planning / reasoning (0 tools — all dropped + 2 new skills)

**Dropped (5):** `planner_build_task_graph`, `planner_decompose_task`,
`planner_pick_skills_for_task`, `plan_health_check`,
`plan_regenerate_task`.

**Not built:** `planner` SVC, `plan-health` SVC. The SVC pattern earns
its keep only when (a) reasoning is heavy enough to warrant evicting
from the caller's context, (b) permissions differ from the caller's,
(c) multiple EMPs share with cached learning. Planning fires ~1× per
sprint (CTO) + handful of times (PM); reasoning is 3–5 rounds;
caller already has context + permissions + no cross-EMP sharing. An SVC
here is strict overhead.

**New skills (2, materialized this spec):**

| Skill | Roles | Replaces |
|---|---|---|
| `plan-task-graph` | cto, pm | `planner_build_task_graph` + `planner_decompose_task` tools, and `generateWorkflowTaskPlan` standalone call |
| `plan-health-review` | cto | `plan_health_check` + `plan_regenerate_task` tools |

Source in `.arceus/skills-seed/`; materialized into every company's
`apps/api/workspace/.opencode/skills/<id>/SKILL.md` at seed time.

**Standalone LLM calls deleted (2):**

| Function | File | Replacement |
|---|---|---|
| `generateWorkflowTaskPlan` | `apps/api/src/tasks/planner.ts:91` | CTO runs `plan-task-graph` skill in-beat + `task_create`×N |
| `classifyTaskSkills` | `apps/api/src/skills/classifier.ts:34` | Progressive-disclosure catalog in `buildBeatContext` (see §3.1) |

### §15 — Reports / briefs (0 tools — consolidated)

Three "brief builder" tools previously listed were specializations of
`artifact_create` with baked-in templates. **Collapsed into
`artifact_create` (§2, spec 26) + per-role brief-template skills in
§17:**

| Was | Now |
|---|---|
| `pm_build_release_brief` | `pm-release-readiness-review` skill teaches the template; PM calls `artifact_create({kind: "output", ...})` |
| `marketing_distribution_brief` | `marketing-distribution-brief` skill teaches the template; marketing calls `artifact_create({kind: "plan", ...})` |
| `ceo_draft_sprint_rationale` | `ceo-sprint-proposal-prep` skill teaches the workflow; CEO calls `sprint_create` directly with rationale text |

Rationale: prompts/templates belong in the prompt registry, not baked
into tool handlers. One generic `artifact_create` + N skills scales
linearly; tool-per-brief explodes quadratically.

### §16 — Misc / identity (0 tools — all dropped + 1 new hook + 3 internal homes)

**Dropped (5):** `ping`, `who_am_i`, `beat_heartbeat`,
`envelope_idempotency_hash`, `self_append_instruction`.

Why each failed the earns-its-keep test:

| Was | Why dropped | Replacement |
|---|---|---|
| `ping` | Plugin lifecycle, not LLM invocation | `GET /api/health` consumed by `.opencode/plugin/arceus.ts` at load |
| `who_am_i` | Identity already injected via `buildBeatContext` | `cpLoadAgentContext` (already live) populates system prompt |
| `beat_heartbeat` | Runtime concern — "stay alive" isn't an LLM decision | New PostToolUse hook `beat_watchdog_reset` |
| `envelope_idempotency_hash` | Spec 25 middleware already derives it server-side | `deriveIdempotencyKey(beatId, toolName, body)` in middleware; key transparent to agent |
| `self_append_instruction` | Dangerous — bypasses existing learning gates (memory / Skill-Evolution / skills_lead edits) | **No replacement.** Existing paths are enough. |

**New plugin hook (1):** `beat_watchdog_reset` — `tool.execute.after`
on every tool call → `resetBeatWatchdog(beatId)`. Zero LLM visibility.
Added to §18.2 planned hooks.

**Internal-op documentations (3):** all three already exist in code;
this spec formally documents them in §19 as the homes for the dropped
LLM surfaces. No new code.

---

## 3. Cross-cutting concerns

### 3.1 Progressive-disclosure skill catalog

**Problem.** `classifyTaskSkills` fires a cold LLM call before every
beat to pick 0–3 skills for this task+role. Anti-pattern #9 (standalone
`structuredCompletion` masquerading as an agent). Two consequences: (a)
the picker's taste is decoupled from the agent's own reasoning; (b) it's
one more LLM round-trip on every beat dispatch.

**Design.** `buildBeatContext` assembles a **compact catalog** of every
skill this role has and injects it into the agent's system prompt. The
agent picks by calling the `skill` built-in with the chosen ID when a
trigger matches its work.

```typescript
interface SkillCatalogEntry {
  id: string;          // e.g. "plan-task-graph"
  trigger: string;     // from SKILL.md frontmatter, one line
  one_liner: string;   // from SKILL.md description, one line
}
```

Rendered as:

```
## Available skills — call `skill({id})` when a trigger matches

- plan-task-graph (cto, pm): Draft a task DAG or decompose a large task in-beat
  trigger: sprint kickoff with approved rationale, or a mid-sprint task too big for one beat
- plan-health-review (cto): Staleness check + in-beat regeneration
  trigger: start of a CTO beat when sprint ≥ 30% complete, or a finding invalidates downstream work
- ...
```

**What this retires:** `classifyTaskSkills` function deleted.
Pre-beat classifier LLM call removed from `run-beat.ts`.

**What stays:** `skill` built-in (OpenCode native). The existing
`recordSkillUsage` PostToolUse hook reads the chosen ID from the tool
call log and fuels EMA — unchanged.

**Skill evolution compatibility.** When Skill-Evolution SVC eventually
promotes a new skill (future — 24-defer §SE), the catalog rebuilds on
the next beat automatically. No registry reload needed. Materialize a
new `.opencode/skills/<id>/SKILL.md` + add the row to each eligible
role's allowlist → next `buildBeatContext` call picks it up.

**Budget.** Max 40 skill entries per role injected (currently 21 total
skills across the system, huge headroom). If cap hit, truncate by EMA
descending.

### 3.2 `beat_watchdog_reset` hook

New planned hook in `.opencode/plugin/arceus.ts`:

```typescript
hooks["tool.execute.after"].push(async (ctx) => {
  if (ctx.beatId) {
    await resetBeatWatchdog(ctx.beatId);
  }
});
```

Fires on every tool call — treat any activity as "agent alive." Replaces
the dropped `beat_heartbeat` MCP tool. Zero LLM surface; timer is a Map
write, idempotent.

### 3.3 Two new skills materialized

Both are **already written** in `.arceus/skills-seed/` (seed-time source
of truth). This spec ships the **materialization wiring**:

- On new-company seed → copy from seed to `apps/api/workspace/.opencode/skills/<id>/SKILL.md`
- On existing-company backfill → one-time script (see §5 Phase 5 Step 3)
- Add each to the role's progressive catalog via `buildBeatContext`

### 3.4 Two anti-pattern deletions

Both live in the codebase today. Deletions happen in Phase 5 cutover
after the progressive catalog + skills land and have a 1-week shadow
period:

1. `apps/api/src/tasks/planner.ts` — `generateWorkflowTaskPlan` + all call sites (grep first)
2. `apps/api/src/skills/classifier.ts` — `classifyTaskSkills` + all call sites
3. Related prompt-template files in `prompts/templates/` if any (inventory in Phase 5)

### 3.5 Reuse from spec 26

Spec 27 tools inherit from spec 26 without restating:

- **Envelope** (`ToolResult<T>` with `{status, summary, data, error}`)
- **Error cause enum** (`packages/contracts/src/envelope.ts`)
- **Idempotency key derivation** (`deriveIdempotencyKey(beatId, toolName, body)`)
- **HTTP conventions** (POST for mutations, GET for reads, 410 Gone on retirements)
- **Sync DB write pattern** (where applicable — see `execution_*` tools in §2.4)
- **Allowlist config propagation** via per-role `.opencode/agent/<role>.md` files

---

## 4. File manifest

### New files

| Path | Purpose |
|---|---|
| `apps/api/src/routes/internal-mcp/workspace.routes.ts` | Extends existing file; adds the 8 new §8 tool routes (keep 3 live) |
| `apps/api/src/routes/internal-mcp/company.routes.ts` | All 4 §9 routes |
| `apps/api/src/routes/internal-mcp/board.routes.ts` | 2 §10 routes (1 new, 1 modified) |
| `apps/api/src/routes/internal-mcp/execution.routes.ts` | All 4 §11 routes |
| `apps/api/src/routes/health.routes.ts` | `GET /api/health` for plugin-boot liveness (replaces `ping` tool) |
| `apps/api/workspace/.opencode/tool/developer/run_typecheck.ts` | Role-custom dev tool |
| `apps/api/workspace/.opencode/tool/qa/capture_browser_probe.ts` | Role-custom qa tool |
| `apps/api/workspace/.opencode/tool/qa/collect_evidence.ts` | Role-custom qa tool |
| `apps/api/workspace/.opencode/tool/qa/run_acceptance_suite.ts` | Role-custom qa tool |
| `apps/api/workspace/.opencode/tool/qa/diff_against_criteria.ts` | Role-custom qa tool |
| `apps/api/workspace/.opencode/skills/plan-task-graph/SKILL.md` | Materialized from seed |
| `apps/api/workspace/.opencode/skills/plan-health-review/SKILL.md` | Materialized from seed |
| `scripts/materialize-new-skills.ts` | One-time backfill for existing companies |
| `scripts/audit-retired-tool-calls.sh` | Grep for retired §8/§13/§14/§16 names across codebase |

### Modified files

| Path | Change |
|---|---|
| `packages/arceus-mcp/src/tools/workspace/index.ts` | Remove 11 dropped registrations; keep 6 (3 live + 3 new MCP); rename `workspace_preview_probe` → `workspace_probe_preview` |
| `packages/arceus-mcp/src/tools/company/index.ts` | Register 4 §9 tools (or rename existing) |
| `packages/arceus-mcp/src/tools/board/index.ts` | Remove `board_read_inbox` registration; modify `board_post_message` allowlist |
| `packages/arceus-mcp/src/tools/execution/index.ts` | Register 4 §11 tools; remove `execution_approve_sprint`, `execution_get_status` |
| `apps/api/workspace/.opencode/agent/*.md` (all 8) | Drop 11 §8 + 6 §13 + 5 §14 + 5 §16 tool names from `allowedTools`; add `permission.bash` tables; add role-custom tool references where applicable |
| `apps/api/src/orchestration/buildBeatContext.ts` | Add progressive-disclosure skill catalog injection |
| `apps/api/src/orchestration/run-beat.ts` | Delete pre-beat `classifyTaskSkills` call |
| `.opencode/plugin/arceus.ts` | Register `beat_watchdog_reset` PostToolUse hook |
| `apps/api/src/tasks/planner.ts` | Delete `generateWorkflowTaskPlan` (P5) |
| `apps/api/src/skills/classifier.ts` | Delete `classifyTaskSkills` (P5); may delete whole file if it becomes empty |

### Deleted files

After Phase 6 cutover and 2-week 410 deprecation window:

- `packages/arceus-mcp/src/tools/workspace/read-file.ts` (and 10 siblings for dropped §8 tools)
- `packages/arceus-mcp/src/tools/trust/*.ts` (6 files for §13)
- `packages/arceus-mcp/src/tools/planner/*.ts` (5 files for §14, if they existed as scaffolding)
- `packages/arceus-mcp/src/tools/misc/*.ts` (5 files for §16)

---

## 5. Phase plan

All six phases land behind feature flags. Default off until stable in
prod.

| Phase | Name | Flag | Depends on | Duration |
|---|---|---|---|---|
| P1 | §8 Workspace tools + `permission.bash` | `ARCEUS_TOOL_V2_WORKSPACE` | — | ~4 days |
| P2 | §9 Company/agent context + §10 Board + §11 Execution | `ARCEUS_TOOL_V2_CTX` | — | ~3 days |
| P3 | Progressive-disclosure skill catalog | `ARCEUS_TOOL_V2_SKILL_CATALOG` | — (parallel to P1/P2) | ~2 days |
| P4 | §13 Trust/audit drop + `beat_watchdog_reset` hook | `ARCEUS_TOOL_V2_DROPS` | — | ~1 day |
| P5 | §14 Planning drop + 2 skills materialized + 2 anti-pattern deletions | `ARCEUS_TOOL_V2_PLANNING` | P3 (catalog must be picking up new skills) | ~2 days |
| P6 | §16 Misc drop + internal-op docs + cutover | `ARCEUS_TOOL_V2_MISC` | P1–P5 | ~1 day |

**Cutover (2-week deprecation window per retired endpoint):** old tool
endpoints return `HTTP 410 Gone` with `{cause: "tool_retired",
details: {replacement}}`. After 2 weeks of < 10 calls/day, endpoint
deleted.

---

## 6. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agents reach for dropped workspace MCP tools after P1 | Medium | Low (410 with clear pointer) | `tool-error-recovery` skill teaches 410 handling; workspace-specific examples added |
| Progressive catalog bloats system prompt past budget | Low | Medium | 40-skill cap per role; truncate by EMA if hit; monitor `systemPromptTokens` per beat |
| CTO doesn't invoke `plan-task-graph` at sprint kickoff | Medium | High | Sprint-kickoff beat context adds explicit "if you are CTO, use `plan-task-graph`" nudge; measure invocation rate |
| `plan-health-review` runs every beat, spams no-op | Low | Low | Skill has hard `< 30% sprint progress → skip` guardrail; enforced via `buildBeatContext` precondition |
| Deleting `classifyTaskSkills` breaks mid-sprint agents | Low | Medium | Shadow mode: run both paths in parallel for 1 week, compare skill picks, then flip |
| `beat_watchdog_reset` hook fires on `skill` built-in (load, not work) | Low | Low | Design decision: any tool activity = alive; revisit if false-alive rate ≥ 5% |
| `execution_stop` leaves half-written state | Medium | High | Transactional cleanup: SELECT FOR UPDATE active beats, mark `stopped`, commit atomically |
| Admin audit/trust dashboard doesn't ship by cutover | Medium | Low | Ops queries `audit_events` via Supabase studio in interim |

### Rollback

Each phase flag-toggles off cleanly. The two non-flaggable changes:

- **Skill materialization** — revertible by script (`scripts/remove-materialized-skills.ts <slug>`).
- **Hook registration** — revertible by reverting the one commit in `.opencode/plugin/arceus.ts`.

No state migration required for any rollback.

---

## 7. Success criteria

| Metric | Target | Measurement |
|---|---|---|
| Token savings per beat system prompt | −3,500 tokens (§8 workspace + §16 drops) | Log `systemPromptTokens` at dispatch; compare 7-day window pre/post P1+P6 |
| `plan-task-graph` invocation at sprint kickoff | ≥ 80% of CTO kickoff beats | `skill_usage` rows filtered by `skillId=plan-task-graph` AND beat kind |
| `plan-health-review` invocation per sprint ≥ 30% | ≥ 60% of CTO beats | Same query scheme |
| `generateWorkflowTaskPlan` call count | 0 in prod after P5 | Grep build + runtime logs for 2 weeks post-delete |
| `classifyTaskSkills` call count | 0 in prod after P5 | Same |
| 410 traffic on retired endpoints | < 10 calls/day after 2-week window | HTTP access logs |
| DAG validation pass rate (first emission) | ≥ 90% | Add `validation_result` to `task_create` telemetry |
| Dropped trust/audit tool calls | 0 in 30 days post-P4 | Governance hook block-list alert |
| P1 regression: workspace ops latency | within 10% of pre-drop | Beat timing telemetry |

---

## 8. Out of scope

- **§6 Memory tools** — parked; revisit with Memory SVC design.
- **§7 Skills admin tools** — parked; depends on Skill-Evolution SVC backend (24-defer §SE).
- **§12 Governance reads** — stalled; revisit only if a concrete runtime SL scenario surfaces.
- **Admin trust/audit dashboard** — follow-on. Tracked as `doc: admin-audit-dashboard`. Not blocking.
- **`permission.bash` allowlist design** — already established per spec 25; P1 only extends allowlists, doesn't redesign.
- **OpenCode skill registry JSON shape** — maintained by existing plugin hook; this spec doesn't modify shape, just content.
- **Role-custom tool bundle infrastructure** — QA/dev bundles already exist in `.opencode/tool/*`; P1 adds new files, not new infra.

---

## 9. Open questions

1. **Progressive-disclosure format.** Two lines per skill (description + trigger) uses ~15 tokens × 21 skills = ~315 tokens per role. One combined line would halve that. Decision: ship two-line; measure; collapse if total role catalog > 800 tokens.
2. **Does `plan-task-graph` need per-company heuristic overrides?** Sprint-node caps may differ per company. Defer — let Skill-Evolution SVC learn overrides rather than bake them in.
3. **Should `beat_watchdog_reset` fire on `skill` built-in calls?** Skill calls load content, don't do "work." Current design: yes (any tool activity = alive). Validate empirically post-P4.
4. **`approval_get` with no filter — list all or error?** Potential scope leak. Default: `missing_filter` error; revisit if UX suffers.
5. **`execution_stop` cleanup semantics.** Does it mark in-flight tasks `blocked` or leave them in `in_progress`? Propose: `blocked` with `reason: "execution_stopped_by_ceo"` to signal resumability.

---

## 10. Coordination table

| Concern | Owner | Lands in |
|---|---|---|
| Spec 26 MCP (§1–§5) | Platform | Spec 26 |
| **Spec 27 MCP (§8–§11)** | **Platform** | **This spec** |
| Facilitator SVC (chair + contributor) | Platform | Spec 24 |
| Memory SVC backend | Deferred | 24-defer §M |
| Skill-Evolution SVC backend | Deferred | 24-defer §SE |
| Progressive-disclosure catalog | Platform | **This spec (P3)** |
| `beat_watchdog_reset` hook | Platform | **This spec (P4)** |
| Admin audit/trust dashboard | UI/Ops | Follow-on (`doc: admin-audit-dashboard`) |
| `permission.bash` per-role allowlist | Platform | **This spec (P1)** |
| Two skills materialized | Platform | **This spec (P5)** |

---

## 11. References

- [`05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md) — source of truth for final tool surface
- [`06-subagent-flows.md`](../agent-redesign/06-subagent-flows.md) — SVC definitions (planner / plan-health explicitly not built)
- [`26-tool-catalog-integration.md`](./26-tool-catalog-integration.md) — §1–§5 MCP (precedes this)
- [`26-implement.md`](./26-implement.md) — spec 26 implementable edition
- [`27-implement.md`](./27-implement.md) — **this spec's implementable edition** (per-tool Zod schemas, routes, tests, commit sequence)
- [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md) — Facilitator SVC + skill+SVC pattern
- [`24-defer.md`](./24-defer.md) — parked Memory + Skill-Evolution SVCs
- [`25-agent-auth-idempotency.md`](./25-agent-auth-idempotency.md) — envelope / idempotency middleware this spec reuses
- `stall_05_section_12_governance_reads.md` (memory note) — why §12 is stalled
