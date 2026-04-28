/**
 * One-shot DB reconciliation for the remote Supabase dev database.
 *
 * The journal (drizzle.__drizzle_migrations) only has entries 1-6, but
 * the actual schema is in a partial state somewhere between 0006 and 0016
 * (some later migrations were applied via `db:push`, some weren't, and
 * 0006 was modified after being applied so its hash no longer matches).
 *
 * This script:
 *   1. Applies the missing pieces from migrations 0007..0019 idempotently
 *      (using IF NOT EXISTS / DO blocks where the migration files lacked
 *      guards).
 *   2. Truncates and rebuilds drizzle.__drizzle_migrations with the
 *      current SHA-256 hashes of every migration file, so future runs
 *      of the migration runner see "no pending migrations".
 *
 * Idempotent: safe to re-run.
 */
import "../load-env.js";
import postgres from "postgres";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "..", "migrations");

function readJournal(): { idx: number; when: number; tag: string }[] {
  const raw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: { idx: number; when: number; tag: string }[] }).entries;
}

function migrationHash(tag: string): string {
  const sql = readFileSync(join(migrationsFolder, `${tag}.sql`), "utf8");
  return crypto.createHash("sha256").update(sql).digest("hex");
}

const url =
  process.env.SUPABASE_DB_URL?.trim() ||
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!url) throw new Error("No database URL");

const sql = postgres(url, { max: 1, prepare: false });

async function step(label: string, fn: () => Promise<void>) {
  console.log(`[reconcile] ${label} ...`);
  try {
    await fn();
    console.log(`[reconcile] ${label} OK`);
  } catch (err) {
    console.error(`[reconcile] ${label} FAILED:`, err);
    throw err;
  }
}

try {
  // 0007: skill_artifacts.friendly_id
  await step("0007 skill_artifacts.friendly_id", async () => {
    await sql.unsafe(`
      ALTER TABLE "skill_artifacts" ADD COLUMN IF NOT EXISTS "friendly_id" text;
      CREATE UNIQUE INDEX IF NOT EXISTS "skill_artifacts_friendly_id_idx"
        ON "skill_artifacts" USING btree ("company_id","friendly_id")
        WHERE "skill_artifacts"."friendly_id" IS NOT NULL;
    `);
  });

  // 0010: tasks status/kind/priority checks
  await step("0010 tasks status/kind/priority checks", async () => {
    await sql.unsafe(`
      ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_status_check";
      ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_priority_check";
      ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_kind_check";
      ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('created','planned','in_progress','verifying','blocked','completed','failed','cancelled'));
      ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" IN ('critical','high','medium','low'));
      ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" IN ('technical_plan','acceptance_spec','implementation','local_preview','design_direction','qa_verification','service_validation','launch_content','distribution_campaign','skill_authoring','board_handoff','follow_up','bug_fix'));
    `);
  });

  // 0011: tasks_active_claim_idx narrowed
  await step("0011 narrow tasks_active_claim_idx", async () => {
    await sql.unsafe(`
      DROP INDEX IF EXISTS "tasks_active_claim_idx";
      CREATE UNIQUE INDEX "tasks_active_claim_idx"
        ON "tasks" USING btree ("id")
        WHERE checkout_run_id IS NOT NULL AND status = 'in_progress';
    `);
  });

  // 0012: memory_embeddings vector(384) + memory_units.legacy_id
  // Embeddings table is empty so the recast is trivial.
  await step("0012 memory_embeddings vector(384) + legacy_id bridge", async () => {
    // Drop the old IVF index because vector dimension change is incompatible.
    await sql.unsafe(`
      DROP INDEX IF EXISTS "memory_embeddings_embedding_idx";
      ALTER TABLE "memory_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(384);
      ALTER TABLE "memory_units" ADD COLUMN IF NOT EXISTS "legacy_id" text;
      CREATE UNIQUE INDEX IF NOT EXISTS "memory_units_legacy_id_idx"
        ON "memory_units" USING btree ("legacy_id")
        WHERE "memory_units"."legacy_id" IS NOT NULL;
    `);
  });

  // 0013: memory_units dynamic fields
  await step("0013 memory_units dynamic fields", async () => {
    await sql.unsafe(`
      ALTER TABLE "memory_units" ADD COLUMN IF NOT EXISTS "relevance_score" real NOT NULL DEFAULT 1.0;
      ALTER TABLE "memory_units" ADD COLUMN IF NOT EXISTS "container" text NOT NULL DEFAULT '';
      ALTER TABLE "memory_units" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
      ALTER TABLE "memory_units" ADD COLUMN IF NOT EXISTS "delete_reason" text NOT NULL DEFAULT '';
      ALTER TABLE "memory_units" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS "memory_units_agent_type_live_idx"
        ON "memory_units" USING btree ("agent_id","type") WHERE "deleted_at" IS NULL;
      CREATE INDEX IF NOT EXISTS "memory_units_expires_live_idx"
        ON "memory_units" USING btree ("expires_at") WHERE "expires_at" IS NOT NULL AND "deleted_at" IS NULL;
    `);
  });

  // 0014: habits table
  await step("0014 habits canonical table", async () => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "habits" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
        "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
        "trigger_condition" text NOT NULL,
        "action" text NOT NULL,
        "confidence" real NOT NULL DEFAULT 0.0,
        "usage_count" integer NOT NULL DEFAULT 0,
        "formed_from_id" text NOT NULL DEFAULT '',
        "formation_mode" text NOT NULL DEFAULT 'auto',
        "is_active" boolean NOT NULL DEFAULT true,
        "legacy_id" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "habits_confidence_check"     CHECK ("confidence"     >= 0.0 AND "confidence" <= 1.0),
        CONSTRAINT "habits_usage_count_check"    CHECK ("usage_count"    >= 0),
        CONSTRAINT "habits_formation_mode_check" CHECK ("formation_mode" IN ('auto','explicit'))
      );
      CREATE INDEX IF NOT EXISTS "habits_agent_active_idx" ON "habits" ("agent_id") WHERE "is_active" = true;
      CREATE INDEX IF NOT EXISTS "habits_company_idx" ON "habits" ("company_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "habits_legacy_id_idx" ON "habits" ("legacy_id") WHERE "legacy_id" IS NOT NULL;
    `);
  });

  // 0015: drop legacy bridge columns + hippocampus schema
  await step("0015 drop legacy hippocampus", async () => {
    await sql.unsafe(`
      DROP INDEX IF EXISTS "memory_units_legacy_id_idx";
      DROP INDEX IF EXISTS "habits_legacy_id_idx";
      ALTER TABLE "memory_units" DROP COLUMN IF EXISTS "legacy_id";
      ALTER TABLE "habits"       DROP COLUMN IF EXISTS "legacy_id";
      DROP SCHEMA IF EXISTS "hippocampus" CASCADE;
    `);
  });

  // 0016: phase 7a unmigrated schemas (5 tables + agent columns + FKs + indexes)
  await step("0016 phase 7a tables and agent columns", async () => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "hierarchy_nodes" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "company_id" uuid NOT NULL,
        "friendly_id" text,
        "role" text NOT NULL,
        "title" text NOT NULL,
        "level" integer DEFAULT 0 NOT NULL,
        "parent_node_id" uuid,
        "agent_id" uuid,
        "direct_report_node_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
        "open_for_hiring" boolean DEFAULT false NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "ideas" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "company_id" uuid NOT NULL,
        "friendly_id" text,
        "core_idea" text NOT NULL,
        "current_direction" text DEFAULT '' NOT NULL,
        "refined_with_board" boolean DEFAULT false NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "meeting_schedules" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "company_id" uuid NOT NULL,
        "friendly_id" text,
        "type" text NOT NULL,
        "title" text NOT NULL,
        "interval_ms" bigint NOT NULL,
        "participant_agent_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
        "facilitator_agent_id" uuid,
        "conditional_check_enabled" boolean DEFAULT false NOT NULL,
        "enabled" boolean DEFAULT true NOT NULL,
        "last_checked_at" timestamp with time zone,
        "last_meeting_id" uuid,
        "next_check_at" timestamp with time zone,
        "skip_count" integer DEFAULT 0 NOT NULL,
        "total_runs" integer DEFAULT 0 NOT NULL,
        "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "memory_summaries" (
        "agent_id" uuid PRIMARY KEY NOT NULL,
        "company_id" uuid NOT NULL,
        "current_focus" text[] DEFAULT ARRAY[]::text[] NOT NULL,
        "recent_learnings" text[] DEFAULT ARRAY[]::text[] NOT NULL,
        "active_patterns" text[] DEFAULT ARRAY[]::text[] NOT NULL,
        "open_blockers" text[] DEFAULT ARRAY[]::text[] NOT NULL,
        "important_decisions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "strategy_briefs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "company_id" uuid NOT NULL,
        "friendly_id" text,
        "title" text DEFAULT '' NOT NULL,
        "summary" text DEFAULT '' NOT NULL,
        "first_release" text DEFAULT '' NOT NULL,
        "scope_boundary" text[] DEFAULT ARRAY[]::text[] NOT NULL,
        "role_rationale" text[] DEFAULT ARRAY[]::text[] NOT NULL,
        "status" text DEFAULT 'draft' NOT NULL,
        "created_by_agent_id" uuid,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "strategy_briefs_status_check" CHECK ("status" IN ('draft','pending_board_approval','approved','rejected','superseded'))
      );

      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "title" text DEFAULT '' NOT NULL;
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "profile" text DEFAULT '' NOT NULL;
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "capabilities" text[] DEFAULT ARRAY[]::text[] NOT NULL;
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "soul" jsonb DEFAULT '{}'::jsonb NOT NULL;
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "manager_agent_id" uuid;
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "report_agent_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'idle' NOT NULL;
      ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;
    `);

    // FKs (guarded — Postgres has no IF NOT EXISTS for ADD CONSTRAINT)
    const addFk = async (table: string, name: string, ddl: string) => {
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${name}'
              AND conrelid = 'public.${table}'::regclass
          ) THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${ddl};
          END IF;
        END $$;
      `);
    };
    await addFk("hierarchy_nodes", "hierarchy_nodes_company_id_companies_id_fk",
      `FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`);
    await addFk("hierarchy_nodes", "hierarchy_nodes_parent_node_id_hierarchy_nodes_id_fk",
      `FOREIGN KEY ("parent_node_id") REFERENCES "public"."hierarchy_nodes"("id") ON DELETE set null`);
    await addFk("hierarchy_nodes", "hierarchy_nodes_agent_id_agents_id_fk",
      `FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null`);
    await addFk("ideas", "ideas_company_id_companies_id_fk",
      `FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`);
    await addFk("meeting_schedules", "meeting_schedules_company_id_companies_id_fk",
      `FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`);
    await addFk("meeting_schedules", "meeting_schedules_facilitator_agent_id_agents_id_fk",
      `FOREIGN KEY ("facilitator_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null`);
    await addFk("meeting_schedules", "meeting_schedules_last_meeting_id_meetings_id_fk",
      `FOREIGN KEY ("last_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null`);
    await addFk("memory_summaries", "memory_summaries_agent_id_agents_id_fk",
      `FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade`);
    await addFk("memory_summaries", "memory_summaries_company_id_companies_id_fk",
      `FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`);
    await addFk("strategy_briefs", "strategy_briefs_company_id_companies_id_fk",
      `FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`);
    await addFk("strategy_briefs", "strategy_briefs_created_by_agent_id_agents_id_fk",
      `FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null`);
    await addFk("agents", "agents_manager_agent_id_agents_id_fk",
      `FOREIGN KEY ("manager_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null`);

    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "hierarchy_nodes_company_parent_idx" ON "hierarchy_nodes" USING btree ("company_id","parent_node_id");
      CREATE INDEX IF NOT EXISTS "hierarchy_nodes_company_role_idx" ON "hierarchy_nodes" USING btree ("company_id","role");
      CREATE INDEX IF NOT EXISTS "hierarchy_nodes_agent_idx" ON "hierarchy_nodes" USING btree ("agent_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "ideas_company_unique_idx" ON "ideas" USING btree ("company_id");
      CREATE INDEX IF NOT EXISTS "meeting_schedules_company_enabled_next_idx" ON "meeting_schedules" USING btree ("company_id","enabled","next_check_at") WHERE "meeting_schedules"."enabled" = true;
      CREATE INDEX IF NOT EXISTS "meeting_schedules_company_type_idx" ON "meeting_schedules" USING btree ("company_id","type");
      CREATE INDEX IF NOT EXISTS "memory_summaries_company_idx" ON "memory_summaries" USING btree ("company_id");
      CREATE INDEX IF NOT EXISTS "strategy_briefs_company_status_idx" ON "strategy_briefs" USING btree ("company_id","status");
      CREATE INDEX IF NOT EXISTS "strategy_briefs_company_created_idx" ON "strategy_briefs" USING btree ("company_id","created_at");
      CREATE INDEX IF NOT EXISTS "agents_company_status_idx" ON "agents" USING btree ("company_id","status");
      CREATE INDEX IF NOT EXISTS "agents_manager_agent_idx" ON "agents" USING btree ("manager_agent_id");
    `);
  });

  // 0017: drop legacy runtime tables (already idempotent in source)
  await step("0017 drop legacy runtime tables", async () => {
    await sql.unsafe(`
      DROP TABLE IF EXISTS "company_states" CASCADE;
      DROP TABLE IF EXISTS "beat_records"   CASCADE;
    `);
  });

  // 0018: sprint_snapshots.snapshot_data (already idempotent)
  await step("0018 sprint_snapshots.snapshot_data", async () => {
    await sql.unsafe(`
      ALTER TABLE "sprint_snapshots"
        ADD COLUMN IF NOT EXISTS "snapshot_data" jsonb NOT NULL DEFAULT '{}'::jsonb;
    `);
  });

  // 0019: skill_mutations
  await step("0019 skill_mutations", async () => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "skill_mutations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "skill_id" uuid NOT NULL,
        "company_id" uuid NOT NULL,
        "mutated_from_skill_id" uuid,
        "mutated_by_agent_id" uuid,
        "mutated_by_label" text,
        "mutation_reason" text,
        "test_cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "approved_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
    `);
    const addFk = async (name: string, ddl: string) => {
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}'
              AND conrelid = 'public.skill_mutations'::regclass) THEN
            ALTER TABLE "skill_mutations" ADD CONSTRAINT "${name}" ${ddl};
          END IF;
        END $$;
      `);
    };
    await addFk("skill_mutations_skill_id_skill_artifacts_id_fk",
      `FOREIGN KEY ("skill_id") REFERENCES "public"."skill_artifacts"("id") ON DELETE cascade`);
    await addFk("skill_mutations_company_id_companies_id_fk",
      `FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`);
    await addFk("skill_mutations_mutated_from_skill_id_skill_artifacts_id_fk",
      `FOREIGN KEY ("mutated_from_skill_id") REFERENCES "public"."skill_artifacts"("id") ON DELETE set null`);
    await addFk("skill_mutations_mutated_by_agent_id_agents_id_fk",
      `FOREIGN KEY ("mutated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null`);

    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "skill_mutations_skill_created_idx" ON "skill_mutations" USING btree ("skill_id","created_at");
      CREATE INDEX IF NOT EXISTS "skill_mutations_company_created_idx" ON "skill_mutations" USING btree ("company_id","created_at");
      CREATE INDEX IF NOT EXISTS "skill_mutations_mutated_from_idx" ON "skill_mutations" USING btree ("mutated_from_skill_id");
    `);
  });

  // Rebuild journal so future migration runs see "no pending".
  await step("rebuild drizzle.__drizzle_migrations journal", async () => {
    const entries = readJournal();
    await sql.begin(async (tx) => {
      await tx`DELETE FROM drizzle.__drizzle_migrations`;
      for (const e of entries) {
        const hash = migrationHash(e.tag);
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${e.when})`;
      }
    });
    const rows = await sql`SELECT count(*)::int FROM drizzle.__drizzle_migrations`;
    console.log(`[reconcile] journal now has ${rows[0].count} entries (expected ${entries.length})`);
  });

  console.log("[reconcile] DONE");
} finally {
  await sql.end({ timeout: 5 });
}
