import "../src/load-env";
import postgres from "postgres";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = process.env.SUPABASE_DB_URL || process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL || process.env.DATABASE_URL;
if (!url) { console.error("No DB URL found"); process.exit(1); }

const sql = postgres(url);
const migration = readFileSync(resolve(__dirname, "003_service_registry.sql"), "utf8");
const cleaned = migration.replace(/^\s*BEGIN\s*;/mi, "").replace(/^\s*COMMIT\s*;/mi, "");
await sql.begin(async (tx) => {
  await tx.unsafe(cleaned);
});
console.log("Migration 003_service_registry applied successfully");
await sql.end();
