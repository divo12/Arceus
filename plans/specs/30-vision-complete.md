# Spec 30: Vision-Complete — Progressive Catalog, Trust Scoring, Skill-Evolution UI

> **Status:** DRAFT v1
> **Last updated:** 2026-04-24
> **Depends on:**
> - [Spec 23](./23-skill-tool-integration.md) — Skill-Tool Integration (catalog + `skill_usage` wiring)
> - [Spec 24](./24-agent-philosophy-refactor.md) — 24 system ops as tools, `runBeat` heartbeat model
> - [Spec 26/27](./26-tool-catalog-integration.md) — MCP tool catalog, envelope, allowlists
> - [Spec 29](./29-skill-evolution-orchestrator.md) — SL tools (Track B) + ATA orchestrator (Track C)
> - [`plans/agent-redesign/00-vision.md`](../agent-redesign/00-vision.md) — the target lifecycle
> **Purpose:** close the remaining gaps between the shipped code and the vision doc, then surface the whole loop in the web UI.

---

## What This Is

Specs 23–29 laid the architectural floor. The heartbeat runs, agents own the beat, 24 ops are tools, memory tools are wired, the 8 ATA primitives are clean, and spec 29 captures the skill-evolution closed loop.

But three concrete gaps separate us from the vision:

1. **Skill catalog still materializes full SKILL.md to disk.** The vision says agents reference skills by id from a compact in-prompt catalog and only read the body when they decide to use it. Today every skill's full content is written to `productWorkspace/.opencode/skills/<slug>/SKILL.md` on every beat.
2. **Trust band is a hardcoded stub.** [`beat-context-builder.ts:26`](../../apps/api/src/orchestration/beat-context-builder.ts) returns `"standard"` always. There's no `governance/trust.ts`, no `updateTrustScore`, and beat verdict is a three-line heuristic that only reads task transitions.
3. **Everything in spec 29 is paper.** The 7 SL tools, the scheduler, the job queue, the ATA orchestrator, and the post-deploy EMA monitor don't exist in code yet.

This spec composes those three closings (Chunks A / B / C) plus the frontend surfaces they unlock. After this ships, [`00-vision.md`](../agent-redesign/00-vision.md) is truthfully implemented end-to-end and Skills-Lead has a real cockpit.

---

## Why This Matters

```
WITHOUT spec 30:
  Agents see every skill's full body on every beat — token-heavy, noisy,
  and agents can't signal "I considered skill X but picked Y."
  Roles never move between probation/standard/senior — the policy exists
  in materialization but never fires.
  Beat verdicts are coarse (completed→pass, blocked→fail, else→fail),
  so skill success rates and trust scores drift on weak signal.
  Spec 29 lives on disk as markdown only. SL reviews nothing, rolls back
  nothing, and the scheduler doesn't exist to propose anything.

WITH spec 30:
  Agents see a compact catalog of { id, trigger, one-line } entries
  at beat start. They reference skills by id in their output; the plugin
  records usage. Bodies are only fetched when an agent elects to use one.
  Trust band is computed from rolling verdict history per (role, company).
  Verdict uses preview-probe, test signal, and task transitions — a
  composite score that drives trust transitions.
  Spec 29 Tracks B and C are implemented, and the web UI exposes skill
  health, proposal review, manual authoring, job queue state, and
  post-deploy EMA monitors as first-class views.
```

---

## Chunk A — Progressive-Disclosure Skill Catalog

### A.1 What changes

Today `materializeBeatSkills` writes the complete SKILL.md + resources for every active skill into `productWorkspace/.opencode/skills/<slug>/` so OpenCode's native loader picks them up. The catalog is implicit — the agent sees everything all the time.

After this chunk:

- Materializer still writes bodies to disk, but **scoped per beat** under `scratch/<beatId>/skills/` (not shared) and symlinked only when OpenCode resolves a `skill()` call.
- A **compact catalog** `{ id, role, trigger, oneLine }[]` is injected into the agent's system prompt at beat start.
- The agent references skills by `id` in its structured output; the plugin's `tool.execute.after` for the `skill` tool continues to POST `/skills/:id/usage` as today.
- OpenCode's filesystem skill loader still works — the agent can `skill({ name: "<slug>" })` and the disk-resolved path wins. The catalog is an *additional* signal, not a replacement for the file surface.

This is expand-before-contract. The file layer is untouched so rollback is a prompt-template revert.

### A.2 Catalog shape

```typescript
export const SkillCatalogEntrySchema = z.object({
  id: z.string(),              // SkillArtifact.id (stable, not slug)
  slug: z.string(),            // filesystem slug (for the skill() tool)
  role: z.enum([...roles, "all"]),
  trigger: z.string().max(300),  // frontmatter `trigger:`
  oneLine: z.string().max(200),  // frontmatter `description:`
});
```

Rendered into the system prompt as a fenced block:

```markdown
### Skills available this beat

| id | trigger |
|----|---------|
| sk_login_flow | When implementing auth or login UI |
| sk_api_route | When adding a new API endpoint |
| ...
```

Cap: 40 entries max per beat. If the role has more, the catalog is sorted by `(usageCount desc, updatedAt desc)` and truncated.

### A.3 Structured output contract

Agents already respond with structured output for tool calls. No new wire format — the existing `skill({ name })` call is the usage signal. We only add:

- A convention in role soul prompts: "When you consider a skill but don't use it, mention its id in your reasoning." This lets the extractor observe consideration without tool-call overhead. Optional; low-priority.

### A.4 Acceptance

1. Catalog block appears in the system-prompt assembly for every beat, with ≤40 entries.
2. Disk materialization scoped under `scratch/<beatId>/skills/` — no shared state between concurrent beats.
3. Beat-level `ARCEUS_ALLOWED_TOOLS` envvar unchanged. Plugin allowlist logic unchanged.
4. Skill-usage POSTs unchanged — one POST per `skill({ name })` tool call, mapped via manifest.
5. Agents can still `skill({ name: "<slug>" })` and load the body — the file path resolves.
6. When an agent references an id in prose but doesn't call the skill tool, no usage POST fires. (Mention is not use.)

---

## Chunk B — Trust Bands and Richer Beat Verdict

### B.1 Trust storage

New table `role_trust` in `packages/db/src/schema/`:

```typescript
role_trust {
  id: uuid pk
  company_id: text
  role: text
  band: text         // "probation" | "standard" | "senior"
  rolling_pass_rate: numeric(4,3)   // 0.000 .. 1.000
  beats_in_band: int
  last_verdict_at: timestamptz
  updated_at: timestamptz default now()
}
-- unique (company_id, role)
```

History table `role_trust_events`:
```typescript
role_trust_events {
  id: uuid pk
  company_id: text
  role: text
  from_band: text
  to_band: text
  reason: text      // "rolling_rate_below_0.5" | "senior_threshold" | ...
  verdict_window: jsonb  // last N verdicts that drove transition
  created_at: timestamptz default now()
}
```

### B.2 `computeTrustBand` (read)

```typescript
// apps/api/src/governance/trust.ts
export async function computeTrustBand(role: Role, companyId: string): Promise<TrustBand> {
  const row = await db.select().from(roleTrust).where(...).limit(1);
  return row[0]?.band ?? "standard";  // default for fresh roles
}
```

Called from `buildBeatContext`, replaces the stub at [`beat-context-builder.ts:26`](../../apps/api/src/orchestration/beat-context-builder.ts).

### B.3 `updateTrustScore` (write)

Called from `runBeat` cleanup after every beat:

```typescript
export async function updateTrustScore(
  role: Role,
  companyId: string,
  verdict: BeatVerdict,
): Promise<{ band: TrustBand; transitioned: boolean }> {
  // 1. Upsert row, append verdict, recompute rolling pass rate over last 20 beats
  // 2. Apply transition rules (B.4)
  // 3. If band changed, write role_trust_events row
}
```

### B.4 Transition rules (v1)

| From | To | Condition |
|---|---|---|
| standard | probation | rolling_pass_rate < 0.5 over last 20 beats AND beats_in_band >= 10 |
| probation | standard | rolling_pass_rate >= 0.75 over last 10 beats AND beats_in_band >= 5 |
| standard | senior | rolling_pass_rate >= 0.9 over last 50 beats AND beats_in_band >= 30 |
| senior | standard | rolling_pass_rate < 0.75 over last 20 beats |

Tunable via `config/trust.ts` constants; not per-company in v1.

### B.5 Richer beat verdict

Replace the [`scoreBeatVerdict`](../../apps/api/src/orchestration/beat-scoring.ts) heuristic with a composite:

```typescript
export type BeatVerdict = {
  outcome: "pass" | "fail";
  score: number;          // 0..1
  signals: {
    taskTransitions: { completed: number; blocked: number };
    previewProbe?: { ok: boolean; latencyMs?: number };
    testSignal?: { passed: number; failed: number; total: number };
    artifactCount: number;
  };
  cause?: string;         // "beat_hard_cap" | "preview_failed" | ...
};
```

Composite:
- `+0.4` if any task completed
- `-0.4` if any task blocked
- `+0.3` if preview probe passed
- `+0.3` if test pass rate >= 0.9 (weighted by total)
- Clamp to `[0, 1]`. `outcome = score >= 0.5 ? "pass" : "fail"`.

Signals are harvested from existing data:
- task transitions — already tracked in `beat-scoring.ts`
- preview probe — call existing `workspace_probe_preview` once at beat end for developer/tester/ui_designer beats
- test signal — parse `task_append_command` entries matching `/^(npm|pnpm|bun)\s+(test|vitest|jest)/` for exit codes and counts

Skill-success-rate update in [`run-beat.ts:87`](../../apps/api/src/orchestration/run-beat.ts) uses `verdict.score`, not a binary — `updateSuccessRate(skillId, verdict.score)`.

### B.6 Acceptance

1. `role_trust` and `role_trust_events` tables migrated and indexed.
2. `computeTrustBand` called from `buildBeatContext`; stub at line 26 removed.
3. Fresh (role, company) pairs default to `"standard"` with one row inserted on first beat.
4. Transition rules fire and record `role_trust_events` exactly once per transition.
5. `scoreBeatVerdict` returns a score in `[0, 1]` with signal breakdown; `outcome` derived from score.
6. Preview probe failure on a developer beat lowers the score by ≥ 0.3.
7. Test-suite failures visible in the verdict signals.
8. `updateSuccessRate` receives the fractional score, not 1/0.

---

## Chunk C — Spec 29 Implementation

This chunk executes [Spec 29](./29-skill-evolution-orchestrator.md) as written. Summary of deliverables:

### C.1 Track B (SL tools)
- 7 MCP tools: `skill_health_report`, `skill_audit_unused`, `skill_inspect_history`, `skill_validate_definition`, `skill_register`, `skill_update`, `skill_deprecate`.
- `skill_revisions` table migrated and seeded with `revision_number=1` for each existing skill; one git tag `skill-evolve/<id>/1` per existing SKILL.md.
- All 7 allowlisted to `skills_lead` (read-only ones also to `ceo`).
- `skill_candidate_submit` added to all roles.

### C.2 Track C (orchestrator)
- `skill_evolve_jobs` table with pg-lease worker.
- `scheduler.ts` with EMA / cron / candidate / rollback triggers and dedup.
- `runATAPipeline()` composing the 8 Track A primitives with information isolation and two-tier ROA gate.
- Accepted proposals create delegation tasks with `kind=skill_apply_proposal` and a `handoff`-kind artifact.
- Post-deploy EMA monitor enqueuing `trigger=rollback` jobs when a recent revision regresses.

### C.3 Acceptance

All acceptance criteria from Spec 29 §Acceptance (Track B and Track C) must pass. No additions here.

---

## Chunk D — Frontend Surfaces

The web app at [`apps/web/app/`](../../apps/web/app) already has dashboard, agents, employees, execution, governance, inbox, tasks, meetings, logs, debug, preview, settings. This chunk adds views for what A/B/C produce.

### D.1 Routes and data contracts

| Route | Purpose | Data source |
|---|---|---|
| `/agents/[role]/trust` | Trust-band timeline per role | `role_trust_events` via `/api/internal/trust/history/:role` |
| `/execution/[beatId]/inspector` | Beat inspector — catalog seen, skills invoked, verdict signals | Enriched beat record + plugin audit stream |
| `/skills` | Health dashboard — EMA, trend, invocations per skill | `skill_health_report` |
| `/skills/unused` | Deprecation candidates with one-click deprecate | `skill_audit_unused` → `skill_deprecate` |
| `/skills/[id]` | Skill detail + revision timeline + diff viewer | `skill_inspect_history` |
| `/skills/new` | Manual authoring with live validation | `skill_validate_definition` → `skill_register` |
| `/skills/jobs` | Evolve-job queue monitor | `skill_evolve_jobs` SELECT + SSE |
| `/skills/monitors` | Post-deploy EMA watch list + auto-rollback events | `skill_revisions` joined with EMA state |
| `/inbox/proposals` | SL inbox of delegation tasks awaiting review | `tasks` where `kind=skill_apply_proposal` |
| `/proposals/[id]` | Proposal detail with Accept / Revise / Reject | Handoff artifact + ROA denseReasoning + `skill_register`/`skill_update` |

### D.2 API routes to add

All under `/api/internal/v1/`:

```
GET  /trust/history/:role?companyId=...          → role_trust_events (last 50)
GET  /skills/health?role=&since=&minInvocations= → skill_health_report proxy
GET  /skills/audit-unused?staleDays=             → skill_audit_unused proxy
GET  /skills/:id/history                         → skill_inspect_history proxy
POST /skills/validate                            → skill_validate_definition proxy
POST /skills                                     → skill_register proxy
PATCH /skills/:id                                → skill_update proxy
DELETE /skills/:id                               → skill_deprecate proxy
GET  /skills/jobs?status=                        → skill_evolve_jobs
GET  /proposals/:jobId                           → proposal artifact + ROA audit
POST /proposals/:jobId/accept                    → resolves delegation task + calls skill_update
POST /proposals/:jobId/reject                    → marks task rejected
```

All routes envelope-wrapped per Spec 26/27.

### D.3 Components to reuse / add

Reuse:
- Existing `<EnvelopeError />`, `<BeatBadge />`, `<RoleChip />` from `apps/web/components/`.
- Existing SSE client for `skill_evolve_jobs` state changes.

Add:
- `<SkillCatalogTable />` — health dashboard row component with EMA sparkline.
- `<RevisionDiff />` — side-by-side SKILL.md diff between two git tags.
- `<ProposalReview />` — the central accept/revise/reject flow; embeds ATA audit, scenarios, EAA results, ROA denseReasoning.
- `<TrustTimeline />` — horizontal timeline of band transitions with verdict-window drill-down.

### D.4 Real-time updates

Job state changes stream through the existing SSE bus:

```
event: skill_evolve_job
data: { jobId, status, trigger, targetSkillId, updatedAt }
```

Frontend subscribes on `/skills/jobs` and `/inbox/proposals`; no polling.

### D.5 Acceptance

1. All 10 routes above land and pass `/api/internal/*` auth middleware.
2. SL can trigger a rollback end-to-end from `/proposals/:id` without touching the CLI.
3. Unused-skill audit → deprecate flow works from UI with idempotency.
4. Trust-band transitions surface in `/agents/[role]/trust` within 30s of the triggering beat.
5. Beat inspector shows exactly the catalog the agent saw (from chunk A) and the verdict signals (from chunk B).

---

## Ordering and Dependencies

```
Chunk A ─────────────► (independent; touches materializer + prompt builder)

Chunk B ─────────────► (independent; introduces trust schema + verdict composite)
          │
          ▼
Chunk C ─────────────► (depends on B — EMA input + verdict signal drive scheduler)

Chunk D ─────────────► (phased: D.A after A, D.B after B, D.C after C)
```

**Shipping order:**

1. Chunk A backend → Chunk A frontend slice (beat inspector).
2. Chunk B backend → Chunk B frontend slice (trust timeline + verdict view).
3. Chunk C Track B tools + Chunk D routes for B (manual authoring + health dashboard are usable immediately).
4. Chunk C Track C orchestrator + Chunk D remaining views (proposal inbox, job queue, monitors).

Every ship point leaves a usable increment — no "5 weeks until first UI."

---

## Out of Scope

- **Cross-company trust transfer.** Each `(role, company)` pair has its own trust state. No pooling in v1.
- **Per-company trust-rule tuning.** Transition thresholds in B.4 are global constants; knobs in `config/trust.ts` for dev adjustment only.
- **Catalog personalization beyond trust band.** A role's catalog is the same across companies with the same trust band. Per-company skill preferences land in v2.
- **Fully automatic rollback application.** Post-deploy monitor proposes; SL still applies (inherits from Spec 29 §Out of scope).
- **Proposal revision UI.** If SL picks "revise" on a proposal, they edit the SKILL.md freeform and call `skill_update`. No guided revision workflow in v1.
- **Mobile responsive views.** The SL cockpit is desktop-first; mobile layout is a follow-up.

---

## Migration Checklist

1. Land Chunk A — ship catalog block, keep disk materialization path as fallback. Gate rollout behind `FEATURE_PROGRESSIVE_CATALOG` for one week.
2. Migrate trust schema (B.1), deploy `computeTrustBand` reading from DB with a default-to-standard fallback. No user-visible change yet.
3. Upgrade `scoreBeatVerdict` (B.5). Run shadow-mode for 3 days comparing old-heuristic vs new-score outcomes; confirm no regression in skill success rates.
4. Enable trust transitions (B.4). Land `/agents/[role]/trust` UI.
5. Seed `skill_revisions` for existing skills (Spec 29 migration step 2).
6. Land Spec 29 Track B tools + frontend for manual authoring and health dashboard.
7. Land Spec 29 Track C scheduler + orchestrator + remaining frontend views.
8. Enable EMA-drop trigger (conservative thresholds). Monitor for one week.
9. Enable post-deploy EMA monitor.

At the end of step 9, the vision doc is implemented end-to-end and the web UI is the primary surface for skills-lead work.
