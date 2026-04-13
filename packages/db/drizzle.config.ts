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

export default defineConfig({
  out: "./drizzle/migrations",
  schema: "./src/tables.ts",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
});