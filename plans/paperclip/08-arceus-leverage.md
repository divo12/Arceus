---
title: "Arceus Leverage — How to Apply Paperclip's Patterns"
---

# 08 · Arceus Leverage — How to Apply Paperclip's Patterns

**The crown file of this research folder.** Everything prior documented what Paperclip does; this file maps those patterns into concrete Arceus changes with file-level edit sites, estimated effort, and suggested sequencing.

Read this in priority order — each section is a self-contained proposal with a "why", a "what to change", and a "how long."

---

## 1 · Extract an adapter layer (biggest single win)

**Why.** Arceus's orchestrator is hard-wired to OpenCode. Lines in `apps/api/src/opencode.ts` and `apps/api/src/orchestrator.ts` call the OpenCode binary directly. Consequences: can't run Claude Code for cheap roles, can't use Codex for testing, can't let a board operator pick a runtime per agent.

Paperclip proves the refactor works with six adapters behind one structural contract. See `04-agent-adapters.md` for the five-method shape: `execute`, `parse`, `listSkills`, `syncSkills`, `models`.

**What to change.**

1. Create `packages/adapters/` at repo root. One subdir per adapter (start with `opencode-local`). Structure mirrors Paperclip: `src/server/`, `src/ui/`, `src/cli/`, `src/index.ts`.
2. Add an `adapters/abstract.ts` in `packages/contracts/src/` defining:
   ```ts
   export interface AgentAdapter {
     type: string;
     label: string;
     models: Array<{ id: string; label: string }>;
     execute(input: AdapterExecutionInput): Promise<AdapterExecutionResult>;
     parseEvent(line: string): RunEvent | null;
     listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot>;
     syncSkills(ctx: AdapterSkillContext, desired: string[]): Promise<AdapterSkillSnapshot>;
   }
   ```
3. Add `adapterType: string` + `adapterConfig: jsonb` to the `agents` table. Migration: `packages/db/migrations/NNN_add_adapter_fields.sql`.
4. Move OpenCode-spawn code from `apps/api/src/opencode.ts` into `packages/adapters/opencode-local/src/server/execute.ts`. Thin out `opencode.ts` to a re-export.
5. At server boot, register adapters via a central registry. Dispatch in the orchestrator looks like `registry.get(agent.adapterType).execute(input)`.

**Effort.** ~1 week. Pure refactor, no behavior change on the happy path.

**Guardrail.** Do not add a Claude adapter in the same PR. Ship the refactor with only OpenCode behind the new interface, then add Claude Code in a follow-up.

---

## 2 · Adopt the heartbeat protocol as an explicit contract

**Why.** Today Arceus beats are defined by whatever the orchestrator dispatches. There's no single document the agent reads that says "this is the procedure." When a beat fails partway through, recovery is ad hoc.

Paperclip's `HEARTBEAT.md` (`server/src/onboarding-assets/ceo/HEARTBEAT.md:1-83`) is **read by the agent in every wake**. It is the protocol, encoded as an agent instruction. Agents that drift from it fail in predictable, reviewable ways.

**What to change.**

1. Create `packages/company-runtime/onboarding/{role}/HEARTBEAT.md` for each canonical role: CEO, Engineer, PM, QA, Designer, Skills Lead. Each tailored but following the same 9-step shape.
2. At beat dispatch, materialize the role's HEARTBEAT.md into the per-beat skill directory (alongside normal skills). Via the adapter skill-injection mechanism, the agent loads it naturally.
3. Add a test: every canonical role has a HEARTBEAT.md. CI fails if one is missing.
4. Document the protocol explicitly in `docs/architecture/heartbeat-protocol.md` mirroring Paperclip's public doc.

**Effort.** ~2 days to write the 6 HEARTBEAT.md files + ~1 day wiring.

**Payoff.** Agents following the protocol produce readable post-mortems. Debugging moves from "agent did something weird" to "agent skipped step 5, here's why."

---

## 3 · Port the atomic checkout CAS

**Why.** Today Arceus can in principle double-execute a task if two beats fire near-simultaneously (a comment-mention + a scheduled wake on the same issue). The current code path to transition `todo → in_progress` does not use a compound condition.

Paperclip's `issues.ts:1779-1851` nails this with `SELECT FOR UPDATE` + compound `UPDATE ... WHERE status IN (...) AND (checkoutRunId IS NULL OR checkoutRunId = ?)`. 409 on race. Agents never retry 409.

**What to change.**

1. Add `checkout_run_id uuid null` and `execution_run_id uuid null` columns to `tasks` table in `packages/db/src/schema/tasks.ts`. Migration.
2. Implement an `/api/tasks/:id/checkout` endpoint in `apps/api/src/routes/` with the exact Paperclip SQL:
   ```sql
   BEGIN;
   SELECT id FROM tasks WHERE id = $1 FOR UPDATE;
   UPDATE tasks
      SET checkout_run_id = $run, execution_run_id = $run,
          status = 'in_progress', started_at = NOW()
    WHERE id = $1
      AND status IN ('todo','backlog','blocked','in_review')
      AND (assignee_agent_id IS NULL OR assignee_agent_id = $agent)
      AND (checkout_run_id IS NULL OR checkout_run_id = $run)
      AND (execution_run_id IS NULL OR execution_run_id = $run);
   ```
3. In orchestrator dispatch, call the checkout endpoint before doing any work. Handle 409 by re-queueing the beat (or skipping).
4. Update the HEARTBEAT.md skill body to document "never retry 409."

**Effort.** ~1 day, including tests that assert race-safety.

**Guardrail.** Add a race-condition test that fires 10 checkouts in parallel on the same task and asserts exactly 1 succeeds.

---

## 4 · Unify skill loading via progressive-disclosure materialization

**Why.** Arceus already started this (the `Arceus-progdisc/` worktree in the repo is mid-flight). Paperclip validates the end state: no embedding, no classifier LLM call, **LLM-picked skills from an in-prompt catalog, full bodies materialized on disk for the adapter to discover**.

Key insight from `03-skills-system.md` §B: Paperclip has no mutation pipeline, but otherwise their loading model is what Arceus wants. Our SkillArtifact lifecycle (versioning, EMA, mutation) stays — only the *loading* changes.

**What to change.**

1. Delete the embedding-based `matchSkillsAsync` hot path. It's still referenced in `Arceus-progdisc/` but not in main (already removed). Confirm main does not regress.
2. In `apps/api/src/skills/catalog.ts:26`, `buildSkillCatalog(role)` is already the compact catalog. Keep it. Inject into the agent's system prompt as a tier-1 catalog:
   ```
   ## Available skills for {role}
   - write-tests-first (v3, trust 82%) — Use when writing new features with tests first.
   - integrate-feedback (v2, trust 91%) — Use when processing a review that asks for changes.
   ...
   ```
3. At beat dispatch, materialize the *active* subset as real files under `{beatWorkdir}/.opencode/skills/{name}/SKILL.md`. OpenCode's built-in skill tool picks them up.
4. Add a PostToolUse hook via the OpenCode plugin API that POSTs back to `/api/skill-usage` when the LLM loads a skill body. This feeds `recordSkillUsage` and the EMA success-rate update.
5. Extend `SkillArtifact` with `resources?: { path, kind, content }[]` to carry tier-3 attachments (scripts, references). Materialize alongside SKILL.md.

**Effort.** 2-3 days (work is already partially done in `Arceus-progdisc/`).

**What we keep that Paperclip doesn't have.**
- `successRate` EMA
- `version` counter
- Mutation pipeline (`skill-mutator.ts`) — Pattern Learner → proposals → Skills Lead approval → merge as v+1
- `company_skills` DB persistence (like Paperclip, but richer)

---

## 5 · Stranded-run reconciliation loop

**Why.** Arceus has **zero** crash recovery. If an OpenCode beat's process dies mid-run, the task sits `in_progress` indefinitely with nothing polling. The only recovery is a human noticing and manually resetting status.

Paperclip's `heartbeat.ts:2987` runs a reconciliation loop every N seconds that:
1. Finds `heartbeat_runs` with `status='running'` and a dead PID.
2. Marks them crashed, releases locks.
3. Enqueues at most **one** automatic recovery wake with `reason='stranded_recovery'`.
4. After `processLossRetryCount` exhausted (cap 40), marks the issue `blocked` with a board-visible comment.

**What to change.**

1. Add `pid int`, `process_group_id int`, `process_loss_retry_count int default 0` to `heartbeat_runs` (or whatever our beat table is).
2. In the adapter spawn path, capture PID + process group (set `detached: true` on `spawn`).
3. Add `apps/api/src/services/stranded-reconciler.ts`. On server boot + every 30s: scan running beats, check PIDs with `process.kill(pid, 0)` (throws if dead), mark dead runs crashed, release task locks, enqueue recovery.
4. Cap recovery at 5 (we're simpler than Paperclip; 40 is overkill). Beyond cap → mark task blocked + comment.
5. UI: show crash chain via `retry_of_run_id` (next section adds this).

**Effort.** ~2 days including the PID/group capture + unit tests.

**Risk.** Misdetecting live processes as dead if PIDs recycle. Use `process_group_id` + a second check (modification time on the run's log file) to be safe.

---

## 6 · Plugin SDK (start the long investment)

**Why.** Arceus's surface is closed. Every new integration (GitHub, Linear, Slack, custom tools) is a core code change. This does not scale.

Paperclip's plugin SDK (see `07-plugin-system.md`) is a ~3-week investment that unlocks a community extension model: JSON-RPC over stdio, process isolation, capability gating, manifest validation.

**What to change (sequenced).**

Phase A — minimal skeleton (1 week):
1. Create `packages/arceus-sdk/`. Lift the structure of Paperclip's `packages/plugins/sdk/` verbatim (MIT licensed). Rename namespaces.
2. Host side: `apps/api/src/plugins/` with `worker-manager.ts`, `tool-dispatcher.ts`, `manifest-validator.ts`.
3. DB: migrations for `plugins`, `plugin_config`, `plugin_state`.
4. One example plugin: `examples/hello-world` that registers a single tool.

Phase B — capability system (1 week):
5. Implement capability allowlist: plugin declares `issues.read`, host rejects calls outside declared capabilities.
6. Secret handling: `ctx.secrets.get(key)` reads from `company_secrets` with per-plugin scoping.

Phase C — UI slots (1 week, optional):
7. Add named UI slots in the web app; dynamic script loading from `/api/plugins/{id}/ui/...`.
8. Second example: `examples/dashboard-widget` — tiny React widget.

**Effort.** 3 weeks, parallelizable. Can defer Phase C.

**Strategic value.** Unlocks Arceus as a *platform* instead of a *product*. Third-party adapters become plugins that register `adapterType`.

---

## 7 · DB schema lifts (small, high-value migrations)

**Why.** Several Paperclip column-level choices solve real problems Arceus will hit. Cheap to add now; painful to add later.

**What to change, in priority order.**

**Migration A — `heartbeat_runs` augmentation.**
```sql
ALTER TABLE heartbeat_runs
  ADD COLUMN pid                     integer,
  ADD COLUMN process_group_id        integer,
  ADD COLUMN adapter_config_rev_id   uuid REFERENCES agent_config_revisions(id),
  ADD COLUMN session_id_before       text,
  ADD COLUMN session_id_after        text,
  ADD COLUMN retry_of_run_id         uuid REFERENCES heartbeat_runs(id),
  ADD COLUMN process_loss_retry_count integer DEFAULT 0;
```
Needed for §5 (stranded recovery) and clean session continuity.

**Migration B — `heartbeat_run_events`.**
```sql
CREATE TABLE heartbeat_run_events (
  id         bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES heartbeat_runs(id),
  seq        integer NOT NULL,
  event_type text NOT NULL,
  stream     text,
  level      text,
  message    text,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);
CREATE INDEX ON heartbeat_run_events (run_id, seq);
```
Enables resumable UI tails + post-hoc structured audit.

**Migration C — `agent_task_sessions`.**
```sql
CREATE TABLE agent_task_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          text NOT NULL,
  agent_id            text NOT NULL,
  adapter_type        text NOT NULL,
  task_key            text NOT NULL,
  session_params_json jsonb,
  session_display_id  text,
  last_run_id         uuid REFERENCES heartbeat_runs(id),
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, agent_id, adapter_type, task_key)
);
```
Enables per-task session continuity across beats.

**Migration D — `activity_log`.**
```sql
CREATE TABLE activity_log (
  id          bigserial PRIMARY KEY,
  company_id  text NOT NULL,
  actor_kind  text NOT NULL,       -- 'board'|'agent'|'system'
  actor_id    text,
  entity_kind text NOT NULL,
  entity_id   text NOT NULL,
  operation   text NOT NULL,
  diff        jsonb,
  run_id      uuid REFERENCES heartbeat_runs(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity_log (company_id, created_at DESC);
CREATE INDEX ON activity_log (entity_kind, entity_id);
```
Unified audit trail, replaces ad-hoc logging scattered through services.

**Effort.** 1 day per migration, including writer helpers and backfill (if applicable).

---

## 8 · Budget policies + incidents split

**Why.** Today Arceus tracks `costs` but enforcement is ad-hoc in a handful of places. Paperclip separates **declarative caps** (`budget_policies`) from **observed breaches** (`budget_incidents`). See `05-board-and-governance.md §C`.

**What to change.**

1. New migration: `budget_policies` with `(company_id, scope_type, scope_id, metric, window_kind)` unique.
2. New migration: `budget_incidents` append-only.
3. Single function `getInvocationBlock(ctx) → { status, reason? }` called before every beat claim. Mirror Paperclip's `heartbeat.ts:2622`.
4. On hard-stop breach: cancel the beat + write incident + send board notification.
5. UI: surface current policies + recent incidents.

**Effort.** 2 days.

---

## 9 · Activity log as the single audit story

**Why.** Arceus today writes audit bits across many tables. When a board user asks "what did my agents do last week?", the answer is a pile of union queries. Paperclip's single `activity_log` (+ `heartbeat_run_events` for per-run detail) gives one pane.

**What to change.** Covered by Migration D in §7 above. Plus:
1. `apps/api/src/lib/activity-log.ts` — a single `append(event)` helper.
2. Call sites: every status transition, approval decision, policy change, plugin install, workspace realize/close.
3. A new route: `GET /api/companies/{id}/activity?entityKind=...&since=...` paginated.

**Effort.** 1 day after Migration D lands.

---

## 10 · What NOT to copy

Not every Paperclip pattern is right for Arceus.

- **Multi-adapter at launch.** Paperclip ships six adapters because they want every runtime; Arceus should stay focused on one (OpenCode) until v1. The adapter layer is for *structural* decoupling, not for shipping Claude Code immediately.
- **Their single-human board model.** Arceus's product aims at team usage earlier. We will need multi-board sooner than v2. Plan RBAC in from the start.
- **Dropping embeddings entirely.** Paperclip has no mutation/learning pipeline; they don't need embeddings. Arceus's Pattern Learner may benefit from embeddings at the *attribution* layer (matching failed beat patterns to skills). Keep `skill-mutator.ts` + embeddings there. Just not on the dispatch hot path.
- **PGlite in production.** Paperclip allows it; we shouldn't rely on embedded Postgres in production. Supabase Postgres stays.
- **Paperclip's `dangerouslySkipPermissions = true` default.** Their reason is valid (headless `--print` mode can't answer prompts), but we should make this explicit per-adapter and audit every tool permission in the HEARTBEAT.md.

---

## Recommended sequencing

Suggested order (6-8 weeks total):

| Week | Work | Sections |
|---|---|---|
| 1 | DB migrations A+B+C+D (§7 + §9) — foundation for everything else | §7 A-D, §9 |
| 2 | Atomic checkout CAS + HEARTBEAT.md protocol | §2, §3 |
| 3 | Stranded-run reconciliation (needs PID columns from wk 1) | §5 |
| 4 | Extract adapter layer (opencode-local) | §1 |
| 5 | Progressive-disclosure skill loading + PostToolUse hook | §4 |
| 6 | Budget policies + incidents + enforcement gate | §8 |
| 7-8 | Plugin SDK Phase A + one example plugin (optional to defer) | §6 |

Each week is a shippable PR. The only hard dependency is migrations first (week 1), because §3 needs checkout columns and §5 needs PID columns.

---

## One-line summary

> Arceus and Paperclip are attacking the same problem. Paperclip has made the control-plane-vs-execution-plane split cleaner, atomic concurrency safer, skills looser, and governance smaller. Lift the plumbing (adapter layer, CAS checkout, stranded reconciliation, activity log), **keep** Arceus's richer skill lifecycle, and defer what Paperclip deferred (plugins, multi-runtime launch).

## Open questions

- **[unconfirmed]** Does Paperclip's `issue_relations` allow arbitrary cycles? (Probably not; likely DAG-only enforced at write time.)
- **[unconfirmed]** What's in `plugin-runtime-sandbox.ts` — is it full-on seccomp/AppArmor, or just env scrubbing? Worth reading before plugin Phase A.
- **[unconfirmed]** How does `process_group_id` survive across docker-compose environments where the server and agent are in the same container? Need to test.

Each of these will shake out during implementation. Ask the board operator (you) before committing to a specific answer.
