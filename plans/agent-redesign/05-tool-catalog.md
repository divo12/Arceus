# Tool Catalog — Flat View

> Companion to [`04-ops-by-surface.md`](./04-ops-by-surface.md). This doc is
> deliberately flat: every tool we intend to build or keep, listed with the
> employees that will call it. **No surface labels** (MCP / custom / SVC /
> hook) — that decision lives in `04`.
>
> Use this when you're asking "who calls what?" Use `04` when you're asking
> "where does it live?"
>
> **Verdict column:** fill with `PASS` if the row is fine as-is. Leave any
> other value (e.g. `REVIEW`, a comment, `DROP`) to flag for discussion.

## Role short codes

| Code | Role |
|---|---|
| `ceo` | CEO |
| `cto` | CTO |
| `pm` | Product Manager |
| `dev` | Developer |
| `qa` | Tester |
| `ui` | UI Designer |
| `mkt` | Marketing |
| `sl` | Skills Lead |
| `hb` | Heartbeat (not an employee — system-invoked) |
| `all` | All 8 employee roles |

Totals: **~112 tools** across 16 categories (§15 "Reports / briefs" is now
empty — its 3 tools folded into skills; §5 Meetings dropped 3 tools to
skill+SVC pattern), plus **19 skills** (§17 — two meeting playbooks
added), **7 plugin hooks** (§18), **6 service subagents** (§21 —
Facilitator split into chair/contributor), **~105 internal ops** that
never become tools (§19), and a **deletion list** (§20) for what gets
removed once this system ships.

## Column reference

Each tool table has these columns:

- **Tool** — the callable name (MCP or custom)
- **Roles** — which employees have it in their allowlist
- **What it does** — one-liner
- **Subagent** — which service subagent (if any) backs this tool. See §21
  and `06-subagent-flows.md`. `—` means the tool is deterministic (no SVC
  session). A name like `memory` / `facilitator` / `skill-evolution` /
  `planner` / `plan-health` means the tool wraps an invocation of that SVC.
- **Verdict** — fill with `PASS` if the row is fine; anything else flags
  it.

---

## 1. Task lifecycle (15)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `task_claim` | dev, qa, ui, mkt, sl | Employee grabs an unclaimed task off the backlog for this beat. Returns `{status:"error", error:{cause:"deps_unmet", missing:[taskIds]}}` if dependencies aren't satisfied — caller doesn't need a separate readiness check. | — | PASS |
| `task_complete` | dev, qa, ui, mkt, sl | Marks a claimed task done + attaches evidence artifact IDs | — | PASS |
| `task_verify` | qa | Tester signs off on a completed task against acceptance criteria | — | PASS |
| `task_block` | dev, qa, ui, mkt, sl | Flags a task as blocked with reason + suggested unblock path | — | PASS |
| `task_create` | ceo, cto, pm | Adds a new task to the backlog with role, kind, acceptance. Accepts `referenceArtifactIds?: string[]` to attach existing artifacts at creation (e.g. CTO spawns 3 implementation tasks that reference one plan artifact). | — | PASS |
| `task_update` | ceo, cto, pm | Changes a task's title, description, priority, or assigned role mid-sprint. Accepts `referenceArtifactIds?: string[]` with replacement semantics for rewiring attachments. | — | PASS |
| `task_hydrate_from_spec` | ceo, cto, pm | Prefills a task's fields (title, description, acceptance) from a referenced spec artifact | — | PASS |
| `task_get` | all | Reads one task by ID (title, description, status, acceptance). Pass `includeProgress: true` to also return the progress log (plan steps + command log) — replaces the separate `task_get_progress` tool. | — | PASS |
| `task_get_preview_path` | dev, qa | Returns the preview URL path registered for this task | — | PASS |
| `task_list_progress` | ceo, cto, pm | Lists in-progress tasks across the sprint with % complete | — | PASS |
| `task_clear_progress` | cto, pm | Resets a task's progress ledger when restarting work | — | PASS |
| `task_append_command` | dev, qa, sl | Logs a shell command that was run as part of this task | — | PASS |
| `task_append_plan_step` | dev, qa, ceo, cto, pm | Appends a step to the visible plan narration mid-beat | — | PASS |
| `task_append_result` | dev, qa, ui, mkt, sl | Appends a result-text summary to the task record (distinct from artifacts; this is the inline outcome narration) | — | PASS |
| `task_report_bug` | dev, qa, ui, mkt | Files a bug-fix task without interrupting current work. Delivery-role convenience — leadership files via `task_create` with `kind: "bug_fix"`; skills_lead routes skill failures through the Skill-Evolution SVC, not here. | — | PASS |

> **Removed:**
>
> - `task_decompose` — was a duplicate of `planner_decompose_task` (§14).
> - `task_get_progress` — merged into `task_get` via an `includeProgress` flag. Saves 1 tool × 8 roles ≈ 720 catalog tokens. Loading the progress log is gated by the flag so the default `task_get` stays cheap.
> - `task_inspect_readiness` — folded into `task_claim`. A failed claim now returns `cause: "deps_unmet"` with the missing task IDs, which is all the caller needed. Agents that just want to inspect before trying can read `task_get` and look at `dependsOnTaskIds` there.
>
> **Added** (were in the live allowlist but missing from this doc):
>
> - `task_update` — mid-sprint edits to title/priority/role. Leadership-only.
> - `task_hydrate_from_spec` — convenience wrapper for "I just wrote a spec artifact, populate a task from it." Leadership-only.
> - `task_append_result` — delivery-side tool for the inline outcome narration (companion to `task_append_plan_step` and `task_append_command`).

## 2. Artifact management (4)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `artifact_create` | dev, qa, ui, mkt, cto | Writes a plan/code/output/specification artifact. Accepts `attachToTaskIds?: string[]` for atomic create-and-attach. **Always persisted to durable storage** — no explicit `artifact_persist` needed. Artifacts are immutable; to revise, create a new artifact with an incremented title (e.g. "Login form plan v2"). | — | PASS |
| `artifact_get` | all | Reads one artifact by ID. **Build required** — missing from live today; agents currently only see artifacts pre-injected via `buildBeatContext`. | — | PASS |
| `artifact_list_sprint` | ceo, cto, pm | Lists every artifact produced in the active sprint. **Build required** — missing from live today. | — | PASS |
| `artifact_write_to_workspace` | dev, ui_designer, marketing | Materializes an artifact's content into the product workspace as a real file (e.g. `docs/design/home-page.md`). Keeps the artifact→file linkage. **Live today; was missing from 05.** | — | PASS |

> **Removed:**
>
> - `artifact_attach_to_task` — never built live; folded into `artifact_create({attachToTaskIds})` for the create-and-attach case, and `task_create` / `task_update` `referenceArtifactIds` for post-hoc cross-linking.
> - `artifact_persist` (was live but undocumented in 05) — removed. **Artifacts now always-persist on create.** Storage cost is trivial (~24MB/sprint); removing the tiered model eliminates "did you forget to persist?" bugs and simplifies the agent mental model. If retention becomes a cost problem, a background sweep job handles it — not an agent decision.
> - `task_attach_artifact` (live in task namespace, was not in 05) — removed as part of the same consolidation. Use `task_create({referenceArtifactIds})` / `task_update({referenceArtifactIds})` instead (see §1).

## 3. Sprint lifecycle (6)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `sprint_create` | ceo | Atomic create-and-activate: inserts sprint record, creates all tasks with dependency wiring, promotes zero-dep tasks to `planned`, flips sprint status to `executing`. Called by the CEO agent from its primary beat with `{goal, tasks[]}`. **Supersedes the old `sprint_propose` + `sprint_begin_execution` pair** — both were merged into this single atomic call (commit `80de168`). | — | PASS |
| `sprint_get_active` | dev, qa, ui, mkt | Returns `{id, number, goal, status, startedAt, taskCount, completedTaskCount}` for the currently executing sprint. Delivery-role lookup — leadership reads the same data via `company_get_summary` (§9). | — | PASS |
| `sprint_check_completion` | ceo, cto, pm, qa | Returns sprint tally: `{total, completed, verified, blocked, failed, remainingRequired:[taskIds], readyToFinalize:boolean}`. Read-only — agents read this, reason, and decide next action. | — | PASS |
| `sprint_run_qa_gate` | qa | Runs the full sprint-level acceptance pass: every task's acceptance suite across the sprint, returns `{passed, failed, failingTasks, logs}`. Deterministic execution; **QA agent reads results and decides** — gate does not auto-demote task statuses. | — | PASS |
| `sprint_run_final_gate` | cto | Runs full workspace build + integration + export-manifest + preview-stability checks. Returns `{buildOk, integrationOk, exportManifestValid, previewStable, errors}`. **CTO agent reasons about results** — does not auto-block. | — | PASS |
| `sprint_finalize` | ceo | Closes sprint: tags workspace (`sprint-N`), archives sprint record, schedules the next. Final CEO decision after QA + final gates have been reviewed. | — | PASS |

> **Removed:**
>
> - `sprint_propose` — absorbed into `sprint_create` (live since commit `80de168`; CEO reasons in its primary beat, emits one atomic tool call).
> - `sprint_begin_execution` — absorbed into `sprint_create` (same commit; activation happens in the same transaction as creation).
>
> **Added** (was live but missing from 05):
>
> - `sprint_create` — the actual live tool. Documented above.
>
> **Philosophy note:** gates stay as agent tools, not orchestrator internals. The mechanical test execution runs deterministically inside the tool, but the **decision** of whether results are acceptable is the agent's reasoning — consistent with the heartbeat model (orchestrator wakes agent, agent reasons, gets out of the way). Auto-gate-running by the heartbeat would regress to the old orchestrator-driven pattern we're killing in spec 24.

## 4. Approval flow (4)

Approvals are **hierarchical**. Type implicitly encodes the approver (board or CEO); the requester doesn't specify a recipient. Server enforces type→approver routing and role-based gating.

**Types + routing:**

| Type | Approver | Who requests |
|---|---|---|
| `strategy` | Board (human) | ceo |
| `hire` | Board | ceo, pm |
| `external_action` | Board | marketing, ceo |
| `architecture_change` | CEO | cto |
| `scope_change` | CEO | pm, cto |
| `meeting_blocker` | CEO | pm, cto |
| `tool_governance` | CEO | skills_lead |

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `approval_request` | ceo, cto, pm, mkt, sl | Opens an approval with one of the 7 types above. Server routes to the implicit approver (board or CEO). Body: `{type, title, description, meetingId?, agendaItemId?, evidenceArtifactIds?}`. | — | PASS |
| `approval_get` | ceo, cto, pm, mkt, sl | **Dual-purpose read.** If `approvalId` is given, returns that one approval. Otherwise accepts filter args and returns a list: `{status?, filedByMe?, pendingMyDecision?, since?, limit?}`. Replaces the need for a separate `approval_list` tool. | — | PASS |
| `approval_update` | mkt, pm, sl | Adds a clarifying comment or attaches an evidence artifact to a pending approval. Requesters only — the decider doesn't use this (they call `approval_decide`). | — | PASS |
| `approval_decide` | ceo | Approve or reject a pending approval with a reason. **Type-gated policy:** CEO can decide `architecture_change`, `scope_change`, `meeting_blocker`, `tool_governance`. Returns `403 not_authorized` if the type is board-only (`strategy`, `hire`, `external_action`) — those route outside the system to the human board. | — | PASS |

> **Removed:**
>
> - `approval_auto_approve_all` — anti-pattern. Bulk-bypass of the approval gate defeats the purpose of the gate. If an approval type doesn't need human review, code the rule into the server-side policy (auto-approve small tool_governance changes below a blast radius) — don't expose an agent tool for it.
> - `approval_list` — merged into `approval_get` via filter args. Saves a tool slot × 5 roles ≈ 450 tokens.
>
> **Also:** pending approvals for a role can be surfaced in `buildBeatContext` (orchestrator-side) so agents see what's waiting on them without needing a tool call at all — `approval_get` remains the on-demand query path.
>
> **Changes from live:**
>
> - `approval_request` allowlist expanded from {mkt, pm, sl} to {ceo, cto, pm, mkt, sl}. Live was missing the leadership tier (hierarchical approvals need CEO→board and CTO→CEO paths).
> - Type enum expanded from 5 to 7 (adds `architecture_change`, `scope_change`). Server-routing logic is new work.
> - `approval_decide` is new — closes the in-system approval loop for CEO-decidable types. Without it, every approval has to round-trip through a human, even for CEO-tier decisions.

## 5. Meeting lifecycle (4 — skill+SVC pattern)

> **Surface shift.** 4 of what were originally meeting "tools" are NOT MCP tools. Chairs and contributors invoke the Facilitator subagents directly via the OpenCode Task tool, guided by dedicated skills. Only deterministic state-mutating ops stay as MCP tools. Full subagent configs + scenario flows in [`06-subagent-flows.md §4.2`](./06-subagent-flows.md). Skills defined in §17. Token savings vs the MCP-wrapper design: **~1,170 catalog-wide**.

### 5.1 MCP tools (4)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `meeting_record` | ceo, cto, pm, sl | **Synchronous atomic write** of the meeting record: in-memory snapshot + durable DB row in one transaction. Accepts the fat schema (meta + agenda + decisions + learnings + `taskModifications` + `memoryModifications`) because a meeting is one logical event — partial persistence would leave half-recorded meetings. Retires the fire-and-forget persistence path (see §20.7). | — | PASS |
| `meeting_get` | all | Read one meeting by ID. | — | PASS |
| `meeting_request_decision` | ceo, cto, pm | Open an async decision meeting. Creates `open_meeting` record + fires `task_create({kind:"meeting_contribute"})` delegations to required participants. Returns immediately — the meeting itself is async across multiple beats (see 06 §9.2). | — | PASS |
| `meeting_contribute` | all | Participant attaches a position artifact to an open decision meeting. Deterministic link: `{meetingId, artifactId}`. | — | PASS |

### 5.2 Skill-invoked operations (4 — no MCP tool)

These four operations are **not** exposed as MCP tools. Chairs and contributors invoke the Facilitator subagents via `Task()` directly, following skill playbooks.

| Operation | Subagent (06 §4.2) | Playbook skill (§17) | Allowed roles |
|---|---|---|---|
| Run a standup / retro / demo / escalation | `facilitator-chair-service` | `meeting-chair-playbook` | ceo, cto, pm, sl |
| Generate daily brief | `facilitator-chair-service` | `meeting-chair-playbook` | ceo, pm |
| Resolve an async decision meeting | `facilitator-chair-service` | `meeting-chair-playbook` | ceo, cto, pm |
| Draft a contribution (pre-meeting prep) | `facilitator-contributor-service` | `meeting-contribution-drafter` | all 8 |

**Invocation pattern** (per 06 §4.2):

1. Load the relevant skill: `skill({name: "meeting-chair-playbook"})`
2. Construct the JSON prompt per the skill's template (includes `mode` + args)
3. `Task({agent: "facilitator-chair-service", prompt})` — subagent session runs the pipeline
4. `parseEnvelope(result.text)` — pull typed `data` out of the final message
5. Persist side effects via governed MCP tools: `meeting_record` (for run/resolve), `artifact_create` + `meeting_contribute` (for draft), or `artifact_create` (for brief)

**Propose-dispose preserved:** subagents return payloads; chairs (or contributors) apply state changes through MCP tools.

### 5.3 Removed from the prior shape

| Was | Why removed |
|---|---|
| `meeting_run` (MCP) | Replaced by skill+Task invocation of `facilitator-chair-service` |
| `meeting_generate_daily_brief` (MCP) | Same |
| `meeting_draft_contribution` (MCP) | Replaced by skill+Task invocation of `facilitator-contributor-service` |
| `meeting_resolve_decision` (MCP) | Replaced by skill+Task on chair subagent |
| `meeting_list_available_tools` (MCP) | Overengineered — per-meeting tool scoping isn't a real requirement |
| `meeting_get_specialist_context` (MCP) | Internal Facilitator helper, not a public tool |

### 5.4 Changes from live

Live today has only `meeting_record` (ceo, pm, sl). This section adds:

- 3 MCP tools: `meeting_get`, `meeting_request_decision`, `meeting_contribute`
- Broadens `meeting_record` allowlist to include `cto` (chairs architecture meetings)
- Flips `meeting_record` persistence from fire-and-forget → synchronous DB write
- 2 subagents (Facilitator chair + contributor) + 2 skills

### 5.5 Token math

| Change | Δ tokens |
|---|---|
| Drop `meeting_run` (3 roles × 90) | +270 saved |
| Drop `meeting_generate_daily_brief` (2 × 90) | +180 |
| Drop `meeting_draft_contribution` (8 × 90) | +720 |
| Drop `meeting_list_available_tools` (3 × 90) | +270 |
| Drop `meeting_get_specialist_context` (8 × 90) | +720 |
| Trim `meeting_record` `all` → 4 roles (drop 4 × 90) | +360 |
| Add `meeting_request_decision` (3 × 90) | −270 |
| Add `meeting_contribute` (8 × 90) | −720 |
| Add `meeting-chair-playbook` skill manifest (4 × 30) | −120 |
| Add `meeting-contribution-drafter` skill manifest (8 × 30) | −240 |
| **Net** | **+1,170 saved** |

## 6. Memory operations (6)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `memory_add_learning` | all | Records a learned fact / pattern into role memory | — | — |
| `memory_set_focus` | all | Updates the agent's current focus hint for future beats | — | — |
| `memory_format_for_prompt` | all | Produces the memory slice to inject into the next prompt | — | — |
| `memory_process_turn` | all | Extract facts → decide ADD/UPDATE/DELETE → store | `memory` | — |
| `memory_prime_agent` | hb | Pre-beat priming: load memory + generate disposition | `memory` | — |
| `memory_match_habits` | hb | Picks relevant habits from the vault for the current task | `memory` | — |

## 7. Skills (14)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `skill_get_definition` | all | Reads one skill's SKILL.md + resources by ID | — | — |
| `skill_search_for_task` | hb | Picks 0–3 skills from the role catalog for this task | — | — |
| `skill_health_report` | sl | Aggregated EMA / usage / failure report across all skills | — | — |
| `skill_audit_unused` | sl | Lists skills with zero usage in last N sprints | — | — |
| `skill_inspect_history` | sl | Version history + mutation trail for one skill | — | — |
| `skill_register` | sl | Registers a new skill definition (governed) | — | — |
| `skill_update` | sl | Updates an existing skill's body or metadata | — | — |
| `skill_deprecate` | sl | Marks a skill deprecated; removed from future catalogs | — | — |
| `skill_propose_mutation` | sl | Submits a proposed rewrite for review | `skill-evolution` | — |
| `skill_validate_definition` | sl | Lints a SKILL.md for schema + style before register | — | — |
| `skill_init_evolution` | sl | Kicks off the ATA (Skill-Evolution) pipeline manually | `skill-evolution` | — |
| `skill_evolve_from_failure` | sl | Runs full ATA pipeline on a failed skill | `skill-evolution` | — |
| `skill_synthesize_from_patterns` | sl | Clusters recent patterns into a candidate SKILL.md draft | `skill-evolution` | — |
| `skill_review_candidate` | sl | Scores a proposed skill against registry (approve/revise/reject) | `skill-evolution` | — |

> `skill_lint_definition` was here as a duplicate of `skill_validate_definition`. Removed — use `skill_validate_definition`.

## 8. Workspace (22)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `workspace_read_file` | dev, qa, ui | Reads one file from the product workspace | — | — |
| `workspace_write_file` | dev | Writes/overwrites a file in the product workspace | — | — |
| `workspace_diff` | dev, qa | Shows changes made in the current beat vs baseline | — | — |
| `workspace_grep` | dev, qa, cto | Ripgrep across the product source tree | — | — |
| `workspace_run_command` | dev, qa | Runs a governed shell command (allowlisted only) | — | — |
| `workspace_get_head` | dev, qa | Returns current git HEAD SHA (evidence for tests) | — | — |
| `workspace_list_files` | dev, qa, cto, ui | Lists files under a path (glob-aware) | — | — |
| `workspace_check_exports` | dev, qa | Verifies a module exports the expected public API | — | — |
| `workspace_get_preview_url` | dev, qa | Returns the live preview URL for the running app | — | — |
| `workspace_get_build_health` | dev, qa, cto | Checks if last build/typecheck passed | — | — |
| `workspace_init_git` | dev | First-time git init for a new product workspace | — | — |
| `workspace_commit` | dev | Creates a git commit with a descriptive message | — | — |
| `workspace_create_tag` | ceo | Tags the workspace at a sprint boundary (`sprint-N`) | — | — |
| `workspace_install_package` | dev | `bun add` wrapper for dev dependencies | — | — |
| `workspace_run_typecheck` | dev | Hot-loop typecheck with cached incremental results | — | — |
| `workspace_preview_probe` | dev | Hits the live preview URL + reports health | — | — |
| `workspace_commit_checkpoint` | dev | Intermediate commit mid-task (doesn't end the task) | — | — |
| `workspace_verify_baseline` | dev, qa, cto | First-step-of-beat check: does last beat's work still build? | — | — |
| `workspace_collect_evidence` | qa | Pulls screenshots + logs + test output for a QA artifact | — | — |
| `workspace_capture_browser_probe` | qa | Headless browser screenshot + console capture | — | — |
| `workspace_run_acceptance_suite` | qa | Runs the task's configured acceptance tests | — | — |
| `workspace_diff_against_criteria` | qa | LLM diff: observed behavior vs stated acceptance criteria | — | — |

## 9. Company / agent context (8)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `agent_get_context` | all | Returns the assembled beat context (identity + role + memory slice) | — | — |
| `company_get_summary` | ceo, cto, pm | High-level company state: goal, strategy, active sprint | — | — |
| `agent_list_sessions` | ceo, pm | Lists active agent sessions (who's working right now) | — | — |
| `execution_get_active` | ceo, cto, pm | Returns the active execution cycle + phase | — | — |
| `execution_get_status` | ceo, cto, pm | Current status bitmap (paused, gated, running) | — | — |
| `company_bootstrap` | ceo | First-time company setup from founding idea (boot-only) | — | — |
| `company_update_status` | ceo | Updates the company-level status field (e.g. "shipping v1") | — | — |
| `company_set_active_sprint` | ceo, pm | Switches which sprint is currently active | — | — |

## 10. Board / comms (3)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `board_post_message` | ceo, pm | Posts a message from company → board / founder | — | — |
| `board_list_messages` | ceo | Lists board messages + unread markers | — | — |
| `board_read_inbox` | ceo | Filtered view of board messages since last sprint boundary | — | — |

## 11. Execution control (5)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `execution_complete_cycle` | ceo | Marks the current execution cycle complete | — | — |
| `execution_pause_for_review` | ceo, cto | Pauses execution pending manual review | — | — |
| `execution_reconcile_post_review` | ceo | Resumes + reconciles state after human review | — | — |
| `execution_stop` | ceo | Stops execution (e.g. urgent abort) | — | — |
| `execution_approve_sprint` | ceo | Final approval step to close out a sprint | — | — |

## 12. Governance reads (5)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `governance_list_role_tools` | sl, cto | Shows which tools are allowed for a given role | — | — |
| `governance_check_tool_allowed` | sl | Tests whether a specific (role, tool) pairing is allowed | — | — |
| `governance_get_blast_radius` | sl, cto | Returns the declared blast radius for a tool | — | — |
| `governance_list_all_tools` | sl | Catalog dump of every registered tool | — | — |
| `governance_get_registry_stats` | sl | Counts + coverage metrics across the tool registry | — | — |

## 13. Trust / audit (6)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `trust_list_all_scores` | ceo, sl | Trust-tier table across all agents | — | — |
| `trust_get_agent_score` | sl, pm | One agent's current trust score + reasons | — | — |
| `audit_list_events` | sl, ceo | Recent audit-ledger entries (filterable) | — | — |
| `audit_get_activity` | sl | Activity stream for one agent or one task | — | — |
| `audit_log_event` | all | Records a self-reported audit note (tool-level usage) | — | — |
| `activity_emit` | hb | Heartbeat-internal activity event emission | — | — |

## 14. Planning / reasoning (5)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `planner_build_task_graph` | cto | Builds full task DAG from sprint rationale | `planner` | — |
| `planner_decompose_task` | cto, pm | Splits one big task into subtasks | `planner` | — |
| `planner_pick_skills_for_task` | hb | Picks top-N skills for this task+role | `planner` (haiku variant) | — |
| `plan_health_check` | hb, cto | Mid-sprint: diffs remaining tasks vs codebase, flags stale | `plan-health` | — |
| `plan_regenerate_task` | cto | Takes a stale task + current state, rewrites the task body | `plan-health` | — |

## 15. Reports / briefs (0 — consolidated into skills)

All three "brief builder" tools previously listed here were **specializations of `artifact_create`** with baked-in templates. The cleaner shape is:

- Keep the generic `artifact_create` tool (§2).
- Move the templates / workflow guidance into role-specific skills (§17).

| Was | Now |
|---|---|
| `pm_build_release_brief` | `pm-release-readiness-review` skill (§17.2) teaches the template; PM calls `artifact_create({kind: "output", ...})` |
| `marketing_distribution_brief` | `marketing-distribution-brief` skill (§17.2) teaches the template; marketing calls `artifact_create({kind: "plan", ...})` |
| `ceo_draft_sprint_rationale` | `ceo-sprint-proposal-prep` skill (§17.1, already live) teaches the workflow; CEO calls `sprint_create` directly with the rationale text |

Reason: prompts/templates belong in the prompt registry, not baked into tool handlers. A tool per "brief type" explodes quadratically if we keep adding roles or document types. One generic `artifact_create` + N skills scales linearly.

## 16. Misc / identity (5)

| Tool | Roles | What it does | Subagent | Verdict |
|---|---|---|---|---|
| `ping` | all | Liveness check; used at plugin boot | — | — |
| `who_am_i` | all | Returns this agent's role + identity (plugin boot) | — | — |
| `beat_heartbeat` | all | Stall-watchdog reset (keeps beat marked alive) | — | — |
| `envelope_idempotency_hash` | all | Helper: derive stable idempotency key for a request | — | — |
| `self_append_instruction` | all | Agent appends a learning to its per-role instruction overlay | — | — |

---

## Per-role totals (derived)

Counts every tool where the role appears (either named or via `all`):

| Role | Count |
|---|---|
| `ceo` | 49 |
| `cto` | 48 |
| `pm` | 45 |
| `dev` | 58 |
| `qa` | 56 |
| `ui` | 34 |
| `mkt` | 35 |
| `sl` | 54 |
| `hb` | 6 |

These are **upper bounds**. The per-role allowlist in `04` trims further —
e.g. `ceo` won't actually want `task_append_command` in its catalog even
though `all` technically includes `ceo`. Final allowlist curation happens
when we implement.

---

## Conventions

- **Naming:** `<domain>_<verb>` — `task_claim`, `workspace_diff`, etc.
- **`all` means all 8 employee roles**, not heartbeat. Heartbeat is `hb`.
- **Two roles listed = both can call** — not a group alias, literally those
  two in the allowlist.
- Tools used only by `hb` are system-invoked and never show up in an
  employee's prompt-visible catalog.

---

## What's listed in this doc vs. elsewhere

- **Tools (§1–§16)** — the ~112 LLM-callable ops
- **Skills (§17)** — prompt-injected guidance (not tools)
- **Plugin hooks (§18)** — fire on events, no LLM invocation
- **Internal ops (§19)** — ~105 orchestrator-only functions
- **Deletion list (§20)** — what gets removed when this ships

---

## How to use this doc

1. **Adding a new tool?** Pick the category. Decide which roles call it.
   Add the row. Stop. Don't think about MCP vs custom here — that's `04`.
2. **Removing coverage for a role?** Find the tool, trim the role column.
   The allowlist follows.
3. **New role?** Scan this doc, mark rows where the new role should appear.
   `04` then tells you how their catalog gets assembled.

---

## 17. Skills — prompt-injected guidance (19)

Skills are **not tools**. They're markdown documents the agent reads via the
built-in `skill` tool, which OpenCode resolves from the materialized
`.opencode/skills/<slug>/SKILL.md` files. Calling a skill injects its
content into the agent's context — it doesn't execute anything. State
mutation always happens through a tool.

Two flavors: **role-specific** (only relevant to one employee) and
**shared** (useful to all 8).

### 17.1 Role-specific skills — live (8)

| Skill | Roles | What it teaches | Verdict |
|---|---|---|---|
| `artifact-structure` | dev, qa, ui, mkt | How to shape artifact content by kind (plan / code / output / spec) so the next role can consume it | — |
| `ceo-sprint-proposal-prep` | ceo | Workflow to gather context + draft a sprint rationale before calling `sprint_propose` | — |
| `design-to-dev-handoff` | ui | Packaging a design spec so the developer can implement without re-asking | — |
| `developer-tdd-loop` | dev | Red → green → refactor discipline with evidence captured at each step | — |
| `external-approval-request` | mkt | When to open an `approval_request`, what evidence to attach, rollback plan required | — |
| `qa-verification-loop` | qa | Evidence-first verification: probe preview, capture browser, diff against criteria | — |
| `task-completion-checklist` | dev, qa, ui, mkt | Gates every task must clear before `task_complete` (tests pass, artifacts staged) | — |
| `workspace-probe-checklist` | qa | Pre-sign-off preview probe: health, console errors, network failures | — |

### 17.2 Role-specific skills — planned (6)

| Skill | Roles | What it will teach | Verdict |
|---|---|---|---|
| `pm-release-readiness-review` | pm | Aggregating sprint evidence into a go/no-go release decision | — |
| `cto-technical-plan-template` | cto | Template for a complete technical plan: modules, deps, milestones, risks | — |
| `cto-acceptance-criteria-writing` | cto | How to write testable acceptance criteria a QA agent can mechanically verify | — |
| `skills_lead-pattern-promotion` | sl | Judging when a recurring pattern deserves skill graduation | — |
| `marketing-distribution-brief` | mkt | Packaging a launch into channel plan + copy variants + timing | — |
| `meeting-chair-playbook` | ceo, cto, pm, sl | Skill+SVC invocation guide for meeting chairs. Covers `Task(facilitator-chair-service, {mode})` for `run`, `daily_brief`, `resolve`. Includes copy-paste JSON templates, envelope parsing, and failure-cause handling. See 06 §4.2 + 05 §5.2. | — |

### 17.3 Shared skills — planned (5)

| Skill | Roles | What it will teach | Verdict |
|---|---|---|---|
| `memory-hygiene` | all | What to record as a learning, what to forget, how to update vs append | — |
| `escalation-protocol` | all | When to `task_block` vs `approval_request` vs schedule a meeting | — |
| `meeting-participation-etiquette` | all | How to prepare a contribution, how to disagree productively, when to defer | — |
| `tool-error-recovery` | all | Reading `ToolResult.error.cause`, safe-retry patterns, when to stop and block | — |
| `meeting-contribution-drafter` | all | Skill+SVC invocation guide for pre-meeting prep. `Task(facilitator-contributor-service, {mode:"draft", myRole, meetingContext})` → review draft → `artifact_create` + `meeting_contribute`. See 06 §4.2 + 05 §5.2. | — |

---

## 18. Plugin hooks — auto-fire, no LLM (7)

Plugin hooks live in `.opencode/plugin/arceus.ts` and fire reactively on
OpenCode events. **No LLM ever calls them.** They exist to enforce
governance, emit telemetry, and cache session context — cross-cutting
concerns that shouldn't clutter every tool implementation.

### 18.1 Live (3)

| Hook | Fires on | What it does | Verdict |
|---|---|---|---|
| `tool.execute.before` — skill-manifest refresh | Every tool call | Loads `.opencode/arceus-skills.json` into a 10-s-cached Map so the skill-usage POST has the `skillId` lookup ready | — |
| `tool.execute.after` — skill-usage POST | `skill` tool calls only | Fire-and-forget POST to `/api/internal/telemetry/skills/:skillId/usage` — fuels EMA success-rate + `usageCount` | — |
| `experimental.session.compacting` | Session auto-compaction | No-op stub reserved for beat-survival accounting | — |

### 18.2 Planned (4)

| Hook | Fires on | What it will do | Verdict |
|---|---|---|---|
| `tool.execute.before` — governance gate | Every tool call | Looks up session context, checks `allowedTools`, enforces circuit-breaker tally; blocks with structured error if denied | — |
| `tool.execute.after` — audit ledger emit | Every tool call | Emits one audit line per call: `{role, tool, callId, latency, status, causeIfError}` | — |
| `tool.execute.after` — trust adjustment | `task_complete`, `task_verify` success/fail | Calls `adjustTrust(event)` so trust band evolves based on outcomes | — |
| `event` — stall detector | Heartbeat ticks | Tracks idle time per active beat; triggers `failDeveloperStall` if no tool call within threshold | — |

---

## 19. Internal — NEVER exposed as a tool (~105 ops)

Everything below stays inside the Arceus process. No LLM ever sees these.
Either they're raw infrastructure, they'd let an agent escalate its own
trust/privileges, or they'd let one agent recursively spawn another.

The categories mirror the repo's physical layout in `apps/api/src/` and
`packages/company-runtime/`.

### 19.1 Persistence / store (~50)

Raw DB access. Agents must go through governed wrappers (`task_create`,
`artifact_create`, etc.) — never the raw table writers.

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `upsertTask` | Direct INSERT/UPDATE on `tasks` table | Bypasses `task_create` validation + idempotency | — |
| `upsertArtifact` | Direct write to `artifacts` table | Bypasses artifact kind/size limits | — |
| `upsertApproval` | Direct write to `approvals` table | Bypasses approval-type governance | — |
| `upsertMeeting` | Direct write to `meetings` table | Bypasses participant + decision schema checks | — |
| `upsertSprint` | Direct write to `sprints` table | Sprint state transitions must go through lifecycle tools | — |
| `upsertCompany` | Direct write to `companies` table | Company mutations go via `company_*` tools only | — |
| `persistCompanyState` | Serializes + writes the full company snapshot | Infra scheduling; race-sensitive | — |
| `schedulePersistedCompanyState` | Debounces persistence writes | Internal scheduler | — |
| `flushPersistedCompanyState` | Forces immediate flush of pending writes | Shutdown path only | — |
| `loadPersistedCompanyState` | Reads the serialized snapshot on boot | Boot-only | — |
| `clearPersistedStoreState` | Wipes the store cache in memory | Destructive | — |
| `deletePersistedCompanyState` | Deletes the company's persisted snapshot | Destructive wipe | — |
| `getSnapshot` | Returns a handle to the full in-memory company state | Too broad — tool calls should return narrowed views | — |
| `setSnapshot` | Replaces the full snapshot atomically | Testing/recovery only | — |
| `mutateSnapshot` | Applies a closure that mutates snapshot state | Internal mutation primitive | — |
| `getTask` (raw) | Unscoped task reader | `task_get` wraps this with role scope | — |
| `getArtifact` (raw) | Unscoped artifact reader | Same | — |
| `getMeeting` (raw) | Unscoped meeting reader | Same | — |
| `getApproval` (raw) | Unscoped approval reader | Same | — |
| `getSprint` (raw) | Unscoped sprint reader | Same | — |
| `getCompany` (raw) | Full company record (incl. secrets) | Too broad | — |
| `listTasks`, `listArtifacts`, `listMeetings`, `listApprovals`, `listSprints` (raw) | Unscoped list readers | Tools return paginated + role-filtered views | — |
| `withTransaction` | Wraps a callback in a DB transaction | Infra primitive | — |
| `withRLSContext` | Sets row-level-security context for a query | Infra primitive | — |
| `withCompanyScope` | Binds queries to a specific company ID | Infra primitive | — |
| table-specific query helpers (~20) | SQL builders per table | Never prompt-safe | — |

### 19.2 Heartbeat engine (~20)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `tickHeartbeat` | One heartbeat tick — scans for beats to run | The scheduler itself | — |
| `scheduleHeartbeat` | Schedules the next tick | Internal scheduler | — |
| `enqueueBeat` | Adds a beat to the execution queue | Queue primitive | — |
| `dequeueBeat` | Pops the next beat to run | Queue primitive | — |
| `claimBeat` | Reserves a beat ID for execution | Atomic claim; concurrency-sensitive | — |
| `releaseBeat` | Releases a beat back to the queue on failure | Concurrency primitive | — |
| `reconcileStrandedBeats` | Recovers beats whose executor died mid-run | Recovery path; orchestrator-only | — |
| `BeatDependencies` wiring | DI container assembled per beat | Framework internal | — |
| `buildBeatContext` | Assembles the per-beat context object | Heartbeat composition step | — |
| `beatStateMachine` | State transitions: queued → running → done | State enforcement stays outside LLM | — |
| `transitionBeat` | Performs one state transition with audit | Internal transition | — |
| `observeBeatMetrics` | Emits latency/cost metrics | Telemetry hook territory | — |
| `recordBeatOutcome` | Writes success/fail + artifacts to ledger | Internal recorder | — |
| `computeBeatCost` | Token × model-rate math | Cost governance stays deterministic | — |
| model-cost lookup + rate table | Maps model IDs → dollar cost | Config | — |
| beat retry/backoff policy | Decides re-enqueue strategy on failure | Governance | — |

### 19.3 Workspace infrastructure (~20)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `cloneWorkspace` | Clones a template workspace for a new company | Provisioning step | — |
| `provisionWorkspace` | Full workspace bootstrap (disk + git + deps) | Pre-beat provisioning | — |
| `gcWorkspace` | Cleans up orphaned workspace files | Infra GC | — |
| `syncWorkspaceCheckpoint` (infra layer) | The plumbing behind `workspace_commit_checkpoint` | Tool wraps this | — |
| `gitInit` (raw) | Raw `git init` shell exec | Agents go through `workspace_init_git` | — |
| `gitAddAll` | Raw `git add -A` | Internal helper | — |
| `gitCommitRaw` | Raw `git commit` without governance | `workspace_commit` wraps this | — |
| `gitPushInternal` | Pushes checkpoints to a mirror repo | Infra mirror path | — |
| `spawnPreviewServer` | Launches the dev server process | OS-level | — |
| `teardownPreviewServer` | Kills the dev server process | OS-level | — |
| `allocatePreviewPort` | Picks an unused port for the preview | Port bookkeeping | — |
| `registerChildProcess` | Tracks a spawned process for cleanup | Process table | — |
| `reapChildProcess` | Reaps a finished process, returns exit code | Process table | — |
| `killBeatProcesses` | Kills all processes spawned by one beat | Cleanup path | — |
| port-allocation bookkeeping (~5 helpers) | Maintains port-in-use map | Infra | — |

### 19.4 Prompts / LLM infra (~15)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `structuredCompletion` | The raw LLM call primitive every SVC wraps | Exposing it defeats the SVC session boundary | — |
| `runPromptText` | Runs a free-text prompt, returns string | Recursive LLM invocation = infinite-loop + cost-bomb vector | — |
| `runInternalAgentPrompt` | Runs a prompt as a named internal agent | Same | — |
| `agent_run_prompt` | Legacy wrapper around `runPromptText` | Same | — |
| `assembleBudgetedContext` | Fits system + skills + memory into token budget | Used by prompt builder, not agent | — |
| `countTokens` | Tokenizer wrapper | Utility for the budgeter | — |
| `trimToBudget` | Truncates a string to fit a token budget | Same | — |
| `loadPromptTemplate` | Reads a prompt file from the registry | Template engine | — |
| `renderPromptTemplate` | Interpolates vars into a template | Template engine | — |
| `streamSSE` | Server-sent-events stream handler | Transport | — |
| `handleStreamChunk` | Per-chunk stream processor | Transport | — |
| `finalizeStream` | Stream completion + final assembly | Transport | — |

### 19.5 Governance plumbing (~20)

Agents *see the result* of governance (their allowlist). They never see the
evaluator.

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `filterToolsForAgent` | Computes which tools an agent can see | Exposes the allowlist algorithm — policy exfil | — |
| `evaluatePolicy` | Runs policy rules against a (role, tool, args) tuple | Lets an agent probe for bypass | — |
| `BASE_POLICY_RULES` | The rule table itself | Policy definition | — |
| `buildPolicyForRole` | Compiles role-specific policy at boot | Policy compiler | — |
| `cpUpdateTrustScore` | Writes a new trust score for an agent | **Self-promotion vector — never exposed** | — |
| `cpLoadTrustScore` (raw) | Reads raw trust data | `trust_get_agent_score` exposes a narrowed view | — |
| `computeBlastRadius` (raw) | Derives declared blast radius for a tool | Internal governance math | — |
| `resolveAllowlist` | Expands group refs into concrete tool IDs | Allowlist compiler | — |
| `expandGroupMembership` | Resolves `LEADERSHIP` / `DELIVERY` groups | Allowlist compiler | — |
| `auditAgent` (internal writer) | Appends to the audit ledger | Hook-only; agents don't self-audit | — |
| governance middleware (~10 helpers) | Before/after hooks for policy checks | Infra | — |

### 19.6 Telemetry / ledger (~20)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `costLedgerAppend` | Appends one cost entry (model × tokens × $) | Cost governance | — |
| `costLedgerAggregate` | Totals cost per company/sprint/role | Reporting internal | — |
| `costAlarmCheck` | Fires alarm if spend > budget | Alarm path | — |
| `skillUsageCounterIncrement` | Bumps usage counter for a skill ID | Fueled by telemetry hook, not by agent | — |
| `skillEMAUpdate` | Updates exponential moving-average success rate | Same | — |
| `activityStreamAppend` (raw) | Writes to activity stream | Tools expose narrowed `audit_*` readers | — |
| `activityStreamQuery` (raw) | Reads activity stream | Same | — |
| `auditEventAppend` (raw writer) | Raw audit ledger write | Hook-only | — |
| `telemetryFlush` | Flushes batched telemetry | Infra | — |
| `telemetryRetry` | Retries failed telemetry emission | Infra | — |
| `metricsSnapshot` | Dumps current metrics state | Ops plane | — |
| `metricsExport` | Exports metrics to external collector | Ops plane | — |
| per-metric helpers (~8) | Typed metric emitters | Internal | — |

### 19.7 Config / env (~20)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `loadEnv` | Reads `.env` + process.env at boot | Boot-time only | — |
| `requireEnv` | Loads a required env var or throws | Boot-time only | — |
| `optionalEnv` | Loads an optional env var with default | Boot-time only | — |
| feature-flag readers (~8) | One helper per flag (`isFeatureXEnabled`) | Runtime config | — |
| `getRateLimitConfig` | Returns rate limit thresholds | Policy knob | — |
| `getIdempotencyTTL` | Returns idempotency cache TTL | Policy knob | — |
| `getHeartbeatInterval` | Returns heartbeat tick interval | Policy knob | — |
| secret-rotation helpers (~3) | Rotates API keys on schedule | Security-sensitive | — |
| `getSupabaseConfig` | Supabase connection config | Infra config | — |
| `getModelRouterConfig` | Routing rules for model selection | Infra config | — |
| `getStorageConfig` | Object-storage connection config | Infra config | — |

### 19.8 Agent / session (~10)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `ensureAgentSession` | Creates session if missing, else returns existing | Provisioning happens in heartbeat, not via tool | — |
| `createAgentSession` | Fresh session creation | Same | — |
| `persistSession` | Serializes session to storage | Same | — |
| `loadSession` | Rehydrates session from storage | Same | — |
| `cpLoadAgentContext` | Assembles full beat context (identity + memory + tools + skills) | Heartbeat-owned composition | — |
| `handleSessionCompacting` | Plugin-hook handler for auto-compaction | Plugin hook, not LLM-callable | — |
| `spawnEMPSession` | Boots an employee-agent session | Orchestrator-owned | — |
| `spawnSVCSession` | Boots a service-agent session | Orchestrator-owned | — |
| `destroySession` | Cleans up a finished session | Lifecycle | — |
| `gcIdleSessions` | Reaps idle sessions past TTL | Lifecycle | — |

### 19.9 State / reactive (~10)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `subscribeToSnapshot` | Registers a listener for snapshot changes | Event bus internal | — |
| `emitSnapshotDiff` | Broadcasts a diff to subscribers | Event bus internal | — |
| `reactiveWatcher` | Generic reactive primitive | Cache coherence | — |
| `invalidateCache` | Clears a named cache | Cache coherence | — |
| `broadcastToFrontend` | Pushes updates over WebSocket to UI | UI streaming | — |
| `subscribeFrontendClient` | Registers a frontend connection | UI streaming | — |
| `registerEventHandler` | Hooks an orchestrator event | Event plumbing | — |
| `dispatchEvent` | Fires an orchestrator event | Event plumbing | — |
| reactive store primitives (~2) | Signal / effect helpers | Framework | — |

### 19.10 Utility helpers (~10)

| Function | What it does | Why internal | Verdict |
|---|---|---|---|
| `deepMerge` | Recursive object merge | Too generic for a tool | — |
| `deepClone` | Structured clone with class support | Too generic | — |
| `structuredCloneSafe` | Safe clone that drops non-serializable fields | Too generic | — |
| `generateId` | UUID generator | ID minting happens inside governed writers | — |
| `generateBeatId` | Beat-specific ID format | Same | — |
| `generateArtifactId` | Artifact-specific ID format | Same | — |
| `sha256` | SHA-256 hash | Utility | — |
| `hashStable` | Stable hash over sorted keys | Utility | — |
| `canonicalizeJSON` | Canonical JSON serialization | Utility | — |
| `formatTimestamp` / `parseDuration` | Date/duration helpers | Utility | — |

---

### 19.11 Explicit NEVER-expose list

These are called out individually because they *look* like they could be
tools (some are even public functions on the store), but exposing any of
them is an immediate privilege-escalation or cost-bomb vector.

| Function | What it does | Risk if exposed | Verdict |
|---|---|---|---|
| `cpUpdateTrustScore` | Mutates an agent's trust tier | Agent promotes itself past governance | — |
| `resetCompany` | Wipes a company's full state | Destructive; no recovery | — |
| `deletePersistedCompanyState` | Deletes persisted snapshot | Destructive | — |
| `clearPersistedStoreState` | Wipes in-memory store | Destructive | — |
| `evaluatePolicy` | Tests if a (role, tool, args) would be allowed | Policy probing / bypass discovery | — |
| `filterToolsForAgent` | Shows the allowlist algorithm | Policy exfiltration | — |
| `registerSkill` (raw) | Adds a skill without ATA review | Skips Skill-Evolution SVC; pollutes registry | — |
| `updateSkill` (raw) | Mutates a skill without review | Same | — |
| `deprecateSkill` (raw) | Deprecates without review | Same | — |
| `runInternalAgentPrompt` | Runs an arbitrary prompt as a named agent | Recursive LLM; cost bomb + infinite loop | — |
| `runPromptText` | Runs a prompt, returns text | Same | — |
| `agent_run_prompt` | Legacy wrapper | Same | — |
| `schedulePersistedCompanyState` | Forces persistence schedule | Race-sensitive infra | — |
| `flushPersistedCompanyState` | Forces immediate persistence | Shutdown path | — |
| `upsertTask` (raw) | Bypasses `task_create` governance | No idempotency, no role check | — |
| `upsertArtifact` (raw) | Bypasses `artifact_create` | No kind/size validation | — |
| `upsertApproval` (raw) | Bypasses approval workflow | No participant check | — |
| `upsertMeeting` (raw) | Bypasses meeting lifecycle | No schema check | — |
| any `cp*` control-plane function | Internal orchestrator plumbing | Control-plane is orchestrator-only by definition | — |

---

## Rule of thumb

> **If a function returns raw DB rows, mutates trust, triggers another LLM,
> or lives in `control-plane.ts` / `heartbeat.ts` / `store.ts`, it's
> internal. Full stop.** The governed tool that wraps it goes in §1–§16
> above — the raw function doesn't.

---

## 20. Deletion list — what goes away when this system ships

Every item below exists today but becomes dead weight once the heartbeat
architecture (vision §00) + governed tool surface (§1–§16) + SVCs
(`04 §7`) + ROLE_CONFIG dispatch lands. Ordered by impact.

### 20.1 Files to delete entirely (1)

| File | Why | Verdict |
|---|---|---|
| `apps/api/src/tasks/specialist-executor.ts` | The 350-line role-branching orchestrator. Replaced by `runBeat(role)` + agent-initiated tool calls. Vision §315 confirms: "specialist-executor is ~20 LOC in the target, not shrunk from 350." | — |

### 20.2 Dead / duplicate functions (5)

From `03-ops-inventory.md §3` — already marked for removal:

| Function | File | Why | Verdict |
|---|---|---|---|
| `inferCeoStage(snapshot, executionStatus?)` | `apps/api/src/agents/ceo.ts` | Subsumed by `execution_get_status` | — |
| `classifyCeoResponse(response, snapshot)` | `apps/api/src/agents/ceo.ts` | Internal CEO classification; not agent-facing | — |
| `generateStrategy(snapshot)` | `apps/api/src/agents/ceo.ts` | Agent sees result via board messages | — |
| `isCeoStreaming()` | `apps/api/src/agents/ceo.ts` | Debug-only state check | — |
| `appendTaskPlanStep` (internal) | `apps/api/src/persistence/store.ts` | Superseded by `task_append_plan_step` MCP tool | — |

### 20.3 Headless `structuredCompletion()` lambdas — replaced by SVCs (~18 calls)

These 18 one-shot LLM calls get consolidated into 5 SVC pipelines
(`04 §7`). The standalone functions disappear; the logic survives inside
an SVC session.

| Function | File | Consolidates into | Verdict |
|---|---|---|---|
| `llmFactExtractor` | `memory/extractors.ts` | Memory SVC (`memory_process_turn`) | — |
| `llmActionDecider` | `memory/extractors.ts` | Memory SVC (`memory_process_turn`) | — |
| `llmPrimingGenerator` | `memory/extractors.ts` | Memory SVC (`memory_prime_agent`) | — |
| `llmHabitMatcher` | `memory/extractors.ts` | Memory SVC (`memory_match_habits`) | — |
| `generateContribution` | `meetings/synthesis.ts` | Facilitator SVC (`meeting_draft_contribution`) | — |
| `synthesizeMeeting` | `meetings/synthesis.ts` | Facilitator SVC (`meeting_run`) | — |
| `resolveMeeting` | `meetings/resolution.ts` | Facilitator SVC (`meeting_run`) | — |
| `buildDailySyncBrief` | `meetings/resolution.ts` | Facilitator SVC (`meeting_generate_daily_brief`) | — |
| `classifyTaskSkills` | `skills/classifier.ts` | Planner SVC (`planner_pick_skills_for_task`) | — |
| `generateWorkflowTaskPlan` | `tasks/planner.ts` | Planner SVC (`planner_build_task_graph`) | — |
| `triggerCeoSprintProposal` raw completion | `sprints/proposals.ts` | Routed through the CEO agent's own session | — |
| `analyzeFailure` (attribution) | `skills/evolution.ts` | Skill-Evolution SVC (`skill_evolve_from_failure`) | — |
| `proposeSkillMutation` | `skills/evolution.ts` | Skill-Evolution SVC | — |
| `proposeSkillDiscovery` | `skills/evolution.ts` | Skill-Evolution SVC | — |
| `generateTestScenarios` (TGA) | `skills/evolution.ts` | Skill-Evolution SVC | — |
| `executeDryRun` (EAA) | `skills/evolution.ts` | Skill-Evolution SVC | — |
| `reviewResults` (ROA) | `skills/evolution.ts` | Skill-Evolution SVC | — |
| `reviseSkill` | `skills/evolution.ts` | Skill-Evolution SVC | — |
| `synthesizeSkill` | `skills/evolution.ts` | Skill-Evolution SVC (`skill_synthesize_from_patterns`) | — |
| `pruneAlreadyCompletedSpecialistTasks` | `tasks/specialist-executor.ts` | Deleted with the file | — |

### 20.4 Inline prompt builders — moved to template registry

These functions construct prompts as local `[...].join("\n")` arrays next
to the call site. They get **replaced** by a single template in
`prompts/templates/` (for EMPs) or `prompts/templates/svc/` (for SVCs). The
local builders are deleted; the strings live once, loaded from disk.

| Builder | File | Destination | Verdict |
|---|---|---|---|
| inline prompts for `resolveMeeting` (30 lines) | `meetings/resolution.ts` | `prompts/templates/svc/facilitator/*` | — |
| inline prompts for `buildDailySyncBrief` | `meetings/resolution.ts` | Same | — |
| `buildContributionPrompt` | `meetings/synthesis.ts` | Same | — |
| `synthesizeMeeting` inline prompt | `meetings/synthesis.ts` | Same | — |
| `buildAttributionPrompt` | `skills/evolution.ts` | `prompts/templates/svc/skill-evolution/*` | — |
| `buildMutationPrompt` | `skills/evolution.ts` | Same | — |
| `buildDiscoveryPrompt` | `skills/evolution.ts` | Same | — |
| `buildTGAPrompt` | `skills/evolution.ts` | Same | — |
| `buildEAAPrompt` | `skills/evolution.ts` | Same | — |
| `buildROAPrompt` | `skills/evolution.ts` | Same | — |
| `buildRevisionPrompt` | `skills/evolution.ts` | Same | — |
| `buildSkillSynthesisPrompt` | `skills/evolution.ts` | Same | — |
| `pruneAlreadyCompletedSpecialistTasks` prompt | `tasks/specialist-executor.ts` | Deleted with file | — |
| `buildCeoOperatingPrompt` | `apps/api/src/agents/ceo.ts` | `prompts/templates/emp/ceo.md` | — |
| `classifyCeoResponse` prompt | `apps/api/src/agents/ceo.ts` | Deleted (function is dead, §20.2) | — |

### 20.5 Role-specific `if (role === "…")` chains — eliminated by `ROLE_CONFIG`

Anti-pattern #9 from `FLAWS-COMPACT.md`. ~80 magic-string comparisons
across 10 files. Replaced by a single `ROLE_CONFIG: Record<Role, RoleConfig>`
table where each role's behavior (display name, artifact titles, handoff
targets, approval policy) is a property, not an if-branch.

| File | Deleted branches | Replacement | Verdict |
|---|---|---|---|
| `tasks/specialist-executor.ts` | 18 sites | File deleted entirely (§20.1) | — |
| `heartbeats/event-bridge.ts` | 12 `role === "developer"` blocks | Keyed `EVENT_HANDLERS[role]` table | — |
| `persistence/control-plane.ts` | 8 `agent.role === …` checks | `ROLE_CONFIG[role].capabilities` | — |
| `persistence/store.ts` | 8-branch role → name chain | `ROLE_CONFIG[role].displayName` lookup | — |
| `memory/handoffs.ts` | 4 role branches | `memory_handoff` tool — agent chooses targets | — |
| `prompts/specialist.ts` | 5 `task.assignedRole === …` | Likely file deleted once prompts move to registry | — |
| `agents/ceo.ts` | 6 `message.role === …` checks | `ROLE_CONFIG` + typed discriminated union on message | — |
| `sprints/proposals.ts` | 2 `t.assignedRole === …` | `ROLE_CONFIG[role].category` (delivery vs leadership) | — |
| `heartbeats/beat-executor.ts` | Task-kind `===` chain | `TASK_KIND_CONFIG[kind]` | — |

### 20.6 Hardcoded governance flag

| Line | File | Action | Verdict |
|---|---|---|---|
| `const GOVERNANCE_ENABLED = false` | `heartbeats/beat-executor.ts` | Flip to `true`, then delete the const and the ternary entirely — plugin's `tool.execute.before` gate is the new enforcement point (§18.2) | — |

### 20.7 Fire-and-forget pipelines — replaced by proper job queue

Anti-pattern #11 from flaws. `.then(…).catch(console.warn)` on critical
paths — no retry, no propagation, no alerting.

| Call | File | Replacement | Verdict |
|---|---|---|---|
| `runCrossSprintTransfer().then(…)` | `sprints/lifecycle.ts:162` | Job-queue enqueue with retry + terminal-failure alarm | — |
| `runATAPipeline().then(…)` | `skills/cross-sprint.ts:59` | Same; routed through Skill-Evolution SVC | — |
| State-persistence fire-and-forget (`schedulePersistedCompanyState`) | `persistence/store.ts:43` | Synchronous within the write txn; async flush uses the queue. **Critical for `meeting_record` and `artifact_create` durability** — both tools claim atomic writes but today the DB flush happens via fire-and-forget after `replaceState`. Post-fix: both become sync DB writes in the same transaction as the in-memory snapshot update (aligns with the always-persist model — see §5.1 `meeting_record`, §2 `artifact_create`). | — |

### 20.8 Mutable module-level singletons — replaced by DI

Anti-pattern #16. Module-level `Map`s / `let` with no reset — tests
pollute each other.

| File | Bad pattern | Replacement | Verdict |
|---|---|---|---|
| `skills/skill-registry.ts` | Module-level `Map`s | Factory function + DI container; one instance per company-runtime | — |
| `skills/pattern-learner.ts` | Module-level `deps` var | Constructor-injected deps | — |

### 20.9 Governance — trust-writing code paths that become unreachable

Not deleted outright (still referenced by governance plumbing), but *no
longer called by agents*. Their callers outside the governance system
disappear:

| Function | File | Status | Verdict |
|---|---|---|---|
| Any agent-side call to `cpUpdateTrustScore` | every site | Replaced by the `tool.execute.after` trust-adjustment hook (§18.2) | — |
| Orchestrator-side calls to `setTaskStatus` | `specialist-executor.ts`, `beat-executor.ts` | Gone — agents call `task_complete` / `task_block` | — |
| Orchestrator-side `addArtifact` calls | `specialist-executor.ts` | Gone — agents call `artifact_create` | — |
| Orchestrator-side `recordMeeting` | `specialist-executor.ts` | Gone — agents call `meeting_record` | — |
| Orchestrator-side `deliverUiDesignerMemoryHandoff` | `specialist-executor.ts` | Gone — designer calls `memory_handoff` | — |
| Orchestrator-side `createMarketingExternalApproval` | `specialist-executor.ts` | Gone — marketing calls `approval_request` | — |

### 20.10 Tests that pin the old shape

Any test that:

- Imports from `tasks/specialist-executor.ts` → delete
- Asserts `role === "…"` branching behavior → rewrite against `ROLE_CONFIG`
- Mocks individual `structuredCompletion` call-sites (the 18 above) → rewrite against SVC contracts
- Asserts orchestrator creates artifacts / sets task status → rewrite to assert *agent* tool calls

Exact test-file list to be generated at implementation time via
`grep -rl specialist-executor|structuredCompletion|role === ` under `test/`.

---

## Deletion scorecard (rough)

| Bucket | Items | LOC delta (estimate) |
|---|---|---|
| Files deleted | 1 (`specialist-executor.ts`) | −350 |
| Dead/dup functions | 5 | −200 |
| Headless LLM lambdas | ~18 | −600 |
| Inline prompt builders | ~15 | −400 |
| Role-branching sites | ~80 across 9 files | −500 |
| Governance hack | 1 flag + ternary | −20 |
| Fire-and-forget wrappers | 3 | −60 |
| Module singletons | 2 | −80 |
| **Net removal** | | **~−2,200 LOC** |

Against new code added (SVCs, ROLE_CONFIG, template registry, plugin
hooks, tool handlers): expected **net-negative** by ~500–800 LOC. The
codebase gets *smaller* while gaining agent autonomy.

---

## How to use the deletion list

1. **Don't delete anything until its replacement ships.** Each row has a
   "Replacement" or "Consolidates into" column — that must be green first.
2. **Delete in buckets, not by file.** Take one bucket (say §20.4 inline
   prompts) and sweep all of it so the template registry is the only
   source of truth by end of day.
3. **Tests first.** Before deleting a function, grep for test references;
   update or remove tests in the same PR.
4. **The `NEVER-expose` list (§19.11) is not on the deletion list.** Those
   stay internal forever — they're scaffolding the governed tools need.

---

## 21. Service Subagents — summary (5)

Each **Subagent** value in the tables above points at one of these five
OpenCode subagents (`mode: subagent, hidden: true`). Full configs, system
prompts, per-scenario flow diagrams, and the per-employee
`permission.task` matrix live in [`06-subagent-flows.md`](./06-subagent-flows.md).

| Subagent | Model | Steps cap | Backs tools | What it does | Verdict |
|---|---|---|---|---|---|
| `memory` | Haiku | 10 | `memory_process_turn`, `memory_prime_agent`, `memory_match_habits` | Extract facts → reconcile → store; pre-beat priming; habit matching. Replaces 4 headless lambdas in `memory/extractors.ts`. | — |
| `facilitator` | Sonnet | 15 | `meeting_run`, `meeting_generate_daily_brief`, `meeting_draft_contribution` | End-to-end meeting lifecycle in one session: contribute → synth → resolve → brief. Replaces 4 cold calls across `meetings/synthesis.ts` + `meetings/resolution.ts`. | — |
| `skill-evolution` | Sonnet | 25 | `skill_evolve_from_failure`, `skill_synthesize_from_patterns`, `skill_review_candidate`, `skill_propose_mutation`, `skill_init_evolution` | ATA pipeline: attribution → mutation → TGA → EAA → ROA → revise (bounded loop) → synthesize. Replaces 8 lambdas in `skills/evolution.ts`. | — |
| `planner` | Sonnet (Haiku for picker) | 15 | `planner_build_task_graph`, `planner_decompose_task`, `planner_pick_skills_for_task` | Task graph build, task decomposition, skill selection. Replaces `generateWorkflowTaskPlan` + `classifyTaskSkills`. | — |
| `plan-health` | Sonnet | 10 | `plan_health_check`, `plan_regenerate_task` | Diff remaining tasks vs codebase; flag staleness; regenerate stale task bodies. New — closes the "plans drift and rot" gap. | — |

### Contract shared by every SVC

- `permission.task: { "*": "deny" }` — cannot spawn other SVCs
- Each invocation = fresh child session (no state across calls)
- Returns uniform `{status, summary, data, error}` envelope
- Propose-dispose — SVC never writes governed state; calling employee does
- Bounded iteration via `steps:` — on cap-hit, returns
  `status: "partial"` with best-effort data; calling employee decides
  escalation

See §06 for scenarios, system prompts, and the per-employee
`permission.task` table.
