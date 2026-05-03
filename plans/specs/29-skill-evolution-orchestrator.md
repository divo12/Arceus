# Spec 29: Skill Evolution Orchestrator & Skills-Lead Tools

> **Status:** DRAFT v1
> **Last updated:** 2026-04-24
> **Depends on:**
> - Spec 14 (Self-Evolution — the 8 ATA primitives, already migrated to `structuredCompletion` in Track A)
> - Spec 23 (Skill-Tool Integration — progressive-disclosure catalog, skill_usage metrics)
> - Spec 26/27 (Tool catalog & allowlists — MCP registration pattern)
> - Spec 13 (Policy governance — idempotency, envelope, error causes)
> - Hippocampus (skill_usage + beat_outcomes streams)
> **Enables:** Continuous skill improvement without human-in-the-loop gating every change; auto-rollback on regression.
> **Replaces:** Ad-hoc `initSkillEvolution()` lambda wiring; manual-only skill authoring.

---

## What This Is

The 8 ATA primitives (Attribute, Mutation, Discovery, TGA, EAA, ROA, Revision, Synthesis) are already cleaned up in Track A — each is an isolated `structuredCompletion` call with its own schema and system prompt. **They are not wired into anything.** Today nothing triggers them, nothing composes them into a pipeline, and the Skills-Lead (SL) role has no governed way to apply or roll back skill changes.

This spec closes both gaps:

- **Track B** — 7 deterministic MCP tools for SL to **apply, inspect, and roll back** skill changes. No LLM inside these tools. Pure DB + filesystem + git.
- **Track C** — a **scheduler + job queue + orchestrator** that composes the 8 Track A primitives into a full ATA pipeline, runs it on triggers (EMA drop, cron, explicit candidate), and hands accepted proposals to SL as delegation tasks.

Together: C **proposes**, B **disposes**. Two tracks, one loop, zero LLM logic in the write path.

---

## Why This Matters

```
WITHOUT Track B+C:
  The 8 ATA primitives exist but nothing calls them.
  Skills are authored manually. Skills-Lead edits SKILL.md files by hand.
  A skill that regresses stays live until someone notices and rewrites it.
  No rollback path — just more manual edits layered on top.

WITH Track B+C:
  EMA drop on skill X → scheduler enqueues evolve job → ATA pipeline proposes
  a revision with test evidence → two-tier ROA gate decides accept/revise/reject
  → SL gets a delegation task with the proposal → SL validates + applies via
  skill_update → git tag marks the revision → post-deploy monitor watches the
  skill's EMA for N beats → auto-rollback to prior git tag if EMA drops again.

  Propose and dispose are structurally separate. Rollback is git, not another
  LLM pipeline. SL never reasons about deltas — it validates and applies.
```

---

## System Architecture

### Separation of concerns

| Layer | Writes? | LLM? | Trigger |
|-------|---------|------|---------|
| **Track A** (done) | No | Yes (8 isolated calls) | Called by Track C orchestrator |
| **Track B** (this spec) | Yes (fs + db + git) | No | SL role (manual or via delegation task) |
| **Track C** (this spec) | Queue + delegation task only | Yes (via Track A primitives) | Scheduler (EMA / cron / candidate submit) |

**The rule:** Track C never writes to `.arceus/skills-seed/`, never updates the `skills` table, never tags git. It proposes — and proposals are delivered as delegation tasks + handoff artifacts. Track B is the only path that mutates skill state. This split is what makes rollback safe: every write is an SL-called tool, every SL tool tags git.

### Information isolation (inherited from Track A)

Each of the 8 ATA primitives is a fresh `structuredCompletion` with only the inputs its schema requires. The ROA reviewer never sees the mutation prompt's raw intent — only the proposed diff + test scenarios + EAA results. This is enforced structurally: different functions, different prompts, no shared conversation context. Track C's orchestrator composes them in sequence but does not collapse them into one agent session.

### End-to-end loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AGENT BEAT (any role)                       │
│   invokes skill → outcome recorded → skill_usage + beat_outcomes    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ metrics stream
                             ▼
           ┌─────────────────────────────────────┐
           │  Track C: SCHEDULER                 │
           │  ┌─────────┐ ┌────────┐ ┌─────────┐ │
           │  │ EMA drop│ │ nightly│ │candidate│ │
           │  │ trigger │ │  cron  │ │ submit  │ │
           │  └────┬────┘ └───┬────┘ └────┬────┘ │
           └───────┼──────────┼───────────┼──────┘
                   └──────────┼───────────┘
                              ▼
                   ┌──────────────────────┐
                   │ skill_evolve_jobs    │  ← pg queue
                   │   (FOR UPDATE SKIP)  │
                   └──────────┬───────────┘
                              │ worker lease
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │           runATAPipeline() — information-isolated           │
  │                                                             │
  │  analyzeFailure ──► proposeMutation/Discovery ──► TGA       │
  │                                                   │         │
  │                                                   ▼         │
  │                                                  EAA        │
  │                                                   │         │
  │                                          ┌────────▼──────┐  │
  │                                          │ ROA two-tier  │  │
  │                                          │ dense+sparse  │  │
  │                                          └──┬───────┬────┘  │
  │                              reject ◄───────┘       │       │
  │                              needs_revision ─► reviseSkill  │
  │                              accept ─► synthesizeSkill      │
  └────────────────────────────────┬────────────────────────────┘
                                   │ accepted proposal
                                   ▼
              ┌────────────────────────────────────┐
              │ create delegation task             │
              │ assignedRole=skills_lead           │
              │ artifact kind=handoff (proposal)   │
              └────────────────┬───────────────────┘
                               │ next SL beat
                               ▼
    ┌──────────────────────────────────────────────────────┐
    │  SKILLS_LEAD ROLE — uses Track B §7 tools            │
    │                                                      │
    │  skill_inspect_history → skill_validate_definition   │
    │                                 │                    │
    │                                 ▼                    │
    │     skill_register | skill_update | skill_deprecate  │
    │                                 │                    │
    │                                 ▼                    │
    │             git tag skill-evolve/<id>/<n>            │
    └─────────────────────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌───────────────────────────────────┐
                  │ POST-DEPLOY EMA MONITOR (cron)    │
                  │ watch N beats vs baseline         │
                  └──────┬────────────────────┬───────┘
                         │ healthy            │ EMA drop
                         ▼                    ▼
                    (done)          enqueue rollback job
                                    → skill_update(prior tag)
```

### How a skill's lifecycle looks after this spec lands

1. Author or accept — skill enters via `skill_register` (manual) or delegation task from Track C (automated). Either path tags `skill-evolve/<id>/1`.
2. Use — agents invoke via progressive-disclosure catalog (Spec 23). Each invocation writes `skill_usage` and rolls into the per-skill EMA.
3. Regress — EMA drops below threshold. Scheduler enqueues an evolve job targeting this skill.
4. Evolve — ATA pipeline produces a proposal. ROA gate decides. Accepted → SL delegation task.
5. Apply — SL validates with `skill_validate_definition`, applies with `skill_update`. New git tag `skill-evolve/<id>/<n+1>`.
6. Monitor — post-deploy monitor watches EMA for N beats.
7. Rollback or settle — EMA drop → auto-rollback job uses `skill_update` with content from prior tag. No LLM in the rollback path.

---

## Track B — Skills-Lead Deterministic Tools

Seven MCP tools. All SL-allowlisted (plus read-only ones available to CEO for audits). No LLM inside any of them. They validate, write, and tag — nothing else.

### B.1 `skill_health_report` (read-only)

**Purpose:** summary stats across all skills. SL and CEO use this to decide where evolution is needed.

**Wraps:** SQL aggregation over `skill_usage` joined with `beat_outcomes`.

**Input:**
```typescript
{
  role?: Role,              // filter to one role's skills
  since?: ISO8601,          // default: 7 days ago
  minInvocations?: number,  // default: 3 (hide never-used)
}
```

**Output data:**
```typescript
{
  skills: Array<{
    skillId: string,
    role: Role,
    invocations: number,
    ema: number,              // 0..1 success rate, exponentially-weighted
    failureRate: number,
    lastUsedAt: ISO8601,
    trend: "rising" | "stable" | "falling",
  }>,
  windowStart: ISO8601,
  windowEnd: ISO8601,
}
```

**Allowlist:** `skills_lead`, `ceo`.

### B.2 `skill_audit_unused` (read-only)

**Purpose:** find skills that haven't been invoked recently — deprecation candidates.

**Wraps:** SQL `WHERE skill_id NOT IN (SELECT skill_id FROM skill_usage WHERE created_at > now() - interval $1)`.

**Input:**
```typescript
{ staleDays?: number }  // default: 30
```

**Output data:**
```typescript
{
  staleSkills: Array<{
    skillId: string,
    role: Role,
    lastUsedAt: ISO8601 | null,
    registeredAt: ISO8601,
  }>,
}
```

**Allowlist:** `skills_lead`, `ceo`.

### B.3 `skill_inspect_history` (read-only)

**Purpose:** show the revision timeline of a specific skill — who changed it, when, why, which proposal.

**Wraps:** `git log .arceus/skills-seed/<skillId>/` plus the `skill_revisions` table.

**Input:**
```typescript
{ skillId: string }
```

**Output data:**
```typescript
{
  skillId: string,
  revisions: Array<{
    revisionNumber: number,
    gitTag: string,             // "skill-evolve/<skillId>/<n>"
    gitSha: string,
    appliedBy: string,          // SL session id or "manual"
    appliedAt: ISO8601,
    proposalId: string | null,  // Track C job id if auto-proposed
    summary: string,            // commit message first line
  }>,
}
```

**Allowlist:** `skills_lead`, `ceo`.

### B.4 `skill_validate_definition` (dry-run, read-only)

**Purpose:** before applying, check that a proposed SKILL.md parses, has required frontmatter, has non-empty trigger, and doesn't collide with an existing skillId.

**Wraps:** Zod schema + frontmatter parser + DB uniqueness check. Pure static analysis — does not write.

**Input:**
```typescript
{
  skillId: string,
  content: string,          // full SKILL.md contents
  intent: "register" | "update",
}
```

**Output data:**
```typescript
{
  valid: boolean,
  errors: Array<{
    code: string,           // "missing_frontmatter" | "empty_trigger" | "id_collision" | ...
    message: string,
    field?: string,
  }>,
  parsed?: {
    name: string,
    description: string,
    role: Role | "all",
    trigger: string,
  },
}
```

**Allowlist:** `skills_lead`.

### B.5 `skill_register` (write)

**Purpose:** create a new skill. Writes `.arceus/skills-seed/<skillId>/SKILL.md`, inserts `skills` row, inserts `skill_revisions` row, git commit, git tag `skill-evolve/<skillId>/1`.

**Wraps:** fs write + 2 DB inserts + git commit + git tag. Idempotent on `idempotencyKey`.

**Input:**
```typescript
{
  skillId: string,
  content: string,
  proposalId?: string,      // Track C job id if this came from the orchestrator
  idempotencyKey: string,
}
```

**Guarantees:**
- Runs `skill_validate_definition` first. Refuses if invalid.
- Refuses if `skillId` already exists (use `skill_update` instead).
- On success: git tag `skill-evolve/<skillId>/1` is created atomically with the commit.
- On failure at any step: rolls back fs write and DB rows. No orphan tags.

**Output data:**
```typescript
{
  skillId: string,
  revisionNumber: 1,
  gitTag: string,
  gitSha: string,
}
```

**Errors:** `validation_failed`, `id_collision`, `git_failure`, `store_unavailable`.

**Allowlist:** `skills_lead`.

### B.6 `skill_update` (write)

**Purpose:** mutate an existing skill. Same shape as register but for the `skillId` already existing. Used both for forward edits and for rollbacks (rollback just passes content from a prior tag).

**Wraps:** fs write + DB update + `skill_revisions` insert + git commit + git tag `skill-evolve/<skillId>/<n+1>`.

**Input:**
```typescript
{
  skillId: string,
  content: string,
  proposalId?: string,      // present for Track C proposals
  rollbackFromTag?: string, // present for post-deploy auto-rollback
  idempotencyKey: string,
}
```

**Guarantees:**
- Validates first (`skill_validate_definition` with intent="update").
- Refuses if `skillId` does not exist (use `skill_register`).
- `rollbackFromTag` is recorded in `skill_revisions.rollback_from_tag` for audit — purely informational; the write path is identical.
- Tag is `skill-evolve/<skillId>/<n+1>` where `n` is the highest existing revision number.

**Output data:**
```typescript
{
  skillId: string,
  revisionNumber: number,
  gitTag: string,
  gitSha: string,
}
```

**Errors:** `validation_failed`, `skill_not_found`, `git_failure`, `store_unavailable`.

**Allowlist:** `skills_lead`.

### B.7 `skill_deprecate` (write)

**Purpose:** soft-remove a skill. Keeps its history and SKILL.md file, but flags `deprecated=true` in the `skills` table so it stops appearing in progressive-disclosure catalogs.

**Wraps:** DB update + git tag `skill-deprecated/<skillId>`.

**Input:**
```typescript
{
  skillId: string,
  reason: string,           // ≤ 280 chars, stored in skill_revisions
  idempotencyKey: string,
}
```

**Guarantees:**
- Refuses if `skillId` does not exist.
- Idempotent: calling twice with the same `idempotencyKey` is a no-op.
- Does not delete the SKILL.md file. History is preserved for audit.

**Output data:**
```typescript
{ skillId: string, deprecatedAt: ISO8601 }
```

**Allowlist:** `skills_lead`.

### Schema additions

`packages/db/src/schema/skill-revisions.ts` (new):
```typescript
skill_revisions {
  id: uuid pk
  skill_id: text fk → skills.id
  revision_number: int      // 1-based per skill
  git_tag: text unique      // "skill-evolve/<id>/<n>" or "skill-deprecated/<id>"
  git_sha: text
  applied_by: text          // session id
  applied_at: timestamptz
  proposal_id: text nullable // Track C job id
  rollback_from_tag: text nullable
  summary: text             // ≤ 280 chars, stored as commit message
  created_at: timestamptz default now()
}
-- index on (skill_id, revision_number desc)
```

### Rollback mechanics

Rollback is **not** a separate tool. It's `skill_update` called with the content from an earlier git tag. The post-deploy monitor (Track C) reads `git show skill-evolve/<id>/<n-1>:.arceus/skills-seed/<id>/SKILL.md`, then calls `skill_update` with that content, `rollbackFromTag="skill-evolve/<id>/<n-1>"`, and a fresh idempotencyKey. This creates revision `n+1` whose content happens to match revision `n-1`. No special code path — just git + one tool call.

---

## Track C — Skill Evolution Orchestrator

Three components: a scheduler, a job queue, and the `runATAPipeline()` orchestrator that composes the 8 Track A primitives.

### C.1 Scheduler

`apps/api/src/skills/scheduler.ts` — runs in-process (same node process as the API). Polls triggers once per minute.

**Triggers:**

1. **EMA drop.** For each skill, compute rolling EMA over the last 50 invocations. If `current_ema < baseline_ema - 0.15` and `invocations >= 10`, enqueue an evolve job. Baseline = EMA at the time of the most recent `skill-evolve/<id>/<n>` tag.

2. **Nightly cron.** At 03:00 UTC, enqueue one evolve job per skill with `invocations >= 20 AND failure_rate >= 0.3`. Dedup against jobs enqueued in the last 24h.

3. **Candidate submit.** Any role can call `skill_candidate_submit(description, motivation)` during a beat. This enqueues an evolve job with `trigger="candidate"` and no `targetSkillId` (discovery mode).

**Dedup:** one active job per `(targetSkillId, trigger)` pair. If a job is already queued or claimed for this pair, the trigger is a no-op.

### C.2 Job queue

`packages/db/src/schema/skill-evolve-jobs.ts` (new):
```typescript
skill_evolve_jobs {
  id: uuid pk
  trigger: "ema_drop" | "cron" | "candidate" | "rollback"
  target_skill_id: text nullable     // null for discovery
  payload: jsonb                     // trigger-specific context
  status: "pending" | "claimed" | "running" | "done" | "failed"
  attempts: int default 0
  claimed_by: text nullable
  claimed_at: timestamptz nullable
  result: jsonb nullable             // pipeline output or error
  created_at: timestamptz default now()
  completed_at: timestamptz nullable
}
```

**Worker loop:**
```
lease = SELECT * FROM skill_evolve_jobs
        WHERE status='pending' AND attempts < 3
        ORDER BY created_at
        LIMIT 1 FOR UPDATE SKIP LOCKED;
UPDATE status='claimed', claimed_by=$worker, attempts=attempts+1 WHERE id=lease.id;
run runATAPipeline(lease);
UPDATE status='done' or 'failed', result=... WHERE id=lease.id;
```

One worker per API node. Concurrency is not required at this volume (expected <100 jobs/day). If a worker crashes mid-run, `attempts < 3` re-leases it after a timeout.

### C.3 `runATAPipeline()` orchestrator

`apps/api/src/skills/evolution.ts` — already contains the 8 primitives (Track A). This spec adds the composition function.

**Signature:**
```typescript
async function runATAPipeline(job: SkillEvolveJob): Promise<PipelineResult> {
  // 1. Attribute
  const attribution = await analyzeFailure({ skillId: job.targetSkillId, window: job.payload.window });

  // 2. Propose (mutation or discovery depending on trigger)
  const proposal = job.targetSkillId
    ? await proposeSkillMutation({ skillId: job.targetSkillId, attribution })
    : await proposeSkillDiscovery({ candidateDescription: job.payload.description });

  // 3. TGA — generate test scenarios from the proposal only
  const scenarios = await generateTestScenarios({ proposedContent: proposal.content });

  // 4. EAA — dry-run the proposal against scenarios
  const results = await executeDryRun({ proposedContent: proposal.content, scenarios });

  // 5. ROA — two-tier gate
  const review = await reviewResults({ proposedContent: proposal.content, scenarios, results });
  //   review = { denseReasoning: string, gate: "accept" | "reject" | "needs_revision" }

  // 6. Branch
  if (review.gate === "reject") return { status: "rejected", audit: review };
  let finalContent = proposal.content;
  if (review.gate === "needs_revision") {
    const revised = await reviseSkill({ originalContent: proposal.content, review });
    finalContent = revised.content;
  }

  // 7. Synthesize — produce the final SKILL.md + summary
  const synthesis = await synthesizeSkill({ skillId: job.targetSkillId, content: finalContent });

  // 8. Create delegation task to SL (no direct write)
  const artifactId = await createHandoffArtifact({
    kind: "handoff",
    title: `Skill proposal: ${synthesis.skillId}`,
    content: synthesis.content,
    metadata: { proposalId: job.id, reviewAudit: review.denseReasoning },
  });
  await createTask({
    assignedRole: "skills_lead",
    kind: "skill_apply_proposal",
    relatedArtifactIds: [artifactId],
    description: synthesis.summary,
  });

  return { status: "accepted", proposalId: job.id, artifactId };
}
```

**Information isolation.** Each `await` above is a fresh `structuredCompletion` call. The ROA reviewer receives `{ proposedContent, scenarios, results }` — not the mutation prompt, not the attribution reasoning. This is enforced structurally (separate function, separate schema) and tested with a golden-input test that would fail if a primitive leaked upstream context.

**Two-tier ROA output.**
- `denseReasoning` (string, ≤ 2000 chars) — stored in the `skill_evolve_jobs.result` and attached to the delegation task for SL audit. Never fed back into later LLM calls.
- `gate` (enum) — drives the branch. Only this field has orchestrator semantics.

### C.4 Post-deploy EMA monitor

Runs as part of the scheduler's 1-minute tick.

**Logic:**
```
for each skill_revisions row where applied_at > now() - 24h
                                  AND rollback_from_tag IS NULL
                                  AND NOT already_monitored:
  baseline = EMA at applied_at - 1 beat
  current = EMA over beats since applied_at
  invocations_since = count of skill_usage since applied_at
  if invocations_since >= 20 AND current < baseline - 0.10:
    enqueue skill_evolve_jobs(trigger="rollback", target_skill_id=..., payload={from_tag: prior_tag})
```

The rollback job's `runATAPipeline()` path is short-circuited for `trigger="rollback"`: it skips all LLM primitives and directly creates a delegation task to SL with a pre-filled proposal (content from the prior git tag). SL still gates the application — rollback is fast-tracked, not automatic.

### C.5 Failure modes

| Failure | Handling |
|---------|----------|
| LLM primitive throws | `attempts++`, job re-leases up to 3×. After 3 failures, status=`failed`, result records error, on-call alert. |
| ROA returns malformed JSON | Zod parse fails → treated as primitive error → retry. |
| SL never picks up the delegation task | Delegation tasks age out after 7 days with a warning in `skill_health_report`. |
| Post-deploy monitor flaps (rollback → re-evolve → rollback) | Same `(skillId, trigger=rollback)` dedup key prevents more than one active rollback. Manual intervention required if a skill rolls back twice in 7 days. |
| Git tag collision | `skill_revisions.git_tag UNIQUE` constraint catches it. Tool returns `git_failure`. |

---

## Tool surface summary

| Tool | Track | Writes? | LLM? | Allowlist |
|------|-------|---------|------|-----------|
| `skill_health_report` | B | No | No | SL, CEO |
| `skill_audit_unused` | B | No | No | SL, CEO |
| `skill_inspect_history` | B | No | No | SL, CEO |
| `skill_validate_definition` | B | No | No | SL |
| `skill_register` | B | fs + DB + git | No | SL |
| `skill_update` | B | fs + DB + git | No | SL |
| `skill_deprecate` | B | DB + git | No | SL |
| `skill_candidate_submit` | C | Queue only | No | All roles |

Orchestrator internals (`runATAPipeline`, scheduler, EMA monitor) are not MCP tools — they run in-process and are not agent-callable.

---

## Acceptance criteria

### Track B

1. All 7 tools registered in the MCP server with Zod input schemas and envelope-wrapped outputs.
2. `skill_register` with a duplicate `skillId` returns `id_collision` and performs no writes.
3. `skill_update` on a non-existent skill returns `skill_not_found` and performs no writes.
4. `skill_validate_definition` catches missing frontmatter, empty trigger, and id collision without touching fs or DB.
5. Every successful `skill_register` / `skill_update` / `skill_deprecate` produces exactly one git tag and one `skill_revisions` row.
6. A rollback via `skill_update(rollbackFromTag=...)` creates a new revision number whose SKILL.md content exactly matches the tagged prior revision.
7. SL-only tools reject calls from other roles with the existing role-allowlist error.

### Track C

1. EMA drop trigger fires once per `(skillId, trigger)` pair until that job completes.
2. `runATAPipeline()` calls all 8 primitives in order for a mutation trigger; skips `proposeSkillMutation` and runs `proposeSkillDiscovery` for a candidate trigger.
3. Golden-input test: feeding a mutation proposal that references context only available in the attribution step causes the test to fail (proves ROA does not see attribution).
4. Accepted proposals create exactly one delegation task assigned to `skills_lead` with a `handoff`-kind artifact.
5. Rejected proposals produce no task and no artifact; the job result records `denseReasoning`.
6. Post-deploy monitor enqueues at most one rollback job per revision, only after `>= 20` invocations since apply.
7. Worker crash mid-pipeline → job re-leases after timeout, `attempts` increments, runs to completion or marks `failed` after 3 attempts.
8. A skill that has rolled back twice in 7 days is visible in `skill_health_report` with `trend="falling"` and no new rollback job is auto-enqueued (manual only).

---

## Out of scope

- **SL reasoning over proposals.** SL decides accept/reject when reviewing the delegation task. This spec does not prescribe how — whether the SL agent reasons via LLM, a human reviews in the UI, or both. That is a Spec-13 governance decision.
- **Cross-skill refactors.** Each job targets at most one skill. Proposals that would modify multiple skills must be split by the orchestrator into separate jobs; initial implementation rejects multi-skill proposals at the `reviewResults` step.
- **Skill composition / import graphs.** Skills remain independent SKILL.md files. No `includes:` directives in this spec.
- **Automatic rollback application.** The post-deploy monitor creates a rollback *proposal*; SL still applies it. Fully-automatic rollback is a future extension once the monitor has a track record.

---

## Migration path

1. Land Track B (7 tools + schema migration for `skill_revisions`). SL starts using them manually — no orchestrator yet.
2. Seed `skill_revisions` for existing skills with `revision_number=1, applied_by="seed"` and tag `skill-evolve/<id>/1` on each existing SKILL.md.
3. Land Track C scheduler + job queue + `runATAPipeline()`. Enable candidate trigger first (fully opt-in). Validate a handful of end-to-end runs manually.
4. Enable cron trigger. Let it run for a week; confirm it produces useful proposals and SL can action them.
5. Enable EMA-drop trigger last, with a conservative threshold (0.15 drop, 20 invocation floor). Tune from telemetry.
6. Enable post-deploy monitor once EMA-drop trigger has a clean baseline.
