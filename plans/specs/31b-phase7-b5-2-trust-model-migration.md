# Spec 31b — Phase 7.B.5.2-bis: Trust Model Migration

> **Status:** planned, not started
> **Predecessors:** 7.B.5.1 (beat_records), 7.B.5.3 (policy_violations), 7.C.d-cp (control-plane snapshot migration)
> **Blocks:** dropping the legacy `trust_scores` table

## Why this is its own slice

`trust_scores → role_trust` was originally bundled with B.5.1 and
B.5.3 as a "table swap" but the canonical and legacy schemas
disagree on **what trust is keyed by** and **what the trust value
is**. It can't be a translation layer like the other two; the
contract and API surface have to change.

| | Legacy `trust_scores` (text PK) | Canonical `role_trust` (composite PK) |
|--|---------------------------------|---------------------------------------|
| **PK** | `agent_id` (one row per agent) | `(company_id, role)` (one row per role per company) |
| **Trust value** | `score: real` (0–1, continuous) | `band: 'probation' \| 'standard' \| 'senior'` + `rolling_pass_rate: numeric(4,3)` |
| **History** | inline `history: jsonb (TrustEvent[])` | separate `role_trust_events` table with `from_band` / `to_band` / `verdict_window` |
| **Identity** | per-agent | per-role-per-company |

Naive translation would mean every agent in the same role shares
trust state — three developers, one band, one history. That's a
user-visible behaviour change.

## Scope

### Contract changes

`packages/contracts/src/governance.ts`:

```ts
// Replace
export type TrustScore = z.infer<typeof trustScoreSchema>;
// where trustScoreSchema is keyed by agentId with score: 0..1

// With
export const trustBandSchema = z.enum(['probation', 'standard', 'senior']);
export const roleTrustSchema = z.object({
  companyId: z.string(),
  role: roleTypeSchema,
  band: trustBandSchema,
  rollingPassRate: z.number().min(0).max(1),
  beatsInBand: z.number().int().nonnegative(),
  lastVerdictAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type RoleTrust = z.infer<typeof roleTrustSchema>;

// trustEventSchema also changes: agentId → role + companyId,
// kind enum stays, but a transition event now carries fromBand / toBand
// rather than a numeric delta.
```

### Runtime changes (`apps/api/src/persistence/control-plane.ts`)

| Old function | New shape |
|---|---|
| `cpLoadTrustScore(agentId)` | `cpLoadRoleTrust(companyId, role)` — looks up role row from `role_trust` repo |
| `cpUpdateTrustScore(event)` | `cpRecordVerdict(companyId, role, verdict)` — updates rolling pass rate, transitions band when threshold crossed, writes `role_trust_events` row |
| `cpGetAllTrustScores()` | `cpListRoleTrust(companyId)` — one row per role |
| `cpHydrateTrustScores()` | drop — `role_trust` is read on demand, no global cache needed |
| `cpInitializeAgentTrust(agents)` | `cpInitializeCompanyTrust(companyId, roles)` — seeds one row per distinct role |

The in-memory `trustScoreCache: Map<string, TrustScore>` goes
away; `role_trust` reads are cheap enough to skip caching, and the
band-transition logic must be transactional (read current band →
compute new band → write atomically) which a cache can't safely
serve.

### API surface changes (`apps/api/src/routes/governance.routes.ts`)

| Old route | New route |
|---|---|
| `GET  /api/governance/trust-scores`            | `GET  /api/governance/role-trust` |
| `GET  /api/governance/trust-scores/:agentId`   | `GET  /api/governance/role-trust/:role` |
| `POST /api/governance/trust-scores/:agentId/adjust` | `POST /api/governance/role-trust/:role/adjust` |
| `POST /api/governance/trust-scores/cleanup`    | drop — `role_trust` is FK-cascaded by company; orphans only on company deletion |

The dashboard's trust widget (`apps/web/app/dashboard/...`) needs a
parallel update — listing rows by role, showing band as
discrete pill instead of a 0–1 score, and surfacing
`role_trust_events` history per role.

### Reset cascade (`apps/api/src/companies/reset.ts`)

```ts
// Was: delete trust_scores by agent_id list
// Becomes: nothing — role_trust has ON DELETE CASCADE on company_id,
// so deleting the company row clears the trust rows automatically.
```

### Drop the legacy table

After the cutover lands and bakes for one release:

```sql
-- migrations/0018_phase7_drop_trust_scores.sql
DROP TABLE IF EXISTS trust_scores CASCADE;
```

And remove `trustScoresTable` from `packages/db/src/tables.ts`.

## Open questions to resolve before implementation

1. **Does the existing trust-band thresholds doc match the legacy
   score thresholds?** `companyRuntime.getTrustTier(score)` maps
   `0–0.4 → critical`, `0.4–0.6 → restricted`, `0.6–0.8 → standard`,
   `0.8–0.95 → trusted`, `0.95–1 → autonomous` — five tiers. The
   canonical band check allows three: `probation / standard /
   senior`. Need a mapping decision (which tiers collapse into
   which band?) and any policy rules that key off `minTrust:
   number` need a band-equivalent.
2. **Verdict signal source** — `role_trust.rollingPassRate` is
   computed from beat verdict outcomes. Currently the legacy path
   adjusts score per `TrustEvent` (`task_completed`,
   `task_failed`, etc.). The new path needs to consume verdict
   outcomes from `heartbeat_runs.verdictOutcome` directly. Where
   does the per-beat verdict get computed? (Likely in
   `orchestration/beat-lifecycle.ts` finishRun phase.)
3. **Migration of existing `trust_scores` rows** — a one-shot
   ETL: read `trust_scores`, group by `(companyId, role)` (need
   to look up agent's company+role from `agents`), aggregate
   scores into a band assignment, write `role_trust` rows. Should
   this run automatically as a data migration, or as a
   manual one-off for affected dbs?

## Estimate

3–5 days. Roughly:

- Day 1: contract changes + control-plane rewrite + unit tests.
- Day 2: governance route renames + cleanup of stale endpoints.
- Day 3: frontend dashboard update.
- Day 4: data migration + smoke test full beat → verdict → band-transition flow.
- Day 5: drop migration + tables.ts cleanup, ship.
