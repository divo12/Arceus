/**
 * Migration runner with Postgres advisory lock — Spec 31 Phase 8.5.
 *
 * Replaces `drizzle-kit migrate` for production deploys. Two API pods
 * deploying simultaneously would otherwise both call into drizzle-kit's
 * migrator, race on `CREATE TABLE`, and one would fail with SQLSTATE
 * 42P07 + leave the `__drizzle_migrations` journal in a "marked failed"
 * state that requires manual recovery.
 *
 * With this runner, the second pod blocks at `pg_advisory_lock`, then
 * runs into "no pending migrations" and exits cleanly.
 *
 * Run via:  bun packages/db/src/scripts/apply-migrations.ts
 * Or:       bun --filter @arceus/db run db:migrate
 */
import "../load-env.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixed advisory-lock key — Postgres advisory locks are session-scoped
 * numeric tokens with no namespace, so the constant must be globally
 * unique across applications sharing the cluster. `pg_locks` will show
 * this exact value.
 *
 * Inlined as a SQL literal (not a bound parameter) because postgres.js
 * doesn't auto-bind JS bigint, and pg_advisory_lock takes int8 — Number
 * can't represent the int8 max safely. Hard-coded constant is fine: the
 * value is a public coordination key, not a secret.
 */
const ADVISORY_LOCK_KEY_SQL = "9223372036854775807"; // int8 max

function readDatabaseUrl(): string {
  const url =
    process.env.SUPABASE_DB_URL?.trim() ||
    process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "[apply-migrations] No database URL set. Provide SUPABASE_DB_URL, " +
        "ARCEUS_HIPPOCAMPUS_POSTGRES_URL, or DATABASE_URL.",
    );
  }
  return url;
}

function migrationsFolder(): string {
  // ESM-safe __dirname equivalent — the scripts live in
  // packages/db/src/scripts so the migrations dir is "../migrations".
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "migrations");
}

async function main(): Promise<void> {
  const databaseUrl = readDatabaseUrl();
  const folder = migrationsFolder();
  console.log(`[apply-migrations] folder: ${folder}`);
  console.log(`[apply-migrations] taking advisory lock ${ADVISORY_LOCK_KEY_SQL} …`);

  // Single-connection client so the advisory lock is held continuously
  // for the lifetime of the migration run. Postgres advisory locks are
  // session-scoped — releasing requires the same backend that took it.
  const client = postgres(databaseUrl, { max: 1, prepare: false });

  try {
    await client.unsafe(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY_SQL})`);
    console.log("[apply-migrations] lock acquired, applying migrations …");

    const db = drizzle(client);
    await migrate(db, { migrationsFolder: folder });

    console.log("[apply-migrations] done.");
  } finally {
    // pg_advisory_unlock returns boolean (true if unlocked, false if not held).
    // Wrapped in catch so a failure in the unlock itself can't mask the
    // primary error from the migrate call.
    try {
      await client.unsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY_SQL})`);
    } catch (err) {
      console.warn("[apply-migrations] advisory unlock failed:", err);
    }
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[apply-migrations] FAIL:", err);
  process.exit(1);
});
