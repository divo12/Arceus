# Spec 27 — Tool Catalog Integration for §8–§16 (implementable edition)

> **Companion to [`27-tool-catalog-integration-continued.md`](./27-tool-catalog-integration-continued.md).** The original `27-tool-catalog-integration-continued.md` is the scope + phase-plan doc. This doc is the **developer-facing implementable detail**: per-tool Zod schemas, HTTP routes, error-cause tables, atomic commit sequences, test matrices. Read the original first for shape; read this for wiring.

**Status:** Plan · **Owner:** Platform · **Last Updated:** 2026-04-23
**Depends on:** Spec 12 (Heartbeat), Spec 13 (Governance Gateway), Spec 24 (Facilitator SVC + skills), Spec 25 (Agent Auth + Idempotency), **Spec 26 (§1–§5 MCP)**
**Scope:** Ship the **21 kept tools** (§8–§11), the **37 drops** with replacements (built-ins, hooks, middleware, admin dashboard), the **progressive-disclosure skill catalog**, the **new `beat_watchdog_reset` hook**, the **two new skills**, and the **two anti-pattern deletions**.

---

## 0. TL;DR

- **21 kept tools**: 6 MCP + 5 role-custom (§8) + 4 MCP (§9) + 2 MCP (§10) + 4 MCP (§11)
- **37 dropped tool registrations** across §8, §13, §14, §16 (some existed only as scaffolding)
- **2 anti-pattern function deletions** (`generateWorkflowTaskPlan`, `classifyTaskSkills`)
- **1 new plugin hook** (`beat_watchdog_reset`)
- **2 new skills** materialized from `.arceus/skills-seed/`
- **1 new mechanism** — progressive-disclosure skill catalog in `buildBeatContext`
- **6 phases**, each independently deployable behind `ARCEUS_TOOL_V2_*` flag
- Reuses spec 26's envelope, error-cause enum, idempotency middleware, 410-Gone convention

---

## 1. Contracts foundation (inherited from spec 26)

Everything below reuses from `26-implement.md` without restating:

- **Envelope shape** (`ToolResult<T>` with `{status, summary, data, error}`) — spec 26 §2.1
- **Error cause enum** (`ErrorCause` in `packages/contracts/src/envelope.ts`) — spec 26 §2.2. Spec 27 adds three new causes (§1.1 below).
- **Idempotency key derivation** (`deriveIdempotencyKey(beatId, toolName, body)`) — spec 26 §2.3
- **`next_actions` / `artifacts` response fields** — spec 26 §2.4
- **HTTP conventions** (POST for mutations, GET for reads, 410 Gone for retirements) — spec 26 §2.5

### 1.1 New error causes this spec adds

```typescript
// packages/contracts/src/envelope.ts — extend the enum
export type ErrorCause =
  | /* existing spec 26 causes */
  | "preview_unavailable"        // workspace_probe_preview: preview URL is down
  | "baseline_failed"            // workspace_verify_baseline: composite check failed
  | "execution_locked"           // execution_pause_for_review / _stop: already in blocking state
  | "invalid_next_action"        // execution_reconcile_post_review: bad enum
  | "tool_retired";              // 410 Gone envelope
```

HTTP status mapping:

| Cause | HTTP |
|---|---|
| `preview_unavailable` | 503 |
| `baseline_failed` | 200 with `status: "partial"` |
| `execution_locked` | 409 |
| `invalid_next_action` | 400 |
| `tool_retired` | 410 |

---

## 2. §8 Workspace — 11 tools (6 MCP + 5 role-custom)

### 2.1 `workspace_checkpoint` [LIVE]

**Roles:** `dev`, `sl`
**Surface:** MCP
**HTTP:** `POST /api/internal/workspace/checkpoint`
**Idempotency key:** `hash(beatId, "workspace_checkpoint", {taskId, message})`

```typescript
// packages/contracts/src/workspace.ts
export const WorkspaceCheckpointInputSchema = z.object({
  taskId: z.string().min(1),
  message: z.string().min(1).max(500),
  attachBundleUrl: z.boolean().default(true),
});

export const WorkspaceCheckpointDataSchema = z.object({
  commitSha: z.string().length(40),
  bundleUrl: z.string().url().nullable(),
  bytesUploaded: z.number().int().nonnegative(),
  taskStateLinked: z.boolean(),
});
```

**Error causes:** `git_dirty_after_commit`, `bundle_upload_failed` (retry
automatically 2×), `task_not_found`, `idempotency_violation`.

**Tests:** happy path commits + uploads + links; two consecutive calls
with same idempotency key return same shape; bundle upload failure
returns `partial` with `commitSha` populated.

### 2.2 `workspace_probe_preview` [LIVE — rename from `workspace_preview_probe`]

**Roles:** `dev`, `qa`
**Surface:** MCP
**HTTP:** `POST /api/internal/workspace/probe-preview`
**Idempotency:** not idempotent (probes vary over time); envelope still includes key for audit

```typescript
export const WorkspaceProbePreviewInputSchema = z.object({
  taskId: z.string().min(1),
  timeoutMs: z.number().int().positive().max(10_000).default(5_000),
  expectStatus: z.number().int().min(100).max(599).default(200),
});

export const WorkspaceProbePreviewDataSchema = z.object({
  ok: z.boolean(),
  status: z.number().int(),
  timingMs: z.number().int().nonnegative(),
  bodyPreview: z.string().max(500).nullable(),
  consoleErrors: z.array(z.string()).default([]),
});
```

**Error causes:** `preview_unavailable` (connection refused / timeout),
`preview_url_unset` (no URL registered for task).

**Rename mechanics:** existing live registration uses `probe_preview`
(not `preview_probe`); this spec makes the rename canonical across all
docs + configs. No code change needed — just doc alignment.

### 2.3 `workspace_get_preview_url` [LIVE]

**Roles:** `dev`, `qa`
**Surface:** MCP
**HTTP:** `GET /api/internal/workspace/preview-url?taskId=<id>`
**Idempotency:** N/A (read)

```typescript
export const WorkspaceGetPreviewUrlDataSchema = z.object({
  taskId: z.string(),
  previewUrl: z.string().url().nullable(),
  registeredAt: z.string().datetime().nullable(),
});
```

**Error causes:** `task_not_found`, `preview_url_unset`.

### 2.4 `workspace_get_build_health` [NEW]

**Roles:** `dev`, `qa`, `cto`
**Surface:** MCP
**HTTP:** `GET /api/internal/workspace/build-health?companyId=<id>&taskId=<id>`

```typescript
export const WorkspaceGetBuildHealthDataSchema = z.object({
  lastBuildOk: z.boolean(),
  lastTypecheckOk: z.boolean(),
  lastTestOk: z.boolean(),
  since: z.string().datetime(),
  errorsFirstN: z.array(z.object({
    category: z.enum(["build", "typecheck", "test"]),
    message: z.string(),
    location: z.string().nullable(),
  })).max(5),
});
```

**Backed by:** server-side cache updated by `workspace_verify_baseline`
+ `workspace_run_typecheck` on every successful/failed run.

**Error causes:** `cache_empty` (no runs yet — returns `status: "partial"` with all-false data).

### 2.5 `workspace_check_exports` [NEW]

**Roles:** `dev`, `qa`
**Surface:** MCP
**HTTP:** `POST /api/internal/workspace/check-exports`

```typescript
export const WorkspaceCheckExportsInputSchema = z.object({
  filePath: z.string().min(1),
  expectedExports: z.array(z.string().min(1)).min(1).max(50),
});

export const WorkspaceCheckExportsDataSchema = z.object({
  filePath: z.string(),
  present: z.array(z.string()),
  missing: z.array(z.string()),
  extra: z.array(z.string()),
  allPresent: z.boolean(),
});
```

**Implementation:** use `@babel/parser` + AST walk over the target file
(or TypeScript compiler API for `.ts` files). Runs server-side — no
shell out. 2-second hard timeout.

**Error causes:** `file_not_found`, `parse_error`.

### 2.6 `workspace_verify_baseline` [NEW]

**Roles:** `dev`, `qa`, `cto`
**Surface:** MCP
**HTTP:** `POST /api/internal/workspace/verify-baseline`
**Idempotency key:** `hash(beatId, "workspace_verify_baseline", {taskId})` — coalesces duplicate calls within same beat

```typescript
export const WorkspaceVerifyBaselineInputSchema = z.object({
  taskId: z.string().min(1),
  skipPreview: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(120_000).default(60_000),
});

export const WorkspaceVerifyBaselineDataSchema = z.object({
  buildOk: z.boolean(),
  typecheckOk: z.boolean(),
  testOk: z.boolean(),
  previewUp: z.boolean(),
  errors: z.array(z.object({
    stage: z.enum(["build", "typecheck", "test", "preview"]),
    message: z.string(),
  })),
  durationMs: z.number().int().nonnegative(),
});
```

**Composite implementation:**

```typescript
async function verifyBaseline(input) {
  const [build, typecheck, test, preview] = await Promise.all([
    runBuild(input.taskId),
    runTypecheck(input.taskId),
    runBasicTests(input.taskId),
    input.skipPreview ? Promise.resolve({ ok: true }) : probePreview(input.taskId),
  ]);
  const errors = collectErrors(build, typecheck, test, preview);
  const allOk = build.ok && typecheck.ok && test.ok && preview.ok;
  return {
    status: allOk ? "success" : "partial",
    summary: allOk ? "Baseline ok" : `${errors.length} failure(s)`,
    data: { buildOk: build.ok, typecheckOk: typecheck.ok, testOk: test.ok, previewUp: preview.ok, errors, durationMs: elapsed() },
    error: allOk ? null : { cause: "baseline_failed", message: firstFailMessage(errors), details: { stages: errors.map(e => e.stage) } },
  };
}
```

**Side effects:** updates `build_health_cache` row with latest results.

### 2.7 `workspace_run_typecheck` [NEW — role-custom, developer bundle]

**Surface:** `.opencode/tool/developer/run_typecheck.ts` (OpenCode role-custom tool)
**Why role-custom not MCP:** incremental typecheck caches an
in-process Program across calls; round-tripping through MCP would lose
cache locality.

```typescript
// apps/api/workspace/.opencode/tool/developer/run_typecheck.ts
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

const state = new Map<string, ts.Program>();  // keyed by companyId

export default tool({
  name: "workspace_run_typecheck",
  description: "Incremental TypeScript typecheck with in-process cache. Fires 5–20×/beat during type iteration.",
  inputSchema: z.object({
    paths: z.array(z.string()).default([]),  // empty = whole project
    strict: z.boolean().default(true),
  }),
  async execute(args, ctx) {
    const program = getOrCreateProgram(ctx.companyId, args.paths);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    return {
      status: diagnostics.length === 0 ? "success" : "partial",
      summary: `${diagnostics.length} diagnostic(s)`,
      data: {
        diagnostics: diagnostics.slice(0, 20).map(formatDiagnostic),
        totalCount: diagnostics.length,
      },
      error: diagnostics.length === 0 ? null : {
        cause: "typecheck_failed",
        message: formatDiagnostic(diagnostics[0]),
      },
    };
  },
});
```

**Cache invalidation:** cleared on `workspace_checkpoint`, external file
edits (via `write`/`edit` built-in hook), or every 5 minutes.

### 2.8 `workspace_capture_browser_probe` [NEW — role-custom, qa bundle]

**Surface:** `.opencode/tool/qa/capture_browser_probe.ts`
**Playwright dependency:** qa bundle loads `playwright` at tool init.

```typescript
export default tool({
  name: "workspace_capture_browser_probe",
  description: "Headless browser: navigate + screenshot + console + network + DOM snapshot.",
  inputSchema: z.object({
    taskId: z.string(),
    waitForSelector: z.string().optional(),
    timeoutMs: z.number().int().positive().max(30_000).default(10_000),
  }),
  async execute(args, ctx) {
    const url = await getPreviewUrl(args.taskId);
    if (!url) return errResult("preview_url_unset");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const consoleMessages: string[] = [];
      const networkEvents: Array<{url: string; status: number}> = [];
      page.on("console", m => consoleMessages.push(`[${m.type()}] ${m.text()}`));
      page.on("response", r => networkEvents.push({ url: r.url(), status: r.status() }));
      await page.goto(url, { timeout: args.timeoutMs });
      if (args.waitForSelector) await page.waitForSelector(args.waitForSelector, { timeout: args.timeoutMs });
      const screenshot = await page.screenshot({ type: "png" });
      const domSnapshot = await page.content();
      const artifactId = await uploadProbeArtifact({ screenshot, domSnapshot, consoleMessages, networkEvents });
      return ok({ artifactId, consoleMessages: consoleMessages.slice(0, 20), networkEvents: networkEvents.slice(0, 50) });
    } finally {
      await browser.close();
    }
  },
});
```

**Error causes:** `preview_url_unset`, `browser_launch_failed`,
`navigation_timeout`, `selector_not_found`.

### 2.9 `workspace_collect_evidence` [NEW — role-custom, qa bundle]

**Surface:** `.opencode/tool/qa/collect_evidence.ts`

Bundles previously-captured probes + test output + diffs into one
structured QA evidence artifact. No browser work — just assembly.

```typescript
inputSchema: z.object({
  taskId: z.string(),
  probeArtifactIds: z.array(z.string()).min(1),
  testOutputArtifactIds: z.array(z.string()).default([]),
  diffArtifactIds: z.array(z.string()).default([]),
  summary: z.string().max(2000),
})

// Returns:
data: {
  evidenceArtifactId: z.string(),
  bundledSizeBytes: z.number().int(),
  componentCount: z.number().int(),
}
```

### 2.10 `workspace_run_acceptance_suite` [NEW — role-custom, qa bundle]

Reads the task's configured acceptance tests and runs them with
task-aware assertions. Wraps `bun test` with the task metadata as test
context.

```typescript
inputSchema: z.object({
  taskId: z.string(),
  testFilter: z.string().optional(),  // optional regex
})

data: {
  passed: z.number().int(),
  failed: z.number().int(),
  failingTests: z.array(z.object({ name: z.string(), error: z.string() })).max(10),
  durationMs: z.number().int(),
}
```

**Error causes:** `no_acceptance_suite` (task has none configured),
`test_runner_failed` (bun crashed).

### 2.11 `workspace_diff_against_criteria` [NEW — role-custom, qa bundle]

Single-shot LLM diff — observed behavior (from capture + test output)
vs the task's acceptance criteria. Returns structured gaps/unexpected.

```typescript
inputSchema: z.object({
  taskId: z.string(),
  evidenceArtifactId: z.string(),
})

data: {
  matches: z.array(z.string()),          // criteria that passed
  gaps: z.array(z.string()),             // criteria unmet
  unexpected: z.array(z.string()),       // behaviors not in criteria
  overallJudgment: z.enum(["meets", "close", "misses"]),
}
```

**Why function not SVC:** one-shot diff with a single prompt; no
iterative loop. Would be overkill as a subagent.

### 2.1.1 `permission.bash` per-role allowlist

Dropping `workspace_run_command` as a custom tool requires governance to
move into OpenCode's native `permission.bash` config. Each agent's
`.opencode/agent/<role>.md` gets an updated `permission` block.

**Developer example:**

```yaml
# apps/api/workspace/.opencode/agent/developer.md
permission:
  bash:
    "git diff*": "allow"
    "git log*": "allow"
    "git show*": "allow"
    "git rev-parse*": "allow"
    "git status": "allow"
    "git add*": "allow"
    "git commit*": "allow"
    "git init": "allow"
    "bun install": "allow"
    "bun add*": "ask"
    "bun test*": "allow"
    "bun run *": "allow"
    "rm -rf *": "deny"
    "curl *": "deny"
    "sudo *": "deny"
    "*": "deny"
```

**Per-role pattern table:**

| Role | Allow | Ask | Deny |
|---|---|---|---|
| `ceo` | `git tag sprint-*`, `git log*` | — | `*` |
| `cto` | `git diff*`, `git log*`, `git show*`, `git rev-parse*` | — | `*` |
| `pm` | — | — | `*` (uses built-ins only) |
| `developer` | see example above | `bun add*` | `rm -rf*`, `curl*`, `sudo*`, `*` |
| `tester` | `bun test*`, `bun run test:*`, `git log*` (read-only) | — | any file mutation, `*` |
| `ui_designer` | `git log*`, `bun run format`, `bun run lint` | — | `*` |
| `marketing` | — | — | `*` |
| `skills_lead` | `git diff*`, `git log*`, `bun test*` | — | `*` |

---

## 3. §9 Company / agent context — 4 tools

### 3.1 `company_get_summary` [NEW]

**Roles:** `ceo`, `cto`, `pm`
**HTTP:** `GET /api/internal/company/summary?companyId=<id>`

```typescript
export const CompanyGetSummaryDataSchema = z.object({
  companyId: z.string(),
  name: z.string(),
  goal: z.string(),
  strategy: z.string().nullable(),
  status: z.string(),
  activeSprint: z.object({
    id: z.string(),
    number: z.number().int(),
    goal: z.string(),
    status: z.enum(["executing", "qa_gate", "final_gate", "completed"]),
  }).nullable(),
  budgetCents: z.number().int().nonnegative(),
  spentCents: z.number().int().nonnegative(),
});
```

**Implementation:** single indexed read from `companies` + `sprints`
tables. < 10ms typical.

### 3.2 `agent_list_sessions` [NEW]

**Roles:** `ceo`, `pm`
**HTTP:** `GET /api/internal/agents/sessions?companyId=<id>`

```typescript
export const AgentListSessionsDataSchema = z.object({
  sessions: z.array(z.object({
    role: z.string(),
    beatId: z.string(),
    currentTaskId: z.string().nullable(),
    startedAt: z.string().datetime(),
    elapsedMs: z.number().int().nonnegative(),
  })),
  activeCount: z.number().int().nonnegative(),
});
```

**Implementation:** SELECT from `beat_sessions` WHERE status = 'active'
AND companyId = ?. Cached 5s per company.

### 3.3 `execution_get` [MODIFIED — merged from 2 tools]

**Roles:** `ceo`, `cto`, `pm`
**HTTP:** `GET /api/internal/execution?companyId=<id>`
**Replaces:** `execution_get_active` + `execution_get_status` (both retired at cutover).

```typescript
export const ExecutionGetDataSchema = z.object({
  executionCycleId: z.string(),
  phase: z.enum(["planning", "executing", "reviewing", "finalizing"]),
  status: z.enum(["executing", "awaiting_board_review", "paused", "done", "error"]),
  startedAt: z.string().datetime(),
  pausedAt: z.string().datetime().nullable(),
  reason: z.string().nullable(),
  activeSprintId: z.string().nullable(),
});
```

**Retirement mechanics:** Both old endpoints return `410 Gone` with
`{cause: "tool_retired", details: {replacement: "execution_get"}}` for
2 weeks post-cutover.

### 3.4 `company_update_status` [NEW]

**Roles:** `ceo`
**HTTP:** `POST /api/internal/company/status`
**Idempotency key:** `hash(beatId, "company_update_status", {status})`

```typescript
export const CompanyUpdateStatusInputSchema = z.object({
  status: z.string().min(1).max(500),
});

export const CompanyUpdateStatusDataSchema = z.object({
  previousStatus: z.string(),
  newStatus: z.string(),
  updatedAt: z.string().datetime(),
});
```

**Audit:** every write fires `auditAgent({role: "ceo", tool:
"company_update_status", details: {previous, new}})` via hook.

**Error causes:** `not_authorized` (only CEO can call), `status_unchanged` (same value).

---

## 4. §10 Board / comms — 2 tools

### 4.1 `board_post_message` [MODIFIED — PM row removed, cardType enum expanded]

**Roles:** `ceo` (PM dropped)
**HTTP:** `POST /api/internal/board/messages`
**Idempotency key:** `hash(beatId, "board_post_message", {content, cardType})`

```typescript
export const BoardPostMessageInputSchema = z.object({
  content: z.string().min(1).max(10_000),
  cardType: z.enum([
    "status_update",
    "strategy_proposal",
    "sprint_proposal",
    "meeting_summary",
    "escalation",
    "final_report",
    "general",
  ]).default("general"),
  cardData: z.record(z.string(), z.unknown()).optional(),
});

export const BoardPostMessageDataSchema = z.object({
  messageId: z.string(),
  postedAt: z.string().datetime(),
  visibleToBoard: z.boolean(),
});
```

**Validation:** if `cardType` ≠ "general", `cardData` must match the
per-card schema in `chatMessageCardTypeSchema`. Errors with
`card_data_invalid` + schema-path in details.

**Error causes:** `content_too_long`, `card_data_invalid`, `not_authorized` (PM attempt).

### 4.2 `board_list_messages` [NEW — replaces `board_read_inbox`]

**Roles:** `ceo`
**HTTP:** `GET /api/internal/board/messages`

```typescript
export const BoardListMessagesInputSchema = z.object({
  since: z.string().datetime().optional(),
  sinceSprint: z.number().int().positive().optional(),
  role: z.string().optional(),
  cardType: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});

export const BoardListMessagesDataSchema = z.object({
  messages: z.array(z.object({
    messageId: z.string(),
    senderRole: z.string(),
    content: z.string(),
    cardType: z.string(),
    cardData: z.record(z.string(), z.unknown()).nullable(),
    postedAt: z.string().datetime(),
  })),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
```

**`sinceSprint` filter** replaces the standalone `board_read_inbox`
tool: `sinceSprint: 3` returns all messages from sprint 3 onwards.

**Retirement:** `board_read_inbox` endpoint returns 410 Gone with
`replacement: "board_list_messages"` for 2 weeks.

---

## 5. §11 Execution control — 4 tools

### 5.1 `execution_complete_cycle` [NEW]

**Roles:** `ceo`
**HTTP:** `POST /api/internal/execution/complete`
**Idempotency key:** `hash(beatId, "execution_complete_cycle", {executionCycleId})`

```typescript
export const ExecutionCompleteCycleInputSchema = z.object({
  executionCycleId: z.string(),
  summary: z.string().min(1).max(5000),
});

export const ExecutionCompleteCycleDataSchema = z.object({
  executionCycleId: z.string(),
  finalStatus: z.literal("done"),
  completionMeetingId: z.string(),
  closedBeatCount: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
});
```

**Side effects (all in one transaction):**
1. `UPDATE execution_cycles SET status = 'done', completed_at = NOW() WHERE id = ?`
2. `meeting_record` entry with `kind: "cycle_completion"` + summary
3. `UPDATE beat_sessions SET status = 'closed' WHERE cycle_id = ? AND status = 'active'`

**Error causes:** `cycle_not_found`, `execution_locked` (cycle already in `done`/`error`), `no_completed_sprints` (refuse to close a cycle with zero completed sprints).

### 5.2 `execution_pause_for_review` [NEW]

**Roles:** `ceo`, `cto`
**HTTP:** `POST /api/internal/execution/pause`
**Idempotency key:** `hash(beatId, "execution_pause_for_review", {reason})`

```typescript
export const ExecutionPauseForReviewInputSchema = z.object({
  reason: z.string().min(10).max(2000),
  expectedResumeCondition: z.string().min(10).max(1000),
});

export const ExecutionPauseForReviewDataSchema = z.object({
  executionCycleId: z.string(),
  pausedAt: z.string().datetime(),
  blockedBeats: z.number().int().nonnegative(),
  newStatus: z.literal("awaiting_board_review"),
});
```

**Blocks new beat dispatch:** `run-beat.ts` checks `execution.status !==
"awaiting_board_review"` before scheduling; otherwise returns
`status_paused` error to caller.

**Error causes:** `already_paused`, `cycle_not_active`, `cto_reason_too_short` (CTO must give 40+ char reason; policy check in handler).

### 5.3 `execution_reconcile_post_review` [NEW]

**Roles:** `ceo`
**HTTP:** `POST /api/internal/execution/reconcile`
**Idempotency key:** `hash(beatId, "execution_reconcile_post_review", {nextAction})`

```typescript
export const ExecutionReconcilePostReviewInputSchema = z.object({
  nextAction: z.enum(["resume", "restart_sprint", "complete_cycle", "stop"]),
  reason: z.string().min(10).max(2000),
});

export const ExecutionReconcilePostReviewDataSchema = z.object({
  previousStatus: z.literal("awaiting_board_review"),
  newStatus: z.enum(["executing", "executing", "done", "error"]),  // maps from nextAction
  actionTaken: z.string(),
  resumedBeatCount: z.number().int().nonnegative(),
});
```

**Action mapping:**

| `nextAction` | Effect |
|---|---|
| `resume` | Status → `executing`; beats unblocked |
| `restart_sprint` | Roll back active sprint to `planning`; clear task progress; status → `executing` |
| `complete_cycle` | Delegate to `execution_complete_cycle` internally |
| `stop` | Delegate to `execution_stop` internally |

**Error causes:** `not_awaiting_review` (status isn't `awaiting_board_review`), `invalid_next_action`.

### 5.4 `execution_stop` [NEW]

**Roles:** `ceo`
**HTTP:** `POST /api/internal/execution/stop`
**Idempotency key:** `hash(beatId, "execution_stop", {reason})`

```typescript
export const ExecutionStopInputSchema = z.object({
  reason: z.string().min(10).max(2000),
  graceful: z.boolean().default(true),
});

export const ExecutionStopDataSchema = z.object({
  executionCycleId: z.string(),
  finalStatus: z.enum(["stopped", "error"]),
  tasksMarkedBlocked: z.number().int().nonnegative(),
  activeBeatsClosed: z.number().int().nonnegative(),
  requiresReEnable: z.literal(true),
});
```

**Side effects (transactional):**
1. `UPDATE execution_cycles SET status = 'stopped' WHERE id = ?`
2. `UPDATE tasks SET status = 'blocked', block_reason = 'execution_stopped_by_ceo: ' || ? WHERE status IN ('in_progress', 'pending') AND sprint_id IN (<cycle sprints>)`
3. `UPDATE beat_sessions SET status = 'closed' WHERE cycle_id = ? AND status = 'active'`

**Error causes:** `already_stopped`, `cycle_not_found`.

**Re-enable:** via `POST /api/admin/execution/re-enable` — admin-only,
not a tool.

---

## 6. Retired endpoints (§8, §13, §14, §16 drops)

All retired endpoints return `410 Gone` with envelope:

```json
{
  "status": "error",
  "summary": "This tool has been retired.",
  "data": null,
  "error": {
    "cause": "tool_retired",
    "message": "Use <replacement> instead.",
    "details": {
      "retiredIn": "spec-27",
      "retiredAt": "2026-04-23",
      "replacement": "<new tool name or 'built-in: <name>' or 'dropped'>"
    }
  }
}
```

### 6.1 §8 retired (11 endpoints)

| Endpoint | Replacement |
|---|---|
| `/api/internal/workspace/read-file` | `built-in: read` |
| `/api/internal/workspace/write-file` | `built-in: write` |
| `/api/internal/workspace/edit-file` | `built-in: edit` |
| `/api/internal/workspace/grep` | `built-in: grep` |
| `/api/internal/workspace/list-files` | `built-in: glob` |
| `/api/internal/workspace/diff` | `built-in: bash("git diff")` |
| `/api/internal/workspace/run-command` | `built-in: bash` with `permission.bash` |
| `/api/internal/workspace/get-head` | `built-in: bash("git rev-parse HEAD")` |
| `/api/internal/workspace/init-git` | `built-in: bash("git init")` |
| `/api/internal/workspace/commit` | `workspace_checkpoint` |
| `/api/internal/workspace/create-tag` | `built-in: bash("git tag sprint-N")` |
| `/api/internal/workspace/install-package` | `built-in: bash("bun add <pkg>")` (ask-gated) |

### 6.2 §13 retired (6 endpoints)

| Endpoint | Replacement |
|---|---|
| `/api/internal/trust/agent-score` | `dropped` (policy-exfil; admin dashboard) |
| `/api/internal/trust/list-scores` | `dropped` |
| `/api/internal/audit/self-recent` | `dropped` |
| `/api/internal/audit/query-recent` | `dropped` |
| `/api/internal/audit/attest` | `dropped` |
| `/api/internal/audit/request-review` | `dropped` |

### 6.3 §14 retired (5 endpoints — if they existed as scaffolding)

| Endpoint | Replacement |
|---|---|
| `/api/internal/planner/build-task-graph` | `skill: plan-task-graph` + `task_create` |
| `/api/internal/planner/decompose-task` | `skill: plan-task-graph` (decomposition mode) |
| `/api/internal/planner/pick-skills-for-task` | `buildBeatContext: progressive catalog` |
| `/api/internal/plan-health/check` | `skill: plan-health-review` |
| `/api/internal/plan-health/regenerate-task` | `task_update` / `task_create` guided by `plan-health-review` |

### 6.4 §16 retired (5 endpoints — never built, preemptive 410)

| Endpoint | Replacement |
|---|---|
| `/api/internal/ping` | `GET /api/health` (plugin-boot only) |
| `/api/internal/who-am-i` | `cpLoadAgentContext` (injected in system prompt) |
| `/api/internal/beat/heartbeat` | `hook: beat_watchdog_reset` |
| `/api/internal/envelope/idempotency-hash` | `middleware: deriveIdempotencyKey` (spec 25) |
| `/api/internal/self/append-instruction` | `dropped` (use `memory_add_learning` + Skill-Evolution) |

---

## 7. Progressive-disclosure skill catalog

### 7.1 Source data

Every `.opencode/skills/<id>/SKILL.md` frontmatter already carries:

```yaml
---
name: plan-task-graph
description: Draft a task DAG for a sprint (CTO) or decompose a large task into subtasks (PM/CTO). In-beat reasoning — no SVC.
role: cto, pm
trigger: sprint kickoff with an approved rationale, or a mid-sprint task that is too big to execute in one beat
---
```

We read `name`, `description`, `trigger`, `role` from each file in
`.opencode/skills/` at `buildBeatContext` time.

### 7.2 `buildBeatContext` changes

```typescript
// apps/api/src/orchestration/buildBeatContext.ts

interface BeatContext {
  // ... existing fields
  availableSkills: SkillCatalogEntry[];  // NEW
}

interface SkillCatalogEntry {
  id: string;
  one_liner: string;  // = description
  trigger: string;
}

async function loadSkillCatalog(role: string, companyId: string): Promise<SkillCatalogEntry[]> {
  const skillsDir = path.join(companyWorkspaceDir(companyId), ".opencode/skills");
  const entries = await fs.readdir(skillsDir);
  const catalog: SkillCatalogEntry[] = [];
  for (const slug of entries) {
    const skillPath = path.join(skillsDir, slug, "SKILL.md");
    const fm = await parseFrontmatter(skillPath);
    const roles = splitRoles(fm.role); // "cto, pm" → ["cto", "pm"]
    if (!roles.includes(role) && !roles.includes("all")) continue;
    catalog.push({
      id: fm.name,
      one_liner: truncateToOneLine(fm.description, 160),
      trigger: truncateToOneLine(fm.trigger, 200),
    });
  }
  // Budget: cap at 40 entries by EMA descending (join with skill_usage table)
  return await budgetAndSort(catalog, role, companyId);
}
```

### 7.3 System-prompt injection

Added to the role's system prompt assembly:

```
## Available skills — call `skill({id})` when a trigger matches

- plan-task-graph (cto, pm): Draft a task DAG or decompose a large task in-beat
  trigger: sprint kickoff with an approved rationale, or a mid-sprint task too big for one beat
- plan-health-review (cto): In-beat staleness check + regeneration
  trigger: start of a CTO beat when sprint ≥ 30% complete, or a finding invalidates downstream work
- [... up to 40 entries]

Pick by calling the `skill` built-in with the ID. Do not request skills that aren't listed.
```

### 7.4 Retire `classifyTaskSkills`

```typescript
// apps/api/src/orchestration/run-beat.ts — BEFORE

const skillIds = await classifyTaskSkills({ task, role });  // <-- DELETE
const skills = await loadSkills(skillIds);
const systemPrompt = assemble({ ..., skills });

// AFTER

const availableSkills = await loadSkillCatalog(role, companyId);
const systemPrompt = assemble({ ..., availableSkills });
// agent picks at runtime via `skill({id})` built-in call
```

Delete `apps/api/src/skills/classifier.ts` after 1-week shadow parity.

### 7.5 EMA fueling (unchanged)

`recordSkillUsage` hook already reads the chosen skill ID from
`tool.execute.after` on `skill` tool calls. No changes needed — it just
now reads from agent-initiated calls instead of pre-picked.

---

## 8. `beat_watchdog_reset` hook

### 8.1 Registration

```typescript
// .opencode/plugin/arceus.ts — add to hooks["tool.execute.after"]

hooks["tool.execute.after"].push(async (ctx) => {
  if (!ctx.beatId) return;
  try {
    await resetBeatWatchdog(ctx.beatId);
  } catch (err) {
    // Never throw from a PostToolUse hook
    logger.warn("beat_watchdog_reset failed", { err, beatId: ctx.beatId });
  }
});
```

### 8.2 `resetBeatWatchdog` implementation

```typescript
// apps/api/src/orchestration/watchdog.ts

const watchdogTimers = new Map<string, NodeJS.Timeout>();
const WATCHDOG_TIMEOUT_MS = 5 * 60_000;  // 5 min idle → stall

export async function resetBeatWatchdog(beatId: string): Promise<void> {
  const existing = watchdogTimers.get(beatId);
  if (existing) clearTimeout(existing);
  watchdogTimers.set(beatId, setTimeout(() => handleStall(beatId), WATCHDOG_TIMEOUT_MS));
}
```

### 8.3 Retire `beat_heartbeat` MCP registration

Remove from `packages/arceus-mcp/src/tools/misc/beat-heartbeat.ts`
(delete file). Add 410 Gone entry for the endpoint.

---

## 9. Two new skills materialized

### 9.1 Source files (already written in this spec cycle)

- `.arceus/skills-seed/plan-task-graph/SKILL.md`
- `.arceus/skills-seed/plan-health-review/SKILL.md`

### 9.2 Materialization on new-company seed

`scripts/seed-company.ts` already copies `.arceus/skills-seed/*` into
`apps/api/workspace/<companyId>/.opencode/skills/`. No code change
needed — the two new skill directories just get picked up on next seed.

### 9.3 One-time backfill for existing companies

```typescript
// scripts/materialize-new-skills.ts
import { copyFile, mkdir } from "fs/promises";
import { listCompanies } from "../apps/api/src/persistence/companies";

const NEW_SKILLS = ["plan-task-graph", "plan-health-review"];

for (const company of await listCompanies()) {
  for (const slug of NEW_SKILLS) {
    const src = `.arceus/skills-seed/${slug}/SKILL.md`;
    const dest = `apps/api/workspace/${company.id}/.opencode/skills/${slug}/SKILL.md`;
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
    console.log(`Materialized ${slug} into company ${company.id}`);
  }
}
```

Run once on deploy day for P5.

### 9.4 Add to per-role allowlists

Update `.opencode/agent/cto.md` and `.opencode/agent/pm.md` — but
**allowlist is implicit** from the progressive catalog (skills the role
can see = skills whose frontmatter `role:` includes this role). No
explicit allowlist edit needed.

---

## 10. Two anti-pattern deletions

### 10.1 `generateWorkflowTaskPlan`

**File:** `apps/api/src/tasks/planner.ts`
**Action:** delete function and its call sites. CTO now does the DAG
in-beat via `plan-task-graph` skill + `task_create`×N.

**Grep for call sites:**

```bash
rg "generateWorkflowTaskPlan\(" apps/ packages/ --type ts
```

Expected call sites (from anti-patterns doc):
1. `apps/api/src/sprints/proposals.ts` — in CEO sprint-proposal path
2. `apps/api/src/tasks/planner.ts` — self-reference (the function itself)

**Replace with:**

```typescript
// In sprint-proposal path: no pre-generated DAG. CEO's proposal carries the high-level
// goal + initial task shape; CTO in its kickoff beat calls `plan-task-graph` skill + `task_create`.
// The orchestrator no longer generates the DAG — CTO owns that reasoning.
```

### 10.2 `classifyTaskSkills`

**File:** `apps/api/src/skills/classifier.ts`
**Action:** delete function. If the file becomes empty, delete the file.

**Grep for call sites:**

```bash
rg "classifyTaskSkills\(" apps/ packages/ --type ts
```

Expected:
1. `apps/api/src/orchestration/run-beat.ts` — removed in §7.4
2. Possibly in test files — delete tests too.

### 10.3 Shadow parity phase (1 week before deletion)

Before deleting, run **both** old and new paths in shadow mode:

```typescript
// apps/api/src/orchestration/run-beat.ts (during shadow phase)

const oldPicks = await classifyTaskSkills({ task, role }).catch(() => []);
const newCatalog = await loadSkillCatalog(role, companyId);
logSkillPickComparison({ taskId, role, oldPicks, newCatalogIds: newCatalog.map(e => e.id) });

// Use `newCatalog` (new path) for the actual beat.
// `oldPicks` is captured for parity analysis.
```

After 1 week, review `skill_pick_comparison` logs:
- If newCatalog ⊇ oldPicks in ≥ 90% of cases → delete old path
- If < 90% → investigate gap, potentially adjust catalog sorting

---

## 11. Migration phase plan

### Phase P1 — §8 Workspace + `permission.bash` (~4 days)

**Flag:** `ARCEUS_TOOL_V2_WORKSPACE`

**Day 1:** New MCP registrations
- Add `workspace_get_build_health`, `workspace_check_exports`, `workspace_verify_baseline` to `packages/arceus-mcp/src/tools/workspace/`
- Add routes in `apps/api/src/routes/internal-mcp/workspace.routes.ts`
- Add Zod schemas in `packages/contracts/src/workspace.ts`

**Day 2:** Role-custom tools
- Write `developer/run_typecheck.ts`
- Write 4 QA tools (`capture_browser_probe`, `collect_evidence`, `run_acceptance_suite`, `diff_against_criteria`)
- Install Playwright as qa bundle dep

**Day 3:** `permission.bash` rollout
- Update 8 `.opencode/agent/<role>.md` with per-role bash patterns
- Remove 11 dropped tool names from `allowedTools` arrays
- Add `workspace_preview_probe` → `workspace_probe_preview` rename

**Day 4:** 410 Gone + tests
- Add 410 handlers for 11 retired endpoints
- Integration tests: verify built-ins work for each retired-tool use case
- Flag enabled in staging; 48h smoke test

**Atomic commits (in order):**
1. `feat(workspace): add 3 new MCP tools + schemas`
2. `feat(workspace): add 5 role-custom QA + dev tools`
3. `chore(agents): update permission.bash + drop 11 workspace tools from allowlists`
4. `chore(workspace): rename workspace_preview_probe → workspace_probe_preview`
5. `feat(workspace): add 410 Gone for retired endpoints`
6. `test(workspace): integration + built-in parity`
7. `feat(flag): ARCEUS_TOOL_V2_WORKSPACE default off`

### Phase P2 — §9 + §10 + §11 (~3 days)

**Flag:** `ARCEUS_TOOL_V2_CTX`

**Day 1:** §9 Company/agent context
- Schemas + routes for `company_get_summary`, `agent_list_sessions`, `execution_get`, `company_update_status`
- 410 for `execution_get_active`, `execution_get_status`, `agent_get_context`, `company_bootstrap`, `company_set_active_sprint`

**Day 2:** §10 Board/comms + §11 Execution
- `board_list_messages` new, `board_post_message` modified (drop PM)
- 4 execution routes + transactional handlers
- 410 for `board_read_inbox`, `execution_approve_sprint`

**Day 3:** Tests + flag
- Unit tests per tool
- Integration tests for `execution_pause_for_review` → `execution_reconcile_post_review` flow
- Allowlist regression tests

**Atomic commits:**
1. `feat(company): 4 MCP tools + schemas + routes`
2. `feat(board): board_list_messages + cardType expansion`
3. `feat(execution): 4 MCP tools with transactional handlers`
4. `chore(mcp): 410 Gone for 7 retired endpoints`
5. `test: §9/§10/§11 integration`
6. `feat(flag): ARCEUS_TOOL_V2_CTX default off`

### Phase P3 — Progressive-disclosure skill catalog (~2 days, parallel to P1/P2)

**Flag:** `ARCEUS_TOOL_V2_SKILL_CATALOG`

**Day 1:** Catalog loader
- `loadSkillCatalog(role, companyId)` reads frontmatter from `.opencode/skills/*/SKILL.md`
- `budgetAndSort` — 40-cap, EMA-desc
- System-prompt injection template

**Day 2:** Shadow mode
- Run `classifyTaskSkills` in parallel to new catalog
- Log `skill_pick_comparison` for 7 days
- Do NOT delete `classifyTaskSkills` yet — that's Phase P5

**Atomic commits:**
1. `feat(beatContext): progressive-disclosure skill catalog loader`
2. `feat(beatContext): inject catalog into role system prompt`
3. `feat(telemetry): skill_pick_comparison shadow logging`
4. `feat(flag): ARCEUS_TOOL_V2_SKILL_CATALOG default off`

### Phase P4 — §13 Trust/audit drop + watchdog hook (~1 day)

**Flag:** `ARCEUS_TOOL_V2_DROPS`

- Delete 6 trust/audit MCP registrations
- Add 410 for 6 endpoints
- Register `beat_watchdog_reset` hook in `.opencode/plugin/arceus.ts`
- Drop `beat_heartbeat` endpoint with 410

**Atomic commits:**
1. `chore(trust): delete 6 MCP registrations; add 410 Gone`
2. `feat(hook): beat_watchdog_reset PostToolUse`
3. `chore(misc): retire beat_heartbeat endpoint`
4. `feat(flag): ARCEUS_TOOL_V2_DROPS default off`

### Phase P5 — §14 Planning drop + skills + deletions (~2 days, depends on P3 stable)

**Flag:** `ARCEUS_TOOL_V2_PLANNING`

**Prerequisite:** P3's shadow parity ≥ 90% for 7 consecutive days.

**Day 1:** Materialize skills + add to progressive catalog
- Run `scripts/materialize-new-skills.ts` for every existing company
- Verify `plan-task-graph` appears in CTO/PM role catalog on next beat
- Verify `plan-health-review` appears in CTO role catalog

**Day 2:** Delete anti-pattern functions
- Delete `generateWorkflowTaskPlan` + call sites (CEO sprint-proposal path no longer pre-generates DAG; CTO generates in-beat)
- Delete `classifyTaskSkills` + call sites
- Add 410 Gone for 5 §14 endpoints (if they existed as scaffolding)

**Atomic commits:**
1. `feat(skills): materialize plan-task-graph + plan-health-review`
2. `refactor(tasks): delete generateWorkflowTaskPlan standalone call`
3. `refactor(skills): delete classifyTaskSkills standalone call`
4. `chore(planner): 410 Gone for 5 retired endpoints`
5. `feat(flag): ARCEUS_TOOL_V2_PLANNING default off`

### Phase P6 — §16 Misc drop + cutover (~1 day, after P1–P5 green)

**Flag:** `ARCEUS_TOOL_V2_MISC` (final)

- Drop 5 §16 MCP registrations
- Add 410 Gone entries
- Add `GET /api/health` route (if not present)
- Document `deriveIdempotencyKey` + `cpLoadAgentContext` as §19 internal homes in `05-tool-catalog.md`
- **Flip all 6 flags on in prod**
- Monitor 410 traffic; after 2 weeks < 10 calls/day per endpoint, delete endpoints

**Atomic commits:**
1. `chore(misc): drop 5 tool registrations + 410 Gone`
2. `feat(health): GET /api/health for plugin boot`
3. `docs(catalog): finalize §19 internal-op homes`
4. `feat(flag): ARCEUS_TOOL_V2_MISC default off`
5. (separate day, all-flags-on) `feat(flags): enable ARCEUS_TOOL_V2_* in production`
6. (2 weeks later) `chore(cleanup): delete retired endpoints`

---

## 12. Test matrix

### 12.1 Per-tool unit tests

Every tool in §2–§5 gets:
- Happy-path test (valid input → success envelope)
- Each error cause test (trigger condition → expected envelope shape)
- Idempotency test (2× call, same key → same result)
- Authorization test (non-allowlisted role → `not_authorized`)

### 12.2 Integration tests per phase

| Phase | Test |
|---|---|
| P1 | Developer runs `workspace_verify_baseline` → composite check returns correct aggregation; built-in `bash("git diff")` works for ex-`workspace_diff` use case |
| P2 | CEO calls `execution_pause_for_review` → all active beats blocked on next dispatch; `execution_reconcile_post_review({nextAction: "resume"})` unblocks |
| P3 | CTO's system prompt after `buildBeatContext` contains `plan-task-graph` catalog entry with correct trigger line |
| P4 | Agent attempting `trust_get_agent_score` receives 410 Gone with replacement pointer; `beat_watchdog_reset` hook fires on every tool call (verify via telemetry) |
| P5 | CTO sprint-kickoff beat invokes `skill({id: "plan-task-graph"})` ≥ 80% of runs (measure over 10 simulated kickoffs); `generateWorkflowTaskPlan` has zero runtime calls |
| P6 | `GET /api/health` returns `{ok: true}` within 100ms; plugin boot uses it and proceeds |

### 12.3 Cross-cutting tests

- **Flag off** → all new tools return 404; retired endpoints still return 200 (pre-flag behavior)
- **Flag on** → new tools return 200 with envelope; retired return 410
- **410 envelope shape** → matches spec 26 §2.1 envelope with `cause: "tool_retired"`
- **Progressive catalog budget** → inject 100 synthetic skills, verify truncation to 40 with EMA ordering preserved

### 12.4 Allowlist regression

After P1–P6, for every role × every tool, verify via `governance/buildPolicyForRole`:

```typescript
describe("allowlist post-spec-27", () => {
  for (const role of ROLES) {
    test(`${role}: only expected tools`, () => {
      const policy = buildPolicyForRole(role);
      expect(policy.allowedTools).toEqual(EXPECTED[role]);  // ~44–58 per role
      for (const dropped of DROPPED_TOOLS) {
        expect(policy.allowedTools).not.toContain(dropped);
      }
    });
  }
});
```

---

## 13. Observability

### 13.1 Structured events (spec 25 compatible)

Every tool call emits:

```typescript
{
  event: "tool_call",
  spec: "27",
  tool: "workspace_verify_baseline",
  role: "developer",
  beatId: "beat_123",
  companyId: "co_abc",
  latencyMs: 8_400,
  status: "success" | "partial" | "error",
  causeIfError: null | "baseline_failed",
  idempotencyKey: "<hex>",
}
```

### 13.2 Category-specific metrics

| Metric | Source |
|---|---|
| `workspace.verify_baseline.pass_rate` | Grouped by company + sprint |
| `workspace.typecheck.cache_hit_rate` | From role-custom dev tool state |
| `execution.pause.duration_ms` | `pausedAt` → `reconciledAt` |
| `execution.stop.reason_category` | LLM-classified from `reason` field, bucketed |
| `board.post_message.card_type_distribution` | Per-cardType counts |
| `skill_catalog.inject_ms` | `buildBeatContext` subphase timer |
| `skill_catalog.entries_per_role` | Gauge |
| `skill_pick.shadow_parity` | % where new catalog ⊇ old picks (P3 only) |

### 13.3 Dashboards

- **Tool surface health** — p50/p95 latency per tool, error-cause distribution
- **Retirement decay** — 410 calls/day per endpoint (target decay to < 10)
- **Skill invocation** — EMA per skill, invocation rate at trigger points (e.g. sprint-kickoff → `plan-task-graph`)

---

## 14. Rollout checklist

Before flipping all 6 flags in production:

- [ ] P1 shadow in staging 48h — no regressions in workspace ops
- [ ] P2 shadow in staging 48h — `execution_get` merged result matches old pair
- [ ] P3 shadow parity ≥ 90% for 7 consecutive days
- [ ] P4 hook verified firing on every tool call in staging
- [ ] P5 materialization script dry-run on backup company list
- [ ] P6 `/api/health` returns < 100ms p95
- [ ] Every `.opencode/agent/<role>.md` diff reviewed by 2 platform engineers
- [ ] Admin audit/trust dashboard status: acknowledged as follow-on, not blocking
- [ ] Rollback plan per phase rehearsed (flag flip + revert commits identified)
- [ ] Documentation published: team README + `05-tool-catalog.md` final counts + `27-tool-catalog-integration-continued.md` linked
- [ ] Ops queries for interim trust/audit via Supabase studio documented in runbook

---

## 15. References

- [`27-tool-catalog-integration-continued.md`](./27-tool-catalog-integration-continued.md) — scope + phase narrative
- [`05-tool-catalog.md`](../agent-redesign/05-tool-catalog.md) — final tool surface
- [`26-tool-catalog-integration.md`](./26-tool-catalog-integration.md) — §1–§5 MCP (precedes)
- [`26-implement.md`](./26-implement.md) — spec 26 implementable edition (contracts foundation inherited here)
- [`24-agent-philosophy-refactor.md`](./24-agent-philosophy-refactor.md) — Facilitator SVC
- [`25-agent-auth-idempotency.md`](./25-agent-auth-idempotency.md) — envelope + idempotency middleware
- [`.arceus/skills-seed/plan-task-graph/SKILL.md`](../../.arceus/skills-seed/plan-task-graph/SKILL.md) — skill source
- [`.arceus/skills-seed/plan-health-review/SKILL.md`](../../.arceus/skills-seed/plan-health-review/SKILL.md) — skill source
