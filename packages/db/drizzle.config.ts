import "./src/load-env";
import { defineConfig } from "drizzle-kit";

function readAliasedEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return "";
}

const url = readAliasedEnv(["SUPABASE_DB_URL", "ARCEUS_HIPPOCAMPUS_POSTGRES_URL", "DATABASE_URL"]);

// Spec 31 — drizzle-kit targets the new normalized schema dir.
// Legacy tables.ts + drizzle/migrations are retained on disk for reference
// until Phase 7 deletes them.
export default defineConfig({
  schema: "./src/schema/*.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
});