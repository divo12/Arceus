/**
 * EXPLAIN audit — Spec 31 Phase 8.
 *
 * Runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against every
 * hot-path query the runtime fires repeatedly, parses the resulting
 * plan tree, and asserts:
 *
 *   1. Every table > 1000 rows is hit via `Index Scan` / `Index Only
 *      Scan` / `Bitmap Index Scan`, never `Seq Scan`. A seq scan on a
 *      large table is the most common "missed index" symptom.
 *   2. Total execution time fits a per-query budget (default 50 ms).
 *      Catches plan regressions like an unused filter that pulls 10k
 *      rows into memory before filtering down.
 *
 * Run via:  bun packages/db/src/scripts/explain-audit.ts
 *
 * Prerequisites:
 *   - DATABASE_URL set
 *   - Run `bun src/seed.ts` first to populate the canonical company so
 *     EXPLAIN reports realistic plans (a seq scan on an empty table is
 *     a false alarm — the planner picks the cheapest path regardless
 *     of indexes when the table is empty).
 *
 * Exit 0 if every query passes; exit 1 on the first violation, with the
 * plan + offending node printed.
 */
import "../load-env.js";
import postgres from "postgres";
import { CANONICAL_COMPANY_ID } from "../seed.js";
import { toDbId as companyToDbId } from "../repos/companies.js";
import { friendlyToUuid } from "../repos/_uuid.js";

interface HotPath {
  /** Short stable id for output + future regression tracking. */
  name: string;
  /** Human-readable label printed in the report. */
  description: string;
  /** SQL string with $1, $2, ... placeholders. */
  sql: string;
  /** Bound parameter values. */
  params: (string | number | null)[];
  /** Per-query execution budget in milliseconds. */
  budgetMs?: number;
}

const dbCompanyId = companyToDbId(CANONICAL_COMPANY_ID);

/**
 * Hot-path catalog. Each entry should map to a real runtime query
 * pattern. Adding a new spec-31 hot path = one entry here. Keep the
 * SQL minimal so EXPLAIN focuses on the index path, not joins we
 * don't need to audit.
 */
const HOT_PATHS: HotPath[] = [
  {
    name: "task_list_by_company",
    description: "List all tasks for a company (route /tasks)",
    sql: `SELECT id, status, kind FROM tasks WHERE company_id = $1`,
    params: [dbCompanyId],
  },
  {
    name: "task_open_by_role",
    description: "List open tasks for a role (used by buildBeatContext)",
    sql: `SELECT id, status FROM tasks WHERE company_id = $1 AND assigned_role = $2 AND status IN ('created','planned','in_progress','blocked')`,
    params: [dbCompanyId, "developer"],
  },
  {
    name: "agent_by_company_role",
    description: "Resolve agentId by (company, role) — every cost_events / activity_log write",
    sql: `SELECT id FROM agents WHERE company_id = $1 AND role = $2 LIMIT 1`,
    params: [dbCompanyId, "ceo"],
  },
  {
    name: "active_sprint_by_company",
    description: "Find the active sprint for a company",
    sql: `SELECT id FROM sprints WHERE company_id = $1 AND status = 'executing' ORDER BY sprint_number DESC LIMIT 1`,
    params: [dbCompanyId],
  },
  {
    name: "approvals_pending_by_company",
    description: "List pending approvals (governance dashboard)",
    sql: `SELECT id, kind FROM approvals WHERE company_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 50`,
    params: [dbCompanyId],
  },
  {
    name: "activity_log_by_company_recent",
    description: "Inspector cold-path pagination (newest 100 events)",
    sql: `SELECT id, action, entity_type, entity_id FROM activity_log WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`,
    params: [dbCompanyId],
  },
  {
    name: "cost_events_by_company_window",
    description: "Per-company spend in last 24h (dashboard)",
    sql: `SELECT provider, model, cost_cents FROM cost_events WHERE company_id = $1 AND occurred_at >= now() - interval '24 hours' ORDER BY occurred_at DESC LIMIT 200`,
    params: [dbCompanyId],
  },
  {
    name: "skill_recent_outcomes",
    description: "Skill EMA recompute — recent outcomes window per skill",
    sql: `SELECT outcome_score, occurred_at FROM skill_usage_events WHERE skill_id = $1 ORDER BY occurred_at DESC LIMIT 50`,
    params: [friendlyToUuid(`${dbCompanyId}:sk_implement_feature`)],
  },
  {
    name: "heartbeat_stranded",
    description: "Stranded-run reconciler — runs stuck in 'running' past cutoff",
    sql: `SELECT id, agent_id FROM heartbeat_runs WHERE status = 'running' AND started_at < now() - interval '30 minutes'`,
    params: [],
  },
  // memory_units retrieval is a real hot path but lives in
  // `hippocampus.memory_units` until spec 31 PR #13 reconciles the
  // dual schema. Add the entry once the table moves to public.
  // {
  //   name: "memory_units_by_agent_type",
  //   description: "Hippocampus retrieval window per (agent, type)",
  //   sql: `SELECT id FROM memory_units WHERE agent_id = $1 AND type = 'dynamic' ORDER BY created_at DESC LIMIT 25`,
  //   params: [friendlyToUuid("agent_developer_seed")],
  // },
];

/** Recursively walk a plan tree, calling `visit` on each node. */
interface PlanNode { "Node Type": string; "Relation Name"?: string; "Plan Rows"?: number; Plans?: PlanNode[] }
function walkPlan(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walkPlan(child, visit);
}

interface QueryReport {
  name: string;
  description: string;
  executionMs: number;
  budgetMs: number;
  seqScansOnLargeTables: { relation: string; rows: number }[];
  ok: boolean;
}

/** Tables with > this many rows that hit Seq Scan are flagged. Below
 *  this, the planner is allowed to choose seq scan (it's often optimal
 *  for tiny tables). */
const SEQ_SCAN_ROW_THRESHOLD = 1000;

async function fetchTableSizes(sql: postgres.Sql): Promise<Map<string, number>> {
  const rows = await sql<{ relname: string; reltuples: string }[]>`
    SELECT relname, reltuples::text FROM pg_class
     WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
  `;
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.relname, Math.max(0, Math.round(Number(r.reltuples))));
  return map;
}

async function explainOne(
  sql: postgres.Sql,
  path: HotPath,
  tableSizes: Map<string, number>,
): Promise<QueryReport> {
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${path.sql}`;
  const result = await sql.unsafe<{ "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[] }[]>(
    explainSql,
    path.params as never,
  );
  const explainRow = result[0]?.["QUERY PLAN"]?.[0];
  if (!explainRow) {
    throw new Error(`[explain-audit] no plan returned for ${path.name}`);
  }

  const seqScansOnLargeTables: { relation: string; rows: number }[] = [];
  walkPlan(explainRow.Plan, (n) => {
    if (n["Node Type"] === "Seq Scan" && n["Relation Name"]) {
      const rel = n["Relation Name"];
      const rows = tableSizes.get(rel) ?? 0;
      if (rows > SEQ_SCAN_ROW_THRESHOLD) {
        seqScansOnLargeTables.push({ relation: rel, rows });
      }
    }
  });

  const budgetMs = path.budgetMs ?? 50;
  const executionMs = explainRow["Execution Time"];
  const overBudget = executionMs > budgetMs;

  return {
    name: path.name,
    description: path.description,
    executionMs,
    budgetMs,
    seqScansOnLargeTables,
    ok: seqScansOnLargeTables.length === 0 && !overBudget,
  };
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.SUPABASE_DB_URL?.trim() ||
    process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("[explain-audit] no DATABASE_URL set");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  console.log(`[explain-audit] running ${HOT_PATHS.length} hot-path EXPLAIN ANALYZE queries`);
  console.log(`[explain-audit] seq-scan threshold: tables > ${SEQ_SCAN_ROW_THRESHOLD} rows`);

  const tableSizes = await fetchTableSizes(sql);
  const reports: QueryReport[] = [];
  let firstFailure: QueryReport | null = null;

  for (const path of HOT_PATHS) {
    try {
      const r = await explainOne(sql, path, tableSizes);
      reports.push(r);
      if (!r.ok && !firstFailure) firstFailure = r;
    } catch (err) {
      console.error(`[explain-audit] ${path.name} threw:`, (err as Error).message);
      reports.push({
        name: path.name,
        description: path.description,
        executionMs: -1,
        budgetMs: path.budgetMs ?? 50,
        seqScansOnLargeTables: [],
        ok: false,
      });
    }
  }

  console.log("\n[explain-audit] results:");
  for (const r of reports) {
    const tag = r.ok ? "✓" : "✗";
    const ms = r.executionMs >= 0 ? `${r.executionMs.toFixed(2)}ms` : "ERROR";
    const seqHits = r.seqScansOnLargeTables.length > 0
      ? ` SEQ_SCAN on ${r.seqScansOnLargeTables.map((s) => `${s.relation}(${s.rows})`).join(", ")}`
      : "";
    const budgetHit = r.executionMs > r.budgetMs ? ` OVER_BUDGET (>${r.budgetMs}ms)` : "";
    console.log(`  ${tag} ${r.name.padEnd(35)} ${ms.padStart(10)}${seqHits}${budgetHit}`);
  }

  await sql.end();

  const failed = reports.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[explain-audit] FAIL — ${failed.length} of ${reports.length} queries violated constraints`);
    for (const r of failed) {
      console.error(`  - ${r.name}: ${r.description}`);
      for (const s of r.seqScansOnLargeTables) {
        console.error(`      seq scan on ${s.relation} (~${s.rows} rows; add an index)`);
      }
      if (r.executionMs > r.budgetMs) {
        console.error(`      execution ${r.executionMs.toFixed(2)}ms > budget ${r.budgetMs}ms`);
      }
    }
    process.exit(1);
  }

  console.log(`\n[explain-audit] PASS — ${reports.length} queries clean (no seq scans on large tables, all under budget)`);
}

main().catch((err) => {
  console.error("[explain-audit] FAIL:", err);
  process.exit(1);
});
