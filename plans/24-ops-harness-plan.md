# Implementation Plan — Arceus MCP Surface for 24 System Operations (Harness-First)

> Convert 24 orchestrator-called functions into agent-invoked tools. Route via `arceus-mcp` (stable cross-harness contracts) + in-process OpenCode plugin (hot-loop), with procedural knowledge in `SKILL.md`. End state: `specialist-executor.ts` collapses from ~350 lines of role-specific if/else to ~30 lines — **agents drive their own state transitions, inside a harness that makes correct behavior the cheap default.**

---

## 0. Non-goals

- Removing the other ~180 orchestrator-internal ops (governance, telemetry, state mutators stay put).
- Changing `SkillArtifact` lifecycle, EMA, or the ATA pipeline.
- Native `experimental.mcp_lazy` — track OpenCode PR #12520; approximate via per-role scoping.

---

## 1. The four harness pillars (frame every decision)

| Pillar | Applied decision |
|---|---|
| **Action space** | 24 ops → 3 tiers by call frequency. Stable `verb_noun` names. Narrow Zod schemas. No catch-all tools. Idempotency keys on mutators. |
| **Observation** | Single `ToolResult<T>` envelope: `{status, summary, data?, next_actions?, artifacts?, error?}`. Nothing else returned, ever. |
| **Recovery** | Every error path returns `{cause, retry, stop_when}`. Event-based watchdog force-completes on 120s since last SSE event, or 15-min session cap. Circuit breaker refuses after 3× same `(tool_id, error.cause)`. |
| **Context budget** | Per-role eager catalog ≤10 tools. Tool descriptions ≤1 sentence / ≤160 chars (lint-enforced). Full schemas behind `tool_help(id)`. Deep examples in `SKILL.md resources/`. |

---

## 2. Tool taxonomy — the 24 ops

### Tier A — In-process OpenCode plugin (3 tools)
Hot-loop, called per-tool-result or every 5-30s. Stdio round-trip unacceptable.

| Tool | Source | Frequency |
|---|---|---|
| `task_update_progress` | `updateTaskProgress` | every 5-30s during work |
| `task_append_command` | `appendTaskCommand` | per shell invocation |
| `task_append_plan_step` | `appendTaskPlanStep` | per planning tick |

> **v1 scope:** no `skill_record_usage` *tool*. Skill-usage telemetry is recorded via the plugin's `tool.execute.after` hook — when `input.tool === "skill"`, the plugin POSTs to `/api/internal/v1/skills/:skillId/usage` using the `arceus-skills.json` manifest to resolve `slug → skillId`. This keeps skill invocation identical to upstream OpenCode (no custom MCP tool) while still feeding the registry. See §3.6 and Phase 6.

### Tier B — MCP, eager per role (12 tools)
Stable contracts, 1-10 calls per beat. ≤160-char descriptions. Only the ones a role allows are injected.

| Tool | Source | Roles |
|---|---|---|
| `task_complete` | `setTaskStatus(…, "completed")` | all executors |
| `task_block` | `setTaskStatus(…, "blocked")` | all executors |
| `task_append_result` | `appendTaskResult` | all executors |
| `task_set_preview_url` | `setTaskPreviewUrl` | developer, designer |
| `task_verify` | `setTaskVerified` | tester, reviewer |
| `artifact_create` | `addArtifact` | all executors |
| `artifact_write_to_workspace` | `writeArtifactToWorkspace` | developer, designer, marketing |
| `memory_enrich` | `enrichRoleMemory` | all executors |
| `memory_clear_blockers` | `clearRoleBlockers` | all executors |
| `memory_handoff` | generalized from `deliverUiDesignerMemoryHandoff` | designer, skills_lead, tester |
| `workspace_checkpoint` | `syncWorkspaceCheckpoint` | developer, skills_lead |
| `workspace_probe_preview` | preview probe + report URL | developer |

### Tier C — MCP, role-scoped rare (8 tools)
One or two roles only; other roles see `tools: { X: false }` — effectively deferred. Surface via `arceus_tool_search` when a role needs them ad-hoc.

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

**Effective per-role surface: 6–10 tools.** Injected catalog token footprint budgeted < 2,500 tokens per beat.

### Idempotency mode per op (cross-beat safety)

| Mode | Key | Applies to |
|---|---|---|
| **Natural** (business-key) | `task_id` (or `artifact_id`, `sprint_id`) — second call no-ops if state already matches | `task_complete`, `task_block`, `task_verify`, `task_set_preview_url`, `workspace_checkpoint` |
| **Content-hash** | `(target_id, sha256(payload))` — identical content dedupes, new content appends | `task_append_plan_step`, `task_append_result`, `memory_enrich`, `artifact_create` |
| **Beat-scoped** | `(beat_id, op_id)` — append-only, intentional repeats across beats | `task_append_command`, `task_update_progress` |

The route adapter in Phase 1 picks the mode from a per-op config. The `Idempotency-Key` header carries the mode's key; duplicate keys return the original response with `status: "success"` (no side effects).

---

## 3. Progressive disclosure — three gaps from matthewkruczek.ai folded in

### Gap 1 — Index tier: ≤1-sentence tool descriptions

Every MCP `description` field is one sentence, no examples, no caveats. **Lint rule** in `packages/arceus-mcp` pre-commit: fail if any `description.length > 160` chars.

```
BAD  (220 tokens): "task_complete marks a task as completed. This should be called
                   when the agent has finished all work for the task. It will
                   trigger downstream events including board notifications…"
GOOD  (22 tokens): "Mark a task completed. Returns the new task state and any
                   unblocked dependents."
```

### Gap 2 — Detail tier: `tool_help(tool_id)` meta-tool

One eager tool per role. Reads from a generated `TOOL_INDEX.json` (built at MCP server startup). Returns full params, examples, error codes, related tools.

```typescript
server.tool(
  "tool_help",
  "Get full docs (schema, examples, errors, related tools) for an Arceus tool.",
  { tool_id: z.string() },
  async ({ tool_id }) => toolIndex.lookup(tool_id),
);
```

Cost: 1 slot in the eager catalog; unlocks Detail tier for all 24 on demand.

### Gap 3 — Deep tier: `SKILL.md resources/` subdir

Examples, error-recovery recipes, and long-form prose live as siblings of `SKILL.md`. The skill body **references** them by path; agents read only when cited.

```
.arceus/skills/task-completion-checklist/
  SKILL.md                 ← tier-2 (loaded with the skill)
  resources/
    example-happy-path.md  ← tier-3 (loaded only if SKILL.md cites it)
    error-retry-recipe.md
```

Registry extension: `SkillArtifact.resources: SkillResource[]` (per `plans/opencode/05` §4) — already on the roadmap.

### Gap 4 — Optional bridge: `arceus_tool_search`

Activated per-beat via `ARCEUS_TOOL_SEARCH=true` when eager catalog tokens creep past budget. Surfaces Tier C tools without adding them to the role's eager list. Removable when PR #12520 lands.

---

## 3.5 — MCP primitives: Tools vs Resources vs Prompts

MCP exposes three distinct primitives. We use each for what it's best at, per the MCP spec.

| Primitive | Semantics | Our use |
|---|---|---|
| **Tool** | Action the agent invokes. Takes params, returns result. | **All 24 ops.** Every one is a mutation or a parameterized read. |
| **Resource** | Read-only data fetched by URI. Discoverable via `resources/list`. No params. | **Candidate v2 promotion:** `tool_help` could become `arceus://tool/{id}` resources — semantically purer, natively discoverable, zero params. *Kept as a tool in v1 for harness portability (OpenCode's Resource-surfacing behavior varies by version).* |
| **Prompt** | Parameterized template the **user/client** surfaces in UI. Not agent-facing. | **Not used.** Skills are agent-facing procedural knowledge; wrong audience for Prompts. |

**Rule:** in v1, every entry in §2 is a Tool. Revisit Resource promotion for read-only metadata (`tool_help`, `TOOL_INDEX`) once OpenCode's Resource behavior is measured.

### Cost & side-effect annotations in tool descriptions

Per MCP best practice — tools that have rate limits, costs, or non-local side effects should say so in the description (within the 160-char budget):

```
task_complete      — "Mark a task completed. Triggers board notifications."
artifact_persist   — "Upload artifact to Supabase storage. Bandwidth cost."
sprint_propose     — "Trigger a CEO sprint proposal (LLM call, ~$0.05)."
```

Pre-commit hook: flag any tool handler that touches network/storage but whose description doesn't hint at the side-effect.

---

## 3.6 — Skill loading: registry-first via filesystem materialization

**Arceus does NOT build or inject a skill catalog into the prompt.** OpenCode's native Tier-1 `<available_skills>` block reads directly from the materialized `.opencode/skills/` directory at session start — that's the selection layer. Progressive disclosure (Index → Detail → Deep) is OpenCode's built-in `skill` tool + SKILL.md `resources/` pattern, not Arceus code.

**Source of truth is the `SkillArtifact` registry** ([packages/company-runtime/src/skill-registry.ts](../packages/company-runtime/src/skill-registry.ts)), not a static directory. Before every beat, `materializeBeatSkills` queries the registry for `{companyId, role, trustBand}` → `active` artifacts, and writes each as an `.opencode/skills/<slug>/SKILL.md` file into the beat's isolated workdir. The filesystem is a materialized *view* of the registry for this one beat. See Phase 6 for the implementation.

**What this deletes:**
- `buildSkillCatalog` / `buildSkillSection` / `buildSkillMenu` / `getSkillBody` from `apps/api/src/skills/catalog.ts` — the entire pre-beat prompt injection path.
- `classifyTaskSkills` / `matchAndRecordSkills` from `apps/api/src/skills/classifier.ts` — LLM-based pre-selection is redundant; OpenCode selects from the materialized catalog natively.
- The `matchedSkillIds` parameter threaded through `runPromptText` at `apps/api/src/prompts/llm.ts:176` — catalog now comes from the filesystem, not the prompt.

**What this adds in v1:**
- `resources?: SkillResource[]` on `skillArtifactSchema` ([packages/contracts/src/skills.ts](../packages/contracts/src/skills.ts)). Each resource: `{ path, kind: "script" | "reference" | "asset", contentType, content, encoding }`. Stored as `resources JSONB` column on the registry table.
- `materializeBeatSkills({ beatId, companyId, role, trustBand, workDir }, { registry })` — queries `registry.getSkillsForRole(companyId, role)` (filtered to `status === "active"` and trust-band policy), writes SKILL.md + `resources/` per artifact.
- `.opencode/arceus-skills.json` manifest — `slug → { skillId, version }` — for the back-channel lookup.
- **Usage back-channel via plugin hook, not an MCP tool.** In [.opencode/plugin/arceus.ts](../.opencode/plugin/arceus.ts), `tool.execute.after` filters on `input.tool === "skill"`, resolves the invoked slug → `{skillId, version}` through the manifest, and POSTs to `/api/internal/v1/skills/:skillId/usage` (fire-and-forget). No `skill_record_usage` MCP tool — keeps skill invocation identical to upstream OpenCode.
- **EMA update on beat verdict.** When the beat completes (pass/fail), the orchestrator calls `registry.updateSuccessRate(skillId, outcome)` for every skill in that beat's `skillsUsed` set. Math unchanged: `lr=0.15`, clamped.

**SDK caveat:** The opencode integration plan (`plans/opencode/05` §3) references a `session.idle` hook for aggregated skill-usage flushing. SDK 1.3.17 has no such hook — per-call POST in `tool.execute.after` is the v1 substitute. If `session.idle` lands in a later SDK, we batch.

**Kept out of v1 (still deferred):**
- Runtime skill mutation via the ATA pipeline (skill-evolution `.ts` rewrite is a separate spec). Registry-write from the ATA pipeline is fine; it already works. What's deferred is collapsing 8 standalone LLM calls into one agent session.
- Trust-band policy table. Trust-band is passed through as a parameter and used in `listActive` today via a simple filter; the full policy matrix is Phase 7+.

---

## 4. The single tool contract — `ToolResult<T>`

Every Tier A/B/C tool returns the same shape. No exceptions. Defined once in `@arceus/contracts`.

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

## 5. Phases

### Phase 0 — Types + package scaffolding (0.5d)

**Pre-flight** (mandatory, 15 min):
1. Query **Context7** for current `@modelcontextprotocol/sdk` API shape — `registerTool()` vs `tool()`, resource URIs, `StdioServerTransport` constructor signature. The SDK churns; never code from memory.
2. Pin exact SDK version in `packages/arceus-mcp/package.json`. Add a note in the README about the version we tested against.

**Package layout** — server logic kept transport-agnostic; entrypoint picks the transport:

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
│       ├── skill.ts             (1 tool — record_usage manual)
│       └── meta.ts              (tool_help, arceus_tool_search)
└── README.md
```

Also in this phase: add `ToolResult<T>` to `packages/contracts/src/tool-result.ts`.

**Deliverable:** empty stubs, Zod schemas, descriptions ≤160 chars each (lint-enforced). No handlers yet.

---

### Phase 1 — Arceus API internal routes (1.5d)

New routes in `apps/api/src/routes/internal-mcp.ts`, mounted under `/api/internal/v1/*`. Every MCP call lands here, gets governance-checked, idempotency-deduped, then calls the existing mutator. Every response normalized to `ToolResult<T>`.

**URL design rules applied (REST / api-design skill):**
- **Plural, kebab-case, lowercase nouns** — `/tasks`, `/artifacts`, `/memory-handoffs`. No singular, no camelCase, no underscores.
- **No verbs in paths.** State transitions live as sub-resources (`.../completion`, `.../block`, `.../verification`, `.../hydration`, `.../preview-url`) that accept `POST`/`PUT`/`DELETE` with the semantically correct method.
- **Explicit versioning** via URL path (`/v1`). Non-breaking changes add fields; breaking changes bump the major.
- **One method per action.** `POST` creates, `PATCH` partially updates whitelisted fields, `PUT` replaces a single-value state slot, `DELETE` clears. No overloaded `POST /tasks` that both creates and updates.
- **Role/identity NEVER in the URL** — derived from the bearer token + `X-Beat-Id` header to prevent spoofing.

#### Route table

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

#### Status code contract

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
| `409 Conflict` | `Idempotency-Key` replay with a **different** body, or state transition conflict (e.g. completing an already-failed task). |
| `422 Unprocessable Entity` | Zod schema failure. Includes field-level `details[]`. |
| `429 Too Many Requests` | Governance rate-limit. Includes `Retry-After` header. |
| `500 Internal Server Error` | Unexpected server failure. Response body never leaks stack traces. |
| `503 Service Unavailable` | OpenCode / downstream hard-down. Includes `Retry-After`. |

#### Required request headers

| Header | Purpose |
| --- | --- |
| `Authorization: Bearer <ARCEUS_TOKEN>` | Identifies caller. Token scopes to a role + company. |
| `X-Beat-Id: <beat-id>` | Ties the mutation to a specific beat for circuit-breaker + audit. |
| `X-Agent-Role: <role>` | **Advisory**; server authoritative value is derived from the token. Logged for trace alignment. |
| `Idempotency-Key: <uuid>` | Required on all non-`GET` routes. Scoped to `(companyId, beatId)`. |
| `Content-Type: application/json` | All bodies are JSON. |

**`Idempotency-Key` semantics (matches Stripe's contract):**
- First request with key `K` executes, result is cached under `sha256(body)`.
- Replay with same key + same body → returns the cached result (200/201/204 as originally).
- Replay with same key + **different** body → `409 Conflict` with `error.cause: "idempotency_body_mismatch"`.
- Keys expire after the beat ends (`session.idle` / `session.error`) — no cross-beat reuse.

#### Response headers

Every response includes:
```
X-RateLimit-Limit: <per-beat cap>
X-RateLimit-Remaining: <left>
X-RateLimit-Reset: <epoch-seconds>
X-Request-Id: <uuid>           # echoes the incoming header or generates one
```

On `429`, add:
```
Retry-After: <seconds>
```

#### Response body — always `ToolResult<T>`

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

Anti-patterns the adapter enforces (rejected by lint + unit test):
- ❌ `200 OK` with `error` populated.
- ❌ Stack traces, SQL errors, or internal paths in `error.details`.
- ❌ Bare strings where `ToolResult<T>` is expected.
- ❌ `error.cause` values outside the enum `{ "validation" | "governance" | "not_found" | "conflict" | "upstream" | "internal" }`.

#### Authorization model

- Bearer token → `(companyId, role)` pair. Role used for governance checks.
- Per-route `requireRole([...])` middleware enforces CEO-only, PM-only, tester-only gates declaratively.
- **No ownership leakage** — agents cannot read/write tasks outside their company, enforced at the middleware layer (not sprinkled in handlers).

#### Rate limiting

Per-beat internal tier: **10 000 req/min per beat**. Per-route overrides documented inline (e.g. `sprints/proposals` limited to 2/beat to prevent runaway CEO loops).

**Deliverable:** 23 routes covered by unit tests; `pnpm --filter @arceus/api test:routes` green; governance denial returns well-formed `error.cause/retry/stop_when`; curl smoke-test script demonstrates each status code path; OpenAPI 3.1 spec auto-generated from Zod schemas and committed to `apps/api/openapi.yaml`.

---

### Phase 2 — Generalize role-specific helpers (1d)

Two hardcoded-to-one-role functions blocking tool exposure.

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

Old functions become thin wrappers calling the new generic ones. **Zero behavior change** in this phase — this is a refactor that unblocks Phase 3.

**Deliverable:** `apps/api/src/memory/handoffs.ts` and `apps/api/src/approvals/*` refactored; all existing tests green.

---

### Phase 3 — MCP tool handlers (1.5d)

Wire each tool in `packages/arceus-mcp/src/tools/*` to its internal route. Every handler wraps the fetch in the envelope adapter.

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

### Phase 4 — Custom tools (Tier A) + governance plugin (1d)

OpenCode offers two separate local mechanisms — we use each for what it's best at:

| Mechanism | Location | What we put here |
|---|---|---|
| **Custom tools** | `.opencode/tool/*.ts` | 4 Tier A tools — callable by the agent |
| **Plugin (hooks only)** | `.opencode/plugin/arceus.ts` | Governance, audit, circuit breaker, watchdog — wraps every tool call but is never called directly |

**Custom tools** (written per-beat by `writeBeatTools`):

```
.opencode/tool/
├── task_update_progress.ts
├── task_append_command.ts
└── task_append_plan_step.ts
```

Each file exports a Zod schema + handler that returns `ToolResult<T>` via the shared `envelope.ts`:

```typescript
// .opencode/tool/task_update_progress.ts
import { tool } from "@opencode/sdk";
import { z } from "zod";
import { envelope } from "./_lib/envelope";

export default tool({
  description: "Report incremental progress on the current task. Returns the updated task state.",
  args: z.object({
    percent: z.number().min(0).max(100),
    note: z.string().max(500).optional(),
  }),
  execute: async ({ percent, note }) =>
    envelope(() => inProcess.updateTaskProgress(ctx.TASK_ID, { percent, note })),
});
```

**Plugin** (written per-beat by `writeBeatPlugin`, hooks only — no tool registration):

```typescript
// .opencode/plugin/arceus.ts
export const ArceusPlugin: Plugin = async ({ client, worktree }) => ({
  "tool.execute.before": async (input, output) => {
    governanceCheck(input);
    circuitBreaker(input);        // refuses on (tool_id, error.cause) count ≥ 3
  },
  "tool.execute.after": async (input, output) => {
    auditEvent(input, output);    // structured audit log per tool call (input, output envelope, latency)
    circuitBreakerTally(input, output);  // record (tool_id, error.cause) failures for the 3-strike refuser
  },
  "session.idle": async () => {
    watchdogTick();               // force-complete if no SSE event for 120s OR 15-min hard cap
  },
});
```

The plugin wraps **every** tool call — Tier A custom tools, Tier B/C MCP tools, and built-ins like `bash`/`edit`. It never registers a tool itself.

**Deliverable:**
- 3 custom tool files under `.opencode/tool/`, each returning `ToolResult<T>` via shared `envelope.ts`.
- 1 plugin file providing `tool.execute.before` (governance + circuit breaker), `tool.execute.after` (audit + circuit-breaker tally), `session.idle` (watchdog).
- p95 Tier A latency measured (expect < 2ms, no stdio roundtrip).

---

### Phase 5 — Per-role agent files + scoped allowlists (0.5d)

Generated per-beat by `writeBeatAgent`. Example `developer.md`:

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
  memory_enrich: true
  memory_clear_blockers: true
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

Generate 8 role files (ceo, cto, pm, developer, tester, ui_designer, marketing, skills_lead). Layer in existing `permission.edit` / `permission.bash` globs per role config.

**Deliverable:** `writeBeatAgent(beat, workDir)` emits correct file; per-role eager catalog measured; CI assertion `eager_token_count < 2500` per role.

---

### Phase 6 — Registry-driven materialization (v1) (1.5d)

Skills live in the `SkillArtifact` registry already built in [packages/company-runtime/src/skill-registry.ts](../packages/company-runtime/src/skill-registry.ts). Per beat, `materializeBeatSkills` queries the registry, filters by `{companyId, role, trustBand}` + `status === "active"`, and writes each artifact as a `.opencode/skills/<slug>/` tree into the beat's workdir. OpenCode's built-in skill loader reads the filesystem natively.

**Source of truth: the registry (Postgres-backed with in-memory hot cache)**

Existing fields (unchanged): `id`, `companyId`, `role`, `name`, `trigger`, `description`, `content`, `version`, `status`, `successRate`, `usageCount`, `createdAt`, `testCases`.

**New in v1:**

```typescript
// packages/contracts/src/skills.ts — add to skillArtifactSchema
resources: z.array(z.object({
  path: z.string(),                                 // e.g. "resources/evidence-templates.md"
  kind: z.enum(["script", "reference", "asset"]),
  contentType: z.string(),                          // "text/markdown" | "application/javascript" | ...
  content: z.string(),                              // base64 when encoding === "base64"
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
})).default([]),
```

Schema migration: add `resources JSONB DEFAULT '[]'::jsonb` column to `skill_artifacts`. Existing rows get `[]` — no backfill needed.

**Materialization function** (new file):

```typescript
// apps/api/src/opencode/materialize-beat-skills.ts (~80 LOC)
import { getSkillsForRole } from "@arceus/company-runtime/skill-registry";

interface MaterializedSkill { slug: string; skillId: string; version: number; }

export async function materializeBeatSkills(input: {
  beatId: string;
  companyId: string;
  role: Role;
  trustBand: "probation" | "standard" | "senior";
  workDir: string;
}): Promise<MaterializedSkill[]> {
  const skillsDir = path.join(input.workDir, ".opencode", "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  const active = getSkillsForRole(input.companyId, input.role)
    .filter(s => s.status === "active")
    .filter(s => trustBandAllows(input.trustBand, s));

  const manifest: Record<string, { skillId: string; version: number }> = {};
  for (const artifact of active) {
    const slug = slugify(artifact.name);
    const skillDir = path.join(skillsDir, slug);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), renderSkillMd(artifact));
    for (const resource of artifact.resources) await writeResource(skillDir, resource);
    manifest[slug] = { skillId: artifact.id, version: artifact.version };
  }

  await fs.writeFile(
    path.join(input.workDir, ".opencode", "arceus-skills.json"),
    JSON.stringify(manifest, null, 2),
  );

  return Object.entries(manifest).map(([slug, m]) => ({ slug, ...m }));
}
```

**SKILL.md frontmatter** (registry fields + arceus metadata for back-channel):

```yaml
---
name: task-completion-checklist
description: Call task_complete only when evidence fields are populated and handoff is staged.  # ≤160 chars
metadata:
  arceus:
    id: skill_7f3a...
    version: 4
    role: developer
    status: active
---
```

**Usage back-channel via plugin hook** — extend [.opencode/plugin/arceus.ts](../.opencode/plugin/arceus.ts):

```typescript
// Inside tool.execute.after handler, add:
if (input.tool === "skill") {
  const slug = (output.args as { name?: string } | undefined)?.name;
  const entry = slug ? manifest[slug] : undefined;  // manifest loaded once at plugin init
  if (entry) {
    void fetch(`${process.env.ARCEUS_API}/api/internal/v1/skills/${entry.skillId}/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.ARCEUS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ beatId: process.env.BEAT_ID, version: entry.version }),
    }).catch(() => {});  // fire-and-forget; usage telemetry is best-effort
  }
}
```

Plugin init reads `.opencode/arceus-skills.json` from the beat workdir once (via `opencode.app.path.cwd` from the plugin input) and holds it in closure. No polling.

**Server route** (new):

```typescript
// apps/api/src/routes/internal-skills.ts — POST /api/internal/v1/skills/:skillId/usage
// Body: { beatId: string, version: number }
// Calls: recordSkillUsage(skillId) → increments usageCount on the artifact
```

**EMA update on beat verdict** — orchestrator hook:

When a beat completes, gather the `skillsUsed` set (aggregated from per-call usage pings for this beatId) and call `updateSuccessRate(skillId, outcome)` per skill, where `outcome ∈ {0, 1}` from the beat verdict. Math unchanged (lr=0.15, clamped). Wire this into `finishBeat` / `failBeatStall` paths in [apps/api/src/heartbeats/event-bridge.ts](../apps/api/src/heartbeats/event-bridge.ts).

**Trust-band filter** — keep it minimal in v1:

```typescript
// probation: only skills with successRate >= 0.75 AND usageCount >= 20
// standard:  all active skills
// senior:    all active skills + draft skills marked reviewable
function trustBandAllows(band: TrustBand, s: SkillArtifact): boolean { ... }
```

Full trust-band policy matrix is Phase 7+.

**Authoring UX (v1): seed-time only.**

Ship a checked-in `.arceus/skills-seed/<slug>/` tree as the developer-facing authoring surface. `seedExistingSkills()` walks it at boot and builds `SkillArtifact` rows with `resources` populated from the filesystem:

```
.arceus/skills-seed/                         ← committed to git; human authoring UX
  task-completion-checklist/
    SKILL.md                                 ← frontmatter (name, description, role, trigger) + body
    resources/
      evidence-templates.md                  ← seeder inlines as { kind: "reference", contentType: "text/markdown", content, encoding: "utf8" }
      error-retry-recipe.md
  ...
```

`seedExistingSkills()` implementation:
1. Read every `<slug>/SKILL.md` — parse frontmatter for name/description/role/trigger/body.
2. Walk `<slug>/resources/` — each file becomes a `SkillResource`. File extension → `contentType`; binary files use `encoding: "base64"`.
3. `INSERT ... ON CONFLICT DO UPDATE` so re-seeding (e.g. after editing a file and restarting) upserts cleanly.

This keeps the "edit a .md, commit, restart" workflow for the 8 baseline skills. Runtime authoring (agents creating/editing skills mid-beat) is **deferred** — see §10.

**Deliverable:**
1. `resources` field added to `skillArtifactSchema` + DB migration + backfill `[]`.
2. `.arceus/skills-seed/` directory populated with the 8 baseline skills.
3. `seedExistingSkills()` extended to load resources from `<slug>/resources/` with idempotent upsert.
4. `materializeBeatSkills()` implemented and called from `writeBeatOpencodeConfig`.
3. `.opencode/arceus-skills.json` manifest written per beat.
4. Plugin extended with skill-usage POST (filter on `tool === "skill"`).
5. Server route `POST /api/internal/v1/skills/:skillId/usage` → `recordSkillUsage`.
6. Beat-verdict hook calls `updateSuccessRate` for each skill in `skillsUsed`.
7. Seed the registry with 8 baseline skills (the same set previously planned: task-completion-checklist, artifact-structure, memory-handoff-protocol, developer-tdd-loop, design-to-dev-handoff, qa-verification-loop, ceo-sprint-proposal-prep, external-approval-request) via `seedExistingSkills`.
8. Integration test: spawn a beat, assert registry row with `usageCount` incremented + `successRate` updated after beat verdict.

---

### Phase 6.5 — The heartbeat-driven beat lifecycle (end-to-end)

> **Philosophy shift:** move from **orchestration** (orchestrator decides what to do, parses agent output, does work itself) to **heartbeat** (orchestrator curates context, wakes agent, steps out of the way; agent reasons and acts via tools; beat dies). This section defines the end-to-end runtime contract Phase 6 plugs into and Phase 7 enforces.

**Mental model:** The heartbeat is a metronome. On each tick, the orchestrator builds a view of the world, wakes one agent, and gets out of the way. The agent is the only thing that reasons. Its reasoning is bounded by (a) the context we give it, (b) the tools it can see, (c) the skills we materialized. When the agent says it's done, the beat dies. Nothing survives across beats except what the agent wrote to Arceus via tool calls.

---

#### 6.5.1 — Path layout: stable vs ephemeral

Arceus has ONE long-lived OpenCode server for the process lifetime. Beats do not spawn new servers. Per-beat isolation is achieved by:
- **Session ID as isolation boundary** (plugin + MCP resolve `sessionID → beat context` via an Arceus-owned registry)
- **`/tmp/arceus/beats/<beatId>/` as ephemeral scratch** (materialized skills; any other beat-scoped content)
- **Symlinked skills directory** so OpenCode reads beat-specific skills from its fixed cwd

| Path | Lifetime | Writer | Reader |
|---|---|---|---|
| `productWorkspace/opencode.json` | Stable (boot) | `writeSharedOpencodeConfig()` | OpenCode server |
| `productWorkspace/.opencode/agent/<role>.md` (×8) | Stable (boot) | `writeBeatAgent()` for each role | OpenCode (picks via `body.agent`) |
| `productWorkspace/.opencode/plugin/arceus.ts` | Stable (boot) | Checked-in source | OpenCode plugin runtime |
| `productWorkspace/.opencode/arceus-skills.json` | Per-beat (symlink target swaps) | `materializeBeatSkills()` | Plugin reads for usage-POST slug→id map |
| `productWorkspace/.opencode/skills/` → **symlink** | Per-beat (swapped) | `materializeBeatSkills()` | OpenCode native skills loader |
| `/tmp/arceus/beats/<beatId>/skills/<slug>/SKILL.md + resources/` | Per-beat (cleaned on death) | `materializeBeatSkills()` | Symlink target |

**Symlink swap pseudocode (at Step 4 below):**

```typescript
const beatSkillDir = `/tmp/arceus/beats/${beatId}/skills`;
await materializeIntoBeatSkillDir(beatSkillDir, companyId, role, trustBand);

const symlink = path.join(productWorkspace, ".opencode", "skills");
try { await fs.unlink(symlink); } catch {}                    // remove old symlink if any
await fs.symlink(beatSkillDir, symlink);                      // point at this beat's tree

await fs.writeFile(path.join(productWorkspace, ".opencode", "arceus-skills.json"), manifestJson);
```

Beats serialize (one at a time for now), so a single symlink is race-free. When concurrent beats become a v2 requirement, replace with per-session OpenCode support (SDK improvement) or per-beat OpenCode spawn (costly).

---

#### 6.5.2 — Boot time (once per Arceus API process)

| Step | Actor | Action |
|---|---|---|
| 0.1 | Arceus API | Connect Postgres; run `seedExistingSkills()` from `.arceus/skills-seed/` into the `SkillArtifact` registry (idempotent upsert) |
| 0.2 | Arceus API | Initialize `sessionContextMap = new Map<sessionId, BeatContext>()` |
| 0.3 | Arceus API | Mount internal routes incl. `GET /api/internal/v1/session-context/:sessionId` and `POST /api/internal/v1/skills/:id/usage` |
| 0.4 | Arceus API | `warmUpOpencode()` — spawn one `opencode serve` child process at `productWorkspace` |
| 0.5 | Arceus API | `writeSharedOpencodeConfig()` — write `opencode.json` with 8 agent defs, MCP wiring, plugin path |
| 0.6 | OpenCode | Plugin init: read `arceus-skills.json` manifest (empty on boot); initialize session-context cache |
| 0.7 | OpenCode | Spawn MCP server child with `ARCEUS_API` + `ARCEUS_TOKEN` in env (process-wide secrets only — nothing beat-specific) |

**Post-boot invariant:** nothing beat-specific exists in any `process.env`, in any cache, or on disk. All state is ready to accept the first beat.

---

#### 6.5.3 — Per-beat lifecycle (every heartbeat tick)

Walkthrough uses a concrete example: **developer beat to implement a login form.**

| Step | Actor | Action |
|---|---|---|
| **1** | Arceus orchestrator | Heartbeat tick. Pick role=`developer`, companyId=`comp_abc`. Generate `beatId=beat_xyz`. **Do NOT pick a task** — that's the agent's job. |
| **2** | Arceus orchestrator | `buildBeatContext(role, companyId)`: read-only assembly of `{companyState, openTasks, recentArtifacts, myMemory, recentProgress, trustBand, allowedTools}`. No instructions — just state. |
| **3** | Arceus orchestrator | `opencode.session.create({ title })` → `session.id = sess_123`. |
| **4** | Arceus orchestrator | `sessionContextMap.set(sess_123, ctx)`. Context is now resolvable via `GET /api/internal/v1/session-context/sess_123`. |
| **5** | Arceus orchestrator | `materializeBeatSkills({ beatId, companyId, role, trustBand, workDir: /tmp/arceus/beats/beat_xyz })` → writes SKILL.md + resources + manifest; swaps `productWorkspace/.opencode/skills` symlink to `/tmp/arceus/beats/beat_xyz/skills`. |
| **6** | Arceus orchestrator | `opencode.session.prompt({ path: { id: sess_123 }, body: { agent: "developer", system: soul, parts: [{ type: "text", text: renderContextAsText(ctx) }], tools: ctx.allowedTools } })`. **Orchestrator now blocks.** |
| **7** | OpenCode + agent | OpenCode loads `developer.md`, reads materialized skills catalog (native `<available_skills>`), receives the state prompt. Agent reasons: *"tsk_42 login form is the highest-value unblocked task."* |
| **8** | Agent | Emits first tool call: `task_claim({ taskId: "tsk_42", reason: "..." })`. |
| **9** | Plugin (`tool.execute.before`) | Cache miss → `GET /api/internal/v1/session-context/sess_123` → cache `ctx`. Check `tool_claim ∈ ctx.allowedTools` → OK. Check 3-strike circuit → OK. Emit audit `{phase: "before", tool, callID, sessionID, startedAt}`. |
| **10** | MCP server | Receive call, resolve session context the same way, proxy to `POST /api/internal/v1/tasks/tsk_42/claim` with headers `x-beat-id`, `x-company-id`, `x-role`, `idempotency-key: claim:beat_xyz:tsk_42`, `Authorization: Bearer ...`. Return `ToolResult` envelope. |
| **11** | Arceus API | Verify claimable (ready, assignable, not locked). Transition `ready → in_progress`. Record `claimedByBeatId`. Return envelope with task details. |
| **12** | Plugin (`tool.execute.after`) | Emit audit `{phase: "after", tool, callID, latencyMs, status, cause}`. On envelope error: increment circuit tally for `(tool, cause)`. |
| **13** | Agent | Does the work: `task_append_plan_step → edit → write → bash → task_append_command → skill(name="developer-tdd-loop") → ...`. Every tool call flows 8→12. Every `skill(...)` call fires a fire-and-forget POST to `/api/internal/v1/skills/:id/usage` via the plugin's `tool.execute.after` branch. |
| **14** | Agent | Decides work is complete. Emits `memory_handoff({ targets: ["tester"], context })` → `task_complete({ taskId, evidence })`. No orchestrator branching — the agent initiates the handoff itself. |
| **15** | OpenCode | `session.prompt` returns. Control unblocks Arceus orchestrator. |
| **16** | Arceus orchestrator | `scoreBeatVerdict(beatId)` → `pass`/`fail` from what the agent actually did (task completed? artifacts created? tests passed?). |
| **17** | Arceus orchestrator | For each skillId in beat's `skillsUsed` set: `registry.updateSuccessRate(skillId, outcome)`. EMA math (lr=0.15, clamped). |
| **18** | Arceus orchestrator | `updateTrustScore(role, companyId, verdict)`. |
| **19** | Arceus orchestrator | `sessionContextMap.delete(sess_123)` — context bridge gone. |
| **20** | Arceus orchestrator | `opencode.session.delete({ path: { id: sess_123 } })`. Plugin + MCP caches self-evict on next activity or via explicit eviction hook. |
| **21** | Arceus orchestrator | `rm -rf /tmp/arceus/beats/beat_xyz` — ephemeral scratch cleanup. Symlink stale-points; gets re-swapped on next beat's Step 5. |
| **22** | Arceus orchestrator | Emit final SSE events, write progress note for this beat, advance heartbeat counter. **Beat is dead.** |

**What is still "shared":** OpenCode server, plugin, MCP server, secrets env, registry connection. **What is beat-scoped:** session, context-map entry, `/tmp/arceus/beats/<beatId>/` dir, symlink target, plugin/MCP per-session cache entries.

---

#### 6.5.4 — Actors and their responsibilities

| Actor | Lifetime | Job | Does NOT do |
|---|---|---|---|
| **Arceus orchestrator** | Process-wide | Curate context, wake agents, score beats, cleanup | Pick tasks, parse output, create artifacts, trigger handoffs, branch on role |
| **`sessionContextMap`** | Process-wide | Bridge `sessionID → beat metadata` | Store agent state (that's in the session) |
| **OpenCode server** | Process-wide | Host sessions, route tool calls | Know anything about beats (it just sees sessions) |
| **Plugin** | Shared across sessions | Enforce allowlist, circuit break, audit, skill-usage POST | Know task-level state |
| **MCP server** | Shared across sessions | Proxy 24 ops → Arceus API with correct headers | Contain business logic |
| **Session** | One beat | Conversation state, message history, tool log | Persist past `session.delete` |
| **Agent (inside session)** | One beat | Read state, reason, act via tools, complete | Know anything beyond what tools return |

---

#### 6.5.5 — New tools introduced by heartbeat design

Beyond the 24 already catalogued, heartbeat-driven execution needs the agent to read its own situation and claim work explicitly. These arrive in Phase 7 alongside specialist-executor deletion:

| Tool | Purpose | Who |
|---|---|---|
| `task_claim` | Transition `ready → in_progress` by the claiming agent. Idempotency key = `claim:${beatId}:${taskId}`. Returns task detail. | All executors |
| `board_list_ready` | List tasks `status === "ready"` assignable to this role, ranked by priority + dependency satisfaction. Read-only. | All executors |
| `beat_read_last_progress` | Read structured progress notes from this role's last N beats (accomplishments, issues, next-steps). Read-only. | All executors |

These push the 24-ops surface to 26-27. Token budget per role still fits under 2,500 (verified in Phase 5 test — adding 3 × ~50-char descriptions = +150 tokens).

---

#### 6.5.6 — Before / after state

| Today (orchestration) | Target (heartbeat) |
|---|---|
| `executeSpecialistTask(taskId)` | `runBeat(role)` |
| Orchestrator picks task, builds prompt with task embedded | Orchestrator builds state, agent picks task |
| Orchestrator parses LLM output for artifact content | Agent calls `artifact_create` itself |
| `if (role === "tester") buildTesterArtifact` | Tester agent structures its own artifact |
| `deliverUiDesignerMemoryHandoff(task, artifactId)` | Designer calls `memory_handoff` |
| `createMarketingExternalApproval(task, artifactId)` | Marketing calls `approval_request` |
| Orchestrator calls `setTaskStatus(taskId, "completed")` | Agent calls `task_complete({ evidence })` |
| specialist-executor.ts: 350 LOC, 12 role branches | `runBeat`: ~30 LOC, zero role branches |
| Role branching scattered across 10+ files | Role appears only as a key into `ROLE_CONFIGS` |

---

#### 6.5.7 — Anti-patterns resolved by this lifecycle

| Anti-pattern | How the lifecycle resolves it |
|---|---|
| **#3, #4, #20** specialist-executor does agent's job | Orchestrator does only Steps 1-6 and 15-22. Steps 7-14 are the agent. Specialist-executor literally deletes in Phase 7. |
| **#9** `role === "..."` magic strings | Role shows up only in `ROLE_CONFIGS` (Phase 5) and `body.agent` selection (Step 6). No post-work branching survives. |
| **#10, #28** governance hardcoded OFF | Plugin's allowlist (Step 9) is populated from `ctx.allowedTools` per session. Every tool call gated. |
| **#12** no idempotency | Every mutation carries `idempotency-key` derived from `(beatId, op, target)` (Step 10). |
| **#17, #18** system ops called procedurally | All 24 ops are tools (Steps 8-14). Orchestrator owns only Steps 1-6 + 15-22 — all reads + cleanup, zero mutations on the agent's behalf. |
| **#19** action-like skills should be tools | `memory_handoff`, `approval_request`, `task_complete` are all agent-called tools in Step 14. |
| **#23** no progress notes between beats | `task_append_plan_step` + `task_append_command` are tools (Step 13); `beat_read_last_progress` reads them next beat (§6.5.5). |

---

#### 6.5.8 — Updated Phase 6 deliverable

Original Phase 6 items 1-8 (skill registry, resources, materialization, plugin hook, server route, EMA update, seed, integration test) are joined by:

9. **Path contract implemented**: `materializeBeatSkills` writes to `/tmp/arceus/beats/<beatId>/skills/` and swaps the `productWorkspace/.opencode/skills` symlink atomically. On beat death, `/tmp/arceus/beats/<beatId>/` is `rm -rf`'d.
10. **`sessionContextMap` implemented** in Arceus API with `register` / `get` / `delete` operations. Internal route `GET /api/internal/v1/session-context/:sessionId` returns the registered `BeatContext` or 404.
11. **Plugin's session-context resolver** fetches from the internal route on first `tool.execute.before` per session, caches in closure keyed by `input.sessionID`. Cache evicts on explicit session-end notification (or on process restart).
12. **MCP server's session-context resolver** mirrors the plugin: every tool call reads `x-session-id` header → resolve → cache → proxy with `x-beat-id`/`x-company-id`/`x-role` headers.
13. **End-to-end integration test**: spawn a real developer beat against a stub Arceus API, verify `sessionContextMap` is populated before `session.prompt`, verify the materialized skill symlink points at the right `/tmp` path, verify a `task_claim` → `task_complete` tool-call sequence produces the expected DB state, verify cleanup runs (symlink removed, /tmp dir gone, map entry deleted).

**Phase 6 ships a running heartbeat-driven beat.** Phase 7 then deletes specialist-executor and introduces the 3 new tools (`task_claim`, `board_list_ready`, `beat_read_last_progress`) to make the agent self-directing.

---

#### 6.5.9 — Implementation plan (executable work packages)

Twelve work packages, dependency-ordered. Each has a concrete file path, exact signature, acceptance gate, LOC estimate, and time estimate. Packages marked **P** can run in parallel once their deps land.

```
Dependency graph:

  A ─┬─→ B ─────────────────┬─→ F (plugin)   ┐
     │                      ├─→ G (MCP)      ├─→ J (runBeat) ─→ L (e2e test)
     └─→ C ─→ D ─→ E ─→ H ──┘                │
                                             │
                   I (buildBeatContext) ─────┘
                                             │
                                  K (scoreBeatVerdict + EMA)
```

---

##### A — `BeatContext` contract  [~30 LOC, 15 min]

**File:** `packages/contracts/src/beat-context.ts`

```typescript
import { z } from "zod";

export const trustBandSchema = z.enum(["probation", "standard", "senior"]);

export const beatContextSchema = z.object({
  beatId: z.string(),
  sessionId: z.string(),
  companyId: z.string(),
  role: z.enum(["ceo","cto","pm","developer","tester","ui_designer","marketing","skills_lead"]),
  trustBand: trustBandSchema,
  allowedTools: z.array(z.string()),
  taskId: z.string().optional(),
  startedAt: z.string().datetime(),
});
export type BeatContext = z.infer<typeof beatContextSchema>;
```

Re-export from `packages/contracts/src/index.ts`.

**Acceptance:** `pnpm --filter @arceus/contracts build` green; `BeatContext` importable from `@arceus/contracts`.

---

##### B — Session-context map + internal route  [~80 LOC, 45 min]

**Files:**
- `apps/api/src/orchestration/session-context.ts`
- `apps/api/src/routes/internal-session-context.ts`

```typescript
// session-context.ts
const sessionContextMap = new Map<string, BeatContext>();
export const registerSessionContext = (ctx: BeatContext): void => { sessionContextMap.set(ctx.sessionId, ctx); };
export const getSessionContext = (sessionId: string): BeatContext | undefined => sessionContextMap.get(sessionId);
export const unregisterSessionContext = (sessionId: string): void => { sessionContextMap.delete(sessionId); };
export const sessionContextSize = (): number => sessionContextMap.size;  // for metrics
```

```typescript
// internal-session-context.ts (Fastify route)
fastify.get("/api/internal/v1/session-context/:sessionId", async (req, reply) => {
  const ctx = getSessionContext((req.params as any).sessionId);
  if (!ctx) return reply.code(404).send({ error: { cause: "not_found", retry: "never", stop_when: "session ended" } });
  return ctx;
});
```

**Acceptance:** unit test — `register → get → unregister` returns correct values and 404 after unregister. HTTP test — GET returns 200 with body, GET after delete returns 404.

---

##### C — Beat path utilities  [~60 LOC, 30 min]

**File:** `apps/api/src/infra/beat-paths.ts`

```typescript
export const beatScratchDir = (beatId: string): string => path.join("/tmp", "arceus", "beats", beatId);
export const beatSkillsDir  = (beatId: string): string => path.join(beatScratchDir(beatId), "skills");
export const productWorkspaceSkillsSymlink = (): string => path.join(productWorkspace, ".opencode", "skills");

export async function swapSkillsSymlink(targetDir: string): Promise<void> {
  const link = productWorkspaceSkillsSymlink();
  try { await fs.unlink(link); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(targetDir, link);
}

export async function cleanupBeatScratch(beatId: string): Promise<void> {
  await fs.rm(beatScratchDir(beatId), { recursive: true, force: true });
}
```

**Acceptance:** integration test — mkdir target, swap symlink, readlink matches target; call swap twice to verify it overwrites; rmdir cleanup removes tree.

---

##### D — `materializeBeatSkills` + DB migration for `resources`  [~200 LOC, 3 h]

**Files:**
- `packages/contracts/src/skills.ts` — extend `skillArtifactSchema` with `resources: z.array(skillResourceSchema).default([])`
- `packages/db/migrations/NNNN_add_skill_resources.sql` — `ALTER TABLE skill_artifacts ADD COLUMN resources JSONB DEFAULT '[]'::jsonb`
- `apps/api/src/opencode/materialize-beat-skills.ts`

```typescript
export interface MaterializedSkill { slug: string; skillId: string; version: number; }

export async function materializeBeatSkills(input: {
  beatId: string;
  companyId: string;
  role: Role;
  trustBand: TrustBand;
}, deps: { registry: SkillRegistry } = { registry: defaultRegistry }): Promise<MaterializedSkill[]> {
  const skillsDir = beatSkillsDir(input.beatId);
  await fs.mkdir(skillsDir, { recursive: true });

  const active = deps.registry.getSkillsForRole(input.companyId, input.role)
    .filter(s => s.status === "active")
    .filter(s => trustBandAllows(input.trustBand, s));

  const manifest: Record<string, { skillId: string; version: number }> = {};
  for (const artifact of active) {
    const slug = slugify(artifact.name);
    const skillDir = path.join(skillsDir, slug);
    await fs.mkdir(path.join(skillDir, "resources"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), renderSkillMd(artifact));
    for (const resource of artifact.resources ?? []) await writeResource(skillDir, resource);
    manifest[slug] = { skillId: artifact.id, version: artifact.version };
  }

  await fs.writeFile(
    path.join(productWorkspace, ".opencode", "arceus-skills.json"),
    JSON.stringify(manifest, null, 2),
  );
  await swapSkillsSymlink(skillsDir);
  return Object.entries(manifest).map(([slug, m]) => ({ slug, ...m }));
}

function trustBandAllows(band: TrustBand, s: SkillArtifact): boolean {
  if (band === "probation") return s.successRate >= 0.75 && s.usageCount >= 20;
  return true;  // standard + senior see all active skills in v1
}
```

**Acceptance:** unit test with 3 fake `SkillArtifact` rows (one active+standard-ok, one deprecated, one active-but-probation-blocked). Assert: only 1 skill written for probation, 2 written for standard. Manifest has correct slug→id mapping. Symlink points at `/tmp/arceus/beats/<beatId>/skills`.

---

##### E — `writeSharedOpencodeConfig` (boot-time)  [~120 LOC, 1.5 h]

**File:** `apps/api/src/infra/opencode.ts` — extend

```typescript
export async function writeSharedOpencodeConfig(): Promise<void> {
  // 1. Copy plugin into productWorkspace
  const pluginSrc = resolve(projectRoot, "..", "..", ".opencode", "plugin", "arceus.ts");
  const pluginDst = resolve(productWorkspace, ".opencode", "plugin", "arceus.ts");
  await fs.mkdir(path.dirname(pluginDst), { recursive: true });
  await fs.copyFile(pluginSrc, pluginDst);

  // 2. Write all 8 agent files
  for (const role of ROLES) await writeBeatAgent(role, productWorkspace);

  // 3. Write opencode.json with MCP wiring + plugin reference
  const config = {
    "$schema": "https://opencode.ai/config.json",
    share: "disabled",
    mcp: {
      arceus: {
        command: ["node", "./node_modules/@arceus/mcp/dist/server.js"],
        env: { ARCEUS_API: runtimeConfig.arceusApi, ARCEUS_TOKEN: runtimeConfig.arceusToken },
      },
    },
    plugin: ["./.opencode/plugin/arceus.ts"],
  };
  await fs.writeFile(
    resolve(productWorkspace, "opencode.json"),
    JSON.stringify(config, null, 2),
  );
}
```

Call from `warmUpOpencode()` before spawning the server.

**Acceptance:** after `warmUpOpencode()` completes, assert: `productWorkspace/opencode.json` exists + has valid `mcp.arceus` section; 8 `.opencode/agent/<role>.md` files exist; `.opencode/plugin/arceus.ts` is a copy of the source.

---

##### F — Plugin session-context + skill-usage  [~150 LOC, 2 h] **(P)**

**File:** `.opencode/plugin/arceus.ts` — extend

```typescript
const sessionCtxCache = new Map<string, BeatContext>();
const manifestPath = path.join(process.cwd(), ".opencode", "arceus-skills.json");
let manifest: Record<string, { skillId: string; version: number }> = {};

async function ensureCtx(sessionId: string): Promise<BeatContext | null> {
  if (sessionCtxCache.has(sessionId)) return sessionCtxCache.get(sessionId)!;
  const res = await fetch(`${process.env.ARCEUS_API}/api/internal/v1/session-context/${sessionId}`, {
    headers: { authorization: `Bearer ${process.env.ARCEUS_TOKEN}` },
  });
  if (!res.ok) return null;
  const ctx = await res.json() as BeatContext;
  sessionCtxCache.set(sessionId, ctx);
  return ctx;
}

// Inside tool.execute.before:
const ctx = await ensureCtx(input.sessionID);
const allowed = ctx?.allowedTools ?? (governance.allowedTools.size > 0 ? [...governance.allowedTools] : []);
if (allowed.length > 0 && !allowed.includes(input.tool)) throw ...;

// Inside tool.execute.after, after audit emit:
if (input.tool === "skill") {
  const slug = (output.args as { name?: string } | undefined)?.name;
  const entry = slug ? manifest[slug] : undefined;
  if (entry && ctx) {
    void fetch(`${process.env.ARCEUS_API}/api/internal/v1/skills/${entry.skillId}/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.ARCEUS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ beatId: ctx.beatId, version: entry.version }),
    }).catch(() => {});
  }
}
```

Manifest re-read on every `tool.execute.before` for a session the plugin hasn't seen this beat (cheap — small JSON file). Cache invalidation: closure-scoped map; self-evicts on process restart.

**Acceptance:** extend `.opencode/test/smoke.ts` — mock fetch for session-context endpoint, verify allowlist comes from ctx not env when ctx exists; mock skill tool call, verify usage POST fires with correct skillId.

---

##### G — MCP server session-context resolver  [~100 LOC, 1.5 h] **(P)**

**Files:**
- `packages/arceus-mcp/src/context-resolver.ts`
- `packages/arceus-mcp/src/http-client.ts` — extend

```typescript
// context-resolver.ts
const cache = new Map<string, BeatContext>();
export async function resolveSessionContext(sessionId: string): Promise<BeatContext | null> {
  if (cache.has(sessionId)) return cache.get(sessionId)!;
  const res = await fetch(`${process.env.ARCEUS_API}/api/internal/v1/session-context/${sessionId}`, {
    headers: { authorization: `Bearer ${process.env.ARCEUS_TOKEN}` },
  });
  if (!res.ok) return null;
  const ctx = await res.json() as BeatContext;
  cache.set(sessionId, ctx);
  return ctx;
}
```

Each tool handler receives `callContext.sessionID`. Before proxy call:

```typescript
// http-client.ts
const ctx = await resolveSessionContext(callContext.sessionID);
if (!ctx) return failure("No beat context for session", "unknown_session", "never", "session ended or malformed");
return fetch(`${ARCEUS_API}${path}`, {
  method, body,
  headers: {
    "x-beat-id": ctx.beatId,
    "x-company-id": ctx.companyId,
    "x-role": ctx.role,
    "x-session-id": callContext.sessionID,
    "idempotency-key": deriveKey(ctx, op, target),
    authorization: `Bearer ${process.env.ARCEUS_TOKEN}`,
  },
});
```

**Acceptance:** integration test — stub Arceus API with a session-context route, invoke one MCP tool with a known sessionID, assert downstream call arrived with correct `x-beat-id` + `x-company-id` + `x-role`.

---

##### H — `POST /api/internal/v1/skills/:skillId/usage`  [~40 LOC, 30 min]

**File:** `apps/api/src/routes/internal-skills-usage.ts`

```typescript
const bodySchema = z.object({ beatId: z.string(), version: z.number().int() });

fastify.post("/api/internal/v1/skills/:skillId/usage", async (req, reply) => {
  const body = bodySchema.parse(req.body);
  recordSkillUsage((req.params as any).skillId);
  recordBeatSkillUsage(body.beatId, (req.params as any).skillId);  // per-beat tally for K
  return { status: "success", summary: "Skill usage recorded" };
});
```

Also new: `apps/api/src/skills/beat-usage.ts`
```typescript
const beatSkillSets = new Map<string, Set<string>>();
export const recordBeatSkillUsage = (beatId: string, skillId: string): void => {
  if (!beatSkillSets.has(beatId)) beatSkillSets.set(beatId, new Set());
  beatSkillSets.get(beatId)!.add(skillId);
};
export const getBeatSkillUsage = (beatId: string): string[] => [...(beatSkillSets.get(beatId) ?? [])];
export const clearBeatSkillUsage = (beatId: string): void => { beatSkillSets.delete(beatId); };
```

**Acceptance:** HTTP POST → registry `usageCount` for skill increments by 1; `getBeatSkillUsage(beatId)` returns the skillId.

---

##### I — `buildBeatContext`  [~180 LOC, 2.5 h] **(P)**

**File:** `apps/api/src/orchestration/beat-context-builder.ts`

```typescript
export async function buildBeatContext(role: Role, companyId: string, beatId: string, sessionId: string): Promise<BeatContext> {
  return {
    beatId,
    sessionId,
    companyId,
    role,
    trustBand: await computeTrustBand(role, companyId),
    allowedTools: getAllowedArceusTools(role),  // from Phase 5 ROLE_CONFIGS
    startedAt: new Date().toISOString(),
  };
}

// Separately, the *state description* rendered into the prompt:
export function renderStateForAgent(role: Role, companyId: string): string {
  const sections = [
    renderCompanyState(companyId),
    renderOpenTasksForRole(companyId, role),
    renderRecentArtifacts(companyId, 10),
    renderRoleMemory(role, companyId),
    renderLastProgressNotes(role, companyId, 5),
  ];
  return sections.join("\n\n");
}
```

Note: `BeatContext` carries the metadata the plugin+MCP need; `renderStateForAgent` builds the text the agent sees in its prompt. Two separate concerns.

**Acceptance:** unit test with fake DB state, assert all 5 sections present, trustBand computed correctly, allowedTools matches ROLE_CONFIGS.

---

##### J — `runBeat` orchestrator  [~150 LOC, 2 h]

**File:** `apps/api/src/orchestration/run-beat.ts`

```typescript
export async function runBeat(input: { role: Role; companyId: string }): Promise<BeatResult> {
  const beatId = `beat_${crypto.randomBytes(6).toString("hex")}`;
  const opencode = await getOpencode();

  // Step 3: create session
  const session = await opencode.client.session.create({ body: { title: `Beat ${beatId} — ${input.role}` } });
  if (!session.data) throw new Error(`session.create failed for ${input.role}`);

  // Step 2+4: build & register context
  const ctx = await buildBeatContext(input.role, input.companyId, beatId, session.data.id);
  registerSessionContext(ctx);

  // Step 5: materialize skills + swap symlink
  await materializeBeatSkills({ beatId, companyId: input.companyId, role: input.role, trustBand: ctx.trustBand });

  // Step 6: wake the agent (blocks)
  const stateText = renderStateForAgent(input.role, input.companyId);
  const soul = ROLE_SOULS[input.role].systemPrompt;
  try {
    await opencode.client.session.prompt({
      path: { id: session.data.id },
      body: {
        model: { providerID: "azure", modelID: ensureDeployment("workerDeployment") },
        agent: input.role,
        system: soul,
        parts: [{ type: "text", text: stateText }],
        tools: Object.fromEntries(ctx.allowedTools.map(t => [t, true])),
      } as any,
    });
  } finally {
    // Steps 16-22: cleanup
    const verdict = await scoreBeatVerdict(beatId);  // package K
    const usedSkills = getBeatSkillUsage(beatId);
    for (const skillId of usedSkills) updateSuccessRate(skillId, verdict === "pass" ? 1 : 0);
    clearBeatSkillUsage(beatId);
    updateTrustScore(input.role, input.companyId, verdict);
    unregisterSessionContext(session.data.id);
    try { await opencode.client.session.delete({ path: { id: session.data.id } }); } catch {}
    await cleanupBeatScratch(beatId);
  }

  return { beatId, sessionId: session.data.id, verdict };
}
```

**Acceptance:** mocked-OpenCode unit test — `runBeat({role, companyId})` completes, all cleanup branches execute (verdict scored, symlink unlinked, /tmp gone, sessionContextMap empty).

---

##### K — `scoreBeatVerdict` + EMA glue  [~100 LOC, 1.5 h]

**File:** `apps/api/src/orchestration/beat-scoring.ts`

```typescript
export async function scoreBeatVerdict(beatId: string): Promise<"pass" | "fail"> {
  // v1 heuristic: did the agent call task_complete? any task_block?
  const completed = await queryTaskTransitions(beatId, "completed");
  const blocked   = await queryTaskTransitions(beatId, "blocked");
  if (blocked > 0) return "fail";
  if (completed > 0) return "pass";
  return "fail";  // no completion signal → failed beat
}
```

More sophisticated verdict logic lands Phase 7+ (artifact quality, test pass rate, preview-probe status).

**Acceptance:** unit test — seed 3 task transitions (1 completed, 0 blocked) → `pass`; (0, 1) → `fail`; (0, 0) → `fail`.

---

##### L — End-to-end integration test  [~200 LOC, 3 h]

**File:** `apps/api/test/heartbeat-lifecycle.e2e.ts`

```typescript
test("heartbeat-driven beat: wake → claim → complete → cleanup", async () => {
  await seedCompany("comp_test");
  await seedTask({ id: "tsk_1", companyId: "comp_test", role: "developer", status: "ready" });

  const mockOpencode = mockOpencodeServer({
    onPrompt: async ({ sessionId }) => {
      // simulate the agent calling two tools
      await fakeToolCall({ sessionId, tool: "task_claim", args: { taskId: "tsk_1" } });
      await fakeToolCall({ sessionId, tool: "task_complete", args: { taskId: "tsk_1", evidence: {} } });
    },
  });

  const result = await runBeat({ role: "developer", companyId: "comp_test" });

  expect(result.verdict).toBe("pass");
  expect(getTask("tsk_1").status).toBe("completed");
  expect(sessionContextSize()).toBe(0);                        // map entry cleaned
  expect(fs.existsSync(beatScratchDir(result.beatId))).toBe(false);  // /tmp cleaned
  expect(await fs.readlink(productWorkspaceSkillsSymlink()).catch(() => null)).toBeNull();  // symlink unlinked
});
```

Plus: test context resolution — plugin + MCP mock tool calls arrive with correct headers from the sessionContextMap; test symlink atomicity — call runBeat twice back-to-back, second beat's skills don't bleed from first.

**Acceptance:** test passes green in `pnpm --filter @arceus/api test`.

---

##### Execution order (sequential + parallel lanes)

```
Day 1 AM:  A (contract) → B (sessionMap+route) → C (paths)        [~1.5 h total]
Day 1 PM:  D (materialize + migration)                             [~3 h]
Day 2 AM:  E (writeSharedOpencodeConfig)  +  H (usage route)       [~2 h, parallel lanes possible]
Day 2 PM:  F (plugin) + G (MCP) + I (buildBeatContext)             [~6 h, 3 parallel lanes]
Day 3 AM:  J (runBeat) + K (scoreBeat)                             [~3.5 h]
Day 3 PM:  L (e2e test) + bug fixes                                [~3 h]

Total: ~20 h ≈ 2.5 engineer-days for Phase 6 + 6.5 together.
```

---

##### Exit criteria for Phase 6 + 6.5

- [ ] All 12 packages land with acceptance tests green
- [ ] `pnpm --filter @arceus/contracts build` + `pnpm --filter @arceus/api test` + `npm run typecheck` in `.opencode/` all green
- [ ] `runBeat({ role: "developer", companyId })` completes against a real OpenCode server (warm, local Postgres)
- [ ] Plugin audit log shows governance gate enforcement (at least one rejected call with wrong allowlist)
- [ ] Registry shows `usageCount` incremented and `successRate` updated after one real beat
- [ ] `/tmp/arceus/beats/<beatId>/` cleaned, `sessionContextMap.size === 0` post-beat

Ship this, Phase 7 (specialist-executor deletion + 3 new `board_*` / `task_claim` / `beat_read_last_progress` tools) is net-subtractive.

---

### Phase 7 — Heartbeat shadow mode + self-direction tools (2d)

Phase 6 ships the machinery. Phase 7 proves the heartbeat-driven design works and adds the 3 tools that let agents self-direct instead of being handed a task ID.

**Goal:** for ≥10% of beats, skip `executeSpecialistTask` entirely and route through `runBeat(role)`. Compare outcomes against the orchestration path on the remaining 90% to quantify divergence before we flip.

**7.1 — Add the 3 self-direction tools** (adds to MCP server, not standalone):

| Tool | Signature | Owner route |
|---|---|---|
| `board_list_ready` | `(filter?: { priority?: "high"|"normal" }) → ReadyTask[]` | `GET /api/internal/v1/tasks/ready?role=<role>&companyId=<companyId>` |
| `task_claim` | `(taskId: string, reason: string) → ClaimedTask` | `POST /api/internal/v1/tasks/:id/claim` — idempotency key = `claim:${beatId}:${taskId}` |
| `beat_read_last_progress` | `(n: number = 3) → ProgressNote[]` | `GET /api/internal/v1/beats/recent?role=<role>&companyId=<companyId>&n=<n>` |

All three are read-scoped (except `task_claim` which mutates status `ready → in_progress`). Per-role eager catalog re-measured: +3 tools × ~55-char descriptions = +165 tokens. Still under 2,500/role budget from Phase 5.

**7.2 — Shadow routing with feature flag `ARCEUS_HEARTBEAT_SHADOW`:**

```typescript
// heartbeat tick handler
if (shouldShadow(companyId, role)) {          // hash(companyId+role+tick) % 10 === 0 → ~10%
  const shadowResult = await runBeat({ role, companyId });  // new heartbeat path
  emitShadowTelemetry(shadowResult);
} else {
  await executeSpecialistTask(taskId);        // legacy orchestration path
}
```

Shadow and live paths never run for the same tick — one or the other. Comparison is statistical across many beats, not per-beat.

**7.3 — Divergence metrics** (logged per shadow beat):

| Axis | What we measure | How |
|---|---|---|
| Task selection | Did the agent claim the same task the orchestrator would have picked? | Log `orchestratorWouldHaveChosen` alongside `agentPicked` |
| Completion | Did the agent reach `task_complete` or `task_block` within the beat? | Check task state transitions for this beatId |
| Artifacts | Did the agent produce artifacts similar in count/kind to orchestration? | Compare `artifact.count` + `artifact.kind[]` per role |
| Handoffs | Did the agent call `memory_handoff` when orchestration would have? | Compare presence of `memory_handoff` tool call vs orchestrator-triggered wrapper |
| Verdict | Did `scoreBeatVerdict` agree? | Compare pass/fail between shadow and counterfactual |

**7.4 — Recovery contract (v1 scope, honest):**

| Concern | Mechanism | Status |
|---|---|---|
| **Hard cap** per beat | `runBeat` wraps `session.prompt` in `Promise.race([prompt, setTimeout(15 * 60_000)])`. Timeout → force `session.delete`, mark beat verdict `fail`, cause=`beat_hard_cap`, retry=`unsafe`. | Ships in Phase 6 (package J) |
| **Developer stall** | Existing `scheduleDeveloperWatchdog` in [workspace/watchdog.ts](../apps/api/src/workspace/watchdog.ts) continues to run for developer sessions — unchanged from today. | Already live |
| **Idle detection for non-developer roles** | None in v1. Tester/designer/marketing/etc. beats get hard-cap only. | Deferred (§10 "Outer watchdog generalization") |
| **Last-tool diagnostic on timeout** | Plugin's `tool.execute.before`/`after` pair gives before-without-after as the smoking gun. No persistent audit sink yet. | Deferred (§10) |
| **Force-complete after idle** | Not implemented. Plan 05 prescribed `session.idle` — SDK lacks it. `event`-based watchdog deleted (redundant with outer). | Deferred |

**7.5 — Benchmarks collected per beat** (harness metrics):

- completion rate (did task reach terminal state without hard-cap)
- retries per task
- pass@1 (terminal state on first try, no corrections)
- cost per successful task ($)
- time-to-first-tool-call (agent bootstrap latency)
- tool-calls-per-beat (breadth of agent action)

**Deliverable:**
- 3 new MCP tools registered, descriptions ≤160 chars, lint green
- `ARCEUS_HEARTBEAT_SHADOW=true` routes 10% of beats through `runBeat`
- Divergence report surfaced in audit log with 5 axes (7.3)
- 6 benchmark metrics tracked in observability dashboard
- Flip criteria published: divergence ≤5% on all 5 axes + hard-cap rate ≤2% for one full sprint

---

### Phase 8 — Delete specialist-executor (1d)

When Phase 7 flip criteria are met:

**8.1 — Promote the flag:**
- Set `ARCEUS_HEARTBEAT_DEFAULT=true`. Heartbeat routes 100% through `runBeat`.

**8.2 — Delete, don't shrink:**

Specialist-executor is not shrunk to 30 lines. It's **deleted outright**. The only external caller becomes `runBeat`.

| File | Action | Reason |
|---|---|---|
| `apps/api/src/tasks/specialist-executor.ts` | **delete file** | Entire responsibility moved to `runBeat` + agent tool calls |
| `apps/api/src/memory/handoffs.ts` → `deliverUiDesignerMemoryHandoff`, `deliverSkillsLeadMemoryHandoff` | **delete functions** | Agents call generic `memory_handoff` tool themselves |
| `apps/api/src/approvals/*` → `createMarketingExternalApproval` | **delete function** | Marketing agent calls `approval_request` tool itself |
| `apps/api/src/tasks/*` → `buildTesterArtifact`, `buildDesignDirectionArtifact`, all role-specific builders | **delete functions** | Agent structures its own artifact via `artifact_create` |
| `apps/api/src/tasks/planner.ts` → `generateWorkflowTaskPlan` standalone LLM call | **leave for ATA spec** | Orthogonal; stays in specialist-executor's place for now if anything calls it |

**8.3 — Skill pre-flight deletion list** (made redundant by §3.6 + Phase 6 materialization):

| File / symbol | Action | Reason |
|---|---|---|
| `apps/api/src/skills/classifier.ts` (entire file) | delete | `classifyTaskSkills` + `matchAndRecordSkills` replaced by OpenCode native `<available_skills>` read from the materialized tree |
| `buildSkillCatalog` / `buildSkillSection` / `buildSkillMenu` / `getSkillBody` in `apps/api/src/skills/catalog.ts` | delete | No prompt-side catalog injection — OpenCode loads from `.opencode/skills/` symlink |
| `matchedSkillIds` parameter in `runPromptText` at `apps/api/src/prompts/llm.ts:176` | delete | Call site gone; catalog comes from filesystem |
| `matchAndRecordSkills` import at `apps/api/src/heartbeats/beat-executor.ts:25` and call at `:81` | delete | beat-executor itself gets replaced by `runBeat`; these paths disappear with it |
| `skillClassifierSchema` + barrel exports in `apps/api/src/skills/index.ts` | delete | Schema unused after classifier deletion |
| Pre-Phase-6 client-side `recordSkillUsage` call sites in `apps/api/src/skills/*` | delete | Usage now recorded by the plugin hook → `POST /api/internal/v1/skills/:id/usage` route → `recordSkillUsage` in `skill-registry.ts` (server-side). Keep the server-side function; delete only the old client-side filter callers. |

**8.4 — CI grep guards** (PR check):

```bash
# No role-branching in post-beat logic
! rg -n 'if\s*\(\s*(?:role|agent\.role|task\.assignedRole)\s*===\s*"' apps/ packages/

# Skill pre-flight symbols fully removed
! rg -n 'classifyTaskSkills|matchAndRecordSkills|buildSkillCatalog|buildSkillSection|buildSkillMenu|getSkillBody|matchedSkillIds|skillClassifierSchema' apps/ packages/

# specialist-executor.ts does not exist
[ ! -f apps/api/src/tasks/specialist-executor.ts ]
```

If any check returns a hit, the PR fails.

**8.5 — Update callers:**

Search for remaining `executeSpecialistTask` / `runAutonomousReadyTasks` callers; route them to `runBeat({ role, companyId })`. Heartbeat tick handler is the primary caller; anything else is either a test (update) or dead code (delete).

**Deliverable:**
- `specialist-executor.ts` deleted
- `deliverUiDesignerMemoryHandoff`, `createMarketingExternalApproval`, role-specific artifact builders all deleted
- Skill pre-flight layer fully removed; CI grep guards wired into PR check
- `runBeat` is the sole beat entry point; heartbeat tick → `runBeat`
- All tests green; no hidden orchestration-mode code paths remain

---

### Phase 9 — Optional: `arceus_tool_search` bridge (0.5d)

**Almost certainly not needed in v1.** Phase 5 measurement showed per-role eager catalogs at ~650-750 tokens each. Even after Phase 7 adds 3 more tools (~165 tokens) and Phase 8's new `runBeat` path exposes any deferred Tier C tools to additional roles (+~200 tokens generous upper bound), we're well under the 2,500-token budget per role.

**Ship only if** (monitored during Phase 7 shadow):
- Any role's eager catalog exceeds 2,500 tokens after final adjustments, **or**
- Benchmark `time-to-first-tool-call` regresses >30% and bisection pins it to catalog bloat

**If triggered**, add `packages/arceus-mcp/src/tools/search.ts`:

- Registers one eager meta-tool: `arceus_tool_search({ query: string }) → { tool_id, description }[]` (3–5 matches)
- Reads from `TOOL_INDEX.json` generated at MCP server startup
- Plugin's `tool.execute.before` gates Tier C tools: `tool ∈ tierC` AND no prior `arceus_tool_search` call in this session → reject with `cause=search_first`, `retry=safe`, `stop_when="called arceus_tool_search"`
- Removable when OpenCode ships `experimental.mcp_lazy`

**Deliverable (conditional):** one tool file (~100 LOC); per-beat `ARCEUS_TOOL_SEARCH=true` enables it. If not triggered during Phase 7, mark Phase 9 **skipped** and close the plan.

---

## 6. File-level impact

### New files (16)

| File | Lines |
|---|---|
| `packages/contracts/src/tool-result.ts` | ~30 |
| `packages/arceus-mcp/src/server.ts` | ~60 (transport-agnostic McpServer + tool registration) |
| `packages/arceus-mcp/src/transport-stdio.ts` | ~30 (entrypoint, bearer auth, stdio transport) |
| `packages/arceus-mcp/src/transport-http.ts` | ~30 (STUB for v2) |
| `packages/arceus-mcp/src/context.ts` | ~30 |
| `packages/arceus-mcp/src/http-client.ts` | ~60 |
| `packages/arceus-mcp/src/envelope.ts` | ~40 |
| `packages/arceus-mcp/src/tool-index.ts` | ~60 |
| `packages/arceus-mcp/src/tools/*.ts` (9 files) | ~450 |
| `apps/api/src/routes/internal-mcp.ts` | ~320 |
| `apps/api/src/opencode/write-beat-tools.ts` | ~70 (emits 3 `.opencode/tool/*.ts` + shared `_lib/envelope.ts`) |
| `apps/api/src/opencode/write-beat-plugin.ts` | ~120 (hooks only: governance, audit, circuit breaker, watchdog) |
| `apps/api/src/opencode/write-beat-agent.ts` | ~90 |
| `apps/api/src/opencode/write-beat-opencode-config.ts` | ~60 |
| `apps/api/src/opencode/materialize-beat-skills.ts` | ~20 (raw `.md` copy + role filter, v1 — no registry) |
| `.arceus/skills/*/SKILL.md` (8 seed skills + resources + `roles:` frontmatter) | ~2,800 |

### Modified files (8)

| File | Change |
|---|---|
| `apps/api/src/memory/handoffs.ts` | Generalize delivery functions (Phase 2) |
| `apps/api/src/approvals/*.ts` | Generalize marketing approval (Phase 2) |
| `apps/api/src/tasks/specialist-executor.ts` | Strip procedural cascade (Phase 8) |
| `apps/api/src/orchestration/execution-cycle.ts` | Call `writeBeatAgent` / `writeBeatTools` / `writeBeatPlugin` / `writeBeatOpencodeConfig` pre-dispatch |
| `apps/api/src/heartbeats/beat-executor.ts` | Gate old path behind `ARCEUS_MCP_SHADOW` flag |
| `apps/api/src/persistence/store.ts` | Add field whitelist on `updateTask` |
| `package.json` (root) | Add `packages/arceus-mcp` to workspaces |

> **Note:** `packages/company-runtime/src/skill-registry.ts` is **not** modified in v1 — the registry stays untouched. The v1 skill path is filesystem-only; registry changes (adding `resources: SkillResource[]`, EMA metrics, etc.) ship with v2 when we reintroduce registry-driven selection.

### Deleted files (post-Phase 8)

- Role-specific handoff wrappers (`deliverUiDesignerMemoryHandoff`, `createMarketingExternalApproval`) — logic moved to generic helpers.
- ~200 LOC of `if (role === "...")` blocks in `specialist-executor.ts`.
- `apps/api/src/skills/classifier.ts` (entire file) — skill pre-flight replaced by OpenCode native catalog.
- `buildSkillCatalog` / `buildSkillSection` / `buildSkillMenu` / `getSkillBody` from `apps/api/src/skills/catalog.ts` — prompt-side catalog injection removed.
- `matchedSkillIds` parameter from `apps/api/src/prompts/llm.ts` and call sites in `apps/api/src/heartbeats/beat-executor.ts`.

---

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Agent doesn't call `task_complete` → task stays in-progress forever | HIGH | **Event-based watchdog**: force-complete if no SSE event (`message.delta` or `tool.execute.after`) for 120s, OR 15-min hard session cap. Not wall-clock idle — LLM inference can legitimately take 30-45s |
| Governance whitelist too strict → agent can't do its job | HIGH | Start permissive (`task_update` allows title/description only); grow whitelist from shadow telemetry |
| Agent stuck in retry loop on same error (LLMs ignore `retry: "never"`) | HIGH | Plugin `tool.execute.before` tracks `(tool_id, error.cause) → count`; hard-refuses at count ≥ 3 with `retry="never"` — enforcement, not advisory |
| MCP SDK API drift breaks `registerTool`/transport calls | HIGH | Pin exact `@modelcontextprotocol/sdk` version in Phase 0; Context7 lookup before every SDK upgrade |
| Tool description bloat creeps back in | MEDIUM | Pre-commit hook: fail if any `src/tools/*.ts` description > 160 chars or lacks side-effect hint for network/storage ops |
| Eager catalog token count creeps past budget | MEDIUM | CI **hard-fails** on `eager_token_count ≥ 2500` per role with list of demotion candidates. **No auto-demotion** — human picks (silent tier changes break SKILL.md contracts) |
| Stdio serialization overhead higher than expected | MEDIUM | Measure in Phase 3 with Inspector; if p95 > 20ms, promote offenders to Tier A |
| Shadow-mode divergence: agent skips `memory_enrich` systematically | MEDIUM | Skill-creator pass on `memory-handoff-protocol` SKILL.md; if still drifting, make `memory_enrich` a soft requirement via plugin `tool.execute.after` on `task_complete` |
| `ToolResult<T>` envelope drift across MCP vs plugin | MEDIUM | Single `envelope.ts` used by both; Zod-parsed in an integration test for every tool |
| Cross-beat accidental double-mutation (agent loses context) | MEDIUM | Per-op idempotency mode: **natural** (business-key, e.g. `task_complete` keyed by `task_id`), **content-hash** (e.g. `task_append_plan_step` keyed by `sha256(step_text)`), **beat-scoped** (log-like ops). Table in §2 annotates each |
| Static `.arceus/skills/` drifts from runtime needs (no EMA feedback in v1) | MEDIUM | v1 accepts this tradeoff — authoring = PR-reviewed `.md` edit. v2 reintroduces `SkillRegistry` + EMA success-rate sync once we have enough beat telemetry to warrant it. Shadow-mode logs capture "skill was available but not cited" signals for future registry seeding |
| Role-check ripple beyond `specialist-executor.ts` | LOW | Grep audit in Phase 8 before deletion |
| `arceus_tool_search` needed sooner than Phase 9 | LOW | Phase 9 is ready to ship standalone |
| Need for remote (non-local) clients in future | LOW | `transport-stdio.ts` / `transport-http.ts` split in Phase 0 means Streamable HTTP is an entrypoint swap, not a rewrite |

---

## 8. Verification (end-to-end)

1. **Unit** — each MCP tool → internal route → mutator round-trip. Mock Arceus API, assert correct side effects + envelope shape.
2. **Integration** — spin up full Arceus + `opencode run --agent developer` in a sandbox workdir. Task: "add JWT refresh." Assert: `task_complete` called, artifact in DB, memory enriched, workspace checkpointed, sprint advances.
3. **Cross-harness** — `claude mcp add arceus`. Manually invoke `task_complete`. Assert same effect as via OpenCode.
4. **Shadow divergence** — after Phase 7, run 50 beats in shadow mode. Require ≤5% divergence from orchestrator's procedural path before Phase 8.
5. **Harness benchmarks** — completion rate, retries per task, pass@1, cost per successful task; logged per beat, dashboard wired in Phase 7.
6. **Context budget** — CI asserts eager catalog token count < 2,500 per role.
7. **Anti-pattern gates** (PR review checklist):
   - ❌ Two tools with overlapping semantics (`task_finish` vs `task_complete`).
   - ❌ Error-only output without `next_actions` or `retry` hint.
   - ❌ Tool description with examples (those live in `tool_help` or `SKILL.md`).
   - ❌ New eager-tier tool added without deleting one or justifying the budget bump.
   - ❌ Macro-tool bundling unrelated ops to "save round trips."

---

## 9. Complexity & timeline

| Phase | Complexity | Est. |
|---|---|---|
| 0 — Scaffolding + `ToolResult<T>` | Low | 0.5d |
| 1 — Internal routes | Medium | 1.5d |
| 2 — Generalize helpers | Low | 1d |
| 3 — MCP handlers + `tool_help` | Medium | 1.5d |
| 4 — Plugin + Tier A | Medium | 1d |
| 5 — Per-role agent files | Low | 0.5d |
| 6 — SKILL.md authoring + `resources/` | Medium | 1d |
| 7 — Shadow mode + benchmarks | High | 2d |
| 8 — Flip + delete | Medium | 1d |
| 9 — `arceus_tool_search` bridge (optional) | Low | 0.5d |

**Total: 9.5d** (10d with Phase 9).

---

## 10. What this plan deliberately does NOT do

- No Strata 4-stage funnel — 24 tools don't justify the complexity.
- No embedding-based tool selection — per-role scoping + `arceus_tool_search` is enough.
- No "code-as-tools" sandbox — revisit if benchmarks show context pressure after Phase 8.
- No rewrite of the skill-evolution ATA pipeline — orthogonal, separate spec.
- No change to the 180 remaining orchestrator-internal ops.
- No MCP Resources or Prompts in v1 — Tools only. Revisit Resources for `tool_help` once OpenCode's Resource behavior is measured.
- No Streamable HTTP transport in v1 — stdio only. Entrypoint split in Phase 0 makes HTTP a swap, not a rewrite.
- No rewrite of the skill-evolution ATA pipeline in v1 — the 8-call ATA lambda chain in [evolution.ts](../apps/api/src/skills/evolution.ts) keeps writing to the registry as it does today. Collapsing those 8 standalone `structuredCompletion` calls into one agent-session conversation is a separate spec. v1 benefits from the registry + EMA even without touching ATA.
- No full trust-band policy matrix in v1 — `trustBandAllows()` ships with a minimal three-band filter (probation/standard/senior). Full role × band × skill-status matrix is Phase 7+.
- No `session.idle` batched skill-usage flush — SDK 1.3.17 has no such hook. Per-call POST in `tool.execute.after` is the v1 substitute; batch when SDK adds the hook.
- **Runtime skill-resource authoring deferred.** v1 ships seed-time authoring only (`.arceus/skills-seed/<slug>/resources/` → `SkillArtifact.resources` JSONB via `seedExistingSkills`). Agents cannot add or edit resources on a live artifact during a beat. The two runtime paths — (a) admin API `PUT /api/internal/v1/skills/:id/resources` + CLI (`arceus skill add-resource`), and (b) a `skill.upsert_resource` MCP tool granted to the skills_lead agent — are deferred until there's a concrete need. The ATA pipeline's `skillMutator` also can't propose resource changes yet; extending its output schema to include resource diffs is part of the separate ATA-rewrite spec. v1 contract: humans author at seed time, agents consume at runtime.
- **Memory handoff generalization deferred.** `deliverUiDesignerMemoryHandoff` and `deliverSkillsLeadMemoryHandoff` ([handoffs.ts](../apps/api/src/memory/handoffs.ts)) remain as role-specific wrappers. A generic `deliverMemoryHandoff({ fromRole, targets: [{ role, currentFocus, activePatterns, ... }] })` is the right shape, but the role-specific side effects (what each target cares about) are still best expressed as orchestrator-authored templates until specialist agents learn to emit handoff intents in their own output.
- **Outer watchdog generalization deferred to Phase 7.** [`scheduleDeveloperWatchdog`](../apps/api/src/workspace/watchdog.ts) is developer-only and fused to workspace file-change monitoring (a developer-specific signal) and `activeExecution.buildTaskId` (single-task model). Making it per-role requires: (a) per-role timer map in `state.ts` replacing single `developerWatchdog`, (b) per-role activity signal (non-developer roles have no workspace monitor equivalent), (c) per-role escalation meeting templates, (d) per-role active-task resolution. The plugin-level watchdog was removed in Phase 4 cleanup (SDK has no `session.idle` hook; `event` firehose cannot fire in true silence — redundant with outer timer, inferior to it). Status quo: developer is the only role with stall-detection teeth; other roles rely on beat-level scheduling cadence. Revisit during Phase 7 specialist-executor collapse.
- **Last-tool diagnostic blocked on audit sink.** When the outer watchdog fires, we want "last tool call was `bash` (callID c43), started 14m ago, no matching `after` event" in the failure message. The plugin's `tool.execute.before`/`after` audit pair is the right evidence (we emit both, with `callID` + `sessionID` + `startedAt` + `latencyMs`), but today it writes to stderr only — no persistent, queryable store the outer watchdog can grep. Requires: (1) audit sink decision (stderr-tee to file, append-only JSONL per session, or DB table), (2) `readLastToolEvent(sessionID)` helper, (3) `failBeatStall` enriches its diagnostic message. Low value to half-build; wire alongside audit sink when Phase 7 needs observability anyway.
- **Agent-authored approval requests deferred.** In v1, [specialist-executor.ts:231](../apps/api/src/tasks/specialist-executor.ts:231) still hardcodes `if (role === "marketing" && kind === "distribution_campaign")` to fire `requestApproval(...)` with a templated title/description. The correct shape is: marketing agent gets the `POST /api/internal/v1/approvals` MCP tool in its toolbelt and decides *whether* and *what* to request during its own run — deleting the post-task branch entirely. Requires a tool-use loop (not one-shot `structuredCompletion`), MCP bearer threaded into the agent session, and a governance fallback for "agent didn't request one but the kind says it's required." Belongs in the same spec as Path C for the rest of the rigid `if (role === ...)` branches in specialist-executor.

---

## 11. Transport & SDK strategy

**Transport: stdio only in v1.**
- Every MCP client we care about (OpenCode, Claude Code, Inspector) supports stdio natively.
- `transport-stdio.ts` and `transport-http.ts` are split at the entrypoint layer. Server logic (`server.ts` + `tools/*`) is transport-agnostic.
- Promoting to Streamable HTTP later = wire `transport-http.ts` + add `ARCEUS_MCP_BIND=0.0.0.0:7777` env. No tool code changes.

**SDK discipline:**
- Pin exact `@modelcontextprotocol/sdk` version in `package.json`. Never use `^` or `~`.
- Before any SDK upgrade: Context7 lookup → diff release notes → run Level 1 Inspector smoke test.
- SDK API naming (`registerTool` vs `tool`, `StdioServerTransport` constructor shape) has churned. Treat it as unstable until the spec ships 1.0.

**Testing ladder (runs without Arceus):**
1. Level 0 — unit tests on schemas + envelope (`vitest`).
2. Level 1 — MCP Inspector → stdio server with mock env.
3. Level 2 — Inspector → MCP → 30-line mock Express at `/internal/mcp/*`.
4. Level 3 — `opencode run --agent developer` against Level 2 mock + generated `.opencode/*` tree.
5. Level 4 — `claude mcp add arceus ...` proves cross-harness reuse.

Levels 0–3 require zero Arceus runtime. Build the whole 24-tool surface before wiring it in.

---

**Status:** WAITING FOR CONFIRMATION. Reply with `proceed`, `modify: …`, or a phase number to start with.
