/**
 * Backfill — Spec 31 PR #13d.
 *
 * One-shot copy of `hippocampus.habits` → `public.habits`. Habits are
 * write-rare (the procedural memory is updated when the runtime forms
 * a new pattern, not on every beat), so a blocking one-shot is
 * acceptable; no online dual-write is needed.
 *
 * Idempotent + resumable via the unique partial index on
 * `habits.legacy_id` — re-runs `ON CONFLICT DO NOTHING` over rows
 * already migrated.
 *
 * Run via:
 *   bun packages/db/src/scripts/backfill-habits.ts        # dry-run
 *   bun packages/db/src/scripts/backfill-habits.ts --run  # execute
 */
import "../load-env.js";
import postgres from "postgres";
import { friendlyToUuid } from "../repos/_uuid.js";
import {
  buildHabitInsert,
  type LegacyFormationMode,
  type LegacyHabitRow,
} from "../bridges/habit-decode.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

const DATABASE_URL =
  process.env.SUPABASE_DB_URL?.trim() ||
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!DATABASE_URL) {
  console.error("[backfill-habits] DATABASE_URL is required");
  process.exit(1);
}

const LEGACY_SCHEMA =
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA?.trim() ||
  process.env.ARCEUS_DB_SCHEMA?.trim() ||
  "public";

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(LEGACY_SCHEMA)) {
  console.error(`[backfill-habits] invalid schema name: ${LEGACY_SCHEMA}`);
  process.exit(1);
}

const DRY_RUN = !process.argv.includes("--run");

const sql = postgres(DATABASE_URL, { max: 2, prepare: false });

// ---------------------------------------------------------------------------
// Schema probe
// ---------------------------------------------------------------------------

const REQUIRED_LEGACY_COLUMNS = [
  "id",
  "company_id",
  "agent_id",
  "trigger_condition",
  "action",
  "confidence",
  "usage_count",
  "formed_from_id",
  "formation_mode",
  "is_active",
] as const;

async function assertLegacySchema(): Promise<void> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = ${LEGACY_SCHEMA} AND table_name = 'habits'
  `;
  const present = new Set(rows.map((r) => r.column_name));
  const missing = REQUIRED_LEGACY_COLUMNS.filter((col) => !present.has(col));
  if (missing.length > 0) {
    console.error(
      `[backfill-habits] legacy table ${LEGACY_SCHEMA}.habits is missing columns: ${missing.join(", ")}`,
    );
    process.exit(4);
  }
}

// ---------------------------------------------------------------------------
// Raw row + decoder
// ---------------------------------------------------------------------------

interface RawLegacyRow {
  id: string;
  company_id: string;
  agent_id: string;
  trigger_condition: string;
  action: string;
  confidence: number;
  usage_count: number;
  formed_from_id: string;
  formation_mode: LegacyFormationMode;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function fromRaw(raw: RawLegacyRow): LegacyHabitRow {
  return {
    id: raw.id,
    companyId: raw.company_id,
    agentId: raw.agent_id,
    triggerCondition: raw.trigger_condition,
    action: raw.action,
    confidence: raw.confidence,
    usageCount: raw.usage_count,
    formedFromId: raw.formed_from_id,
    formationMode: raw.formation_mode,
    isActive: raw.is_active,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

interface UnresolvedRow {
  id: string;
  agentId: string;
  companyId: string;
  reason: "agent" | "company" | "both";
}

async function preflight(): Promise<UnresolvedRow[]> {
  const rows = await sql<{ id: string; company_id: string; agent_id: string }[]>`
    SELECT id, company_id, agent_id FROM ${sql(`${LEGACY_SCHEMA}.habits`)}
  `;
  const unresolved: UnresolvedRow[] = [];
  for (const row of rows) {
    const companyUuid = friendlyToUuid(row.company_id);
    const agentUuid = friendlyToUuid(row.agent_id);
    const [companyHit] = await sql<{ id: string }[]>`SELECT id FROM companies WHERE id = ${companyUuid} LIMIT 1`;
    const [agentHit] = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = ${agentUuid} LIMIT 1`;
    if (!companyHit && !agentHit) unresolved.push({ id: row.id, agentId: row.agent_id, companyId: row.company_id, reason: "both" });
    else if (!companyHit) unresolved.push({ id: row.id, agentId: row.agent_id, companyId: row.company_id, reason: "company" });
    else if (!agentHit) unresolved.push({ id: row.id, agentId: row.agent_id, companyId: row.company_id, reason: "agent" });
  }
  return unresolved;
}

// ---------------------------------------------------------------------------
// Batched copy
// ---------------------------------------------------------------------------

interface BatchStats {
  scanned: number;
  inserted: number;
  skippedConflict: number;
}

async function processBatch(): Promise<BatchStats> {
  return await sql.begin<BatchStats>(async (tx) => {
    const stats: BatchStats = { scanned: 0, inserted: 0, skippedConflict: 0 };
    const rows = await tx<RawLegacyRow[]>`
      SELECT id, company_id, agent_id, trigger_condition, action, confidence,
             usage_count, formed_from_id, formation_mode, is_active,
             created_at, updated_at
        FROM ${tx(`${LEGACY_SCHEMA}.habits`)} h
       WHERE NOT EXISTS (SELECT 1 FROM habits hh WHERE hh.legacy_id = h.id)
       ORDER BY h.created_at
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
    `;

    for (const raw of rows) {
      stats.scanned += 1;
      const v = buildHabitInsert(fromRaw(raw));
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO habits (
          legacy_id, company_id, agent_id, trigger_condition, action,
          confidence, usage_count, formed_from_id, formation_mode,
          is_active, created_at, updated_at
        ) VALUES (
          ${v.legacyId ?? null},
          ${v.companyId},
          ${v.agentId},
          ${v.triggerCondition},
          ${v.action},
          ${v.confidence ?? 0.0},
          ${v.usageCount ?? 0},
          ${v.formedFromId ?? ""},
          ${v.formationMode ?? "auto"},
          ${v.isActive ?? true},
          ${v.createdAt ?? new Date()},
          ${v.updatedAt ?? new Date()}
        )
        ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (inserted) stats.inserted += 1;
      else stats.skippedConflict += 1;
    }
    return stats;
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validate(): Promise<{ legacy: number; canonical: number; matched: boolean }> {
  const [legacyRow] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${sql(`${LEGACY_SCHEMA}.habits`)}`;
  const [canonicalRow] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM habits WHERE legacy_id IS NOT NULL`;
  const legacy = legacyRow?.n ?? 0;
  const canonical = canonicalRow?.n ?? 0;
  return { legacy, canonical, matched: legacy === canonical };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[backfill-habits] mode=${DRY_RUN ? "dry-run" : "execute"} legacy_schema=${LEGACY_SCHEMA}`);
  await assertLegacySchema();

  const unresolved = await preflight();
  if (unresolved.length > 0) {
    console.error(`[backfill-habits] preflight failed: ${unresolved.length} unresolved row(s)`);
    for (const u of unresolved.slice(0, 20)) {
      console.error(`  - id=${u.id} reason=${u.reason} agent=${u.agentId} company=${u.companyId}`);
    }
    if (unresolved.length > 20) console.error(`  …and ${unresolved.length - 20} more`);
    process.exit(2);
  }
  console.log("[backfill-habits] preflight: OK");

  if (DRY_RUN) {
    console.log("[backfill-habits] dry-run complete; pass --run to execute");
    await sql.end();
    return;
  }

  let totals = { scanned: 0, inserted: 0, skipped: 0 };
  let batchNum = 0;
  while (true) {
    batchNum += 1;
    const batch = await processBatch();
    totals = {
      scanned: totals.scanned + batch.scanned,
      inserted: totals.inserted + batch.inserted,
      skipped: totals.skipped + batch.skippedConflict,
    };
    console.log(
      `[backfill-habits] batch ${batchNum}: scanned=${batch.scanned} inserted=${batch.inserted} skipped=${batch.skippedConflict}`,
    );
    if (batch.scanned === 0) break;
  }

  console.log(`[backfill-habits] done — scanned=${totals.scanned} inserted=${totals.inserted} skipped=${totals.skipped}`);

  const report = await validate();
  console.log(`[backfill-habits] validation: legacy=${report.legacy} canonical=${report.canonical} matched=${report.matched}`);
  await sql.end();
  if (!report.matched) process.exit(3);
}

main().catch(async (err) => {
  console.error("[backfill-habits] fatal:", err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
