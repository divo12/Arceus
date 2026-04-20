# Agent Redesign — DONE (Phase 0 → pre-6.5)

> Self-contained record of everything shipped before the Phase 6.5 heartbeat runtime. You should not need to open `plans/24-ops-harness-plan.md` to understand what's here. The companion doc `02-todo-phase-65-onwards.md` describes what still needs to ship.

---

## 0. Mission statement

Convert 24 orchestrator-called functions (state mutations, memory writes, artifact management, approvals, meetings, governance, skill CRUD, sprint lifecycle) into **agent-invoked tools**. Route via:

- `packages/arceus-mcp` — the stable, cross-harness MCP contract (21 tools: 20 ops + `tool_help`)
- In-process OpenCode plugin `.opencode/plugin/arceus.ts` — governance + circuit breaker + audit
- 3 Tier-A custom tools in `.opencode/tool/*.ts` — hot-loop append/progress ops

End state: `specialist-executor.ts` collapses from ~350 lines of role-specific `if/else` to nothing (it's deleted outright in Phase 8). **Agents drive their own state transitions**, inside a harness that makes correct behavior the cheap default.

### Non-goals

- Removing the other ~180 orchestrator-internal ops (governance, telemetry, state mutators stay put).
- Changing `SkillArtifact` lifecycle, EMA, or the ATA pipeline.
- Native `experimental.mcp_lazy` — track OpenCode PR #12520; approximate via per-role scoping.

---

## 1. The four harness pillars — every decision is framed by these

| Pillar | Applied decision |
|---|---|
| **Action space** | 24 ops → 3 tiers by call frequency. Stable `verb_noun` names. Narrow Zod schemas. No catch-all tools. Idempotency keys on mutators. |
| **Observation** | Single `ToolResult<T>` envelope: `{status, summary, data?, next_actions?, artifacts?, error?}`. Nothing else returned, ever. |
| **Recovery** | Every error path returns `{cause, retry, stop_when}`. 15-min hard session cap (lands in 6.5 package J). Circuit breaker refuses after 3× same `(tool_id, error.cause)`. |
| **Context budget** | Per-role eager catalog ≤10 tools. Tool descriptions ≤1 sentence / ≤160 chars (lint-enforced). Full schemas behind `tool_help(id)`. Deep examples in `SKILL.md resources/`. |

---

## 2. Tool taxonomy — the 24 ops

### Tier A — In-process OpenCode plugin (3 tools)

Hot-loop, called per-tool-result or every 5–30s. Stdio round-trip unacceptable.

| Tool | Source | Frequency |
|---|---|---|
| `task_update_progress` | `updateTaskProgress` | every 5–30s during work |
| `task_append_command` | `appendTaskCommand` | per shell invocation |
| `task_append_plan_step` | `appendTaskPlanStep` | per planning tick |

> **v1 scope:** no `skill_record_usage` *tool*. Skill-usage telemetry is recorded via the plugin's `tool.execute.after` hook — when `input.tool === "skill"`, the plugin POSTs to `/api/internal/telemetry/skills/:skillId/usage` using the `arceus-skills.json` manifest to resolve `slug → skillId`. This keeps skill invocation identical to upstream OpenCode (no custom MCP tool) while still feeding the registry.

### Tier B — MCP, eager per role (12 tools)

Stable contracts, 1–10 calls per beat. ≤160-char descriptions. Only the ones a role allows are injected.

| Tool | Source | Roles |
|---|---|---|
| `task_complete` | `setTaskStatus(…, "completed")` | all executors |
| `task_block` | `setTaskStatus(…, "blocked")` | all executors |
| `task_append_result` | `appendTaskResult` | all executors |
| `task_set_preview_url` | `setTaskPreviewUrl` | developer, designer |
| `task_verify` | `setTaskVerified` | tester, reviewer |
| `artifact_create` | `addArtifact` | all executors |
| `artifact_write_to_workspace` | `writeArtifactToWorkspace` | developer, designer, marketing |
| `memory_enrich` | `enrichRoleMemory` | all executors (**removed from Phase 5 allowlists by user decision — memory deferred**) |
| `memory_clear_blockers` | `clearRoleBlockers` | all executors (**deferred**) |
| `memory_handoff` | generalized from `deliverUiDesignerMemoryHandoff` | designer, skills_lead, tester (**deferred**) |
| `workspace_checkpoint` | `syncWorkspaceCheckpoint` | developer, skills_lead |
| `workspace_probe_preview` | preview probe + report URL | developer |

> **Memory tools status:** The three memory tools (`memory_enrich` / `memory_clear_blockers` / `memory_handoff`) are implemented server-side but **removed from per-role allowlists** (Phase 5 config) per user decision to postpone the memory work. They re-enter the allowlist when the memory integration is prioritized.

### Tier C — MCP, role-scoped rare (8 tools)

One or two roles only; other roles see `tools: { X: false }` — effectively deferred. Surface via `arceus_tool_search` (Phase 9) when a role needs them ad-hoc.

| Tool | Source | Allowed roles |
|---|---|---|
| `task_create` | `upsertTask` | ceo, pm |
| `task_update` | `updateTask` (field-whitelisted) | pm |
| `task_hydrate_from_spec` | `hydrateTaskFromSpec` | ceo |
| `task_attach_artifact` | `attachArtifactToTask` | all (fallback) |
| `artifact_persist` | `persistRuntimeArtifact` | pm, skills_lead |
| `meeting_record` | `recordMeeting` | ceo, pm, skills_lead |
| `approval_request` | generalized `createMarketingExternalApproval` | marketing, skills_lead, pm |
| `sprint_propose` | `triggerCeoSprintProposal` | ceo |

**Effective per-role surface: 6–10 tools.** Injected catalog token footprint budgeted < 2,500 tokens per beat. Phase 5 measurement confirms this — see §5.7 below.

### Idempotency modes (cross-beat safety)

| Mode | Key | Applies to |
|---|---|---|
| **Natural** (business-key) | `task_id` (or `artifact_id`, `sprint_id`) — second call no-ops if state already matches | `task_complete`, `task_block`, `task_verify`, `task_set_preview_url`, `workspace_checkpoint` |
| **Content-hash** | `(target_id, sha256(payload))` — identical content dedupes, new content appends | `task_append_plan_step`, `task_append_result`, `memory_enrich`, `artifact_create` |
| **Beat-scoped** | `(beat_id, op_id)` — append-only, intentional repeats across beats | `task_append_command`, `task_update_progress` |

The route adapter picks the mode from a per-op config. The `Idempotency-Key` header carries the mode's key; duplicate keys return the original response with `status: "success"` (no side effects).

---

## 3. Progressive disclosure — three gaps folded into the design

### Gap 1 — Index tier: ≤1-sentence tool descriptions

Every MCP `description` field is one sentence, no examples, no caveats. Lint rule in `packages/arceus-mcp` pre-commit: **fail if any `description.length > 160` chars.**

```
BAD  (220 tokens): "task_complete marks a task as completed. This should be called
                   when the agent has finished all work for the task. It will
                   trigger downstream events including board notifications…"
GOOD  (22 tokens): "Mark a task completed. Returns the new task state and any
                   unblocked dependents."
```

### Gap 2 — Detail tier: `tool_help(tool_id)` meta-tool

One eager tool per role. Reads from a generated `TOOL_INDEX.json` (built at MCP server startup). Returns full params, examples, error codes, related tools.

Cost: 1 slot in the eager catalog; unlocks Detail tier for all 24 on demand.

### Gap 3 — Deep tier: `SKILL.md resources/` subdir

Examples, error-recovery recipes, and long-form prose live as siblings of `SKILL.md`. The skill body **references** them by path; agents read only when cited.

```
.arceus/skills-seed/task-completion-checklist/
  SKILL.md                 ← tier-2 (loaded with the skill)
  resources/
    evidence-templates.md  ← tier-3 (loaded only if SKILL.md cites it)
    common-failures.md
```

### Gap 4 — Optional bridge: `arceus_tool_search` (Phase 9)

Activated per-beat via `ARCEUS_TOOL_SEARCH=true` when eager catalog tokens creep past budget. Surfaces Tier C tools without adding them to the role's eager list. Almost certainly not needed — see Phase 9 in doc 2.

### Cost & side-effect annotations in descriptions

Per MCP best practice — tools with rate limits, costs, or non-local side effects must say so in the description (within the 160-char budget):

```
task_complete      — "Mark a task completed. Triggers board notifications."
artifact_persist   — "Upload artifact to Supabase storage. Bandwidth cost."
sprint_propose     — "Trigger a CEO sprint proposal (LLM call, ~$0.05)."
```

Pre-commit hook flags any tool handler that touches network/storage but whose description doesn't hint at the side effect.

---

## 3.5 — MCP primitives: Tools vs Resources vs Prompts

| Primitive | Semantics | Our use |
|---|---|---|
| **Tool** | Action the agent invokes. Takes params, returns result. | **All 24 ops.** Every one is a mutation or a parameterized read. |
| **Resource** | Read-only data fetched by URI. Discoverable via `resources/list`. No params. | **Candidate v2 promotion:** `tool_help` could become `arceus://tool/{id}` resources — semantically purer, natively discoverable, zero params. *Kept as a tool in v1 for harness portability (OpenCode's Resource-surfacing behavior varies by version).* |
| **Prompt** | Parameterized template the **user/client** surfaces in UI. Not agent-facing. | **Not used.** Skills are agent-facing procedural knowledge; wrong audience for Prompts. |

**Rule:** in v1, every entry in §2 is a Tool. Revisit Resource promotion for read-only metadata (`tool_help`, `TOOL_INDEX`) once OpenCode's Resource behavior is measured.

---

## 3.6 — Skill loading: registry-first via filesystem materialization

**Arceus does NOT build or inject a skill catalog into the prompt.** OpenCode's native Tier-1 `<available_skills>` block reads directly from the materialized `.opencode/skills/` directory at session start — that's the selection layer. Progressive disclosure (Index → Detail → Deep) is OpenCode's built-in `skill` tool + SKILL.md `resources/` pattern, not Arceus code.

**Source of truth is the `SkillArtifact` registry** (`packages/company-runtime/src/skill-registry.ts`), not a static directory. Before every beat, `materializeBeatSkills` queries the registry for `{companyId, role, trustBand}` → `active` artifacts, and writes each as an `.opencode/skills/<slug>/SKILL.md` file into the beat's isolated workdir. The filesystem is a materialized **view** of the registry for this one beat.

**What this deletes** (in Phase 8):
- `buildSkillCatalog` / `buildSkillSection` / `buildSkillMenu` / `getSkillBody` from `apps/api/src/skills/catalog.ts` — the entire pre-beat prompt injection path.
- `classifyTaskSkills` / `matchAndRecordSkills` from `apps/api/src/skills/classifier.ts` — LLM-based pre-selection is redundant; OpenCode selects from the materialized catalog natively.
- The `matchedSkillIds` parameter threaded through `runPromptText` at `apps/api/src/prompts/llm.ts:176` — catalog now comes from the filesystem, not the prompt.

**What this added in v1** (Phase 6, shipped):
- `resources: SkillResource[]` field on `skillArtifactSchema`. Each resource: `{ path, kind: "script"|"reference"|"asset", contentType, content, encoding: "utf8"|"base64" }`. In-memory registry for now (no Postgres migration yet — the registry is a module-level singleton).
- `materializeBeatSkills({ beatId, companyId, role, trustBand, workDir })` queries `registry.getSkillsForRole(companyId, role)` (filtered to `status === "active"` and trust-band policy), writes SKILL.md + `resources/` per artifact + `arceus-skills.json` manifest.
- **Usage back-channel via plugin hook, not an MCP tool.** Plugin's `tool.execute.after` filters on `input.tool === "skill"`, resolves slug → `{skillId, version}` via manifest, POSTs to `/api/internal/telemetry/skills/:skillId/usage` (fire-and-forget).
- **EMA update on beat verdict** happens in Phase 6.5 (package J's `finally` block). The registry function `updateSuccessRate(skillId, outcome)` exists today; caller wiring comes later.

**SDK caveat:** The opencode integration plan referenced a `session.idle` hook for aggregated skill-usage flushing. SDK `@opencode-ai/plugin@1.3.17` has no such hook — per-call POST in `tool.execute.after` is the v1 substitute. If `session.idle` lands in a later SDK, we batch.

**Authoring UX (v1): seed-time only.** The developer-facing authoring surface is `.arceus/skills-seed/<slug>/SKILL.md + resources/`. `seedExistingSkillsDetailed()` walks this tree at boot and upserts into the registry. Runtime authoring (agents creating/editing skills mid-beat) is deferred.

---

## 4. The single tool contract — `ToolResult<T>`

Every Tier A/B/C tool returns the same shape. No exceptions. Defined once in `@arceus/contracts`:

```typescript
export interface ToolResult<T = unknown> {
  status: "success" | "warning" | "error";
  summary: string;                      // one line, human-readable
  data?: T;                             // typed payload
  next_actions?: string[];              // what the agent should consider next
  artifacts?: Array<{
    id: string;
    path?: string;
    kind: string;
  }>;
  error?: {
    cause: string;                      // root-cause hint
    retry: "safe" | "unsafe" | "never";
    stop_when: string;                  // explicit give-up condition
  };
}
```

**Why:** one envelope → one recovery path → free observability (log the envelope). Agents learn it once.

---

## 5. What shipped, phase by phase

### Phase 0 — Types + package scaffolding (0.5d) ✅

**Pre-flight:**
- Pinned exact `@modelcontextprotocol/sdk` version in `packages/arceus-mcp/package.json`.
- Note in README about the version tested against.

**Package layout:**

```
packages/arceus-mcp/
├── package.json                 (bin: arceus-mcp; pinned @modelcontextprotocol/sdk version)
├── src/
│   ├── server.ts                (McpServer bootstrap — NO transport logic)
│   ├── transport-stdio.ts       (entrypoint: stdio transport, bearer auth from env)
│   ├── transport-http.ts        (STUB for future Streamable HTTP; not wired in v1)
│   ├── context.ts               (BEAT_ID, COMPANY_ID, ROLE, ARCEUS_API, ARCEUS_TOKEN from env)
│   ├── http-client.ts           (fetch wrapper → Arceus API, retries, bearer)
│   ├── envelope.ts              (ToolResult<T> construction + Zod guard)
│   ├── tool-index.ts            (build TOOL_INDEX.json from src/tools/*)
│   └── tools/
│       ├── task.ts              (6 tools)
│       ├── artifact.ts          (3 tools)
│       ├── memory.ts            (3 tools)
│       ├── workspace.ts         (2 tools)
│       ├── meeting.ts           (1 tool)
│       ├── approval.ts          (1 tool)
│       ├── sprint.ts            (1 tool)
│       └── meta.ts              (tool_help, arceus_tool_search)
└── README.md
```

`ToolResult<T>` added to `packages/contracts/src/tool-result.ts`.

**Deliverable:** empty stubs, Zod schemas, descriptions ≤160 chars each (lint-enforced).

---

### Phase 1 — Arceus API internal routes (1.5d) ✅

New routes in `apps/api/src/routes/internal-mcp/*`, mounted under `/api/internal/v1/*`. Every MCP call lands here, gets governance-checked, idempotency-deduped, then calls the existing mutator. Every response normalized to `ToolResult<T>`.

**URL design rules (REST / api-design skill):**
- **Plural, kebab-case, lowercase nouns** — `/tasks`, `/artifacts`, `/memory-handoffs`.
- **No verbs in paths.** State transitions live as sub-resources (`.../completion`, `.../block`, `.../verification`, `.../hydration`, `.../preview-url`) that accept `POST`/`PUT`/`DELETE` with the semantically correct method.
- **Explicit versioning** via URL path (`/v1`).
- **One method per action.** `POST` creates, `PATCH` partially updates whitelisted fields, `PUT` replaces a single-value state slot, `DELETE` clears.
- **Role/identity NEVER in the URL** — derived from the bearer token + `X-Beat-Id` header.

**Route table:**

| Method | Path | Mutator | Notes |
| --- | --- | --- | --- |
| **Tasks — state transitions** | | | |
| `POST` | `/api/internal/v1/tasks` | `upsertTask` (create path only) | 201 + `Location`. CEO/PM roles only. |
| `PATCH` | `/api/internal/v1/tasks/:taskId` | `updateTask` | Whitelisted fields enforced by governance. 200 on success. |
| `POST` | `/api/internal/v1/tasks/:taskId/completion` | `setTaskStatus(id, "completed")` | Idempotent via `Idempotency-Key`. |
| `POST` | `/api/internal/v1/tasks/:taskId/block` | `setTaskStatus(id, "blocked")` | Body carries `reason`. |
| `POST` | `/api/internal/v1/tasks/:taskId/verification` | `setTaskVerified` | Tester-only. |
| `POST` | `/api/internal/v1/tasks/:taskId/results` | `appendTaskResult` | Append semantics; body is `{ entry }`. |
| `POST` | `/api/internal/v1/tasks/:taskId/commands` | `appendTaskCommand` | Append; body is `{ command, exitCode }`. |
| `POST` | `/api/internal/v1/tasks/:taskId/plan-steps` | `appendTaskPlanStep` | Append; body is `{ step }`. |
| `PATCH` | `/api/internal/v1/tasks/:taskId/progress` | `updateTaskProgress` | Partial update of `{ percent, note }`. |
| `PUT` | `/api/internal/v1/tasks/:taskId/preview-url` | `setTaskPreviewUrl` | Single-slot replacement. 204 on success. |
| `POST` | `/api/internal/v1/tasks/:taskId/artifacts` | `attachArtifactToTask` | Links an existing artifact to the task. |
| `POST` | `/api/internal/v1/tasks/:taskId/hydration` | `hydrateTaskFromSpec` | Idempotent; rehydrates from the spec artifact. |
| **Artifacts** | | | |
| `POST` | `/api/internal/v1/artifacts` | `addArtifact` | 201 + `Location: /api/internal/v1/artifacts/:id`. |
| `POST` | `/api/internal/v1/artifacts/:artifactId/workspace-writes` | `writeArtifactToWorkspace` | Append to workspace; returns written path. |
| `POST` | `/api/internal/v1/artifacts/:artifactId/persistence` | `persistRuntimeArtifact` | Promotes runtime artifact to durable store. |
| **Memory** | | | |
| `POST` | `/api/internal/v1/memory-enrichments` | `enrichRoleMemory` | Body carries `{ role, context }` (role subject, not actor). |
| `POST` | `/api/internal/v1/memory-handoffs` | generalized `memoryHandoff` | See Phase 2 for payload shape. |
| `DELETE` | `/api/internal/v1/memory-blockers` | `clearRoleBlockers` | Idempotent — 204 even if nothing cleared. |
| **Workspace** | | | |
| `POST` | `/api/internal/v1/workspaces/checkpoints` | `syncWorkspaceCheckpoint` | 201; checkpoint is the created resource. |
| `POST` | `/api/internal/v1/workspaces/preview-probes` | preview probe | 201; probe is the created resource, body returns outcome. |
| **Meetings / Approvals / Sprints** | | | |
| `POST` | `/api/internal/v1/meetings` | `recordMeeting` | 201 + `Location`. |
| `POST` | `/api/internal/v1/approvals` | generalized `requestApproval` | 201 + `Location`; `kind` discriminates payload. |
| `POST` | `/api/internal/v1/sprints/proposals` | `triggerCeoSprintProposal` | CEO-only; 202 Accepted (async work). |

**Status code contract:**

| Status | When |
| --- | --- |
| `200 OK` | `PATCH` / `PUT` with response body; successful idempotent replay. |
| `201 Created` | `POST` that creates a resource. Always includes `Location` header. |
| `202 Accepted` | `POST` that queues async work (sprint proposal, approval routing). |
| `204 No Content` | `PUT`/`DELETE` that succeed with nothing to return. |
| `400 Bad Request` | Malformed JSON, bad `Idempotency-Key` format. |
| `401 Unauthorized` | Missing/invalid bearer token. |
| `403 Forbidden` | Governance denial (trust band, role, whitelist). `error.cause: "governance"`. |
| `404 Not Found` | Unknown task / artifact / sprint ID. |
| `409 Conflict` | `Idempotency-Key` replay with a **different** body, or state transition conflict. |
| `422 Unprocessable Entity` | Zod schema failure. Includes field-level `details[]`. |
| `429 Too Many Requests` | Governance rate-limit. Includes `Retry-After` header. |
| `500 Internal Server Error` | Unexpected server failure. Response body never leaks stack traces. |
| `503 Service Unavailable` | OpenCode / downstream hard-down. Includes `Retry-After`. |

**Required request headers:**

| Header | Purpose |
| --- | --- |
| `Authorization: Bearer <ARCEUS_TOKEN>` | Identifies caller. Token scopes to a role + company. |
| `X-Beat-Id: <beat-id>` | Ties the mutation to a specific beat for circuit-breaker + audit. |
| `X-Agent-Role: <role>` | Advisory; server authoritative value is derived from the token. |
| `Idempotency-Key: <uuid>` | Required on all non-`GET` routes. Scoped to `(companyId, beatId)`. |
| `Content-Type: application/json` | All bodies are JSON. |

**`Idempotency-Key` semantics (matches Stripe's contract):**
- First request with key `K` executes, result is cached under `sha256(body)`.
- Replay with same key + same body → returns the cached result (200/201/204 as originally).
- Replay with same key + **different** body → `409 Conflict` with `error.cause: "idempotency_body_mismatch"`.
- Keys expire when the beat ends — no cross-beat reuse.

**Response headers (every response):**

```
X-RateLimit-Limit: <per-beat cap>
X-RateLimit-Remaining: <left>
X-RateLimit-Reset: <epoch-seconds>
X-Request-Id: <uuid>           # echoes the incoming header or generates one
```

On `429`, add `Retry-After: <seconds>`.

**Response body — always `ToolResult<T>`:**

Success (`2xx`):
```json
{
  "status": "ok",
  "summary": "Task tsk_abc marked completed.",
  "data": { "taskId": "tsk_abc", "status": "completed", "unblockedDependents": ["tsk_def"] },
  "next_actions": ["task_append_result", "artifact_create"],
  "artifacts": []
}
```

Error (`4xx`/`5xx`) — same envelope, `error` populated, `data` null:
```json
{
  "status": "error",
  "summary": "Trust band below threshold for task_update.",
  "data": null,
  "error": {
    "cause": "governance",
    "retry": "never",
    "stop_when": "trust_band_change",
    "details": [
      { "field": "task.assignedRole", "message": "developer cannot reassign tasks", "code": "field_not_whitelisted" }
    ]
  },
  "next_actions": ["escalate_to_pm"]
}
```

**Anti-patterns the adapter enforces:**
- ❌ `200 OK` with `error` populated.
- ❌ Stack traces, SQL errors, or internal paths in `error.details`.
- ❌ Bare strings where `ToolResult<T>` is expected.
- ❌ `error.cause` values outside the enum `{ "validation" | "governance" | "not_found" | "conflict" | "upstream" | "internal" }`.

**Authorization model:**
- Bearer token → `(companyId, role)` pair. Role used for governance checks.
- Per-route `requireRole([...])` middleware enforces CEO-only, PM-only, tester-only gates declaratively.
- No ownership leakage — agents cannot read/write tasks outside their company, enforced at the middleware layer.

**Rate limiting:** Per-beat internal tier at 10,000 req/min per beat. Per-route overrides inline (e.g. `sprints/proposals` limited to 2/beat).

**Deliverable:** 23 routes covered by unit tests; integration tests green; governance denial returns well-formed `error.cause/retry/stop_when`.

---

### Phase 2 — Generalize role-specific helpers (1d) ✅

Two hardcoded-to-one-role functions blocking tool exposure were generalized:

```typescript
// BEFORE
deliverUiDesignerMemoryHandoff(task, artifactId)
// AFTER
memoryHandoff({ fromRole, targetRoles: Role[], context: string, artifactId?: string })

// BEFORE
createMarketingExternalApproval(task, artifactId)
// AFTER
requestApproval({ kind: "external_marketing" | "ux_sign_off" | …, details: {...}, artifactId?: string })
```

Old functions became thin wrappers calling the new generic ones. **Zero behavior change.**

**Deliverable:** `apps/api/src/memory/handoffs.ts` and `apps/api/src/approvals/*` refactored; all existing tests green.

---

### Phase 3 — MCP tool handlers (1.5d) ✅

Wired each tool in `packages/arceus-mcp/src/tools/*` to its internal route. Every handler wraps the fetch in the envelope adapter.

```typescript
// tools/task.ts
server.tool(
  "task_complete",
  "Mark the current task completed. Returns the new task state and any unblocked dependents.",
  {
    evidence: z.string().min(10).max(2000),
    artifactId: z.string().uuid().optional(),
  },
  async ({ evidence, artifactId }): Promise<ToolResult<TaskState>> => {
    return await arceusApi.post(
      `/internal/mcp/task/${ctx.TASK_ID}/complete`,
      { evidence, artifactId },
    );
  },
);
```

**Rules (enforced by lint + PR review):**
- Tool description ≤160 chars.
- No examples or caveats in the description — those go in `SKILL.md` or `tool_help`.
- Handler body is a single fetch + envelope. No business logic in the MCP layer.

**Deliverable:** all 20 MCP tools + `tool_help` + (optional) `arceus_tool_search` callable from MCP Inspector; Zod-parsed envelope asserted in integration tests.

---

### Phase 4 — Custom tools (Tier A) + governance plugin (1d) ✅

OpenCode offers two separate local mechanisms — we use each for what it's best at:

| Mechanism | Location | What we put here |
|---|---|---|
| **Custom tools** | `.opencode/tool/*.ts` | 3 Tier A tools — callable by the agent |
| **Plugin (hooks only)** | `.opencode/plugin/arceus.ts` | Governance, audit, circuit breaker — wraps every tool call but is never called directly |

**Custom tools shipped:**

```
.opencode/tool/
├── task_update_progress.ts
├── task_append_command.ts
└── task_append_plan_step.ts
```

Each file exports a Zod schema + handler that returns `ToolResult<T>` via the shared `_lib/envelope.ts`:

```typescript
// .opencode/tool/task_update_progress.ts
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { arceusRequest, failure, loadContext, run, success, type ToolResult } from "./_lib/envelope.js";

export default tool({
  description: "Report incremental progress on the current task. Returns the updated task state.",
  args: {
    percent: z.number().min(0).max(100),
    note: z.string().max(500).optional(),
  },
  execute: async ({ percent, note }) =>
    run(async () => {
      const ctx = loadContext();
      const res = await arceusRequest<ToolResult<unknown>>(ctx, {
        method: "PATCH",
        path: `/api/internal/v1/tasks/${ctx.taskId}/progress`,
        body: { percent, note },
      });
      if (res.status >= 400) return failure(`Progress update failed (HTTP ${res.status}).`, "upstream", "safe", "task_exists", res.data);
      return success(`Progress updated on ${ctx.taskId}.`, { taskId: ctx.taskId, percent, note });
    }),
});
```

**Plugin shipped** (`.opencode/plugin/arceus.ts`, ~150 LOC) with hooks only — no tool registration:

```typescript
export const ArceusPlugin: Plugin = async () => {
  const governance = { allowedTools: loadAllowedTools(), denyReason: "Tool not in this beat's allowlist." };
  const circuitTally = new Map<string, number>();                          // 3-strike per (tool, cause)
  const pendingCalls = new Map<string, { tool: string; startedAt: number }>();
  // skill-usage manifest cache (refreshed every 10s from .opencode/arceus-skills.json)

  return {
    "tool.execute.before": async (input, output) => {
      // 1. Governance: if ctx.allowedTools is populated, reject tools not in it
      // 2. Circuit breaker: reject if (tool, cause) tally ≥ 3
      // 3. Start latency timer
      // 4. Emit audit: {phase: "before", tool, callID, sessionID, args, startedAt}
    },
    "tool.execute.after": async (input, output) => {
      // 1. Compute latencyMs from pending timer
      // 2. Parse envelope for status/cause
      // 3. Emit audit: {phase: "after", tool, callID, sessionID, status, cause, latencyMs}
      // 4. If envelope.status === "error" && envelope.cause: increment circuit tally
      // 5. If tool === "skill": resolve slug via manifest, fire-and-forget POST to /api/internal/telemetry/skills/:id/usage
    },
  };
};
```

**Watchdog deleted.** An earlier iteration added an `event`-hook watchdog that would emit audit on 120s idle / 15min hard cap. This was removed:
- SDK `@opencode-ai/plugin@1.3.17` has no `session.idle` hook (plan 05 was wrong about this).
- The `event` firehose cannot fire during true silence — zero events = zero watchdog checks.
- Redundant with the outer `scheduleDeveloperWatchdog` in `apps/api/src/workspace/watchdog.ts` which *does* have a real `setTimeout`.
- The hard cap enforcement now lives in Phase 6.5 package J (`Promise.race` around `session.prompt`).

**Constants:**
- `CIRCUIT_THRESHOLD = 3`
- Manifest refresh interval: 10,000 ms

**Smoke test** (`.opencode/test/smoke.ts`, 13 assertions, green):
- Envelope contract (success path: PATCH method, correct path, required headers)
- Idempotency-key sent on appropriate POSTs
- Body passthrough
- HTTP 500 maps to `error.cause === "upstream"`
- Missing env surfaces structured error (not throw)
- Governance: blocks tool not on allowlist
- Circuit breaker: trips after 3 strikes on same (tool, cause)
- Audit lines emitted in both `before` and `after` phases

**Deliverable:**
- 3 custom tool files under `.opencode/tool/`, each returning `ToolResult<T>` via shared `_lib/envelope.ts`
- 1 plugin file providing `tool.execute.before` (governance + circuit breaker + audit), `tool.execute.after` (audit + circuit-breaker tally + skill-usage POST)
- Smoke test + typecheck green

---

### Phase 5 — Per-role agent files + scoped allowlists (0.5d) ✅

Generated per-beat (conceptually) by `writeBeatAgent`. Example `developer.md`:

```yaml
---
mode: primary
model: anthropic/claude-sonnet-4-5
tools:
  # Built-ins
  bash: true
  edit: true
  read: true
  grep: true
  # Tier A (in-process)
  task_update_progress: true
  task_append_command: true
  task_append_plan_step: true
  # Tier B eager (developer subset)
  task_complete: true
  task_block: true
  task_append_result: true
  task_set_preview_url: true
  artifact_create: true
  artifact_write_to_workspace: true
  workspace_checkpoint: true
  workspace_probe_preview: true
  # Meta
  tool_help: true
  # Tier C denied for developer
  task_create: false
  sprint_propose: false
  approval_request: false
  meeting_record: false
  # Skills
  skill: true
---
```

**All 8 role files generated:** ceo, cto, pm, developer, tester, ui_designer, marketing, skills_lead.

**Critical architectural note — all 8 roles use `mode: primary`.** Employees are independent primary entities. The org hierarchy (CEO → CTO → developer, etc.) is stitched together on the frontend as a visual/coordination layer, NOT via OpenCode's primary/subagent parent-child relationship. Using subagent mode would couple execution flow to the opencode runtime's delegation model, which is the wrong abstraction — Arceus's orchestrator drives dispatch.

**Measured per-role eager catalog token counts** (CI assertion: must be `< 2,500`):

| Role | Arceus tools | ~Tokens |
|---|---|---|
| ceo | 5 | ~580 |
| pm | 6 | ~620 |
| cto | 10 | ~680 |
| developer | 15 | ~709 |
| tester | 13 | ~660 |
| ui_designer | 14 | ~680 |
| marketing | 13 | ~650 |
| skills_lead | 16 | ~743 |

**All under budget.** Phase 7 adds 3 more tools (~165 tokens each role) — still fits.

**Memory tools removed from allowlists** (user decision, deferred): `memory_enrich`, `memory_clear_blockers`, `memory_handoff` are not in any role's allowlist in Phase 5 config. They re-enter when the memory integration work is prioritized.

**Deliverable:** `writeBeatAgent(beat, workDir)` emits correct file for all 8 roles; per-role eager catalog measured; CI assertion `eager_token_count < 2500` per role.

---

### Phase 6 — Registry-driven skill materialization (items 1–8) ✅

Skills live in the `SkillArtifact` registry (in-memory module singleton for v1 — `packages/company-runtime/src/skill-registry.ts`). Per beat, `materializeBeatSkills` queries the registry, filters by `{companyId, role, trustBand}` + `status === "active"`, and writes each artifact as a `.opencode/skills/<slug>/` tree into the beat's workdir. OpenCode's built-in skill loader reads the filesystem natively.

> **Items 1–8 shipped in this slice.** Items 9–13 (symlink swap, `sessionContextMap`, plugin/MCP session-context resolvers, end-to-end integration test) are Phase 6.5 — see companion doc.

#### Item 1 — `resources` field on `SkillArtifact`

**File:** `packages/contracts/src/skills.ts`

Added `skillResourceSchema` and extended `skillArtifactSchema`:

```typescript
export const skillResourceSchema = z.object({
  path: z.string(),                                        // e.g. "resources/evidence-templates.md"
  kind: z.enum(["script", "reference", "asset"]),
  contentType: z.string(),                                 // "text/markdown" | "application/javascript" | ...
  content: z.string(),                                     // base64 when encoding === "base64"
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});

// Added to skillArtifactSchema:
resources: z.array(skillResourceSchema).default([]),
```

Exported `SkillResource` type. `.default([])` means existing in-memory / legacy data parses cleanly — backward compatible.

**Ripple fixes:** every site constructing a `SkillArtifact` literal got `resources: []` added:
- `packages/company-runtime/src/skill-mutator.ts` (2 sites)
- `packages/company-runtime/src/pattern-learner.ts`
- Test helpers: `skill-registry.test.ts`, `skill-mutator.test.ts`, `skill-tester.test.ts`, `pattern-learner.test.ts`

**No Postgres migration in this slice** — the registry is an in-memory Map; when persistence lands in a later phase, the column is `ALTER TABLE skill_artifacts ADD COLUMN resources JSONB DEFAULT '[]'::jsonb`.

#### Item 2 — `.arceus/skills-seed/` with 8 baseline skills

**Directory:** `.arceus/skills-seed/`

Eight SKILL.md files, each with YAML frontmatter (`name`, `description` ≤160 chars, `role`, `trigger`) + body. Four have `resources/` subdirs to prove tier-3 progressive disclosure.

| Slug | Role | Resources |
|---|---|---|
| `task-completion-checklist` | developer | 2 (evidence-templates.md, common-failures.md) |
| `artifact-structure` | developer | — |
| `developer-tdd-loop` | developer | 1 (shell-conventions.md) |
| `design-to-dev-handoff` | ui_designer | — |
| `qa-verification-loop` | tester | 1 (criteria-patterns.md) |
| `ceo-sprint-proposal-prep` | ceo | — |
| `external-approval-request` | marketing | — |
| `workspace-probe-checklist` | developer | — |

**Role scoping note:** Frontmatter has `role: <single role>`, not `roles: [...]`. `getSkillsForRole(companyId, role)` filters by exact match. Multi-role skills in v2.

#### Item 3 — `seedExistingSkills()` extended with resources + upsert modes

**File:** `packages/company-runtime/src/skill-registry.ts`

- New helper `readSkillResources(skillDir)` recursively walks `<slug>/resources/`, infers `{kind, contentType, encoding}` from file extension via `RESOURCE_TYPE_MAP`:

  | Extension | Kind | ContentType | Encoding |
  |---|---|---|---|
  | `.md`, `.mdx` | reference | text/markdown | utf8 |
  | `.txt` | reference | text/plain | utf8 |
  | `.json` | reference | application/json | utf8 |
  | `.yaml`, `.yml` | reference | application/yaml | utf8 |
  | `.js`, `.mjs` | script | application/javascript | utf8 |
  | `.ts` | script | application/typescript | utf8 |
  | `.sh` | script | application/x-shellscript | utf8 |
  | `.png` | asset | image/png | base64 |
  | `.jpg`, `.jpeg` | asset | image/jpeg | base64 |
  | `.svg` | asset | image/svg+xml | utf8 |
  | `.pdf` | asset | application/pdf | base64 |

- `seedExistingSkills(companyId, skillsDirOrOptions?)` kept its legacy signature (returns `number`) for backward compatibility with 6+ existing callers.
- New overload accepts `SeedSkillsOptions = { skillsDir?, mode?: "preserve" | "overwrite-content" }`:
  - `preserve` (default): skip skills that already exist in the registry. Idempotent.
  - `overwrite-content`: update `content` + `resources` + `role` + `trigger` on existing skills, **preserve `usageCount` and `successRate`** (so re-seeding after editing a SKILL.md doesn't reset EMA metrics).
- New export `seedExistingSkillsDetailed(...)` returns `{seeded, updated, skipped}`.
- Default source directory changed: now `<repoRoot>/.arceus/skills-seed/`; legacy path kept as fallback.

#### Item 4 — `materializeBeatSkills()` implementation

**File:** `apps/api/src/opencode/materialize-beat-skills.ts` (new, ~130 LOC)

**Signature:**

```typescript
materializeBeatSkills({
  beatId: string,
  companyId: string,
  role: string,
  trustBand: "probation" | "standard" | "senior",
  workDir: string,
}) → Promise<MaterializedSkill[]>   // { slug, skillId, version }
```

**Behavior:**
1. Clears `<workDir>/.opencode/skills/` with `rm -rf` + recreates — prevents stale skills from a previous beat from leaking.
2. Queries `getSkillsForRole(companyId, role)`.
3. Filters `status === "active"`.
4. Applies trust-band filter (`trustBandAllows`):
   - `probation`: requires `successRate >= 0.75 && usageCount >= 20` (excludes fresh seed skills by design — full policy matrix Phase 7+)
   - `standard` | `senior`: all active skills
5. For each surviving artifact: writes `<workDir>/.opencode/skills/<slug>/SKILL.md` with Arceus metadata frontmatter (including `metadata.arceus.id` + `version` for the back-channel), plus each resource at its declared relative path under `resources/`.
6. Writes `<workDir>/.opencode/arceus-skills.json` manifest: `Record<slug, {skillId, version}>`.
7. Returns the materialized list.

**SKILL.md rendering** produces:

```yaml
---
name: task-completion-checklist
description: Call task_complete only when evidence fields are populated and handoff is staged.
metadata:
  arceus:
    id: skill-task-completion-checklist-v1
    version: 1
    role: developer
    status: active
---

[body from SkillArtifact.content]
```

**Out of scope in this slice:** no symlink swap, no `/tmp` involvement — materializer writes directly to caller-provided `workDir`. Symlink wiring is Phase 6.5 package C.

#### Item 5 — Plugin skill-usage POST

**File:** `.opencode/plugin/arceus.ts` (extended)

- Closure-scoped manifest cache (`SkillManifest`) with 10s refresh interval, loaded from `<cwd>/.opencode/arceus-skills.json`.
- `resolveSkillSlug(args)` extracts the `name` arg from an OpenCode `skill(...)` tool invocation.
- In `tool.execute.after`, when `input.tool === "skill"`: refresh-if-stale, resolve slug → `{skillId, version}`, fire-and-forget POST to `${ARCEUS_API}/api/internal/telemetry/skills/:skillId/usage`.
- POST body: `{beatId, version}`. `beatId` comes from `process.env.BEAT_ID` (Phase 6.5 package F will switch this to `ctx.beatId` via session-context lookup).
- Failure swallowed with `.catch(() => {})` — best-effort, must never block the beat or leak to agent.

#### Item 6 — Skill-usage telemetry route

**File:** `apps/api/src/routes/internal-telemetry.routes.ts` (new, ~120 LOC)

**Route:** `POST /api/internal/telemetry/skills/:skillId/usage`

**Body schema:** `{ beatId: string, version?: number }`

**Middleware:** `mcpAuth` only (bearer token check). **No idempotency replay** — this endpoint is fire-and-forget.

**Behavior:**
1. Validates `skillId` + body.
2. Returns 404 if skill not found.
3. Calls `recordSkillUsage(skillId)` → bumps `usageCount` on the artifact.
4. Calls `recordBeatSkillUsage(beatId, skillId)` → adds to per-beat tally (`Map<beatId, Set<skillId>>`). Phase 6.5 package J reads this at beat end to drive `updateSuccessRate(skillId, outcome)` for every skill used this beat.
5. Returns 202 with envelope.

**Per-beat tally API exported for orchestrator:**
- `recordBeatSkillUsage(beatId, skillId)`
- `getBeatSkillUsage(beatId): string[]`
- `clearBeatSkillUsage(beatId)`

**Route namespace design — `/telemetry/` vs `/v1/`:**

| Namespace | Caller | Semantics | Middleware |
|---|---|---|---|
| `/api/internal/v1/*` | Agent → MCP server → route | Mutation on agent's behalf; per-beat idempotency + replay-safety | Full MCP chain: `mcpAuth` + `mcpRequestContext` + `mcpRateLimitHeaders` + `mcpIdempotencyReplay` |
| `/api/internal/telemetry/*` | Plugin / orchestrator → route | Observation or bookkeeping; no agent intent to replay | `mcpAuth` only (bearer token) |

The plugin doesn't send an `Idempotency-Key` header on its fire-and-forget POST; putting this route under `/v1/*` would have caused 422 rejections. Separating the namespace also makes the architectural split obvious.

#### Item 7 — 8 baseline skills register successfully

Covered by Item 2 (directory contents) + Item 3 (the seeder). Proven by the integration test below: `seedExistingSkillsDetailed(companyId)` returns `{seeded: 8, updated: 0, skipped: 0}`.

#### Item 8 — End-to-end integration test

**File:** `apps/api/src/opencode/materialize-beat-skills.test.ts` (9 test cases, all green)

| # | Test | Proves |
|---|---|---|
| 1 | `slugify` normalizes to kebab-case | Filesystem-safe slugs from arbitrary names |
| 2 | `renderSkillMd` writes Arceus metadata | Frontmatter carries `arceus.id` / `version` for back-channel |
| 3 | `seedExistingSkillsDetailed` loads all 8 baseline skills | Seed dir → registry end-to-end; resources populate |
| 4 | Preserve mode is idempotent (8 seeded → 8 skipped on re-run) | Safe to call on every boot |
| 5 | Overwrite-content mode preserves `usageCount` | Re-seeding after file edit doesn't reset EMA |
| 6 | `materializeBeatSkills` writes SKILL.md + resources + manifest | Full write path correct |
| 7 | Stale skills cleared between beats (developer → tester) | No cross-beat contamination |
| 8 | Probation trust band filters fresh seed skills | Trust filter works |
| 9 | `recordSkillUsage` + `updateSuccessRate` move registry state | Registry ops behave correctly |

**Run it:** `cd apps/api && npx tsx --test src/opencode/materialize-beat-skills.test.ts`

---

## 6. Files in the "done" state

### Files created this phase

- **Contracts** (1):
  - `packages/contracts/src/beat-context.ts` — NOT yet created (Phase 6.5 package A)
  - Extended `packages/contracts/src/skills.ts` — `skillResourceSchema` + `SkillResource` + `resources` field

- **Skill seed directory** (8 SKILL.md + 4 resource files, ~2,800 LOC total):
  - `.arceus/skills-seed/task-completion-checklist/{SKILL.md, resources/evidence-templates.md, resources/common-failures.md}`
  - `.arceus/skills-seed/artifact-structure/SKILL.md`
  - `.arceus/skills-seed/developer-tdd-loop/{SKILL.md, resources/shell-conventions.md}`
  - `.arceus/skills-seed/design-to-dev-handoff/SKILL.md`
  - `.arceus/skills-seed/qa-verification-loop/{SKILL.md, resources/criteria-patterns.md}`
  - `.arceus/skills-seed/ceo-sprint-proposal-prep/SKILL.md`
  - `.arceus/skills-seed/external-approval-request/SKILL.md`
  - `.arceus/skills-seed/workspace-probe-checklist/SKILL.md`

- **MCP package** (~930 LOC):
  - `packages/arceus-mcp/package.json`
  - `packages/arceus-mcp/src/server.ts` (~60)
  - `packages/arceus-mcp/src/transport-stdio.ts` (~30)
  - `packages/arceus-mcp/src/transport-http.ts` (~30 stub)
  - `packages/arceus-mcp/src/context.ts` (~30)
  - `packages/arceus-mcp/src/http-client.ts` (~60)
  - `packages/arceus-mcp/src/envelope.ts` (~40)
  - `packages/arceus-mcp/src/tool-index.ts` (~60)
  - `packages/arceus-mcp/src/tools/*.ts` (9 files, ~450)
  - `packages/arceus-mcp/README.md`

- **Arceus API internal routes** (~320 LOC):
  - `apps/api/src/routes/internal-mcp/index.ts`
  - `apps/api/src/routes/internal-mcp/middleware.ts`
  - `apps/api/src/routes/internal-mcp/tasks.routes.ts`
  - `apps/api/src/routes/internal-mcp/artifacts.routes.ts`
  - `apps/api/src/routes/internal-mcp/workspaces.routes.ts`
  - `apps/api/src/routes/internal-mcp/meetings.routes.ts`
  - `apps/api/src/routes/internal-mcp/approvals.routes.ts`
  - `apps/api/src/routes/internal-mcp/sprints.routes.ts`
  - `apps/api/src/routes/internal-mcp/envelope.ts`
  - `apps/api/src/routes/internal-mcp/idempotency.ts` (+ test)
  - `apps/api/src/routes/internal-mcp/integration.test.ts`

- **Arceus API telemetry route** (~120 LOC):
  - `apps/api/src/routes/internal-telemetry.routes.ts` (+ exported per-beat tally helpers)

- **Materialization** (~130 LOC + 200 LOC test):
  - `apps/api/src/opencode/materialize-beat-skills.ts`
  - `apps/api/src/opencode/materialize-beat-skills.test.ts`

- **OpenCode plugin + tools** (~400 LOC):
  - `.opencode/plugin/arceus.ts`
  - `.opencode/tool/_lib/envelope.ts`
  - `.opencode/tool/task_update_progress.ts`
  - `.opencode/tool/task_append_command.ts`
  - `.opencode/tool/task_append_plan_step.ts`
  - `.opencode/agent/config.ts` (ROLE_CONFIGS, per-role allowlists)
  - `.opencode/agent/write-beat-agent.ts`
  - `.opencode/test/smoke.ts` (plugin + tools integration)
  - `.opencode/test/agent-gen.ts` (per-role file generation + token budget)

### Files modified

- `packages/contracts/src/skills.ts` — added `skillResourceSchema` + `resources` field
- `packages/company-runtime/src/skill-registry.ts` — resource walker + upsert modes + new default seed path
- `packages/company-runtime/src/index.ts` — export `seedExistingSkillsDetailed`, options/result types
- `packages/company-runtime/src/skill-mutator.ts` — `resources: []` in 2 literals
- `packages/company-runtime/src/pattern-learner.ts` — `resources: []` in 1 literal
- Company-runtime test helpers (skill-registry, skill-mutator, skill-tester, pattern-learner `.test.ts`) — `resources: []`
- `apps/api/src/memory/handoffs.ts` — generalized delivery functions (Phase 2)
- `apps/api/src/approvals/*.ts` — generalized marketing approval (Phase 2)
- `apps/api/src/persistence/store.ts` — field whitelist on `updateTask`
- `apps/api/src/routes/index.ts` — export `internalMcpRoutes` + `internalTelemetryRoutes`
- `apps/api/src/server.ts` — register both route plugins
- `package.json` (root) — add `packages/arceus-mcp` to workspaces

### Files NOT yet modified (Phase 8 work)

These show up in Phase 8's deletion list but are untouched in this slice:

- `apps/api/src/tasks/specialist-executor.ts`
- `apps/api/src/skills/classifier.ts`
- `apps/api/src/skills/catalog.ts` (the catalog-injection symbols)
- `apps/api/src/prompts/llm.ts` (the `matchedSkillIds` parameter)

---

## 7. Anti-patterns this phase addressed (from `plans/code-audit/flaws.md`)

| # | Anti-pattern | Status after this slice |
|---|---|---|
| #19 | Skills with action semantics should be tools | **Partially addressed.** Registry + EMA feedback loop now in v1; knowledge/action distinction still uniform (all skills are procedural prompts) per opencode plan §4.9 |

All other anti-patterns (#3 specialist-executor as orchestrator, #4 role branching, #9 magic strings, #17 procedural ops, #20 specialist-executor biggest violator, #23 no progress notes) are **still outstanding** — they get addressed in Phase 7 (shadow mode) and Phase 8 (specialist-executor deletion). See the companion doc.

---

## 8. Verification commands (run these on every compaction)

```bash
# 1. Types green across the packages we touched
cd /Users/divyansh/Arceus/packages/contracts && npx tsc --noEmit
cd /Users/divyansh/Arceus/packages/company-runtime && npx tsc --noEmit
cd /Users/divyansh/Arceus/apps/api && npx tsc --noEmit
cd /Users/divyansh/Arceus/.opencode && npm run typecheck

# 2. Phase 6 integration test (9 assertions)
cd /Users/divyansh/Arceus/apps/api && npx tsx --test src/opencode/materialize-beat-skills.test.ts

# 3. Plugin smoke test (13 assertions — governance + circuit + audit + tool contracts)
cd /Users/divyansh/Arceus/.opencode && npx tsx test/smoke.ts

# 4. Phase 5 agent-gen test (8 roles + token budget < 2500)
cd /Users/divyansh/Arceus/.opencode && npx tsx test/agent-gen.ts
```

All four should exit 0.

---

## 9. What's still missing before the heartbeat runtime can run

See companion doc `02-todo-phase-65-onwards.md`. Top items:

- **`BeatContext` contract** (Phase 6.5 package A) — 30 LOC.
- **`sessionContextMap` + HTTP lookup route** (package B) — the bridge that lets plugin + MCP resolve `sessionID → beat context` on first use.
- **Beat path utilities + symlink swap** (package C) — `/tmp/arceus/beats/<beatId>/` + `productWorkspace/.opencode/skills` symlink management.
- **`writeSharedOpencodeConfig()`** (package E) — boot-time wiring of plugin + 8 agent files + MCP config into `productWorkspace/opencode.json`.
- **Plugin + MCP session-context resolvers** (packages F + G) — fetch from the route instead of `process.env`.
- **`buildBeatContext` + `renderStateForAgent`** (package I) — the read-only state assembly that replaces "orchestrator decides which task, builds prompt, parses output."
- **`runBeat(role, companyId)`** (package J) — the heart. `session.create` → register context → materialize → `session.prompt` with hard cap → cleanup in `finally`.
- **`scoreBeatVerdict` + EMA glue** (package K) — reads per-beat skill tally, calls `updateSuccessRate` per skill.
- **End-to-end integration test** (package L).
- **Phase 7 — 3 self-direction tools** (`task_claim`, `board_list_ready`, `beat_read_last_progress`) + shadow mode + divergence telemetry.
- **Phase 8 — delete `specialist-executor.ts`** + all role branching + skill pre-flight symbols, wire 3 CI grep guards.

No Phase 9 (`arceus_tool_search`) expected to ship — current per-role budgets leave plenty of headroom.
