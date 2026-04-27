/**
 * @module db/client
 * Database connection management.
 *
 * Provides Drizzle ORM (postgres.js) and Supabase clients with lazy
 * singletons. Reads connection config from env vars with multiple
 * alias fallbacks.
 */
import "./load-env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { DatabaseConnectionConfig, DatabaseHealth } from "./types";

/** Reads the first non-empty value from a list of env var names. */
function readAliasedEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return "";
}

/** Determines if the database is direct-connected or using a fallback URL. */
function getDatabaseRuntimeMode(databaseUrl: string): DatabaseConnectionConfig["mode"] {
  if (!databaseUrl) {
    return "disabled";
  }

  return process.env.SUPABASE_DB_URL?.trim() ? "direct" : "fallback";
}

export type DbClient = PostgresJsDatabase<Record<string, never>>;

let dbClient: DbClient | null = null;
let sqlClient: postgres.Sql | null = null;
let supabaseClient: SupabaseClient | null = null;

/** Builds a DatabaseConnectionConfig from env vars, or null if DATABASE_URL is missing.
 *  Supabase-specific fields are optional and only consulted by `getSupabaseClient`. */
export function getDatabaseConnectionConfig(): DatabaseConnectionConfig | null {
  const databaseUrl = readAliasedEnv(["SUPABASE_DB_URL", "ARCEUS_HIPPOCAMPUS_POSTGRES_URL", "DATABASE_URL"]);
  if (!databaseUrl) {
    return null;
  }
  const supabaseUrl = readAliasedEnv(["SUPABASE_URL", "PAPERCLIP_STORAGE_SUPABASE_PROJECT_URL"]);
  const supabaseServiceRoleKey = readAliasedEnv(["SUPABASE_SERVICE_ROLE_KEY", "PAPERCLIP_STORAGE_SUPABASE_SERVICE_ROLE_KEY"]);

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    databaseUrl,
    mode: getDatabaseRuntimeMode(databaseUrl),
  };
}

/** Returns true if Supabase URL + service role key are set. */
export function isSupabaseConfigured() {
  const config = getDatabaseConnectionConfig();
  return Boolean(config?.supabaseUrl && config.supabaseServiceRoleKey);
}

/** Returns true if any supported database URL env var is set. */
export function isDatabaseConfigured() {
  return Boolean(getDatabaseConnectionConfig()?.databaseUrl);
}

/**
 * Default pool size when `ARCEUS_DB_POOL_SIZE` isn't set.
 *
 * Sizing guidance (Spec 31 §Phase 8.5): scale to ~`(api replicas × 10)`
 * connections so a single pod restart doesn't exhaust the Postgres
 * connection pool. Raise via `ARCEUS_DB_POOL_SIZE` in production; ensure
 * `max_connections` on the DB is sized appropriately
 * (`max_connections >= replicas × pool_size + headroom`).
 */
const DEFAULT_POOL_SIZE = 10;

function readPoolSize(): number {
  const raw = process.env.ARCEUS_DB_POOL_SIZE?.trim();
  if (!raw) return DEFAULT_POOL_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(
      `[@arceus/db] ARCEUS_DB_POOL_SIZE="${raw}" is not a positive integer; falling back to ${DEFAULT_POOL_SIZE}.`,
    );
    return DEFAULT_POOL_SIZE;
  }
  return parsed;
}

/**
 * Validate the database URL at first `getDb()` call. Production:
 * fail-loud with a clear error so the deploy crashes before serving
 * traffic. Dev: soft-warn so a misconfigured `.env.local` still
 * boots into a sensible default for local hacking.
 *
 * Same pattern as `bearer.resolveBearerToken` (spec 25 §3.5) — known
 * good for "must be set in prod, optional in dev".
 */
function resolveDatabaseUrl(): string {
  const config = getDatabaseConnectionConfig();
  if (config?.databaseUrl) return config.databaseUrl;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[@arceus/db] DATABASE_URL (or SUPABASE_DB_URL / ARCEUS_HIPPOCAMPUS_POSTGRES_URL) " +
        "is required in production. Refusing to start with no persistence.",
    );
  }

  console.warn(
    "[@arceus/db] No DATABASE_URL set; falling back to local default postgresql://localhost:5432/arceus_dev. " +
      "This is dev-only — set DATABASE_URL before deploying.",
  );
  return "postgresql://localhost:5432/arceus_dev";
}

/** Returns the singleton Drizzle client, creating it on first call. Throws in production
 *  if DB not configured (dev falls back to localhost with a warning). */
export function getDb() {
  if (!sqlClient) {
    const databaseUrl = resolveDatabaseUrl();
    sqlClient = postgres(databaseUrl, {
      max: readPoolSize(),
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  if (!dbClient) {
    dbClient = drizzle(sqlClient);
  }

  return dbClient;
}

/** Returns the singleton Supabase client. Throws if not configured. */
export function getSupabaseClient() {
  const config = getDatabaseConnectionConfig();
  if (!config?.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or supported compatibility aliases.");
  }

  if (!supabaseClient) {
    supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return supabaseClient;
}

/** Pings the database and returns health status. */
export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  const config = getDatabaseConnectionConfig();
  if (!config) {
    return {
      ok: false,
      kind: "postgres",
      details: "Persistence disabled. Falling back to in-memory mode.",
    };
  }

  try {
    await getDb().execute(sql`select 1`);
    return {
      ok: true,
      kind: "postgres",
      details: `Database configured in ${config.mode} mode.`,
    };
  } catch (error) {
    return {
      ok: false,
      kind: "postgres",
      details: error instanceof Error ? error.message : "Unknown database error",
    };
  }
}

/** Closes all database connections and resets singletons. */
export async function closeDbConnections() {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
  }

  dbClient = null;
  supabaseClient = null;
}

