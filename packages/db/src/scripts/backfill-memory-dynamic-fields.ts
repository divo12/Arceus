/**
 * Backfill — Spec 31 PR #13c follow-on.
 *
 * PR #13b mirrored legacy rows into `public.memory_units` before the
 * dynamic-store columns (`relevance_score`, `container`, `deleted_at`,
 * `delete_reason`, `version`) existed on the canonical side. Migration
 * 0013 added them with safe defaults; this script copies the live
 * legacy values into rows that were mirrored before the column add,
 * so decay/GC behaviour matches what the legacy backend produced.
 *
 * Idempotent: rows whose dynamic fields already match legacy are
 * skipped via the `IS DISTINCT FROM` filter. Re-running is a no-op.
 *
 * Run via:
 *   bun packages/db/src/scripts/backfill-memory-dynamic-fields.ts        # dry-run
 *   bun packages/db/src/scripts/backfill-memory-dynamic-fields.ts --run  # execute
 */
import "../load-env.js";
import postgres from "postgres";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL?.trim() ||
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!DATABASE_URL) {
  console.error("[backfill-dynamic-fields] DATABASE_URL is required");
  process.exit(1);
}

const LEGACY_SCHEMA =
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA?.trim() ||
  process.env.ARCEUS_DB_SCHEMA?.trim() ||
  "public";

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(LEGACY_SCHEMA)) {
  console.error(`[backfill-dynamic-fields] invalid schema name: ${LEGACY_SCHEMA}`);
  process.exit(1);
}

const DRY_RUN = !process.argv.includes("--run");

const sql = postgres(DATABASE_URL, { max: 2, prepare: false });

const REQUIRED_LEGACY_COLUMNS = ["relevance_score", "container", "deleted_at", "delete_reason", "version"] as const;

async function assertLegacySchema(): Promise<void> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = ${LEGACY_SCHEMA} AND table_name = 'memory_units'
  `;
  const present = new Set(rows.map((r) => r.column_name));
  const missing = REQUIRED_LEGACY_COLUMNS.filter((col) => !present.has(col));
  if (missing.length > 0) {
    console.error(
      `[backfill-dynamic-fields] legacy table ${LEGACY_SCHEMA}.memory_units is missing required columns: ${missing.join(", ")}`,
    );
    console.error("[backfill-dynamic-fields] apply legacy migrations or point at a production schema.");
    process.exit(4);
  }
}

async function main(): Promise<void> {
  console.log(`[backfill-dynamic-fields] mode=${DRY_RUN ? "dry-run" : "execute"} legacy_schema=${LEGACY_SCHEMA}`);

  await assertLegacySchema();

  const [pendingRow] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
      FROM memory_units mu
      JOIN ${sql(`${LEGACY_SCHEMA}.memory_units`)} m ON m.id = mu.legacy_id
     WHERE mu.legacy_id IS NOT NULL
       AND (
         mu.relevance_score IS DISTINCT FROM m.relevance_score
         OR mu.container       IS DISTINCT FROM m.container
         OR mu.deleted_at      IS DISTINCT FROM m.deleted_at
         OR mu.delete_reason   IS DISTINCT FROM m.delete_reason
         OR mu.version         IS DISTINCT FROM m.version
       )
  `;
  const pending = pendingRow?.n ?? 0;
  console.log(`[backfill-dynamic-fields] pending rows: ${pending}`);

  if (DRY_RUN || pending === 0) {
    if (DRY_RUN) console.log("[backfill-dynamic-fields] dry-run complete; pass --run to execute");
    await sql.end();
    return;
  }

  const updated = await sql.unsafe(`
    UPDATE memory_units mu
       SET relevance_score = m.relevance_score,
           container       = m.container,
           deleted_at      = m.deleted_at,
           delete_reason   = m.delete_reason,
           version         = m.version
      FROM "${LEGACY_SCHEMA}".memory_units m
     WHERE mu.legacy_id IS NOT NULL
       AND m.id = mu.legacy_id
       AND (
         mu.relevance_score IS DISTINCT FROM m.relevance_score
         OR mu.container       IS DISTINCT FROM m.container
         OR mu.deleted_at      IS DISTINCT FROM m.deleted_at
         OR mu.delete_reason   IS DISTINCT FROM m.delete_reason
         OR mu.version         IS DISTINCT FROM m.version
       )
  `);
  // postgres.js returns the rows on Result objects whose `count`
  // field carries the affected-row count for non-RETURNING UPDATEs.
  const affected = (updated as unknown as { count?: number }).count ?? 0;
  console.log(`[backfill-dynamic-fields] updated rows: ${affected}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error("[backfill-dynamic-fields] fatal:", err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
