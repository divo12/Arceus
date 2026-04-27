/**
 * Backfill — Spec 31 PR #13b.
 *
 * One-shot migration that copies every live row from the legacy
 * `hippocampus.memory_units` table into the canonical
 * `public.memory_units` + `public.memory_embeddings` tables. The
 * online dual-write (`apps/api/src/persistence/memory-bridge.ts`)
 * keeps the new tables in sync from the moment this PR ships;
 * this script catches up the rows that existed before then.
 *
 * Decode logic is shared with the bridge via
 * `bridges/memory-decode.ts` — both paths produce byte-identical rows.
 *
 * Run via:
 *   bun packages/db/src/scripts/backfill-memory.ts        # dry-run preflight
 *   bun packages/db/src/scripts/backfill-memory.ts --run  # execute backfill
 *
 * Resumable + concurrency-safe:
 *   - Unique partial index on `memory_units.legacy_id` (PR #13a) makes
 *     re-runs idempotent via `ON CONFLICT DO NOTHING`.
 *   - `FOR UPDATE SKIP LOCKED` on the legacy SELECT lets multiple
 *     workers process disjoint batches simultaneously.
 */
import "../load-env.js";
import postgres, { type TransactionSql } from "postgres";
import { friendlyToUuid } from "../repos/_uuid.js";
import {
  buildMemoryUnitInsert,
  LEGACY_EMBEDDING_MODEL,
  type LegacyMemoryRow,
  type LegacyMemoryType,
  type LegacySourceType,
  type LegacyVisibility,
} from "../bridges/memory-decode.js";

// ---------------------------------------------------------------------------
// Config — read once at process start
// ---------------------------------------------------------------------------

const BATCH_SIZE = 1000;
const SAMPLE_SIZE = 10;

const DATABASE_URL =
  process.env.SUPABASE_DB_URL?.trim() ||
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!DATABASE_URL) {
  console.error("[backfill-memory] DATABASE_URL is required");
  process.exit(1);
}

const LEGACY_SCHEMA =
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA?.trim() ||
  process.env.ARCEUS_DB_SCHEMA?.trim() ||
  "public";

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(LEGACY_SCHEMA)) {
  console.error(`[backfill-memory] invalid schema name: ${LEGACY_SCHEMA}`);
  process.exit(1);
}

const DRY_RUN = !process.argv.includes("--run");

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const sql = postgres(DATABASE_URL, { max: 4, prepare: false });

// ---------------------------------------------------------------------------
// Raw legacy row shape (postgres.js returns snake_case)
// ---------------------------------------------------------------------------

interface RawLegacyRow {
  id: string;
  company_id: string;
  agent_id: string;
  content: string;
  memory_type: LegacyMemoryType;
  confidence: number;
  relevance_score: number;
  container: string;
  visibility: LegacyVisibility;
  source_type: LegacySourceType | null;
  source_id: string | null;
  metadata: Record<string, unknown>;
  version: number;
  deleted_at: Date | null;
  delete_reason: string;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  embedding: number[] | null;
}

function fromRaw(raw: RawLegacyRow): LegacyMemoryRow {
  return {
    id: raw.id,
    companyId: raw.company_id,
    agentId: raw.agent_id,
    content: raw.content,
    memoryType: raw.memory_type,
    confidence: raw.confidence,
    relevanceScore: raw.relevance_score,
    container: raw.container,
    visibility: raw.visibility,
    sourceType: raw.source_type,
    sourceId: raw.source_id,
    metadata: raw.metadata ?? {},
    version: raw.version,
    deletedAt: raw.deleted_at,
    deleteReason: raw.delete_reason,
    expiresAt: raw.expires_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    embedding: raw.embedding,
  };
}

/** pgvector serialisation — postgres.js doesn't speak the vector type
 *  natively, so we marshal arrays to the `'[1,2,3]'::vector(384)` form. */
function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Schema probe — confirm the legacy table is at the version we expect
// ---------------------------------------------------------------------------

const REQUIRED_LEGACY_COLUMNS = [
  "deleted_at",
  "delete_reason",
  "memory_type",
  "visibility",
  "source_type",
  "source_id",
  "metadata",
  "relevance_score",
  "container",
  "version",
  "embedding",
] as const;

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
      `[backfill-memory] legacy table ${LEGACY_SCHEMA}.memory_units is missing required columns: ${missing.join(", ")}`,
    );
    console.error(
      "[backfill-memory] this script targets the spec 05a schema (migration 001_hippocampus_memory.sql).",
    );
    console.error(
      "[backfill-memory] apply legacy migrations to the source DB or point at a production schema.",
    );
    process.exit(4);
  }
}

// ---------------------------------------------------------------------------
// Preflight — every legacy row must resolve to a known agent + company
// ---------------------------------------------------------------------------

interface UnresolvedRow {
  id: string;
  agentId: string;
  companyId: string;
  reason: "agent" | "company" | "both";
}

async function preflight(): Promise<UnresolvedRow[]> {
  const rows = await sql<{ id: string; company_id: string; agent_id: string }[]>`
    SELECT id, company_id, agent_id
      FROM ${sql(`${LEGACY_SCHEMA}.memory_units`)}
     WHERE deleted_at IS NULL
  `;

  const unresolved: UnresolvedRow[] = [];
  for (const row of rows) {
    const companyUuid = friendlyToUuid(row.company_id);
    const agentUuid = friendlyToUuid(row.agent_id);

    const [companyHit] = await sql<{ id: string }[]>`SELECT id FROM companies WHERE id = ${companyUuid} LIMIT 1`;
    const [agentHit] = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = ${agentUuid} LIMIT 1`;

    if (!companyHit && !agentHit) {
      unresolved.push({ id: row.id, agentId: row.agent_id, companyId: row.company_id, reason: "both" });
    } else if (!companyHit) {
      unresolved.push({ id: row.id, agentId: row.agent_id, companyId: row.company_id, reason: "company" });
    } else if (!agentHit) {
      unresolved.push({ id: row.id, agentId: row.agent_id, companyId: row.company_id, reason: "agent" });
    }
  }
  return unresolved;
}

// ---------------------------------------------------------------------------
// Batched copy — one transaction per batch
// ---------------------------------------------------------------------------

interface BatchStats {
  scanned: number;
  inserted: number;
  skippedConflict: number;
  embeddingsWritten: number;
}

async function processBatch(): Promise<BatchStats> {
  return await sql.begin<BatchStats>(async (tx) => {
    const stats: BatchStats = { scanned: 0, inserted: 0, skippedConflict: 0, embeddingsWritten: 0 };

    const legacyRows = await tx<RawLegacyRow[]>`
      SELECT id, company_id, agent_id, content, memory_type, confidence,
             relevance_score, container, visibility, source_type, source_id,
             metadata, version, deleted_at, delete_reason,
             expires_at, created_at, updated_at, embedding
        FROM ${tx(`${LEGACY_SCHEMA}.memory_units`)} m
       WHERE m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM memory_units mu WHERE mu.legacy_id = m.id)
       ORDER BY m.created_at
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
    `;

    for (const raw of legacyRows) {
      stats.scanned += 1;
      const inserted = await mirrorOne(tx, fromRaw(raw));
      if (!inserted.inserted) {
        stats.skippedConflict += 1;
        continue;
      }
      stats.inserted += 1;
      if (inserted.embeddingWritten) stats.embeddingsWritten += 1;
    }

    return stats;
  });
}

interface MirrorResult {
  inserted: boolean;
  embeddingWritten: boolean;
}

async function mirrorOne(tx: TransactionSql, legacy: LegacyMemoryRow): Promise<MirrorResult> {
  const sourceTaskId = await resolveSourceTaskId(tx, legacy);
  const v = buildMemoryUnitInsert(legacy, sourceTaskId);

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO memory_units (
      legacy_id, company_id, agent_id, type, kind, content, tags,
      confidence, relevance_score, container, deleted_at, delete_reason,
      version, source_task_id, source_beat_id, expires_at,
      created_at, updated_at
    ) VALUES (
      ${v.legacyId ?? null},
      ${v.companyId},
      ${v.agentId},
      ${v.type},
      ${v.kind ?? null},
      ${v.content},
      ${tx.array(v.tags ?? [])},
      ${v.confidence ?? 0.8},
      ${v.relevanceScore ?? 1.0},
      ${v.container ?? ""},
      ${v.deletedAt ?? null},
      ${v.deleteReason ?? ""},
      ${v.version ?? 1},
      ${v.sourceTaskId ?? null},
      ${v.sourceBeatId ?? null},
      ${v.expiresAt ?? null},
      ${v.createdAt ?? new Date()},
      ${v.updatedAt ?? new Date()}
    )
    ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
    RETURNING id
  `;

  if (!row) return { inserted: false, embeddingWritten: false };

  if (legacy.embedding && legacy.embedding.length > 0) {
    await tx`
      INSERT INTO memory_embeddings (memory_id, embedding, model_version, created_at)
      VALUES (${row.id}, ${vectorLiteral(legacy.embedding)}::vector, ${LEGACY_EMBEDDING_MODEL}, ${legacy.createdAt})
      ON CONFLICT (memory_id) DO UPDATE
        SET embedding = EXCLUDED.embedding,
            model_version = EXCLUDED.model_version
    `;
    return { inserted: true, embeddingWritten: true };
  }

  return { inserted: true, embeddingWritten: false };
}

async function resolveSourceTaskId(tx: TransactionSql, legacy: LegacyMemoryRow): Promise<string | null> {
  if (legacy.sourceType !== "task" || !legacy.sourceId) return null;
  const candidate = friendlyToUuid(legacy.sourceId);
  const [row] = await tx<{ id: string }[]>`SELECT id FROM tasks WHERE id = ${candidate} LIMIT 1`;
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Validation — counts + random-sample diff
// ---------------------------------------------------------------------------

interface ValidationReport {
  legacyCount: number;
  canonicalCount: number;
  matched: boolean;
  sampleDiffs: SampleDiff[];
}

interface SampleDiff {
  legacyId: string;
  ok: boolean;
  field?: string;
  legacyValue?: unknown;
  canonicalValue?: unknown;
}

async function validate(): Promise<ValidationReport> {
  const [legacyRow] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM ${sql(`${LEGACY_SCHEMA}.memory_units`)} WHERE deleted_at IS NULL
  `;
  const [canonicalRow] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM memory_units WHERE legacy_id IS NOT NULL
  `;

  const legacyCount = legacyRow?.n ?? 0;
  const canonicalCount = canonicalRow?.n ?? 0;

  const sampleDiffs = await diffRandomSample();
  const matched = legacyCount === canonicalCount && sampleDiffs.every((d) => d.ok);

  return { legacyCount, canonicalCount, matched, sampleDiffs };
}

async function diffRandomSample(): Promise<SampleDiff[]> {
  const samples = await sql<RawLegacyRow[]>`
    SELECT id, content, confidence, memory_type, visibility, metadata
      FROM ${sql(`${LEGACY_SCHEMA}.memory_units`)}
     WHERE deleted_at IS NULL
     ORDER BY random()
     LIMIT ${SAMPLE_SIZE}
  `;

  const diffs: SampleDiff[] = [];
  for (const raw of samples) {
    const [canonical] = await sql<{
      content: string;
      confidence: number;
    }[]>`
      SELECT content, confidence FROM memory_units WHERE legacy_id = ${raw.id} LIMIT 1
    `;
    if (!canonical) {
      diffs.push({ legacyId: raw.id, ok: false, field: "row", legacyValue: "exists", canonicalValue: "missing" });
      continue;
    }
    if (canonical.content !== raw.content) {
      diffs.push({
        legacyId: raw.id,
        ok: false,
        field: "content",
        legacyValue: raw.content.slice(0, 64),
        canonicalValue: canonical.content.slice(0, 64),
      });
      continue;
    }
    if (Math.abs((canonical.confidence ?? 0) - raw.confidence) > 1e-6) {
      diffs.push({
        legacyId: raw.id,
        ok: false,
        field: "confidence",
        legacyValue: raw.confidence,
        canonicalValue: canonical.confidence,
      });
      continue;
    }
    diffs.push({ legacyId: raw.id, ok: true });
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[backfill-memory] mode=${DRY_RUN ? "dry-run" : "execute"} legacy_schema=${LEGACY_SCHEMA}`);

  await assertLegacySchema();

  console.log("[backfill-memory] preflight: resolving every legacy row…");
  const unresolved = await preflight();
  if (unresolved.length > 0) {
    console.error(`[backfill-memory] preflight failed: ${unresolved.length} unresolved row(s)`);
    for (const u of unresolved.slice(0, 20)) {
      console.error(`  - id=${u.id} reason=${u.reason} agent=${u.agentId} company=${u.companyId}`);
    }
    if (unresolved.length > 20) console.error(`  …and ${unresolved.length - 20} more`);
    process.exit(2);
  }
  console.log("[backfill-memory] preflight: OK");

  if (DRY_RUN) {
    console.log("[backfill-memory] dry-run complete; pass --run to execute");
    await sql.end();
    return;
  }

  let totals = { scanned: 0, inserted: 0, skipped: 0, embeddings: 0 };
  let batchNum = 0;
  while (true) {
    batchNum += 1;
    const batch = await processBatch();
    totals = {
      scanned: totals.scanned + batch.scanned,
      inserted: totals.inserted + batch.inserted,
      skipped: totals.skipped + batch.skippedConflict,
      embeddings: totals.embeddings + batch.embeddingsWritten,
    };
    console.log(
      `[backfill-memory] batch ${batchNum}: scanned=${batch.scanned} inserted=${batch.inserted} ` +
        `skipped=${batch.skippedConflict} embeddings=${batch.embeddingsWritten}`,
    );
    if (batch.scanned === 0) break;
  }

  console.log(
    `[backfill-memory] done — scanned=${totals.scanned} inserted=${totals.inserted} ` +
      `skipped=${totals.skipped} embeddings=${totals.embeddings}`,
  );

  console.log("[backfill-memory] validating…");
  const report = await validate();
  console.log(
    `[backfill-memory] validation: legacy=${report.legacyCount} canonical=${report.canonicalCount} matched=${report.matched}`,
  );
  for (const d of report.sampleDiffs) {
    if (!d.ok) {
      console.error(
        `  diff legacy=${d.legacyId} field=${d.field} ${JSON.stringify({
          legacy: d.legacyValue,
          canonical: d.canonicalValue,
        })}`,
      );
    }
  }
  await sql.end();
  if (!report.matched) process.exit(3);
}

main().catch(async (err) => {
  console.error("[backfill-memory] fatal:", err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
