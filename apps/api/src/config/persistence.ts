/**
 * Persistence configuration.
 * Supabase credentials, database URLs, storage buckets, and workspace root.
 */
import { readAliasedOptionalEnv, readOptionalEnv } from "./env";

const defaultWorkspaceRoot = process.platform === "win32" ? "Q:/arceus-ws" : "/tmp/workspaces";

const supabaseUrl = readAliasedOptionalEnv("SUPABASE_URL", [
  "PAPERCLIP_STORAGE_SUPABASE_PROJECT_URL",
]);

const supabaseServiceRoleKey = readAliasedOptionalEnv("SUPABASE_SERVICE_ROLE_KEY", [
  "PAPERCLIP_STORAGE_SUPABASE_SERVICE_ROLE_KEY",
]);

const directDatabaseUrl = readAliasedOptionalEnv("SUPABASE_DB_URL", []);
const fallbackDatabaseUrl = readAliasedOptionalEnv("ARCEUS_HIPPOCAMPUS_POSTGRES_URL", [
  "DATABASE_URL",
]);

export const persistenceConfig = {
  supabase: {
    url: supabaseUrl,
    serviceRoleKey: supabaseServiceRoleKey,
    configured: Boolean(supabaseUrl && supabaseServiceRoleKey),
  },
  database: {
    directUrl: directDatabaseUrl,
    fallbackUrl: fallbackDatabaseUrl,
    url: directDatabaseUrl || fallbackDatabaseUrl,
    mode: directDatabaseUrl ? "direct" : fallbackDatabaseUrl ? "fallback" : "disabled",
    configured: Boolean(directDatabaseUrl || fallbackDatabaseUrl),
  },
  storage: {
    workspaceBucket: readAliasedOptionalEnv("SUPABASE_STORAGE_BUCKET", [
      "PAPERCLIP_STORAGE_SUPABASE_BUCKET",
    ], "arceus-workspaces"),
    assetsBucket: readOptionalEnv("SUPABASE_ASSETS_BUCKET", "arceus-assets"),
  },
  workspace: {
    root: readOptionalEnv("ARCEUS_WORKSPACE_ROOT", defaultWorkspaceRoot),
  },
};

/** Check whether Supabase storage credentials are configured. */
export function isSupabaseConfigured() {
  return persistenceConfig.supabase.configured;
}