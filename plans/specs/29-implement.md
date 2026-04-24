# Spec 29 — Implementation Plan: Skill Evolution Orchestrator & Skills-Lead Tools

**Status:** Draft · **Owner:** Platform · **Last Updated:** 2026-04-25
**Closes:** [`29-skill-evolution-orchestrator.md`](./29-skill-evolution-orchestrator.md)
**Depends on shipped:**
- Spec 14 — 8 ATA primitives, isolated `structuredCompletion` calls in `apps/api/src/skills/evolution.ts`
- Spec 23 Pass 1–3 — per-beat skill-usage tally + `updateSuccessRate` round-trip; DB write-through behind `ARCEUS_SKILLS_DB_WRITETHROUGH`
- Spec 26/27 — internal-MCP envelope + idempotency middleware + per-role allowlists
- Spec 13 — governance gateway (already gates all MCP tools via `ALL_ARCEUS_TOOLS`)

---

## 0. TL;DR

Eight phases, **A → H**, ordered by dependency. Track B (deterministic SL tools) ships first; Track C (orchestrator + scheduler) ships behind a flag and is rolled out trigger-by-trigger per the spec's migration path (§Migration).

| Phase | Theme | Effort | Track | Blocks |
|---|---|---|---|---|
| **A** | Schema migration + repos for `skill_revisions` (already in Drizzle, no live migration) + git helpers | 0.5 d | B | B–E |
| **B** | Track B read-only tools: `skill_health_report`, `skill_audit_unused`, `skill_inspect_history`, `skill_validate_definition` | 1 d | B | F |
| **C** | Track B write tools: `skill_register`, `skill_update`, `skill_deprecate` (fs + DB + git, atomic rollback) | 2 d | B | E, F |
| **D** | Backfill `skill_revisions` for existing `.arceus/skills-seed/*` skills + tag `skill-evolve/<id>/1` | 0.5 d | B | F |
| **E** | Track C scheduler skeleton + `skill_evolve_jobs` worker loop (no triggers wired yet) | 1.5 d | C | F, G |
| **F** | `runATAPipeline()` composition over the 8 existing primitives + delegation-task creation | 2 d | C | G, H |
| **G** | Triggers: candidate submit (opt-in) → cron → EMA-drop, in that order, each behind a sub-flag | 1.5 d | C | H |
| **H** | Post-deploy EMA monitor + rollback short-circuit + flap protection | 1 d | C | — |

**Aggregate effort:** ~10 d single-threaded; ~6 d if Track B and Track C scheduler skeleton run in parallel after Phase A.

**Feature flags (all default off):**
- `ARCEUS_SKILL_EVOLVE_ORCHESTRATOR=1` — master flag; without it nothing in Phases E–H runs.
- `ARCEUS_SKILL_EVOLVE_TRIGGER_CANDIDATE=1` — enable §C.1 candidate trigger.
- `ARCEUS_SKILL_EVOLVE_TRIGGER_CRON=1` — enable nightly cron trigger.
- `ARCEUS_SKILL_EVOLVE_TRIGGER_EMA=1` — enable EMA-drop trigger.
- `ARCEUS_SKILL_EVOLVE_MONITOR=1` — enable post-deploy monitor.

**Backward risk:** Track B is additive (new tools, new table, no edits to existing skill paths). Track C is fully flag-gated; with no flags set the scheduler does not start.

---

## 1. Phase A — Schema + git helpers

### A.1 Verify schema coverage (no live migration)

`packages/db/src/schema/skill_revisions.ts` already exists (uuid id, fk → `skill_artifacts`, `revision_number`, `git_tag` UNIQUE, `git_sha`, `applied_by`, `proposal_id`, `rollback_from_tag`, `summary`, indexes). Same for [`skill_evolve_jobs.ts`](../../packages/db/src/schema/skill_evolve_jobs.ts). The repos in [`packages/db/src/repos/skill_revisions.ts`](../../packages/db/src/repos/skill_revisions.ts) and [`packages/db/src/repos/skill_evolve_jobs.ts`](../../packages/db/src/repos/skill_evolve_jobs.ts) cover the queries this spec needs.

**Action:**
- Confirm `skill_revisions` is in the next Drizzle migration the team runs against staging. If not yet applied, add the `npm run db:generate` output and the run-migration script (`packages/db/migrations/run-008.ts` or whatever is next).
- Add a tiny repo helper `findRevisionByGitTag(db, tag)` and `latestRevisionForSkill(db, skillId)` if not already present (used by C.7 / H rollback monitor).

### A.2 Git helpers

New file `apps/api/src/skills/git.ts`. Pure shell-out wrappers around `git` (already on PATH; the API process runs in the repo root). Each helper takes only the workspace-relative arguments it needs and returns typed output.

```typescript
export async function gitCommitFiles(opts: { paths: string[]; message: string }): Promise<{ sha: string }>;
export async function gitTag(opts: { tag: string; sha: string; message: string }): Promise<void>;
export async function gitShowFileAtTag(opts: { tag: string; path: string }): Promise<string>;
export async function gitListTagsMatching(opts: { pattern: string }): Promise<string[]>;
export async function gitDeleteTag(opts: { tag: string }): Promise<void>;  // for atomic rollback in C
```

All commands run via `child_process.execFile("git", [...])` with `cwd = repo root`. Errors throw a tagged `GitError`. Tags are local-only in dev; in prod the deploy job pushes `--tags` after the API publishes. (Spec 29 does not require tag push — that's an ops concern.)

**Tests:** unit-level integration test that creates a temp git repo, calls each helper, asserts behavior. Lives in `apps/api/src/skills/git.test.ts`.

### A.3 Idempotent skill-revisions writer

New helper in `apps/api/src/skills/revisions.ts`:

```typescript
export async function writeRevisionAtomic(args: {
  skillId: string;
  content: string;          // SKILL.md body
  intent: "register" | "update" | "deprecate";
  appliedBy: string;
  proposalId?: string;
  rollbackFromTag?: string;
  summary: string;
}): Promise<{ revisionNumber: number; gitTag: string; gitSha: string }>;
```

Steps (in order, each rollback-safe):
1. Compute `revisionNumber = (latestRevisionForSkill(skillId)?.revisionNumber ?? 0) + 1`.
2. Compute `gitTag` (`skill-evolve/<id>/<n>` or `skill-deprecated/<id>` for deprecate).
3. Write `<repo>/.arceus/skills-seed/<id>/SKILL.md` (skip for deprecate). Capture prior content for rollback.
4. `gitCommitFiles({ paths: [...], message: summary })` → `sha`.
5. INSERT `skill_revisions` row (UNIQUE on `git_tag` is the idempotency anchor).
6. `gitTag({ tag, sha, message: summary })`.
7. On any step ≥ 4 failing: `git reset --hard HEAD~1` (only if the commit was created and DB insert failed), restore prior file contents, delete the tag if it was created, return error.

Returns the canonical row. Used by C.5–C.7 (skill_register / update / deprecate). **No LLM in this path.**

**Exit criterion:** Atomic-write test covering: commit-only failure rolls back the file; DB-only failure rolls back the commit; tag-only failure rolls back DB row + commit. Verified via temp git repo + sqlite mock or real Drizzle against a test DB.

---

## 2. Phase B — Track B read-only tools

Four tools, all SL-allowlisted (read-only ones also CEO-allowlisted per spec §B.1–B.4). One file: `apps/api/src/routes/internal-mcp/skills.routes.ts`. Register in [`apps/api/src/routes/internal-mcp/index.ts`](../../apps/api/src/routes/internal-mcp/index.ts) alongside the existing route modules.

| Tool | Route | Backed by |
|---|---|---|
| `skill_health_report` | `POST /internal-mcp/skills/health` | SQL aggregate over `skill_usage_events` joined with the registry's in-memory state (or DB rows if `ARCEUS_SKILLS_DB_WRITETHROUGH=1`) |
| `skill_audit_unused` | `POST /internal-mcp/skills/audit-unused` | `getUnusedSkills` from `@arceus/company-runtime` extended with `skill_usage_events` lookback |
| `skill_inspect_history` | `POST /internal-mcp/skills/history` | `skill_revisions` table + `gitListTagsMatching("skill-evolve/<id>/*")` cross-check |
| `skill_validate_definition` | `POST /internal-mcp/skills/validate` | `parseSkillFrontmatter` (already in `skill-registry.ts`) + `getSkillById` for collision check. Pure function — no fs, no DB writes. |

All four use the existing envelope helper [`apps/api/src/routes/internal-mcp/envelope.ts`](../../apps/api/src/routes/internal-mcp/envelope.ts) and the role-allowlist middleware ([`middleware.ts`](../../apps/api/src/routes/internal-mcp/middleware.ts)).

### B.1 EMA computation

The spec uses "EMA" loosely — the registry already maintains a per-skill EMA (`successRate`, lr=0.15) in `skill-registry.ts:updateSuccessRate`. For `skill_health_report` we report:
- `ema` = current `successRate` from registry (already EMA-style).
- `invocations` = count from `skill_usage_events` in window.
- `failureRate` = `1 - ema` (proxy; precise breakdown awaits Spec 32 trace data).
- `trend` = compare current `ema` to `ema` at `windowStart` using the snapshot in the most recent `skill_revisions.summary` (revision summary will record `emaAtApply` as JSON in `summary` going forward — ok to start `null` and backfill in D).

No new EMA math. Reuse the registry.

### B.2 MCP wrappers

In `packages/arceus-mcp/src/tools/skill.ts` (NEW), register the 4 tools mirroring the routes. Schemas exactly match §B.1–B.4 in the spec. Per-role allowlist edits in [`.opencode/agent/config.ts`](../../.opencode/agent/config.ts) — add to `skills_lead.tools` and the read-only three to `ceo.tools`. Add to `ALL_ARCEUS_TOOLS`.

**Exit criterion:** Each tool callable from a SL agent session via integration test (`apps/api/src/routes/internal-mcp/skills.test.ts`); CEO can call the three read-only ones; other roles get governance-denied.

---

## 3. Phase C — Track B write tools

Three tools sharing `writeRevisionAtomic` from A.3. One additional route file (extending `skills.routes.ts`).

| Tool | Route | Notes |
|---|---|---|
| `skill_register` | `POST /internal-mcp/skills/register` | Refuses if `skillId` exists. Always revision 1. |
| `skill_update` | `POST /internal-mcp/skills/update` | Refuses if `skillId` does not exist. `rollbackFromTag` is informational only (recorded in row). |
| `skill_deprecate` | `POST /internal-mcp/skills/deprecate` | Updates `skill_artifacts.status='deprecated'`, writes a `skill-deprecated/<id>` tag (DB row only — no SKILL.md change). |

**Idempotency.** All three use the existing [`idempotency.ts`](../../apps/api/src/routes/internal-mcp/idempotency.ts) middleware. Plus a defense-in-depth: the UNIQUE constraint on `skill_revisions.git_tag` catches double-applies that slip past idempotency (same revisionNumber → same tag → constraint error → return last successful envelope).

**Registry coherence.** After a successful `skill_register` / `skill_update`, call `registerSkill(...)` (which fires `onSkillUpserted` and — if `ARCEUS_SKILLS_DB_WRITETHROUGH=1` — propagates to `skill_artifacts`). After `skill_deprecate`, call `deprecateSkill(skillId, reason)`. This keeps the in-memory store and the DB write-through path consistent with the new revision.

**MCP wrappers + allowlist.** Same pattern as Phase B — extend `skill.ts` in `packages/arceus-mcp/src/tools/`, add to `skills_lead.tools` only.

**Exit criteria (mirrors spec §B.5–B.7 + Acceptance §B.1–B.7):**
1. Duplicate `skillId` on `skill_register` → `id_collision`, no fs/DB writes.
2. Missing `skillId` on `skill_update` → `skill_not_found`, no writes.
3. Each successful write produces exactly one git tag and one `skill_revisions` row.
4. `skill_update(rollbackFromTag=...)` with content from `gitShowFileAtTag(...)` produces a new revision whose SKILL.md byte-equals the prior tag's file.
5. Non-SL roles rejected by governance.

---

## 4. Phase D — Backfill existing skills

One-shot migration script: `scripts/backfill-skill-revisions.ts`.

For each directory under `.arceus/skills-seed/`:
1. If a `skill_revisions` row already exists for this skill → skip.
2. Look up the `skill_artifacts.id` (via `skill_artifacts.slug = <dir name>`); if absent, skip with a warning.
3. Compute the latest commit SHA touching `<dir>/SKILL.md` via `git log -1 --format=%H -- <path>`.
4. INSERT `skill_revisions` row: `revision_number=1`, `git_tag="skill-evolve/<id>/1"`, `git_sha=<sha>`, `applied_by="seed"`, `summary="seed: initial revision"`.
5. Create the git tag pointing at the current `HEAD` (or the historical commit, configurable). Default: `HEAD` so future post-deploy monitoring has a real baseline timestamp.

**Idempotent.** Re-runs are safe — UNIQUE on `git_tag` blocks dupes.

**Run once in staging, once in prod, before Phase G enables triggers.** Documented as a post-deploy step in the migration runbook.

---

## 5. Phase E — Track C scheduler skeleton + worker loop

New file: `apps/api/src/skills/scheduler.ts`. Behind `ARCEUS_SKILL_EVOLVE_ORCHESTRATOR=1`. Without the flag, `startSkillScheduler()` is a no-op.

### E.1 Worker loop

`startSkillScheduler()`:
1. Schedule a `setInterval(tick, 60_000)` (1-minute tick).
2. On each tick:
   - **Trigger evaluation** (Phase G) — gated by sub-flags, runs first; skipped entirely until Phase G.
   - **Job lease + run.** `leaseOne(db, { workerId, maxAttempts: 3 })` (already exists in `skill_evolve_jobs.ts` repo). If a row is returned, run `runATAPipeline(job)` (Phase F). Wrap in try/catch — on success call `completeJob(...)`, on failure call `failJob(...)` with the error message.
3. On API shutdown: clear the interval; let in-flight pipeline call finish (await with a 30 s drain).

**Concurrency:** one worker per API process, one job per tick. Volume estimate: <100 jobs/day (per spec §C.2). `FOR UPDATE SKIP LOCKED` already in `leaseOne` makes multi-process safe even if we scale out later.

### E.2 Lifecycle hook

Wire `startSkillScheduler()` from [`apps/api/src/server.ts`](../../apps/api/src/server.ts) right after `initSkillEvolution()`. Add a matching `stopSkillScheduler()` call in the existing graceful-shutdown handler.

### E.3 No-pipeline stub

For Phase E only, `runATAPipeline(job)` is a stub that just records `result: { stub: true }` and returns `{ status: "stubbed" }`. Phase F replaces it.

**Exit criterion:** With the master flag on but no triggers wired, the scheduler runs every minute, finds no jobs, no errors. Inserting a job manually into `skill_evolve_jobs` causes the worker to lease it, mark it done, log the stub.

---

## 6. Phase F — `runATAPipeline()` orchestrator

New file: `apps/api/src/skills/orchestrator.ts`. Replaces the stub from Phase E.

### F.1 Composition

The 8 primitives already exist in `apps/api/src/skills/evolution.ts` (lines 447–565: `analyzeFailure`, `proposeSkillMutation`, `proposeSkillDiscovery`, `generateTestScenarios`, `executeDryRun`, `reviewResults`, `reviseSkill`, `synthesizeSkill`). Each is its own `structuredCompletion` call wired via `setSkillMutatorDeps`/`setSkillTesterDeps`/`setPatternLearnerDeps`. **Information isolation is already structurally enforced** — we do not need to refactor the primitives.

The orchestrator is purely composition (mirrors spec §C.3 pseudocode):

```typescript
export async function runATAPipeline(job: SkillEvolveJob): Promise<PipelineResult> {
  if (job.trigger === "rollback") return runRollbackShortCircuit(job);   // Phase H

  const attribution = await analyzeFailure({ ... });
  const proposal = job.targetSkillId
    ? await proposeSkillMutation({ skillId: job.targetSkillId, attribution })
    : await proposeSkillDiscovery({ ... });
  const scenarios = await generateTestScenarios({ proposedContent: proposal.content });
  const results   = await executeDryRun({ proposedContent: proposal.content, scenarios });
  const review    = await reviewResults({ proposedContent: proposal.content, scenarios, results });

  if (review.gate === "reject") return { status: "rejected", audit: review };

  let finalContent = proposal.content;
  if (review.gate === "needs_revision") {
    finalContent = (await reviseSkill({ originalContent: proposal.content, review })).content;
  }
  const synthesis = await synthesizeSkill({ skillId: job.targetSkillId, content: finalContent });

  const artifactId = await createHandoffArtifact({ ... });
  await createTask({ assignedRole: "skills_lead", kind: "skill_apply_proposal", relatedArtifactIds: [artifactId], description: synthesis.summary });

  return { status: "accepted", proposalId: job.id, artifactId };
}
```

### F.2 Information-isolation contract

Each `await` is a separate function call with its own typed input. The reviewer (`reviewResults`) receives only `{ proposedContent, scenarios, results }` — the orchestrator does not pass `attribution` or the original mutation prompt. Spec §C.3 calls for a golden-input test that proves this; implement as: feed a `proposedContent` whose validity depends on a fact only present in the attribution prompt. The reviewer should reject it (no information leak). If that test passes today (it should, given current isolation), check it in to lock the behavior.

### F.3 Delegation task creation

Use existing helpers — `artifact_create` route logic for handoff artifacts and `task_create` for the SL task. Both already write through `replaceState` and have sync-DB paths from Spec 28 Phase B. No new persistence code.

The task `kind` is `skill_apply_proposal` (new constant). Add to the kind enum if it lives in `@arceus/contracts`; otherwise it's just a string and SL's prompt + the SL agent's checklist handler dispatch on it.

### F.4 SL action-prefix dispatch

The SL agent already has an action-prefix dispatcher in [`apps/api/src/heartbeats/checklist-executor.ts`](../../apps/api/src/heartbeats/checklist-executor.ts) (`skills_lead:mutate_underperformer`). Add a parallel handler for `skills_lead:apply_proposal` that:
1. Reads the proposal artifact via `artifact_get`.
2. Calls `skill_validate_definition`.
3. If valid, calls `skill_update` (or `skill_register` if `intent=create`).

The dispatcher already routes by action prefix from the orchestrator's checklist. The orchestrator builds the checklist from the open `skill_apply_proposal` task. No new orchestrator branching.

**Exit criteria (mirrors spec Acceptance §C.2–§C.5):**
- Mutation trigger calls all 8 primitives in order.
- Candidate trigger skips `proposeSkillMutation` and uses `proposeSkillDiscovery`.
- Golden-input test for ROA isolation passes.
- Accepted → exactly one delegation task + one handoff artifact.
- Rejected → no task, no artifact, `denseReasoning` recorded in `skill_evolve_jobs.result`.

---

## 7. Phase G — Triggers (rolled out one at a time)

### G.1 Candidate submit (first, lowest risk)

New MCP tool `skill_candidate_submit` (allowlisted to all roles per spec §Tool surface). Route `POST /internal-mcp/skills/candidate-submit`. Body: `{ description, motivation }`. Action: `enqueueJob(db, { trigger: "candidate", targetSkillId: null, payload: { description, motivation } })`. Behind `ARCEUS_SKILL_EVOLVE_TRIGGER_CANDIDATE=1`.

**Validate end-to-end manually before enabling next trigger.** Submit a candidate, watch the worker pick it up, see the SL delegation task land.

### G.2 Nightly cron (second)

In `scheduler.ts:tick`, when `now().UTC().hour === 3 && minute < 1` and `ARCEUS_SKILL_EVOLVE_TRIGGER_CRON=1`:

```sql
SELECT id FROM skill_artifacts
WHERE status='active'
  AND id NOT IN (SELECT target_skill_id FROM skill_evolve_jobs
                 WHERE created_at > now() - interval '24 hours' AND target_skill_id IS NOT NULL)
  AND id IN (SELECT skill_id FROM skill_usage_events
             WHERE occurred_at > now() - interval '24 hours'
             GROUP BY skill_id
             HAVING count(*) >= 20 AND avg(CASE WHEN outcome='success' THEN 1.0 ELSE 0.0 END) <= 0.7);
```

For each row, `enqueueJob({ trigger: "cron", targetSkillId: id, payload: { window: "24h" } })`.

**Dedup** — the `NOT IN (... last 24h)` clause is the dedup. Single source of truth.

### G.3 EMA-drop (last)

After each beat in [`apps/api/src/orchestration/run-beat.ts`](../../apps/api/src/orchestration/run-beat.ts) finishes the existing Pass-1 `updateSuccessRate(...)` loop, also evaluate per-skill EMA-drop:

```typescript
if (process.env.ARCEUS_SKILL_EVOLVE_TRIGGER_EMA === "1") {
  for (const skillId of usedSkills) {
    const skill = getSkillById(skillId);
    const baseline = await getRevisionBaselineEma(skillId);  // ema at most recent revision
    if (skill && baseline != null && skill.successRate < baseline - 0.15 && skill.usageCount >= 10) {
      await maybeEnqueueEvolveJob({ trigger: "ema_drop", targetSkillId: skillId });
    }
  }
}
```

`maybeEnqueueEvolveJob` does the `(skillId, trigger)` dedup against the `skill_evolve_jobs` table (no active/pending row for this pair). `getRevisionBaselineEma` reads the JSON `summary` of the most recent `skill_revisions` row for this skill (recorded at apply time in Phase C).

**Backfill caveat:** for skills seeded in Phase D, the seed row's `summary` won't have `emaAtApply`. Treat null baseline as "use registry seed default 0.7" so the EMA-drop trigger has a sensible floor for legacy skills until they get their first real revision.

**Exit criteria (spec Acceptance §C.1):** EMA drop fires once per `(skillId, trigger)` pair until that job completes. Verify via integration test that two consecutive triggering beats produce only one queued job.

---

## 8. Phase H — Post-deploy EMA monitor + rollback

### H.1 Monitor

Inside `scheduler.ts:tick`, when `ARCEUS_SKILL_EVOLVE_MONITOR=1`:

```sql
SELECT skill_id, MAX(revision_number) AS rev, MAX(created_at) AS applied_at
FROM skill_revisions
WHERE created_at > now() - interval '24 hours'
  AND rollback_from_tag IS NULL
GROUP BY skill_id;
```

For each row:
1. Compute `invocationsSince = COUNT(skill_usage_events WHERE skill_id=$1 AND occurred_at > applied_at)`.
2. If `invocationsSince < 20` → skip (not enough signal yet).
3. Compute `currentEma` (registry `successRate`).
4. Read `baselineEma` from this row's prior revision summary; if missing, use 0.7.
5. If `currentEma < baselineEma - 0.10` → enqueue rollback job: `enqueueJob({ trigger: "rollback", targetSkillId, payload: { fromTag: <prior tag>, applied_at } })`.

**Already-monitored guard:** the same `(skillId, trigger="rollback")` dedup applies — at most one active rollback job per skill at a time.

### H.2 Rollback short-circuit in `runATAPipeline`

```typescript
async function runRollbackShortCircuit(job: SkillEvolveJob): Promise<PipelineResult> {
  const fromTag = job.payload.fromTag as string;
  const path = `.arceus/skills-seed/${slugFor(job.targetSkillId!)}/SKILL.md`;
  const priorContent = await gitShowFileAtTag({ tag: fromTag, path });
  const artifactId = await createHandoffArtifact({
    title: `Rollback proposal: ${job.targetSkillId}`,
    content: priorContent,
    metadata: { proposalId: job.id, rollbackFromTag: fromTag },
  });
  await createTask({
    assignedRole: "skills_lead",
    kind: "skill_apply_rollback",
    relatedArtifactIds: [artifactId],
    description: `Rollback ${job.targetSkillId} to ${fromTag} after EMA regression`,
  });
  return { status: "rollback_proposed", proposalId: job.id, artifactId };
}
```

Zero LLM calls. SL still gates the application — when SL beats run the dispatcher routes `skill_apply_rollback` to a handler that calls `skill_update` with the prior content and `rollbackFromTag=fromTag`.

### H.3 Flap protection

Add to `skill_health_report`: a per-skill `rollbackCount7d` field. When > 1, scheduler **does not** auto-enqueue further rollback jobs for that skill (manual only). Logged in the report so SL sees it. Implementation: count `skill_revisions WHERE rollback_from_tag IS NOT NULL AND skill_id=$1 AND created_at > now() - 7d`.

**Exit criteria (spec Acceptance §C.6–§C.8):**
- One rollback job per revision, only after ≥20 invocations.
- Worker crash mid-pipeline → job re-leases, attempts increments, succeeds or fails after 3.
- Skill rolled back twice in 7 days → visible in `skill_health_report` with `trend="falling"`, no auto-rollback enqueued.

---

## 9. Cross-cutting concerns

### 9.1 Governance

All new MCP tools go through the existing `service-registry.ts` allowlist + `governance-gateway.ts` policy check. No new policy rules required — the role-allowlist is the gate.

### 9.2 Telemetry

Each Track C primitive call already emits via `structuredCompletion`'s usage hook. Add scheduler-level logs (`[SkillScheduler] tick`, `[SkillScheduler] leased job <id>`, `[SkillPipeline] gate=accept|reject|needs_revision`) and one `emitEmployeeActivity("skills_lead", "context", ...)` per delegation task created.

### 9.3 Observability hooks (Spec 32)

The OTEL sink shipped on this branch (commits `cf276d5`, `0cf74cf`) already wraps `structuredCompletion`. The 8 primitives + the orchestrator inherit it for free. Add a span around `runATAPipeline` itself so the per-job total is visible alongside the per-primitive spans.

### 9.4 Security

- Git operations run as the API process user against the local checkout. They never push (push is an ops concern). No remote network exposure.
- `skill_validate_definition` parses untrusted content; the existing frontmatter parser uses `js-yaml` `SAFE_SCHEMA`-equivalent tokens (no JS exec). Re-verify when reading the skill registry parser.
- `skill_update` with `rollbackFromTag` reads file content from a git ref **only** to copy to a new revision. The tool itself does not exec the SKILL.md content.

### 9.5 Tests

| Phase | Test file | Coverage |
|---|---|---|
| A | `apps/api/src/skills/git.test.ts` | git helper round-trip on temp repo |
| A | `apps/api/src/skills/revisions.test.ts` | `writeRevisionAtomic` rollback cases |
| B | `apps/api/src/routes/internal-mcp/skills.read.test.ts` | 4 read-only tools, role-allowlist denials |
| C | `apps/api/src/routes/internal-mcp/skills.write.test.ts` | register/update/deprecate, idempotency, collision, atomic rollback |
| D | manual run + assertion that `skill_revisions` row count == seed-skill directory count |
| E | `apps/api/src/skills/scheduler.test.ts` | tick lifecycle, lease+complete, lease+fail, drain on shutdown |
| F | `apps/api/src/skills/orchestrator.test.ts` | 8-primitive sequence (mocked LLM), reject path, accept path, candidate path, ROA isolation golden-input |
| G | `apps/api/src/skills/triggers.test.ts` | candidate dedup, cron dedup, EMA-drop dedup |
| H | `apps/api/src/skills/monitor.test.ts` | rollback enqueued at threshold, flap-protection blocks 2nd rollback |

All tests use `node --import tsx --test` (per project convention; npx is unreliable on Windows per user memory).

---

## 10. Migration runbook

Aligns with spec §Migration path. Per-step:

1. **Phase A–C → ship.** Track B tools available in production. SL can author/edit skills via the new tools manually. No orchestrator yet.
2. **Phase D → run backfill** in staging then prod. `scripts/backfill-skill-revisions.ts`. Verify each skill has a row + tag.
3. **Phase E + F → ship behind `ARCEUS_SKILL_EVOLVE_ORCHESTRATOR=1` (off by default).** No triggers wired yet. Smoke-test by manually inserting a candidate job: `INSERT INTO skill_evolve_jobs (trigger, target_skill_id, payload, status) VALUES ('candidate', null, '{"description":"test"}', 'pending');`. Confirm the worker leases it, the pipeline runs, an SL task lands.
4. **Phase G.1 → enable `ARCEUS_SKILL_EVOLVE_TRIGGER_CANDIDATE=1`** in staging. Have one role submit a candidate. Validate the SL flow end-to-end. Promote to prod.
5. **Phase G.2 → enable `ARCEUS_SKILL_EVOLVE_TRIGGER_CRON=1`.** Let it run a week. Confirm it produces ≤ N proposals and SL actions them. Promote.
6. **Phase G.3 → enable `ARCEUS_SKILL_EVOLVE_TRIGGER_EMA=1`** with the spec's conservative thresholds (drop 0.15, 10 invocations). Tune from telemetry.
7. **Phase H → enable `ARCEUS_SKILL_EVOLVE_MONITOR=1`** once the EMA-drop trigger has a clean baseline week.

Rollback at any step = unset the flag. No data migration is destructive.

---

## 11. Out of scope (per spec §Out of scope)

- SL reasoning over proposals. The SL agent's apply-or-reject decision is a Spec 13 governance concern.
- Cross-skill refactors. Each job targets at most one skill; multi-skill proposals are rejected at `reviewResults`.
- Skill `includes:` / composition graphs.
- Automatic rollback application (SL still gates rollback proposals).
- Pushing git tags to a remote — ops concern, not in this spec.

---

## 12. Open questions

1. **Per-skill EMA-baseline storage.** Plan stores baseline EMA in `skill_revisions.summary` JSON. Alternative: add a typed column `baseline_ema numeric(5,4)` in a follow-up migration. Decision: go with JSON-in-summary for v1 to avoid a second migration; revisit if querying becomes painful.
2. **Where does `slugFor(skillId)` live?** Today the registry uses `name` as the directory name and `id = "skill-<name>-v1"` for seeds. Need a single helper used by `materializeBeatSkills`, the backfill script, and the rollback short-circuit. Place in `packages/company-runtime/src/skill-paths.ts` and export.
3. **One-process-only worker.** Current plan is one worker per API node. If we ever run >1 API replica, the `FOR UPDATE SKIP LOCKED` lease is correct but we'll want a worker-id heartbeat to detect stuck claims. Defer until we actually run multi-replica.
4. **Stub for `skill_evolve_jobs.payload` schema.** Each trigger uses different keys (`window`, `description`, `motivation`, `fromTag`). Define a discriminated union in `packages/contracts/src/skills.ts` to keep the worker type-safe rather than `Record<string, unknown>`.

---

## 13. Acceptance summary mapping

Spec acceptance criterion → implementation phase:

| Spec §B.1–B.7 | Phase B + C |
| Spec §C.1 EMA fires once per pair | Phase G.3 |
| Spec §C.2 8 primitives in order; discovery for candidate | Phase F.1 |
| Spec §C.3 ROA isolation golden-input | Phase F.2 |
| Spec §C.4 accepted → 1 task + 1 artifact | Phase F.3 |
| Spec §C.5 rejected → no task, denseReasoning recorded | Phase F.1 / F.3 |
| Spec §C.6 ≤ 1 rollback job per revision, ≥ 20 invocations | Phase H.1 |
| Spec §C.7 worker crash → re-lease + max 3 attempts | Phase E.1 |
| Spec §C.8 2× rollback in 7d → visible, no auto-enqueue | Phase H.3 |
