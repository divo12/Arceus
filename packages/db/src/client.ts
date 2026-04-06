import "./load-env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { DatabaseAdapter, DatabaseConnectionConfig, DatabaseHealth, EntityName, EntityRecordMap } from "./types";

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

function readAliasedEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return "";
}

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

export function getDatabaseConnectionConfig(): DatabaseConnectionConfig | null {
  const supabaseUrl = readAliasedEnv(["SUPABASE_URL", "PAPERCLIP_STORAGE_SUPABASE_PROJECT_URL"]);
  const supabaseServiceRoleKey = readAliasedEnv(["SUPABASE_SERVICE_ROLE_KEY", "PAPERCLIP_STORAGE_SUPABASE_SERVICE_ROLE_KEY"]);
  const databaseUrl = readAliasedEnv(["SUPABASE_DB_URL", "ARCEUS_HIPPOCAMPUS_POSTGRES_URL", "DATABASE_URL"]);

  if (!supabaseUrl || !supabaseServiceRoleKey || !databaseUrl) {
    return null;
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    databaseUrl,
    mode: getDatabaseRuntimeMode(databaseUrl),
  };
}

export function isSupabaseConfigured() {
  const config = getDatabaseConnectionConfig();
  return Boolean(config?.supabaseUrl && config.supabaseServiceRoleKey);
}

export function isDatabaseConfigured() {
  return Boolean(getDatabaseConnectionConfig()?.databaseUrl);
}

export function getDb() {
  const config = getDatabaseConnectionConfig();
  if (!config?.databaseUrl) {
    throw new Error("Database is not configured. Set SUPABASE_DB_URL or a supported fallback URL.");
  }

  if (!sqlClient) {
    sqlClient = postgres(config.databaseUrl, {
      max: 5,
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

export async function closeDbConnections() {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
  }

  dbClient = null;
  supabaseClient = null;
}

export class NoopDatabaseAdapter implements DatabaseAdapter {
  readonly kind = "noop" as const;

  private readonly store = new Map<EntityName, Map<string, unknown>>();

  async list<K extends EntityName>(entity: K): Promise<Array<EntityRecordMap[K]>> {
    return Array.from(this.getEntityStore(entity).values()).map((record) => cloneRecord(record as EntityRecordMap[K]));
  }

  async getById<K extends EntityName>(entity: K, id: string): Promise<EntityRecordMap[K] | null> {
    const record = this.getEntityStore(entity).get(id);
    return record ? cloneRecord(record as EntityRecordMap[K]) : null;
  }

  async upsert<K extends EntityName>(entity: K, record: EntityRecordMap[K] & { id: string }): Promise<EntityRecordMap[K]> {
    this.getEntityStore(entity).set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async delete<K extends EntityName>(entity: K, id: string): Promise<boolean> {
    return this.getEntityStore(entity).delete(id);
  }

  async healthCheck(): Promise<DatabaseHealth> {
    return {
      ok: true,
      kind: this.kind,
      details: "In-memory adapter active. Replace with PostgreSQL/Drizzle in Spec 04."
    };
  }

  private getEntityStore(entity: EntityName) {
    let bucket = this.store.get(entity);
    if (!bucket) {
      bucket = new Map<string, unknown>();
      this.store.set(entity, bucket);
    }
    return bucket;
  }
}

export function createNoopDatabaseAdapter() {
  return new NoopDatabaseAdapter();
}