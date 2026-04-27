/**
 * Backfill — Spec 31 PR #13d.
 *
 * One-shot copy of `hippocampus.priming_state` → `public.priming_states`.
 * Priming is overwritten on every beat by the runtime so a one-shot
 * (no online dual-write) is appropriate; once PR #13d soaks, the
 * runtime exclusively writes to canonical and legacy is dropped in
 * PR #13e.
 *
 * Idempotent via `ON CONFLICT (agent_id) DO UPDATE` — re-runs are a
 * no-op when canonical already matches legacy.
 *
 * Run via:
 *   bun packages/db/src/scripts/backfill-priming.ts        # dry-run
 *   bun packages/db/src/scripts/backfill-priming.ts --run  # execute
 */
import "../load-env.js";
import postgres from "postgres";
import { friendlyToUuid } from "../repos/_uuid.js";
import { encodePrimingState, type LegacyPrimingRow } from "../bridges/priming-decode.js";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL?.trim() ||
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!DATABASE_URL) {
  console.error("[backfill-priming] DATABASE_URL is required");
  process.exit(1);
}

const LEGACY_SCHEMA =
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA?.trim() ||
  process.env.ARCEUS_DB_SCHEMA?.trim() ||
  "public";

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(LEGACY_SCHEMA)) {
  console.error(`[backfill-priming] invalid schema name: ${LEGACY_SCHEMA}`);
  process.exit(1);
}

const DRY_RUN = !process.argv.includes("--run");

const sql = postgres(DATABASE_URL, { max: 2, prepare: false });

const REQUIRED_LEGACY_COLUMNS = ["agent_id", "company_id", "confidence", "caution", "morale", "recent_events"] as const;

async function assertLegacySchema(): Promise<void> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${LEGACY_SCHEMA} AND table_name = 'priming_state'
  `;
  const present = new Set(rows.map((r) => r.column_name));
  const missing = REQUIRED_LEGACY_COLUMNS.filter((col) => !present.has(col));
  if (missing.length > 0) {
    console.error(`[backfill-priming] legacy table ${LEGACY_SCHEMA}.priming_state is missing columns: ${missing.join(", ")}`);
    process.exit(4);
  }
}

interface RawLegacyRow {
  agent_id: string;
  company_id: string;
  confidence: number;
  caution: number;
  morale: number;
  recent_events: string[] | null;
  updated_at: Date;
}

function fromRaw(raw: RawLegacyRow): LegacyPrimingRow {
  return {
    agentId: raw.agent_id,
    companyId: raw.company_id,
    confidence: raw.confidence,
    caution: raw.caution,
    morale: raw.morale,
    recentEvents: Array.isArray(raw.recent_events) ? raw.recent_events.filter((e): e is string => typeof e === "string") : [],
    updatedAt: raw.updated_at,
  };
}

interface UnresolvedRow {
  agentId: string;
  companyId: string;
  reason: "agent" | "company" | "both";
}

async function preflight(): Promise<UnresolvedRow[]> {
  const rows = await sql<{ agent_id: string; company_id: string }[]>`
    SELECT agent_id, company_id FROM ${sql(`${LEGACY_SCHEMA}.priming_state`)}
  `;
  const unresolved: UnresolvedRow[] = [];
  for (const row of rows) {
    const companyUuid = friendlyToUuid(row.company_id);
    const agentUuid = friendlyToUuid(row.agent_id);
    const [companyHit] = await sql<{ id: string }[]>`SELECT id FROM companies WHERE id = ${companyUuid} LIMIT 1`;
    const [agentHit] = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = ${agentUuid} LIMIT 1`;
    if (!companyHit && !agentHit) unresolved.push({ agentId: row.agent_id, companyId: row.company_id, reason: "both" });
    else if (!companyHit) unresolved.push({ agentId: row.agent_id, companyId: row.company_id, reason: "company" });
    else if (!agentHit) unresolved.push({ agentId: row.agent_id, companyId: row.company_id, reason: "agent" });
  }
  return unresolved;
}

async function main(): Promise<void> {
  console.log(`[backfill-priming] mode=${DRY_RUN ? "dry-run" : "execute"} legacy_schema=${LEGACY_SCHEMA}`);
  await assertLegacySchema();

  const unresolved = await preflight();
  if (unresolved.length > 0) {
    console.error(`[backfill-priming] preflight failed: ${unresolved.length} unresolved row(s)`);
    for (const u of unresolved.slice(0, 20)) {
      console.error(`  - reason=${u.reason} agent=${u.agentId} company=${u.companyId}`);
    }
    process.exit(2);
  }
  console.log("[backfill-priming] preflight: OK");

  if (DRY_RUN) {
    console.log("[backfill-priming] dry-run complete; pass --run to execute");
    await sql.end();
    return;
  }

  const rows = await sql<RawLegacyRow[]>`
    SELECT agent_id, company_id, confidence, caution, morale, recent_events, updated_at
      FROM ${sql(`${LEGACY_SCHEMA}.priming_state`)}
  `;

  let upserted = 0;
  await sql.begin(async (tx) => {
    for (const raw of rows) {
      const legacy = fromRaw(raw);
      const stateBlob = encodePrimingState(legacy);
      // postgres.js auto-serialises objects as jsonb when the
      // column type matches; we cast through `unknown` so the
      // structured PrimingStateBlob lines up with the driver's
      // permissive JSON-input type.
      await tx`
        INSERT INTO priming_states (agent_id, company_id, state, recent_outcomes, updated_at)
        VALUES (
          ${friendlyToUuid(legacy.agentId)},
          ${friendlyToUuid(legacy.companyId)},
          ${JSON.stringify(stateBlob)}::jsonb,
          ${"[]"}::jsonb,
          ${legacy.updatedAt}
        )
        ON CONFLICT (agent_id) DO UPDATE
          SET state = EXCLUDED.state,
              recent_outcomes = EXCLUDED.recent_outcomes,
              updated_at = EXCLUDED.updated_at
      `;
      upserted += 1;
    }
  });

  console.log(`[backfill-priming] done — upserted=${upserted}`);
  await sql.end();
}

main().catch(async (err) => {
  console.error("[backfill-priming] fatal:", err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
