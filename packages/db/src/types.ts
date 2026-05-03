/**
 * @module db/types
 * Connection-config types for the postgres.js + Supabase clients in
 * `client.ts`. The legacy `EntityName` / `DatabaseAdapter` /
 * `TableDefinition` triad backed an in-memory adapter that the spec
 * 31 redesign retired — drizzle queries against `schema/*` are the
 * only persistence path now.
 */
export interface DatabaseHealth {
  ok: boolean;
  kind: string;
  details?: string;
}

export type DatabaseRuntimeMode = "disabled" | "direct" | "fallback";

export interface DatabaseConnectionConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  databaseUrl: string;
  mode: DatabaseRuntimeMode;
}
