---
title: Arceus Code Audit — Fix Proposals
started: 2026-04-19
pairs-with: flaws.md
---

# Arceus Code Audit — Fix Proposals

One detailed fix proposal per `F-NNN` entry in `flaws.md`. 1:1 mapping. Each fix includes: root-cause summary, concrete code, migration order, and verification step.

Ordering below matches `flaws.md` — same IDs, same progression.

---

## F-001 · Replace error-suppressing process handlers with fail-fast + structured crash log

**Flaw it pairs with:** global `unhandledRejection` + `uncaughtException` handlers that keep the process alive.

**Root cause:** the handlers were likely added to mask a noisy async bug in development. The comment ("Prevent … from killing the process") reveals the intent. Suppression leaves the process in undefined state; in an agent-orchestration system this is catastrophic (partial DB writes, scheduler still firing, silent boot failure).

**Proposed code** — replace `server.ts:1-7` with:

```ts
import { serializeError } from "serialize-error"; // add as dep; or hand-roll (see below)

// Crash hooks must be installed BEFORE any other module side-effects so
// early-boot errors (e.g. config load, env parse) are captured.
process.on("unhandledRejection", (reason) => {
  void handleFatalError("unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  void handleFatalError("uncaughtException", err);
});

async function handleFatalError(kind: "unhandledRejection" | "uncaughtException", raw: unknown) {
  const serialized = serializeError(raw); // name, message, stack, cause chain
  // 1. Always stderr — durable even if audit ledger is broken.
  console.error(JSON.stringify({ event: "process.fatal", kind, error: serialized, pid: process.pid, ts: new Date().toISOString() }));
  // 2. Best-effort audit drain — don't wait forever, but give it a chance.
  try {
    await Promise.race([
      drainAuditLedger(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("audit-drain-timeout")), 3000)),
    ]);
  } catch (drainErr) {
    console.error("[FATAL] audit drain failed:", drainErr);
  }
  // 3. Exit non-zero; supervisor restarts us.
  process.exit(1);
}
```

Hand-rolled `serializeError` if the dep is unwanted:
```ts
function serializeError(e: unknown, depth = 5): Record<string, unknown> {
  if (depth === 0 || !(e instanceof Error)) return { value: String(e) };
  return {
    name: e.name,
    message: e.message,
    stack: e.stack,
    cause: e.cause !== undefined ? serializeError(e.cause, depth - 1) : undefined,
  };
}
```

**Deployment requirement:** confirm the runtime has a supervisor that restarts the process on `exit(1)` — Docker (`restart: unless-stopped`), Railway (default), pm2 (`pm2 start … --restart-delay`), systemd (`Restart=on-failure`). If none, crashing = downtime; add a supervisor *before* landing this fix.

**Verification:**
1. Add an integration test that `throw`s from a fake route handler and asserts the process exits with code 1.
2. Wire a Docker healthcheck or platform probe against `/api/health` and confirm the supervisor restarts within the expected window.
3. Confirm audit ledger contains a `process.fatal` event after a forced crash in staging.

**Effort:** 1-2 hours including the supervisor audit.

---

## F-002 · Shrink the durability gap today; plan for DB-first reads tomorrow

**Flaw it pairs with:** full `CompanySnapshot` held in process RAM as a write-back cache.

**Root cause:** the pattern is an artifact of Arceus starting as a single-tenant prototype. RAM-as-source-of-truth gave speed and simplicity early; the migration cost is now higher because `getSnapshot()` is pervasive.

**Three-stage fix**, scale-gated:

### Stage A — Short-term (ship within the current sprint)

Goal: make the durability gap observable and small.

1. **Flush cadence:** change `flush()` from periodic to **immediate** on every mutation that crosses a write boundary. The `upsert*` / `update*` helpers in `store.ts` should enqueue a pending write AND trigger a debounced flush (50-200 ms) rather than relying on a timer. For high-stakes mutations (`setTaskStatus`, `commitBeatRecord`, governance approvals), flush synchronously before returning.
2. **Observability hooks:** emit metrics at the store layer:
   - `arceus.store.pending_writes_depth` (gauge)
   - `arceus.store.time_since_flush_ms` (gauge)
   - `arceus.store.mutation_count_total` (counter, by entity kind)
   Graph these; alert when `time_since_flush_ms > 5000` or depth > 100.
3. **Transactional boundary helper:** add a `withStoreTransaction(mutate, audit)` helper so every mutation is paired with its audit emit and flushed atomically.

### Stage B — Medium-term (next 1-2 sprints, when scaling to 2 processes)

Goal: kill the global singleton; move to DB-first access with per-request snapshots.

1. **Introduce `loadSnapshotForRequest(companyId, ctx)`** in `persistence/store.ts`. It performs a single indexed query that returns only the data the current request needs (partial snapshot, not full). Backed by Drizzle relational queries.
2. **Deprecate `getSnapshot()`** incrementally. New call sites use `ctx.snapshot` (bound by Fastify's `onRequest` hook); old sites get grep-migrated in batches.
3. **Mutations become SQL-first.** `upsertTask` becomes a direct Drizzle `insert().onConflictDoUpdate(...)` call, returning the row — no separate cache update. The in-memory snapshot, if still used, is refreshed from the returned row only for the current request.
4. **Route-scoped cache.** Wrap pure derivations in React 19 `cache()` (server components only) or a request-scoped `Map` injected by middleware. Lifetime = one request.

### Stage C — Long-term (when horizontal scale or event-replay is needed)

Goal: multi-process safety + event sourcing for audit.

1. **Shared cache (Redis/Valkey)** for hot reads that are expensive DB-side (sprint summaries, agent rosters).
2. **Transactional outbox** → bus → projections. The `audit_events` table already carries the shape; promote it to a real outbox with offset tracking, and have projections (in-memory caches, search indexes, etc.) subscribe.
3. **Event replay** becomes the recovery story instead of `hydrate()`.

**Verification (Stage A):**
- Inject a test crash between mutation and flush; measure lost work in the before/after case.
- Load test: 100 concurrent mutations, verify `time_since_flush_ms` stays <500 ms p95.

**Effort:**
- Stage A: 2-3 days.
- Stage B: 1-2 weeks of incremental migration.
- Stage C: only when scale pressure appears; 3-4 weeks.

---

## F-003 · Recover the missing `apps/api/src/workspace/` directory, then clean `dist/`

**Flaw it pairs with:** `./workspace/manager.js` import target doesn't exist; 49 tsc errors.

**Root cause:** commit `5984bec` ("spec-14: decompose orchestrator + server into domain modules") deleted `apps/api/src/workspace-manager.ts` + `workspace-scaffold.ts` as part of a refactor but didn't commit the replacement `workspace/` directory. The dev loop hides the problem because `apps/api/dist/workspace-*.js` files from the pre-refactor build are still on disk and get resolved first by Node in some paths.

**Step 1 — Locate the lost files.**

```bash
# Check all local branches + reflog for a tree containing workspace/manager.ts
git log --all --diff-filter=A --oneline -- "apps/api/src/workspace/manager.ts"
git log --all --diff-filter=A --oneline -- "apps/api/src/workspace/"
git fsck --lost-found  # may surface dangling trees with the new layout
# Check worktrees
git worktree list
find .claude/worktrees -type f -name "manager.ts" 2>/dev/null
# Check remote branches
git ls-remote origin | grep -iE "spec-14|workspace|progdisc"
```

If any of those surface a blob with the refactored layout, cherry-pick the add commits or `git checkout <sha> -- apps/api/src/workspace/`.

**Step 2 — If nothing recovers, reconstruct from evidence.**

The pre-refactor sources are visible in git history:
```bash
git show 5984bec^:apps/api/src/workspace-manager.ts > /tmp/old-workspace-manager.ts
git show 5984bec^:apps/api/src/workspace-scaffold.ts > /tmp/old-workspace-scaffold.ts
```

The call sites tell you what the new modules must export:
```bash
git grep -n "workspaceManager\." -- 'apps/*' 'packages/*' | sort -u
git grep -nE "from ['\"](\./|\.\./)+workspace/(manager|monitor|scaffold|watchdog|preview|entry-check)" -- 'apps/*'
```

Expected new modules (inferred from import names):
- `apps/api/src/workspace/manager.ts` — from `workspace-manager.ts`, probably owning `workspaceManager` singleton + `getLegacyProductDir` (rename while you're here, see F-006).
- `apps/api/src/workspace/scaffold.ts` — scaffolding new workspaces.
- `apps/api/src/workspace/monitor.ts` — filesystem monitoring.
- `apps/api/src/workspace/watchdog.ts` — stall/liveness detection.
- `apps/api/src/workspace/preview.ts` — dev-server preview logic.
- `apps/api/src/workspace/entry-check.ts` — workspace entry-point validation.

Reassemble by splitting the old flat files along the import-name boundary.

**Step 3 — Re-enable typecheck as a gate.**

Add to CI (`.github/workflows/ci.yml` or equivalent):
```yaml
- name: typecheck
  run: pnpm -r exec -- tsc --noEmit
```

Also add a pre-commit hook (`husky` + `lint-staged`) running `tsc --noEmit` on staged TS files — prevents this regression class from landing again.

**Step 4 — Clean `dist/`.**

```bash
rm -rf apps/api/dist
echo "apps/api/dist/" >> .gitignore  # if not already
# verify no scripts reference dist before the build step
git grep -n "apps/api/dist" -- package.json scripts/ apps/
```

Verify `apps/api/package.json` start script runs from source in dev (`tsx src/server.ts`) and from a *fresh* build in prod (`node dist/server.js` after `tsc -b`).

**Verification:**
1. `pnpm -r exec -- tsc --noEmit` returns 0 errors.
2. `pnpm dev` in `apps/api/` boots without a `Cannot find module` error.
3. Cold Docker build succeeds.

**Effort:** if the files recover cleanly, 1-2 hours. If reconstructing from scratch, 4-8 hours.

---

## F-004 · Centralize `ARCEUS_PERSISTENCE_MODE` as a Zod-validated, type-safe config

**Flaw it pairs with:** duplicated read, no enum validation.

**Root cause:** no shared config module for this flag; two sites did the minimum defensive parse independently.

**Proposed code:**

1. Create `apps/api/src/config/persistence.ts`:

```ts
import { z } from "zod";

export const persistenceModeSchema = z.enum(["local", "supabase"]); // extend as modes are added
export type PersistenceMode = z.infer<typeof persistenceModeSchema>;

const raw = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
const parsed = persistenceModeSchema.safeParse(raw);

if (!parsed.success) {
  const allowed = persistenceModeSchema.options.join(" | ");
  throw new Error(
    `Invalid ARCEUS_PERSISTENCE_MODE="${raw}". Allowed values: ${allowed}.`,
  );
}

export const persistenceMode: PersistenceMode = parsed.data;
```

2. Re-export from `apps/api/src/config/index.ts`:

```ts
export { persistenceMode, persistenceModeSchema, type PersistenceMode } from "./persistence.js";
```

3. Replace the two inline reads.

**In `apps/api/src/server.ts`:**
```ts
// before (line 70-71)
const persistenceMode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
console.log(`[STARTUP] Company state persistence mode: ${persistenceMode}`);

// after
import { persistenceMode } from "./config/persistence.js";
app.log.info({ event: "startup.config", persistenceMode }, `persistence mode: ${persistenceMode}`);
```

**In `apps/api/src/persistence/company-state.ts:11`:**
```ts
// before
const mode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
if (mode === "supabase") { ... }

// after
import { persistenceMode } from "../config/persistence.js";
if (persistenceMode === "supabase") { ... }  // exhaustive type-narrowed
```

4. **Compile-time exhaustiveness.** Any `switch (persistenceMode) { case "local": … }` block now gets exhaustiveness checking via `assertNever(x: never)` in the default branch.

**Verification:**
1. Unit test: set `process.env.ARCEUS_PERSISTENCE_MODE = "lokal"`, confirm server fails to boot with a readable error.
2. Grep: `git grep "ARCEUS_PERSISTENCE_MODE"` returns 0 hits outside `config/persistence.ts`.
3. `tsc --noEmit`: no regressions.

**Effort:** 30 minutes.

---

## F-005 · Extract `startServer(config, services)` factory; move entrypoint to `index.ts`

**Flaw it pairs with:** module-level import-time side effects make `server.ts` untestable.

**Root cause:** `server.ts` conflates composition (wiring) and execution (running). ESM top-level await makes this usable as an entry point; it also makes it unusable as a module.

**Proposed code:**

1. **Rename `server.ts` → `app.ts`** (or keep as `server.ts` but export a factory). The file becomes:

```ts
// apps/api/src/app.ts
import Fastify, { type FastifyInstance } from "fastify";
import type { BeatDependencies } from "@arceus/company-runtime";

export interface StartServerOptions {
  config: {
    port: number;
    host: string;
    persistenceMode: PersistenceMode;
    demoMode: boolean;
  };
  services: {
    /* optional overrides for tests */
    beatDeps?: Partial<BeatDependencies>;
  };
}

export async function startServer(opts: StartServerOptions): Promise<{
  app: FastifyInstance;
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
  shutdown: (signal: string) => Promise<void>;
}> {
  // 1. Install crash hooks (see F-001) — FIRST.
  installFatalErrorHandlers();

  // 2. Build Fastify.
  const app = Fastify({ logger: buildLoggerConfig() /* see F-007 */ });

  // 3. Hydrate store.
  await hydrate();

  // 4. Build DI containers (beatDeps, meeting pipeline, scheduler).
  const beatDeps = buildBeatDependencies(opts.services.beatDeps);
  const heartbeatEngine = new HeartbeatEngine(heartbeatConfig, beatDeps);
  const meetingPipeline = buildMeetingPipeline({ heartbeatEngine });
  const meetingScheduler = new MeetingScheduler(meetingConfig, { runPipeline: (id) => meetingPipeline.run(id), /* … */ });

  // 5. Register routes.
  await registerAllRoutes(app, { heartbeatEngine, meetingScheduler });

  // 6. Start ancillary (audit ledger, trust scores) BEFORE serving.
  startAuditLedger();
  await cpHydrateTrustScores();

  // 7. Conditionally auto-resume heartbeat.
  await maybeAutoResumeHeartbeat(heartbeatEngine, meetingScheduler);

  // 8. Listen.
  await app.listen(opts.config);

  // 9. Background warmup.
  warmUpOpencode().catch((err) => app.log.error({ event: "opencode.warmup.failed", err }));

  return { app, heartbeatEngine, meetingScheduler, shutdown: buildShutdown(app, heartbeatEngine, meetingScheduler) };
}
```

Helpers (`buildBeatDependencies`, `buildMeetingPipeline`, `registerAllRoutes`, `maybeAutoResumeHeartbeat`, `buildShutdown`, `installFatalErrorHandlers`, `buildLoggerConfig`) each live in focused files — they peel off much of the inline spaghetti (addresses F-008-style god-file concerns too).

2. **Create `apps/api/src/index.ts`** — the entry point:

```ts
import { serverConfig, orchestratorConfig, persistenceMode } from "./config/index.js";
import { startServer } from "./app.js";

const { app, shutdown } = await startServer({
  config: { ...serverConfig, persistenceMode, demoMode: orchestratorConfig.demoMode },
  services: {},
});

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (orchestratorConfig.demoMode) {
  app.log.warn({ event: "startup.demo_mode" }, "⚠ DEMO MODE ACTIVE");
}
```

3. **Update `apps/api/package.json`:**

```jsonc
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest"
  }
}
```

4. **Tests can now do:**

```ts
import { startServer } from "../src/app.js";

test("routes are registered", async () => {
  const { app, shutdown } = await startServer({ config: testConfig, services: { beatDeps: mockBeatDeps } });
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  await shutdown("TEST");
});
```

**Verification:**
1. `pnpm test` can run against a real in-process server.
2. Boot latency measured: should be unchanged or faster (no double-hydration, tree-shakes cleaner).
3. Confirm no file outside `index.ts` calls `app.listen()`.

**Effort:** 4-6 hours for a clean pass, including migrating tests.

---

## F-006 · Rename `getLegacyProductDir()` OR migrate off it

**Flaw it pairs with:** Legacy-named getter at composition root.

**Root cause:** a partial migration that left the old API visible. Blocked on F-003 (file doesn't exist).

**Two paths, depending on what F-003 reveals:**

### Path A — Legacy getter exists alongside a new one

After restoring `workspace/manager.ts`, if the module exports both `getLegacyProductDir` and (say) `getProductDir` / `getWorkspaceRoot`:

1. Identify callers: `git grep "getLegacyProductDir"` (currently only `server.ts:67`).
2. Replace with the new API:
   ```ts
   const productDir = workspaceManager.getWorkspaceRoot(); // or whatever the new name is
   ```
3. Delete `getLegacyProductDir` from the module.
4. Add `no-restricted-syntax` ESLint rule to catch reintroduction:
   ```jsonc
   { "selector": "CallExpression[callee.property.name=/.*Legacy.*/]", "message": "Avoid Legacy-named APIs" }
   ```

### Path B — Legacy getter is the only API (name misleads)

Rename in-place:
```bash
git mv apps/api/src/workspace/manager.ts apps/api/src/workspace/manager.ts  # no-op
# Then search + replace the symbol
git grep -l "getLegacyProductDir" | xargs sed -i '' 's/getLegacyProductDir/getProductDir/g'
```

Add a deprecated re-export for a release cycle if anything external might reference it:
```ts
/** @deprecated renamed to getProductDir; removal planned in 0.x+2 */
export const getLegacyProductDir = workspaceManager.getProductDir.bind(workspaceManager);
```

**Verification:**
1. `git grep -i legacy` across the codebase returns only intentional uses (e.g. database-migration comments).
2. `tsc --noEmit` passes.

**Effort:** 15-30 minutes once F-003 is resolved.

---

## F-007 · Structured Pino config with redaction, level-by-env, and request ID

**Flaw it pairs with:** `Fastify({ logger: true })` = default Pino, no redaction.

**Root cause:** copy-paste from Fastify "getting started" docs. No one's thought about log content yet because no secrets have accidentally shipped.

**Proposed code** — replace `server.ts:66`:

```ts
import Fastify from "fastify";
import { randomUUID } from "node:crypto";

const isProd = process.env.NODE_ENV === "production";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    redact: {
      paths: [
        // Request headers
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "req.headers['x-auth-token']",
        // Arceus-specific payloads — expand as routes add logging
        "req.body.password",
        "req.body.apiKey",
        "req.body.token",
        "req.body.secret",
        "req.body.llmApiKey",
        "req.body.azureApiKey",
        "req.body.supabaseServiceRoleKey",
        // Wildcard guard for any nested "apiKey" anywhere
        "*.apiKey",
        "*.password",
        "*.secret",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
    // Pretty-print only in dev; JSON in prod for log aggregators.
    transport: isProd
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } },
    // Base fields attached to every log line.
    base: {
      service: "arceus-api",
      env: process.env.NODE_ENV ?? "development",
      version: process.env.ARCEUS_VERSION ?? "dev",
    },
    // Fastify's request ID — propagated via `X-Request-Id`; stable per request.
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        id: req.id,
        remoteAddress: req.ip,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
    },
  },
  genReqId: (req) => String(req.headers["x-request-id"] ?? randomUUID()),
  requestIdHeader: "x-request-id",
  requestIdLogLabel: "reqId",
});
```

**Audit ledger integration:** once the request ID is in the log context, also attach it to the audit entries for the request:
```ts
app.addHook("onRequest", async (req) => {
  req.audit = (entry) => audit({ ...entry, reqId: req.id });
});
```

**Verification:**
1. Temp route: `app.get("/test-leak", async (req) => { req.log.info({ password: "secret", token: "xxx" }, "test"); return "ok"; });`
2. Hit it and verify log shows `password: "[REDACTED]"` and `token: "[REDACTED]"`.
3. Run in prod mode, confirm output is JSON.
4. Run in dev mode, confirm colorized pretty output.

**Effort:** 1-2 hours including the test route + audit ledger linkage.

---

## F-008 · Enable `eslint-plugin-import/order` + `consistent-type-imports`; run `knip`

**Flaw it pairs with:** unordered, unobserved import block.

**Root cause:** no tooling enforced import ordering; 12-import barrel from `store.ts` went unnoticed.

**Proposed code — in the ESLint flat config (`eslint.config.js` or `eslint.config.ts`):**

```ts
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default [
  ...tseslint.configs.recommendedTypeChecked,
  {
    plugins: { import: importPlugin },
    rules: {
      // Ordering
      "import/order": ["error", {
        "groups": [
          "builtin",     // node:fs, node:path
          "external",    // fastify, zod, drizzle
          "internal",    // @arceus/*
          "parent",      // ../foo
          "sibling",     // ./bar
          "index",       // ./
          "object",
          "type",
        ],
        "pathGroups": [
          { pattern: "@arceus/**", group: "internal", position: "before" },
        ],
        "pathGroupsExcludedImportTypes": ["builtin"],
        "newlines-between": "always",
        "alphabetize": { order: "asc", caseInsensitive: true },
      }],

      // Type-imports
      "@typescript-eslint/consistent-type-imports": ["error", {
        prefer: "type-imports",
        fixStyle: "separate-type-imports",
      }],

      // Detection
      "import/no-duplicates": "error",
      "import/no-cycle": ["warn", { maxDepth: 10 }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
```

Run the auto-fix pass:
```bash
pnpm eslint --fix 'apps/**/*.ts' 'packages/**/*.ts'
```

Then commit the (mechanical) reorder as a separate PR titled "chore: enforce import ordering" — zero behavioral change, easy to review.

**Complement with `knip` (dead-code + unused-imports detector):**

```bash
pnpm add -D -w knip
cat > knip.json <<'EOF'
{
  "workspaces": {
    "apps/api": { "entry": ["src/index.ts", "src/app.ts"] },
    "apps/web": { "entry": ["app/**/layout.tsx", "app/**/page.tsx"] },
    "packages/*": { "entry": ["src/index.ts"] }
  }
}
EOF
pnpm exec knip --reporter codeclimate
```

Add to CI:
```yaml
- name: knip (dead code)
  run: pnpm exec knip
```

Fixes for god-barrel import (the 12-named-import from `./persistence/store.js`) are tracked when we audit `store.ts` itself — likely splitting by domain (`store/tasks.ts`, `store/meetings.ts`, etc.).

**Verification:**
1. `pnpm eslint` returns 0 errors on `server.ts`.
2. Diff of `server.ts` shows imports grouped, alphabetized, with blank lines between groups.
3. `knip` reports no unused exports in `server.ts`.

**Effort:** 1 hour for ESLint config + auto-fix; 30 min for knip setup; N hours for fallout (depends on actual dead-code volume).

---

---

## F-009 · Parameterize `BeatDependencies` on `TMutation`; delete the `as any` cast

**Flaw it pairs with:** `applyMutations` forced through `as any` at the DI boundary.

**Root cause:** `packages/company-runtime/src/heartbeat.ts:66-71` types `mutations` as `Array<{ type: string; [key: string]: unknown }>` — the broadest non-`any` shape possible. The Arceus-side `cpApplyMutations` expects a strict discriminated union. The runtime package didn't know Arceus's vocabulary when it was written, so it settled for a permissive shape. The host-side `as any` is the direct consequence.

**Two-stage fix.**

### Stage 1 — runtime package: make the interface generic

In `packages/company-runtime/src/heartbeat.ts`:

```ts
// Before
export interface BeatDependencies {
  applyMutations: (
    companyId: string,
    mutations: Array<{ type: string; [key: string]: unknown }>,
    causation?: { eventId?: string; summary?: string },
    expectedVersion?: number,
  ) => { version: number; applied: number; errors: string[] };
  // ...
}

// After
export interface BaseMutation { type: string; [key: string]: unknown }

export interface BeatDependencies<TMutation extends BaseMutation = BaseMutation> {
  applyMutations: (
    companyId: string,
    mutations: TMutation[],
    causation?: { eventId?: string; summary?: string },
    expectedVersion?: number,
  ) => { version: number; applied: number; errors: string[] };
  // ... rest unchanged
}

export class HeartbeatEngine<TMutation extends BaseMutation = BaseMutation> {
  constructor(config: HeartbeatConfig, deps?: BeatDependencies<TMutation>, legacyExecutor?: BeatExecutor) { ... }
  // ...
}
```

`BaseMutation` as the default keeps all existing consumers working with zero changes — the generic only bites if you narrow it.

### Stage 2 — host: narrow + delete cast

Assuming `cpApplyMutations` already has (or can export) the discriminated union `ArceusMutation`:

```ts
// packages/contracts/src/mutations.ts
export type ArceusMutation =
  | { type: "set_task_status"; taskId: string; status: TaskStatus }
  | { type: "append_memory"; agentId: string; content: string; kind: MemoryKind }
  | { type: "transition_sprint"; sprintId: string; to: SprintStatus }
  // ... exhaustive
  ;
```

Then in `server.ts`:

```ts
import type { BeatDependencies } from "@arceus/company-runtime";
import type { ArceusMutation } from "@arceus/contracts";

const beatDeps: BeatDependencies<ArceusMutation> = {
  // ...
  applyMutations: (companyId, mutations, causation, expectedVersion) =>
    cpApplyMutations(companyId, mutations, causation, expectedVersion),  // ← no cast
  // ...
};

const heartbeatEngine = new HeartbeatEngine<ArceusMutation>(heartbeatConfig, beatDeps);
```

**Verification:**
1. `tsc --noEmit` passes with no cast.
2. Introduce a test that adds `{ type: "unknown_mutation", data: 42 }` to the list and assert the compiler rejects it.
3. Run existing heartbeat e2e test (`packages/company-runtime/src/heartbeat.e2e-test.ts`) — must still pass unchanged because the default generic parameter preserves backward compatibility.

**Effort:** 1-2 hours. The `ArceusMutation` union may already exist inside `cpApplyMutations`; if not, define it there and re-export from contracts.

---

## F-010 · Extract `buildBeatDependencies(services)` factory

**Flaw it pairs with:** `beatDeps` inlined in composition root.

**Root cause:** server.ts conflates wiring and construction. Same pattern as F-005 at a smaller scale.

**Proposed code** — create `apps/api/src/heartbeats/beat-deps.ts`:

```ts
import type { BeatDependencies } from "@arceus/company-runtime";
import type { ArceusMutation } from "@arceus/contracts";
import { serializeError } from "../lib/serialize-error.js"; // see F-011
import { COMPANY_ID_PENDING } from "@arceus/contracts";    // see F-012

export interface BeatDependencyServices {
  loadAgentContext: typeof import("../persistence/control-plane.js").cpLoadAgentContext;
  getSnapshotVersion: typeof import("../persistence/control-plane.js").cpGetSnapshotVersion;
  applyMutations:   typeof import("../persistence/control-plane.js").cpApplyMutations;
  commitBeatRecord: typeof import("../persistence/control-plane.js").cpCommitBeatRecord;
  flushStore:       typeof import("../persistence/store.js").flush;
  getSnapshot:      typeof import("../persistence/store.js").getSnapshot;
  audit:            typeof import("../observability/audit-ledger.js").audit;
  executeTask:      typeof import("./beat-executor.js").executeBeatTask;
  executeChecklistAction: typeof import("./checklist-executor.js").executeChecklistAction;
  emitBeatEvent:    (event: Parameters<NonNullable<BeatDependencies["emitBeatEvent"]>>[0]) => void;
}

export function buildBeatDependencies(
  services: BeatDependencyServices,
): BeatDependencies<ArceusMutation> {
  return {
    loadAgentContext: (agentId, beatId, beatNumber, trigger, config) =>
      services.loadAgentContext(agentId, beatId, beatNumber, trigger, config),

    getSnapshotVersion: () => services.getSnapshotVersion(),

    applyMutations: (companyId, mutations, causation, expectedVersion) =>
      services.applyMutations(companyId, mutations, causation, expectedVersion),

    commitBeatRecord: (record) => services.commitBeatRecord(record),

    flushStore: () => services.flushStore(),

    audit: {
      auditAgent: (companyId, agentRole, eventType, summary, opts) =>
        services.audit({ companyId, category: "agent_action", eventType, summary, agentRole, ...opts }),
      auditSystem: (companyId, eventType, summary, opts) =>
        services.audit({ companyId, category: "system", eventType, summary, ...opts }),
      auditError: (companyId, eventType, summary, error, opts) =>
        services.audit({
          companyId, category: "error", severity: "error", eventType, summary,
          detail: { error: serializeError(error) }, // F-011 lands here
          ...opts,
        }),
    },

    executeTask: (ctx, taskId, beatId) => services.executeTask(ctx, taskId, beatId),
    executeChecklistAction: (ctx, action, beatId) => services.executeChecklistAction(ctx, action, beatId),

    getAgentRoster: () => {
      const snap = services.getSnapshot();
      if (snap.company.id === COMPANY_ID_PENDING) return []; // F-012 lands here
      return snap.agents.map((a) => ({ agentId: a.id, role: a.role, companyId: snap.company.id }));
    },

    emitBeatEvent: (event) => services.emitBeatEvent(event),
  };
}
```

Then `server.ts` shrinks to:

```ts
const beatDeps = buildBeatDependencies({
  loadAgentContext: cpLoadAgentContext,
  getSnapshotVersion: cpGetSnapshotVersion,
  applyMutations: cpApplyMutations,
  commitBeatRecord: cpCommitBeatRecord,
  flushStore: flush,
  getSnapshot,
  audit,
  executeTask: executeBeatTask,
  executeChecklistAction,
  emitBeatEvent,
});

const heartbeatEngine = new HeartbeatEngine<ArceusMutation>(heartbeatConfig, beatDeps);
```

From 25 lines to 11.

**Tests can now do:**

```ts
const deps = buildBeatDependencies({
  ...productionServices,
  executeTask: async () => ({ summary: "mocked", tokensUsed: 0, actionsCount: 0, toolCalls: 0, completed: true }),
  audit: vi.fn(),
});
const engine = new HeartbeatEngine(testConfig, deps);
```

**Verification:**
1. Unit test for `buildBeatDependencies` with fully-mocked services.
2. Existing heartbeat e2e tests still pass.
3. `tsc --noEmit` passes.

**Effort:** 2 hours.

---

## F-011 · `serializeError` helper for full-fidelity error audit

**Flaw it pairs with:** `auditError` drops stack + cause.

**Root cause:** error-to-string was the minimum defensive code; no helper existed to do the right thing.

**Proposed code** — create `apps/api/src/lib/serialize-error.ts`:

```ts
export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedError | { value: string };
  // Extension slot for subclass-specific fields (e.g. ZodError.issues)
  extra?: Record<string, unknown>;
}

export function serializeError(err: unknown, depth = 5): SerializedError | { value: string } {
  if (depth === 0) return { value: "[max-depth]" };
  if (!(err instanceof Error)) return { value: String(err) };

  const out: SerializedError = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };

  if (err.cause !== undefined) {
    out.cause = depth > 1 ? serializeError(err.cause, depth - 1) : { value: "[truncated]" };
  }

  // Known extensions
  if ("issues" in err && Array.isArray((err as { issues: unknown }).issues)) {
    out.extra = { issues: (err as { issues: unknown }).issues };
  }
  if ("code" in err && typeof (err as { code: unknown }).code === "string") {
    out.extra = { ...(out.extra ?? {}), code: (err as { code: string }).code };
  }

  return out;
}
```

**Use it in `buildBeatDependencies`** (already shown in F-010's code).

**Reuse in F-001's crash handler:**

```ts
process.on("uncaughtException", (err) => {
  console.error(JSON.stringify({ event: "process.fatal", kind: "uncaughtException", error: serializeError(err), ts: new Date().toISOString() }));
  void handleFatalError(err);
});
```

**Audit log shape — before vs after:**

```jsonc
// Before
{ "category": "error", "summary": "beat failed", "detail": { "error": "task X threw" } }

// After
{
  "category": "error",
  "summary": "beat failed",
  "detail": {
    "error": {
      "name": "TaskExecutionError",
      "message": "task X threw",
      "stack": "TaskExecutionError: task X threw\n  at executeBeatTask (apps/api/src/heartbeats/beat-executor.ts:183:13)\n  ...",
      "cause": {
        "name": "ZodError",
        "message": "Invalid input",
        "extra": { "issues": [{ "path": ["input"], "message": "required" }] }
      }
    }
  }
}
```

**Verification:**
1. Unit test: throw a `new Error("outer", { cause: new Error("inner") })`; assert serialized output includes `cause.message === "inner"`.
2. Integration: trigger a known error path; inspect audit ledger entry; confirm stack + cause present.

**Effort:** 45 minutes including tests.

---

## F-012 · Replace `"company_pending"` string with a typed constant (then plan the structural fix)

**Flaw it pairs with:** magic-string sentinel for the no-company state.

**Root cause:** the sentinel was added inline early; no shared constant existed, so every consumer inlined the string.

**Stage 1 — quick win (ship same day):** export a typed constant.

In `packages/contracts/src/company.ts`:

```ts
export const COMPANY_ID_PENDING = "company_pending" as const;
export type CompanyIdPending = typeof COMPANY_ID_PENDING;

// Helper narrowing
export function isPendingCompany<T extends { id: string }>(c: T): boolean {
  return c.id === COMPANY_ID_PENDING;
}
```

Replace every occurrence:

```bash
# Find all call sites
git grep -n "\"company_pending\"" -- 'apps/*' 'packages/*'
# Manual review + replace — use isPendingCompany() where possible, COMPANY_ID_PENDING where a bare comparison is cleanest.
```

Add a lint rule to prevent regression:

```jsonc
// eslint.config.js
{
  "rules": {
    "no-restricted-syntax": ["error", {
      "selector": "Literal[value='company_pending']",
      "message": "Use COMPANY_ID_PENDING or isPendingCompany() from @arceus/contracts"
    }]
  }
}
```

**Stage 2 — structural fix (schedule when the snapshot type is touched):** discriminate the snapshot.

```ts
// Before
interface CompanySnapshot {
  company: { id: string; name: string; ... };
  agents: Agent[];
  // ...
}

// After
type CompanySnapshot =
  | { state: "pending" }
  | { state: "hired"; company: Company; agents: Agent[]; /* ... */ };

// Usage forces narrowing
function getRoster(snap: CompanySnapshot) {
  if (snap.state === "pending") return [];
  return snap.agents.map(/* ... */); // snap.agents available; snap.company available
}
```

This removes the possibility of the "pending" state ever being confused with a real company at the type level.

**Verification:**
1. Grep returns zero remaining literal `"company_pending"` outside `packages/contracts/src/company.ts`.
2. ESLint rule fires if someone reintroduces the literal.
3. (Stage 2) no access to `snap.company` or `snap.agents` compiles without narrowing.

**Effort:** Stage 1: 30 minutes. Stage 2: 1-2 days (needs coordinated refactor across every consumer of `CompanySnapshot`).

---

## F-013 · Delete module-level setters; pass emitter + scheduler via factory

**Flaw it pairs with:** process-wide singleton slot for `reactiveEventEmitter` (and `meetingSchedulerRef`).

**Root cause:** the reactive emitter and meeting scheduler references live as `let` slots in `state.ts` because the modules that need them are imported before server.ts has constructed them. The setter pattern resolves the ordering problem at the cost of testability and multi-instance support.

**Proposed code.**

### Stage 1 — scope the state in a class

In `apps/api/src/orchestration/state.ts`:

```ts
// Before
let reactiveEventEmitter: EmitterFn | null = null;
export function setReactiveEventEmitter(fn: EmitterFn) { reactiveEventEmitter = fn; }
export function getReactiveEventEmitter() { return reactiveEventEmitter; }
let meetingSchedulerRef: MeetingScheduler | null = null;
export function setMeetingScheduler(s: MeetingScheduler) { meetingSchedulerRef = s; }
export function getMeetingSchedulerRef() { return meetingSchedulerRef; }

// After
export class OrchestrationState {
  constructor(
    public readonly reactiveEventEmitter: EmitterFn,
    public readonly meetingScheduler: MeetingScheduler,
    // ... other per-run state (agentSessions, artifacts, etc. that are currently module-level)
  ) {}
}
```

### Stage 2 — create the state inside `startServer`

In `app.ts` (the factory from F-005):

```ts
export async function startServer(opts: StartServerOptions) {
  // ... hydrate, etc.

  const heartbeatEngine = new HeartbeatEngine(heartbeatConfig, beatDeps);

  const emitter: EmitterFn = (companyId, agentId, role, event) =>
    heartbeatEngine.emitEvent(companyId, agentId, role, event);

  const meetingPipeline = buildMeetingPipeline({ heartbeatEngine });
  const meetingScheduler = new MeetingScheduler(meetingConfig, { runPipeline: (id) => meetingPipeline.run(id), /* ... */ });

  const orchestration = new OrchestrationState(emitter, meetingScheduler);

  await registerAllRoutes(app, { heartbeatEngine, meetingScheduler, orchestration });

  // ...
}
```

### Stage 3 — migrate consumers

Every `getReactiveEventEmitter()` / `getMeetingSchedulerRef()` call site becomes an `orchestration.reactiveEventEmitter` / `orchestration.meetingScheduler` access. The `orchestration` reference is passed to domain modules either via function arguments or via Fastify's `app.decorate("orchestration", ...)`.

Grep to find consumers:

```bash
git grep -n "getReactiveEventEmitter\|getMeetingSchedulerRef\|setReactiveEventEmitter\|setMeetingScheduler" -- 'apps/*'
```

### Stage 4 — delete the setters + `let` slots

Once all consumers are migrated, delete the module-level `let`, the setters, and the getters.

**Verification:**
1. Grep returns zero hits for `setReactiveEventEmitter` and `setMeetingScheduler` after the refactor.
2. A test can create two `OrchestrationState` instances in one process without interference.
3. Existing routes + heartbeat + meeting behavior unchanged.

**Effort:** 3-4 hours. Biggest cost is chasing down every consumer of the two getters and threading the `orchestration` object through.

---

## F-014 · Collapse `BeatDependencies.audit` into a single `audit(entry)` call (upstream)

**Flaw it pairs with:** three audit wrappers on the host side that are near-identical and exist because the runtime demands that exact shape.

**Root cause:** `packages/company-runtime/src/heartbeat.ts` defines `audit: { auditAgent, auditSystem, auditError }` as three separate named methods. The runtime didn't want to depend on the host's audit schema, so it invented three shapes — one per category — rather than accepting a single generic audit entry.

**Proposed code.**

### Stage 1 — runtime package: accept one `audit(entry)`

In `packages/company-runtime/src/heartbeat.ts`:

```ts
// Before
audit: {
  auditAgent: (companyId, agentRole, eventType, summary, opts?) => void;
  auditSystem: (companyId, eventType, summary, opts?) => void;
  auditError: (companyId, eventType, summary, error?, opts?) => void;
};

// After
export interface AuditEntry {
  companyId: string;
  category: "agent_action" | "system" | "error";
  severity?: "info" | "warn" | "error";
  eventType: string;
  summary: string;
  agentRole?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
}
audit: (entry: AuditEntry) => void;
```

Update runtime call sites to use the unified shape:

```ts
// Before
deps.audit.auditAgent(companyId, agent.role, "beat_started", "Beat started");

// After
deps.audit({ companyId, category: "agent_action", agentRole: agent.role, eventType: "beat_started", summary: "Beat started" });
```

### Stage 2 — host: one-line wrapper

In `buildBeatDependencies` (F-010's factory):

```ts
audit: services.audit,  // done. no more three wrappers.
```

### Sequencing

This fix **depends on F-009** being in flight — both involve modifying `BeatDependencies`. Land them in the same runtime-package bump so consumers only have to update their `beatDeps` once.

**Verification:**
1. Runtime e2e test passes with the new shape.
2. Server-side audit entries unchanged in the ledger.
3. `git grep "auditAgent\|auditSystem\|auditError"` returns no host-side usages (all go through the one `audit(entry)`).

**Effort:** 1-2 hours, bundled with F-009.

---

---

## F-015 · Extract `buildMeetingPipeline(services)` into `apps/api/src/meetings/pipeline.ts`

**Flaw it pairs with:** 157-line inline MeetingPipeline composition in server.ts.

**Root cause:** same pattern as F-010 — composition root does construction + business logic. The pipeline's phase callbacks each contain real logic that belongs in its own domain module.

**Stage 1 — scaffold the factory + phase modules.**

```
apps/api/src/meetings/
├─ pipeline.ts                     # new — buildMeetingPipeline factory
├─ phases/
│  ├─ collect-contributions.ts     # new — wraps F-017's event-driven wait
│  ├─ synthesize.ts                # existing (meetings/synthesis.ts — rename if needed)
│  ├─ resolve.ts                   # existing
│  ├─ execute-decisions.ts         # existing
│  ├─ produce-brief.ts             # existing (moved out of resolution.ts)
│  ├─ extract-memories.ts          # new — absorbs inline extractMemories body
│  └─ on-escalation-complete.ts    # new — absorbs the regex-parse logic (removed once F-020 lands)
└─ pipeline-handlers.ts            # thin adapters that plug phase modules into MeetingPipeline shape
```

**Stage 2 — `buildMeetingPipeline`:**

```ts
// apps/api/src/meetings/pipeline.ts
import type { MeetingPipeline } from "@arceus/company-runtime";
import { MeetingPipeline as MeetingPipelineClass } from "@arceus/company-runtime";
import { collectContributionsPhase } from "./phases/collect-contributions.js";
import { synthesizePhase } from "./phases/synthesize.js";
// ... etc

export interface MeetingPipelineServices {
  getSnapshot: () => CompanySnapshot;
  updateMeeting: (id: string, patch: (m: Meeting) => Meeting) => Meeting | null;
  flush: () => Promise<void>;
  upsertTask: (t: Task) => Task;
  updateTask: (id: string, patch: Partial<Task>) => Task | null;
  upsertApproval: (a: Approval) => Approval;
  appendChatMessage: (m: ChatMessage) => void;
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;  // F-027 lands here
  audit: typeof audit;
  // ... other injected services
}

export function buildMeetingPipeline(services: MeetingPipelineServices): MeetingPipeline {
  return new MeetingPipelineClass({
    getSnapshot: services.getSnapshot,
    updateMeeting: services.updateMeeting,
    flush: services.flush,
    startTokenTracking: (id) => startMeetingTokenAccumulator(id),
    drainTokens: (id) => drainMeetingTokenAccumulator(id),
    collectContributions: (m, { signal }) => collectContributionsPhase(m, { ...services, signal }),  // F-017, F-019
    synthesizeMeeting: (m) => synthesizePhase(m, services),
    resolveMeeting: (m) => resolvePhase(m, services),
    executeMeetingDecisions: (m) => executeDecisionsPhase(m, services),
    produceBrief: (m) => produceBriefPhase(m, services),
    extractMemories: (m) => extractMemoriesPhase(m, services),
    onEscalationComplete: (m) => onEscalationCompletePhase(m, services),
  });
}
```

server.ts shrinks to:

```ts
const meetingScheduler = new MeetingScheduler(meetingsConfig.scheduler, { /* ... */ });
const meetingPipeline = buildMeetingPipeline({
  getSnapshot, updateMeeting, flush, upsertTask, updateTask, upsertApproval, appendChatMessage,
  heartbeatEngine, meetingScheduler, audit,
  // ... etc
});
meetingScheduler.setRunPipeline((id) => meetingPipeline.run(id));  // solves F-027 cleanly via setter
```

**Verification:**
1. Existing meeting e2e tests pass unchanged.
2. `tsc --noEmit` passes with `MeetingPipelineServices` typing end-to-end.
3. Can construct `buildMeetingPipeline({ ...mocks })` in a unit test with no server.ts touch.

**Effort:** 6-8 hours (includes extracting phase files + wiring the new interface).

---

## F-016 · Detect + break the import cycle; kill the 5 dynamic imports

**Flaw it pairs with:** 6 callbacks use `await import(...)` to bypass circular deps.

**Root cause:** somewhere, a module that server.ts imports transitively imports back from server.ts (or a module server.ts co-owns with it). Dynamic imports defer resolution, which avoids the cycle error — at the cost of visibility.

**Stage 1 — identify the cycle:**

```bash
pnpm add -D -w madge
pnpm exec madge --circular --extensions ts apps/api/src
```

Typical output reveals a chain like:
```
apps/api/src/meetings/synthesis.ts ->
apps/api/src/orchestration/state.ts ->
apps/api/src/persistence/store.ts ->
apps/api/src/meetings/synthesis.ts
```

**Stage 2 — break the cycle.** Two canonical moves:
1. **Extract shared types.** If `synthesis.ts` uses a type defined in `state.ts`, and `state.ts` needs something from `synthesis.ts`, hoist the type to a neutral `packages/contracts/src/meetings.ts` — both sides import down from it.
2. **Invert ownership.** The side that has more to offer should own the type. Often `packages/contracts` is the answer.

**Stage 3 — convert dynamic imports to static:**

```ts
// Before
async synthesizeMeeting(meeting) {
  const { synthesizeMeeting: synthesize } = await import("./meetings/synthesis.js");
  ...
}

// After
import { synthesizeMeetingContributions } from "./meetings/synthesis.js";  // top of file
async synthesizeMeeting(meeting) {
  ...
  const synthesis = await synthesizeMeetingContributions(meeting, snap);
  ...
}
```

**Stage 4 — prevent regression.** In the ESLint flat config (F-008):

```ts
{
  rules: {
    "import/no-cycle": ["error", { maxDepth: 10, ignoreExternal: true }],
  },
}
```

Note: ESLint's `import/no-cycle` does **not** see dynamic imports by default, so Stage 3 must precede Stage 4.

**Verification:**
1. `madge --circular` returns zero cycles.
2. `tsc --noEmit` passes.
3. `knip` report shrinks (previously-invisible imports now counted).
4. Server boot time measured before/after — should be unchanged or slightly faster.

**Effort:** 2-4 hours of detective work + mechanical edits. Bundles naturally with F-015.

---

## F-017 · Replace `collectContributions` polling with event-driven wait

**Flaw it pairs with:** 5-minute busy-wait poll loop.

**Root cause:** when written, there was no store-level event emitter for contribution additions, so the author fell back to polling. The event infrastructure now exists (see `beat-event-bus.ts` and the `onBeatEvent` subscribers).

**Proposed code.**

### Stage 1 — expose a contribution-added event

In `apps/api/src/persistence/store.ts` (or wherever `upsertMeeting`/`addContribution` lives):

```ts
type MeetingEvent = { type: "contribution_added"; meetingId: string; contributionCount: number };
const meetingEmitter = new EventEmitter();

export function onMeetingEvent(fn: (e: MeetingEvent) => void): () => void {
  meetingEmitter.on("*", fn);
  return () => meetingEmitter.off("*", fn);
}

export function addContribution(meetingId: string, contribution: Contribution): void {
  const meeting = updateMeeting(meetingId, (m) => ({ ...m, contributions: [...m.contributions, contribution] }));
  if (meeting) {
    meetingEmitter.emit("*", { type: "contribution_added", meetingId, contributionCount: meeting.contributions.length });
  }
}
```

(Or whatever lifecycle method adds contributions — the key is "emit when state changes.")

### Stage 2 — the phase uses it

```ts
// apps/api/src/meetings/phases/collect-contributions.ts
import { onMeetingEvent } from "../../persistence/store.js";
import { meetingsConfig } from "../../config/meetings.js";

export async function collectContributionsPhase(
  meeting: Meeting,
  services: MeetingPipelineServices & { signal?: AbortSignal },
): Promise<Meeting> {
  const target = meeting.participantAgentIds.length;
  const snap = services.getSnapshot();

  // 1. Notify participants.
  for (const agentId of meeting.participantAgentIds) {
    const agent = snap.agents.find((a) => a.id === agentId);
    if (agent) {
      services.heartbeatEngine.emitEvent(snap.company.id, agentId, agent.role, "meeting_contribution");
    }
  }

  // 2. Wait for target count OR timeout OR abort — whichever resolves first.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, meetingsConfig.contributionTimeoutMs);
    const onAbort = () => { cleanup(); reject(new DOMException("aborted", "AbortError")); };
    services.signal?.addEventListener("abort", onAbort);

    const unsubscribe = onMeetingEvent((e) => {
      if (e.type !== "contribution_added" || e.meetingId !== meeting.id) return;
      if (e.contributionCount >= target) { cleanup(); resolve(); }
    });

    // Fast path — already met.
    const current = services.getSnapshot().meetings.find((m) => m.id === meeting.id);
    if (current && current.contributions.length >= target) { cleanup(); resolve(); }

    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
      services.signal?.removeEventListener("abort", onAbort);
    }
  });

  return services.getSnapshot().meetings.find((m) => m.id === meeting.id) ?? meeting;
}
```

### Wins

- **Resolves within microseconds** of the last contribution (vs up to 5s stale).
- **Single snapshot read** at completion (vs 60 scans worst case).
- **No worker pinning.** The Promise isn't active; it's a pending subscription.
- **Cancellation** is first-class (F-019 lands naturally).
- **Timeout** is one setTimeout, not a deadline-check in a loop.

**Verification:**
1. Integration test: trigger 3 participants, assert phase resolves in <50 ms after the 3rd contribution.
2. Timeout test: 0 contributions, assert resolves at `contributionTimeoutMs ± 100 ms`.
3. Abort test: fire abort, assert the promise rejects with `AbortError` immediately.
4. Stress test: 100 concurrent collections, verify no worker-thread saturation.

**Effort:** 3-4 hours including the event wiring + tests.

---

## F-018 · Move contribution timing to `config/meetings.ts`

**Flaw it pairs with:** magic numbers `300_000` / `5_000` in `collectContributions`.

**Proposed code:**

```ts
// apps/api/src/config/meetings.ts
import { z } from "zod";

export const meetingsConfig = z.object({
  contributionTimeoutMs: z.number().int().positive(),
  // Removed when F-017 lands and polling is gone.
  contributionPollIntervalMs: z.number().int().positive().optional(),
  scheduler: z.object({
    tickIntervalMs: z.number().int().positive(),
    defaultDailySyncIntervalMs: z.number().int().positive(),
  }),
}).parse({
  contributionTimeoutMs: Number(process.env.ARCEUS_MEETING_CONTRIBUTION_TIMEOUT_MS ?? 300_000),
  contributionPollIntervalMs: Number(process.env.ARCEUS_MEETING_CONTRIBUTION_POLL_MS ?? 5_000),
  scheduler: {
    tickIntervalMs: Number(process.env.ARCEUS_MEETING_SCHEDULER_TICK_MS ?? 30_000),
    defaultDailySyncIntervalMs: Number(process.env.ARCEUS_MEETING_DAILY_SYNC_MS ?? 300_000),
  },
});
```

Use at call sites:

```ts
import { meetingsConfig } from "../../config/meetings.js";
const deadline = Date.now() + meetingsConfig.contributionTimeoutMs;
```

Also folds F-026 (scheduler config) into the same file.

**Verification:** grep for bare `300_000` / `5_000` / `30_000` in server.ts / meetings/* — zero hits.

**Effort:** 20 minutes. Bundled with F-017 + F-026.

---

## F-019 · Thread `AbortSignal` through every pipeline phase

**Flaw it pairs with:** `collectContributions` (and every other phase) has no cancellation.

**Proposed code** — already shown in F-017's Stage 2. Generalized to all phases:

1. **`MeetingPipeline.run(meetingId, opts?)`** accepts `{ signal?: AbortSignal }`.
2. **Each phase callback signature** includes `signal?: AbortSignal` in its context.
3. **Phase modules** check `signal.throwIfAborted()` at natural checkpoints (before/after every await).
4. **Pipeline runner** wraps the whole chain in a try/catch that catches `AbortError` and marks the meeting status as `"cancelled"` with an audit entry.
5. **Graceful shutdown** calls `AbortController.abort()` on an in-flight pipeline before `app.close()`.

```ts
// Inside a phase function
export async function synthesizePhase(meeting: Meeting, services: Services & { signal?: AbortSignal }) {
  services.signal?.throwIfAborted();
  const synthesis = await services.synthesizeContributions(meeting);
  services.signal?.throwIfAborted();
  services.updateMeeting(meeting.id, (m) => ({ ...m, synthesis }));
  await services.flush();
  return services.getSnapshot().meetings.find((m) => m.id === meeting.id) ?? meeting;
}
```

**Verification:**
1. Unit test per phase: fire abort mid-phase, assert `AbortError` thrown.
2. Integration: start a meeting, trigger shutdown mid-way, assert meeting ends in `"cancelled"` state.
3. Confirm `app.close()` completes within `graceMs` during shutdown (no hung pipelines).

**Effort:** 2 hours once F-015 + F-017 are in. Spreads across every phase module.

---

## F-020 · Add `relatedTaskId` to Meeting schema; delete the regex

**Flaw it pairs with:** task ID regex-parsed from meeting title.

**Proposed code.**

### Stage 1 — schema update

`packages/contracts/src/meetings.ts`:

```ts
export const meetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: meetingStatusSchema,
  // ... existing fields
  relatedTaskId: z.string().nullable().default(null),  // ← new
  relatedSprintId: z.string().nullable().default(null), // ← while we're here, future-proof
  kind: z.enum(["daily_sync", "escalation", "ad_hoc"]).default("ad_hoc"),
});
```

### Stage 2 — populate at creation

Wherever escalation meetings are created (likely `meetings/resolution.ts` or similar):

```ts
// Before
const meeting: Meeting = {
  title: `Escalation: ${task.title} [${task.id}]`,
  // ...
};

// After
const meeting: Meeting = {
  title: `Escalation: ${task.title}`,   // cleaner title for humans
  relatedTaskId: task.id,                // machine-readable field
  kind: "escalation",
  // ...
};
```

### Stage 3 — migrate existing rows

One-time data migration (idempotent):

```ts
// scripts/migrate-meeting-related-task-id.ts (or a regular Drizzle migration)
const meetings = await db.select().from(meetingsTable).where(isNull(meetingsTable.relatedTaskId));
for (const m of meetings) {
  const match = m.title.match(/\[([^\]]+)\]$/);
  if (match) {
    const cleanTitle = m.title.replace(/\s*\[[^\]]+\]$/, "");
    await db.update(meetingsTable)
      .set({ relatedTaskId: match[1], title: cleanTitle })
      .where(eq(meetingsTable.id, m.id));
  }
}
```

### Stage 4 — consumer cleanup

Replace `onEscalationComplete`'s regex with direct field access:

```ts
// Before (server.ts:249-251)
const taskIdMatch = meeting.title.match(/\[([^\]]+)\]$/);
const relatedTaskId = taskIdMatch?.[1] ?? null;

// After (phase module)
const relatedTaskId = meeting.relatedTaskId;
```

**Verification:**
1. Migration dry-run on a copy of prod — assert every escalation meeting gets a populated `relatedTaskId`.
2. Unit test: escalation meeting created with task, assert `meeting.relatedTaskId === task.id`.
3. E2E: trigger a stalled-task escalation, verify second-level escalation fires correctly after migration.
4. Grep: zero remaining `meeting.title.match(/\[/)` patterns.

**Effort:** 2-3 hours including the migration + tests.

---

## F-021 · Per-participant audit on memory-store failures

**Flaw it pairs with:** swallowed errors in `extractMemories` loop.

**Root cause:** the catch was written to "keep going" without routing the loss to audit.

**Proposed code** (assumes F-011's `serializeError` + F-015's phase extraction landed):

```ts
// apps/api/src/meetings/phases/extract-memories.ts
export async function extractMemoriesPhase(
  meeting: Meeting,
  services: MeetingPipelineServices,
): Promise<number> {
  const snap = services.getSnapshot();
  const results = await extractMeetingMemories(meeting, snap, services.factExtractor);

  let totalStored = 0;
  const failures: Array<{ agentId: string; attempted: number; error: SerializedError }> = [];

  for (const { agentId, memories } of results) {
    try {
      const stored = await services.hippocampus.storeMemories(memories);
      totalStored += stored;
    } catch (err) {
      const serialized = serializeError(err);
      services.audit({
        companyId: snap.company.id,
        category: "error",
        severity: "error",
        eventType: "meeting.extract_memories.participant_failed",
        summary: `Failed to store ${memories.length} memories for agent ${agentId}`,
        detail: { meetingId: meeting.id, agentId, attempted: memories.length, error: serialized },
      });
      failures.push({ agentId, attempted: memories.length, error: serialized });
    }
  }

  if (failures.length > 0) {
    services.audit({
      companyId: snap.company.id,
      category: "system",
      severity: "warn",
      eventType: "meeting.extract_memories.partial_failure",
      summary: `${failures.length}/${results.length} participants failed`,
      detail: { meetingId: meeting.id, totalStored, failures },
    });
  }

  return totalStored;
}
```

**Escalation policy decision** (optional, consult product): if `failures.length === results.length` (all participants failed), should the phase report failure to the pipeline and mark the meeting as degraded? Default: yes — silent total failure is worse than loud partial failure.

**Verification:**
1. Unit test: mock `storeMemories` to throw for participant B; assert audit entry contains agent ID + error.
2. Integration: disable hippocampus; run a meeting; verify audit ledger has per-participant error entries.

**Effort:** 1 hour.

---

## F-022 · `withPhaseAudit` wrapper around every pipeline phase

**Flaw it pairs with:** no audit on meeting pipeline phase transitions.

**Proposed code:**

```ts
// apps/api/src/meetings/with-phase-audit.ts
import { audit } from "../observability/audit-ledger.js";
import { serializeError } from "../lib/serialize-error.js";

export async function withPhaseAudit<T>(opts: {
  phase: string;
  companyId: string;
  meetingId: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const started = Date.now();
  audit({
    companyId: opts.companyId,
    category: "system",
    eventType: `meeting.${opts.phase}.start`,
    summary: `Meeting ${opts.meetingId} phase ${opts.phase} started`,
    detail: { meetingId: opts.meetingId },
  });
  try {
    const result = await opts.fn();
    audit({
      companyId: opts.companyId,
      category: "system",
      eventType: `meeting.${opts.phase}.complete`,
      summary: `Meeting ${opts.meetingId} phase ${opts.phase} completed`,
      detail: { meetingId: opts.meetingId, durationMs: Date.now() - started },
    });
    return result;
  } catch (err) {
    audit({
      companyId: opts.companyId,
      category: "error",
      severity: "error",
      eventType: `meeting.${opts.phase}.failed`,
      summary: `Meeting ${opts.meetingId} phase ${opts.phase} failed`,
      detail: { meetingId: opts.meetingId, durationMs: Date.now() - started, error: serializeError(err) },
    });
    throw err;
  }
}
```

Apply inside `buildMeetingPipeline`:

```ts
synthesizeMeeting: (m) => withPhaseAudit({
  phase: "synthesize",
  companyId: services.getSnapshot().company.id,
  meetingId: m.id,
  fn: () => synthesizePhase(m, services),
}),
```

Produces a queryable audit trail:

```sql
SELECT event_type, COUNT(*), PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (detail->>'durationMs')::int) AS p95_ms
FROM audit_events
WHERE event_type LIKE 'meeting.%.complete' AND created_at > now() - interval '7 days'
GROUP BY event_type;
```

**Verification:**
1. Run a successful meeting; verify 14 audit entries (7 starts + 7 completes).
2. Force a synthesize failure; verify `meeting.synthesize.failed` entry with error detail.
3. Dashboard query (example above) returns non-empty after a week of traffic.

**Effort:** 1.5 hours including the wrapper + application to all 7 phases.

---

## F-023 · Hoist `meetingFactSchema` to `packages/contracts/src/memory.ts`

**Flaw it pairs with:** Zod schema defined inline in `extractMemories`.

**Proposed code:**

```ts
// packages/contracts/src/memory.ts
import { z } from "zod";

export const meetingFactSchema = z.object({
  facts: z.array(z.object({
    content: z.string(),
    type: z.enum(["static", "dynamic", "procedural"]),
    confidence: z.number(),
    is_temporal: z.boolean(),
    expiry_days: z.number().nullable(),
    trigger: z.string().nullable(),
    action: z.string().nullable(),
  })),
});

export type MeetingFactPayload = z.infer<typeof meetingFactSchema>;
export type MeetingFact = MeetingFactPayload["facts"][number];
```

Import at call site (inside the extracted phase module from F-024):

```ts
import { meetingFactSchema } from "@arceus/contracts";
```

**Verification:**
1. Other potential consumers (`hippocampus/*`, `memory/extractors.ts`, `routes/memory.routes.ts`) verified — no silent duplicate schemas left.
2. Zod construction cost measured before/after — expect a small boot-time shift, zero per-meeting cost.

**Effort:** 15 minutes.

---

## F-024 · Extract `extractMeetingFactsViaLLM` to a top-level function

**Flaw it pairs with:** `meetingFactExtractor` inline closure.

**Proposed code:**

```ts
// apps/api/src/meetings/extraction.ts
import { structuredCompletion } from "../infra/azure-openai.js";
import { MEETING_EXTRACTION_PROMPT, buildMeetingExtractionPrompt } from "@arceus/hippocampus";
import { meetingFactSchema, type MeetingFact } from "@arceus/contracts";

export async function extractMeetingFactsViaLLM(
  transcript: string,
  role: string,
  name: string,
): Promise<MeetingFact[]> {
  const userPrompt = buildMeetingExtractionPrompt(role, name, transcript);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: MEETING_EXTRACTION_PROMPT },
      { role: "user", content: userPrompt },
    ],
    meetingFactSchema,
    "meeting_fact_extraction",
    { temperature: 0.3 },
  );
  return result.facts.map((f) => ({
    ...f,
    trigger: f.trigger ?? undefined,
    action: f.action ?? undefined,
  }));
}
```

Import into `extractMemoriesPhase` (F-021):

```ts
import { extractMeetingFactsViaLLM } from "../extraction.js";
// ...
const results = await extractMeetingMemories(meeting, snap, extractMeetingFactsViaLLM);
```

**Verification:**
1. Unit test the extractor with a fixed transcript + mocked `structuredCompletion`.
2. Independent reuse: confirm the function can be imported elsewhere if a future non-meeting extractor wants the same LLM shape.

**Effort:** 20 minutes.

---

## F-025 · Introduce `MeetingEffectsContext` interface

**Flaw it pairs with:** anonymous effect-dep bag in `executeMeetingDecisions`.

**Proposed code:**

```ts
// packages/contracts/src/meetings.ts
import type { Task, Approval, ChatMessage } from "./index.js";

export interface MeetingEffectsContext {
  upsertTask: (task: Task) => Task;
  updateTask: (id: string, patch: Partial<Task>) => Task | null;
  upsertApproval: (approval: Approval) => Approval;
  appendChatMessage: (message: ChatMessage) => void;
  flush: () => Promise<void>;
}
```

Type the receiver in `meetings/phases/execute-decisions.ts`:

```ts
import type { MeetingEffectsContext } from "@arceus/contracts";

export function executeDecisionsPhase(
  meeting: Meeting,
  snapshot: CompanySnapshot,
  ctx: MeetingEffectsContext,
): ExecutionResult {
  // ...
}
```

Pass at the call site (inside `buildMeetingPipeline`):

```ts
const effects: MeetingEffectsContext = {
  upsertTask: services.upsertTask,
  updateTask: services.updateTask,
  upsertApproval: services.upsertApproval,
  appendChatMessage: services.appendChatMessage,
  flush: services.flush,
};
// ... pass `effects` into executeDecisionsPhase
```

**Verification:**
1. TypeScript catches any call site that forgets a field.
2. Refactor test: add a new effect to the interface, confirm every call site fails to compile until it's wired.

**Effort:** 30 minutes.

---

## F-026 · Move scheduler config to `config/meetings.ts`

**Flaw it pairs with:** hardcoded `{ tickIntervalMs: 30_000, defaultDailySyncIntervalMs: 300_000 }`.

**Proposed code:** already included in F-018's `meetingsConfig.scheduler` block. Call site becomes:

```ts
import { meetingsConfig } from "../config/meetings.js";
const meetingScheduler = new MeetingScheduler(meetingsConfig.scheduler, { /* ... */ });
```

**Verification:** grep confirms no literals `30_000` / `300_000` remain in server.ts construction sites.

**Effort:** 5 minutes. Folds into F-018's PR.

---

## F-027 · Resolve pipeline/scheduler construction order via setter OR getter injection

**Flaw it pairs with:** `onEscalationComplete` forward-references `meetingScheduler`.

**Root cause:** the pipeline needs the scheduler's `escalateUp(...)` for Phase 7; the scheduler needs the pipeline's `run(...)` to actually execute meetings. Today they're linked by closure late-binding (fragile).

**Two patterns; pick one.**

### Option A — setter on the scheduler (recommended, simpler)

Construct the scheduler first without its `runPipeline` dep; set it later once the pipeline exists.

```ts
// MeetingScheduler gains:
export class MeetingScheduler {
  private runPipelineFn: ((id: string) => Promise<void>) | null = null;
  setRunPipeline(fn: (id: string) => Promise<void>) { this.runPipelineFn = fn; }
  // internal callers assert-non-null or throw if unset by the time scheduler starts
}

// Composition
const meetingScheduler = new MeetingScheduler(meetingsConfig.scheduler, {
  getSnapshot, upsertMeeting, upsertMeetingSchedule, updateMeetingSchedule, flush,
});

const meetingPipeline = buildMeetingPipeline({
  // ... other services
  meetingScheduler,   // pipeline receives scheduler directly — F-027 solved
});

meetingScheduler.setRunPipeline((id) => meetingPipeline.run(id));
```

Now both sides have each other via proper references; the closure ladder is gone.

### Option B — getter injection

```ts
const meetingPipeline = buildMeetingPipeline({
  getMeetingScheduler: () => meetingScheduler,  // reference-by-closure but explicit
});
```

Uglier but doesn't require an API change to `MeetingScheduler`.

**Verification:**
1. Unit test: construct pipeline + scheduler in either order; confirm both patterns work.
2. `onEscalationComplete` test: call synchronously during construction simulation; no more TDZ risk.

**Effort:** 30 minutes. Land with F-015.

---

## F-028 · Rename imported phase functions to distinct identifiers

**Flaw it pairs with:** same-name shadowing in callbacks.

**Proposed code** — in each phase source module (post-F-015), rename the export:

```ts
// apps/api/src/meetings/synthesis.ts — before
export async function synthesizeMeeting(meeting: Meeting, snap: CompanySnapshot): Promise<Synthesis> { ... }

// After
export async function synthesizeMeetingContributions(meeting: Meeting, snap: CompanySnapshot): Promise<Synthesis> { ... }
```

Pattern: verb + object rather than bare noun ("synthesize X" instead of just "X"). Makes each function's purpose clearer standalone.

Suggested renames:
- `synthesizeMeeting` → `synthesizeMeetingContributions`
- `resolveMeeting` → `resolveMeetingConflicts`
- `executeMeetingDecisions` → `applyMeetingDecisions`
- `produceBrief` → already fine; or `generateDailySyncBrief`

Callback bodies drop the aliases:

```ts
// Before
async synthesizeMeeting(meeting) {
  const { synthesizeMeeting: synthesize } = await import("...");
  const synthesis = await synthesize(meeting, snap);
  ...
}

// After
import { synthesizeMeetingContributions } from "./phases/synthesize.js";
async synthesizeMeeting(meeting) {
  const synthesis = await synthesizeMeetingContributions(meeting, snap);
  ...
}
```

**Verification:**
1. `grep -c ": synthesize =\\|: resolve =\\|: execute =" apps/api/src/server.ts` → 0.
2. `tsc --noEmit` passes.
3. Readability pass: each call site now unambiguous.

**Effort:** 15 minutes. Bundles with F-015 + F-016.

---

---

## F-029 · Extract the startup-init block into a named function

**Flaw it pairs with:** anonymous `{ }` scope for startup init (F-029).

**Proposed code** — create `apps/api/src/orchestration/initialize-existing-company.ts`:

```ts
import type { CompanySnapshot } from "@arceus/contracts";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";
import { COMPANY_ID_PENDING } from "@arceus/contracts";  // from F-012
import { seedRegistry } from "../governance/service-registry.js";
import { audit } from "../observability/audit-ledger.js";
import { serializeError } from "../lib/serialize-error.js";  // from F-011

export interface ExistingCompanyInitDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
  logger: FastifyBaseLogger;
}

export async function initializeExistingCompany(
  snap: CompanySnapshot,
  deps: ExistingCompanyInitDeps,
): Promise<void> {
  deps.logger.info({ event: "startup.company_state", companyId: snap.company.id, agentCount: snap.agents.length });

  if (snap.company.id === COMPANY_ID_PENDING) {
    deps.logger.info({ event: "startup.no_company" }, "No company hydrated — skipping registry seed");
    return;
  }

  try {
    const { seeded, skipped } = await seedRegistry(snap.company.id);
    deps.logger.info({ event: "startup.registry_seeded", seeded, skipped });
  } catch (err) {
    // F-030 fix
    audit({
      companyId: snap.company.id,
      category: "error",
      severity: "error",
      eventType: "startup.registry_seed_failed",
      summary: "Service registry re-seed failed at startup",
      detail: { error: serializeError(err) },
    });
    deps.logger.error({ event: "startup.registry_seed_failed", err });
  }

  await maybeAutoResumeHeartbeat(snap, deps);  // F-031 extracted
}
```

Then in `startServer()` (F-005 factory):

```ts
await initializeExistingCompany(getSnapshot(), { heartbeatEngine, meetingScheduler, logger: app.log });
```

**Verification:** server boot behavior unchanged; tests can call `initializeExistingCompany(mockSnap, mockDeps)` in isolation.

**Effort:** 30 minutes.

---

## F-030 · Audit registry-seed failures; expose "degraded" flag

**Flaw it pairs with:** seed failure only `console.warn`'d.

**Proposed code** (shown inside F-029's `initializeExistingCompany`) — the `catch` block now emits `startup.registry_seed_failed` to the audit ledger with full `serializeError` (F-011) context.

**Optional — degraded-mode flag:**

```ts
// apps/api/src/governance/service-registry.ts
let registryDegraded = false;
export function markRegistryDegraded() { registryDegraded = true; }
export function isRegistryDegraded() { return registryDegraded; }
```

Expose on `/api/health`:

```ts
app.get("/api/health", async () => ({
  status: "ok",
  registry: isRegistryDegraded() ? "degraded" : "healthy",
  demoMode: orchestratorConfig.demoMode,   // F-042 lands here
}));
```

The UI polls `/api/health` and shows a "Service registry degraded — some tools unavailable" banner when set.

**Verification:** fail `seedRegistry` in a test; assert audit entry + `/api/health` returns `registry: "degraded"`.

**Effort:** 45 minutes.

---

## F-031 · Staleness-gated heartbeat resume

**Flaw it pairs with:** auto-resume heartbeat without staleness check.

**Proposed code** — add to `orchestration/initialize-existing-company.ts`:

```ts
import { sprintStatusSchema } from "@arceus/contracts";

const AUTO_RESUME_STALENESS_THRESHOLD_MS = 60 * 60_000;  // 1 hour — env-overridable

async function maybeAutoResumeHeartbeat(snap: CompanySnapshot, deps: ExistingCompanyInitDeps) {
  const activeSprint = snap.sprints.find((s) =>
    s.id === snap.company.currentSprintId &&
    (s.status === sprintStatusSchema.enum.executing || s.status === sprintStatusSchema.enum.reviewing),
  );
  if (!activeSprint) return;

  const lastBeatAt = await cpGetLastBeatAtForSprint(activeSprint.id);  // new control-plane helper
  const now = Date.now();
  const ageMs = lastBeatAt ? now - new Date(lastBeatAt).getTime() : Infinity;

  if (ageMs > AUTO_RESUME_STALENESS_THRESHOLD_MS) {
    audit({
      companyId: snap.company.id,
      category: "system",
      severity: "warn",
      eventType: "startup.heartbeat_resume_blocked_stale",
      summary: `Sprint ${activeSprint.number} last beated ${Math.floor(ageMs / 60000)}m ago — human unblock required`,
      detail: { sprintId: activeSprint.id, lastBeatAt, ageMs },
    });
    deps.logger.warn({ event: "startup.heartbeat_resume_blocked_stale", sprintId: activeSprint.id });
    return;
  }

  deps.heartbeatEngine.start();
  deps.meetingScheduler.start();
  audit({
    companyId: snap.company.id,
    category: "system",
    eventType: "startup.heartbeat_auto_resumed",
    summary: `Auto-resumed heartbeat — Sprint ${activeSprint.number} is ${activeSprint.status}`,
    detail: { sprintId: activeSprint.id, ageMs },
  });
}
```

Add a new operator endpoint for explicit unblock:

```ts
// apps/api/src/routes/heartbeat.routes.ts
app.post("/api/heartbeat/force-resume", { preHandler: requireBoardAuth }, async (req) => {
  app.services.heartbeatEngine.start();
  app.services.meetingScheduler.start();
  audit({ /* ... */ eventType: "heartbeat.force_resumed", actor: req.user.id });
  return { ok: true };
});
```

**Verification:**
1. Test with `lastBeatAt = 2 hours ago`; assert `heartbeatEngine.start` NOT called; audit entry present.
2. Test with `lastBeatAt = 30 min ago`; assert heartbeat resumes as before.
3. E2E: simulate 3-day outage, verify operator sees a banner and must click "Resume."

**Effort:** 2 hours (includes the `cpGetLastBeatAtForSprint` helper and the force-resume endpoint).

---

## F-032 · Replace the beat-event type cast with exhaustive narrowing

**Flaw it pairs with:** `event.type as "beat_started" | …` silently widens.

**Proposed code** — in `packages/company-runtime/src/index.ts`, export the event type:

```ts
export type BeatEventType = "beat_started" | "beat_completed" | "beat_failed" | "beat_idle";

export interface BeatEvent {
  type: BeatEventType;
  beatId: string;
  agentId: string;
  role: string;
  data?: Record<string, unknown>;
}
```

Update `emitBeatEvent` / `onBeatEvent` to use the typed shape.

In `server.ts` (or wherever the subscription lands after F-005 extraction):

```ts
import type { BeatEventType } from "@arceus/company-runtime";

function assertNever(x: never): never { throw new Error(`Unhandled beat event type: ${x}`); }

onBeatEvent((event) => {
  switch (event.type) {
    case "beat_started":
    case "beat_completed":
    case "beat_failed":
    case "beat_idle":
      emitEmployeeActivity(event.role, event.type, `${event.type}: ${event.data?.summary ?? event.beatId}`, {
        beatId: event.beatId,
        detail: event.data ?? null,
      });
      return;
    default:
      // New event types → compile error here, forcing handler update.
      return assertNever(event.type);
  }
});
```

**Verification:**
1. Add a new event type to the union in the runtime package; assert `tsc --noEmit` flags the `assertNever` branch.
2. No behavior change for existing events.

**Effort:** 30 minutes. Bundles with F-014.

---

## F-033 · Capture + invoke unsubscribe on shutdown

**Flaw it pairs with:** `onBeatEvent` subscription never unsubscribed.

**Proposed code:**

```ts
// inside startServer() — F-005
const unsubscribeBeatEvents = onBeatEvent((event) => { /* as F-032 */ });

function buildShutdown(...) {
  return async (signal: string) => {
    // Unsubscribe listeners BEFORE stopping engines so stale events don't fire.
    unsubscribeBeatEvents();
    // ... F-039's shutdown logic
  };
}
```

If `onBeatEvent` currently doesn't return an unsubscribe, update the event bus (`packages/company-runtime/src/beat-event-bus.ts`) to return one:

```ts
export function onBeatEvent(handler: BeatEventHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
```

**Verification:**
1. Integration test: subscribe, unsubscribe, emit an event; assert handler not called.
2. Shutdown test: trigger shutdown mid-beat, confirm no late `emitEmployeeActivity` calls fire.

**Effort:** 30 minutes.

---

## F-034 · Switch `||` to `??` with explicit empty-string guard

**Flaw it pairs with:** `event.data?.summary || event.beatId` falsy-or.

**Proposed code:**

```ts
const summary = event.data?.summary;
const label = summary != null && summary !== "" ? summary : event.beatId;
emitEmployeeActivity(event.role, event.type, `${event.type}: ${label}`, { ... });
```

Or the terser form:

```ts
const label = event.data?.summary?.trim() || event.beatId;
```

(`trim()` first normalizes whitespace-only strings to empty; then `||` is safe because the only falsy strings that remain are intentionally empty.)

**Verification:** unit test covers `{ summary: "" }`, `{ summary: "  " }`, `{ summary: null }`, `{ summary: undefined }`, `{ summary: "real" }`.

**Effort:** 10 minutes. Bundles with F-032.

---

## F-035 · Env-gated CORS origin allowlist

**Flaw it pairs with:** `cors, { origin: true }`.

**Proposed code** — new config module:

```ts
// apps/api/src/config/cors.ts
import { z } from "zod";

const corsConfigSchema = z.object({
  origins: z.union([z.literal(true), z.array(z.string().url())]),
  credentials: z.boolean(),
});

export type CorsConfig = z.infer<typeof corsConfigSchema>;

const isDev = process.env.NODE_ENV !== "production";
const rawOrigins = process.env.ARCEUS_CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

export const corsConfig: CorsConfig = corsConfigSchema.parse({
  origins: isDev && rawOrigins.length === 0 ? true : rawOrigins,
  credentials: process.env.ARCEUS_CORS_CREDENTIALS === "true",
});
```

Register:

```ts
import { corsConfig } from "./config/cors.js";

await app.register(cors, {
  origin: corsConfig.origins,
  credentials: corsConfig.credentials,
});
```

**Deployment note:** set `ARCEUS_CORS_ORIGINS=https://app.arceus.ai,https://staging.arceus.ai` in prod; leave unset in dev.

**Verification:**
1. Dev (no env): `curl -H 'Origin: http://localhost:5173' /api/health` → gets `Access-Control-Allow-Origin: http://localhost:5173`.
2. Prod with allowlist: unknown origin → no ACAO header (browser blocks).
3. Startup fails loudly if `ARCEUS_CORS_ORIGINS` contains a malformed URL.

**Effort:** 45 minutes.

---

## F-036 · Register `helmet`, `rate-limit`, + request-ID middleware

**Flaw it pairs with:** missing rate-limit, helmet, request-ID.

**Proposed code:**

```ts
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";

// Request IDs — one stable ID per request, honored from X-Request-Id
const app = Fastify({
  logger: { /* F-007 config */ },
  genReqId: (req) => {
    const header = req.headers["x-request-id"];
    return typeof header === "string" && header.length > 0 ? header : randomUUID();
  },
  requestIdHeader: "x-request-id",
  requestIdLogLabel: "reqId",
});

// Security headers
await app.register(helmet, {
  contentSecurityPolicy: isProd ? undefined /* defaults */ : false,  // dev-friendly
});

// Rate limit — per-IP baseline; tighten per-route where needed.
await app.register(rateLimit, {
  max: Number(process.env.ARCEUS_RATE_LIMIT_MAX ?? 100),
  timeWindow: process.env.ARCEUS_RATE_LIMIT_WINDOW ?? "1 minute",
  keyGenerator: (req) => {
    // Prefer authenticated user ID; fall back to IP.
    return (req as any).user?.id ?? req.ip;
  },
});

// Audit integration — attach req.id onto audit entries.
app.addHook("onRequest", async (req) => {
  (req as any).auditContext = { reqId: req.id };
});
```

Per-route overrides where needed (e.g. tighter limits on write endpoints):

```ts
// inside a route file
app.post("/api/agents/:id/invoke", {
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
}, handler);
```

**Verification:**
1. `curl -v /api/health` → response includes `X-Request-Id` + helmet headers (`X-Frame-Options: DENY`, etc.).
2. Hammer an endpoint 150 times in 60s → 429 after 100.
3. Audit entries include `reqId` matching the response header.

**Effort:** 1.5 hours including tests + per-route tuning.

---

## F-037 · Register routes via loop with a `services` container

**Flaw it pairs with:** 19 hand-written route registrations with partial DI.

**Proposed code** — decorate the app once, then loop:

```ts
import * as routes from "./routes/index.js";

// Decorate
app.decorate("services", services);  // services: { heartbeatEngine, meetingScheduler, audit, ... }

// Type augmentation
declare module "fastify" {
  interface FastifyInstance {
    services: AppServices;
  }
}

// Register loop
for (const [name, plugin] of Object.entries(routes)) {
  await app.register(plugin);
  app.log.debug({ event: "route_registered", name });
}
```

Each route file reads `fastify.services.*`:

```ts
// apps/api/src/routes/company.routes.ts
export async function companyRoutes(app: FastifyInstance) {
  app.get("/api/companies/:id", async (req) => {
    const snap = app.services.getSnapshot();
    // ...
  });
}
```

Routes that previously used the `routeDeps` parameter now pull the same objects from `app.services`.

**Migration step:** update each route module to stop expecting a second `deps` parameter; change to a single-arg plugin signature.

**Verification:**
1. `tsc --noEmit` passes.
2. All 19 routes still function; integration smoke test per route cluster.
3. Adding a 20th route → `routes/foo.routes.ts` export + barrel add → auto-registered.

**Effort:** 3-4 hours (one-time migration pass).

---

## F-038 · Start infrastructure before registering routes

**Flaw it pairs with:** audit ledger + trust scores started after routes.

**Proposed code** — reorder inside `startServer()`:

```ts
export async function startServer(opts) {
  installFatalErrorHandlers();   // F-001

  // 1. Hydrate state
  await hydrate();

  // 2. Infrastructure services (BEFORE routes)
  startAuditLedger();
  await cpHydrateTrustScores();

  // 3. Build engines + deps
  const beatDeps = buildBeatDependencies(services);  // F-010
  const heartbeatEngine = new HeartbeatEngine(heartbeatConfig, beatDeps);
  const meetingScheduler = new MeetingScheduler(meetingsConfig.scheduler, { /* ... */ });
  const meetingPipeline = buildMeetingPipeline({ /* ... */ });  // F-015
  meetingScheduler.setRunPipeline((id) => meetingPipeline.run(id));  // F-027

  // 4. Initialize existing company (may start heartbeat, with staleness gate from F-031)
  await initializeExistingCompany(getSnapshot(), { heartbeatEngine, meetingScheduler, logger: app.log });

  // 5. Fastify plugins — security first
  await app.register(helmet);
  await app.register(cors, corsConfig);
  await app.register(rateLimit, rateLimitConfig);

  // 6. Routes (infrastructure is already live)
  const services = { heartbeatEngine, meetingScheduler, /* ... */ };
  app.decorate("services", services);
  for (const [, plugin] of Object.entries(routes)) await app.register(plugin);

  // 7. Accept traffic
  await flush();
  try {
    await app.listen(opts.config);  // F-040 wrap
  } catch (err) {
    audit({ eventType: "startup.listen_failed", error: serializeError(err) });
    throw err;
  }

  // 8. Background warmups
  warmUpOpencode().catch((err) => audit.auditError(companyId, "opencode_warmup", err));  // F-041

  return { app, heartbeatEngine, meetingScheduler, shutdown: buildShutdown(/* ... */) };
}
```

Readiness guard (optional but cheap):

```ts
let systemReady = false;
// after step 6: systemReady = true;
// inside audit()/other handlers: if (!systemReady && strict) throw new Error("pre-ready access");
```

**Verification:**
1. Startup logs show phases in order: `hydrate → infra → engines → init_company → fastify → routes → listen → warmup`.
2. Artificial test: mock a route handler to call `audit()`; assert it writes to the ledger successfully (ledger is live).

**Effort:** 2 hours. Overlaps heavily with F-005's extraction work.

---

## F-039 · Graceful shutdown: await, timeout, force-kill

**Flaw it pairs with:** shutdown races + hangs + no force-kill.

**Proposed code:**

```ts
const SHUTDOWN_TIMEOUT_MS = Number(process.env.ARCEUS_SHUTDOWN_TIMEOUT_MS ?? 10_000);
let shuttingDown = false;

function buildShutdown(app, heartbeatEngine, meetingScheduler, unsubscribes) {
  return async function shutdown(signal: string) {
    if (shuttingDown) {
      // Second signal → force-exit.
      app.log.error({ event: "shutdown.forced", signal });
      process.exit(137);
    }
    shuttingDown = true;

    app.log.info({ event: "shutdown.start", signal });

    const shutdownWork = (async () => {
      // 1. Stop accepting new work.
      unsubscribes.forEach((u) => u());  // F-033

      // 2. Stop engines in parallel (both return promises).
      await Promise.all([
        Promise.resolve(heartbeatEngine.stop()),  // Promise.resolve handles sync OR async returns
        Promise.resolve(meetingScheduler.stop()),
      ]);

      // 3. Drain audit ledger (cannot flush after it's closed).
      await drainAuditLedger();

      // 4. Teardown the store (final flush).
      await teardown();

      // 5. Close HTTP server (waits for in-flight requests).
      await app.close();
    })();

    try {
      await Promise.race([
        shutdownWork,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms`)), SHUTDOWN_TIMEOUT_MS),
        ),
      ]);
      app.log.info({ event: "shutdown.complete" });
      process.exit(0);
    } catch (err) {
      app.log.error({ event: "shutdown.failed", err });
      process.exit(1);
    }
  };
}
```

**Recommended upstream change:** ensure `HeartbeatEngine.stop()` and `MeetingScheduler.stop()` return `Promise<void>` (even if sync today, so the API is future-proof).

**Verification:**
1. Unit test: trigger shutdown with a long-running beat; assert exit within `SHUTDOWN_TIMEOUT_MS`.
2. Unit test: two SIGTERMs back-to-back; assert second triggers `exit(137)`.
3. Load test: 20 in-flight requests, send SIGTERM; no data loss, graceful drain.

**Effort:** 1.5 hours.

---

## F-040 · Wrap `app.listen` in try/catch

**Flaw it pairs with:** listen failure becomes silent ghost.

**Proposed code** — shown inline in F-038 step 7. Standalone version:

```ts
try {
  await app.listen(serverConfig);
  app.log.info({ event: "startup.listening", port: serverConfig.port, host: serverConfig.host });
} catch (err) {
  audit({
    companyId: "system",
    category: "error",
    severity: "error",
    eventType: "startup.listen_failed",
    summary: `Failed to bind ${serverConfig.host}:${serverConfig.port}`,
    detail: { error: serializeError(err) },
  });
  app.log.fatal({ event: "startup.listen_failed", err });
  await drainAuditLedger();
  process.exit(1);
}
```

Note: this must flush the audit ledger before exit so the failure lands durably.

**Verification:**
1. Set `PORT=22` (privileged port); boot as non-root; confirm audit entry + exit 1.
2. Bind twice on the same port in two processes; second process exits cleanly with `startup.listen_failed`.

**Effort:** 20 minutes. Part of F-038's sequencing.

---

## F-041 · Attach `.catch` to `warmUpOpencode()`

**Flaw it pairs with:** `void warmUpOpencode()` fire-and-forget.

**Proposed code:**

```ts
warmUpOpencode().catch((err) => {
  app.log.warn({ event: "opencode.warmup_failed", err });
  audit({
    companyId: snap.company.id,
    category: "error",
    severity: "warn",
    eventType: "opencode.warmup_failed",
    summary: "OpenCode warmup failed at startup — first beat may be slow",
    detail: { error: serializeError(err) },
  });
});
```

Optional — expose an "opencode healthy" flag:

```ts
let opencodeHealthy = true;
warmUpOpencode()
  .then(() => { opencodeHealthy = true; })
  .catch((err) => { opencodeHealthy = false; /* audit as above */ });

// In /api/health
{ status: "ok", opencode: opencodeHealthy ? "healthy" : "degraded", ... }
```

**Verification:**
1. Stub `warmUpOpencode` to reject; assert audit entry + log line; server still responds on `/api/health`.
2. Happy path: `/api/health` returns `opencode: "healthy"`.

**Effort:** 30 minutes.

---

## F-042 · Audit demo-mode activation; surface on `/api/health`

**Flaw it pairs with:** demo-mode warning only in console.

**Proposed code:**

```ts
if (orchestratorConfig.demoMode) {
  app.log.warn({ event: "startup.demo_mode_active" }, "⚠ DEMO MODE ACTIVE — frontend-only constraints enabled");
  audit({
    companyId: getSnapshot().company.id,
    category: "system",
    severity: "warn",
    eventType: "startup.demo_mode_active",
    summary: "Demo mode active at server startup",
    detail: { config: orchestratorConfig },  // snapshot of demo-mode-relevant settings
  });
}

// Expose on /api/health
app.get("/api/health", async () => ({
  status: "ok",
  demoMode: orchestratorConfig.demoMode,
  registry: isRegistryDegraded() ? "degraded" : "healthy",  // F-030
  opencode: opencodeHealthy ? "healthy" : "degraded",       // F-041
}));
```

**UI surface (outside this PR's scope but worth noting):** when `/api/health` returns `demoMode: true`, the web UI renders a persistent orange banner.

**Verification:**
1. Boot with `ARCEUS_DEMO_MODE=true` → audit entry present; `/api/health` returns `demoMode: true`.
2. Boot without → no audit entry; `/api/health` returns `demoMode: false`.

**Effort:** 20 minutes.

---

---

## F-043 · Wrap all state in an `OrchestrationState` class; delete the 12 setters

**Flaw it pairs with:** 14 module-level mutable `let` exports.

**Root cause:** historical convenience. `export let` was the quickest way to share state across modules; the team never paid the cost of a proper boundary.

**The umbrella refactor.** This fix is the biggest single change in the entire audit — it collapses ~8 flaws at once (F-043, F-044, F-045, F-046, F-048, F-054, F-055, partially F-013).

### Stage 1 — the class

`apps/api/src/orchestration/orchestration-state.ts`:

```ts
import type { CompanySnapshot } from "@arceus/contracts";
import type { MeetingScheduler } from "@arceus/company-runtime";

type ReactiveEmitter = (companyId: string, agentId: string, role: string, event: BeatEventTrigger) => void;

// Discriminated union replaces the 3 loose ceo* vars (F-048)
export type CeoProposalState =
  | { kind: "idle" }
  | { kind: "inFlight"; startedAt: number }
  | { kind: "cooldown"; until: number; consecutiveFailures: number };

export type WorkspaceFileMtimes = Map<string, number>;  // F-061

export class OrchestrationState {
  // ── Agent sessions (encapsulated; no live-ref leaks — F-045)
  readonly #agentSessions = new Map<string, AgentSessionState>();
  getAgentSessions(): Readonly<Map<string, AgentSessionState>> { return this.#agentSessions; }
  listAgentSessions(): Record<string, AgentSessionState> { return Object.fromEntries(this.#agentSessions); }
  setAgentSession(id: string, s: AgentSessionState): void { this.#agentSessions.set(id, s); }
  removeAgentSession(id: string): void { this.#agentSessions.delete(id); }

  // ── Artifacts
  readonly #artifacts: Artifact[] = [];
  getArtifacts(): ReadonlyArray<Artifact> { return this.#artifacts; }
  addArtifact(a: Artifact): void { this.#artifacts.push(a); }

  // ── Execution status with transition guard (F-044 — real invariant)
  #executionStatus: ExecutionStatus = "idle";
  getExecutionStatus(): ExecutionStatus { return this.#executionStatus; }
  setExecutionStatus(next: ExecutionStatus): void {
    // (optional: add a transition matrix and throw on invalid)
    this.#executionStatus = next;
  }

  // ── Active execution
  #activeExecution: ExecutionContext | null = null;
  getActiveExecution(): ExecutionContext | null { return this.#activeExecution; }
  setActiveExecution(ctx: ExecutionContext | null): void { this.#activeExecution = ctx; }

  // ── Bridge flag
  #eventBridgeStarted = false;
  isEventBridgeStarted(): boolean { return this.#eventBridgeStarted; }
  setEventBridgeStarted(v: boolean): void { this.#eventBridgeStarted = v; }

  // ── Timers (all cleanup lives here — F-046)
  #promptPoller: NodeJS.Timeout | null = null;
  #developerWatchdog: NodeJS.Timeout | null = null;
  #developerMonitor: NodeJS.Timeout | null = null;
  readonly #pendingPromptCompletions = new Map<string, PendingPromptCompletion>();
  #developerWorkspaceSnapshot: WorkspaceFileMtimes = new Map();
  #developerStepLoopActive = false;

  addPendingPromptCompletion(key: string, entry: PendingPromptCompletion): void {
    // F-047 — bound the map
    if (this.#pendingPromptCompletions.size >= MAX_PENDING_COMPLETIONS) {
      throw new Error("pendingPromptCompletions over ceiling");
    }
    this.#pendingPromptCompletions.set(key, entry);
  }
  removePendingPromptCompletion(key: string): void {
    const entry = this.#pendingPromptCompletions.get(key);
    if (entry) { clearTimeout(entry.timer); this.#pendingPromptCompletions.delete(key); }
  }

  // ── CEO proposal — tagged union (F-048)
  #ceoProposal: CeoProposalState = { kind: "idle" };
  getCeoProposal(): Readonly<CeoProposalState> { return this.#ceoProposal; }
  startCeoProposal(): void {
    if (this.#ceoProposal.kind === "inFlight") throw new Error("already in flight");
    this.#ceoProposal = { kind: "inFlight", startedAt: Date.now() };
  }
  completeCeoProposal(success: boolean): void {
    if (this.#ceoProposal.kind !== "inFlight") throw new Error("not in flight");
    if (success) { this.#ceoProposal = { kind: "idle" }; return; }
    const prev = this.#ceoProposal;
    const failures = (prev as any).consecutiveFailures ?? 0;
    if (failures + 1 >= CEO_PROPOSAL_FAILURES_BEFORE_COOLDOWN) {
      this.#ceoProposal = { kind: "cooldown", until: Date.now() + CEO_PROPOSAL_COOLDOWN_MS, consecutiveFailures: failures + 1 };
    } else {
      this.#ceoProposal = { kind: "idle" };
    }
  }
  isCeoInCooldown(): boolean {
    return this.#ceoProposal.kind === "cooldown" && this.#ceoProposal.until > Date.now();
  }

  // ── Reactive + scheduler — proper DI at construction (F-055)
  readonly reactiveEmitter: ReactiveEmitter;
  readonly meetingScheduler: MeetingScheduler;

  #sprintCompletionTriggered = false;
  getSprintCompletionTriggered(): boolean { return this.#sprintCompletionTriggered; }
  setSprintCompletionTriggered(v: boolean): void { this.#sprintCompletionTriggered = v; }

  constructor(deps: {
    reactiveEmitter: ReactiveEmitter;
    meetingScheduler: MeetingScheduler;
  }) {
    this.reactiveEmitter = deps.reactiveEmitter;
    this.meetingScheduler = deps.meetingScheduler;
  }

  // ── Clean teardown — called from shutdown (F-046)
  async dispose(): Promise<void> {
    if (this.#promptPoller) { clearInterval(this.#promptPoller); this.#promptPoller = null; }
    if (this.#developerWatchdog) { clearTimeout(this.#developerWatchdog); this.#developerWatchdog = null; }
    if (this.#developerMonitor) { clearInterval(this.#developerMonitor); this.#developerMonitor = null; }
    for (const [, entry] of this.#pendingPromptCompletions) clearTimeout(entry.timer);
    this.#pendingPromptCompletions.clear();
    this.#agentSessions.clear();
    this.#artifacts.length = 0;
    this.#activeExecution = null;
    this.#executionStatus = "idle";
  }
}
```

### Stage 2 — inject at `startServer()` (F-005 factory)

```ts
const orchestration = new OrchestrationState({
  reactiveEmitter: (companyId, agentId, role, event) =>
    heartbeatEngine.emitEvent(companyId, agentId, role, event),
  meetingScheduler,
});

app.decorate("services", { ...services, orchestration });
```

### Stage 3 — call sites

Before:
```ts
import { setExecutionStatus, activeExecution } from "../orchestration/state.js";
setExecutionStatus("executing");
if (activeExecution) { ... }
```

After:
```ts
// inside a Fastify route
app.services.orchestration.setExecutionStatus("executing");
if (app.services.orchestration.getActiveExecution()) { ... }
```

Migrate via codemod or grep-assisted pass — every import of `"../orchestration/state.js"` becomes an access on `orchestration`.

### Stage 4 — delete state.ts (types keep)

Once all consumers migrated, state.ts shrinks to **types only** (the runtime types `AgentSessionState`, `Artifact`, etc.). The mutable-state exports + setters + getters all disappear.

**Verification:**
1. `grep "export let" apps/api/src/orchestration/state.ts` → 0 results.
2. `tsc --noEmit` passes.
3. Two `OrchestrationState` instances can coexist in one test file without interference.
4. `dispose()` is called from shutdown; event loop drains cleanly (verified by Node exiting without `setImmediate` pin).

**Effort:** this is the biggest structural refactor in the audit. **1.5-3 days** of careful work, spread across many PRs:
- Day 0.5: write the class + tests.
- Day 1: migrate ~30% of call sites, land.
- Day 2: migrate another 40%, land.
- Day 3: final 30% + delete old exports + grep-verify.

Land behind a feature flag or as a sequence of commits that preserve both APIs temporarily.

---

## F-044 · Delete the 12 setter one-liners (folded into F-043)

**Fix:** resolved by F-043 — the class methods replace the setters. No standalone work.

**Verification:** grep `"export function set"` in state.ts → 0 results after F-043.

**Effort:** 0 (bundled).

---

## F-045 · Return `Readonly<...>` types from getters

**Flaw it pairs with:** live Map/Array references leak through getters.

**Fix inside F-043:**
- `getAgentSessions()` returns `ReadonlyMap<...>` via cast.
- `getArtifacts()` returns `ReadonlyArray<...>` via cast.
- Add methods for every mutation path (`addArtifact`, `setAgentSession`, etc.) — no direct mutation from outside.

**Transitional fix if F-043 is delayed:**

```ts
// apps/api/src/orchestration/state.ts (interim)
export function getAgentSessionsMap(): ReadonlyMap<string, AgentSessionState> {
  return agentSessions;
}
export function getArtifacts(): ReadonlyArray<Artifact> {
  return artifacts;
}
```

This blocks the type-checker from letting callers call `.push()` / `.clear()`. Runtime is still mutable (TypeScript erases types), so a malicious caller could `(getArtifacts() as Artifact[]).push(...)` — but now it's a deliberate cast, visible in review.

**Verification:** `tsc --noEmit` after changing every caller; any `.push` / `.clear` / `.set` on the returned value → type error.

**Effort:** 30 min standalone; 0 if bundled with F-043.

---

## F-046 · Call `dispose()` from shutdown

**Flaw it pairs with:** timers cleaned up only in reset, never on shutdown.

**Fix inside F-043 + F-039:**

```ts
// inside buildShutdown() from F-039
async function shutdown(signal: string) {
  // ...
  await Promise.all([heartbeatEngine.stop(), meetingScheduler.stop()]);
  await app.services.orchestration.dispose();   // ← new line
  await drainAuditLedger();
  await teardown();
  await app.close();
  // ...
}
```

**Verification:** integration test — start server, send SIGTERM, observe Node exits within `SHUTDOWN_TIMEOUT_MS` (no timer pinning the event loop).

**Effort:** 10 min. Bundled with F-039 + F-043.

---

## F-047 · Bound `pendingPromptCompletions`; ensure cleanup on every path

**Flaw it pairs with:** unbounded Map growth.

**Proposed code** (assumes F-043's class structure):

```ts
const MAX_PENDING_COMPLETIONS = 1000;  // tune; alert before hit

class OrchestrationState {
  readonly #pendingPromptCompletions = new Map<string, PendingPromptCompletion>();

  createPendingPromptCompletion(key: string, timeoutMs: number): Promise<void> {
    if (this.#pendingPromptCompletions.size >= MAX_PENDING_COMPLETIONS) {
      throw new Error(`pendingPromptCompletions ceiling ${MAX_PENDING_COMPLETIONS} reached`);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingPromptCompletions.delete(key);
        reject(new Error(`prompt completion ${key} timed out`));
      }, timeoutMs);
      this.#pendingPromptCompletions.set(key, {
        resolve: () => { this.#pendingPromptCompletions.delete(key); clearTimeout(timer); resolve(); },
        reject: (err) => { this.#pendingPromptCompletions.delete(key); clearTimeout(timer); reject(err); },
        timer,
      });
    });
  }

  resolvePendingPromptCompletion(key: string): void { this.#pendingPromptCompletions.get(key)?.resolve(); }
  rejectPendingPromptCompletion(key: string, err: Error): void { this.#pendingPromptCompletions.get(key)?.reject(err); }
  pendingPromptCompletionsSize(): number { return this.#pendingPromptCompletions.size; }
}
```

**Observability:** expose `pendingPromptCompletionsSize()` as a metric; alert if it crosses e.g. 80% of the ceiling.

**Verification:**
1. Unit test: add 1001 pending, confirm the last throws.
2. Unit test: call `resolve` — confirm Map entry gone, timer cleared.
3. Unit test: let timer fire — confirm reject fires, entry gone.

**Effort:** 45 min.

---

## F-048 · Discriminated union for CEO proposal state

**Flaw it pairs with:** 3 loose variables for cooldown state.

**Fix shown inline in F-043** — `CeoProposalState` tagged union + methods `startCeoProposal()`, `completeCeoProposal(success)`, `isCeoInCooldown()`.

**Verification:**
1. Unit tests cover the state machine: idle → inFlight → cooldown-or-idle; cooldown.until check; failures counter reset on success.
2. Invalid transitions throw (`startCeoProposal` when already in flight).

**Effort:** 30 min standalone; 0 if bundled with F-043.

---

## F-049 · Extract `resolveProductDir()` helper

**Flaw it pairs with:** workspace-path logic duplicated between state.ts and opencode.ts.

**Proposed code** — `apps/api/src/config/paths.ts`:

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve the absolute path to the product-workspace directory.
 *
 * In dev (cwd ≠ /app) or when `<repoRoot>/workspace` exists, use the repo-root
 * location. In Docker (/app) with no existing dir, fall back to cwd/workspace.
 */
export function resolveProductDir(cwd: string = process.cwd()): string {
  const repoRoot = resolveRepoRoot(cwd);
  const atRoot = resolve(repoRoot, "workspace");
  if (existsSync(atRoot) || !cwd.startsWith("/app")) return atRoot;
  return resolve(cwd, "workspace");
}

export function resolveRepoRoot(cwd: string = process.cwd()): string {
  return process.env.ARCEUS_REPO_ROOT ?? resolve(cwd, "..", "..");  // F-057
}
```

Callers:

```ts
// state.ts
import { resolveProductDir, resolveRepoRoot } from "../config/paths.js";
export const workspaceRoot = resolveRepoRoot();
export const productDir = resolveProductDir();  // F-050: turn into a function on demand

// infra/opencode.ts
import { resolveProductDir } from "../config/paths.js";
const productWorkspace = resolveProductDir();
```

**Verification:** grep `existsSync.*workspace` across the repo → 0 hits outside `config/paths.ts`.

**Effort:** 30 min.

---

## F-050 · Make `productDir` lazy

**Flaw it pairs with:** `existsSync` at module load.

**Fix:** already shown in F-049 — `resolveProductDir()` is a function, not a constant. Consumers call it when they need the path. Re-computed each call (cheap) but always accurate.

Alternative: cache + invalidate via `invalidateProductDirCache()` for tests.

**Verification:** test that creates the dir after import → next `resolveProductDir()` call returns the dir, not the fallback.

**Effort:** 0 if bundled with F-049; 10 min standalone.

---

## F-051 · Move `*Input` DTO types to `packages/contracts/`

**Flaw it pairs with:** LLM DTO types mixed with runtime state types.

**Proposed code:** move files.

```bash
# types to move:
#   MeetingAgendaInput, MeetingDecisionInput, MeetingLearningInput
#     → packages/contracts/src/meetings.ts
#   TaskModificationInput
#     → packages/contracts/src/tasks.ts
#   MemoryModificationInput
#     → packages/contracts/src/memory.ts
```

Update import sites:

```ts
// state.ts — remove the type definitions

// callers (grep to find them)
import type { MeetingAgendaInput } from "@arceus/contracts";
```

While you're at it: declare these as Zod schemas if they aren't already, and derive the types via `z.infer` (feeds into F-052).

**Verification:** grep `MeetingAgendaInput\|MeetingDecisionInput\|...` across the repo → all imports point at `@arceus/contracts`; none at `orchestration/state.ts`.

**Effort:** 45 min including Zod schemas.

---

## F-052 · Derive status string-unions from Zod enums

**Flaw it pairs with:** hand-written string unions.

**Proposed code** — for each status:

```ts
// packages/contracts/src/agent-session.ts
export const agentSessionStatusSchema = z.enum(["idle", "working", "done", "error"]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

// packages/contracts/src/execution.ts
export const executionStatusSchema = z.enum(["idle", "planning", "executing", "verifying", "awaiting_board_review", "paused", "done", "error"]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

// packages/contracts/src/tool-status.ts
export const toolStatusSchema = z.enum(["invoked", "completed"]).nullable();
export type ToolStatus = z.infer<typeof toolStatusSchema>;
```

Update state.ts to import; delete the hand-written types.

**Benefit:** the same schema can now validate incoming data at API boundaries.

**Verification:** `tsc --noEmit` passes; runtime `executionStatusSchema.parse("invalid")` throws clearly.

**Effort:** 30 min.

---

## F-053 · Audit whether snapshot fields are optional; fail loud or document

**Flaw it pairs with:** silent `?? []` on `transitions` / `feedbackRounds`.

**Two options depending on investigation:**

**If the fields should always exist:**

```ts
export function getTransitions(): Transition[] {
  const snap = getSnapshot();
  if (!snap.transitions) {
    throw new Error("snapshot.transitions missing — hydrate misconfigured");
  }
  return snap.transitions;
}
```

**If genuinely optional (e.g. new snapshots don't populate them):**

```ts
/**
 * Returns the company's transition history. Returns [] for snapshots
 * created before the transitions field was added (schema version < 5).
 */
export function getTransitions(): ReadonlyArray<Transition> {
  return getSnapshot().transitions ?? [];
}
```

Pick one, document the decision in an ADR.

**Verification:** tests around the fallback path — decide behavior intentionally rather than by accident.

**Effort:** 20 min investigation + 10 min code.

---

## F-054 · Auto-enforce the reset invariant (obviated by F-043)

**Fix:** F-043's class has no `reset` — disposing and constructing a new `OrchestrationState` is the reset. Nothing to enforce.

**If F-043 is delayed:** write a meta-test.

```ts
import * as state from "../src/orchestration/state.js";
import { resetOrchestratorState } from "../src/orchestration/state.js";

test("every mutable export resets to initial value", () => {
  // Set every mutable export to a non-default value
  state.setExecutionStatus("executing");
  state.setCeoProposalInFlight(true);
  // ... etc
  resetOrchestratorState();
  expect(state.executionStatus).toBe("idle");
  expect(state.ceoProposalInFlight).toBe(false);
  // ... etc
});
```

This catches "new `export let` added without corresponding reset" by failing when the test developer forgets.

**Verification:** the meta-test fails when a new `let` is added without updating `resetOrchestratorState` and the test.

**Effort:** 45 min standalone.

---

## F-055 · Inject reactive emitter + scheduler via constructor (cross-ref F-013)

**Fix:** bundled with F-043 + F-013 — the `OrchestrationState` class accepts both as constructor deps. The module-level `let` + setter pattern is deleted.

**Verification:** same as F-013.

**Effort:** 0 (bundled).

---

## F-056 · Push all magic numbers into `config/orchestrator.ts`

**Flaw it pairs with:** mixed hardcoded + config-derived constants.

**Proposed code** — extend `config/orchestrator.ts`:

```ts
export const orchestratorConfig = {
  // existing fields
  developer: { /* ... */ },
  coreExecutionTaskKinds: [/* ... */],

  // new: pull from env or defaults
  promptCompletionPollIntervalMs: Number(process.env.ARCEUS_PROMPT_POLL_MS ?? 8_000),
  maxFindingsPerTask: Number(process.env.ARCEUS_MAX_FINDINGS_PER_TASK ?? 6),
  ceoProposal: {
    failuresBeforeCooldown: Number(process.env.ARCEUS_CEO_FAILURES_BEFORE_COOLDOWN ?? 3),
    cooldownMs: Number(process.env.ARCEUS_CEO_COOLDOWN_MS ?? 2 * 60 * 1000),
  },
};
```

Use in state.ts:

```ts
export const PROMPT_COMPLETION_POLL_INTERVAL_MS = orchestratorConfig.promptCompletionPollIntervalMs;
export const MAX_FINDINGS_PER_TASK = orchestratorConfig.maxFindingsPerTask;
export const CEO_PROPOSAL_FAILURES_BEFORE_COOLDOWN = orchestratorConfig.ceoProposal.failuresBeforeCooldown;
export const CEO_PROPOSAL_COOLDOWN_MS = orchestratorConfig.ceoProposal.cooldownMs;
```

Or skip the state.ts re-exports if callers import directly from config.

**Verification:** no bare numeric literals in state.ts `export const`.

**Effort:** 20 min.

---

## F-057 · Env-overridable `workspaceRoot` + sanity check

**Flaw it pairs with:** hardcoded `resolve(cwd, "..", "..")`.

**Proposed code** — shown in F-049's `resolveRepoRoot` helper:

```ts
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  const explicit = process.env.ARCEUS_REPO_ROOT;
  if (explicit) return explicit;
  const inferred = resolve(cwd, "..", "..");
  // Sanity check — fail loud if inferred root doesn't look like our repo
  if (!existsSync(resolve(inferred, "package.json"))) {
    throw new Error(`inferred repo root ${inferred} has no package.json; set ARCEUS_REPO_ROOT`);
  }
  return inferred;
}
```

**Verification:** test that running from a wrong cwd with no env override throws a clear error.

**Effort:** 15 min. Bundled with F-049.

---

## F-058 · Named `ReactiveEmitter` type alias

**Fix:** shown in F-043 —

```ts
type ReactiveEmitter = (companyId: string, agentId: string, role: string, event: BeatEventTrigger) => void;
```

Use in both the field declaration and the constructor param. No `typeof` indirection.

**Verification:** grep `typeof reactiveEventEmitter` → 0 results.

**Effort:** 0 (bundled with F-043).

---

## F-059 · Brand status strings (defer unless a bug shows up)

**Fix (deferred):** if "idle" confusion between `AgentSessionStatus` and `ExecutionStatus` causes a real bug, upgrade both to branded types:

```ts
type AgentSessionStatus = "idle" | "working" | "done" | "error" & { readonly __brand: "AgentStatus" };
```

Until then, leave with a brief comment near each type:

```ts
/** Agent-session status (distinct from ExecutionStatus which also has "idle"). */
export type AgentSessionStatus = ...;
```

**Verification:** N/A (deferred).

**Effort:** 5 min for the comment; 1 hour for full branding if ever needed.

---

## F-060 · JSDoc pass on every export

**Proposed code:** walk the file, add a `/** ... */` block to each exported symbol. Example:

```ts
/** Per-agent runtime state tracked during an active beat. Lifecycle: created when
 *  the agent starts a beat, updated by beat-executor, cleared on completion. */
export type AgentSessionState = { /* ... */ };

/** Full outcome of an orchestration cycle. States progress linearly except
 *  `paused` (from board action) and `error` (from any phase failure). */
export type ExecutionStatus = ...;
```

Add ESLint rule to enforce going forward:

```ts
// eslint.config.js
{
  plugins: { jsdoc: jsdocPlugin },
  rules: {
    "jsdoc/require-jsdoc": ["error", {
      publicOnly: true,
      require: { FunctionDeclaration: true, ClassDeclaration: true, ArrowFunctionExpression: true },
    }],
  },
},
```

**Verification:** `pnpm eslint apps/api/src/orchestration/state.ts` → 0 jsdoc violations.

**Effort:** 1-2 hours pass + config.

---

## F-061 · `WorkspaceFileMtimes` named type alias

**Fix** — shown in F-043 / F-049:

```ts
/** Snapshot of tracked workspace files → last-modified epoch ms. */
export type WorkspaceFileMtimes = Map<string /* relative path */, number /* epoch ms */>;
```

Use at the declaration:

```ts
export let developerWorkspaceSnapshot: WorkspaceFileMtimes = new Map();
```

**Verification:** grep `Map<string, number>` in state.ts → 0 results.

**Effort:** 5 min.

---

## F-062 · Lazy Set construction (low priority)

**Fix (optional):**

```ts
// Before
export const WORKSPACE_MONITOR_IGNORE = new Set(orchestratorConfig.developer.workspaceMonitorIgnore);

// After (lazy)
let _ignoreSet: Set<string> | null = null;
export function workspaceMonitorIgnore(): Set<string> {
  if (!_ignoreSet) _ignoreSet = new Set(orchestratorConfig.developer.workspaceMonitorIgnore);
  return _ignoreSet;
}
```

**Honestly:** the cost is negligible; prefer leaving unless you're optimizing cold-start aggressively.

**Effort:** 10 min if you ever care.

---

---

## F-063 · Set `shell: false` on spawn + pass args as array

**Flaw it pairs with:** `shell: true` spawn.

**Proposed code** — `apps/api/src/infra/opencode.ts:197-203`:

```ts
const proc = spawn("opencode", args, {
  shell: false,            // ← was true
  cwd: productWorkspace,
  env: buildChildEnv(),    // ← was `{ ...process.env }`, see F-064
});
```

`shell: false` is Node's default — omit the key entirely if you prefer. The `args` array is already an array of plain strings (`["serve", "--hostname=...", "--port=..."]`), so no shell interpretation is needed.

**Verification:**
1. Boot the server; confirm OpenCode still spawns and reaches "listening" state.
2. Injection test: set a config value with shell-special chars (e.g. `opencodePort = "8080; echo hacked"`) in a test; confirm the spawn fails cleanly with "invalid port" — not with "echoed hacked."

**Effort:** 5 minutes.

---

## F-064 · Replace full env copy with an allowlist

**Flaw it pairs with:** `env: { ...process.env }` leaks all server secrets into the child.

**Proposed code** — new helper + call site:

```ts
// apps/api/src/infra/opencode.ts

function buildChildEnv(): NodeJS.ProcessEnv {
  return {
    // Unix essentials — OpenCode needs these to resolve binaries + home dir
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG,
    TZ: process.env.TZ,

    // Azure credentials — OpenCode reads these directly
    AZURE_API_KEY: runtimeConfig.azureApiKey,
    AZURE_OPENAI_ENDPOINT: runtimeConfig.azureEndpoint,
    AZURE_OPENAI_API_KEY: runtimeConfig.azureApiKey,
    AZURE_OPENAI_API_VERSION: runtimeConfig.azureApiVersion,
    AZURE_RESOURCE_NAME: runtimeConfig.azureResourceName,

    // Optional runtime tunables — extend as OpenCode documents them
    // OPENCODE_LOG_LEVEL: process.env.OPENCODE_LOG_LEVEL,
  };
}
```

Replace the spawn config at `:200-202`:

```ts
env: buildChildEnv(),
```

**Side effect:** this fix makes F-065 (`ensureAzureRuntimeEnvironment`) redundant. `buildChildEnv` sets the child's env directly from `runtimeConfig`; nothing has to mutate the parent's `process.env`.

**Verification:**
1. Boot OpenCode; verify it still authenticates to Azure (spawn → "listening" → first API call succeeds).
2. Add a fake sensitive env var (`SECRET_SERVER_TOKEN=xyz`) to the parent; spawn OpenCode; confirm the child cannot see it (have a test route call `postOpencodeJson` with a debug command that reads `process.env.SECRET_SERVER_TOKEN` — should be undefined).

**Effort:** 20 minutes. Bundles with F-063 and F-065.

---

## F-065 · Delete `ensureAzureRuntimeEnvironment`; pass to child directly

**Flaw it pairs with:** function mutates parent's `process.env` globally.

**Proposed code:** delete the function entirely. Remove the call site at `getOpencode()` line 244. The env values now reach OpenCode via F-064's `buildChildEnv()`.

```ts
// Before (lines 67-74, 244)
function ensureAzureRuntimeEnvironment() { /* 5 process.env = ... */ }
export async function getOpencode() {
  ensureAzureRuntimeEnvironment();
  // ...
}

// After
export async function getOpencode() {
  // env is supplied per-spawn via buildChildEnv; no global mutation.
  // ...
}
```

**Verification:**
1. Grep the repo for any other consumer of the five `AZURE_*` env vars on the *parent* process — if nothing reads them outside OpenCode, the delete is safe.
2. Boot + spawn test — OpenCode authenticates as before.
3. Test pollution: in a Vitest run, confirm that `process.env.AZURE_API_KEY` stays `undefined` after OpenCode spawns (was previously mutated).

**Effort:** 15 minutes. Bundled with F-064.

---

## F-066 · Track child process; kill it on `resetOpencodeConnection`

**Flaw it pairs with:** reset forgets the child → zombie processes.

**Proposed code** — augment the manager to hold the `ChildProcess`:

```ts
type OpencodeInstance = {
  server: { url: string; close(): void };
  client: ReturnType<typeof createOpencodeClient>;
  proc: ChildProcess | null;   // ← new; null if we adopted an existing server we don't own
};

// inside getOpencode()
const { url, proc } = await launchOpencodeServer(...);
return connectOpencodeClient(url, () => proc.kill()).then((instance) => ({ ...instance, proc }));

// adopted existing server — we did not spawn it, so we don't kill it
if (await detectExistingOpencodeServer(existingUrl)) {
  return connectOpencodeClient(existingUrl, () => {}).then((i) => ({ ...i, proc: null }));
}
```

Now `resetOpencodeConnection` can actually clean up:

```ts
export async function resetOpencodeConnection(): Promise<void> {
  const current = opencodePromise;
  opencodePromise = null;
  if (!current) return;
  try {
    const instance = await current;
    if (instance.proc) {
      instance.proc.kill("SIGTERM");
      // Best-effort: wait briefly for graceful exit, then SIGKILL.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          instance.proc!.kill("SIGKILL");
          resolve();
        }, 5_000);
        instance.proc!.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  } catch {
    // previous attempt was already failing; nothing to clean up.
  }
}
```

**Verification:**
1. Unit test: spawn, reset, assert `proc.kill` was called and `exit` fired.
2. Integration: call reset N times; confirm no orphan OpenCode processes (`ps aux | grep opencode` → only one or zero).
3. Graceful-shutdown path (F-039) also calls `resetOpencodeConnection` during dispose so shutdown cleans up the child.

**Effort:** 1 hour.

---

## F-067 · Detach `proc.stdout` / `stderr` listeners after resolve

**Flaw it pairs with:** listeners + output buffer grow forever.

**Proposed code** — extract the handlers as named functions:

```ts
function spawnOpencodeServer(hostname, port, config): Promise<{ url: string; proc: ChildProcess }> {
  // ... existing setup

  let output = "";
  const onStdoutData = (chunk: Buffer) => {
    output += chunk.toString();
    // existing regex + resolve logic
  };
  const onStderrData = (chunk: Buffer) => { output += chunk.toString(); };

  proc.stdout?.on("data", onStdoutData);
  proc.stderr?.on("data", onStderrData);

  return new Promise((resolve, reject) => {
    // ...
    // On resolve: detach handlers, reset output buffer.
    const detach = () => {
      proc.stdout?.off("data", onStdoutData);
      proc.stderr?.off("data", onStderrData);
      // Optionally: attach lightweight pass-through loggers from this point on
      proc.stdout?.on("data", (c) => app.log.info({ event: "opencode.stdout" }, c.toString()));
      proc.stderr?.on("data", (c) => app.log.warn({ event: "opencode.stderr" }, c.toString()));
    };
    // ... on match: clearTimeout; detach(); resolve({ url, proc })
    // ... on exit/error: clearTimeout; detach(); reject(...)
  });
}
```

The post-startup pass-through is F-074's fix.

**Verification:**
1. Memory test: run OpenCode for 10 min with high log volume, assert memory doesn't grow linearly in the parent.
2. Confirm startup still resolves correctly.

**Effort:** 30 minutes. Bundles with F-074.

---

## F-068 · Log + audit `destroyBeatSession` failures

**Flaw it pairs with:** silent swallow in `destroyBeatSession`.

**Proposed code:**

```ts
export async function destroyBeatSession(sessionId: string): Promise<void> {
  try {
    const opencode = await getOpencode();
    const response = await fetch(`${opencode.server.url}/session/${sessionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    audit({
      companyId: getSnapshot().company.id,
      category: "system",
      severity: "warn",
      eventType: "opencode.session.destroy_failed",
      summary: `Failed to destroy OpenCode session ${sessionId}`,
      detail: { sessionId, error: serializeError(err) },
    });
    sessionDeleteFailures.inc();  // Prometheus-style counter
  }
}
```

Add a counter metric exposed on `/metrics` (or wherever metrics live):

```ts
import { Counter } from "prom-client";
export const sessionDeleteFailures = new Counter({
  name: "arceus_opencode_session_delete_failures_total",
  help: "Count of OpenCode session DELETE failures",
});
```

**Verification:**
1. Stub `fetch` to return 500; assert audit entry + counter increment.
2. Grafana (or whatever dashboard) shows the metric.

**Effort:** 30 minutes.

---

## F-069 · Wrap promise singletons in `OpencodeManager` class

**Flaw it pairs with:** module-level promise singletons.

**Proposed code** — new class, owned by `startServer()`:

```ts
// apps/api/src/infra/opencode-manager.ts
export class OpencodeManager {
  #opencodePromise: Promise<OpencodeInstance> | null = null;
  #ceoSessionPromise: Promise<Session> | null = null;

  constructor(private readonly config: OpencodeConfig, private readonly logger: FastifyBaseLogger) {}

  async getOpencode(): Promise<OpencodeInstance> { /* logic formerly in getOpencode() */ }
  async warmUp(): Promise<boolean> { /* logic formerly in warmUpOpencode */ }
  async reset(): Promise<void> { /* logic formerly in resetOpencodeConnection + F-066 */ }
  async getCeoSession(): Promise<Session> { /* existing logic */ }
  async createBeatSession(role: string, beatId: string): Promise<Session> { /* existing */ }
  async destroyBeatSession(sessionId: string): Promise<void> { /* F-068 logic */ }
  async postJson<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> { /* F-079 + F-085 */ }
  async openEventStream(signal?: AbortSignal) { /* F-082 */ }
  async dispose(): Promise<void> { /* graceful teardown — kills child, closes connections */ }
}
```

In `startServer()`:

```ts
const opencodeManager = new OpencodeManager(runtimeConfig, app.log);
await opencodeManager.warmUp();   // F-041 + F-084
app.decorate("opencodeManager", opencodeManager);
```

Every consumer of the old module-level functions switches to `app.opencodeManager.*`.

On shutdown:

```ts
await opencodeManager.dispose();
```

**Verification:**
1. `grep "from.*opencode.ts"` returns zero direct imports of `getOpencode` / `warmUpOpencode` / `resetOpencodeConnection` / `postOpencodeJson` — all go through the manager.
2. A test constructs `new OpencodeManager(...)` and can destroy its own spawned process without affecting other tests.

**Effort:** 4-6 hours. Collapses F-063, F-064, F-065, F-066, F-067, F-068, F-083, F-084 into one cohesive refactor.

---

## F-070 · Use `resolveProductDir()` helper (cross-ref F-049)

**Flaw it pairs with:** workspace-path duplication.

**Fix:** bundled with F-049. Delete lines 17-23 in opencode.ts; import `resolveProductDir` from `config/paths.ts`:

```ts
import { resolveProductDir } from "../config/paths.js";

const productWorkspace = resolveProductDir();
```

**Verification:** grep `existsSync.*workspace` in the repo → 0 hits outside `config/paths.ts`.

**Effort:** 5 minutes once F-049 lands.

---

## F-071 · Retry spawn on `EADDRINUSE`; treat port reservation as advisory

**Flaw it pairs with:** TOCTOU race in `reservePort`.

**Proposed code** — extend the retry loop already present in `launchOpencodeServer`:

```ts
async function launchOpencodeServer(hostname, preferredPort, config) {
  const attemptedPorts = new Set<number>();
  let launchPort = await pickLaunchPort(hostname, preferredPort);
  let lastError: unknown = null;
  const maxAttempts = 5;

  for (let i = 0; i < maxAttempts; i++) {
    attemptedPorts.add(launchPort);
    try {
      return await spawnOpencodeServer(hostname, launchPort, config);
    } catch (error) {
      lastError = error;
      if (!isPortConflictError(error, launchPort)) {
        throw error;
      }
      // Race happened. Grab any free port and retry.
      launchPort = await pickLaunchPort(hostname, 0);
    }
  }

  throw new Error(`Unable to start OpenCode after ${maxAttempts} attempts; tried ports ${Array.from(attemptedPorts).join(", ")}. Last error: ${lastError}`);
}
```

Additionally: document in `reservePort`'s JSDoc that the reservation is *advisory* and that callers must handle `EADDRINUSE` at spawn time.

**Verification:**
1. Test that simulates the race (two concurrent `pickLaunchPort` for the same preferred port) and confirms only one spawn succeeds, the other retries cleanly.
2. CI spawning multiple OpenCode instances in parallel succeeds 100% of runs.

**Effort:** 30 minutes.

---

## F-072 · Prefer `error.code === "EADDRINUSE"` over substring match

**Flaw it pairs with:** port-conflict detection via string matching.

**Proposed code:**

```ts
function isPortConflictError(error: unknown, port: number): boolean {
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") return true;
  }
  // Fallback for errors thrown as strings by OpenCode's own wrappers.
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`port ${port}`) && message.includes("use");
}
```

Loosen the fallback pattern (`port X` + `use`) so minor phrasing changes don't break it. Error codes are the reliable path.

**Verification:** synthetic test with an `ErrnoException({ code: "EADDRINUSE" })` vs a raw Error with custom text — both detected.

**Effort:** 15 minutes. Bundles with F-071.

---

## F-073 · More resilient server-URL parsing + structured log output

**Flaw it pairs with:** brittle stdout parsing.

**Proposed code:**

```ts
const LISTENING_RE = /opencode\s+server\s+listening.*?(https?:\/\/[^\s]+)/i;

proc.stdout?.on("data", (chunk: Buffer) => {
  const text = stripAnsi(chunk.toString());  // strip color codes
  output += text;
  // Match across potentially buffered lines, case-insensitive
  const match = output.match(LISTENING_RE);
  if (match) { clearTimeout(timeout); resolve({ url: match[1], proc }); }
});
```

Use a library for ANSI stripping (`strip-ansi` from npm, ~1 kB). Case-insensitive. Matches across newlines if needed.

On timeout, include `output` in the error for easier debugging:

```ts
const timeout = setTimeout(() => {
  reject(new Error(`Timeout waiting for OpenCode. Last ${MAX_DIAG_CHARS} chars of output:\n${output.slice(-MAX_DIAG_CHARS)}`));
}, 45_000);
```

Longer-term: file an issue upstream asking OpenCode to expose a stable startup hook (e.g. `--port-file=/tmp/opencode.port` + watch the file).

**Verification:** synthetic test feeding various OpenCode log formats (with/without ANSI, different casing) — all detected.

**Effort:** 30 minutes.

---

## F-074 · Pipe stderr to structured logger during normal operation

**Flaw it pairs with:** stderr silently collected, never surfaced except on error.

**Proposed code** — after startup completes (see F-067's `detach()`), attach a pass-through:

```ts
function detach() {
  proc.stdout?.off("data", onStdoutData);
  proc.stderr?.off("data", onStderrData);

  // Live forwarding during normal operation.
  proc.stdout?.on("data", (c) => {
    for (const line of c.toString().split("\n").filter(Boolean)) {
      logger.info({ event: "opencode.stdout", line });
    }
  });
  proc.stderr?.on("data", (c) => {
    for (const line of c.toString().split("\n").filter(Boolean)) {
      logger.warn({ event: "opencode.stderr", line });
    }
  });
}
```

For exit-error diagnostics, keep a small ring buffer (e.g. last 500 lines) so crash dumps include recent context.

**Verification:**
1. Force OpenCode to print a stderr warning; confirm it appears in Arceus's structured log at warn level with `event: "opencode.stderr"`.
2. Memory check: stderr spam doesn't grow unboundedly (ring buffer is bounded).

**Effort:** 30 minutes. Bundles with F-067.

---

## F-075 · Deep merge in `loadOpencodeConfig`

**Flaw it pairs with:** shallow merge silently drops nested keys.

**Proposed code** — option A, library:

```ts
import merge from "lodash.merge";  // pnpm add lodash.merge

function loadOpencodeConfig(overrides: Record<string, unknown>): Record<string, unknown> {
  const configPath = resolve(repoRoot, "opencode.json");
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;  // F-077
  }
  return merge({}, base, overrides);  // empty target so base isn't mutated
}
```

Option B, hand-rolled (only plain objects, no arrays):

```ts
function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    const baseVal = out[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v) &&
        baseVal !== null && typeof baseVal === "object" && !Array.isArray(baseVal)) {
      out[k] = deepMerge(baseVal as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
```

Document the array behavior you pick (replace vs concat — default "replace" matches `lodash.merge` and most common user expectations).

**Verification:** test with nested overrides; confirm base's non-overridden nested keys survive.

**Effort:** 20 minutes.

---

## F-076 · Move `syncOpencodeConfigToWorkspace` to async, once-per-lifecycle

**Flaw it pairs with:** sync I/O duplicated per spawn.

**Proposed code:**

```ts
import { writeFile, mkdir, copyFile, readdir } from "node:fs/promises";

async function syncOpencodeConfigToWorkspace(mergedConfig: Record<string, unknown>): Promise<void> {
  const configTarget = resolve(productWorkspace, "opencode.json");
  const tmpTarget = `${configTarget}.tmp.${process.pid}`;

  // Atomic write — temp + rename. If rename fails, old config stays.
  await writeFile(tmpTarget, JSON.stringify(mergedConfig, null, 2), "utf8");
  await rename(tmpTarget, configTarget);

  const srcPrompts = resolve(repoRoot, ".opencode", "prompts");
  const dstPrompts = resolve(productWorkspace, ".opencode", "prompts");
  if (await pathExists(srcPrompts)) {
    await mkdir(dstPrompts, { recursive: true });
    const entries = await readdir(srcPrompts);
    await Promise.all(entries.map((f) =>
      copyFile(resolve(srcPrompts, f), resolve(dstPrompts, f))
    ));
  }
}
```

Call **once per manager lifecycle** (inside `OpencodeManager.getOpencode` on first call, not per spawn). Cache a "last synced" flag so we don't re-sync on reconnect.

```ts
#configSynced = false;
async #ensureConfigSynced() {
  if (this.#configSynced) return;
  await syncOpencodeConfigToWorkspace(loadOpencodeConfig({ share: "disabled" }));
  this.#configSynced = true;
}
```

Invalidate on config reload (e.g. SIGHUP).

**Verification:**
1. Two parallel test spawns; confirm only one actually does the sync work.
2. Event loop responsiveness measured during sync — should not exceed normal HTTP latency (<10 ms).

**Effort:** 45 minutes. Bundles with F-069.

---

## F-077 · Distinguish ENOENT from SyntaxError in `loadOpencodeConfig`

**Flaw it pairs with:** catch-all in config loader.

**Proposed code** (already shown inline in F-075):

```ts
try {
  base = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    // File exists but can't be parsed / read → surface the error
    throw err;
  }
  // File missing → fall back silently
}
```

**Verification:**
1. Test with missing file → returns overrides-only.
2. Test with malformed JSON → throws readable `SyntaxError: Unexpected token ...`.
3. Test with permission denied → throws readable `EACCES`.

**Effort:** 10 minutes. Bundles with F-075.

---

## F-078 · Validate Azure runtime config at startup

**Flaw it pairs with:** `ensureAzureRuntimeEnvironment` doesn't validate.

**Proposed code** — already partially addressed by F-065's delete; the remaining guard belongs in config parsing:

```ts
// apps/api/src/config/runtime.ts (or wherever runtimeConfig is built)
import { z } from "zod";

export const runtimeConfigSchema = z.object({
  azureApiKey: z.string().min(10, "azureApiKey missing or too short"),
  azureEndpoint: z.string().url("azureEndpoint must be a URL"),
  azureApiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/, "azureApiVersion format invalid"),
  azureResourceName: z.string().min(1),
  opencodeHost: z.string().min(1),
  opencodePort: z.number().int().min(1).max(65535),
  // ...
});

export const runtimeConfig = runtimeConfigSchema.parse(rawRuntimeConfig);
```

Server refuses to boot with a clear error if any required field is missing/invalid.

**Verification:** unset `ARCEUS_AZURE_API_KEY`; server boot fails with a readable "azureApiKey missing or too short" error.

**Effort:** 30 minutes.

---

## F-079 · Add per-request `AbortSignal` with timeout to `postOpencodeJson`

**Flaw it pairs with:** no timeout on fetch.

**Proposed code:**

```ts
const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 30_000;

export async function postOpencodeJson<T>(
  path: string,
  body: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;

  return resilientCall(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("opencode request timeout")), timeoutMs);
      // Honor caller-provided signal too
      options.signal?.addEventListener("abort", () => controller.abort(options.signal!.reason));
      try {
        const response = await fetch(`${opencode.server.url}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`OpenCode ${path}: ${response.status} ${response.statusText}`);
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    },
    { breaker: breakers.opencode, shouldRetry: isRetryableError },
  );
}
```

Long-running tool calls can opt out: `postOpencodeJson(path, body, { timeoutMs: 5 * 60_000 })`.

**Verification:**
1. Stub `fetch` to never resolve; confirm the call rejects after 30s with "opencode request timeout."
2. Normal fast call still succeeds under the limit.

**Effort:** 30 minutes.

---

## F-080 · Verify OpenCode identity before reusing an existing server

**Flaw it pairs with:** probe accepts any SSE server as "OpenCode."

**Proposed code:**

```ts
async function detectExistingOpencodeServer(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    // Replace the /event probe with a lightweight identity check.
    const response = await fetch(`${url}/version`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json();
    // OpenCode exposes { name, version, ... } on /version — verify.
    return typeof body === "object" && body !== null && (body as any).name === "opencode";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
```

If OpenCode doesn't have a `/version` endpoint, use another request that confirms the shape (e.g. `GET /session` returning a known-OpenCode response key).

**Verification:** point the probe at `httpbin.org/stream` (an SSE-like endpoint) — old code returns `true`, new code returns `false`.

**Effort:** 20 minutes.

---

## F-081 · Require `https://` for non-local OpenCode hosts

**Flaw it pairs with:** hardcoded `http://`.

**Proposed code** — parse protocol based on host:

```ts
function buildOpencodeUrl(host: string, port: number): string {
  const isLocal = host === "localhost" || host === "127.0.0.1" || host.startsWith("172.") || host.startsWith("192.168.");
  const scheme = isLocal ? "http" : "https";
  return `${scheme}://${host}:${port}`;
}

// Usage
const existingUrl = buildOpencodeUrl(runtimeConfig.opencodeHost, runtimeConfig.opencodePort);
```

Or better: make the full URL part of config, validated:

```ts
export const runtimeConfigSchema = z.object({
  // ...
  opencodeUrl: z.string().url().refine((u) => {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }, "opencodeUrl must be https:// unless pointing at localhost"),
});
```

**Verification:** setting `opencodeUrl: "http://prod.example.com:8080"` fails config validation.

**Effort:** 20 minutes. Bundles with F-078.

---

## F-082 · Wrap event-stream reader with cleanup contract

**Flaw it pairs with:** reader leaked if caller forgets to cancel.

**Proposed code** — option A, callback-style helper:

```ts
export async function consumeOpencodeEvents(
  onChunk: (chunk: Uint8Array) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  return resilientCall(
    async () => {
      const opencode = await getOpencode();
      const controller = new AbortController();
      options.signal?.addEventListener("abort", () => controller.abort(options.signal!.reason));

      const response = await fetch(`${opencode.server.url}/event`, { signal: controller.signal });
      if (!response.ok || !response.body) {
        throw new Error(`Unable to open OpenCode event stream: ${response.status}`);
      }
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) onChunk(value);
        }
      } finally {
        await reader.cancel().catch(() => {});  // best-effort
      }
    },
    { breaker: breakers.opencode, shouldRetry: isRetryableError },
  );
}
```

Call sites use:

```ts
await consumeOpencodeEvents((chunk) => { /* parse SSE */ }, { signal: shutdownSignal });
```

Keep the old `openOpencodeEventStream` for callers that genuinely need a reader; add a loud JSDoc requiring cancellation.

**Verification:**
1. Abort the signal mid-stream; confirm the reader is cancelled and the fetch terminates.
2. Normal-termination path: confirm reader.cancel() runs on done.

**Effort:** 45 minutes.

---

## F-083 · Audit events on every OpenCode lifecycle transition

**Flaw it pairs with:** no audit integration in opencode.ts.

**Proposed code** — within `OpencodeManager` (F-069), add audit at each lifecycle edge:

```ts
class OpencodeManager {
  private audit(eventType: string, summary: string, detail?: Record<string, unknown>, severity: "info" | "warn" | "error" = "info") {
    audit({
      companyId: getSnapshot().company.id,
      category: severity === "error" ? "error" : "system",
      severity,
      eventType,
      summary,
      detail,
    });
  }

  async spawnOpencode(): Promise<void> {
    this.audit("opencode.spawn.start", "spawning OpenCode child process");
    try {
      // ... spawn
      this.audit("opencode.spawn.success", `OpenCode listening at ${url}`, { url, pid: proc.pid });
    } catch (err) {
      this.audit("opencode.spawn.failed", "OpenCode spawn failed", { error: serializeError(err) }, "error");
      throw err;
    }
  }

  // Similar audit at:
  //   opencode.session.create, opencode.session.destroy, opencode.session.destroy_failed (F-068)
  //   opencode.reset, opencode.child.exited, opencode.child.crashed
  //   opencode.warmup.start, opencode.warmup.success, opencode.warmup.failed (F-084)
}
```

**Verification:** run a full cycle (warmup → beat → reset) and query audit ledger: expect ~10 entries per cycle for the OpenCode domain.

**Effort:** 1 hour. Bundled with F-069.

---

## F-084 · `warmUp` failure emits audit + logger (cross-ref F-041)

**Flaw it pairs with:** `warmUpOpencode` silently clears state.

**Fix:** bundled with F-041 + F-083. Within `OpencodeManager.warmUp()`:

```ts
async warmUp(): Promise<boolean> {
  this.audit("opencode.warmup.start", "pre-warming OpenCode server");
  try {
    await this.getOpencode();
    this.audit("opencode.warmup.success", "OpenCode ready");
    return true;
  } catch (err) {
    this.audit("opencode.warmup.failed", "warmup failed; first request will pay cold-start cost",
      { error: serializeError(err) }, "warn");
    await this.reset();  // clear cache so next call retries
    return false;
  }
}
```

**Verification:** covered by F-041 + F-083.

**Effort:** 0 (bundled).

---

## F-085 · Accept `zodSchema` parameter on `postOpencodeJson`

**Flaw it pairs with:** `as T` cast on response body.

**Proposed code:**

```ts
import type { ZodType } from "zod";

export async function postOpencodeJson<T>(
  path: string,
  body: unknown,
  options: { schema?: ZodType<T>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  return resilientCall(async () => {
    // ... fetch logic from F-079
    if (response.status === 204) return undefined as T;
    const json = await response.json();
    if (options.schema) return options.schema.parse(json);
    return json as T;  // caller explicitly opted out of validation
  }, { breaker: breakers.opencode, shouldRetry: isRetryableError });
}
```

Gradual migration — existing callers continue passing no schema; new callers pass one. Over time, the unvalidated path can be deprecated.

**Verification:**
1. Call with a Zod schema; confirm validation runs and shape mismatches throw.
2. Existing callers (no schema) behave unchanged.

**Effort:** 15 minutes. Bundles with F-079.

---

---

## F-086 · Re-enable CAS; fix the version-scope design so concurrent unrelated mutations don't collide

**Flaw it pairs with:** `cpApplyMutations` concurrency check is commented out.

**Root cause:** the `snapshotVersion` is a single process-global integer. Every mutation bumps it. Two agents mutating *different* tasks artificially conflict because they share the counter. The "fix" (disable the check) papers over a design error at a higher level — the version should be per-entity or per-affected-entity-set, not global.

**Three-stage fix.**

### Stage 1 — near-term (this sprint): re-enable the check + retry

Re-enable the check; callers retry on conflict.

```ts
export function cpApplyMutations(
  companyId, mutations, causation, expectedVersion
): { version: number; applied: number; errors: string[]; conflict?: true } {
  if (expectedVersion !== undefined && expectedVersion !== snapshotVersion) {
    return {
      version: snapshotVersion,
      applied: 0,
      errors: [`Optimistic concurrency conflict: expected v${expectedVersion}, current v${snapshotVersion}`],
      conflict: true,
    };
  }
  // ... rest of existing logic
}
```

Callers (heartbeat-engine, route handlers) catch `conflict: true` and retry with the fresh version:

```ts
async function applyWithRetry(mutations, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const version = cpGetSnapshotVersion();
    const result = cpApplyMutations(companyId, mutations, causation, version);
    if (!result.conflict) return result;
    // Rebuild mutations from fresh snapshot and retry
    await sleep(10 * Math.pow(2, i));
  }
  throw new Error("CAS retry exhausted");
}
```

### Stage 2 — medium-term: per-entity versioning

Each mutable entity (task, sprint, meeting) gets its own version counter. A task mutation checks the task's version, not the global one. Two agents mutating different tasks never conflict.

```ts
// In-memory
const entityVersions = new Map<string, number>();  // key: "task:abc123" → version

function cpApplyMutations(
  companyId, mutations,
  expectedVersions: Record<string, number>,  // e.g. { "task:abc123": 5, "sprint:xyz": 2 }
) {
  for (const [key, expected] of Object.entries(expectedVersions)) {
    const current = entityVersions.get(key) ?? 0;
    if (current !== expected) return { conflict: true, conflictKey: key };
  }
  // Apply, then bump each affected entity's version
  for (const m of mutations) {
    applyOneMutation(companyId, m);
    entityVersions.set(keyFor(m), (entityVersions.get(keyFor(m)) ?? 0) + 1);
  }
  // ...
}
```

### Stage 3 — long-term: DB-backed transactional mutations

All mutations flow through a Drizzle transaction; use DB-level advisory locks or row-level `SELECT FOR UPDATE` on the affected entities. Real atomicity, no hand-rolled CAS.

**Verification (Stage 1):**
1. Test: two concurrent `cpApplyMutations` with the same `expectedVersion` — one succeeds, other gets `conflict: true`.
2. E2E: two parallel beats mutating the same task; exactly one mutation lands (the other retries or errors visibly).
3. Grep: every caller of `cpApplyMutations` now handles the `conflict` case or is wrapped by `applyWithRetry`.

**Effort:**
- Stage 1: 2 hours (including caller migration).
- Stage 2: 1-2 days (per-entity versioning + key derivation).
- Stage 3: 1-2 weeks, coupled with F-002 Stage B.

---

## F-087 · Never run `npm run build`; use fixed `tsc --noEmit` command array with `shell: false`

**Flaw it pairs with:** workspace-to-host RCE via `npm run build`.

**Root cause:** the build check trusts `package.json` authored in an agent-writable directory.

**Proposed code:**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export async function cpRunBuildCheck(productDir: string): Promise<typeof lastBuildCheck> {
  if (!existsSync(productDir)) {
    return (lastBuildCheck = { status: "unknown", detail: `missing: ${productDir}`, checkedAt: new Date().toISOString() });
  }
  if (!existsSync(join(productDir, "tsconfig.json"))) {
    return (lastBuildCheck = { status: "ok", detail: "no tsconfig.json", checkedAt: new Date().toISOString() });
  }

  try {
    // FIXED command array — no shell, no user-controlled args.
    await execFileAsync("npx", ["tsc", "--noEmit", "--project", productDir], {
      cwd: productDir,
      timeout: 30_000,
      shell: false,   // explicit: no shell interpretation
      env: { PATH: process.env.PATH, HOME: process.env.HOME },  // minimal env
    });
    lastBuildCheck = { status: "ok", detail: "tsc --noEmit passed", checkedAt: new Date().toISOString() };
  } catch (err) {
    const stderr = (err as any)?.stderr?.toString?.() ?? "";
    lastBuildCheck = { status: "error", detail: stderr.slice(0, 500), checkedAt: new Date().toISOString() };
  }
  return lastBuildCheck;
}
```

Key changes:
1. `execFile` (not `exec`/`execSync`) — no shell interpretation.
2. Fixed argv array — even if `productDir` contains shell specials, they never reach a shell.
3. Never reads `package.json.scripts.build`. Only runs `tsc`.
4. Async. Fixes F-093 simultaneously.

**Sandboxing for stronger defense (optional):** run `tsc` in a Docker container with the workspace mounted read-only and no network access. Any compromise is contained.

**Verification:**
1. Place `{"scripts": {"build": "echo hacked"}}` in a test workspace; call `cpRunBuildCheck`; assert "hacked" is not printed anywhere.
2. Synthetic `productDir` = `"/tmp/x; rm -rf /"` (literal string with shell specials); confirm the `rm` doesn't execute.
3. Normal tsc run succeeds.

**Effort:** 1 hour. Bundles with F-093.

---

## F-088 · All-or-nothing batch mutation

**Flaw it pairs with:** `cpApplyMutations` is non-atomic despite docstring.

**Proposed code — two-pass approach:**

```ts
export function cpApplyMutations(companyId, mutations, causation, expectedVersion) {
  // ... CAS check (F-086)

  // Pass 1: validate every mutation without side effects.
  const validationErrors: string[] = [];
  for (const m of mutations) {
    const err = validateMutation(m, getSnapshot());  // returns string | null
    if (err) validationErrors.push(`${m.type}: ${err}`);
  }
  if (validationErrors.length > 0) {
    audit({
      companyId, category: "error", severity: "error",
      eventType: "mutations_rejected",
      summary: `Batch of ${mutations.length} rejected: ${validationErrors.length} validation errors`,
      detail: { errors: validationErrors, mutations: mutations.map((m) => m.type) },
    });
    return { version: snapshotVersion, applied: 0, errors: validationErrors };
  }

  // Pass 2: apply (previous try/catch-per-mutation becomes unnecessary because validation guarded).
  let applied = 0;
  try {
    for (const m of mutations) {
      applyOneMutation(companyId, m, causation?.eventId);
      applied++;
    }
  } catch (err) {
    // Apply-time error after validation = genuine bug; roll back what we applied.
    // ... rollback logic (challenging with the current store; see below)
  }

  const version = bumpVersion();
  // ...
}

function validateMutation(m: StateMutation, snap: CompanySnapshot): string | null {
  switch (m.type) {
    case "task_status": {
      const task = snap.tasks.find((t) => t.id === m.taskId);
      if (!task) return `task ${m.taskId} not found`;
      // ... other checks
      return null;
    }
    // ... cases for each mutation type
    default: return assertNever(m);
  }
}
```

### Rollback is hard with the current store shape

The write-back cache (F-002) makes rollback awkward. A partial in-memory apply that needs undoing requires either:
- **Snapshot before apply; restore on error** — expensive for large snapshots.
- **Log of inverse mutations** — each mutation kind needs a paired inverse.
- **DB-transactional applies** — defers the problem to the DB layer (the Stage 3 fix of F-086).

For now: **validation pass + audit-on-apply-failure** reduces the problem to "validation was thorough enough." Track any apply-time throw as a critical audit event to catch validation gaps.

**Verification:**
1. Test: batch of 3 mutations where #2 fails validation → 0 applied, clear error for mutation #2.
2. Test: batch of 3 where #2 throws at apply time → audit entry `mutations_partial_apply` with rollback details.

**Effort:** 4-6 hours including validator functions for each mutation type.

---

## F-089 · `ControlPlane` class (umbrella refactor)

**Flaw it pairs with:** 7 module-level singletons in control-plane.ts.

**Proposed code — parallel to F-043 + F-069:**

```ts
// apps/api/src/persistence/control-plane.ts (new class form)
export class ControlPlane {
  #snapshotVersion = 0;
  #mutationCount = 0;
  #buildCheckProductDir: string | null = null;
  #lastBuildCheck = { status: "unknown" as const, detail: "Not yet checked", checkedAt: new Date().toISOString() };
  #trustScoreCache = new Map<string, TrustScore>();
  #recentViolationsCache: PolicyViolation[] = [];
  readonly #startedAt = new Date().toISOString();

  constructor(
    private readonly store: StoreFacade,
    private readonly audit: Audit,
    private readonly db: DbClient | null,
    private readonly logger: FastifyBaseLogger,
  ) {}

  getSnapshotVersion(): number { return this.#snapshotVersion; }

  applyMutations(companyId, mutations, causation, expectedVersion): { version; applied; errors } {
    // F-086, F-088, F-090 logic here
  }

  async loadAgentContext(agentId, beatId, beatNumber, trigger, config): Promise<AgentBeatContext | null> {
    // F-092 fixed here — thin wrapper calling buildAgentContext(...) from a dedicated module
  }

  async commitBeatRecord(record: BeatRecord): Promise<boolean> { /* F-112 */ }
  async updateTrustScore(event: TrustEvent): Promise<TrustScore> { /* F-104 */ }
  async hydrateTrustScores(): Promise<void> { /* F-108 */ }
  // ... etc

  async dispose(): Promise<void> {
    // Unsubscribe store events (F-095)
    this.#storeUnsubscribes.forEach((u) => u());
    this.#trustScoreCache.clear();
    this.#recentViolationsCache.length = 0;
  }
}
```

Construct one instance inside `startServer()` (F-005). Every consumer of `cpLoadAgentContext` / `cpApplyMutations` / etc. now calls `app.services.controlPlane.*`.

**Migration path:**
1. Add the class alongside existing exports.
2. One-by-one, migrate callers.
3. Delete the module-level exports when zero callers remain.

**Verification:** same as F-043 — grep for `cpLoadAgentContext` etc. → 0 direct imports; everything routes through the class.

**Effort:** 6-8 hours. Collapses F-089, F-095, F-104, F-107, F-108, F-112 into one refactor.

---

## F-090 · Align `StateMutation` with store-helper shapes; delete all `as any` casts in `applyOneMutation`

**Flaw it pairs with:** 7 `as any` casts in the mutation switch.

**Proposed code:**

```ts
// packages/contracts/src/mutations.ts
export const taskStatusMutationSchema = z.object({
  type: z.literal("task_status"),
  taskId: z.string(),
  status: taskStatusSchema,
  summary: z.string().optional(),
});

export const taskCreateMutationSchema = z.object({
  type: z.literal("task_create"),
  task: taskSchema,  // full Task shape — no `as any` downstream
});
// ... etc for every mutation type

export const stateMutationSchema = z.discriminatedUnion("type", [
  taskStatusMutationSchema,
  taskCreateMutationSchema,
  // ... etc
]);
export type StateMutation = z.infer<typeof stateMutationSchema>;
```

Then `applyOneMutation` can strip every cast:

```ts
function applyOneMutation(companyId, mutation: StateMutation, causationId?: string) {
  switch (mutation.type) {
    case "task_status":
      updateTask(mutation.taskId, (t) => ({ ...t, status: mutation.status, ...(mutation.summary ? { summary: mutation.summary } : {}) }));
      return;
    case "task_create":
      upsertTask(mutation.task);   // no cast
      return;
    // ... etc
    default: return assertNever(mutation);  // F-114 lands
  }
}
```

`updateTask` / `upsertTask` / etc. signatures in store.ts use the same types from contracts.

**Verification:** `grep "as any" apps/api/src/persistence/control-plane.ts` → zero hits in `applyOneMutation`.

**Effort:** 2 hours (the tricky part is getting the store-helper signatures to accept the narrowed types).

---

## F-091 · Audit persistence-write failures

**Flaw it pairs with:** `schedulePersistedCompanyState(...).catch(() => {})`.

**Proposed code:**

```ts
const snapshot = getSnapshot();
schedulePersistedCompanyState(snapshot, getEvents()).catch((err) => {
  audit({
    companyId, category: "error", severity: "error",
    eventType: "persist_write_failed",
    summary: "Failed to persist snapshot — mutations may not survive restart",
    detail: { error: serializeError(err), mutationsApplied: applied, version },
  });
  persistFailureCount.inc();  // metric
});
```

Expose a metric on `/api/health`:

```ts
{
  persistWriteFailures: persistFailureCount.value,
  lastPersistAttemptAt: ...,
  lastPersistSuccessAt: ...,
}
```

Alerting: if `persistWriteFailures > 0` for more than 60s, page the operator.

**Verification:** stub `schedulePersistedCompanyState` to reject once; confirm audit entry + metric increment + log line.

**Effort:** 30 minutes.

---

## F-092 · Extract `buildAgentContext` helper

**Flaw it pairs with:** 165-line `cpLoadAgentContext`.

**Proposed code** — new file `apps/api/src/heartbeats/build-agent-context.ts`:

```ts
export interface BuildAgentContextDeps {
  snapshot: CompanySnapshot;
  trustScoreFor: (agentId: string) => number;
  toolsFor: (companyId: string, role: string) => Tool[];
  filterTools: (...) => FilterResult;
  runBuildCheck: () => void;   // may be a no-op; F-100
  latestDailySyncBrief: (snap: CompanySnapshot) => DailySyncBrief | null;
  emitActivity: (...) => void;
  config: { beatTokenBudget: number; beatCostCeilingCents: number };
}

export function buildAgentContext(
  agentId: string,
  beatId: string,
  beatNumber: number,
  trigger: BeatRecord["trigger"],
  deps: BuildAgentContextDeps,
): AgentBeatContext | null {
  const agent = findAgent(deps.snapshot, agentId);
  if (!agent) return null;

  const tasks = filterAgentTasks(deps.snapshot, agent);   // handles CEO/PM + tester-in-review edge cases
  const artifacts = collectArtifacts(deps.snapshot, tasks);
  const tools = applyToolPolicy(deps, agent, beatId);
  const memories = assembleMemories(deps.snapshot, agent);
  const meetings = recentMeetings(deps.snapshot);
  const approvals = pendingApprovals(deps.snapshot);

  deps.emitActivity("context", { /* ... */ });

  return {
    beatId, beatNumber, trigger, startedAt: new Date().toISOString(),
    agentId: agent.id, agentName: agent.name, role: agent.role, soul: agent.soul,
    company: deps.snapshot.company,
    currentSprint: currentSprint(deps.snapshot),
    hierarchy: deps.snapshot.hierarchy,
    managerAgentId: agent.managerAgentId,
    reportAgentIds: agent.reportAgentIds,
    tasks, artifacts, memories, /* ... */,
    ...(agent.role === "skills_lead" ? buildSkillsLeadContext(...) : {}),
  };
}
```

Each helper (`filterAgentTasks`, `collectArtifacts`, `applyToolPolicy`, …) is its own named function, independently testable. `cpLoadAgentContext` becomes a 5-line wrapper.

**Verification:**
1. Existing tests around `cpLoadAgentContext` still pass.
2. Each sub-helper has its own unit test.

**Effort:** 3-4 hours.

---

## F-093 · Async build check; agents read cached result only

**Flaw it pairs with:** `execSync` blocks the event loop 30s.

**Proposed code** — already shown in F-087. The `cpRunBuildCheck` becomes async (`execFile` wrapped in `promisify`), returns a Promise, updates the cache when it finishes.

Background timer drives refresh, not agent beats:

```ts
// Inside startServer()
setInterval(() => {
  cpRunBuildCheck(buildCheckProductDir).catch((err) => app.log.warn({ err, event: "build_check_failed" }));
}, 60_000);
```

Agents read `cpGetLastBuildCheck()` (synchronous, returns cached result). Never wait for a fresh one inline.

**Verification:**
1. Force a hanging build; confirm agents continue to serve requests without blocking.
2. Build result updates within the refresh interval.

**Effort:** 1 hour. Bundled with F-087 + F-100.

---

## F-094 · Move truncation policies to explicit boundaries

**Flaw it pairs with:** silent `slice(-50)` + `slice(0, 300)`.

**Proposed code:**

**Results: move to an append-only log.**

```ts
// Instead of truncating in-memory:
export function cpCommitTaskResult(companyId, taskId, result: TaskResult): void {
  // ... existing code
  updateTask(taskId, (t) => ({
    ...t,
    status: "completed",
    completedAt: new Date().toISOString(),
    executorState: { ...t.executorState, latestResultAt: result.beatId },  // single pointer
  }));
  // Append to a separate task_results log
  appendTaskResult({
    taskId, beatId: result.beatId, summary: result.summary,
    artifacts: result.artifacts, createdAt: new Date().toISOString(),
  });
}

// Query by taskId when the UI/agent needs the history
export function getTaskResults(taskId: string, limit = 50): TaskResult[] { /* ... */ }
```

**Feedback: validate length at input, fail loud.**

```ts
const FEEDBACK_MAX_CHARS = 300;

if (result.summary.length > FEEDBACK_MAX_CHARS) {
  // Either reject the result at input, or emit a metric + warn audit
  audit({
    category: "system", severity: "warn",
    eventType: "feedback_truncated",
    summary: `Feedback exceeded ${FEEDBACK_MAX_CHARS} chars — callers should be fixed`,
    detail: { taskId, originalLength: result.summary.length },
  });
}

// Still truncate if a caller ignores, but now there's an audit trail.
const feedback = result.summary.slice(0, FEEDBACK_MAX_CHARS);
```

**Verification:**
1. Commit 60 task results in a test; assert all 60 are retrievable via `getTaskResults`.
2. Commit a feedback > 300 chars; confirm warn-level audit entry.

**Effort:** 2 hours.

---

## F-095 · Capture + cleanup store event subscriptions

**Flaw it pairs with:** `storeEvents.on(...)` never unsubscribed.

**Proposed code** (inside F-089's `ControlPlane` class):

```ts
class ControlPlane {
  #storeUnsubscribes: Array<() => void> = [];

  attachStoreListeners(storeEvents: StoreEventsEmitter) {
    this.#storeUnsubscribes.push(storeEvents.on("state-changed", () => this.#notifyStateChange()));
    this.#storeUnsubscribes.push(storeEvents.on("agents-hired", (agents) => this.#handleAgentsHired(agents)));
  }

  #handleAgentsHired(agents: Array<{ id: string }>) {
    // F-113 fix: use .catch, not .then
    Promise.allSettled(
      agents.map((a) => this.updateTrustScore({ agentId: a.id, kind: "manual_adjustment", delta: 0, reason: "Agent hired — initial trust", timestamp: new Date().toISOString() })),
    ).then((results) => {
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) this.logger.warn({ event: "trust_init_failed", failed, total: agents.length });
    }).catch((err) => this.logger.error({ event: "trust_init_handler_crashed", err }));
  }

  async dispose() {
    this.#storeUnsubscribes.forEach((u) => u());
    this.#storeUnsubscribes = [];
  }
}
```

`storeEvents.on(...)` must return an unsubscribe function. If it doesn't today, update the EventEmitter wrapper.

**Verification:**
1. Boot + dispose; assert `storeEvents.listenerCount("state-changed") === 0` post-dispose.
2. Tests can safely construct multiple `ControlPlane` instances without handler accumulation.

**Effort:** 45 minutes. Bundled with F-089.

---

## F-096 · Use `COMPANY_ID_PENDING` (cross-ref F-012)

Replace `snap.company.id === "company_pending"` with the typed constant from F-012.

**Effort:** 5 minutes.

---

## F-097 · Collapse ternary; verify `"stopped"` is real

```ts
// Before
status: executionStatus === "idle" ? "idle" : executionStatus === "stopped" ? "idle" : "executing"

// After
function translateExecutionStatus(s: ExecutionStatus | "stopped"): "idle" | "executing" {
  switch (s) {
    case "idle": case "stopped": return "idle";
    case "planning": case "executing": case "verifying": case "awaiting_board_review":
    case "paused": case "done": case "error": return "executing";
    default: return assertNever(s);
  }
}
```

**Investigate `"stopped"`** — `git grep "stopped" apps/api/src/` across the orchestration code. If nothing sets it, delete the branch; if something does, add `"stopped"` to the `ExecutionStatus` enum.

**Effort:** 20 minutes including the investigation.

---

## F-098 · Role enum (cross-ref F-052 / F-111)

**Fix:** F-052's Zod-derived role enum + replace every `agent.role === "..."` comparison with `agent.role === AgentRole.Xxx` (or similar). Covers F-098 + F-111 together.

**Effort:** 30 minutes once F-052 lands.

---

## F-099 · Add `reviewState` to the Sprint schema

```ts
// packages/contracts/src/sprints.ts
export const sprintReviewStateSchema = z.object({
  bugTaskIds: z.array(z.string()).default([]),
  // ... other review-state fields
}).optional();

export const sprintSchema = z.object({
  // ... existing fields
  reviewState: sprintReviewStateSchema,
});
```

Then delete the `as any` at line 417:

```ts
const reviewState = currentSprint?.reviewState;
if (reviewState?.bugTaskIds.length > 0) { /* ... */ }
```

**Effort:** 30 minutes.

---

## F-100 · Background build-check; no side effect in the load path

**Fix:** covered by F-093's solution — `cpLoadAgentContext` only reads `cpGetLastBuildCheck()`; the actual `cpRunBuildCheck` runs on a setInterval.

**Effort:** 0 (bundled).

---

## F-101 · Fail loud on null `startedAt`

```ts
// Before
startedAt: r.startedAt?.toISOString() ?? new Date().toISOString()

// After
startedAt: r.startedAt?.toISOString() ?? (() => {
  throw new Error(`beat_record ${r.id} has null startedAt — DB data integrity violation`);
})(),
```

Or if null is a valid state:

```ts
startedAt: r.startedAt?.toISOString() ?? null  // change return type to `string | null`
```

Pick one; the current silent fallback is neither.

**Effort:** 15 minutes.

---

## F-102 · Zod-validate DB rows before returning

```ts
const beatRecordRowSchema = z.object({
  // ... full schema matching the DB columns
});

const rows = await db.select().from(beatRecordsTable)...;
return rows.map((r) => {
  const parsed = beatRecordRowSchema.safeParse(r);
  if (!parsed.success) {
    audit({ category: "error", eventType: "beat_record_row_invalid", detail: { id: r.id, errors: parsed.error.issues } });
    return null;
  }
  return parsed.data;
}).filter((r): r is BeatRecord => r !== null);
```

**Effort:** 45 minutes.

---

## F-103 · Use top-level import for `readFileSync`

```ts
// Line 766 before
const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf-8"));

// After (readFileSync is already imported at line 2)
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
```

**Effort:** 2 minutes.

---

## F-104 · DB-first trust updates with write-through cache

```ts
async updateTrustScore(event: TrustEvent): Promise<TrustScore> {
  const current = await this.loadTrustScore(event.agentId);
  const updated = adjustTrust(current, event);

  // DB first; cache only if DB succeeds.
  if (this.db) {
    await this.db.insert(trustScoresTable).values({ /* ... */ }).onConflictDoUpdate({ /* ... */ });
  }
  // Cache reflects successful DB write.
  this.#trustScoreCache.set(event.agentId, updated);

  return updated;
}
```

If DB write fails, cache is unchanged (stale) — correct for restart recovery. No divergence.

**Verification:** simulate DB failure; cache doesn't advance; next read still returns old score.

**Effort:** 30 minutes. Bundles with F-089.

---

## F-105 · Bounded ring buffer for violations cache

```ts
class BoundedArray<T> {
  #items: T[] = [];
  constructor(private readonly maxSize: number) {}
  push(item: T) {
    this.#items.push(item);
    if (this.#items.length > this.maxSize) this.#items.shift();
  }
  toArray(): ReadonlyArray<T> { return this.#items; }
}

// Usage
#recentViolationsCache = new BoundedArray<PolicyViolation>(500);
this.#recentViolationsCache.push(violation);
```

**Effort:** 20 minutes.

---

## F-106 · Return `degraded` flag on cache-fallback reads

```ts
export async function cpGetPolicyViolations(opts?: { agentId?: string; limit?: number }):
  Promise<{ data: PolicyViolation[]; source: "db" | "cache"; degraded: boolean }> {
  if (isDatabaseConfigured()) {
    try {
      const rows = await /* ... */;
      return { data: rows, source: "db", degraded: false };
    } catch (err) {
      audit({ category: "error", eventType: "policy_violations_db_failed", detail: { error: serializeError(err) } });
      // Fall through to cache with degraded flag
    }
  }
  return { data: /* cache */, source: "cache", degraded: true };
}
```

UI / callers can surface the degraded state to operators.

**Effort:** 30 minutes.

---

## F-107 · Deep clone from `cpGetAllTrustScores`

```ts
export function cpGetAllTrustScores(): ReadonlyArray<Readonly<TrustScore>> {
  return Array.from(this.#trustScoreCache.values(), (ts) => ({ ...ts, history: [...ts.history] }));
}
```

**Effort:** 5 minutes.

---

## F-108 · Audit trust-hydrate failures; surface degraded state

```ts
async hydrateTrustScores(): Promise<void> {
  if (!this.db) return;
  try {
    const rows = await this.db.select().from(trustScoresTable);
    for (const row of rows) this.#trustScoreCache.set(row.agentId, { /* ... */ });
    this.logger.info({ event: "trust_hydrated", count: rows.length });
  } catch (err) {
    audit({
      companyId: "system", category: "error", severity: "error",
      eventType: "trust_hydrate_failed",
      summary: "Governance trust scores failed to hydrate — agents running on initial scores",
      detail: { error: serializeError(err) },
    });
    governanceDegraded = true;  // surface on /api/health
  }
}
```

**Effort:** 20 minutes. Bundled with F-030.

---

## F-109 · Warn on trust cache misses

```ts
#getTrustScoreOrWarn(agentId: string): number {
  const cached = this.#trustScoreCache.get(agentId);
  if (cached) return cached.score;

  this.logger.warn({ event: "trust_cache_miss", agentId }, "trust cache miss — using initial; check hydration");
  trustCacheMisses.inc();
  return TRUST_CONFIG.initialScore;
}
```

**Effort:** 10 minutes.

---

## F-110 · Implement or delete `taskProgress`

Grep every consumer of `AgentBeatContext.taskProgress`:

```bash
git grep -n "\.taskProgress" apps/ packages/
```

- If zero consumers → remove the field from `AgentBeatContext` schema.
- If consumers exist → write the query that populates it:
  ```ts
  taskProgress: snap.tasks
    .filter((t) => agentTasks.some((at) => at.id === t.id))
    .flatMap((t) => t.progressLog ?? []),
  ```

**Effort:** 20 minutes (mostly the grep).

---

## F-111 · Bundled with F-098

**Effort:** 0.

---

## F-112 · Audit + retry on `cpCommitBeatRecord` failure

```ts
async commitBeatRecord(record: BeatRecord, opts?: { retries?: number }): Promise<boolean> {
  if (!this.db) return false;
  const retries = opts?.retries ?? 2;
  for (let i = 0; i <= retries; i++) {
    try {
      await this.db.insert(beatRecordsTable).values({ /* ... */ });
      return true;
    } catch (err) {
      if (i === retries) {
        audit({
          companyId: record.companyId, category: "error", severity: "error",
          eventType: "beat_record_commit_failed",
          summary: `Failed to persist beat record ${record.id} after ${retries + 1} attempts`,
          detail: { beatId: record.id, error: serializeError(err) },
        });
        beatRecordWriteFailures.inc();
        return false;
      }
      await sleep(100 * Math.pow(2, i));
    }
  }
  return false;
}
```

**Effort:** 30 minutes.

---

## F-113 · Append `.catch` to `agents-hired` handler

```ts
.then((results) => {
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) this.logger.warn({ event: "trust_init_failed", failed });
}).catch((err) => this.logger.error({ event: "trust_init_handler_crashed", err }));
```

**Effort:** 5 minutes. Bundled with F-095.

---

## F-114 · `assertNever` in mutation switch default

```ts
import { assertNever } from "../lib/assert-never.js";

// apps/api/src/lib/assert-never.ts
export function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

// In applyOneMutation:
default:
  return assertNever(mutation);
```

Requires F-090's discriminated union to work.

**Effort:** 10 minutes.

---

## F-115 · Move imports to top of file

```ts
// Top of file — merge with existing imports
import { execSync, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
```

Delete the mid-file block at lines 736-738.

**Effort:** 5 minutes.

---

## F-116 · JSDoc the cost-column type choice

```ts
/**
 * Beat cost in cents, stored as `text` in the DB to preserve full precision
 * across very long-running agents (where a `numeric` column might lose
 * fractional cents at serialization boundaries). Kept as `number` in-memory.
 */
costCents: String(record.costCents),
```

Or better: change the DB column to `numeric(20, 4)` and drop the cast. Effort for the cast-free path is 1 hour (migration + code update).

**Effort:** 5 minutes for the JSDoc; 1 hour for the schema migration.

---

## F-117 · `Number.isFinite` on cost

```ts
costCents: Number.isFinite(Number(r.costCents)) ? Number(r.costCents) : 0
```

Preserves intent (NaN → 0) while being explicit about what "0 fallback" means.

**Effort:** 2 minutes.

---

---

## F-118 · Attribute LLM tokens to exactly one accumulator

**Flaw it pairs with:** `accumulateBeatTokens` double-counts across concurrent beats.

**Proposed code** — thread `beatId` / `meetingId` through audit context:

```ts
// azure-openai.ts
export type LlmAuditContext = {
  companyId: string;
  agentRole?: string;
  correlationId?: string;
  label?: string;
  // NEW — attribution hints
  beatId?: string;
  meetingId?: string;
};

function auditLlmCall(
  deployment: string, usage: AzureOpenAIUsage | undefined,
  latencyMs: number, ctx?: LlmAuditContext, schemaName?: string,
) {
  const totalTokens = /* ... existing ... */;

  // Attribute to EXACTLY one accumulator each.
  if (ctx?.beatId) {
    const current = beatTokenAccumulators.get(ctx.beatId);
    if (current !== undefined) beatTokenAccumulators.set(ctx.beatId, current + totalTokens);
  }
  if (ctx?.meetingId) {
    const current = meetingTokenAccumulators.get(ctx.meetingId);
    if (current !== undefined) meetingTokenAccumulators.set(ctx.meetingId, current + totalTokens);
  }

  audit({ /* ... */ });
}
```

Delete the old `accumulateBeatTokens` function. Update every call site of `chatCompletion` / `structuredCompletion` / `chatCompletionStream` to pass the right `beatId` or `meetingId` in `LlmAuditContext`:

```ts
// Before
await chatCompletion("workerDeployment", messages, { companyId, agentRole });

// After
await chatCompletion("workerDeployment", messages, { companyId, agentRole, beatId: ctx.beatId });
```

**Migration plan:**
1. Add the fields to `LlmAuditContext` as optional.
2. Update `auditLlmCall` to use them (above).
3. Grep every call site of the LLM functions; ensure each passes the right attribution.
4. Once 100% of callers pass attribution, add a warn audit when neither is set ("LLM call without attribution — cost tracking lost").

**Verification:**
1. Integration test: two concurrent beats, each makes 1 LLM call; confirm each beat's accumulator holds only its own tokens, not 2× the shared total.
2. Grep `chatCompletion(`/`structuredCompletion(`/`chatCompletionStream(` → every call site provides `beatId` or `meetingId`.

**Effort:** 2 hours including call-site migration.

---

## F-119 · Add `AbortSignal` + timeout to every LLM fetch

**Flaw it pairs with:** no fetch timeout.

**Proposed code:**

```ts
const DEFAULT_LLM_TIMEOUT_MS = Number(process.env.ARCEUS_LLM_TIMEOUT_MS ?? 60_000);

export async function chatCompletion(
  deploymentKey,
  messages,
  auditCtx?: LlmAuditContext,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  return resilientCall(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("LLM call timeout")), timeoutMs);
    options.signal?.addEventListener("abort", () => controller.abort(options.signal!.reason));

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { /* ... */ },
        body: JSON.stringify({ messages, temperature }),
        signal: controller.signal,   // ← new
      });
      // ... rest of handler
    } finally {
      clearTimeout(timer);
    }
  }, { breaker: breakers.azureOpenAI, shouldRetry: isRetryableError });
}
```

Apply the same pattern to `structuredCompletion` and `chatCompletionStream`. `AbortError` should be classified as non-retryable in `isRetryableError` (F-125).

**Verification:**
1. Stub fetch to never resolve; confirm calls reject after `timeoutMs`.
2. Caller-provided signal aborted mid-flight → call rejects immediately.

**Effort:** 30 minutes.

---

## F-120 · Structured error class; keep body out of `Error.message`

**Flaw it pairs with:** Azure error bodies leaked verbatim.

**Proposed code:**

```ts
export class AzureOpenAIError extends Error {
  constructor(
    readonly deployment: string,
    readonly status: number,
    readonly statusText: string,
    readonly body: string,   // kept as a field, NOT concatenated into message
    readonly schemaName?: string,
  ) {
    super(`Azure OpenAI ${deployment} returned ${status} ${statusText}${schemaName ? ` (schema: ${schemaName})` : ""}`);
    this.name = "AzureOpenAIError";
  }
}

// Call site
if (!response.ok) {
  const body = await response.text();
  throw new AzureOpenAIError(deployment, response.status, response.statusText, body.slice(0, 500));
}
```

`serializeError` (F-011) can decide whether to include `body` based on audit config (e.g. full body in stage, summary in prod).

Pair with F-007's Pino redaction — `err.body` path can be redacted at the logger layer if needed.

**Verification:** thrown error has `.status` + `.body` as structured fields; `err.message` contains only the short summary; audit entries show `body` separately, not concatenated.

**Effort:** 30 minutes.

---

## F-121 · Stream usage via `stream_options: { include_usage: true }`

**Flaw it pairs with:** streaming LLM calls don't track tokens.

**Proposed code:**

```ts
export async function chatCompletionStream(
  deploymentKey, messages, auditCtx?: LlmAuditContext, options?: {...}
): Promise<ReadableStream<Uint8Array>> {
  // ...
  const response = await fetch(url, {
    // ...
    body: JSON.stringify({
      messages,
      temperature: options?.temperature ?? 0.7,
      stream: true,
      stream_options: { include_usage: true },   // ← new
    }),
  });
  // ...

  // Wrap the stream to extract usage from the final chunks + emit audit when done.
  const [forCaller, forObserver] = response.body.tee();
  observeStream(forObserver, { deployment, auditCtx, streamStartedAt });
  return forCaller;
}

async function observeStream(stream: ReadableStream, ctx: ObserveCtx) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: AzureOpenAIUsage | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Parse SSE chunks; look for the chunk containing `"usage"`
      for (const event of parseSseEvents(buffer)) {
        const parsed = JSON.parse(event.data);
        if (parsed.usage) usage = parsed.usage;
      }
    }
    auditLlmCall(ctx.deployment, usage, Date.now() - ctx.streamStartedAt, ctx.auditCtx);
  } catch (err) {
    audit({ /* llm_stream_failed */ });
  }
}
```

`stream.tee()` duplicates the stream so the caller gets one copy and our observer gets another without interfering.

**Verification:**
1. Stream a known response; confirm `usage` is captured and audit event fires.
2. Tokens from the stream flow into the beat accumulator (F-118).

**Effort:** 2 hours — the SSE parsing + `tee` wiring is non-trivial.

---

## F-122 · Throw `LlmEmptyResponseError` instead of returning `""`

**Flaw it pairs with:** silent `""` fallback.

**Proposed code:**

```ts
export class LlmEmptyResponseError extends Error {
  constructor(readonly deployment: string, readonly schemaName?: string) {
    super(`Azure OpenAI ${deployment} returned no content${schemaName ? ` (schema: ${schemaName})` : ""}`);
    this.name = "LlmEmptyResponseError";
  }
}

// Replace line 136
const content = json.choices[0]?.message?.content;
if (!content) throw new LlmEmptyResponseError(deployment);
return content;
```

Callers can catch this and retry with a different prompt or fall back to a default.

**Verification:** mock Azure to return `{ choices: [] }`; confirm `LlmEmptyResponseError` thrown, not `""` returned.

**Effort:** 10 minutes.

---

## F-123 · Swap `resilientCall` order; fix docstring OR pick explicit semantics

**Flaw it pairs with:** docstring-vs-implementation mismatch.

**Two options; pick one and commit.**

### Option A (recommended): swap order — retries go through the breaker

```ts
export async function resilientCall<T>(fn, opts: ResilientCallOptions): Promise<T> {
  return withRetry(() => opts.breaker.execute(fn), opts);
}
```

Now each retry calls `breaker.execute` independently. The breaker sees each attempt as a separate outcome. When it's open, retries fail fast (via `CircuitOpenError`, classified non-retryable per line 231). Docstring becomes truthful.

### Option B: keep current order; rewrite docstring

```ts
/**
 * Runs `fn` through a retry loop wrapped by a circuit breaker.
 * The breaker sees ONE outcome per `resilientCall` — the final
 * result after retries are exhausted. Individual retry attempts
 * do NOT count against the breaker threshold.
 */
```

Option A is safer (faster breaker-open response, each retry benefits from fail-fast). Option B is a doc-only change with no behavior shift.

**Verification:**
- Option A: stub a breaker to be open; confirm `resilientCall` rejects with `CircuitOpenError` without calling `fn`.
- Either option: grep docstring matches implementation.

**Effort:** 15 minutes.

---

## F-124 · Audit + metric on breaker state changes

**Flaw it pairs with:** breaker state changes only stderr.

**Proposed code:**

```ts
import { audit } from "../observability/audit-ledger.js";

function logStateChange(from: CircuitState, to: CircuitState, name: string) {
  const severity = to === "open" ? "error" : to === "closed" ? "info" : "warn";

  audit({
    companyId: "_system",
    category: to === "open" ? "error" : "system",
    severity,
    eventType: `circuit_breaker.${to}`,
    summary: `Circuit breaker "${name}" transitioned ${from} → ${to}`,
    detail: { breakerName: name, from, to, ts: new Date().toISOString() },
  });

  circuitBreakerStateChanges.inc({ breaker: name, to });   // Prometheus counter
}
```

Alert rule (Prometheus/Grafana):

```
ALERT CircuitBreakerOpen
  IF sum(circuit_breaker_state) by (breaker, state) == 1 AND state == "open" for 120s
  FOR 2m
  LABELS { severity="high" }
  ANNOTATIONS { summary="Breaker {{ $labels.breaker }} has been open for 2+ minutes" }
```

**Verification:**
1. Trigger breaker open in test; confirm audit + metric both fire.
2. Dashboard shows breaker state over time.

**Effort:** 30 minutes.

---

## F-125 · Typed errors for retryable classification

**Flaw it pairs with:** string-matching in `isRetryableError`.

**Proposed code** — custom error classes that carry the signal as typed fields:

```ts
// apps/api/src/infra/errors.ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url?: string,
  ) {
    super(`HTTP ${status}${url ? ` (${url})` : ""}`);
    this.name = "HttpError";
  }
}

export class OpencodeStaleSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`OpenCode session ${sessionId} no longer exists`);
    this.name = "OpencodeStaleSessionError";
  }
}
```

Replace throw sites (F-120 fix throws `AzureOpenAIError` which can extend `HttpError`; opencode stale sessions throw `OpencodeStaleSessionError` instead of a generic error with specific text).

Rewrite `isRetryableError`:

```ts
export function isRetryableError(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;
  if (error instanceof AbortError) return false;  // F-119 — don't retry aborts

  if (error instanceof OpencodeStaleSessionError) return true;
  if (error instanceof HttpError) return isRetryableHttpStatus(error.status);

  if (error instanceof TypeError) return true;  // fetch network errors

  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNRESET" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
  }

  return false;
}
```

No string matching. Every classification decision is based on a typed field.

**Verification:**
1. Mock errors of each class; confirm correct classification.
2. Grep `msg.includes` and `msg.match` in `isRetryableError` → 0 results.

**Effort:** 1 hour (the error-class migration is what takes time; the classifier itself is quick).

---

## F-126 · Cap retry backoff with `maxDelay`

**Flaw it pairs with:** unbounded exponential backoff.

**Proposed code:**

```ts
export interface RetryOptions {
  maxRetries: number;
  delay: number;
  backoff: number;
  /** Maximum ms to wait between retries (cap on exponential growth). Default: 30_000 */
  maxDelay: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  delay: 1000,
  backoff: 2,
  maxDelay: 30_000,
};

// Inside withRetry:
const baseWait = delay * Math.pow(backoff, attempt - 1) * jitter;
const wait = Math.min(baseWait, maxDelay);
```

**Verification:**
1. Set `maxRetries=20`, `delay=1000`, `backoff=2`; confirm wait caps at `maxDelay`.
2. Total retry budget under high retry count is predictable.

**Effort:** 10 minutes.

---

## F-127 · Encapsulate token accumulators in a `LlmCostTracker` class

**Flaw it pairs with:** module-level token Maps.

**Proposed code:**

```ts
export class LlmCostTracker {
  readonly #beatTokens = new Map<string, number>();
  readonly #meetingTokens = new Map<string, number>();

  startBeat(beatId: string) { this.#beatTokens.set(beatId, 0); }
  drainBeat(beatId: string): number { const t = this.#beatTokens.get(beatId) ?? 0; this.#beatTokens.delete(beatId); return t; }
  startMeeting(meetingId: string) { this.#meetingTokens.set(meetingId, 0); }
  drainMeeting(meetingId: string): number { /* ... */ }

  attribute(totalTokens: number, ctx: { beatId?: string; meetingId?: string }) {
    if (ctx.beatId) { const c = this.#beatTokens.get(ctx.beatId); if (c !== undefined) this.#beatTokens.set(ctx.beatId, c + totalTokens); }
    if (ctx.meetingId) { const c = this.#meetingTokens.get(ctx.meetingId); if (c !== undefined) this.#meetingTokens.set(ctx.meetingId, c + totalTokens); }
  }

  dispose() { this.#beatTokens.clear(); this.#meetingTokens.clear(); }
}
```

Inject via `startServer()` factory (F-005 pattern). `auditLlmCall` receives the tracker via closure or explicit dep.

**Verification:** tests can construct independent `LlmCostTracker` instances.

**Effort:** 45 minutes. Bundles with F-118.

---

## F-128 · Cache `zodToJsonSchema` per schema reference

**Flaw it pairs with:** schema conversion recomputed per call.

**Proposed code:**

```ts
const schemaCache = new WeakMap<ZodType, Record<string, unknown>>();

function getDerivedSchema(schema: ZodType): Record<string, unknown> {
  const cached = schemaCache.get(schema);
  if (cached) return cached;
  const derived = zodToJsonSchema(schema, { target: "openAi", $refStrategy: "none" }) as Record<string, unknown>;
  schemaCache.set(schema, derived);
  return derived;
}

// Usage
const derived = getDerivedSchema(schema);
```

`WeakMap` means the cache is GC'd automatically when the schema goes out of scope.

**Verification:** benchmark 1000 calls with same schema — should show significant speedup for the derive step.

**Effort:** 15 minutes.

---

## F-129 · Thread `temperature` through `chatCompletion` + stream

**Flaw it pairs with:** hardcoded temperature on two of three entry points.

**Proposed code:**

```ts
export async function chatCompletion(
  deploymentKey, messages, auditCtx?: LlmAuditContext,
  options: { temperature?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  // ...
  body: JSON.stringify({ messages, temperature: options.temperature ?? 0.7 }),
}
```

Same for `chatCompletionStream`. Bundled with F-119 (both add an options param).

**Effort:** 10 minutes. Bundled with F-119.

---

## F-130 · Zod-validated Azure response parser

**Flaw it pairs with:** `as`-cast on response JSON.

**Proposed code:**

```ts
import { z } from "zod";

const azureChatCompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
    finish_reason: z.string().optional(),
  })),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional(),
});

// In chatCompletion / structuredCompletion
const rawJson = await response.json();
const json = azureChatCompletionSchema.parse(rawJson);  // throws on shape mismatch
```

Emit an audit entry on parse failure with the raw JSON (for debugging).

**Verification:** mock Azure to return a weird shape; confirm ZodError thrown with clear path.

**Effort:** 30 minutes.

---

## F-131 · Move `DEFAULT_STRUCTURED_MAX_TOKENS` to config

**Flaw it pairs with:** magic number.

**Proposed code:**

```ts
// apps/api/src/config/llm.ts
export const llmConfig = {
  structuredMaxTokens: Number(process.env.ARCEUS_LLM_STRUCTURED_MAX_TOKENS ?? 12_000),
  defaultTimeoutMs: Number(process.env.ARCEUS_LLM_TIMEOUT_MS ?? 60_000),
  defaultTemperature: Number(process.env.ARCEUS_LLM_TEMPERATURE ?? 0.7),
};

// azure-openai.ts
import { llmConfig } from "../config/llm.js";
const maxTokens = options?.maxTokens ?? llmConfig.structuredMaxTokens;
```

**Effort:** 15 minutes. Bundles with F-119 (timeout) and F-129 (temperature).

---

## F-132 · Accept `AbortSignal` on every LLM call

**Fix:** bundled with F-119 (shown in the code there).

**Effort:** 0 (bundled).

---

## F-133 · Zod-validated runtimeConfig.azureApiKey

**Fix:** bundled with F-078. Ensures the key is a non-empty string at startup — never `undefined` reaching a header value.

**Effort:** 0 (bundled with F-078).

---

## F-134 · Audit `llm_stream_completed` + `llm_stream_failed`

**Fix:** bundled with F-121 — the `observeStream` function emits these events on end / error.

**Effort:** 0 (bundled).

---

## F-135 · Include 408 and 425 in `isRetryableHttpStatus`

**Proposed code:**

```ts
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504;
}
```

**Effort:** 2 minutes.

---

## F-136 · Use `performance.now()` for breaker cooldown

**Proposed code:**

```ts
export class CircuitBreaker {
  private lastFailureAt = 0;  // now holds performance.now() value

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (performance.now() - this.lastFailureAt >= this.opts.cooldownMs) {
        this.transition("half_open");
      } else {
        throw new CircuitOpenError(this.opts.name, this.opts.cooldownMs - (performance.now() - this.lastFailureAt));
      }
    }
    // ...
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureAt = performance.now();  // monotonic
    // ...
  }
}
```

`performance.now()` is monotonic — immune to NTP adjustments and admin clock changes.

**Verification:** simulate a clock jump-backward mid-cooldown; confirm cooldown completes correctly.

**Effort:** 10 minutes.

---

## F-137 · Emit audit + metric on retry attempts

**Proposed code:**

```ts
// Caller provides onRetry; it's now the default at construction time.
export async function resilientCall<T>(fn, opts: ResilientCallOptions): Promise<T> {
  const breakerName = opts.breaker.getState().name;
  const wrapped: ResilientCallOptions = {
    ...opts,
    onRetry: (attempt, error) => {
      retryCountTotal.inc({ breaker: breakerName });
      audit({
        companyId: "_system",
        category: "system",
        severity: "debug",
        eventType: "external_call_retry",
        summary: `${breakerName} retry attempt ${attempt}`,
        detail: { breakerName, attempt, error: serializeError(error) },
      });
      opts.onRetry?.(attempt, error);
    },
  };
  return wrapped.breaker.execute(() => withRetry(fn, wrapped));
}
```

Metric for Grafana: `arceus_retry_count_total{breaker="azure-openai"}`.

**Verification:** trigger retries in test; confirm counter increments + audit entries appear.

**Effort:** 30 minutes. Bundles with F-123.

---

## F-138 · Bundled with F-124

**Effort:** 0.

---

## F-139 · `BreakerRegistry` class for testable breaker management

**Flaw it pairs with:** module-level `breakers` singleton.

**Proposed code:**

```ts
export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  register(name: string, opts: Partial<CircuitBreakerOptions> = {}): CircuitBreaker {
    if (this.breakers.has(name)) throw new Error(`breaker "${name}" already registered`);
    const b = new CircuitBreaker({ name, onStateChange: /* F-124 audit callback */, ...opts });
    this.breakers.set(name, b);
    return b;
  }

  get(name: string): CircuitBreaker {
    const b = this.breakers.get(name);
    if (!b) throw new Error(`breaker "${name}" not registered`);
    return b;
  }

  getAll() { return Array.from(this.breakers.values()); }
  health() { return this.getAll().map((b) => b.getState()); }
}

// In startServer()
const breakerRegistry = new BreakerRegistry();
breakerRegistry.register("azure-openai", { failureThreshold: 3, cooldownMs: 30_000 });
breakerRegistry.register("supabase", { failureThreshold: 5, cooldownMs: 20_000 });
breakerRegistry.register("opencode", { failureThreshold: 3, cooldownMs: 15_000 });

app.decorate("services", { ...services, breakerRegistry });
```

Every consumer of `breakers.azureOpenAI` switches to `app.services.breakerRegistry.get("azure-openai")`.

**Effort:** 45 minutes.

---

## F-140 · Bundled with F-130

**Effort:** 0.

---

## F-141 · Bundled with F-122

Replace `json.choices[0]?.message?.content ?? ""` with explicit throw path.

**Effort:** 0 (bundled).

---

## F-142 · Widen jitter to full decorrelated

**Proposed code:**

```ts
// Before
const jitter = Math.random() * 0.3 + 0.85;  // 0.85-1.15

// After (decorrelated jitter — AWS architecture blog pattern)
const jitter = Math.random() * 0.5 + 0.5;   // 0.5-1.0
```

Or full jitter:

```ts
const wait = Math.random() * baseWait;  // 0 to baseWait
```

Full jitter gives the best thundering-herd protection but makes individual retry timing less predictable for tests. Decorrelated is a middle ground.

**Verification:** load test with 100 concurrent retrying clients; confirm retries spread across time rather than clustering.

**Effort:** 2 minutes.

---

---

## F-143 · Single strategy UUID reused across company + strategy

**Flaw it pairs with:** two different strategy UUIDs.

**Proposed code** — `apps/api/src/persistence/store.ts:408-446`:

```ts
export function bootstrapCompany(input: BootstrapInput) {
  const companyId = `company_${crypto.randomUUID()}`;
  const strategyId = `strategy_${crypto.randomUUID()}`;   // ← declare once
  const ideaId = `idea_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const empty = createEmptyCompanySnapshot();              // F-154 lands here too

  replaceState({
    ...empty,
    company: {
      ...empty.company,
      id: companyId, name: input.companyName, boardOwner: input.boardOwner,
      goal: input.idea, budgetCents: input.budgetCents,
      currentStrategyId: strategyId,                       // ← same id
      createdAt: now,
    },
    idea: { id: ideaId, companyId, coreIdea: input.idea, currentDirection: "", refinedWithBoard: false },
    strategy: { ...empty.strategy, id: strategyId, companyId, createdAt: now },  // ← same id
  }, [
    createBootstrapEvent("Board bootstrapped a new company.", { companyId, companyName: input.companyName, budgetCents: input.budgetCents }),
  ]);

  return snapshot;
}
```

**Verification:** after `bootstrapCompany`, assert `snapshot.company.currentStrategyId === snapshot.strategy.id`. Add this as a regression test — it will catch any future repeat of the bug.

**Effort:** 2 minutes.

---

## F-144 · `CompanyStore` class (umbrella refactor, the cache at its source)

**Flaw it pairs with:** module-level cache state.

**Root cause:** store.ts *is* the write-back cache. Everything else (control-plane, opencode, azure-openai) wraps state around it. Fixing F-043 / F-089 / F-069 / F-127 without this file leaves them all half-done.

**Proposed code** — class form, parallel to F-043 / F-069 / F-089:

```ts
export class CompanyStore {
  #snapshot: CompanySnapshot = createEmptyCompanySnapshot();
  #events: EventEnvelope[] = [];
  #dirty = false;
  #lastHydratedAt: string | null = null;
  #lastFlushedAt: string | null = null;
  #mutationsSinceHydrate = 0;
  #taskProgress = new Map<string, TaskProgress>();   // F-145: move into store OR integrate with snapshot

  constructor(
    private readonly persistence: PersistenceAdapter,
    private readonly emitter: EventEmitter<StoreEvents>,
    private readonly logger: FastifyBaseLogger,
  ) {}

  getSnapshot(): Readonly<CompanySnapshot> { return this.#snapshot; }   // F-149
  getEvents(): ReadonlyArray<EventEnvelope> { return this.#events; }

  private async replace(nextSnapshot: CompanySnapshot, nextEvents = this.#events) {
    this.#snapshot = nextSnapshot;
    this.#events = nextEvents;
    this.#dirty = true;
    this.#mutationsSinceHydrate++;
    await this.persist();
    this.emitter.emit("state-changed");
  }

  private async persist() {
    try { await this.persistence.schedule(this.#snapshot, this.#events); }
    catch (err) {
      audit({ /* F-146 */ });
      this.logger.warn({ event: "store_persist_failed", err });
    }
  }

  async hydrate(companyId?: string): Promise<boolean> {
    const persisted = await this.persistence.load(companyId);
    if (!persisted) return false;
    // Use replace() so subscribers see state-changed (F-147).
    this.#snapshot = persisted.snapshot; this.#events = persisted.events;
    this.#dirty = false; this.#mutationsSinceHydrate = 0;
    this.#lastHydratedAt = new Date().toISOString();
    this.emitter.emit("state-changed");   // ← the missing emit
    return true;
  }

  async flush(): Promise<void> {
    if (!this.#dirty) return;   // F-169 short-circuit
    await this.persistence.flush();
    this.#dirty = false;
    this.#lastFlushedAt = new Date().toISOString();
  }

  async batch<T>(fn: () => T | Promise<T>): Promise<T> {   // F-166
    // Suppress persist + emit until fn returns
    const original = this.persist.bind(this);
    let persistPending = false;
    this.persist = async () => { persistPending = true; };
    try {
      const result = await fn();
      this.persist = original;
      if (persistPending) await this.persist();
      return result;
    } finally {
      this.persist = original;
    }
  }

  // ... each upsert/update method (F-152 generic helper inside)
}
```

Construct one instance inside `startServer()`. Every external consumer uses `app.services.companyStore.*` instead of the module exports.

**Migration:** add the class alongside existing exports; migrate consumers; delete the module-level `let`s last.

**Effort:** 8-10 hours. Collapses F-144, F-146, F-147, F-148, F-149, F-152, F-163, F-164, F-165, F-166, F-169 into one refactor.

---

## F-145 · Move `taskProgress` into the snapshot lifecycle

**Flaw it pairs with:** `taskProgressMap` is orphaned from the cache.

**Two options.**

### Option A (recommended): inline into each Task

Add a `progress?: TaskProgress` field on `Task` in contracts. `updateTaskProgress` becomes `updateTask(taskId, t => ({ ...t, progress }))`. Automatically persisted, hydrated, flushed — no special handling.

```ts
// packages/contracts/src/tasks.ts
export const taskSchema = z.object({
  // ... existing fields
  progress: taskProgressSchema.optional(),
});

// apps/api/src/persistence/store.ts
export function updateTaskProgress(taskId: string, progress: TaskProgress) {
  updateTask(taskId, (t) => ({ ...t, progress }));
}
export function getTaskProgress(taskId: string): TaskProgress | null {
  return snapshot.tasks.find((t) => t.id === taskId)?.progress ?? null;
}
```

### Option B: top-level array on snapshot

```ts
// CompanySnapshot gains:
taskProgress: TaskProgress[];

// store.ts
export function updateTaskProgress(taskId: string, progress: TaskProgress) {
  const idx = snapshot.taskProgress.findIndex((tp) => tp.taskId === taskId);
  const next = idx >= 0
    ? snapshot.taskProgress.map((tp, i) => i === idx ? progress : tp)
    : [...snapshot.taskProgress, progress];
  replaceState({ ...snapshot, taskProgress: next });
}
```

Option A is cleaner for most queries; Option B is simpler if progress outlives a task. Pick A.

**Migration:** one-time backfill that copies `taskProgressMap` into each task's `progress` field; delete `taskProgressMap`.

**Verification:**
1. Create a task; commit progress; restart the server; confirm progress survives.
2. Control-plane's F-110 taskProgress field populates correctly.

**Effort:** 1 hour including backfill.

---

## F-146 · Audit persistence failures (bundled with F-091)

**Fix:** already covered by F-091's structure. Apply the same pattern inside the `CompanyStore` class's `#persist` method.

**Effort:** 0 (bundled).

---

## F-147 · Emit `state-changed` on hydrate

**Fix:** shown inline in F-144's class form — `this.emitter.emit("state-changed")` after hydrate assignment.

If you can't wait for the full class refactor, add one line to the existing function:

```ts
export async function hydrate(companyId?: string): Promise<boolean> {
  const persisted = await loadPersistedCompanyState(companyId);
  if (!persisted) return false;
  snapshot = persisted.snapshot;
  events = persisted.events;
  dirty = false;
  mutationsSinceHydrate = 0;
  lastHydratedAt = new Date().toISOString();
  storeEvents.emit("state-changed");   // ← new
  return true;
}
```

**Verification:** subscribe to `state-changed` in a test, call `hydrate`, assert the subscriber fired.

**Effort:** 2 minutes standalone; 0 bundled with F-144.

---

## F-148 · Unified `resetCompany` with explicit scope

**Flaw it pairs with:** asymmetric reset/clear.

**Proposed code:**

```ts
export async function resetCompany(opts: { scope: "memory" | "persistent" | "both"; companyId?: string }): Promise<void> {
  if (opts.scope === "persistent" || opts.scope === "both") {
    if (!opts.companyId) throw new Error("resetCompany: companyId required for persistent scope");
    await deletePersistedCompanyState(opts.companyId);
  }
  if (opts.scope === "memory" || opts.scope === "both") {
    snapshot = createEmptyCompanySnapshot();
    events = [];
    dirty = false;
    mutationsSinceHydrate = 0;
    taskProgressMap.clear();   // F-145 obviates this if migrated
    storeEvents.emit("state-changed");
  }
}

// Delete the old `resetCompany()` and `clearPersistedStoreState()` — or keep as thin wrappers for one release.
```

**Verification:**
1. `resetCompany({ scope: "memory" })` → in-memory empty, DB untouched.
2. `resetCompany({ scope: "both", companyId })` → both cleared.
3. Callers must now pass explicit scope — type-enforced.

**Effort:** 30 minutes (including call-site migration).

---

## F-149 · Return `Readonly<>` types (bundled with F-144)

**Fix:** class form uses private fields + readonly return types. Standalone interim:

```ts
export function getSnapshot(): Readonly<CompanySnapshot> { return snapshot; }
export function getEvents(): ReadonlyArray<EventEnvelope> { return events; }
```

TypeScript treats returned values as immutable; mutations become compile errors. Runtime unchanged.

**Effort:** 5 minutes standalone.

---

## F-150 · Extract `applyStrategy` into `company-runtime/strategy/apply.ts`

**Proposed structure:**

```
packages/company-runtime/src/strategy/
├─ apply.ts                   // the top-level applyStrategy function
├─ build-hierarchy.ts         // pure hierarchy construction (F-159, F-160, F-161)
├─ derive-agents.ts           // agents/sessions/memories from hierarchy
└─ events.ts                  // createStrategyProposedEvent (F-170)
```

`store.ts` becomes:

```ts
import { applyStrategy as applyStrategyLogic } from "@arceus/company-runtime";

export function applyStrategy(output: StrategyOutput) {
  const result = applyStrategyLogic(output, snapshot, events);
  replaceState(result.snapshot, result.events);
  storeEvents.emit("agents-hired", result.agents);
  return snapshot;
}
```

The logic moves to the runtime package (pure, testable); store.ts just glues.

**Verification:** existing end-to-end tests pass; new unit tests cover `buildHierarchy`, `deriveAgents`, `createStrategyProposedEvent` independently.

**Effort:** 3-4 hours.

---

## F-151 · Narrow status/role parameters via Zod enums

```ts
import { agentStatusSchema, companyStatusSchema } from "@arceus/contracts";

export function updateAgentStatus(agentId: string, status: unknown) {
  const parsed = agentStatusSchema.parse(status);
  // ... uses parsed (now typed correctly, no cast)
}

export function updateCompanyStatus(status: unknown) {
  const parsed = companyStatusSchema.parse(status);
  // ...
}
```

Same pattern in `applyStrategy` — replace `as HierarchyNode["role"]` casts with `hierarchyRoleSchema.parse(...)`.

**Effort:** 30 minutes.

---

## F-152 · Generic `upsertById` helper

```ts
function upsertById<T extends { id: string }>(
  arr: readonly T[],
  item: T,
  position: "append" | "prepend" = "append",
): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) return arr.map((x, idx) => (idx === i ? item : x));
  return position === "prepend" ? [item, ...arr] : [...arr, item];
}

// Rewrite each upsert:
export function upsertTask(task: Task) {
  replaceState({ ...snapshot, tasks: upsertById(snapshot.tasks, task) });
  return task;
}
```

5 functions collapse to 3-line bodies; one place to audit the pattern.

**Effort:** 30 minutes including tests.

---

## F-153 · Pick one insert position as default; opt into `prepend`

**Flaw it pairs with:** inconsistent push/unshift across upserts.

**Proposed code:** default to append; callers that genuinely need prepend pass it explicitly:

```ts
export function upsertMeeting(meeting: Meeting) {
  replaceState({ ...snapshot, meetings: upsertById(snapshot.meetings, meeting, "prepend") });
  return meeting;
}
```

Document the "why" for any prepend case. If there's no reason, switch to append.

**Effort:** 10 minutes. Bundles with F-152.

---

## F-154 · `createEmptyCompanySnapshot()` once per bootstrap

**Fix:** shown inline in F-143. `const empty = createEmptyCompanySnapshot();` at the top; reuse.

**Effort:** 0 (bundled with F-143).

---

## F-155 · `"company_pending"` / `"pending-runtime-binding"` constants (bundled with F-012)

Export `COMPANY_ID_PENDING` + `SESSION_RUNTIME_BINDING_PENDING` from contracts. Replace literals.

**Effort:** 5 minutes. Bundles with F-012.

---

## F-156 · Config-driven agent names

```ts
// apps/api/src/config/agent-names.ts
export const DEFAULT_AGENT_NAMES: Record<string, string> = {
  ceo: "Avery",
  cto: "Lin",
  // ... etc
};

// store.ts
import { DEFAULT_AGENT_NAMES } from "../config/agent-names.js";

function buildAgentName(role: string): string {
  return DEFAULT_AGENT_NAMES[role] ?? titleCase(role.replace(/_/g, " "));
}
```

Future: load per-company overrides from DB; fall back to defaults.

**Effort:** 15 minutes.

---

## F-157 · Derive model names from `runtimeConfig.ensureDeployment`

**Flaw it pairs with:** hardcoded `"azure/ceo-deployment"` etc.

```ts
import { ensureDeployment } from "../config/index.js";

const model = agent.role === "ceo"
  ? `azure/${ensureDeployment("ceoDeployment")}`
  : `azure/${ensureDeployment("workerDeployment")}`;
```

Or move the string construction into a `buildSessionModel(role)` helper.

**Effort:** 10 minutes.

---

## F-158 · Replace CEO magic-string checks

Bundled with F-098 role enum. After enum lands:

```ts
import { AgentRole, CEO } from "@arceus/contracts";

status: agent.role === CEO ? "running" : "active",
model: agent.role === CEO ? ... : ...,
actorId: agents.find((a) => a.role === CEO)?.id ?? ...,
```

**Effort:** 10 minutes. Bundled with F-098.

---

## F-159 · O(1) hierarchy-node lookup via Map

```ts
const nodeById = new Map(hierarchy.map((n) => [n.id, n]));

const computeNodeLevel = (node: HierarchyNode): number => {
  if (!node.parentNodeId) return 0;
  const parent = nodeById.get(node.parentNodeId);   // ← O(1), not .find
  return parent ? computeNodeLevel(parent) + 1 : 0;
};
```

**Effort:** 5 minutes. Bundles with F-150's extraction.

---

## F-160 · Key level cache by node id, not role

```ts
const levelCache = new Map<string /* nodeId */, number>();

const computeNodeLevel = (node: HierarchyNode): number => {
  const cached = levelCache.get(node.id);
  if (cached !== undefined) return cached;
  const level = node.parentNodeId ? computeNodeLevel(nodeById.get(node.parentNodeId)!) + 1 : 0;
  levelCache.set(node.id, level);
  return level;
};
```

**Effort:** 5 minutes. Bundled with F-159.

---

## F-161 · Build hierarchy functionally, no in-place mutation

```ts
function buildHierarchy(roles: StrategyRole[]): HierarchyNode[] {
  const nodesById = new Map<string, { id: string; role: string; title: string; agentId: string }>();
  const roleToAgentId = new Map<string, string>();
  const roleToNodeId = new Map<string, string>();

  // Pass 1: create id-only stubs
  for (const role of roles) {
    const id = `node_${crypto.randomUUID()}`;
    const agentId = `agent_${role.role}_${crypto.randomUUID()}`;
    nodesById.set(id, { id, role: role.role, title: role.title, agentId });
    roleToAgentId.set(role.role, agentId);
    roleToNodeId.set(role.role, id);
  }

  // Pass 2: build linked nodes (no mutation of intermediates)
  const linked: HierarchyNode[] = roles.map((role) => {
    const stub = nodesById.get(roleToNodeId.get(role.role)!)!;
    const parentNodeId = role.parent_role ? (roleToNodeId.get(role.parent_role) ?? null) : null;
    const directReportNodeIds = roles
      .filter((r) => r.parent_role === role.role)
      .map((r) => roleToNodeId.get(r.role)!)
      .filter(Boolean);
    return {
      ...stub, level: 0 /* computed next */, parentNodeId, directReportNodeIds, openForHiring: false,
    };
  });

  // Pass 3: compute levels (F-159 + F-160 applied)
  const byId = new Map(linked.map((n) => [n.id, n]));
  const levelCache = new Map<string, number>();
  const level = (n: HierarchyNode): number => {
    const cached = levelCache.get(n.id);
    if (cached !== undefined) return cached;
    const l = n.parentNodeId ? level(byId.get(n.parentNodeId)!) + 1 : 0;
    levelCache.set(n.id, l);
    return l;
  };

  return linked.map((n) => ({ ...n, level: level(n) }));
}
```

No in-place mutation anywhere. Pure function — testable in isolation.

**Effort:** 30 minutes. Part of F-150.

---

## F-162 · Split `updateCompanySprint` into two functions

```ts
export function setCurrentSprint(sprintId: string, sprintNumber: number) {
  replaceState({ ...snapshot, company: { ...snapshot.company, currentSprintId: sprintId, currentSprintNumber: sprintNumber } });
}

export function clearCurrentSprint() {
  replaceState({ ...snapshot, company: { ...snapshot.company, currentSprintId: null, currentSprintNumber: null } });
}
```

Delete the polymorphic `updateCompanySprint(string | null, number | null)`.

**Effort:** 10 minutes including caller migration.

---

## F-163 · Delete deprecated re-exports

```bash
# Find callers
git grep -n "hydrateStoreFromPersistence\|flushStorePersistence" apps/ packages/

# Migrate each to hydrate/flush, then delete the aliases.
```

**Effort:** 15 minutes + caller migration (probably zero).

---

## F-164 · Zod validation at store boundary

**Fix:** add `schema.parse(input)` at the entry of each upsert/update.

```ts
import { taskSchema } from "@arceus/contracts";

export function upsertTask(task: Task) {
  const parsed = taskSchema.parse(task);   // throws on invalid shape
  replaceState({ ...snapshot, tasks: upsertById(snapshot.tasks, parsed) });
  return parsed;
}
```

Trade-off: Zod parse cost vs safety. Zod is fast (~µs); the safety is worth it.

**Effort:** 1 hour (all upsert/update sites).

---

## F-165 · Structured store events with entity details

**Flaw it pairs with:** generic `state-changed` events.

**Proposed code:**

```ts
// apps/api/src/persistence/store-events.ts
interface StoreEvents {
  "state-changed": () => void;                            // keep for legacy listeners
  "entity-changed": (e: { kind: "task" | "sprint" | "meeting" | "approval" | "memory" | "transition"; id: string; op: "upsert" | "update" | "delete" }) => void;
  "agents-hired": (agents: AgentIdentity[]) => void;
}

// Each upsert emits both:
export function upsertTask(task: Task) {
  replaceState({ ...snapshot, tasks: upsertById(snapshot.tasks, task) });
  storeEvents.emit("entity-changed", { kind: "task", id: task.id, op: "upsert" });
  return task;
}
```

Control-plane subscribes to `entity-changed` and audits from the bus — one audit site, every mutation covered.

**Effort:** 1-2 hours (wire events + migrate audit from per-call-site to bus).

---

## F-166 · Batch / transaction primitive

**Fix:** shown inline in F-144's class (`batch<T>(fn)` method that suppresses persist + emit). Standalone form without the class:

```ts
let batchDepth = 0;
let pendingPersist = false;
let pendingEmits: Array<[keyof StoreEvents, unknown]> = [];

export async function batch<T>(fn: () => T | Promise<T>): Promise<T> {
  batchDepth++;
  try {
    return await fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      if (pendingPersist) persistState();
      for (const [event, payload] of pendingEmits) storeEvents.emit(event, payload);
      pendingPersist = false;
      pendingEmits = [];
    }
  }
}

// Inside replaceState:
if (batchDepth > 0) {
  pendingPersist = true;
  pendingEmits.push(["state-changed", undefined]);
} else {
  persistState();
  storeEvents.emit("state-changed");
}
```

**Verification:** call `batch(() => { upsertTask; upsertTask; upsertTask; })` and assert exactly one `state-changed` fires.

**Effort:** 1 hour.

---

## F-167 · Remove `node.agentId!` non-null assertion

**Flaw it pairs with:** `!` on `node.agentId` at line 511.

**Fix:** make `agentId` non-optional on the local HierarchyNode during build; or check explicitly:

```ts
const node = nodeByRole.get(role.role as HierarchyNode["role"]);
if (!node?.agentId) throw new Error(`hierarchy build error: agent id missing for role ${role.role}`);
// now node.agentId is narrowed to string without `!`
```

Bundled with F-161's functional hierarchy builder — agentId is assigned at creation, never `undefined`.

**Effort:** 0 (bundled).

---

## F-168 · Commit on snapshot schema: required or optional

**Flaw it pairs with:** `?? []` fallbacks.

**Process:**
1. For each field with a fallback (`transitions`, `feedbackRounds`, `meetingSchedules`), grep "is this set on the empty snapshot?"
2. If yes → required. Remove the `?? []` fallback.
3. If no → declare as `?:` in the contract; keep the fallback but add `// intentionally optional` comment.

`createEmptyCompanySnapshot` should set every field to an empty array if it's required; that's the simplest path.

**Effort:** 30 minutes audit + 10 minutes fixes.

---

## F-169 · Short-circuit `flush` on clean cache

```ts
export async function flush(): Promise<void> {
  if (!dirty) return;
  await flushPersistedCompanyState();
  dirty = false;
  lastFlushedAt = new Date().toISOString();
}
```

**Verification:** metrics on flush call count before/after — should drop if callers flush frequently on clean state.

**Effort:** 2 minutes.

---

## F-170 · `createStrategyProposedEvent` helper

```ts
// packages/company-runtime/src/events.ts
export function createStrategyProposedEvent(
  strategy: Strategy,
  roles: StrategyRole[],
  firstRelease: string,
  ceoAgentId: string,
): EventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    companyId: strategy.companyId,
    entityType: "strategy",
    entityId: strategy.id,
    eventType: "strategy.proposed",
    causationId: null,
    correlationId: crypto.randomUUID(),
    actorType: "agent",
    actorId: ceoAgentId,
    occurredAt: new Date().toISOString(),
    summary: "CEO proposed the first real strategy and org chart.",
    payload: { firstRelease, roles },
  };
}

// store.ts applyStrategy — delete the inline construction, call the helper.
```

**Effort:** 15 minutes. Part of F-150.

---

## F-171 · (Defer) `Map<agentId, MemorySummary>` for O(1) memory updates

Current scale doesn't justify it; log as future-work if memory updates ever show up in profiling.

**Effort:** 30 minutes if ever needed.

---

## F-172 · Functional `.map` instead of mutating cloned array

```ts
// Before
const nextTasks = [...snapshot.tasks];
nextTasks[existing] = task;

// After (inside the F-152 helper)
return arr.map((x, idx) => (idx === existing ? item : x));
```

Bundled with F-152.

**Effort:** 0 (bundled).

---

---

## F-173 · Collapse schema.ts drift — one source of truth

**Flaw it pairs with:** 24 entities in `schema.ts`, 14 real tables.

**Two-phase fix.**

### Phase A — delete the metadata lie

Immediately remove the 10 ghost entities from `EntityName` + `EntityRecordMap` + `arceusTableDefinitions`. They don't exist; pretending they do breaks `DatabaseAdapter.list<K>`.

```ts
// types.ts — strip the 10 ghost entities
export type EntityName =
  | "workspaces" | "sprintSnapshots" | "artifacts" | "companyStates"
  | "assets" | "auditEvents" | "serviceRegistry" | "beatRecords"
  | "trustScores" | "policyViolations" | "skillArtifacts"
  | "memoryUnits" | "habits" | "primingStates";    // 14, matches reality

// schema.ts — delete entries for companies/ideas/strategies/sprints/
//             hierarchy/agents/sessions/tasks/chatMessages/meetings/
//             approvals/events/memorySummaries
```

### Phase B — delete `schema.ts` entirely

`arceusTableDefinitions` is pure documentation. Drizzle already knows the table names, primary keys, and column types. Having a parallel metadata map creates drift.

Delete `schema.ts`; update imports; `indexes` claims disappear (F-177 lands at the same time).

**Verification:**
1. `grep arceusTableDefinitions packages/ apps/` → 0 results after removal.
2. `tsc --noEmit` passes.
3. DB queries unaffected.

**Effort:** 1 hour Phase A, 30 minutes Phase B.

---

## F-174 · F-002 Stage B — extract domain tables from the jsonb blob

**Flaw it pairs with:** single jsonb column holds the whole CompanySnapshot.

**This is the biggest structural refactor in the audit.** Full plan is in F-002's Stage B. Summary here:

### Target state

```sql
-- Real relational tables (today's ghosts become rows)
CREATE TABLE companies     (id text PK, ...);
CREATE TABLE agents        (id text PK, company_id text REFERENCES companies(id), ...);
CREATE TABLE sprints       (id text PK, company_id text REFERENCES companies(id), number int, status text, ...);
CREATE TABLE tasks         (id text PK, company_id, sprint_id REFERENCES sprints(id), ...);
CREATE TABLE meetings      (...);
CREATE TABLE approvals     (...);
CREATE TABLE chat_messages (id text PK, company_id, sprint_id, role, content, created_at timestamptz);

-- Proper indexes
CREATE INDEX CONCURRENTLY idx_tasks_agent_status ON tasks(assigned_agent_id, status) WHERE status != 'done';
CREATE INDEX CONCURRENTLY idx_tasks_sprint ON tasks(sprint_id);
CREATE INDEX CONCURRENTLY idx_meetings_scheduled ON meetings(company_id, scheduled_at) WHERE status = 'scheduled';

-- company_states becomes a thin cursor/version table
CREATE TABLE company_states (
  company_id text PK,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### Migration steps

1. **Expand** — create new tables alongside the jsonb. New writes go to both; old reads still pull jsonb (backward compat).
2. **Backfill** — one-off script reads every `company_states.snapshot_data`, inserts rows into the new tables.
3. **Migrate reads** — one consumer at a time moves from `snapshot.tasks` to `SELECT * FROM tasks WHERE company_id = ?`.
4. **Contract** — once all consumers on new tables, stop writing jsonb; mark the column dead.
5. **Drop** — remove `snapshot_data` column in a later migration.

Per-entity migrations run over weeks. Each landing is independent.

**Verification:** end-to-end tests pass at every step; performance improves (measurable via query latency + throughput benchmarks).

**Effort:** **1-2 weeks** of focused work. Do not start this the same sprint as F-002 Stage A (flush cadence). Do Stage A first; prove it helps; then begin B.

---

## F-175 · Foreign keys across tenant-scoped tables

**Proposed migrations** (run after F-174's tables exist):

```sql
ALTER TABLE beat_records
  ADD CONSTRAINT fk_beat_records_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE beat_records
  ADD CONSTRAINT fk_beat_records_agent
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

-- Similar for audit_events, artifacts, policy_violations, skill_artifacts, workspaces, etc.
```

Cascade policies:
- `company_id` → usually `ON DELETE CASCADE` (orphans have no meaning).
- `agent_id` → `ON DELETE SET NULL` on audit-ish tables (preserve the record, null the reference) or CASCADE on per-agent tables.
- `sprint_id` → CASCADE (sprint-scoped data).

**Blocker:** F-174 must land first (the target tables don't exist yet).

**Effort:** 1 hour per constraint addition (including `NOT VALID` + background validate pattern for minimal lock time on large tables).

---

## F-176 · Add unique constraints where logic demands

```sql
ALTER TABLE service_registry ADD CONSTRAINT unq_service_registry_tool
  UNIQUE (company_id, tool_name);

ALTER TABLE audit_events ADD CONSTRAINT unq_audit_events_seq
  UNIQUE (company_id, sequence);

ALTER TABLE beat_records ADD CONSTRAINT unq_beat_records_beat
  UNIQUE (agent_id, beat_number);
```

Each migration wrapped in `ADD CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT` to minimize lock.

**Caveat:** if existing data violates uniqueness (duplicates that the lack of constraint allowed), the `VALIDATE` will fail. Run a pre-check query + dedupe script first.

**Effort:** 2-3 hours total including dedupe.

---

## F-177 · Delete `schema.ts`'s `indexes` field (or entire file)

**Fix:** part of F-173 Phase B. Delete the `indexes` array; it's documentation that lies.

Real indexes live in migration SQL (as `CREATE INDEX CONCURRENTLY`) and/or Drizzle schema (`.$tableExtraConfig` with `index().on(col)`).

**Effort:** 0 bundled with F-173.

---

## F-178 · `_migrations` table + single runner

**Proposed code:**

```sql
-- First migration added (000_bootstrap.sql)
CREATE TABLE IF NOT EXISTS _migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL
);
```

```ts
// packages/db/src/migrate.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import postgres from "postgres";

const MIGRATION_DIR = join(import.meta.dirname, "../migrations");

export async function migrate(): Promise<void> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL not set");
  const sql = postgres(url);

  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text NOT NULL
      )
    `);

    const applied = new Map<string, string>();
    for (const row of await sql`SELECT name, checksum FROM _migrations`) {
      applied.set(row.name as string, row.checksum as string);
    }

    const files = readdirSync(MIGRATION_DIR)
      .filter((f) => f.endsWith(".sql") && !f.includes("concurrent"))
      .sort();

    for (const file of files) {
      const content = readFileSync(join(MIGRATION_DIR, file), "utf8");
      const checksum = createHash("sha256").update(content).digest("hex");

      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`migration ${file} has changed since application (checksum mismatch)`);
        }
        continue;
      }

      console.log(`applying ${file}...`);
      const stripped = content.replace(/^\s*BEGIN\s*;/mi, "").replace(/^\s*COMMIT\s*;/mi, "");
      await sql.begin(async (tx) => {
        await tx.unsafe(stripped);
        await tx`INSERT INTO _migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });
    }

    // Second pass: concurrent-only files (no BEGIN/COMMIT wrapper)
    const concurrentFiles = readdirSync(MIGRATION_DIR)
      .filter((f) => f.endsWith(".sql") && f.includes("concurrent"))
      .sort();
    for (const file of concurrentFiles) {
      if (applied.has(file)) continue;
      const content = readFileSync(join(MIGRATION_DIR, file), "utf8");
      const checksum = createHash("sha256").update(content).digest("hex");
      console.log(`applying ${file} (concurrent)...`);
      await sql.unsafe(content);   // no transaction
      await sql`INSERT INTO _migrations (name, checksum) VALUES (${file}, ${checksum})`;
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) migrate().catch((err) => { console.error(err); process.exit(1); });
```

Delete every `run-NNN.ts`. CI runs `pnpm --filter @arceus/db migrate`.

**Verification:**
1. Fresh DB: `migrate()` applies all migrations in order.
2. Running twice is a no-op.
3. Editing an applied migration throws checksum mismatch.

**Effort:** 2-3 hours.

---

## F-179 · Delete per-migration runners (bundled with F-178)

Once `migrate.ts` exists, delete:
- `run-001b.ts`, `run-002.ts`, `run-003.ts`, `run-004.ts`, `run-005.ts`, `run-006.ts`, `run-007.ts`
- Move `force-complete-sprint.ts` + `verify.ts` out of `migrations/` (see F-193).

**Effort:** 15 minutes after F-178.

---

## F-180 · Mandatory `CONCURRENTLY` on index adds; runner handles non-transactional files

**Migration file convention:**

```
001_hippocampus_memory.sql                     # transactional DDL
001b_fix_schema.sql                            # transactional
001c_concurrent_indexes.sql                    # NON-transactional, CONCURRENTLY allowed
```

File naming (`.concurrent.sql` or a `-- concurrent` marker) tells the runner to skip transaction wrapping.

Inside:
```sql
-- 001c_concurrent_indexes.sql
-- No BEGIN/COMMIT; runner will NOT wrap in a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_embedding_concurrent
  ON hippocampus.memory_units USING hnsw (embedding vector_cosine_ops)
  WHERE deleted_at IS NULL;
```

For existing migrations that unsafely create indexes in-transaction on (soon-to-be-large) production tables — consider rewriting to drop + concurrently-recreate under downtime budget.

**Verification:**
1. Runner applies concurrent file outside a transaction.
2. Regular files still in transaction.

**Effort:** 1 hour (runner + one example). Bundled with F-178.

---

## F-181 · Raise connection pool; expose env var

```ts
// packages/db/src/client.ts
const POOL_MAX = Number(process.env.ARCEUS_PG_POOL_SIZE ?? 20);

sqlClient = postgres(config.databaseUrl, {
  max: POOL_MAX,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},   // suppress NOTICE-level logs
});
```

Observability: log connection-pool metrics periodically.

```ts
setInterval(() => {
  const client = sqlClient as postgres.Sql & { [key: string]: any };
  if (client && client.active) {
    logger.debug({ event: "pg.pool_status", active: client.active, idle: client.idle });
  }
}, 60_000);
```

**Effort:** 20 minutes.

---

## F-182 · Pick text-or-uuid and align migration + Drizzle

**Recommended:** migrate DB columns to `UUID`.

```sql
-- migration NNN_memory_units_to_uuid.sql
BEGIN;
ALTER TABLE hippocampus.memory_units ALTER COLUMN id TYPE uuid USING id::uuid;
ALTER TABLE hippocampus.memory_units ALTER COLUMN company_id TYPE uuid USING company_id::uuid;
ALTER TABLE hippocampus.memory_units ALTER COLUMN agent_id TYPE uuid USING agent_id::uuid;
ALTER TABLE hippocampus.memory_units ALTER COLUMN previous_version_id TYPE uuid USING previous_version_id::uuid;
-- Similar for habits + priming_state.
COMMIT;
```

Assumes every existing string value is UUID-formatted. Pre-check:
```sql
SELECT count(*) FROM hippocampus.memory_units WHERE id !~ '^[0-9a-f-]{36}$';
-- Must be 0 before running the ALTER.
```

**Alternative** (lower risk): change Drizzle to `text("id")` instead. Immediate, no migration.

**Effort:** 30 min to verify + 1h to migrate, or 5 min to change Drizzle.

---

## F-183 · Delete `DatabaseAdapter` + `NoopDatabaseAdapter`

```bash
git grep "DatabaseAdapter\|NoopDatabaseAdapter\|createNoopDatabaseAdapter" apps/ packages/
# If zero hits outside packages/db/src: delete the interface, the impl, createDbContext.
```

**Effort:** 15 minutes.

---

## F-184 · Port `defineTable` pattern to `tables.ts`

```ts
// top of tables.ts
const configuredSchemaName = process.env.ARCEUS_DB_SCHEMA?.trim() || process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA?.trim() || "public";
const arceusSchema = configuredSchemaName === "public" ? null : pgSchema(configuredSchemaName);
const defineTable: (name: string, columns: any) => any = arceusSchema ? arceusSchema.table.bind(arceusSchema) : pgTable;

// each table: declare columns once
export const workspacesTable = defineTable("workspaces", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  // ... etc
});
```

~150 lines of duplication deleted.

**Effort:** 1 hour.

---

## F-185 · Deprecate env-var aliases; log fallback use

```ts
function readAliasedEnv(names: string[]): { value: string; source: string | null } {
  for (let i = 0; i < names.length; i++) {
    const value = process.env[names[i]]?.trim();
    if (value) {
      if (i > 0) console.warn(`[db] Using deprecated env var ${names[i]}; prefer ${names[0]}`);
      return { value, source: names[i] };
    }
  }
  return { value: "", source: null };
}
```

Usage surfaces the deprecation warning once per boot.

**Effort:** 20 minutes.

---

## F-186 · Add CHECK constraints on status/severity columns

```sql
ALTER TABLE workspaces ADD CONSTRAINT ck_workspaces_status
  CHECK (status IN ('active', 'archived', 'error'));

ALTER TABLE beat_records ADD CONSTRAINT ck_beat_records_status
  CHECK (status IN ('running', 'completed', 'failed', 'timeout'));

ALTER TABLE policy_violations ADD CONSTRAINT ck_policy_violations_severity
  CHECK (severity IN ('low', 'medium', 'high', 'critical'));

-- ... per-table
```

**Caveat:** like F-176, existing rows must comply. Pre-check via `SELECT DISTINCT status FROM table`.

**Effort:** 2 hours.

---

## F-187 · `load-env` uses find-up from cwd

```ts
import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

function findEnvFile(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(current, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const envPath = findEnvFile(process.cwd());
if (envPath) loadEnv({ path: envPath, override: false });
```

Works regardless of install path.

**Effort:** 15 minutes.

---

## F-188 · Migration numbering convention

Pick one and enforce in CI:

### Option A: strict monotonic integers

`001_*.sql`, `002_*.sql`, `003_*.sql` — when a hotfix is needed, allocate the next available number (say 012 even if you're between 011 and 013 conceptually).

### Option B: timestamps (Rails-style)

`20241119120000_hippocampus_memory.sql` — globally sortable, no collision between branches.

Option B scales better for multi-branch development. Adopt it for new migrations; keep existing numbers frozen.

**CI guard:**
```ts
// packages/db/migrations-lint.test.ts
const names = readdirSync(MIGRATION_DIR).filter((f) => f.endsWith(".sql"));
const sorted = [...names].sort();
if (names.join(",") !== sorted.join(",")) throw new Error("migration names not sortable");
```

**Effort:** 15 minutes.

---

## F-189 · Delete `indexes` field (bundled with F-177)

Fix: part of F-173 / F-177. Delete the claim; rely on migration SQL only.

**Effort:** 0.

---

## F-190 · Apply `updated_at` trigger to every table that has the column

```sql
-- migration NNN_updated_at_triggers.sql
-- (update_updated_at_column() function already exists from migration 001)

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspaces', 'company_states', 'beat_records', 'trust_scores', 'skill_artifacts'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t, t);
  END LOOP;
END $$;
```

**Effort:** 30 minutes.

---

## F-191 · RLS migration (deferred until multi-tenant)

Skeleton for when the time comes:

```sql
ALTER TABLE beat_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE beat_records FORCE ROW LEVEL SECURITY;

CREATE POLICY beat_records_tenant_isolation ON beat_records
  USING (company_id = current_setting('app.current_company_id', true));
```

Every read/write must `SET LOCAL app.current_company_id = ?` at transaction start.

**Effort:** 1-2 days when multi-tenant becomes a real goal.

---

## F-192 · `drizzle-kit check` in CI

```yaml
# .github/workflows/ci.yml
- run: pnpm --filter @arceus/db exec drizzle-kit check
```

Fails on detected drift between Drizzle schema and DB.

**Effort:** 15 minutes.

---

## F-193 · Move ad-hoc scripts out of `migrations/`

```bash
mkdir -p packages/db/src/scripts
git mv packages/db/migrations/force-complete-sprint.ts packages/db/src/scripts/
git mv packages/db/migrations/verify.ts packages/db/src/scripts/
```

**Effort:** 5 minutes.

---

## F-194 · Eager-init DB client in `startServer()`

```ts
export async function startServer(opts) {
  // ... hydrate
  // Force-init DB connection so first request doesn't pay for it.
  await getDatabaseHealth();   // triggers getDb() + prepare + health check
  // ...
}
```

**Effort:** 5 minutes.

---

## F-195 · Unified shutdown budget

```ts
// apps/api/src/config/shutdown.ts
export const shutdownConfig = {
  totalMs: Number(process.env.ARCEUS_SHUTDOWN_TIMEOUT_MS ?? 10_000),
  dbDrainMs: Number(process.env.ARCEUS_DB_DRAIN_MS ?? 3_000),
  httpCloseMs: Number(process.env.ARCEUS_HTTP_CLOSE_MS ?? 5_000),
};

// packages/db/src/client.ts
export async function closeDbConnections(timeoutMs: number = 3_000) {
  if (sqlClient) {
    await sqlClient.end({ timeout: Math.ceil(timeoutMs / 1000) });
    sqlClient = null;
  }
  dbClient = null;
  supabaseClient = null;
}
```

Shutdown flow (inside F-039):
```ts
await Promise.race([
  (async () => {
    await closeDbConnections(shutdownConfig.dbDrainMs);
    await app.close({ timeout: shutdownConfig.httpCloseMs });
  })(),
  new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), shutdownConfig.totalMs)),
]);
```

**Effort:** 30 minutes. Bundled with F-039.

---

## F-196 · Backup / restore runbook

```markdown
# docs/db/backup-restore.md

## Automatic backups (Supabase Pro+)
- Supabase takes daily backups at 04:00 UTC.
- Retention: 7 days (Pro), 30 days (Team), 90 days (Enterprise).

## PITR (Point-in-Time Recovery)
- Available Pro+. 7-day window.
- Supabase Dashboard → Project → Database → Backups → Point in Time.

## Manual backup (any tier)
pg_dump -Fc --file=arceus-$(date +%F).dump $SUPABASE_DB_URL

## Restore
pg_restore --clean --if-exists --dbname=$TARGET_URL arceus-2025-01-15.dump

## Quarterly drill checklist
- [ ] Restore yesterday's backup to a staging Supabase project
- [ ] Run smoke test suite against restored DB
- [ ] Time the restore; document against SLA
```

**Effort:** 1 hour writing + quarterly drill.

---

## F-197 · Implement or remove `previous_version_id`

**Grep** for consumers:
```bash
git grep "previous_version_id\|previousVersionId" apps/ packages/
```

If used → add a `getMemoryVersionChain(memoryId)` helper + UI. If unused → drop the column in a migration.

**Effort:** 15 minutes to investigate + whichever follows.

---

## F-198 · Bundled with F-183 (adapter deleted, `structuredClone` moot)

**Effort:** 0.

---

## F-199 · Bundled with F-116 (JSDoc the numeric column choice)

**Effort:** 0.

---

## F-200 · Delete deprecated exports

```bash
git grep "@deprecated" packages/db/src/
# For each: grep for consumers; migrate; delete.
```

**Effort:** 30 minutes.

---

## F-201 · Migration header template

```sql
-- 008_whatever.sql
-- Problem:    Current X is Y.
-- Solution:   Add column Z so queries can W.
-- Dependencies: Migration 007 (skill_artifacts table).
-- Rollback:   DROP COLUMN z;  — safe but loses data.
-- Safe on prod: yes / no-requires-maintenance-window
-- Reviewed-by: <name>

BEGIN;
-- ...
COMMIT;
```

Add a pre-commit hook that requires the header.

**Effort:** 15 minutes.

---

## F-202 · Adopt `drizzle-zod` for reconciled schemas

```ts
// packages/contracts/src/sprints.ts
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { sprintsTable } from "@arceus/db";

export const sprintInsertSchema = createInsertSchema(sprintsTable);
export const sprintSelectSchema = createSelectSchema(sprintsTable);
export type Sprint = z.infer<typeof sprintSelectSchema>;
```

Drizzle auto-derives Zod schemas from the table definition. Types stay in sync automatically.

**Caveat:** `drizzle-zod` doesn't handle every edge case (custom types, complex jsonb shapes). Mix with hand-written schemas where needed.

**Effort:** 1-2 hours to adopt + migrate the simplest tables.

---

---

## F-203 · `expireStale` releases semaphore slot too

**Flaw it pairs with:** lock expired but slot retained → slot leak.

**Proposed code:**

```ts
// BeatLockManager gains slot tracking
class BeatLockManager {
  private readonly locks = new Map<string, {
    beatId: string;
    acquiredAt: number;
    releaseSlot?: () => void;   // ← NEW — the semaphore release fn
  }>();

  acquire(agentId: string, beatId: string, releaseSlot?: () => void): boolean {
    if (this.locks.has(agentId)) return false;
    this.locks.set(agentId, { beatId, acquiredAt: Date.now(), releaseSlot });
    return true;
  }

  expireStale(timeoutMs: number): Array<{ agentId: string; beatId: string }> {
    const now = Date.now();
    const expired: Array<{ agentId: string; beatId: string }> = [];
    for (const [agentId, lock] of this.locks) {
      if (now - lock.acquiredAt > timeoutMs) {
        expired.push({ agentId, beatId: lock.beatId });
        this.locks.delete(agentId);
        try { lock.releaseSlot?.(); } catch { /* noop */ }   // ← release semaphore
      }
    }
    return expired;
  }
}

// triggerBeat wires the releaseSlot:
if (!this.locks.acquire(request.agentId, beatId, () => this.semaphore.release())) {
  this.semaphore.release();
  return null;
}
// finally block: check if lock was already expired (releaseSlot already called)
// — guard with a flag to avoid double-release
```

**Caveat:** the beat's own `finally` block must not double-release. Add a flag `slotReleased` per beat request that the finally checks.

**Verification:**
1. Simulate a hung beat via a stub `executeTask` that never resolves; fire a scheduler tick past `beatTimeoutMs`; confirm semaphore slot is released after expiration.
2. Normal path still releases correctly in the finally block.

**Effort:** 1 hour.

---

## F-204 · Capture `beatNumber` at assignment, thread through buildRecord

**Flaw it pairs with:** `buildRecord` reads mutable `this.beatCounter`.

**Proposed code:**

```ts
// triggerBeat
const beatNumber = ++this.beatCounter;
const beatId = `beat_${beatNumber}_${Date.now()}`;

// ...
const record = await this.executor(request, beatId, beatNumber);

// fourPhaseExecutor signature becomes
private async fourPhaseExecutor(request, beatId, beatNumber): Promise<BeatRecord> { ... }

// buildRecord takes beatNumber as an explicit parameter
private buildRecord(
  beatId, beatNumber, request, startedAt, phases, ...
): BeatRecord {
  return { id: beatId, beatNumber, ... };
}
```

No more reads of `this.beatCounter` from inside `buildRecord`. Each beat's record carries its own immutable beatNumber.

**Verification:**
1. Fire 10 concurrent beats via `Promise.all`; assert each record has a unique `beatNumber`.
2. Existing tests pass.

**Effort:** 20 minutes.

---

## F-205 · Thread `AbortSignal` through every dep call

**Flaw it pairs with:** cooperative-only timeout.

**Proposed code:**

```ts
// BeatDependencies extensions
interface BeatDependencies {
  loadAgentContext: (..., signal?: AbortSignal) => AgentBeatContext | null;
  executeTask?: (ctx, taskId, beatId, opts: { signal: AbortSignal }) => Promise<...>;
  executeChecklistAction?: (ctx, action, beatId, opts: { signal: AbortSignal }) => Promise<...>;
  // ...
}

// Inside fourPhaseExecutor
const abortController = new AbortController();
const timeoutHandle = setTimeout(() => abortController.abort(new Error("beat_timeout")), this.config.beatTimeoutMs);
try {
  const ctx = deps.loadAgentContext(..., abortController.signal);
  // ...
  const result = await deps.executeTask(ctx, taskId, beatId, { signal: abortController.signal });
  // ...
} catch (err) {
  if (err?.name === "AbortError") {
    outcome = "TIMED_OUT";
    status = "timed_out";
  } else {
    outcome = "ERROR";
  }
  // ...
} finally {
  clearTimeout(timeoutHandle);
}
```

**Dependency:** every dep implementation must honor `signal` — F-119 + F-132 covers LLM calls; F-082 covers opencode event streams; `loadAgentContext` gets it too.

**Verification:** stub `executeTask` to hang; fire a beat with short `beatTimeoutMs`; confirm beat rejects with AbortError and finishes within the timeout.

**Effort:** 2 hours including downstream dep updates.

---

## F-206 · Audit `commitBeatRecord` failures

Bundled with F-112. The heartbeat's catch just needs to route the error:

```ts
if (this.deps) {
  this.deps.commitBeatRecord(record).catch((err) => {
    this.deps.audit.auditError(
      request.companyId, "beat_record_commit_failed",
      `Failed to persist beat ${record.id}`, err, { beatId: record.id },
    );
    beatRecordWriteFailures.inc();
  });
}
```

**Effort:** 10 minutes. Bundled with F-112.

---

## F-207 · Extract each phase into its own method

**Flaw it pairs with:** 214-line god function.

**Proposed code** — 4 new private methods + a small orchestrator:

```ts
interface PhaseResult<T> {
  data?: T;
  skipReason?: { outcome: BeatOutcome; summary: string; status: BeatStatus };
  error?: unknown;
  phaseInfo?: Partial<BeatPhases>;
  tokens?: number;
}

private async phase1Wake(request, beatId, signal): Promise<PhaseResult<AgentBeatContext>> {
  const start = Date.now();
  const snapshotVersion = this.deps!.getSnapshotVersion();
  const ctx = this.deps!.loadAgentContext(request.agentId, beatId, this.beatCounter, request.trigger, {
    beatTokenBudget: this.config.beatTokenBudget,
    beatCostCeilingCents: this.config.beatCostCeilingCents,
  });
  if (!ctx) return { skipReason: { outcome: "SKIPPED", summary: "agent not found", status: "skipped" }, phaseInfo: { contextAssembly: { durationMs: Date.now() - start, tokensUsed: 0 } } };
  if (this.config.pauseWhenNoActiveSprint && !ctx.currentSprint && !LEADERSHIP_ROLES.includes(request.role)) {
    return { skipReason: { outcome: "SKIPPED", summary: "no active sprint", status: "skipped" }, phaseInfo: { contextAssembly: { durationMs: Date.now() - start, tokensUsed: 0 } } };
  }
  if (this.config.pauseWhenBudgetExhausted && ctx.companyBudgetRemainingCents <= 0) {
    return { skipReason: { outcome: "BUDGET_EXCEEDED", summary: "company budget exhausted", status: "skipped" }, phaseInfo: { contextAssembly: { durationMs: Date.now() - start, tokensUsed: 0 } } };
  }
  return { data: ctx, phaseInfo: { contextAssembly: { durationMs: Date.now() - start, tokensUsed: 0 } } };
}

private phase2Observe(ctx: AgentBeatContext): PhaseResult<ChecklistResult> { ... }
private async phase3Execute(ctx, checklist, beatId, signal): Promise<PhaseResult<{ tokens, summary, outcome, actions, toolCalls }>> { ... }
private async phase4Serialize(request, beatId, snapshotVersionRead): Promise<PhaseResult<{ version, mutationCount }>> { ... }

private async fourPhaseExecutor(request, beatId, beatNumber) {
  const startedAt = new Date().toISOString();
  const phases: BeatPhases = {};
  const signal = new AbortController().signal;  // wire F-205 here

  const wake = await this.phase1Wake(request, beatId, signal);
  Object.assign(phases, wake.phaseInfo ?? {});
  if (wake.skipReason) return this.buildRecord(beatId, beatNumber, request, startedAt, phases, wake.skipReason.status, wake.skipReason.outcome, ...);
  // ... similar for phase 2, 3, 4
}
```

~60 LOC orchestrator + 4 focused phase methods. Each phase testable in isolation.

**Verification:** existing heartbeat.e2e-test.ts passes; new unit tests per phase; tsc clean.

**Effort:** 4-6 hours.

---

## F-208 · Per-deployment cost rates; separate input/output tokens

Bundled with F-118 + F-131.

```ts
// config/llm.ts
export const llmCostConfig = {
  deployments: {
    ceoDeployment: { inputPer1M: Number(process.env.ARCEUS_CEO_INPUT_COST_PER_M ?? 250), outputPer1M: Number(process.env.ARCEUS_CEO_OUTPUT_COST_PER_M ?? 1000) },  // cents
    workerDeployment: { inputPer1M: Number(process.env.ARCEUS_WORKER_INPUT_COST_PER_M ?? 50), outputPer1M: Number(process.env.ARCEUS_WORKER_OUTPUT_COST_PER_M ?? 150) },
  },
};

// buildRecord uses breakdown from usage
const costCents = (
  (inputTokens / 1_000_000) * rates.inputPer1M +
  (outputTokens / 1_000_000) * rates.outputPer1M
);
```

Requires `BeatRecord` to carry `inputTokens` + `outputTokens` separately (schema migration).

**Effort:** 1 hour including schema + contracts.

---

## F-209 · Pre-emptive budget checks inside `executeTask`

**Flaw:** budget checked post-hoc.

**Proposed shape:**

```ts
// BeatDependencies
executeTask?: (ctx, taskId, beatId, opts: { signal: AbortSignal; budget: BudgetHandle }) => Promise<...>;

interface BudgetHandle {
  remainingCents(): number;
  remainingTokens(): number;
  charge(tokens: number, costCents: number): void;  // emits abort if overdrawn
}

// Implementation (apps/api side)
function buildBudgetHandle(beat: { tokenBudget: number; costCeilingCents: number; companyBudgetCents: number }): BudgetHandle {
  let tokens = 0, cents = 0;
  return {
    remainingCents: () => beat.costCeilingCents - cents,
    remainingTokens: () => beat.tokenBudget - tokens,
    charge: (t, c) => {
      tokens += t; cents += c;
      if (tokens > beat.tokenBudget || cents > beat.costCeilingCents) {
        throw new BudgetExceededError(tokens, cents);
      }
    },
  };
}

// executeTask uses budget.charge() before each LLM call; aborts mid-flight.
```

**Effort:** 1-2 hours.

---

## F-210 · Store `errorDetail` on BeatRecord

Bundled with F-011 + F-210. Add `errorDetail: SerializedError | null` to `BeatRecord` schema; engine populates in catch:

```ts
catch (err) {
  errorMessage = err instanceof Error ? err.message : String(err);
  errorDetail = serializeError(err);
  // ...
}

buildRecord(..., errorMessage, errorDetail, ...) {
  return { ..., errorMessage, errorDetail };
}
```

Schema migration: add `error_detail JSONB` column to `beat_records` table.

**Effort:** 30 minutes.

---

## F-211 · Engine-level retry with classification

Bundled with F-125. Inside `phase3Execute`:

```ts
let attempt = 0;
while (attempt < MAX_BEAT_RETRIES) {
  try {
    const result = await deps.executeTask(ctx, taskId, beatId, opts);
    return { data: { ...result } };
  } catch (err) {
    if (attempt === MAX_BEAT_RETRIES - 1 || !isRetryableError(err)) {
      return { error: err };
    }
    attempt++;
    await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
  }
}
```

Emits an audit entry per retry (bundled with F-137).

**Effort:** 30 minutes. Bundled with F-125/F-137.

---

## F-212 · Stranded-beat recovery sweeper

**Flaw:** expired locks don't trigger recovery.

**Proposed code:**

```ts
class HeartbeatEngine {
  private readonly strandedRetryCount = new Map<string, number>();  // agentId → count
  private static readonly MAX_STRANDED_RETRIES = 5;

  private tick() {
    const expired = this.locks.expireStale(this.config.beatTimeoutMs);
    for (const { agentId, beatId } of expired) {
      const count = (this.strandedRetryCount.get(agentId) ?? 0) + 1;
      this.strandedRetryCount.set(agentId, count);

      this.deps?.audit.auditError(
        /* companyId */ "unknown",  // look up from roster
        "beat_stranded",
        `Beat ${beatId} on agent ${agentId} exceeded timeout; retry ${count}/${HeartbeatEngine.MAX_STRANDED_RETRIES}`,
        null,
        { beatId, agentId, count },
      );

      if (count >= HeartbeatEngine.MAX_STRANDED_RETRIES) {
        // Stage a mutation: set agent status = blocked
        this.stageMutation({ type: "agent_status", agentId, status: "blocked" });
        this.deps?.audit.auditSystem(
          "unknown", "agent_auto_blocked",
          `Agent ${agentId} auto-blocked after ${count} stranded beats`,
        );
        this.strandedRetryCount.delete(agentId);
        continue;
      }

      // Enqueue exactly ONE recovery wake
      const roster = this.deps?.getAgentRoster?.() ?? [];
      const agent = roster.find((a) => a.agentId === agentId);
      if (agent) {
        this.emitEvent(agent.companyId, agentId, agent.role, "stranded_recovery");
      }
    }

    // Reset counter on first successful beat
    // (hook into triggerBeat's success path: this.strandedRetryCount.delete(agentId))
  }
}
```

**Requires:** `BeatEventTrigger` to include `"stranded_recovery"`; audit ledger entries so operators see the pattern.

**Verification:** hang an agent's beat > `beatTimeoutMs`; confirm expiration triggers a recovery wake; successful recovery resets the counter.

**Effort:** 2-3 hours.

---

## F-213 · Overdueness-based scheduling

**Flaw:** pure priority starves low-priority agents.

**Proposed code:**

```ts
private tick() {
  // ... expireStale
  const roster = this.deps!.getAgentRoster!();
  const now = Date.now();

  // Compute overdueness + priority for each agent
  const ranked = roster.map((a) => {
    const interval = this.config.roleIntervals[a.role] ?? this.config.schedulerIntervalMs * 10;
    const last = this.lastBeatAt.get(a.agentId) ?? 0;
    const overdueBy = Math.max(0, (now - last) - interval);
    return { ...a, overdueBy, priority: HeartbeatEngine.ROLE_PRIORITY[a.role] ?? 99 };
  });

  ranked.sort((a, b) => {
    if (a.overdueBy !== b.overdueBy) return b.overdueBy - a.overdueBy;  // most overdue first
    return a.priority - b.priority;  // priority tiebreaker
  });

  // ... iterate ranked, acquire slots
}
```

Priority still matters when everyone is "at schedule," but nobody gets starved indefinitely.

**Verification:** simulate 10 agents with varying priorities but similar overdueness; confirm they all eventually beat (no permanent starvation).

**Effort:** 30 minutes.

---

## F-214 · Surface `applyMutations.errors` in BeatRecord

```ts
const heartbeatResult = this.flushStagedMutations(...);
mutationCount += heartbeatResult.applied;
snapshotVersionWritten = heartbeatResult.version;

if (heartbeatResult.errors.length > 0) {
  outcome = "PARTIAL_FAILURE";  // new enum value
  summary = `${summary} [mutation errors: ${heartbeatResult.errors.length}]`;
  // Store errors in phases.serialization detail
  phases.serialization = { durationMs: Date.now() - serializeStart, mutationCount, errors: heartbeatResult.errors };
}
```

Add `PARTIAL_FAILURE` to `BeatOutcome` enum in contracts.

**Effort:** 30 minutes.

---

## F-215 · Atomic task checkout mutation

**Flaw:** no CAS on task claim.

**Proposed code** — add a `task_checkout` mutation type:

```ts
// packages/contracts/src/mutations.ts
{ type: "task_checkout"; taskId: string; agentId: string; beatId: string; expectedStatus: TaskStatus }
```

Implementation in `cpApplyMutations`:
- `SELECT ... FOR UPDATE` on the task.
- Fail if `task.assignedAgentId` is set and ≠ our agentId.
- Fail if `task.status ≠ expectedStatus`.
- Otherwise set `assignedAgentId`, `checkoutBeatId`, update status.

Engine uses it:

```ts
// phase3Execute
this.stageMutation({
  type: "task_checkout",
  taskId: actionableTask.id,
  agentId: request.agentId,
  beatId,
  expectedStatus: actionableTask.status,
});

// Flush BEFORE calling executeTask
const checkoutResult = this.flushStagedMutations(request.companyId, { eventId: beatId });
if (checkoutResult.errors.length > 0) {
  // Task was taken by another agent — abort gracefully
  return { skipReason: { outcome: "SKIPPED", summary: "task lost to concurrent beat", status: "skipped" } };
}

// NOW safe to executeTask
const result = await deps.executeTask(ctx, actionableTask.id, beatId, opts);
```

Depends on F-086 (CAS re-enabled) to actually enforce the check.

**Effort:** 2-3 hours. Bundled with F-086 + F-088.

---

## F-216 · Bundled with F-215

Same underlying fix — explicit checkout eliminates the orphan-task race.

**Effort:** 0.

---

## F-217 · Safe `emitBeatEvent` wrapper

```ts
private safeEmit(event: { type: string; beatId: string; agentId: string; role: string; data?: Record<string, unknown> }) {
  try {
    this.deps?.emitBeatEvent?.(event);
  } catch (err) {
    this.deps?.audit.auditError(
      "system", "beat_event_subscriber_failed",
      `Event subscriber threw on ${event.type}`, err, { beatId: event.beatId },
    );
  }
}

// Replace every deps.emitBeatEvent?.(...) with this.safeEmit(...)
```

**Effort:** 15 minutes.

---

## F-218 · UUID-based beatId

```ts
const beatId = `beat_${crypto.randomUUID()}`;  // globally unique
```

Still human-readable prefix; no collision risk across resets or restarts.

**Effort:** 2 minutes.

---

## F-219 · Drain all queued events; clear on pause

```ts
private drainEventQueue(agentId: string): void {
  const queue = this.eventQueue.get(agentId);
  if (!queue || queue.length === 0) return;
  this.eventQueue.delete(agentId);

  // Fire all queued events in sequence; don't just take one
  for (const entry of queue) {
    this.triggerBeat({ ...entry, trigger: { type: "event", event: entry.event } })
      .catch((err) => this.deps?.audit.auditError(entry.companyId, "queued_beat_failed", `Queued event ${entry.event} failed`, err, { agentId }));
  }
}

// On agent pause/terminate (new method):
clearEventQueueForAgent(agentId: string) {
  this.eventQueue.delete(agentId);
  this.deps?.audit.auditSystem("system", "event_queue_cleared", `Cleared ${count} queued events for ${agentId}`);
}
```

**Effort:** 20 minutes.

---

## F-220 · Bounded event queue per agent

```ts
private static readonly MAX_EVENTS_PER_AGENT = 100;

emitEvent(companyId, agentId, role, event) {
  if (this.locks.isLocked(agentId)) {
    const queue = this.eventQueue.get(agentId) ?? [];
    if (queue.length >= HeartbeatEngine.MAX_EVENTS_PER_AGENT) {
      const dropped = queue.shift();
      this.deps?.audit.auditSystem("system", "event_queue_overflow", `Dropped oldest event for ${agentId}`, { dropped });
    }
    queue.push({ companyId, role, event });
    this.eventQueue.set(agentId, queue);
    return;
  }
  // ... non-queued path
}
```

**Effort:** 10 minutes. Bundled with F-219.

---

## F-221 · Treat `beatHistory` as UI cache only

**Proposed code:**

```ts
// Rename to make intent explicit
private readonly recentBeatsCache: BeatRecord[] = [];   // UI cache; NOT authoritative
private static readonly RECENT_CACHE_SIZE = 200;

// Point authoritative reads at DB
getRecentBeats(companyId?: string): BeatRecord[] {
  return companyId
    ? this.recentBeatsCache.filter((r) => r.companyId === companyId)
    : [...this.recentBeatsCache];
}

async getBeatHistory(companyId: string, opts?: { limit?: number; agentId?: string }): Promise<BeatRecord[]> {
  // Delegate to cpGetBeatHistory — DB is truth
  return this.deps?.getBeatHistory?.(companyId, opts) ?? [];
}
```

**Effort:** 15 minutes.

---

## F-222 · `selectTask` honors `blockedByIds`

```ts
private selectTask(ctx: AgentBeatContext) {
  // ... existing filter by status/role
  const withDepsResolved = actionable.filter((t) => {
    const blockers = t.blockedByIds ?? [];
    if (blockers.length === 0) return true;
    return blockers.every((id) => {
      const blocker = ctx.tasks.find((b) => b.id === id);
      return !blocker || blocker.status === "completed" || blocker.status === "cancelled";
    });
  });
  if (withDepsResolved.length === 0) return null;
  // ... sort + return first
}
```

**Verification:** a task with `blockedByIds: ["t-1"]` where `t-1.status = "in_progress"` is NOT selected; when `t-1` completes, it becomes selectable.

**Effort:** 15 minutes.

---

## F-223 · Leadership roles from enum

```ts
// packages/contracts
export const LEADERSHIP_ROLES: ReadonlySet<AgentRole> = new Set(["ceo", "cto", "pm"]);

// heartbeat.ts
import { LEADERSHIP_ROLES } from "@arceus/contracts";
const isLeadership = LEADERSHIP_ROLES.has(request.role);
```

Bundled with F-098 role enum.

**Effort:** 5 minutes.

---

## F-224 · Zod validation + audit on `patchConfig`

```ts
patchConfig(patch: Partial<HeartbeatConfig>) {
  const next = heartbeatConfigSchema.parse({ ...this.config, ...patch });
  this.deps?.audit.auditSystem("system", "heartbeat_config_patched", `Heartbeat config updated`, {
    detail: { changes: Object.keys(patch), before: this.getConfig(), after: next },
  });
  Object.assign(this.config, next);
}
```

Requires `heartbeatConfigSchema` to exist in contracts.

**Effort:** 20 minutes.

---

## F-225 · Expanded `getStatus`

```ts
getStatus() {
  const now = Date.now();
  const queueSizes: Record<string, number> = {};
  for (const [agentId, q] of this.eventQueue) queueSizes[agentId] = q.length;

  return {
    running: this.running,
    activeLocks: this.locks.activeCount,
    semaphoreAvailable: this.semaphore.available,
    totalBeats: this.beatCounter,
    lastBeatAt: Object.fromEntries(this.lastBeatAt),
    recentHistorySize: this.beatHistory.length,
    queuedEventsPerAgent: queueSizes,
    stagedMutations: this.stagedMutations.length,
    strandedRetryCounts: Object.fromEntries(this.strandedRetryCount ?? new Map()),  // F-212
    avgBeatDurationMs: computeAvg(this.beatHistory),
  };
}
```

Feeds the `/api/heartbeat/status` route.

**Effort:** 30 minutes.

---

## F-226 · Rich `ExecuteTaskResult` shape

**Flaw it pairs with:** thin return type.

```ts
// packages/contracts/src/beats.ts
export interface ExecuteTaskResult {
  status: "completed" | "partial" | "failed";
  summary: string;
  nextActions: Array<{
    kind: "create_task" | "escalate" | "retry" | "notify_board" | "schedule_meeting";
    detail: string;
    relatedTaskId?: string;
  }>;
  artifacts: Array<{
    id: string;
    kind: "code" | "plan" | "output" | "specification";
    path?: string;
  }>;
  tokensUsed: number;
  inputTokens?: number;   // F-208 integration
  outputTokens?: number;
  actionsCount: number;
  toolCalls: number;
  completed: boolean;
  errorDetail?: SerializedError;
}

// Engine uses the richer shape — surfaces nextActions to the audit ledger, writes artifacts to the beat record
```

**Effort:** 1 hour.

---

## F-227 · Unify `executeChecklistAction` shape with `executeTask`

Same `ExecuteTaskResult` shape for both. Omit `completed` if it doesn't apply, or alias the type.

**Effort:** 0 bundled with F-226.

---

## F-228 · `BeatContext` passed to dep callbacks; hide `stagedMutations`

```ts
interface BeatContext {
  beatId: string;
  agentId: string;
  companyId: string;
  stageMutation: (m: StateMutation) => void;
  audit: BeatDependencies["audit"];
  signal: AbortSignal;
  budget: BudgetHandle;   // F-209
}

// dep signature
executeTask?: (ctx: AgentBeatContext, taskId: string, beatCtx: BeatContext) => Promise<ExecuteTaskResult>;
```

`stagedMutations` becomes per-beat (created inside `fourPhaseExecutor`, never instance state).

**Effort:** 1 hour. Bundled with F-207's phase extraction.

---

## F-229 · Narrow `stageMutation` parameter to `StateMutation`

```ts
stageMutation(m: StateMutation) { ... }
```

Bundled with F-090's discriminated union.

**Effort:** 0 bundled.

---

## F-230 · Audit dropped mutations in catch

```ts
} catch (err) {
  const dropped = [...this.stagedMutations];
  if (dropped.length > 0) {
    deps.audit.auditSystem(
      request.companyId, "beat_mutations_discarded",
      `Discarded ${dropped.length} staged mutations due to beat failure`,
      { beatId, types: dropped.map((m) => m.type) },
    );
  }
  this.clearStagedMutations();
  // ... rest of error path
}
```

**Effort:** 10 minutes.

---

## F-231 · Pre-check pause conditions in `triggerBeat`

```ts
async triggerBeat(request: BeatRequest): Promise<BeatRecord | null> {
  if (this.config.pauseRoles.includes(request.role)) return null;

  // NEW: cheap pre-checks before semaphore
  if (this.config.pauseWhenBudgetExhausted) {
    const snap = this.deps?.getSnapshot?.();
    if (snap && snap.company.budgetCents - snap.company.spentCents <= 0) {
      return null;
    }
  }
  // ... rest
}
```

Requires `getSnapshot` on `BeatDependencies` (or a narrower `getCompanyBudget()` helper).

**Effort:** 20 minutes.

---

## F-232 · Session persistence per beat

Bundled with F-174. After real tables exist:

```ts
// BeatDependencies
loadBeatSession?: (agentId: string, taskId: string) => Promise<SessionHandle | null>;
saveBeatSession?: (session: SessionHandle) => Promise<void>;

// phase3Execute
const session = await deps.loadBeatSession?.(request.agentId, actionableTask.id);
const result = await deps.executeTask(ctx, actionableTask.id, { ...beatCtx, session });
if (result.session) await deps.saveBeatSession?.(result.session);
```

`agent_task_sessions` table must exist (migration).

**Effort:** 2-3 hours after F-174.

---

## F-233 · Process-group tracking in `executeTask` result

Extend `ExecuteTaskResult`:

```ts
export interface ExecuteTaskResult {
  // ... F-226 fields
  processGroupId?: number;   // PID of spawned child (opencode)
}

// Engine tracks active PIDs per beat for timeout kill:
private activeProcessGroups = new Map<string, number>();   // beatId → pgid

// After executeTask returns
if (result.processGroupId) this.activeProcessGroups.set(beatId, result.processGroupId);

// On timeout (F-203's expireStale or F-205's abort)
const pgid = this.activeProcessGroups.get(beatId);
if (pgid) process.kill(-pgid, "SIGTERM");  // negative = process group
```

**Effort:** 1 hour. Bundled with F-066.

---

## F-234 · Remove `executionMode === "orchestrator"` dead branch

Grep for consumers; if nothing sets mode to `"orchestrator"`, remove the field entirely.

```bash
git grep "executionMode" apps/ packages/
```

If legacy: keep field, document its meaning; if not: delete.

**Effort:** 10 minutes.

---

## F-235 · `Readonly<BeatRecord>` returns from `getHistory`

```ts
getHistory(companyId?: string): ReadonlyArray<Readonly<BeatRecord>> {
  // ... same body
}
```

**Effort:** 2 minutes.

---

## F-236 · Typed event payloads

```ts
// packages/contracts/src/beats.ts
export type BeatEvent =
  | { type: "beat_started"; beatId: string; agentId: string; role: string }
  | { type: "beat_completed"; beatId: string; agentId: string; role: string; data: { outcome: BeatOutcome; totalTokens: number; summary: string } }
  | { type: "beat_failed"; beatId: string; agentId: string; role: string; data: { error: string } }
  | { type: "beat_idle"; beatId: string; agentId: string; role: string; data: { outcome: BeatOutcome } };

// BeatDependencies
emitBeatEvent?: (event: BeatEvent) => void;
```

Subscribers narrow via `switch (event.type)`; exhaustiveness enforced by `assertNever`.

**Effort:** 30 minutes. Bundled with F-032.

---

## F-237 · Structured logger injected into engine

```ts
interface BeatDependencies {
  // ... existing
  logger: FastifyBaseLogger;   // new
}

// Replace all console.log/warn/error with deps.logger.info/warn/error({ event: "..." }, message)
```

**Effort:** 30 minutes.

---

## Running index

| Fix | Flaw | Effort | Order of ops |
|---|---|---|---|
| F-003 | ⛔ missing `workspace/` | 1-8h | **First** — unblocks everything |
| F-001 | 🔴 process handlers | 1-2h | After F-003 (verify with working tsc) |
| F-011 | 🟡 `serializeError` helper | 0.75h | Before F-001/F-010 (both reuse it) |
| F-012 | 🟡 `COMPANY_ID_PENDING` constant (Stage 1) | 0.5h | Before F-010 |
| F-005 | 🟡 factory extraction | 4-6h | After F-001 (handlers go in factory) |
| F-010 | 🟠 `buildBeatDependencies` factory | 2h | Inside F-005 |
| F-009 | 🟠 generic `BeatDependencies<TMutation>` | 1-2h | Bundle with F-014 |
| F-014 | 🟢 unified `audit(entry)` | 1-2h | Bundle with F-009 |
| F-013 | 🟠 delete module-level setters | 3-4h | After F-005 |
| F-004 | 🟡 persistence env | 0.5h | Standalone; any time |
| F-007 | 🟢 pino config | 1-2h | Inside F-005's factory |
| F-008 | 🟢 eslint order | 1h + fallout | Standalone; any time |
| F-006 | 🟢 rename legacy getter | 0.5h | After F-003 |
| F-002 | 🟠 in-memory snapshot | 2d/2w/4w | **Last** — strategic, scale-gated |
| F-012 Stage 2 | 🟡 structural snapshot discriminator | 1-2d | With F-002 Stage B |
| F-015 | 🟠 buildMeetingPipeline factory | 6-8h | Blocks most §4 fixes; land after F-010 |
| F-016 | 🟡 break import cycle | 2-4h | Bundle with F-015 |
| F-017 | 🟠 event-driven contribution wait | 3-4h | After F-015 |
| F-018 | 🟡 meetings config file | 20m | Bundled with F-017 |
| F-019 | 🟡 AbortSignal through phases | 2h | After F-015 + F-017 |
| F-020 | 🟠 `relatedTaskId` schema field | 2-3h | After F-015; includes data migration |
| F-021 | 🟡 per-participant audit on failure | 1h | After F-011 + F-015 |
| F-022 | 🟡 `withPhaseAudit` wrapper | 1.5h | After F-011 + F-015 |
| F-023 | 🟡 hoist `meetingFactSchema` | 15m | Standalone; any time |
| F-024 | 🟢 extract `extractMeetingFactsViaLLM` | 20m | Bundles with F-023 |
| F-025 | 🟡 `MeetingEffectsContext` interface | 30m | Standalone |
| F-026 | 🟢 scheduler config in file | 5m | Folds into F-018 |
| F-027 | 🟡 setter for `runPipeline` on scheduler | 30m | Bundles with F-015 |
| F-028 | 🟢 rename imported phase functions | 15m | Bundles with F-015 + F-016 |
| F-029 | 🟢 extract `initializeExistingCompany` | 30m | Bundles with F-005 factory |
| F-030 | 🟡 audit registry-seed failure | 45m | After F-011 + F-029 |
| F-031 | 🟡 staleness-gated heartbeat resume | 2h | After F-029; new control-plane helper |
| F-032 | 🟡 exported `BeatEventType` + exhaustive narrowing | 30m | Bundles with F-014 |
| F-033 | 🟡 unsubscribe on shutdown | 30m | Bundles with F-039 |
| F-034 | 🟢 `??` instead of `||` on summary fallback | 10m | Bundles with F-032 |
| F-035 | 🟠 env-gated CORS allowlist | 45m | Standalone; before prod launch |
| F-036 | 🟠 helmet + rate-limit + request-ID | 1.5h | Standalone; before prod launch |
| F-037 | 🟡 route-loop + `app.services` container | 3-4h | After F-013 |
| F-038 | 🟡 infrastructure-before-routes ordering | 2h | Part of F-005 factory |
| F-039 | 🟠 shutdown: await + timeout + force-kill | 1.5h | Part of F-005 factory |
| F-040 | 🟡 wrap `app.listen` in try/catch | 20m | Part of F-038 |
| F-041 | 🟡 `.catch` on `warmUpOpencode` | 30m | Standalone |
| F-042 | 🟢 audit demo-mode + expose on health | 20m | Bundles with F-030 |
| **F-043** | 🟠 `OrchestrationState` class (umbrella refactor) | **1.5-3 days** | Collapses F-044/F-045/F-046/F-048/F-054/F-055 |
| F-044 | 🟠 delete setter one-liners | 0 | Bundled with F-043 |
| F-045 | 🟠 `Readonly<>` getters | 30m | Bundled with F-043 |
| F-046 | 🟡 call `dispose()` from shutdown | 10m | Bundled with F-043 + F-039 |
| F-047 | 🟡 bound + clean `pendingPromptCompletions` | 45m | Inside F-043 |
| F-048 | 🟡 `CeoProposalState` discriminated union | 30m | Inside F-043 |
| F-049 | 🟡 extract `resolveProductDir()` | 30m | Standalone |
| F-050 | 🟡 lazy `productDir` | 0 | Bundled with F-049 |
| F-051 | 🟡 move `*Input` DTOs to contracts | 45m | Standalone; before F-052 |
| F-052 | 🟡 Zod-derived status types | 30m | After F-051 |
| F-053 | 🟡 decide + document `?? []` fallback | 30m | Standalone |
| F-054 | 🟡 reset-invariant meta-test | 45m | Interim only — obsoleted by F-043 |
| F-055 | 🟡 constructor-injected emitter + scheduler | 0 | Bundled with F-043 |
| F-056 | 🟡 push magic numbers to config | 20m | Standalone |
| F-057 | 🟡 `ARCEUS_REPO_ROOT` env + sanity check | 15m | Bundled with F-049 |
| F-058 | 🟡 `ReactiveEmitter` type alias | 0 | Bundled with F-043 |
| F-059 | 🟢 brand status strings (deferred) | 5m / 1h | Defer unless bug |
| F-060 | 🟢 JSDoc pass + ESLint rule | 1-2h | Standalone |
| F-061 | 🟢 `WorkspaceFileMtimes` alias | 5m | Bundled with F-043 |
| F-062 | 🟢 lazy Set construction | 10m | Defer — low value |
| **F-063** | 🔴 `shell: false` on spawn | 5m | First; tiny + security-critical |
| **F-064** | 🟠 child-env allowlist | 20m | Bundles with F-063 |
| F-065 | 🟠 delete `ensureAzureRuntimeEnvironment` | 15m | Bundles with F-064 |
| F-066 | 🟠 track child + kill on reset | 1h | Part of F-069 manager |
| F-067 | 🟡 detach listeners after startup | 30m | Bundles with F-074 |
| F-068 | 🟡 audit + metric on destroyBeatSession failure | 30m | Standalone |
| **F-069** | 🟠 `OpencodeManager` class (umbrella) | 4-6h | Collapses F-063/64/65/66/67/68/83/84 |
| F-070 | 🟡 `resolveProductDir` helper | 5m | Bundled with F-049 |
| F-071 | 🟡 retry spawn on EADDRINUSE | 30m | Standalone |
| F-072 | 🟡 `error.code` port-conflict detection | 15m | Bundles with F-071 |
| F-073 | 🟡 case-insensitive URL parsing + ANSI strip | 30m | Standalone |
| F-074 | 🟡 pipe stderr to logger | 30m | Bundles with F-067 |
| F-075 | 🟠 deep merge in loadOpencodeConfig | 20m | Standalone |
| F-076 | 🟠 async config sync, once-per-lifecycle | 45m | Bundles with F-069 |
| F-077 | 🟡 distinguish ENOENT from SyntaxError | 10m | Bundles with F-075 |
| F-078 | 🟡 Zod-validated runtimeConfig | 30m | Standalone |
| F-079 | 🟠 per-request AbortSignal timeout | 30m | Before prod |
| F-080 | 🟡 verify OpenCode identity on probe | 20m | Standalone |
| F-081 | 🟡 require https for remote hosts | 20m | Bundles with F-078 |
| F-082 | 🟡 consumeOpencodeEvents helper | 45m | Standalone |
| F-083 | 🟡 audit all lifecycle events | 1h | Bundled with F-069 |
| F-084 | 🟡 warmUp audits | 0 | Bundled with F-041 + F-083 |
| F-085 | 🟢 Zod-schema param on postOpencodeJson | 15m | Bundles with F-079 |
| **F-086** | 🔴 Re-enable CAS + per-entity versioning | 2h / 1-2d / 1-2w | Stage 1 blocks ship; rest is scale-gated |
| **F-087** | 🔴 Delete `npm run build` path; fixed tsc argv | 1h | **Security critical — do first** |
| **F-088** | 🔴 All-or-nothing batch mutations | 4-6h | After F-086 |
| **F-089** | 🟠 `ControlPlane` class (umbrella) | 6-8h | Collapses F-089/95/104/107/108/112 |
| F-090 | 🟠 align StateMutation with store helpers | 2h | Part of F-088 |
| F-091 | 🟠 audit persistence-write failures | 30m | Standalone |
| F-092 | 🟠 extract `buildAgentContext` | 3-4h | Part of F-089 |
| F-093 | 🟠 async build check | 1h | Bundled with F-087 |
| F-094 | 🟠 boundary truncation policies | 2h | Standalone |
| F-095 | 🟠 store-event unsubscribe | 45m | Bundled with F-089 |
| F-096 | 🟡 use COMPANY_ID_PENDING | 5m | Bundled with F-012 |
| F-097 | 🟡 collapse ternary; verify `stopped` | 20m | Standalone |
| F-098 | 🟡 role enum references | 30m | Bundled with F-052 |
| F-099 | 🟡 `reviewState` in Sprint schema | 30m | Standalone |
| F-100 | 🟡 background build check | 0 | Bundled with F-093 |
| F-101 | 🟡 fail loud on null startedAt | 15m | Standalone |
| F-102 | 🟡 Zod-validate DB rows | 45m | Standalone |
| F-103 | 🟡 replace require() with import | 2m | Standalone |
| F-104 | 🟡 DB-first trust updates | 30m | Bundled with F-089 |
| F-105 | 🟡 BoundedArray for violations | 20m | Standalone |
| F-106 | 🟡 degraded flag on cache-fallback | 30m | Standalone |
| F-107 | 🟡 deep clone trust scores | 5m | Bundled with F-089 |
| F-108 | 🟡 audit trust-hydrate failures | 20m | Bundled with F-030 |
| F-109 | 🟡 warn on trust cache miss | 10m | Standalone |
| F-110 | 🟡 implement or delete taskProgress | 20m | Standalone |
| F-111 | 🟡 bundled with F-098 | 0 | — |
| F-112 | 🟡 audit + retry beat-record commit | 30m | Bundled with F-089 |
| F-113 | 🟢 `.catch` on agents-hired handler | 5m | Bundled with F-095 |
| F-114 | 🟢 assertNever in mutation switch | 10m | After F-090 |
| F-115 | 🟢 move mid-file imports to top | 5m | Standalone |
| F-116 | 🟢 JSDoc cost column OR migrate schema | 5m / 1h | Standalone |
| F-117 | 🟢 Number.isFinite on cost | 2m | Standalone |
| **F-118** | 🔴 attribute tokens to exactly one accumulator | 2h | First — fixes cost-tracking lie |
| F-119 | 🟠 AbortSignal + timeout on LLM fetch | 30m | Before prod |
| F-120 | 🟠 `AzureOpenAIError` class; keep body out of message | 30m | Bundled with F-011 |
| F-121 | 🟠 stream usage via `stream_options.include_usage` | 2h | After F-118 |
| F-122 | 🟠 `LlmEmptyResponseError` on missing content | 10m | Standalone |
| F-123 | 🟠 swap resilientCall order; match docstring | 15m | Before F-124 / F-137 |
| F-124 | 🟠 audit breaker state changes + metric | 30m | Standalone |
| F-125 | 🟠 typed errors for retry classification | 1h | After F-120 |
| F-126 | 🟠 cap retry backoff with maxDelay | 10m | Standalone |
| F-127 | 🟡 `LlmCostTracker` class | 45m | Bundled with F-118 |
| F-128 | 🟡 cache zodToJsonSchema | 15m | Standalone |
| F-129 | 🟡 thread temperature through all entry points | 10m | Bundled with F-119 |
| F-130 | 🟡 Zod-validated Azure response | 30m | Standalone |
| F-131 | 🟡 llmConfig module | 15m | Bundles with F-119 + F-129 |
| F-132 | 🟡 AbortSignal on all LLM calls | 0 | Bundled with F-119 |
| F-133 | 🟡 api-key validation | 0 | Bundled with F-078 |
| F-134 | 🟡 audit stream completion + failure | 0 | Bundled with F-121 |
| F-135 | 🟡 add 408/425 to isRetryableHttpStatus | 2m | Standalone |
| F-136 | 🟡 `performance.now()` for breaker cooldown | 10m | Standalone |
| F-137 | 🟡 audit + metric on retries | 30m | Bundles with F-123 |
| F-138 | 🟡 bundled with F-124 | 0 | — |
| F-139 | 🟡 BreakerRegistry class | 45m | Standalone |
| F-140 | 🟢 bundled with F-130 | 0 | — |
| F-141 | 🟢 bundled with F-122 | 0 | — |
| F-142 | 🟢 widen jitter to decorrelated | 2m | Standalone |
| **F-143** | 🔴 fix double-UUID in bootstrapCompany | 2m | **Trivial; fix immediately** |
| **F-144** | 🟠 `CompanyStore` class (umbrella) | 8-10h | Collapses F-144/146/147/148/149/152/163/164/165/166/169 |
| F-145 | 🟠 move taskProgress into snapshot | 1h | Standalone |
| F-146 | 🟠 audit persist failures | 0 | Bundled with F-091 |
| F-147 | 🟠 emit state-changed on hydrate | 2m | Immediate; bundled with F-144 |
| F-148 | 🟠 unified resetCompany scope | 30m | Before any reset calls in prod |
| F-149 | 🟠 Readonly<> return types | 5m | Bundled with F-144 |
| F-150 | 🟠 extract applyStrategy | 3-4h | Standalone |
| F-151 | 🟠 Zod parse at store boundary | 30m | Standalone |
| F-152 | 🟡 generic upsertById helper | 30m | Standalone |
| F-153 | 🟡 consistent insert position | 10m | Bundled with F-152 |
| F-154 | 🟡 createEmptyCompanySnapshot once | 0 | Bundled with F-143 |
| F-155 | 🟡 sentinel constants | 5m | Bundled with F-012 |
| F-156 | 🟡 config-driven agent names | 15m | Standalone |
| F-157 | 🟡 deploy names via ensureDeployment | 10m | Standalone |
| F-158 | 🟡 replace CEO magic strings | 10m | Bundled with F-098 |
| F-159 | 🟡 O(1) hierarchy lookup | 5m | Part of F-150 |
| F-160 | 🟡 level cache by node id | 5m | Part of F-150 |
| F-161 | 🟡 functional hierarchy builder | 30m | Part of F-150 |
| F-162 | 🟡 split updateCompanySprint | 10m | Standalone |
| F-163 | 🟡 delete deprecated re-exports | 15m | Bundled with F-144 |
| F-164 | 🟡 Zod at store boundary | 1h | Bundled with F-151 |
| F-165 | 🟡 structured entity-changed events | 1-2h | Bundled with F-144 |
| F-166 | 🟡 batch primitive | 1h | Bundled with F-144 |
| F-167 | 🟡 remove node.agentId! | 0 | Bundled with F-161 |
| F-168 | 🟡 commit on snapshot schema | 30m | Standalone |
| F-169 | 🟡 flush short-circuit | 2m | Standalone |
| F-170 | 🟡 createStrategyProposedEvent helper | 15m | Part of F-150 |
| F-171 | 🟢 Map for memory updates | 30m | Defer |
| F-172 | 🟢 functional array update style | 0 | Bundled with F-152 |
| **F-173** | 🔴 collapse schema.ts drift | 1.5h | Phase A immediate; Phase B with F-174 |
| **F-174** | 🔴 F-002 Stage B — extract domain tables | 1-2 weeks | Strategic; after F-002 Stage A proves helpful |
| F-175 | 🟠 foreign keys across tables | 1h per constraint | Blocked by F-174 |
| F-176 | 🟠 unique constraints on logical keys | 2-3h | Dedupe check first |
| F-177 | 🟠 delete `indexes` field | 0 | Bundled with F-173 |
| F-178 | 🟠 `_migrations` tracking + generic runner | 2-3h | Standalone |
| F-179 | 🟠 delete per-migration runners | 15m | Bundled with F-178 |
| F-180 | 🟠 mandatory CONCURRENTLY on index adds | 1h | Bundled with F-178 |
| F-181 | 🟠 raise pool cap + env var | 20m | Standalone |
| F-182 | 🟠 reconcile text vs uuid | 30m-1h | Standalone |
| F-183 | 🟡 delete DatabaseAdapter + NoopDatabaseAdapter | 15m | Standalone |
| F-184 | 🟡 `defineTable` pattern in tables.ts | 1h | Standalone |
| F-185 | 🟡 deprecate env-var aliases | 20m | Standalone |
| F-186 | 🟡 CHECK constraints on status/severity | 2h | Dedupe-check first |
| F-187 | 🟡 `load-env` find-up from cwd | 15m | Standalone |
| F-188 | 🟡 migration numbering convention + CI guard | 15m | Standalone |
| F-189 | 🟡 delete `indexes` claims | 0 | Bundled with F-177 |
| F-190 | 🟡 `updated_at` triggers everywhere | 30m | Standalone |
| F-191 | 🟡 RLS migration | 1-2d | Deferred until multi-tenant |
| F-192 | 🟡 drizzle-kit check in CI | 15m | Standalone |
| F-193 | 🟡 move ad-hoc scripts out of migrations | 5m | Standalone |
| F-194 | 🟡 eager DB init in startServer | 5m | Standalone |
| F-195 | 🟡 unified shutdown budget | 30m | Bundled with F-039 |
| F-196 | 🟡 backup/restore runbook | 1h + drill | Standalone |
| F-197 | 🟡 implement or drop `previous_version_id` | 15m + follow-up | Investigate first |
| F-198 | 🟢 bundled with F-183 | 0 | — |
| F-199 | 🟢 bundled with F-116 | 0 | — |
| F-200 | 🟢 delete deprecated exports | 30m | Standalone |
| F-201 | 🟢 migration header template + hook | 15m | Standalone |
| F-202 | 🟢 adopt drizzle-zod | 1-2h | Standalone |
| **F-203** | 🔴 expireStale releases semaphore too | 1h | First; fixes scheduler dead-lock |
| **F-204** | 🔴 capture beatNumber at assignment | 20m | Immediate |
| F-205 | 🟠 AbortSignal through dep calls | 2h | Bundled with F-119 + F-132 |
| F-206 | 🟠 audit commitBeatRecord failure | 10m | Bundled with F-112 |
| F-207 | 🟠 extract phase methods | 4-6h | Foundational for most other fixes |
| F-208 | 🟠 per-deployment cost rates | 1h | Bundled with F-118 |
| F-209 | 🟠 pre-emptive budget checks | 1-2h | Requires BudgetHandle |
| F-210 | 🟠 errorDetail on BeatRecord | 30m | Bundled with F-011 |
| F-211 | 🟠 engine-level retry | 30m | Bundled with F-125 + F-137 |
| F-212 | 🟠 stranded-beat recovery sweeper | 2-3h | Standalone (Paperclip parity) |
| F-213 | 🟠 overdueness-based scheduling | 30m | Standalone |
| F-214 | 🟠 surface mutation errors in record | 30m | Bundled with F-088 |
| F-215 | 🟠 atomic task checkout mutation | 2-3h | Bundled with F-086 / F-088 |
| F-216 | 🟠 bundled with F-215 | 0 | — |
| F-217 | 🟠 safe emitBeatEvent wrapper | 15m | Standalone |
| F-218 | 🟡 UUID beatId | 2m | Standalone |
| F-219 | 🟡 drain-all event queue | 20m | Standalone |
| F-220 | 🟡 bounded event queue | 10m | Bundled with F-219 |
| F-221 | 🟡 history = UI cache only | 15m | Standalone |
| F-222 | 🟡 selectTask respects blockedByIds | 15m | Standalone |
| F-223 | 🟡 leadership roles from enum | 5m | Bundled with F-098 |
| F-224 | 🟡 Zod on patchConfig | 20m | Standalone |
| F-225 | 🟡 expanded getStatus | 30m | After F-212 + F-219 |
| F-226 | 🟡 rich ExecuteTaskResult shape | 1h | Standalone |
| F-227 | 🟡 unify executeChecklistAction | 0 | Bundled with F-226 |
| F-228 | 🟡 BeatContext, hide staged mutations | 1h | Bundled with F-207 |
| F-229 | 🟡 narrow stageMutation type | 0 | Bundled with F-090 |
| F-230 | 🟡 audit dropped mutations | 10m | Standalone |
| F-231 | 🟡 pre-check pause conditions | 20m | Standalone |
| F-232 | 🟡 session persistence | 2-3h | After F-174 |
| F-233 | 🟡 process-group tracking | 1h | Bundled with F-066 |
| F-234 | 🟢 remove orchestrator dead branch | 10m | Standalone |
| F-235 | 🟢 Readonly BeatRecord returns | 2m | Standalone |
| F-236 | 🟢 typed BeatEvent union | 30m | Bundled with F-032 |
| F-237 | 🟢 structured logger injected | 30m | Bundled with F-037 |

---

## F-238 · Treat missing dependency as unresolved (not resolved)

**Root cause:** Lookup miss silently interpreted as "dep satisfied."

```ts
const depTask = ctx.tasks.find((t) => t.id === depId);
if (!depTask) {
  await ctx.audit.emit("dependency_missing", { depId, taskId: task.id, severity: "warn" });
  return { resolved: false, reason: `Dependency ${depId} not found — blocking` };
}
return { resolved: depTask.status === "completed", reason: `Dep ${depId} status=${depTask.status}` };
```

**Verification:** unit test asserting a dangling dep id blocks dispatch + emits audit.  
**Effort:** 15m.

---

## F-239 · Schema-typed `reviewState` on SprintSchema

**Root cause:** runtime field absent from contracts; accessed via `as any`.

```ts
// packages/contracts/src/domain.ts
export const SprintReviewStateSchema = z.enum(["waiting_tester", "cto_escalated", "rework", "final_gate", "idle"]);
// extend SprintSchema with .extend({ reviewState: SprintReviewStateSchema.optional() })
```

**Verification:** delete `as any` casts at :236/:267/:327; tsc passes.  
**Effort:** 30m. **Bundled with F-099.**

---

## F-240 · CheckOutcome carries reason + confidence

**Root cause:** boolean `resolved` conflates "confirmed" with "assumed."

```ts
interface CheckOutcome { resolved: boolean; reason: string; confidence: "high" | "medium" | "low"; action?: SuggestedAction; }
```

**Verification:** `runChecklist` logs the full `CheckOutcome[]` trail.  
**Effort:** 1h.

---

## F-241 · Strictly CAS-driven bug-fix dispatch

**Root cause:** defensive "don't wedge" branch masks missing transactional lock.

Replace `if (!task) return true` with an atomic `takeBugFixTask(companyId, sprintId)` that does `UPDATE tasks SET status='in_progress' WHERE status='bug' AND version=?` and returns the row — no row = nothing to fix.

**Verification:** run two concurrent bug-fix beats → exactly one picks up the task.  
**Effort:** 2-3h. **Bundled with F-086 / F-215.**

---

## F-242 · ChecklistConfig + Clock injection

**Root cause:** magic timeout constants in module scope.

```ts
interface ChecklistConfig { escalationTimeoutMs: number; stuckAfterFixTimeoutMs: number; }
export function runChecklist(ctx: AgentBeatContext, cfg: ChecklistConfig, clock: Clock) { /* ... */ }
```

**Verification:** fake clock tests for escalation boundary cases.  
**Effort:** 45m.

---

## F-243 · Per-role check registration

```ts
// checklist/registry.ts
const registry = new Map<AgentRole, CheckFn[]>();
export function registerCheck(role: AgentRole, fn: CheckFn) { /* ... */ }
// each check-module calls registerCheck at import time
```

**Verification:** adding a role without checks throws on boot.  
**Effort:** 1h. **Bundled with F-226.**

---

## F-244 · Status predicate helpers + enum

```ts
import { TaskStatus } from "@arceus/contracts";
export const isCompleted = (t: Task) => t.status === TaskStatus.Completed;
export const isPending = (t: Task) => t.status === TaskStatus.Todo || t.status === TaskStatus.InReview;
```

Replace all literal status comparisons across checks.

**Verification:** grep `status === "` → 0 matches.  
**Effort:** 30m. **Bundled with F-155.**

---

## F-245 · Pre-index `ctx.tasks`

```ts
ctx.tasksByStatus = groupBy(ctx.tasks, (t) => t.status);
ctx.tasksByAssignee = groupBy(ctx.tasks, (t) => t.assignedRole);
```

**Verification:** bench shows constant-time check fanout.  
**Effort:** 30m.

---

## F-246 · Extend AgentBeatContextSchema with skill fields

```ts
export const AgentBeatContextSchema = z.object({
  // ... existing
  skillHealth: z.array(SkillHealthSchema).optional(),
  unusedSkills: z.array(SkillSchema).optional(),
  sprintSkillGapCount: z.number().optional(),
});
```

**Verification:** Zod parse on context construction.  
**Effort:** 20m.

---

## F-247 · Thread AbortSignal through CheckFn

```ts
type CheckFn = (ctx: AgentBeatContext, signal: AbortSignal) => Promise<CheckOutcome>;
```

Each check awaits its I/O with the signal; engine aborts on shutdown.

**Verification:** SIGTERM test — checklist resolves to cancelled within 500ms.  
**Effort:** 1h. **Bundled with F-066/F-039.**

---

## F-248 · Audit full ChecklistResult trail

```ts
const outcomes: CheckOutcome[] = [];
for (const check of checks) outcomes.push(await check(ctx, signal));
await ctx.audit.emit("checklist_evaluated", { outcomes, selected: outcomes.find(o => !o.resolved) ?? null });
```

**Verification:** audit ledger has one event per beat with all check outcomes.  
**Effort:** 20m.

---

## F-249 · Discriminated SuggestedAction

```ts
export type SuggestedAction =
  | { kind: "sprint_review.cto_escalation_review" }
  | { kind: "sprint_review.cto_escalation_force_complete"; reason: string }
  | { kind: "meeting_contribution"; meetingId: string }
  | { kind: "skills_lead.mutate_underperformer" }
  | { kind: "skills_lead.deprecate_unused" }
  | { kind: "skills_lead.fill_skill_gap" }
  | { kind: "generic"; label: string; detail: string };
```

Parse once in check; dispatch by `kind` downstream.

**Verification:** tsc catches unknown kinds at dispatch site.  
**Effort:** 2h (touches checklist + executor).

---

## F-250 · Budget threshold from `budget_policies`

```ts
const policy = await ctx.deps.loadBudgetPolicy(ctx.companyId);
const threshold = policy.unhealthyRatio ?? 0.9;
```

**Verification:** integration test with varied policies.  
**Effort:** 30m.

---

## F-251 · (bundled)

Meeting-contribution action normalized by F-249 discriminated union.  
**Effort:** 0. **Bundled with F-249.**

---

## F-252 · Split long check functions

Extract pure helpers: `findOverdueReviews(tasks, clock)`, `constructEscalationAction(overdue)`, `isStuckAfterFix(task, clock, timeout)`.

**Verification:** each helper unit-testable without a full context.  
**Effort:** 1h.

---

## F-253 · `ctx.activeTaskFor(role)` helper

```ts
ctx.activeTaskFor = (role) => ctx.tasksByAssignee.get(role)?.find((t) => t.status === "in_progress");
```

**Verification:** 5 duplicated call sites collapse to one.  
**Effort:** 15m.

---

## F-254 · Default arms on scope/roadmap

```ts
const scope = ctx.scope ?? { inScope: [], outOfScope: [] };
const roadmap = ctx.roadmap ?? { horizons: [] };
```

**Effort:** 10m.

---

## F-255 · Honor or delete `GOVERNANCE_ENABLED`

**Root cause:** hardcoded `false` disables the governance pre-filter entirely.

```ts
// apps/api/src/heartbeats/beat-executor.ts
import { isGovernanceEnabled } from "../governance/policy.js";
// remove constant; read from config
if (await isGovernanceEnabled(ctx.companyId)) {
  const governedTools = await filterByPolicy(roleTools, ctx);
  attachToolsToPrompt(governedTools, session);
}
```

**Verification:** end-to-end test: a denied tool invocation blocks prompt execution.  
**Effort:** 2-3h. **Bundled with F-089.**

---

## F-256 · Transactional trust delta inside applyMutations

```ts
stageMutation({ type: "trust_event", event: noChangeEvent });
// trust row updated inside the same tx that flips task status
await deps.applyMutations(mutations);
```

**Verification:** DB assertion — trust row and task row updated atomically.  
**Effort:** 1h. **Bundled with F-104 + F-086.**

---

## F-257 · Narrow `roleTools` typing

Replace `(roleTools as any)[k]` with `keyof ToolPolicy` indexing; add Zod parse on roleTools load.

**Effort:** 30m. **Bundled with F-255.**

---

## F-258 · Atomic task claim CAS

```sql
UPDATE tasks SET status = 'in_progress', version = version + 1, claimed_by = $1
  WHERE id = $2 AND status = 'todo' AND version = $3 RETURNING *;
```

If no row returned → another beat claimed it; abort.

**Verification:** two beats racing for the same task → only one proceeds.  
**Effort:** 2h. **Bundled with F-086.**

---

## F-259 · Replace classifier with catalog injection

Delete `matchAndRecordSkills(role, ...)`; build `SkillCatalog[]` at beat start; inject ids + one-line descriptions into system prompt; agent references ids in output; `recordSkillUsage` reads them from the structured response.

**Verification:** classifier call count in logs → 0; skill usage still recorded.  
**Effort:** 3-4h. **Bundled with F-015.**

---

## F-260 · `swallowAndAudit` helper

```ts
async function swallowAndAudit<T>(kind: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (err) {
    await audit(kind, { error: serializeError(err) });
    return null;
  }
}
// usage: await swallowAndAudit("trust_update_failed", () => cpUpdateTrustScore(evt));
```

**Effort:** 30m (helper) + 15m per call site replacement. **Bundled with F-068.**

---

## F-261 · Single final mutation for session state

Use local `nextSessionId` variable throughout; commit once via `stageMutation({ type: "agent_session_update", sessionId: nextSessionId })` at finally.

**Effort:** 30m.

---

## F-262 · AbortSignal all the way down

`executeBeatTask(ctx, taskId, beatId, signal)` → propagate to `runPromptText(..., { signal })`, `executeSpecialistTask(..., { signal })`, `triggerCeoSprintProposal({ signal })`.

**Verification:** SIGTERM test — all in-flight work aborts within 1s.  
**Effort:** 2h. **Bundled with F-066/F-039.**

---

## F-263 · Extract WorkspaceOrchestrator

Executor emits `WorkspaceIntent` events (`scaffold`, `snapshot`, `preview`); a separate `WorkspaceOrchestrator` subscribes and acts. Executor no longer imports `fs`, `preview`, or `workspace/*`.

**Effort:** 4-6h (refactor).

---

## F-264 · `isSpecialistRole` / `isLeadershipRole` predicates

```ts
const SPECIALIST_ROLES: ReadonlySet<AgentRole> = new Set(["tester", "ui_designer", "marketing", "skills_lead"]);
export const isSpecialistRole = (r: AgentRole) => SPECIALIST_ROLES.has(r);
```

**Effort:** 15m. **Bundled with F-098/F-223.**

---

## F-265 · ARCEUS_STALE_THRESHOLD_MS config

```ts
const STALE_THRESHOLD_MS = config.staleThresholdMs ?? 10 * 60 * 1000;
```

**Effort:** 10m. **Bundled with F-242.**

---

## F-266 · Content-hash based change detection

```ts
const preHashes = await hashTree(workspacePath);
// ... run work
const postHashes = await hashTree(workspacePath);
const changed = diffHashes(preHashes, postHashes);
```

Or alternatively: `git status --porcelain` for workspaces with git.

**Verification:** sub-second edits detected on HFS+.  
**Effort:** 2h.

---

## F-267 · workspace-config.meaningfulExtensions

```ts
// packages/workspace/config.ts
export const workspaceConfig = {
  meaningfulExtensions: new Set([".ts", ".tsx", ".js", ".css", ".md"]),
};
```

**Effort:** 15m.

---

## F-268 · `truncateTelemetry` helper

```ts
export function truncateTelemetry(s: string, opts: { chars: number; preserveLines?: boolean } = { chars: 500 }): string {
  if (s.length <= opts.chars) return s;
  const sliced = s.slice(0, opts.chars);
  return opts.preserveLines ? sliced.slice(0, sliced.lastIndexOf("\n")) + "…" : sliced + "…";
}
```

**Effort:** 30m incl. call-site sweep. **Bundled with F-094.**

---

## F-269 · `createToolGovernanceApproval` factory

```ts
export function createToolGovernanceApproval(input: { agentId: string; tool: string; beatId: string; severity: Severity; detail: string }): Approval {
  return ApprovalSchema.parse({ kind: "tool_governance", createdAt: nowIso(), status: "pending", ...input });
}
```

**Effort:** 20m. **Bundled with F-142.**

---

## F-270 · Per-agent lock in the engine

Move CEO-streaming mutex out of a global and into `BeatLockManager` keyed by agent id. Engine rejects concurrent chat+beat with `409`.

**Effort:** 1h. **Bundled with F-051.**

---

## F-271 · Split executor by role

```
heartbeats/role-executors/
  developer-executor.ts
  ceo-executor.ts
  specialist-executor.ts
  index.ts  // dispatch by role
```

**Effort:** 4h (refactor).

---

## F-272 · Structured activity factories

```ts
export const beatActivity = {
  started: (role: AgentRole, meta: BeatStartedMeta) => emitEmployeeActivity(role, "working", ..., meta),
  workFinished: (role: AgentRole, meta: BeatFinishedMeta) => emitEmployeeActivity(role, "transition", ..., meta),
};
```

**Effort:** 1-2h. **Bundled with F-032.**

---

## F-273 · Set bridge-started flag in success path only

```ts
export async function startEventBridge() {
  try {
    const opencode = await getOpencode();
    const response = await fetch(`${opencode.server.url}/event`);
    if (!response.ok || !response.body) return;
    setEventBridgeStarted(true); // <-- only after success
    // ... read loop
  } catch { /* ... */ }
}
```

**Effort:** 5m.

---

## F-274 · Lazy-singleton event bridge

```ts
let bridgePromise: Promise<void> | null = null;
export function ensureEventBridge(): Promise<void> {
  if (bridgePromise) return bridgePromise;
  bridgePromise = startEventBridge().catch((err) => { bridgePromise = null; throw err; });
  return bridgePromise;
}
```

Callers `await ensureEventBridge()` instead of fire-and-forget.

**Effort:** 30m. **Bundled with F-273.**

---

## F-275 · Exact-match CEO dispatch

```ts
if (role === "ceo" && action.kind === "sprint.propose") { /* ... */ }
```

Depends on F-249 `SuggestedAction` union.  
**Effort:** 0. **Bundled with F-249.**

---

## F-276 · Parse-once SuggestedAction

Removal of `split(":")` at dispatch site is automatic once F-249 lands.  
**Effort:** 0. **Bundled with F-249.**

---

## F-277 · CAS on meeting version

```sql
UPDATE meetings SET contributions = contributions || $1::jsonb, version = version + 1
  WHERE id = $2 AND version = $3;
```

Retry with fresh version on miss (bounded).

**Effort:** 1h. **Bundled with F-086.**

---

## F-278 · Runtime guard on underperformers

```ts
const worst = underperformers[0];
if (!worst) return { summary: "no underperformer", ... };
```

**Effort:** 5m.

---

## F-279 · Track ATA pipelines in job queue

```ts
const job = await jobs.enqueue("ata_pipeline", { mutationId, companyId });
await ctx.audit.emit("ata_enqueued", { jobId: job.id, mutationId });
```

**Effort:** 2h. **Bundled with F-037.**

---

## F-280 · Early-return on missing Skills Lead

```ts
if (!skillsLeadAgent) {
  await audit("skills_lead_missing", { companyId, severity: "warn" });
  return noopResult("no Skills Lead agent");
}
```

**Effort:** 15m.

---

## F-281 · SkillsLeadPolicy config

```ts
interface SkillsLeadPolicy { underperformerThreshold: number; unusedDays: number; clusterMin: number; maxDeprecatePerBeat: number; maxGapFillPerBeat: number; }
```

Pass `policy` into `executeSkillsLeadAction`.

**Effort:** 30m. **Bundled with F-242.**

---

## F-282 · Real governance task row

```ts
const governanceTask = await createGovernanceTask({ kind: "skill_mutation", targetSkillId: worst.id, companyId });
await processTaskOutcome({ taskId: governanceTask.id, ... });
```

**Effort:** 1h.

---

## F-283 · Bump skill-deprecation audit severity

```ts
auditAgent(companyId, "skills_lead", "skill_deprecated", ..., { severity: "notice", detail: { ... } });
```

**Effort:** 2m. **Bundled with F-025.**

---

## F-284 · Static import of meetings/synthesis

```ts
import { generateContribution } from "../meetings/synthesis.js";
// at top of checklist-executor.ts
```

**Effort:** 2m.

---

## F-285 · `withBeatTokens` wrapper

```ts
async function withBeatTokens<T>(beatId: string, fn: () => Promise<T>): Promise<{ result: T; tokensUsed: number }> {
  startBeatTokenAccumulator(beatId);
  try { return { result: await fn(), tokensUsed: drainBeatTokenAccumulator(beatId) }; }
  finally { if (!isTokenAccumulatorDrained(beatId)) drainBeatTokenAccumulator(beatId); }
}
```

**Effort:** 1h incl. call-site sweep.

---

## F-286 · ChecklistActionHandler registry

```ts
const handlers = new Map<`${AgentRole}.${ActionKind}`, Handler>();
export function registerHandler(role: AgentRole, kind: ActionKind, h: Handler) { ... }
```

Dispatch via `handlers.get(`${role}.${action.kind}`)`.

**Effort:** 2h. **Bundled with F-249.**

---

## F-287 · Distinct `skipped` status for unhandled actions

```ts
await audit("unhandled_checklist_action", { role, action: action.kind, severity: "warn" });
return { summary: `${role}: ${action.kind} (no handler)`, status: "skipped", tokensUsed: ..., actionsCount: 0, toolCalls: 0 };
```

**Effort:** 20m.

---

## F-288 · Named constants

```ts
const MAX_DEPRECATE_PER_BEAT = 3;
const MAX_GAP_FILL_PER_BEAT = 2;
```

**Effort:** 5m. **Bundled with F-281.**

---

## F-289 · Audit unhandled processEvent rejections

```ts
processEvent(event).catch((err) => {
  emitEmployeeActivity("system", "error", `event_bridge_process_failed: ${serializeError(err).message}`);
});
```

**Effort:** 10m. **Bundled with F-068.**

---

## F-290 · Flag set inside success path + failure audit

```ts
setTimeout(() => {
  if (!eventBridgeStarted) {
    startEventBridge().catch((err) => emitEmployeeActivity("system", "error", `bridge_reconnect_failed: ${err.message}`));
  }
}, reconnectDelayMs());
```

Remove the `setEventBridgeStarted(true)` after the `.catch()` — F-273's change handles it.

**Effort:** 15m. **Bundled with F-273/F-274.**

---

## F-291 · Await policy-violation + trust writes

```ts
try {
  await cpRecordPolicyViolation({ ... });
  await cpUpdateTrustScore(trustEvent);
} catch (err) {
  emitEmployeeActivity("system", "error", `trust_update_failed: ${serializeError(err).message}`);
}
```

Or better: enqueue on an outbox (drains via durable worker).

**Effort:** 45m. **Bundled with F-086/F-104.**

---

## F-292 · Timeout on initial bridge connect

```ts
const response = await fetch(`${opencode.server.url}/event`, { signal: AbortSignal.timeout(5000) });
```

**Effort:** 5m. **Bundled with F-066.**

---

## F-293 · AbortSignal on SSE reader

```ts
const controller = new AbortController();
export function stopEventBridge() { controller.abort(); }
// pass signal to fetch; check signal.aborted in the while-loop
```

**Effort:** 30m.

---

## F-294 · Trust-score cache per (agentId, beatId)

```ts
const trustCache = new Map<string, { score: number; loadedAt: number }>();
async function getTrustScore(agentId: string) {
  const hit = trustCache.get(agentId);
  if (hit && Date.now() - hit.loadedAt < 5000) return hit.score;
  const fresh = await cpLoadTrustScore(agentId);
  trustCache.set(agentId, { score: fresh.score, loadedAt: Date.now() });
  return fresh.score;
}
```

Invalidate on trust-event write.

**Effort:** 1h. **Bundled with F-118.**

---

## F-295 · Debounce escalation-meeting creation

```ts
const recentEscalations = new Map<string, number>();
function shouldCreateEscalation(role: AgentRole, taskId: string): boolean {
  const key = `${role}:${taskId}`;
  const last = recentEscalations.get(key) ?? 0;
  if (Date.now() - last < 60_000) return false;
  recentEscalations.set(key, Date.now());
  return true;
}
```

**Effort:** 30m.

---

## F-296 · OpencodeEventSchema

```ts
export const OpencodeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.part.updated"), properties: z.object({ part: OpencodePartSchema, info: OpencodeInfoSchema }) }),
  z.object({ type: z.literal("session.idle"), properties: z.object({ info: OpencodeInfoSchema }) }),
  z.object({ type: z.literal("session.error"), properties: z.object({ info: OpencodeInfoSchema, error: OpencodeErrorSchema }) }),
]);
```

Parse on entry; reject malformed frames.

**Effort:** 2h. **Bundled with F-031.**

---

## F-297 · Canonical sessionID extractor

```ts
function extractSessionId(evt: OpencodeEvent): string | null {
  return evt.properties?.info?.sessionID ?? null;
}
```

Normalize in the Zod transform; remove the three-fallback chain.

**Effort:** 0 after F-296.

---

## F-298 · Tool capability table

```ts
const TOOL_CAPABILITIES: Record<string, "edit" | "shell" | "read" | "network"> = {
  edit: "edit", write: "edit", patch: "edit", apply_patch: "edit", str_replace: "edit",
  bash: "shell", read: "read", grep: "read", glob: "read", fetch: "network",
};
function capabilityOf(tool: string) { return TOOL_CAPABILITIES[tool] ?? "other"; }
```

**Effort:** 30m.

---

## F-299 · Hoist TextDecoder

```ts
const decoder = new TextDecoder();
// inside loop: buffer += decoder.decode(value, { stream: true });
```

**Effort:** 2m.

---

## F-300 · Parse-failure counter + warn

```ts
let parseFailures = 0;
try { ... } catch { parseFailures++; if (parseFailures % 100 === 0) console.warn(`[bridge] ${parseFailures} parse failures`); }
```

**Effort:** 10m. **Bundled with F-068.**

---

## F-301 · `SystemRole | AgentRole` union

```ts
export type TelemetryActor = AgentRole | "system" | "orchestrator";
export function emitEmployeeActivity(actor: TelemetryActor, ...) { ... }
```

**Effort:** 30m. **Bundled with F-098.**

---

## F-302 · Exponential backoff + jitter

```ts
function reconnectDelayMs(attempt: number) {
  const base = Math.min(16_000, 250 * 2 ** attempt);
  return base + Math.random() * base * 0.25; // ±25% jitter
}
```

Track attempt count; reset to 0 on successful connect.

**Effort:** 30m. **Bundled with F-070.**

---

## F-303 · (bundled)

Replace `slice(0, 180)` with `truncateTelemetry(cmd, { chars: 180 })`.  
**Effort:** 0. **Bundled with F-094/F-268.**

---

## F-304 · Execution-state machine

Move `setExecutionStatus` out of event handler; handler dispatches `ExecutionEvent.SessionError` → state machine reduces.

**Effort:** included in F-043 refactor.

---

## Running index (extended)

| ID | Title | Effort | Notes |
|----|-------|--------|-------|
| F-238 | 🔴 dangling dep blocks | 15m | Standalone |
| F-239 | 🟠 schema-typed reviewState | 30m | Bundled with F-099 |
| F-240 | 🟠 CheckOutcome reason/confidence | 1h | Standalone |
| F-241 | 🟠 CAS bug-fix dispatch | 2-3h | Bundled with F-086/F-215 |
| F-242 | 🟡 ChecklistConfig + Clock | 45m | Standalone |
| F-243 | 🟡 per-role check registry | 1h | Bundled with F-226 |
| F-244 | 🟡 status predicates + enum | 30m | Bundled with F-155 |
| F-245 | 🟡 pre-index ctx.tasks | 30m | Standalone |
| F-246 | 🟡 AgentBeatContextSchema skills | 20m | Standalone |
| F-247 | 🟡 AbortSignal on CheckFn | 1h | Bundled with F-066/F-039 |
| F-248 | 🟡 audit full ChecklistResult | 20m | Standalone |
| F-249 | 🟡 SuggestedAction union | 2h | Standalone |
| F-250 | 🟡 budget threshold from DB | 30m | Standalone |
| F-251 | 🟡 meeting-contrib via union | 0 | Bundled with F-249 |
| F-252 | 🟢 split long checks | 1h | Standalone |
| F-253 | 🟢 ctx.activeTaskFor helper | 15m | Standalone |
| F-254 | 🟢 scope/roadmap defaults | 10m | Standalone |
| F-255 | 🔴 honor GOVERNANCE_ENABLED | 2-3h | Bundled with F-089 |
| F-256 | 🔴 transactional trust delta | 1h | Bundled with F-104/F-086 |
| F-257 | 🔴 narrow roleTools typing | 30m | Bundled with F-255 |
| F-258 | 🟠 atomic task claim CAS | 2h | Bundled with F-086 |
| F-259 | 🟠 catalog injection replaces classifier | 3-4h | Bundled with F-015 |
| F-260 | 🟠 swallowAndAudit helper | 1h | Bundled with F-068 |
| F-261 | 🟠 single-final session mutation | 30m | Standalone |
| F-262 | 🟠 AbortSignal in executor | 2h | Bundled with F-066/F-039 |
| F-263 | 🟠 WorkspaceOrchestrator extract | 4-6h | Standalone |
| F-264 | 🟡 role predicates | 15m | Bundled with F-098/F-223 |
| F-265 | 🟡 stale threshold config | 10m | Bundled with F-242 |
| F-266 | 🟡 content-hash change detection | 2h | Standalone |
| F-267 | 🟡 workspace-config extensions | 15m | Standalone |
| F-268 | 🟡 truncateTelemetry helper | 30m | Bundled with F-094 |
| F-269 | 🟡 approval factory | 20m | Bundled with F-142 |
| F-270 | 🟡 per-agent lock | 1h | Bundled with F-051 |
| F-271 | 🟡 split executor by role | 4h | Standalone |
| F-272 | 🟢 structured activity factories | 1-2h | Bundled with F-032 |
| F-273 | 🟢 bridge flag on success | 5m | Standalone |
| F-274 | 🔴 lazy-singleton bridge | 30m | Bundled with F-273 |
| F-275 | 🟠 exact-match CEO dispatch | 0 | Bundled with F-249 |
| F-276 | 🟠 parse-once action | 0 | Bundled with F-249 |
| F-277 | 🟠 CAS on meeting version | 1h | Bundled with F-086 |
| F-278 | 🟠 runtime guard on underperformers | 5m | Standalone |
| F-279 | 🟠 track ATA in job queue | 2h | Bundled with F-037 |
| F-280 | 🟡 early-return missing skills_lead | 15m | Standalone |
| F-281 | 🟡 SkillsLeadPolicy | 30m | Bundled with F-242 |
| F-282 | 🟡 real governance task row | 1h | Standalone |
| F-283 | 🟡 bump deprecation severity | 2m | Bundled with F-025 |
| F-284 | 🟡 static import synthesis | 2m | Standalone |
| F-285 | 🟡 withBeatTokens wrapper | 1h | Standalone |
| F-286 | 🟡 handler registry | 2h | Bundled with F-249 |
| F-287 | 🟡 skipped status | 20m | Standalone |
| F-288 | 🟢 named constants | 5m | Bundled with F-281 |
| F-289 | 🔴 audit unhandled rejections | 10m | Bundled with F-068 |
| F-290 | 🔴 flag on success + fail audit | 15m | Bundled with F-273/F-274 |
| F-291 | 🔴 await trust writes | 45m | Bundled with F-086/F-104 |
| F-292 | 🟠 bridge connect timeout | 5m | Bundled with F-066 |
| F-293 | 🟠 reader AbortSignal | 30m | Standalone |
| F-294 | 🟠 trust-score cache | 1h | Bundled with F-118 |
| F-295 | 🟠 escalation debounce | 30m | Standalone |
| F-296 | 🟡 OpencodeEventSchema | 2h | Bundled with F-031 |
| F-297 | 🟡 canonical sessionID | 0 | Bundled with F-296 |
| F-298 | 🟡 tool capability table | 30m | Standalone |
| F-299 | 🟡 hoist TextDecoder | 2m | Standalone |
| F-300 | 🟡 parse-failure counter | 10m | Bundled with F-068 |
| F-301 | 🟡 TelemetryActor union | 30m | Bundled with F-098 |
| F-302 | 🟡 exponential backoff | 30m | Bundled with F-070 |
| F-303 | 🟢 truncate bash cmd | 0 | Bundled with F-094 |
| F-304 | 🟢 execution-state machine | 0 | Bundled with F-043 |

---

# Wave 2 — orchestration + agents + skills + sprints + meetings + tasks + prompts/obs + hippocampus + routes

## F-305 · Serialize cleanup past all awaits

**Root cause:** `setActiveExecution(null)` runs before `checkSprintCompletion`, `recordMeeting`, etc. settle.

```ts
// orchestration/execution-cycle.ts
const cleanup = async () => {
  await recordMeeting({...});
  await checkSprintCompletion();
};
try { await cleanup(); } finally { setActiveExecution(null); }
```

**Verification:** no more orphan activeExecution logs after crash.
**Effort:** 30m.

---

## F-306 · Re-snapshot at each async boundary

**Root cause:** single `getSnapshot()` captured at entry; mutations between awaits invalidate it.

Rule: never hold a snapshot across an `await`. Either re-read or promote the whole cycle to a DB transaction.

**Effort:** 1h. **Bundled with F-315.**

---

## F-307 · AbortSignal on cycle

Accept `signal: AbortSignal` in `completeExecutionCycle(ctx, signal)`; propagate to all awaited helpers; `stopExecution()` calls `controller.abort()`.
**Effort:** 45m. **Bundled with F-066/F-262.**

---

## F-308 · Transactional cleanup block

```ts
await applyMutations([
  { type: "set_task_status", ... },
  { type: "record_meeting", ... },
  { type: "set_active_execution", value: null },
]);
```
**Effort:** 1h. **Bundled with F-086.**

---

## F-309 · Named constants for bootstrap sentinels

```ts
const DEFAULT_BOARD_OWNER = "Board";
const BOOTSTRAP_BUDGET_CENTS = 999_999_999; // TODO: make configurable
```
**Effort:** 10m. **Bundled with F-017.**

---

## F-310 · Consistent boardDecision fallback

Extract one helper `formatBoardDecision(decision)` returning `decision.reason ?? "Board review required."` consistently.
**Effort:** 10m.

---

## F-311 · Reactive emit must audit on missing dep

```ts
export function emitReactive(event) {
  if (!emitter) { audit("reactive_dropped", { event, severity: "warn" }); return; }
  emitter.emit(event);
}
```
**Effort:** 15m. **Bundled with F-068.**

---

## F-312 · Role literals from enum

Replace `"ceo"`, `"cto"` strings with `AgentRole.CEO` / `AgentRole.CTO` imports.
**Effort:** 15m. **Bundled with F-098/F-264.**

---

## F-313 · `pluralize` helper

```ts
export const pluralize = (word: string, n: number) => `${word}${n === 1 ? "" : "s"}`;
```
**Effort:** 5m.

---

## F-314 · Exhaustive executionStatus check

Switch on the full `ExecutionStatus` enum; use `never` in default arm.
**Effort:** 10m. **Bundled with F-043.**

---

## F-315 · Re-snapshot after async mutations in chat

```ts
// agents/chat.ts
let snapshot = getSnapshot();
if (snapshot.company.id === "company_pending") {
  await bootstrapIdeaWithWorkspace(idea);
  snapshot = getSnapshot(); // re-read
}
// use fresh snapshot everywhere
```
**Effort:** 30m.

---

## F-316 · Audit emitBeatEvent failures

```ts
try {
  await emitBeatEvent({...});
} catch (err) {
  await audit("beat_event_emit_failed", { kind: "board_message", error: serializeError(err) });
}
```
**Effort:** 15m. **Bundled with F-260.**

---

## F-317 · Bounded SSE buffer

```ts
const MAX_BUFFER = 64 * 1024;
if (nextBuffer.length > MAX_BUFFER) throw new Error("SSE buffer overflow");
```
**Effort:** 10m.

---

## F-318 · Validate mandatory roles via Zod after injection

```ts
const finalStrategy = strategyOutputSchema.parse(enforceMandatoryRoles(draft));
```
Drop `as any` casts at `:85-86`.
**Effort:** 30m. **Bundled with F-031.**

---

## F-319 · Await recordCeoCardMeeting

```ts
await recordCeoCardMeeting(card, trimmedMessage, fullText);
const nextSnapshot = getSnapshot();
```
**Effort:** 5m.

---

## F-320 · Drop hardcoded `meeting.create = false` in fallback

Fallback card should carry the original `meeting.create` signal from board intent. If unknown, mark `meeting.create = null` and surface it for reconciliation.
**Effort:** 20m.

---

## F-321 · Wrap retry `structuredCompletion` in try/catch

```ts
try {
  const retry = await structuredCompletion(...);
  return retry;
} catch (retryErr) {
  await audit("ceo_retry_failed", { err: serializeError(retryErr) });
  return fallbackCard();
}
```
**Effort:** 15m.

---

## F-322 · Split ceo.ts by concern

```
agents/
├── ceo/
│   ├── schema.ts        (zod types)
│   ├── summarize.ts     (snapshot→context summarization)
│   ├── classify.ts      (card classification)
│   ├── strategy.ts      (generateStrategy)
│   ├── fallback.ts      (fallback cards)
│   └── index.ts         (exports)
```
**Effort:** 4h.

---

## F-323 · Structured logger

```ts
import { logger } from "../observability/logger.js";
logger.warn({ role, beatId }, "CEO retry triggered");
```
**Effort:** 10m per site. **Bundled with F-037.**

---

## F-324 · Named summary caps

```ts
const SUMMARY_CAPS = { recentChat: 8, recentSprints: 4, recentTasks: 5, contentPreview: 280, feedbackPreview: 150, strategyPreview: 400 } as const;
```
**Effort:** 15m. **Bundled with F-017.**

---

## F-325 · Truncate with marker

```ts
const trunc = truncateTelemetry(m.content, { chars: 150 });
```
**Effort:** 5m. **Bundled with F-094/F-268.**

---

## F-326 · Single-pass reduce

```ts
const { recent, inProgress, blocked } = snapshot.tasks.reduce((acc, t) => {
  if (isRecent(t)) acc.recent.push(t);
  if (t.status === "in_progress") acc.inProgress.push(t);
  if (t.status === "blocked") acc.blocked.push(t);
  return acc;
}, { recent: [], inProgress: [], blocked: [] });
```
**Effort:** 30m.

---

## F-327 · sessionId → role reverse index

```ts
const roleBySession = new Map<string, AgentRole>();
function setSession(role: AgentRole, sessionId: string) {
  roleBySession.set(sessionId, role);
  sessions.set(role, { sessionId, ... });
}
```
**Effort:** 20m.

---

## F-328 · Immutable session update

```ts
sessions.set(role, { ...existing, ...patch });
// NOT Object.assign(existing, patch)
```
**Effort:** 10m.

---

## F-329 · Inline queuedFollowUpCount

Derive in place in the template literal, no intermediate const.
**Effort:** 5m.

---

## F-330 · AST-level skill lint

Replace regex lint with a real shell parser (`shell-quote` or `bash-parser`). Require an allow-list of commands on approved skills. Reject any skill using `$(`, backticks, `eval`, `exec`, or shell redirection unless explicitly allowed.

```ts
import { parse } from "shell-quote";
function lintSkillContent(content: string) {
  const tokens = parse(content);
  const found = tokens.filter(t => typeof t === "object" && t.op);
  if (found.length > 0) return { findings: [...] };
}
```
**Effort:** 4-6h. **Bundled with F-087.**

---

## F-331 · DLQ for ATA pipelines

```ts
await jobs.enqueue("ata_pipeline", { mutationId, proposer, companyId, attempt: 0 });
// worker drains, retries with backoff, DLQs after N failures
```
**Effort:** 3h. **Bundled with F-037/F-279.**

---

## F-332 · CAS on mutation status transition

```sql
UPDATE mutations SET status = $new, version = version + 1
  WHERE id = $id AND status = $expected AND version = $version;
```
Zero rows affected → reject with 409.
**Effort:** 1h. **Bundled with F-086.**

---

## F-333 · Typed noop for null skill lookups

```ts
function lookupSkill(id: string): Skill | null {
  return getSkillById(id) ?? null;
}
// caller: const skill = lookupSkill(id); if (!skill) return noop();
```
Remove `deps!` and `!` assertions.
**Effort:** 30m.

---

## F-334 · (removed) — Classifier deletion

Classifier is obsoleted by catalog injection (F-259). Remove `matchAndRecordSkills`, delete classifier.ts entirely.
**Effort:** 0. **Bundled with F-015/F-259.**

---

## F-335 · Transaction around skill-tester revision loop

```ts
await db.transaction(async (tx) => {
  await tx.update(mutations).set({ status: "testing", ... });
  // all revision writes in same tx
});
```
**Effort:** 1h. **Bundled with F-086.**

---

## F-336 · Index on `skills.companyId`

```sql
CREATE INDEX CONCURRENTLY idx_skills_company_id ON skills(company_id);
```
**Effort:** 5m + migration.

---

## F-337 · Lazy active-index rebuild

Rebuild on query, not on every register. Cache invalidation on writes.
```ts
let activeIndexDirty = true;
function getActiveIndex() {
  if (activeIndexDirty) { rebuild(); activeIndexDirty = false; }
  return activeIndex;
}
```
**Effort:** 30m.

---

## F-338 · Enforce per-mutation budget ceiling

```ts
if (estimatedCostCents > policy.perMutationCapCents) {
  return { allowed: false, code: "budget_exceeded", reason: "..." };
}
```
**Effort:** 15m.

---

## F-339 · `daysToMs` helper

```ts
export const daysToMs = (n: number) => n * 24 * 60 * 60 * 1000;
```
**Effort:** 2m.

---

## F-340 · (bundled)

Remove magic caps after classifier deletion (F-259). **Effort:** 0.

---

## F-341 · Delete deprecated exports

```bash
grep -r 'buildSkillMenu\|getSkillBody\|runPatternPromotionSweep' apps/ packages/
# if zero callers → delete
```
**Effort:** 15m.

---

## F-342 · Split evolution.ts by pipeline phase

```
skills/evolution/
├── attribution.ts    (analyzeFailure)
├── mutation.ts       (proposeSkillMutation, proposeSkillDiscovery)
├── testing.ts        (generateTestScenarios, executeDryRun)
├── review.ts         (reviewResults, reviseSkill)
├── synthesis.ts      (synthesizeSkill)
└── index.ts
```
**Effort:** 4h.

---

## F-343 · Route skills logs through logger

**Effort:** 30m. **Bundled with F-037/F-323.**

---

## F-344 · Validate verdict

```ts
const verdict = VerdictSchema.parse(lastResult.verdict);
```
**Effort:** 5m. **Bundled with F-031.**

---

## F-345 · Persist reviewState phase BEFORE probe

```ts
await updateSprint(sprintId, s => ({ ...s, reviewState: { ...s.reviewState, phase: "probing" } }));
const probe = await previewProbe();
if (!probe.reachable) { /* still persisted "probing" */ return; }
```
**Effort:** 30m. **Bundled with F-086.**

---

## F-346 · Single `updateSprint` path via CAS

Collapse the two write sites into one transactional update with version check.
**Effort:** 45m. **Bundled with F-086.**

---

## F-347 · Surface tagSprint failure

```ts
try {
  await workspaceManager.tagSprint(sprintId);
} catch (err) {
  await setSprintStatus(sprintId, "tag_failed", { error: serializeError(err) });
  throw err; // let lifecycle handler retry
}
```
**Effort:** 30m. **Bundled with F-068.**

---

## F-348 · AbortSignal on verification LLM + CEO proposal

```ts
await runPromptText(role, sessionId, system, user, { signal });
await structuredCompletion(dep, msgs, schema, tag, { signal });
```
**Effort:** 1h. **Bundled with F-066/F-262.**

---

## F-349 · QA-parse failure classified as defect

```ts
try {
  qaReport = parseQAReport(output);
} catch (parseErr) {
  qaReport = { verdict: "fail", defects: ["QA_REPORT_PARSE_FAILED"], raw: output };
  await audit("qa_parse_failed", { taskId, sprintId });
}
```
Don't treat parse failure as tool failure.
**Effort:** 20m.

---

## F-350 · Wrap sprint approval in transaction

```ts
await db.transaction(async (tx) => {
  await tx.insert(sprints).values(sprint);
  for (const task of tasks) await tx.insert(taskTable).values(task);
  await tx.update(companies).set({ currentSprintId: sprint.id });
});
```
**Effort:** 2h. **Bundled with F-086/F-174.**

---

## F-351 · Content-hash dedup on proposal

Hash the proposed card; if recent proposal has the same hash → skip; else proceed.
```ts
const cardHash = sha256(JSON.stringify(card));
if (recentProposals.has(cardHash)) return { skipped: "duplicate" };
```
**Effort:** 30m.

---

## F-352 · Extract review phases

```ts
async function runProbePhase(ctx) { ... }
async function runQAPromptPhase(ctx) { ... }
async function runBugRoutingPhase(ctx) { ... }
async function runGraphEmitPhase(ctx) { ... }
export async function executeSprintReviewVerification(ctx) {
  const probe = await runProbePhase(ctx);
  if (!probe.ok) return probe;
  // ...
}
```
**Effort:** 4h.

---

## F-353 · Extract sprint-approval phases

Same pattern as F-352 — phase-per-function.
**Effort:** 3h.

---

## F-354 · SprintReviewPhase enum

```ts
export enum SprintReviewPhase { Waiting = "waiting_tester", Rework = "rework", CtoEscalated = "cto_escalated", FinalGate = "final_gate", Idle = "idle" }
```
**Effort:** 30m. **Bundled with F-099/F-239.**

---

## F-355 · Truncate stderr with marker

**Effort:** 2m. **Bundled with F-094/F-268.**

---

## F-356 · ReviewState interface

```ts
interface ReviewState {
  phase: SprintReviewPhase;
  gateResults: GateResult[];
  bugTaskIds: string[];
  completedAt: string | null;
}
```
Drop every `as Record<string, unknown[]>` cast.
**Effort:** 45m. **Bundled with F-099/F-239.**

---

## F-357 · Config constants

```ts
export const REVIEW_CONFIG = { maxCycles: 3, errorExcerptChars: 200, gateOutputChars: 4096 } as const;
```
**Effort:** 15m. **Bundled with F-242.**

---

## F-358 · Delete dead else

```ts
if (config.autoSkipOnNoPackageJson && !hasPackageJson) return result;
// plain continue-through is the default
```
**Effort:** 2m.

---

## F-359 · CAS on meeting pipeline transition

```sql
UPDATE meetings SET status = $new, version = version + 1
  WHERE id = $id AND version = $version;
```
**Effort:** 45m. **Bundled with F-086/F-277.**

---

## F-360 · Scheduler pipeline in job queue

Replace `deps.runPipeline()` fire-and-forget with enqueue onto a tracked job queue.
**Effort:** 2h. **Bundled with F-279.**

---

## F-361 · Atomic upsert + schedule update

```ts
await db.transaction(async (tx) => {
  await tx.insert(meetings).onConflictDoUpdate(...);
  await tx.update(schedules).set({ ...patch, version: sql`version + 1` }).where(eq(schedules.id, id));
});
```
**Effort:** 1h. **Bundled with F-086.**

---

## F-362 · CAS on counters

```sql
UPDATE schedules SET skip_count = skip_count + 1, version = version + 1
  WHERE id = $id AND version = $version;
```
**Effort:** 20m. **Bundled with F-086.**

---

## F-363 · try/catch around meeting LLM calls

```ts
try {
  return await structuredCompletion(...);
} catch (err) {
  await audit("meeting_llm_failed", { kind, err: serializeError(err) });
  return fallbackMeetingResult();
}
```
**Effort:** 30m across 4 sites.

---

## F-364 · Uniqueness constraint on daily-sync

```sql
CREATE UNIQUE INDEX idx_daily_sync_unique ON meetings(company_id, type, date_trunc('day', created_at))
  WHERE type = 'daily_sync';
```
App-level `hasDailySync` becomes advisory; DB is truth.
**Effort:** 30m. **Bundled with F-086.**

---

## F-365 · Zod-parse LLM resolution output

```ts
const parsed = ResolutionOutputSchema.parse(output);
// all assignments typed, no casts
```
**Effort:** 30m. **Bundled with F-031.**

---

## F-366 · await executeMeetingDecisions

```ts
await executeMeetingDecisions(meeting, decisions);
await transitionToNextPhase();
```
**Effort:** 5m.

---

## F-367 · await applyMeetingEffects

Similar. Drop fire-and-forget.
**Effort:** 5m. **Bundled with F-366.**

---

## F-368 · MeetingType enum

```ts
export enum MeetingType { Escalation = "escalation", EvalTriggered = "eval_triggered", DailySync = "daily_sync", SpecialistCompletion = "specialist_completion" }
```
**Effort:** 20m. **Bundled with F-098.**

---

## F-369 · Manager role resolver as pluggable dep

```ts
interface ManagerResolver { getManagerRole(role: AgentRole): AgentRole | null; }
// inject; allow override per-company
```
**Effort:** 30m.

---

## F-370 · Split meeting-scheduler

```
meeting-scheduler/
├── tick.ts
├── assess.ts
├── escalation.ts
├── daily-sync.ts
├── manager-chain.ts
└── index.ts
```
**Effort:** 3h.

---

## F-371 · Rename / invert conditionalCheckEnabled

Rename to `skipWhenNoBlockers` (semantics match name). Default false.
**Effort:** 15m.

---

## F-372 · Named constants

```ts
const MEMORY_BRIEF_MAX_CHARS = 80;
const AGENDA_ITEM_MAX_CHARS = 100;
const CONFIDENCE_SHARED_DECISION = 0.8;
const MEMORY_EXPIRY_DAYS = 30;
```
**Effort:** 10m. **Bundled with F-242.**

---

## F-373 · Validate participantAgentIds against roster

```ts
const validIds = new Set(snapshot.agents.map(a => a.id));
const participants = requested.filter(id => validIds.has(id));
if (participants.length < requested.length) await audit("meeting_stale_participants", {...});
```
**Effort:** 15m.

---

## F-374 · Idempotent artifact propagation

```ts
await updateTask(childId, t => ({
  ...t,
  incomingArtifactIds: uniqueStrings([...t.incomingArtifactIds, artifactId]),
}));
```
Plus CAS on parent task status → guaranteed single completion.
**Effort:** 30m. **Bundled with F-086.**

---

## F-375 · Outbox for hippocampus + pattern learner

Instead of `hippocampus.processTaskCompletion(...).catch(logger.warn)`, write an outbox row atomically with the task status change; drain via durable worker.
**Effort:** 3h. **Bundled with F-331/F-279.**

---

## F-376 · setTaskStatus event emission

Instead of inline side effects, emit `TaskStatusChanged` events:
```ts
await setTaskStatus(id, status);
// downstream subscribers (graph, hippocampus, skills, escalation) handle their own concern
```
**Effort:** 6h. Architectural refactor. **Bundled with F-043.**

---

## F-377 · AbortSignal on cross-sprint transfer

**Effort:** 15m. **Bundled with F-262.**

---

## F-378 · Null guard on promotion lookup

```ts
const child = snapshot.tasks.find(t => t.id === childId);
if (!child) { await audit("promotion_dangling_child", { childId }); continue; }
```
**Effort:** 5m.

---

## F-379 · Runtime guard on activeAgents access

```ts
const primary = activeAgents[0];
if (!primary) return { summary: "no active agents", ... };
```
**Effort:** 2m. **Bundled with F-278.**

---

## F-380 · Defensive null-checks in specialist executor

All `find()` calls gated; `getPreviewEvidenceUrl()` result checked before use.
**Effort:** 20m.

---

## F-381 · ARTIFACT_CAP constant

```ts
const INCOMING_ARTIFACT_CAP = 20;
// exported from a shared config module
```
**Effort:** 5m.

---

## F-382 · TASK_RESULT_HISTORY_WINDOW constant

**Effort:** 5m. **Bundled with F-381.**

---

## F-383 · Truncate artifact content with marker

**Effort:** 2m. **Bundled with F-094/F-268.**

---

## F-384 · Prefix enum

```ts
export const TASK_RESULT_PREFIX = { edited: "edited:", preview: "preview:", meeting: "meeting:", bash: "bash:" } as const;
```
Replace string-literal parsing downstream with typed helpers.
**Effort:** 20m. **Bundled with F-249.**

---

## F-385 · Memoize snapshot per function

```ts
async function setTaskStatus(id: string, status: TaskStatus) {
  const snap = getSnapshot();
  // reuse `snap` throughout this function
}
```
**Effort:** 30m.

---

## F-386 · Zod-parse task status

Parse LLM-output task status updates via `TaskStatusSchema`.
**Effort:** 15m. **Bundled with F-155/F-386.**

---

## F-387 · Unify execution-cycle

Either delete the `packages/task-engine/execution-cycle.ts` duplicate (if unreferenced) or move one into the other's namespace.
**Effort:** 1h. Needs grep first.

---

## F-388 · Task state machine guards

```ts
const LEGAL_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  todo: new Set(["in_progress", "blocked", "cancelled"]),
  in_progress: new Set(["in_review", "completed", "blocked", "failed"]),
  in_review: new Set(["completed", "rework", "blocked"]),
  // ...
};
function assertLegal(from: TaskStatus, to: TaskStatus) {
  if (!LEGAL_TRANSITIONS[from].has(to)) throw new Error(`illegal ${from}→${to}`);
}
```
**Effort:** 1h.

---

## F-389 · Delete `mapTaskPriority`

Identity function — inline-remove.
**Effort:** 5m.

---

## F-390 · Shared `isFollowUp` / `isBugFix` predicates

```ts
export const isFollowUp = (t: Task) => t.kind === "follow_up";
export const isBugFix = (t: Task) => t.kind === "bug_fix";
```
**Effort:** 10m.

---

## F-391 · Persistent audit buffer survives DB outages

```ts
// instead of clearing pendingFlush after MAX_FAILURES, spill to disk
if (failures > MAX_DB_FAILURES) {
  await fs.appendFile(SPILL_PATH, JSON.stringify(pendingFlush) + "\n");
  pendingFlush = [];
}
// background replayer drains SPILL_PATH when DB recovers
```
**Effort:** 2h.

---

## F-392 · Mutex on pendingFlush

```ts
const flushLock = new Semaphore(1);
async function flushToDb() {
  await flushLock.acquire();
  try { /* splice + write */ } finally { flushLock.release(); }
}
```
**Effort:** 30m. **Bundled with F-086.**

---

## F-393 · Bounded graph store + LRU eviction

```ts
class GraphStore {
  private static MAX_NODES = 100_000;
  addNode(node) {
    if (this.nodes.size > MAX_NODES) this.evictOldest();
    this.nodes.set(node.id, node);
  }
}
```
Or persist to DB after N nodes; keep a hot working-set in memory.
**Effort:** 2h. **Bundled with F-045.**

---

## F-394 · Subscriber unsubscribe on write error

```ts
stream.on("error", () => unsubscribe(id));
stream.write(...).catch(() => unsubscribe(id));
```
**Effort:** 20m.

---

## F-395 · AbortSignal threaded to runPromptText

```ts
export async function runPromptText(role, sessionId, system, user, { signal }: { signal?: AbortSignal } = {}) {
  const result = await opencode.client.session.prompt(..., { signal });
}
```
**Effort:** 30m. **Bundled with F-262.**

---

## F-396 · Narrow LLM return types

```ts
const statusResult = StatusResultSchema.parse(response);
// no `as Record<...>`
```
**Effort:** 30m. **Bundled with F-031.**

---

## F-397 · Proper null handling in emitter

```ts
if (!node) { await audit("graph_node_missing", {...}); return; }
// no `null as unknown as GraphNode`
```
**Effort:** 10m.

---

## F-398 · Activity buffer config

```ts
const ACTIVITY_RING_SIZE = env.ACTIVITY_RING_SIZE ?? 2000;
```
**Effort:** 5m. **Bundled with F-242.**

---

## F-399 · SSE_HEARTBEAT_MS config

**Effort:** 2m. **Bundled with F-242.**

---

## F-400 · ARTIFACT_BUDGET_CHARS config

**Effort:** 2m. **Bundled with F-242.**

---

## F-401 · Developer file-listing cap

```ts
const DEV_FILE_LIST_CAP = 100;
```
**Effort:** 2m. **Bundled with F-242.**

---

## F-402 · Audit ledger emits to own logger

```ts
// audit-ledger.ts
import { logger } from "./logger.js";
logger.error({ event }, "audit flush failed");
// no console.log inside the audit subsystem
```
**Effort:** 10m. **Bundled with F-037.**

---

## F-403 · DecisionType Zod enum

```ts
export const DecisionTypeSchema = z.enum([...]);
```
**Effort:** 10m. **Bundled with F-031.**

---

## F-404 · Delete `alternatives` field

**Effort:** 5m.

---

## F-405 · Delete `toolCalls` on beatNode

**Effort:** 5m.

---

## F-406 · Parameterized habit-ID query

```ts
await db.select().from(habits).where(inArray(habits.id, habitIds));
// drizzle's inArray is parameterized — replace sql.join composition
```
**Effort:** 15m.

---

## F-407 · Embedding init timeout

```ts
loadingPromise = Promise.race([
  pipeline("feature-extraction", MODEL),
  new Promise((_, reject) => setTimeout(() => reject(new Error("embedding init timeout")), 30_000)),
]);
```
**Effort:** 15m.

---

## F-408 · Lazy-singleton embedding loader

```ts
let loadingPromise: Promise<Pipeline> | null = null;
export function getEmbedder(): Promise<Pipeline> {
  if (!loadingPromise) {
    loadingPromise = pipeline(...).catch((err) => { loadingPromise = null; throw err; });
  }
  return loadingPromise;
}
```
**Effort:** 15m.

---

## F-409 · Retry + reconcile for embedding failures

Instead of silent null-embedding insert:
```ts
try {
  const vec = await embed(content);
  await insert({ content, embedding: vec });
} catch (err) {
  await insert({ content, embedding: null, pendingEmbedding: true });
  await jobs.enqueue("backfill_embedding", { id, content });
}
```
**Effort:** 1h. **Bundled with F-331.**

---

## F-410 · Transaction on fact routing

```ts
await db.transaction(async (tx) => {
  const existing = await tx.query.memoryFacts.findMany(...);
  const decision = await decide(existing, newFact);
  await applyDecision(tx, decision);
});
```
**Effort:** 1h. **Bundled with F-086.**

---

## F-411 · HNSW index on embedding column

```sql
CREATE INDEX idx_memory_embedding_hnsw ON memory_facts USING hnsw (embedding vector_cosine_ops);
```
**Effort:** 15m + migration.

---

## F-412 · Assert embedding dim on boot

```ts
const sample = await embed("test");
if (sample.length !== EMBEDDING_DIM) throw new Error(`embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${sample.length}`);
```
**Effort:** 10m.

---

## F-413 · Shared decay formula helper

```ts
export const decayFactor = (days: number) => Math.pow(0.5, days / MEMORY_DECAY_DAYS);
// compile into SQL function if pgvector needs inline
```
**Effort:** 30m.

---

## F-414 · Confidence constants

```ts
export const CONFIDENCE = { success: 0.8, partial: 0.6, failure: 0.4 } as const;
```
**Effort:** 5m. **Bundled with F-242.**

---

## F-415 · Align creation + GC windows

```ts
export const MEMORY_EXPIRY_DAYS = 30;
// used both at insert (expiresAt = now + days) and GC
```
**Effort:** 15m.

---

## F-416 · Tier-boost config

```ts
export const TIER_BOOST: Record<MemoryTier, number> = env.TIER_BOOST ?? { static: 1.5, dynamic: 1.0 };
```
**Effort:** 10m.

---

## F-417 · Cursor pagination on memory list

```ts
async list({ cursor, limit = 50 }: ListOpts) {
  const rows = await db.select().from(facts).where(gt(facts.id, cursor)).limit(limit + 1);
  const hasNext = rows.length > limit;
  return { items: rows.slice(0, limit), nextCursor: hasNext ? rows[limit - 1].id : null };
}
```
**Effort:** 45m.

---

## F-418 · Summary truncation helper

**Effort:** 2m. **Bundled with F-094/F-268.**

---

## F-419 · Warn when retrieval has no embeddings

```ts
if (embeddings.length === 0) {
  logger.warn({ agentId, taskDesc }, "retrieval_fallback_to_1.0");
}
```
**Effort:** 5m.

---

## F-420 · Rename memory store interfaces

```ts
interface ImmutableMemoryStore { add, list, get }        // formerly StaticMemoryStore
interface MutableMemoryStore extends ImmutableMemoryStore { update, gc }  // formerly DynamicMemoryStore
```
**Effort:** 20m.

---

## F-421 · Remove scopeBoost

Delete the unused multiplier.
**Effort:** 2m.

---

## F-422 · Remove `__embedding` stash

**Effort:** 2m.

---

## F-423 · Audit habit GC

```ts
await audit("habit_deactivated", { habitId, reason, severity: "notice" });
```
**Effort:** 5m. **Bundled with F-283.**

---

## F-424 · Auth preHandler on mutation routes

```ts
// apps/api/src/routes/index.ts
app.addHook("preHandler", async (req, reply) => {
  if (MUTATION_METHODS.has(req.method) && !req.headers.authorization) {
    reply.code(401); return { error: { code: "unauthorized" } };
  }
  // verify bearer token against session store
});
```
Plus `@fastify/rate-limit` + per-route roles.
**Effort:** 6-8h (foundation work).

---

## F-425 · Consistent status codes on errors

```ts
// respond.ts helper
export function notFound(reply, message) { reply.code(404); return { error: { code: "not_found", message } }; }
export function conflict(reply, message) { reply.code(409); return { error: { code: "conflict", message } }; }
```
Replace every `{ error: "..." }` returned at 200.
**Effort:** 2h across 6 routes.

---

## F-426 · Fastify JSON-schema + Zod on every route body

```ts
app.post("/api/skills/mutations/:id/run-ata", {
  schema: { body: zodToJsonSchema(RunAtaBodySchema), params: ... }
}, handler);
```
**Effort:** 4h (route-by-route).

---

## F-427 · Move `seedExistingSkills` out of GET

```ts
app.post("/api/skills/seed", async () => { seedExistingSkills(companyId); return { seeded: true }; });
// server.ts bootstrap calls it once on startup
// GET handlers do NOT seed
```
**Effort:** 30m.

---

## F-428 · Gate debug/seed endpoints

```ts
if (process.env.NODE_ENV === "production" && !process.env.ARCEUS_ADMIN_TOKEN) return;
app.register(debugRoutes, { prefix: "/_internal" });
```
Plus admin-token check in the preHandler.
**Effort:** 30m.

---

## F-429 · Generic error responses

```ts
catch (err) {
  const requestId = req.id;
  logger.error({ err, requestId }, "internal_error");
  reply.code(500);
  return { error: { code: "internal_error", requestId } };
}
```
No `err.message` leaked.
**Effort:** 1h across 10 routes.

---

## F-430 · API-conventions doc + route rename

Add `/api/v1/` prefix. Adopt `POST /resources/:id:action` pattern for side effects (`POST /api/v1/sprints/:id:approve`). Document in `docs/api-conventions.md`.
**Effort:** 6h (mass rename + redirect).

---

## F-431 · Response envelope helper

```ts
export function respond<T>(data: T, meta?: Meta): ApiResponse<T> {
  return { data, ...(meta ? { meta } : {}) };
}
```
Every handler returns via `respond()`.
**Effort:** 3h.

---

## F-432 · Cursor pagination on list routes

```ts
const { cursor, limit = 50 } = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
```
**Effort:** 30m per route × 16 = ~8h. **Bundled with F-431.**

---

## F-433 · AgentRoleEnum in contracts

```ts
export const AgentRoleEnum = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
```
Use everywhere role is a param.
**Effort:** 30m. **Bundled with F-098.**

---

## F-434 · Bounded numeric query parsing

```ts
const limit = z.coerce.number().int().min(1).max(500).default(50).parse(query.limit);
```
**Effort:** 20m across 5 sites.

---

## F-435 · 409 on beat skip

```ts
if (result.status === "skipped") {
  reply.code(409);
  return { error: { code: "beat_locked", reason: result.reason } };
}
```
**Effort:** 10m.

---

## F-436 · Location header on 201

```ts
reply.code(201).header("Location", `/api/v1/companies/${snapshot.company.id}`);
```
**Effort:** 5m.

---

## F-437 · 204 on DELETE /api/company

```ts
await resetCompany();
reply.code(204).send();
// or document it returns snapshot
```
**Effort:** 5m.

---

## F-438 · Required action on approval

```ts
const body = z.object({ action: z.enum(["approved", "rejected"]), summary: z.string().optional() }).parse(req.body);
```
**Effort:** 5m.

---

## F-439 · Typed PATCH config schema

```ts
const ConfigPatchSchema = z.object({
  schedulerIntervalMs: z.number().int().min(100).optional(),
  maxConcurrentBeats: z.number().int().min(1).max(100).optional(),
  // ...
});
const patch = ConfigPatchSchema.parse(req.body);
```
**Effort:** 20m.

---

## F-440 · /api/v1/ prefix + Sunset header

```ts
app.register(routes, { prefix: "/api/v1" });
// deprecated routes emit `Sunset: <date>` header
```
**Effort:** 2h (rename + redirects).

---

## F-441 · Canonical routes + alias redirects

Pick `/api/employee-activity`; make `/api/activity` a 301 redirect with `Sunset` header. Pick `/api/orchestrator/execute` over `/api/heartbeat/start` (or vice versa); mark one deprecated.
**Effort:** 1h.

---

## F-442 · `streamSse` helper

```ts
export function streamSse(reply, subscribe) {
  setSseHeaders(reply);
  const heartbeat = setInterval(() => reply.raw.write(`event: ping\ndata: {}\n\n`), 15_000);
  const unsubscribe = subscribe(event => {
    try { reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`); }
    catch { cleanup(); }
  });
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  reply.raw.on("close", cleanup);
}
```
**Effort:** 2h. Standardize across debug, audit, chat, events, activity.

---

## F-443 · Required fields over magic defaults

```ts
const SyncBodySchema = z.object({
  taskId: z.string().min(1),
  agentRole: AgentRoleEnum,
  message: z.string().min(1),
}); // no defaults
```
**Effort:** 10m.

---

## F-444 · (bundled)

Debug graph stream gated by F-428.
**Effort:** 0.

---

## F-445 · Immutable trigger construction

```ts
const trigger = body.trigger
  ?? { type: "interval" as const, scheduledAt: new Date().toISOString() };
const normalized = trigger.type === "interval" && !trigger.scheduledAt
  ? { ...trigger, scheduledAt: new Date().toISOString() }
  : trigger;
// no `(trigger as any).scheduledAt = ...`
```
**Effort:** 10m.

---

## F-446 · Metadata on paginated slices

```ts
return { data: list.slice(-50), meta: { total: list.length, returnedWindow: "last_50" } };
```
**Effort:** 20m.

---

## F-447 · Discriminated success/error shape

```ts
type PreviewStatus = { status: "started" | "running"; url: string; entryUrl: string } | { status: "failed"; error: string };
```
**Effort:** 30m.

---

## F-448 · Range-ordered diff validation

```ts
const DiffQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
}).refine(q => q.from < q.to, { message: "from must be less than to" });
```
**Effort:** 5m.

---

## F-449 · Rename /api/events

```
GET /api/v1/events/history    → JSON array, bounded
GET /api/v1/events/stream     → live SSE (with heartbeats per F-442)
```
**Effort:** 30m.

---

## F-450 · CORS allow-list

```ts
app.register(cors, {
  origin: (origin, cb) => {
    cb(null, ALLOWED_ORIGINS.has(origin));
  },
  credentials: true,
});
// never echo request origin unconditionally
```
**Effort:** 30m.

---

## F-451 · Minimal 201 response

```ts
reply.code(201).header("Location", `/api/v1/companies/${id}`);
return respond({ id: snapshot.company.id, createdAt: snapshot.company.createdAt });
// client fetches full snapshot separately
```
**Effort:** 15m.

---

## F-452 · Split /strategy/execute into distinct endpoints

```
POST /api/v1/strategies            (create)
POST /api/v1/strategies/:id:apply  (persist)
POST /api/v1/orchestrator:start    (start engine)
```
**Effort:** 2h.

---

## F-453 · TrustEventKind enum

```ts
export const TrustEventKindSchema = z.enum([...]);
const event = buildTrustEvent(..., TrustEventKindSchema.parse(body.kind), ...);
```
**Effort:** 20m. **Bundled with F-433.**

---

## F-454 · Nest skill-candidates under sprints

```
GET /api/v1/sprints/:sprintId/skill-candidates
```
**Effort:** 10m.

---

## F-455 · Global rate limiter

```ts
await app.register(rateLimit, { max: 100, timeWindow: "1 minute", allowList: ["127.0.0.1"] });
// override per route:
app.post("/api/v1/quick-execute", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, handler);
```
**Effort:** 1h.

---

## F-456 · @fastify/cors with allow-list

**Effort:** 15m. **Bundled with F-450.**

---

## F-457 · 404 on missing candidate

```ts
if (!candidate) { reply.code(404); return { error: { code: "cluster_not_promotable", clusterId } }; }
```
**Effort:** 5m. **Bundled with F-425.**

---

## F-458 · Consistent DI via Fastify plugin options

```ts
// all route plugins accept Deps
export interface RouteDeps {
  heartbeat: HeartbeatEngine;
  meetings: MeetingScheduler;
  workspace: WorkspaceManager;
  // ...
}
export default async function routes(app, deps: RouteDeps) { ... }
```
No module-level singletons imported into route handlers.
**Effort:** 3h.

---

## Running index — Wave 2

| ID | Title | Effort | Notes |
|----|-------|--------|-------|
| F-305 | 🔴 serialize cleanup | 30m | Standalone |
| F-306 | 🔴 re-snapshot at boundaries | 1h | Bundled with F-315 |
| F-307 | 🟠 AbortSignal on cycle | 45m | Bundled with F-262 |
| F-308 | 🟠 transactional cleanup | 1h | Bundled with F-086 |
| F-309 | 🟡 bootstrap sentinels | 10m | Bundled with F-017 |
| F-310 | 🟡 boardDecision helper | 10m | Standalone |
| F-311 | 🟡 audit reactive dropped | 15m | Bundled with F-068 |
| F-312 | 🟡 role-literal enum | 15m | Bundled with F-098 |
| F-313 | 🟢 pluralize helper | 5m | Standalone |
| F-314 | 🟢 exhaustive status check | 10m | Bundled with F-043 |
| F-315 | 🔴 re-snapshot in chat | 30m | Standalone |
| F-316 | 🔴 audit emitBeatEvent | 15m | Bundled with F-260 |
| F-317 | 🟠 bounded SSE buffer | 10m | Standalone |
| F-318 | 🟠 Zod after enforceMandatoryRoles | 30m | Bundled with F-031 |
| F-319 | 🟠 await recordCeoCardMeeting | 5m | Standalone |
| F-320 | 🟠 reconcile meeting.create fallback | 20m | Standalone |
| F-321 | 🟠 try/catch retry | 15m | Standalone |
| F-322 | 🟠 split ceo.ts | 4h | Standalone |
| F-323 | 🟡 structured logger | 10m | Bundled with F-037 |
| F-324 | 🟡 SUMMARY_CAPS const | 15m | Bundled with F-017 |
| F-325 | 🟡 truncate with marker | 5m | Bundled with F-268 |
| F-326 | 🟡 single-pass reduce | 30m | Standalone |
| F-327 | 🟡 sessionId→role index | 20m | Standalone |
| F-328 | 🟡 immutable session update | 10m | Standalone |
| F-329 | 🟢 inline queuedFollowUpCount | 5m | Standalone |
| F-330 | 🔴 AST shell lint | 4-6h | Bundled with F-087 |
| F-331 | 🔴 DLQ for ATA | 3h | Bundled with F-279 |
| F-332 | 🔴 CAS on mutation status | 1h | Bundled with F-086 |
| F-333 | 🟠 typed null-noop | 30m | Standalone |
| F-334 | 🟠 delete classifier | 0 | Bundled with F-259 |
| F-335 | 🟠 tx around tester loop | 1h | Bundled with F-086 |
| F-336 | 🟠 index skills.companyId | 5m | Standalone |
| F-337 | 🟠 lazy active-index | 30m | Standalone |
| F-338 | 🟡 per-mutation cost cap | 15m | Standalone |
| F-339 | 🟡 daysToMs helper | 2m | Standalone |
| F-340 | 🟡 classifier cleanup | 0 | Bundled with F-259 |
| F-341 | 🟡 delete deprecated exports | 15m | Standalone |
| F-342 | 🟡 split evolution.ts | 4h | Standalone |
| F-343 | 🟡 skills logger | 30m | Bundled with F-037 |
| F-344 | 🟢 VerdictSchema | 5m | Bundled with F-031 |
| F-345 | 🔴 persist phase before probe | 30m | Bundled with F-086 |
| F-346 | 🔴 CAS on sprint update | 45m | Bundled with F-086 |
| F-347 | 🔴 surface tagSprint fail | 30m | Bundled with F-068 |
| F-348 | 🟠 AbortSignal on LLM | 1h | Bundled with F-262 |
| F-349 | 🟠 QA-parse as defect | 20m | Standalone |
| F-350 | 🟠 tx sprint approval | 2h | Bundled with F-086 |
| F-351 | 🟠 content-hash dedup | 30m | Standalone |
| F-352 | 🟠 split review verification | 4h | Standalone |
| F-353 | 🟠 split sprint approval | 3h | Standalone |
| F-354 | 🟡 SprintReviewPhase enum | 30m | Bundled with F-099 |
| F-355 | 🟡 stderr truncation | 2m | Bundled with F-268 |
| F-356 | 🟡 ReviewState interface | 45m | Bundled with F-099 |
| F-357 | 🟡 REVIEW_CONFIG | 15m | Bundled with F-242 |
| F-358 | 🟢 delete dead else | 2m | Standalone |
| F-359 | 🔴 CAS meeting pipeline | 45m | Bundled with F-086 |
| F-360 | 🔴 scheduler job queue | 2h | Bundled with F-279 |
| F-361 | 🔴 atomic upsert + schedule | 1h | Bundled with F-086 |
| F-362 | 🟠 CAS counters | 20m | Bundled with F-086 |
| F-363 | 🟠 try/catch meeting LLM | 30m | Standalone |
| F-364 | 🟠 unique daily-sync | 30m | Bundled with F-086 |
| F-365 | 🟠 Zod resolution output | 30m | Bundled with F-031 |
| F-366 | 🟠 await executeMeetingDecisions | 5m | Standalone |
| F-367 | 🟠 await applyMeetingEffects | 5m | Bundled with F-366 |
| F-368 | 🟡 MeetingType enum | 20m | Bundled with F-098 |
| F-369 | 🟡 pluggable manager resolver | 30m | Standalone |
| F-370 | 🟡 split meeting-scheduler | 3h | Standalone |
| F-371 | 🟡 rename conditionalCheck | 15m | Standalone |
| F-372 | 🟡 meeting constants | 10m | Bundled with F-242 |
| F-373 | 🟢 validate participants | 15m | Standalone |
| F-374 | 🔴 idempotent artifact propagation | 30m | Bundled with F-086 |
| F-375 | 🔴 outbox hippocampus | 3h | Bundled with F-279 |
| F-376 | 🔴 setTaskStatus event emission | 6h | Bundled with F-043 |
| F-377 | 🟠 AbortSignal cross-sprint | 15m | Bundled with F-262 |
| F-378 | 🟠 null-guard promotion | 5m | Standalone |
| F-379 | 🟠 activeAgents guard | 2m | Bundled with F-278 |
| F-380 | 🟠 null-checks executor | 20m | Standalone |
| F-381 | 🟡 INCOMING_ARTIFACT_CAP | 5m | Standalone |
| F-382 | 🟡 TASK_RESULT_HISTORY const | 5m | Bundled with F-381 |
| F-383 | 🟡 artifact truncate | 2m | Bundled with F-268 |
| F-384 | 🟡 TASK_RESULT_PREFIX enum | 20m | Bundled with F-249 |
| F-385 | 🟡 memoize snapshot | 30m | Standalone |
| F-386 | 🟡 Zod task status | 15m | Bundled with F-155 |
| F-387 | 🟡 unify execution-cycle | 1h | Standalone |
| F-388 | 🟡 transition guards | 1h | Standalone |
| F-389 | 🟢 delete mapTaskPriority | 5m | Standalone |
| F-390 | 🟢 isFollowUp/isBugFix | 10m | Standalone |
| F-391 | 🔴 persistent audit spill | 2h | Standalone |
| F-392 | 🔴 mutex on pendingFlush | 30m | Bundled with F-086 |
| F-393 | 🔴 bounded graph store | 2h | Bundled with F-045 |
| F-394 | 🟠 SSE subscriber cleanup | 20m | Standalone |
| F-395 | 🟠 AbortSignal runPromptText | 30m | Bundled with F-262 |
| F-396 | 🟠 narrow LLM return types | 30m | Bundled with F-031 |
| F-397 | 🟠 real null handling emitter | 10m | Standalone |
| F-398 | 🟡 ACTIVITY_RING_SIZE config | 5m | Bundled with F-242 |
| F-399 | 🟡 SSE_HEARTBEAT_MS | 2m | Bundled with F-242 |
| F-400 | 🟡 ARTIFACT_BUDGET_CHARS | 2m | Bundled with F-242 |
| F-401 | 🟡 DEV_FILE_LIST_CAP | 2m | Bundled with F-242 |
| F-402 | 🟡 audit ledger logger | 10m | Bundled with F-037 |
| F-403 | 🟡 DecisionTypeSchema | 10m | Bundled with F-031 |
| F-404 | 🟢 delete alternatives | 5m | Standalone |
| F-405 | 🟢 delete toolCalls | 5m | Standalone |
| F-406 | 🔴 parameterized habit SQL | 15m | Standalone |
| F-407 | 🟠 embedding init timeout | 15m | Standalone |
| F-408 | 🟠 lazy-singleton embedder | 15m | Standalone |
| F-409 | 🟠 embedding backfill queue | 1h | Bundled with F-331 |
| F-410 | 🟠 tx fact routing | 1h | Bundled with F-086 |
| F-411 | 🟠 HNSW index | 15m | Standalone |
| F-412 | 🟡 assert embedding dim | 10m | Standalone |
| F-413 | 🟡 decayFactor helper | 30m | Standalone |
| F-414 | 🟡 CONFIDENCE constants | 5m | Bundled with F-242 |
| F-415 | 🟡 align expiry/GC | 15m | Standalone |
| F-416 | 🟡 TIER_BOOST config | 10m | Standalone |
| F-417 | 🟡 cursor pagination memory | 45m | Standalone |
| F-418 | 🟡 summary truncate | 2m | Bundled with F-268 |
| F-419 | 🟡 retrieval warn | 5m | Standalone |
| F-420 | 🟡 rename memory stores | 20m | Standalone |
| F-421 | 🟢 remove scopeBoost | 2m | Standalone |
| F-422 | 🟢 remove __embedding | 2m | Standalone |
| F-423 | 🟢 audit habit GC | 5m | Bundled with F-283 |
| F-424 | 🔴 auth preHandler | 6-8h | Foundation |
| F-425 | 🔴 consistent error codes | 2h | Standalone |
| F-426 | 🔴 Zod route bodies | 4h | Standalone |
| F-427 | 🔴 move seed out of GET | 30m | Standalone |
| F-428 | 🔴 gate debug endpoints | 30m | Standalone |
| F-429 | 🔴 generic error responses | 1h | Standalone |
| F-430 | 🟠 API conventions + rename | 6h | Standalone |
| F-431 | 🟠 response envelope | 3h | Standalone |
| F-432 | 🟠 cursor pagination routes | 8h | Bundled with F-431 |
| F-433 | 🟠 AgentRoleEnum | 30m | Bundled with F-098 |
| F-434 | 🟠 bounded numeric parsing | 20m | Standalone |
| F-435 | 🟠 409 beat skip | 10m | Standalone |
| F-436 | 🟠 Location header on 201 | 5m | Standalone |
| F-437 | 🟠 204 on DELETE company | 5m | Standalone |
| F-438 | 🟠 required action field | 5m | Standalone |
| F-439 | 🟠 PATCH config schema | 20m | Standalone |
| F-440 | 🟠 /api/v1/ + Sunset | 2h | Standalone |
| F-441 | 🟡 dedup alias routes | 1h | Standalone |
| F-442 | 🟡 streamSse helper | 2h | Standalone |
| F-443 | 🟡 required fields | 10m | Standalone |
| F-444 | 🟡 gated debug stream | 0 | Bundled with F-428 |
| F-445 | 🟡 immutable trigger | 10m | Standalone |
| F-446 | 🟡 slice metadata | 20m | Standalone |
| F-447 | 🟡 discriminated preview shape | 30m | Standalone |
| F-448 | 🟡 diff range refine | 5m | Standalone |
| F-449 | 🟡 rename /api/events | 30m | Standalone |
| F-450 | 🟡 CORS allow-list | 30m | Standalone |
| F-451 | 🟡 minimal 201 response | 15m | Standalone |
| F-452 | 🟡 split strategy/execute | 2h | Standalone |
| F-453 | 🟡 TrustEventKind enum | 20m | Bundled with F-433 |
| F-454 | 🟡 nest skill-candidates | 10m | Standalone |
| F-455 | 🟡 global rate limiter | 1h | Standalone |
| F-456 | 🟡 @fastify/cors | 15m | Bundled with F-450 |
| F-457 | 🟡 404 missing candidate | 5m | Bundled with F-425 |
| F-458 | 🟢 DI via plugin options | 3h | Standalone |

---

**Wave 2 aggregate effort (excluding F-002 and C4 auth foundation):** ~5 focused days.

**Umbrella dependencies (finish first, many fixes collapse):**
- F-086 (CAS primitive in `applyMutations`) — unblocks F-258, F-277, F-345, F-346, F-350, F-359, F-361, F-362, F-364, F-374, F-392, F-410 (12 fixes).
- F-068 (swallowAndAudit helper) — unblocks F-260, F-289, F-300, F-311, F-316, F-347, F-391 (7 fixes).
- F-262 (AbortSignal) — unblocks F-247, F-262, F-293, F-307, F-348, F-377, F-395 (7 fixes).
- F-098 (AgentRoleEnum) — unblocks F-223, F-264, F-301, F-312, F-368, F-433, F-453 (7 fixes).
- F-242 (ChecklistConfig + env constants) — unblocks F-265, F-281, F-324, F-357, F-372, F-398-F-401, F-414 (9 fixes).
- F-259 (catalog-injection skills) — collapses F-334, F-340 (classifier deletion).
- F-037 (structured logger) — collapses console.log cleanup for F-237, F-272, F-323, F-343, F-402 (5 fixes).
- F-268 (truncateTelemetry) — collapses every `slice(0, N)` site: F-094, F-303, F-325, F-355, F-383, F-418 (6 fixes).

Pick **5 umbrellas to land first → 50+ downstream fixes flip to "just apply the pattern."**

---

## Next audit targets

After the above ship (or are triaged out), audit:
- `apps/api/src/persistence/store.ts` (the god module behind F-002)
- `apps/api/src/persistence/control-plane.ts` (989 LOC, the biggest single file)
- `apps/api/src/orchestration/state.ts` (module-level mutable state; ties to F-002 + F-005)
- `apps/api/src/infra/opencode.ts` (external runtime coupling — adapter-layer candidate)
