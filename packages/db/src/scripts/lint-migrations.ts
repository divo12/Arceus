/**
 * Migration linter — Spec 31 Phase 8.5.
 *
 * Fails CI if any single migration file mixes DDL (schema change) with
 * DML (data change). The standard SQL anti-pattern: a half-applied
 * mixed migration leaves the schema migrated AND the backfill partial,
 * which is the worst kind of failure to recover from.
 *
 * Separating concerns means:
 *   - Schema changes can be rolled forward without partial backfill.
 *   - Data backfills can be retried (idempotent INSERT…ON CONFLICT) without
 *     re-applying schema.
 *   - The journal table reflects logical units, not entangled work.
 *
 * Run via:  bun packages/db/src/scripts/lint-migrations.ts
 * Or:       bun --filter @arceus/db run db:lint-migrations
 *
 * Exit 0 if clean. Exit 1 if any file mixes; the offending file + matched
 * keywords are printed to stderr.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keywords match as statement-starting tokens — anchored to start-of-line
 * (after optional whitespace) so trigger bodies and DEFAULT clauses don't
 * false-positive. e.g. `CREATE TRIGGER ... BEFORE UPDATE ON foo` does NOT
 * match the DML `UPDATE` (the keyword is in the middle of a CREATE
 * TRIGGER, not opening a new statement).
 */
const DDL_KEYWORDS = [
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "CREATE INDEX",
  "CREATE UNIQUE INDEX",
  "DROP INDEX",
  "CREATE SCHEMA",
  "DROP SCHEMA",
  "CREATE TYPE",
  "DROP TYPE",
  "ALTER TYPE",
];

const DML_KEYWORDS = [
  "INSERT INTO",
  "UPDATE",
  "DELETE FROM",
];

/**
 * Lines that look like DML but are actually drizzle's bookkeeping
 * (writes to its `__drizzle_migrations` journal table). The journal
 * tracks which migrations have run and lives outside the schema-vs-data
 * distinction.
 */
const DML_ALLOWLIST_PATTERNS: readonly RegExp[] = [
  /__drizzle_migrations/i,
  /drizzle\.__drizzle_migrations/i,
];

interface LintHit {
  kind: "ddl" | "dml";
  keyword: string;
  line: number;
  text: string;
}

/**
 * Build a statement-anchored regex for a keyword. Matches when the
 * keyword appears at the start of a line (after optional whitespace),
 * which is the convention for a statement opener. Avoids false-positives
 * inside CREATE TRIGGER bodies, DEFAULT clauses, or strings.
 *
 * Case-insensitive; word-boundary on the trailing edge so "UPDATE"
 * doesn't match "UPDATEXYZ".
 */
function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\b`, "im");
}

function findKeywordsInFile(text: string, keywords: string[], kind: LintHit["kind"]): LintHit[] {
  const hits: LintHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const stripped = stripCommentsAndStrings(raw);
    for (const kw of keywords) {
      if (keywordRegex(kw).test(stripped)) {
        // Skip if any allowlist pattern matches this line — drizzle's
        // own migration journal writes show up as INSERT INTO but aren't
        // user data.
        if (DML_ALLOWLIST_PATTERNS.some((re) => re.test(raw))) continue;
        hits.push({ kind, keyword: kw, line: i + 1, text: raw.trim() });
        break;
      }
    }
  }
  return hits;
}

/**
 * Remove SQL line comments (-- ...), block comments (slash-star ... star-slash),
 * and string literals before keyword matching, so a comment like
 * `-- INSERT INTO foo` or a string like `'CREATE TABLE'` doesn't false-
 * positive. Block comments spanning lines are left intact (rare in real
 * migrations).
 */
function stripCommentsAndStrings(line: string): string {
  let out = line.replace(/--.*$/, "");
  out = out.replace(/\/\*[^]*?\*\//g, " ");
  out = out.replace(/'(?:[^']|'')*'/g, "''");
  out = out.replace(/"(?:[^"]|"")*"/g, '""');
  return out;
}

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "migrations");
}

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
}

interface FileViolation {
  file: string;
  ddlHits: LintHit[];
  dmlHits: LintHit[];
}

function lintFile(file: string): FileViolation | null {
  const text = readFileSync(file, "utf-8");
  const ddlHits = findKeywordsInFile(text, DDL_KEYWORDS, "ddl");
  const dmlHits = findKeywordsInFile(text, DML_KEYWORDS, "dml");
  if (ddlHits.length > 0 && dmlHits.length > 0) {
    return { file, ddlHits, dmlHits };
  }
  return null;
}

function main(): void {
  const dir = migrationsDir();
  const files = listMigrationFiles(dir);
  console.log(`[lint-migrations] checking ${files.length} migration file(s) in ${dir}`);

  const violations: FileViolation[] = [];
  for (const file of files) {
    const v = lintFile(file);
    if (v) violations.push(v);
  }

  if (violations.length === 0) {
    console.log("[lint-migrations] clean — no migration mixes DDL with DML.");
    process.exit(0);
  }

  console.error(`\n[lint-migrations] FAIL — ${violations.length} migration(s) mix DDL with DML:\n`);
  for (const v of violations) {
    const name = v.file.split("/").pop() ?? v.file;
    console.error(`  ${name}`);
    for (const hit of v.ddlHits) {
      console.error(`    DDL  L${hit.line}  ${hit.keyword}  →  ${hit.text.slice(0, 80)}`);
    }
    for (const hit of v.dmlHits) {
      console.error(`    DML  L${hit.line}  ${hit.keyword}  →  ${hit.text.slice(0, 80)}`);
    }
    console.error("");
  }
  console.error(
    "Split each into two migrations: one for the schema change, one for the data change.\n" +
      "Allowed DML inside DDL migrations: writes to drizzle's __drizzle_migrations journal\n" +
      "(drizzle handles those itself; if you wrote one manually, add it to DML_ALLOWLIST_PATTERNS).",
  );
  process.exit(1);
}

main();
