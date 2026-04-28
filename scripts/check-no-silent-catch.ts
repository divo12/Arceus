#!/usr/bin/env bun
/**
 * Mandatory lint — bans silent error swallowing in production code.
 *
 * Why this exists
 * ───────────────
 * The C2 audit (~32 sites) showed how `.catch(() => {})` patterns turn the
 * runtime into a black box: DB outages, network blips, LLM failures all
 * disappear with no audit trail and no inspector signal. Rule of thumb
 * from the audit: "operators see a healthy-looking server with diverging
 * DB state, phantom memories, broken audit trails."
 *
 * What it bans
 * ────────────
 * - `.catch(() => {})` — bare swallow
 * - `.catch(() => null)` / `.catch(() => undefined)` in production (web is exempt; see `IGNORE`)
 * - `.catch(console.warn)` / `.catch(console.error)` — log-and-drop
 * - Empty `catch (err) {}` blocks
 *
 * Allowed
 * ───────
 * - `swallowAndAudit(...)` / `swallowAndReport(...)` from `apps/api/src/observability/swallow.ts`
 * - Any catch followed by `// silent: <reason>` justification comment
 * - Lines marked `// eslint-disable-next-line silent-catch`
 *
 * Wiring
 * ──────
 * - Manual: `bun scripts/check-no-silent-catch.ts`
 * - Pre-commit (recommended): hook this into the same place that runs
 *   `db:lint-migrations` — both are blocking lints for ~the same class
 *   of bug (operational invisibility).
 *
 * Exit code 0 = clean, 1 = violations found (with line numbers).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const SCAN_DIRS = [
  "apps/api/src",
  "packages/company-runtime/src",
  "packages/hippocampus/src",
  "packages/db/src",
  "packages/contracts/src",
  "packages/arceus-mcp/src",
  "packages/task-engine/src",
];

const SKIP_FILE_PATTERNS = [
  /\.test\.ts$/,
  /\.e2e-test\.ts$/,
  /\bnode_modules\b/,
  /\/dist\//,
  /\bobservability\/swallow\.ts$/, // the helper itself defines the patterns
];

interface Violation {
  path: string;
  line: number;
  pattern: string;
  source: string;
}

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "bare_swallow", re: /\.catch\(\(\)\s*=>\s*\{\s*\}\)/ },
  { name: "return_null", re: /\.catch\(\(\)\s*=>\s*null\)/ },
  { name: "return_undefined", re: /\.catch\(\(\)\s*=>\s*(undefined|void 0)\)/ },
  { name: "log_and_drop", re: /\.catch\(console\.(warn|error|log)\)/ },
  // .catch(err => console.warn(...)) where the body is a single console.* call
  // and nothing else (no audit, no rethrow).
  {
    name: "console_only_catch",
    re: /\.catch\(\(?\w*\)?\s*=>\s*console\.(warn|error|log)\([^)]*\)\)/,
  },
];

// Empty catch blocks — match `catch (...) { }` with optional whitespace.
const EMPTY_CATCH_RE = /catch\s*\([^)]*\)\s*\{\s*\}/;

function shouldSkip(file: string): boolean {
  return SKIP_FILE_PATTERNS.some((re) => re.test(file));
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: Awaited<ReturnType<typeof readdirSync>>;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, out);
    } else if (
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !shouldSkip(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

function checkFile(file: string): Violation[] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Allow opt-out comment on the same or prior line.
    const prior = i > 0 ? lines[i - 1] : "";
    if (
      /\/\/\s*silent:/i.test(line) ||
      /\/\/\s*silent:/i.test(prior) ||
      /\/\/\s*eslint-disable.*silent-catch/i.test(line) ||
      /\/\/\s*eslint-disable.*silent-catch/i.test(prior)
    ) {
      continue;
    }

    // Skip if the entire line is a comment (// ... or * inside a JSDoc block)
    // — the patterns sometimes appear as documentation, not code.
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }

    for (const { name, re } of PATTERNS) {
      const match = re.exec(line);
      if (match) {
        // Skip if the match is inside an inline `//` comment.
        const commentIdx = line.indexOf("//");
        if (commentIdx >= 0 && match.index >= commentIdx) continue;
        violations.push({
          path: file,
          line: i + 1,
          pattern: name,
          source: line.trim(),
        });
      }
    }
    const emptyMatch = EMPTY_CATCH_RE.exec(line);
    if (emptyMatch) {
      const commentIdx = line.indexOf("//");
      if (commentIdx >= 0 && emptyMatch.index >= commentIdx) continue;
      violations.push({
        path: file,
        line: i + 1,
        pattern: "empty_catch",
        source: line.trim(),
      });
    }
  }
  return violations;
}

function main(): number {
  const all: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = resolve(ROOT, dir);
    const files = walk(abs);
    for (const f of files) all.push(...checkFile(f));
  }

  if (all.length === 0) {
    console.log("[silent-catch] clean — no swallowed errors found.");
    return 0;
  }

  console.error(`[silent-catch] ${all.length} violation(s) found:\n`);
  for (const v of all) {
    const rel = relative(ROOT, v.path);
    console.error(`  ${rel}:${v.line}  [${v.pattern}]`);
    console.error(`    ${v.source}`);
  }
  console.error(
    "\nFix: replace with `swallowAndAudit(where, fn, ctx)` from " +
      "`apps/api/src/observability/swallow.ts`, or annotate with " +
      "`// silent: <reason>` if the swallow is intentional " +
      "(shutdown teardown, parse-loop skip, etc).",
  );
  return 1;
}

process.exit(main());
