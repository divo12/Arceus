/**
 * Friendly-id ↔ UUID boundary — single source of truth.
 *
 * Every domain repo in spec 31 uses uuidv5(friendlyId, ARCEUS_UUID_NS) to
 * compute the deterministic DB primary key from a friendly string id
 * ("tsk_xyz", "company_abc", "beat_123"). The same NS is also used by:
 *   - apps/api/src/orchestration/beat-lifecycle.ts (heartbeat_runs.id)
 *   - packages/hippocampus/src/backends/pgvector.ts (memory FK targets)
 *   - apps/api/src/observability/cost-recorder.ts + activity-log-sink.ts
 *
 * **DO NOT change the namespace constant after data exists** — it would
 * invalidate every PK derived from a friendly string. The single export
 * makes that contract observable in one place rather than scattered
 * across 8 files where someone could change one without the others.
 */
import { v5 as uuidv5 } from "uuid";

/** Fixed v5 namespace — DO NOT change after data exists, would invalidate PKs. */
export const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";

/** RFC 4122 UUID format check — used by every repo's `toDbId` to short-circuit
 *  inputs that are already uuids (round-tripped from a previous DB read). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single-arg friendly-id → uuid helper. Use this when the friendly id is
 * globally unique (companies, agents, sprints, tasks, …). For company-
 * scoped ids that need namespacing under the company uuid (skill slugs),
 * use the repo-local two-arg `toDbId(companyDbId, friendly)` form
 * instead — see skill_artifacts.ts.
 */
export const friendlyToUuid = (friendly: string): string =>
  UUID_RE.test(friendly) ? friendly : uuidv5(friendly, ARCEUS_UUID_NS);
