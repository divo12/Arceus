# Spec 23: Skill & Tool Integration — Blending Arceus SkillArtifact with the OpenCode/Anthropic Skill Contract

**Status:** Design · **Owner:** Spec-14 / Runtime · **Last Updated:** 2026-04-18
**Depends on:** Spec 14 (Self-Evolution), Spec 04 (Persistence), Spec 11 (Control Plane)
**Unlocks:** Arceus tool layer (OpenCode plugin tools), PostToolUse telemetry loop, tier-3 resources
**Out of scope (deferred):** Arceus-MCP server (portability to non-OpenCode harnesses). External MCP servers can be subscribed to at any time via `opencode.json`’s `mcp` block without changes here.

---

## 0. TL;DR

Arceus already has a rich, evolvable **SkillArtifact** (versioned, company-scoped, EMA-graded, governed through ATA). OpenCode and Anthropic's skill model already have a battle-tested **in-turn loading contract** (filesystem discovery → metadata catalog → body pulled on demand via `skill()` tool → optional tier-3 resources).

These two systems solve **overlapping but distinct** problems:

- **Arceus owns the _lifecycle_:** what a skill _is_ over time — creation, mutation, governance, grading, per-company scope.
- **OpenCode owns the _in-turn contract_:** how a skill reaches the agent _right now_ — catalog injection, on-demand body load, progressive disclosure.

The blend: **SkillArtifact becomes the source of truth that materializes the filesystem view OpenCode expects at each beat.** The orchestrator no longer pre-classifies and injects bodies; instead, OpenCode's native `skill` tool pulls bodies on demand, and a PostToolUse hook reports usage back to Arceus so the EMA + governance loop stays intact.

Alongside skills, we ship a small set of **Arceus tools** as OpenCode plugin tools (`tool()` + Zod) materialized into every beat: `emit_artifact`, `mark_task_complete`, `post_ceo_message`, … Each tool's `execute()` hits the local Arceus HTTP API directly — no extra server, no new protocol. Tool + skill are two separate artifacts with a defined contract: the tool carries schema-level teaching (Zod `.describe()`), the skill carries workflow teaching (when/how/errors). External MCP servers (Linear, GitHub, Context7, Claude Preview) remain available through opencode's own `mcp` config — they're orthogonal to this spec.

---

## 1. Current State (2026-04)

| Concern | Today in Arceus | Gap |
|---|---|---|
| Skill storage | `skillsById: Map<id, SkillArtifact>` + 6 SKILL.md seeds | In-memory only; `skill_artifacts` migration 007 exists but is never read/written |
| Dispatch-time matching | `matchAndRecordSkills()` → `classifyTaskSkills()` LLM call → 0-3 IDs → `buildSkillSection()` inlines full bodies into system prompt | One extra LLM roundtrip per beat; bodies bloat every prompt even when unused |
| Discovery | Arceus push model (classifier picks, orchestrator injects) | No per-turn agent autonomy; LLM can't load skills mid-task |
| Telemetry | `recordSkillUsage()` fires at classify-time | Records _intent_ to use, not actual use — success rate EMA is noisy |
| Tier-3 resources | Not supported — `content: string` only | No way to ship scripts, reference tables, or binary assets with a skill |
| Custom tools | None — agents use OpenCode built-ins (bash, edit, read, …) only | Orchestration results extracted by stdout-parsing, brittle and ambiguous |
| External MCP | Not wired | Add via `opencode.json` `mcp` block when needed — out of scope here |
| Governance | ATA pipeline, Governance Gateway, successRate EMA — all intact | Unchanged by this spec; stays Arceus-side |

---

## 2. Design Principles

1. **Arceus owns evolution; OpenCode owns loading.** Don't make OpenCode multi-tenant. Don't make Arceus re-implement filesystem discovery.
2. **Materialize per-beat, not once.** Each beat gets a tailored ephemeral `.opencode/skills/` (and `.opencode/tools/`) directory. Filesystem path is the isolation boundary.
3. **Teaching is layered.** Tool schema (args) → skill frontmatter (when) → skill body (how) → tier-3 files (deep reference). Never stuff everything into one place.
4. **Measure from the tool, not from the skill.** The tool's `execute()` is the ground truth for "was this skill followed." Skills describe; tools measure.
5. **Kill the pre-classify LLM call.** OpenCode's native `skill` tool replaces it. One roundtrip saved per beat, better per-skill attribution, agents load mid-task.
6. **Backward compatible at every phase.** Rollback is a config flip, never a schema migration.

---

## 3. Architecture: End-to-End Beat Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ARCEUS CONTROL PLANE (Node)                                               │
│                                                                            │
│  packages/company-runtime/skills/*.md  ──► seedExistingSkills(companyId)   │
│            (baseline SKILL.md)                          │                  │
│                                                         ▼                  │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │  skillsById : Map<id, SkillArtifact>   (+ DB write-through)      │      │
│  │    • version, status, companyId, role                            │      │
│  │    • content (SKILL.md body)                                     │      │
│  │    • resources: SkillResource[] ◄── NEW (tier-3)                 │      │
│  │    • successRate (EMA), usageCount, lastUsedAt                   │      │
│  │    • mutation history, mutatedFromId                             │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│                          │                                                 │
│                          │ beat dispatch                                   │
│                          ▼                                                 │
│  materializeBeatWorkspace(beatId, companyId, role)                         │
│  ───────────────────────────────────────────────────                       │
│   /tmp/arceus/beats/{beatId}/                                              │
│     .opencode/                                                             │
│       skills/                                                              │
│         write-tests-first/                                                 │
│           SKILL.md           ◄── rendered from artifact.content            │
│           scripts/run-tdd.sh ◄── from artifact.resources                   │
│           references/...                                                   │
│         emit-artifact-correctly/                                           │
│           SKILL.md                                                         │
│       tools/                                                               │
│         arceus_emit_artifact.ts  ◄── OpenCode plugin tool() + Zod          │
│         arceus_mark_task_complete.ts   (static, shipped from apps/api)     │
│       opencode.json                                                        │
│         { permission: { bash: "ask", write: "allow", edit: "allow" } }     │
│         // external MCP (Linear, GitHub, …) goes under `mcp` if needed     │
└────────────────────────────────────────────────────────────────────────────┘
                            │ opencode spawned with cwd=/tmp/arceus/beats/…
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  OPENCODE AGENT PROCESS                                                    │
│                                                                            │
│  Skill.Service discovers SKILL.md → builds tier-1 catalog in system prompt │
│  ToolRegistry loads .opencode/tools/*.ts (arceus tools) + built-ins        │
│                                                                            │
│  Agent reasons:                                                            │
│    "Need TDD for this" → skill({ name: "write-tests-first" })              │
│                                   │                                        │
│                                   ▼                                        │
│                            Tier-2 body + tier-3 scripts now in context     │
│                                                                            │
│  Agent works:                                                              │
│    bash("npm test -- --watch")                                             │
│    edit(...)                                                               │
│    arceus_emit_artifact({ taskId, kind, title, filePaths, summary })       │
│                                   │                                        │
│                                   ▼                                        │
│    PostToolUse hook → POST /api/skill-usage { skillId, beatId, outcome }   │
└────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  ARCEUS TELEMETRY & EVOLUTION LOOP                                         │
│                                                                            │
│  recordSkillUsage(skillId)        ──► usageCount++, lastUsedAt=now         │
│  updateSuccessRate(skillId, out)  ──► EMA: rate = rate*0.85 + out*0.15     │
│  processTaskOutcome(...)           ──► may emit mutation proposal          │
│          │                                                                 │
│          ▼                                                                 │
│  ATA pipeline (between beats):                                             │
│    proposed → revision → approved → merged                                 │
│      │                                                                     │
│      ▼                                                                     │
│    applyMergedMutation() ──► deprecate v1, register v2                     │
│      │                                                                     │
│      ▼                                                                     │
│    Next beat materializes v2's SKILL.md — old beats never see v2           │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Concerns & Ownership

| Concern | Owner | Notes |
|---|---|---|
| Filesystem discovery | **OpenCode** | But sourced from Arceus via materialization |
| Progressive disclosure (tier 1/2/3) | **OpenCode** | Native `skill` tool handles pull-loading |
| Catalog injection into system prompt | **OpenCode** | `SystemPrompt.skills()` builds catalog from disk |
| Version management (v1 → v2 → v3) | **Arceus** | OpenCode sees only the active version for this beat |
| Per-company scope | **Arceus** | Filesystem = isolation boundary |
| Mutation / governance (ATA) | **Arceus** | Invisible to OpenCode; only active set materialized |
| successRate / usageCount / EMA | **Arceus** | Fed by PostToolUse hook |
| Tool permissions (allow/deny/ask) | **OpenCode** | `opencode.json` config |
| External MCP registry | **OpenCode** | Optional — subscribed per company/role via `opencode.json` `mcp` block |
| Tier-3 resources (scripts/refs/assets) | **Shared** | Arceus stores inline in DB, materializes as files |
| Orchestration tools (emit_artifact, …) | **Arceus** | OpenCode plugin tools materialized into each beat; `execute()` hits local Arceus API |

---

## 5. Data Model Changes

### 5.1 Extend `SkillArtifact` (packages/contracts)

```typescript
export interface SkillResource {
  path: string;                                   // "scripts/run-tests.sh"
  kind: "script" | "reference" | "asset";
  content: string;                                // inline (small); base64 for binary
  executable?: boolean;                           // chmod +x on materialize
}

export interface SkillArtifact {
  // ── existing fields (unchanged) ──────────────────────────────────────
  id: string;
  companyId: string;
  name: string;
  role: string;
  version: number;
  status: "active" | "deprecated" | "proposed";
  trigger: string;                                // one-line, becomes SKILL.md description
  content: string;                                // SKILL.md body (tier-2)
  testCases: SkillTestCase[];
  successRate: number;                            // 0..1, EMA
  usageCount: number;
  lastUsedAt: string | null;
  mutatedFromId: string | null;
  mutatedBy: string | null;                       // agentId or "system"
  mutationReason: string | null;
  createdAt: string;
  approvedAt: string | null;

  // ── NEW ──────────────────────────────────────────────────────────────
  resources?: SkillResource[];                    // tier-3 payload
  allowedTools?: string[];                        // rendered into frontmatter
  boundTools?: string[];                          // tool names this skill teaches
}
```

### 5.2 Migration 008: `skill_resources`

```sql
-- Tier-3 payload table, FK to skill_artifacts
CREATE TABLE hippocampus.skill_resources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id     UUID NOT NULL REFERENCES hippocampus.skill_artifacts(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('script', 'reference', 'asset')),
  content      TEXT NOT NULL,
  executable   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (skill_id, path)
);
CREATE INDEX idx_skill_resources_skill_id ON hippocampus.skill_resources(skill_id);
```

### 5.3 Migration 009: `tool_invocations` (telemetry)

```sql
-- Every arceus-mcp tool call is logged; drives per-skill attribution
CREATE TABLE hippocampus.tool_invocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beat_id         TEXT NOT NULL,
  company_id      TEXT NOT NULL,
  agent_role      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  args_json       JSONB NOT NULL,
  result_status   TEXT NOT NULL CHECK (result_status IN ('ok','error')),
  result_summary  TEXT,
  skill_ids_active TEXT[],                        -- skills loaded at time of call
  duration_ms     INTEGER,
  invoked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_invocations_beat ON hippocampus.tool_invocations(beat_id);
CREATE INDEX idx_tool_invocations_company ON hippocampus.tool_invocations(company_id, invoked_at DESC);
```

---

## 6. The Materialization Step

### 6.1 New function

```typescript
// apps/api/src/beat-materializer.ts

export interface BeatWorkspace {
  beatId: string;
  root: string;                                  // /tmp/arceus/beats/{beatId}
  skillsDir: string;                             // root + /.opencode/skills
  toolsDir: string;                              // root + /.opencode/tools
  opencodeConfig: string;                        // root + /opencode.json
  materializedSkillIds: string[];
}

export async function materializeBeatWorkspace(
  beatId: string,
  companyId: string,
  role: AgentRole,
): Promise<BeatWorkspace>;
```

### 6.2 What it writes

```
/tmp/arceus/beats/{beatId}/
├── opencode.json                          # points at arceus-mcp + per-role tool allowlist
├── .opencode/
│   ├── skills/
│   │   └── {skill.name}/
│   │       ├── SKILL.md                  # frontmatter + trigger + content
│   │       └── {resource.path}           # tier-3 files
│   └── tools/
│       └── {tool.name}.ts                # symlink or copy from apps/api/tools-shipped/
└── (workspace files from workspace-manager)
```

### 6.3 Rendered `SKILL.md` format

```markdown
---
name: write-tests-first
description: TDD workflow for new features (trust: 82%, v3)
role: developer
allowed-tools: bash, read, edit, write, arceus_emit_artifact
---

{artifact.content}
```

Injecting `(trust: X%, v3)` into the description lets OpenCode's tier-1 catalog surface Arceus telemetry directly to the LLM at selection time — a blend bonus the vanilla OpenCode flow doesn't have.

### 6.4 Rendered `opencode.json`

```json
{
  "permission": {
    "bash": "ask",
    "write": "allow",
    "edit": "allow"
  }
  // NOTE: external MCP servers (Linear, GitHub, Context7, Claude Preview, …)
  //       may be added per-company/per-role under an `"mcp": { … }` block.
  //       That is OpenCode's native capability and is out of scope for this spec.
}
```

Env vars (`ARCEUS_API`, `ARCEUS_BEAT_ID`, `ARCEUS_COMPANY_ID`, `ARCEUS_AGENT_ROLE`) are passed to the opencode child process so that every plugin tool's `execute()` can authenticate its callbacks to the control plane.

---

## 7. Tool Layer: OpenCode Plugin Tools

### 7.1 Why plain plugin tools (not an MCP server — for now)

We deliberately keep the tool layer **simple and in-process** with OpenCode. No extra daemon, no stdio protocol, no separate versioning story. Each tool is a TypeScript file using OpenCode's native `tool()` helper; its `execute()` is a plain `fetch()` against the already-running Arceus HTTP API.

| | OpenCode plugin tool (**chosen**) | Arceus-MCP server (deferred) |
|---|---|---|
| Build cost | ~30 lines per tool | stdio server + transport + registration |
| Runtime cost | 0 (in-process) | +1 subprocess per beat |
| Portability | OpenCode only | Any MCP-capable harness |
| Versioning | Git-tracked `.ts` file | Server version + API contract |
| When to adopt | **Now** — single harness, single process | If/when Arceus runs on Claude Code / Cursor / Codex directly |

If portability becomes a need, the same tool definitions port to MCP in a day — the schema and `execute()` body stay identical, only the registration surface changes. That migration is explicitly **not in this spec**.

External MCP servers (Linear, GitHub, Context7, Claude Preview, …) are a different axis — subscribe to them any time via `opencode.json`'s native `mcp` block. They don't need our control plane.

### 7.2 Initial tool surface

| Tool | When to call | Replaces |
|---|---|---|
| `arceus_emit_artifact` | After a completed unit of work | Stdout-parsing for artifacts |
| `arceus_mark_task_complete` | After emit + self-verify | Status-inference regex |
| `arceus_request_code_review` | Developer asks reviewer for pass | Artifact-chain convention |
| `arceus_post_message` | CEO chat, standup posts | Chat-injection path |
| `arceus_get_task` | Read assignment by id | Currently inlined in system prompt |
| `arceus_log_decision` | Capture a design decision for hippocampus | New capability |

Each tool is a separate file under `apps/api/tools-shipped/arceus_{name}.ts`. The filename becomes the tool name OpenCode exposes to the agent.

### 7.3 Canonical tool shape (OpenCode plugin)

```typescript
// apps/api/tools-shipped/arceus_emit_artifact.ts
import { tool } from "@opencode-ai/plugin";

export default tool({
  description:
    "Persist a versioned code artifact back to the Arceus orchestrator. " +
    "Call after completing a discrete unit of work (one feature, one fix, one test suite). " +
    "Do NOT use to save mid-task progress.",
  args: {
    taskId: tool.schema.string()
      .describe("Task ID from your assignment message"),
    kind: tool.schema.enum(["code", "plan", "review", "test"])
      .describe("'code' for source edits; 'test' for test files; 'plan' for design docs; 'review' for reviewer output"),
    title: tool.schema.string().max(70)
      .describe("Imperative, git-commit-style title. Under 70 chars."),
    filePaths: tool.schema.array(tool.schema.string())
      .describe("Workspace-root-relative paths; exclude .git, node_modules, build outputs"),
    summary: tool.schema.string()
      .describe("Markdown. Three sections: What changed / Why / Risks"),
  },
  async execute(args) {
    const res = await fetch(`${process.env.ARCEUS_API}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beatId: process.env.ARCEUS_BEAT_ID,
        companyId: process.env.ARCEUS_COMPANY_ID,
        agentRole: process.env.ARCEUS_AGENT_ROLE,
        ...args,
      }),
    });
    if (!res.ok) {
      throw new Error(`Arceus rejected artifact: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  },
});
```

The entire tool is ~30 lines. The materializer copies (or symlinks) this file into `/tmp/arceus/beats/{beatId}/.opencode/tools/`. OpenCode discovers it at startup and exposes it to the agent like any other built-in.

---

## 8. Skill + Tool Pair: Worked Example

### 8.1 The tool (arceus_emit_artifact) — already shown in §7.3

What the tool teaches by itself, in every turn, for free:
- **When** to call it (description).
- **What args** to pass (each `.describe()`).
- **Constraints** the LLM can't violate (`enum`, `max(70)`).

### 8.2 The skill (emit-artifact-correctly)

```markdown
---
name: emit-artifact-correctly
description: Teaches when and how to emit Arceus artifacts via arceus_emit_artifact — granularity, title conventions, 409/400 recovery.
role: developer
allowed-tools: arceus_emit_artifact, bash, read, grep
---

# Emit Artifact Correctly

## When to use this
You finished a task and need to persist the result. Emit one artifact per
logical unit of work:
- ✅ Finished an OAuth handler → one `code` artifact
- ✅ Wrote tests for it       → separate `test` artifact
- ❌ Don't bundle unrelated changes
- ❌ Don't emit multiple artifacts per single file change

## Arg conventions

### `title`
Imperative, <70 chars — think git commit subject:
- ✅ "Add OAuth callback handler with PKCE support"
- ❌ "OAuth work" / "I added a handler that does OAuth callbacks and also..."

### `filePaths`
Workspace-root-relative; never `.git`, `node_modules`, build outputs.
Always `bash("git status --porcelain")` first.

### `summary`
```
## What changed
- ...
## Why
- ...
## Risks
- ...
```

## Correct call pattern
1. `bash("git diff --name-only HEAD~1")`
2. Call `arceus_emit_artifact({...})`
3. Keep the returned `artifactId`, pass to `arceus_mark_task_complete`

## Error modes
| Error | Cause | Fix |
|---|---|---|
| 409 | Already emitted for this taskId | Use `arceus_supersede_artifact` instead |
| 400 paths | Absolute or outside workspace | Recompute with `git status --porcelain` |
| Task stays `in_progress` | Forgot `arceus_mark_task_complete` | Call it as step 4 |

## Anti-patterns
- ❌ Using this tool to "save progress" mid-task
- ❌ `kind: "code"` for config-only edits — use `"plan"`
- ❌ `summary` >500 words — reviewers skim
```

### 8.3 How they connect at runtime

```
agent beat starts
   │
   ▼
OpenCode builds system prompt:
  <available_tools>
    arceus_emit_artifact(taskId, kind, title, ...)   ← schema, always visible
    bash, edit, read, grep, skill, ...
  </available_tools>
  <available_skills>
    emit-artifact-correctly: Teaches when and how... ← tier-1, always visible
    write-tests-first: TDD workflow for new features
    ...
  </available_skills>
   │
   ▼
Agent reasons: "I finished OAuth. I should emit an artifact.
               The catalog lists emit-artifact-correctly — load it."
   │
   ▼
Agent calls: skill({ name: "emit-artifact-correctly" })   ← tier-2, on demand
   │
   ▼
SKILL.md body enters context → agent sees title rules, 409 recovery
   │
   ▼
Agent runs:
  bash("git diff --name-only HEAD~1")
  arceus_emit_artifact({ taskId, kind: "code", title: "...", ... })
   │
   ▼
Tool execute() → POST /api/artifacts → returns { artifactId }
PostToolUse hook → POST /api/skill-usage { skillId, beatId, outcome }
```

---

## 9. Teaching Budget — Where To Put What

| Teaching type | Where it lives | Always loaded? | Token cost |
|---|---|---|---|
| "What args does this tool take?" | Tool schema `.describe()` | Yes | 30–200 |
| "Which tool to reach for when?" | Skill frontmatter `description` | Yes (tier-1 catalog) | ~60 |
| "Universal conventions for this tool" | Agent soul / system prompt | Yes | Medium |
| "Workflow patterns, error modes, examples" | Skill body (tier-2) | On `skill()` call | 500–3k |
| "Deep reference, rare error codes" | Skill-folder references/ (tier-3) | On explicit Read | Free until used |
| "Executable automation (tdd runner, linter wrapper)" | Skill-folder scripts/ (tier-3) | On bash() call | Free until used |

**Rules of thumb:**
1. Applies to every call of the tool → put it in tool `.describe()` or agent soul.
2. Applies to a recognizable class of tasks → put it in a skill.
3. Lookup table or rarely-needed detail → put it in a tier-3 reference file.

---

## 10. What Dies, What Survives, What Changes

### Dies
- `classifyTaskSkills()` — the pre-classify LLM call.
- `matchAndRecordSkills()` wrapper at beat dispatch.
- `buildSkillSection()` full-body injection into every system prompt.
- The 6 defensive `seedExistingSkills()` calls in `server.ts` (one bootstrap seed only).
- Stdout-parsing for artifact/status extraction (replaced by arceus-mcp tools).

### Survives (stronger)
- `SkillArtifact` type — the lifecycle object.
- `skillsById` map — still the hot cache, now DB-backed.
- `seedExistingSkills()` — still the baseline, runs once per company.
- ATA mutation pipeline (`skill-mutator.ts`) — unchanged.
- Pattern Learner — unchanged, still watches beats.
- `successRate` EMA + `usageCount` — now fed by PostToolUse hooks, not classifier.
- Governance Gateway — unchanged; mutations still gated between beats.

### Changes
- `buildSkillCatalog(role)` → `materializeBeatWorkspace(beatId, companyId, role)` returning a filesystem path.
- `recordSkillUsage()` called by the `/api/skill-usage` webhook, not inline.
- SkillArtifact gains `resources: SkillResource[]`, `allowedTools?: string[]`, `boundTools?: string[]`.
- DB write-through in `registerSkill / updateSkill / deprecateSkill / storeMutation / applyMergedMutation`.

---

## 11. Per-Company / Per-Role Scoping

OpenCode has no tenant model. Arceus runs one OpenCode process per beat — so isolation happens at the **materialization step**:

```
/tmp/arceus/beats/
├── beat_abc123/                      # Sprint 2 · Acme Corp · developer
│   └── .opencode/skills/             # 12 skills (Acme's active set, developer role)
├── beat_def456/                      # Sprint 5 · Beta Inc · tester
│   └── .opencode/skills/             # 8 skills (Beta's active set, tester role)
└── beat_ghi789/                      # Sprint 2 · Acme Corp · ceo
    └── .opencode/skills/             # 6 skills (CEO role — no developer content)
```

Filter at materialize: `companyId === currentCompany && role === agentRole && status === "active"`.
The filesystem boundary enforces the isolation. OpenCode sees a flat, fully-valid skills dir — it has no idea skills are per-company or versioned.

---

## 12. Governance Loop (Between Beats)

```
Beat N runs
  │ skill-X body loaded
  │ agent tried to follow, task failed
  ▼
Pattern Learner logs failure, tagged with active skill IDs
  │
  ▼  (between beats)
ATA pipeline proposes v2 of skill-X (new SKILL.md + optional new resources)
  │
  ▼
Skills Lead reviews → Governance Gateway checks trust / budget / own-role → approved
  │
  ▼
applyMergedMutation()
  • deprecate skill-X v1 (status=deprecated)
  • register  skill-X v2 (status=active)
  • DB write-through
  │
  ▼
Beat N+1 dispatch
  materializeBeatWorkspace() writes v2's SKILL.md (and resources)
  v1's folder is simply not emitted
  │
  ▼
OpenCode sees v2 as "the skill" — no version awareness needed inside OpenCode
```

The pipeline is **invisible to OpenCode**. That's the point.

---

## 13. Telemetry Loop (During & After Beats)

### 13.1 Wire format: `/api/skill-usage`

```typescript
POST /api/skill-usage
{
  beatId:     "beat_abc123",
  companyId:  "company_acme",
  agentRole:  "developer",
  skillId:    "skill-write-tests-first-v3",
  phase:      "loaded" | "completed",     // loaded = skill() tool fired; completed = beat finished
  outcome?:   0 | 1,                       // only on phase=completed
  taskId?:    "task_42",
  toolCalls?: string[]                     // tools invoked after skill was loaded
}
```

### 13.2 PostToolUse hook (plugin, one per beat workspace)

```typescript
// .opencode/plugins/skill-telemetry.ts
import { plugin } from "@opencode-ai/plugin";

export default plugin({
  hooks: {
    postToolUse: async (ctx) => {
      if (ctx.tool.name !== "skill") return;
      await fetch(`${process.env.ARCEUS_API}/api/skill-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beatId:    process.env.ARCEUS_BEAT_ID,
          companyId: process.env.ARCEUS_COMPANY_ID,
          agentRole: process.env.ARCEUS_AGENT_ROLE,
          skillId:   skillNameToId(ctx.tool.input.name),
          phase:     "loaded",
        }),
      });
    },
  },
});
```

### 13.3 Outcome aggregation (beat end)

After the beat completes, the orchestrator:
1. Computes outcome ∈ {0, 1} from build/test/review signals.
2. For every `skillId` seen in `/api/skill-usage?phase=loaded&beatId=…`, calls `updateSuccessRate(skillId, outcome)`.
3. Logs the full attribution to `hippocampus.tool_invocations` for later pattern analysis.

---

## 14. Migration Plan

### Phase A — DB write-through (prerequisite)
**Scope:** `packages/db` writes, read-from-DB on cold start.
- Implement `dbPersistSkill`, `dbPersistMutation`, `dbLoadSkillsForCompany`.
- Gate on `isDbConfigured()`.
- On server boot, if DB configured: `dbLoadSkillsForCompany()` replaces / augments `seedExistingSkills()`.
- **Backward compatible:** without DB, current in-memory behaviour unchanged.

**Verify:** restart server → all skills present in memory match DB.

### Phase B — Materialization shim (no behaviour change)
**Scope:** `apps/api/src/beat-materializer.ts` runs _alongside_ current flow.
- On beat dispatch, write `/tmp/arceus/beats/{beatId}/.opencode/skills/`.
- Keep `classifyTaskSkills` + `buildSkillSection` running (both paths active).
- Add materialization telemetry: file count, bytes written, duration.

**Verify:** every beat has a materialized dir; contents match `getSkillsForRole(...)`. Zero behaviour change in agent output.

### Phase C — Ship the Arceus plugin tools
**Scope:** `apps/api/tools-shipped/` package.
- Author `arceus_emit_artifact`, `arceus_mark_task_complete` as OpenCode plugin tools (Section 7.3 shape).
- Materializer (Phase B) copies/symlinks them into `/tmp/arceus/beats/{beatId}/.opencode/tools/`.
- Tools hit `/api/artifacts` and `/api/tasks/{id}/complete` on the local Arceus HTTP server.
- Every tool call logs to `tool_invocations` but does not yet replace stdout parsing.

**Verify:** agents can call `arceus_emit_artifact` in e2e tests; stdout-parsing still the source of truth.

*(Deferred — not in this spec: porting these same tools to an `arceus-mcp` stdio server for portability to non-OpenCode harnesses.)*

### Phase D — Flip the loader
**Scope:** the point-of-no-return commit.
- Launch `opencode` with `cwd=/tmp/arceus/beats/{beatId}`.
- Delete `classifyTaskSkills`, `matchAndRecordSkills`, `buildSkillSection` call sites.
- Wire PostToolUse hook for `/api/skill-usage`.
- Switch artifact extraction to `arceus_emit_artifact` only (keep stdout-parsing behind a feature flag for 1 sprint as rollback).

**Verify:** beat prompts are ~40% smaller (no inlined skill bodies); per-skill success rates become meaningfully per-skill (not per-dispatch-guess).

### Phase E — Tier-3 resources
**Scope:** extend `SkillArtifact.resources`, materialize alongside SKILL.md.
- Migration 008 applied.
- ATA pipeline learns to version resources together with content.
- First tier-3 skill: `write-tests-first` ships `scripts/run-tdd.sh`.

**Verify:** agent invokes the script during a beat; skill graduates from "describes TDD" to "runs TDD."

**Rollback at any phase:** pure config flip. No schema migrations reversed.

---

## 15. Observability & Guardrails

### Metrics (emit to existing telemetry)
- `skill.materialize.duration_ms` per beat
- `skill.materialize.skill_count` per beat
- `skill.materialize.bytes_written` per beat
- `skill.usage.loaded_count` per skillId
- `skill.usage.success_rate` per skillId (EMA tail)
- `tool.invocation.count` per tool_name
- `tool.invocation.error_rate` per tool_name
- `prompt.tokens.saved` = old_size − new_size (expected: ~40%)

### Guardrails
- Materialized dirs cleaned up 10 min after beat end (cron).
- `skill.materialize.duration_ms` SLO: p95 < 50ms. If exceeded, profile `registerSkill` DB writes.
- `tool.invocation.error_rate` > 10% for 5 min on any Arceus tool → page on-call.
- Schema validation on Arceus tools uses Zod (via `tool.schema`); rejected calls return structured error (not silent failure).

### Failure modes
| Failure | Detection | Recovery |
|---|---|---|
| Materialized dir corrupt | opencode fails to discover skills | Rematerialize from DB; retry beat once |
| Arceus API unreachable from tool.execute() | tool calls throw | Fallback to legacy stdout parsing (Phase D feature flag) |
| PostToolUse hook drops | usageCount drift detected by reconciliation job | Reconcile from `tool_invocations` table |
| DB write-through lag | `lastUsedAt` stale in DB | Same-process memory is source of truth; DB is eventually consistent |

---

## 16. Open Questions

1. **`allowed-tools` enforcement across harnesses.** OpenCode issue #18837 flags inconsistent enforcement. Decision: assume advisory at the harness level, and also add a server-side allowlist check inside each Arceus tool's `execute()` body (cross-referencing `boundTools` on the currently-loaded skills for this beat).
2. **Beat workspace lifecycle vs workspace-manager.** Does `materializeBeatWorkspace()` nest inside the company workspace dir, or stand alone in `/tmp/arceus/beats`? Current proposal: standalone, cross-referenced via symlink — but needs verification that opencode handles symlinks on macOS + Linux consistently.
3. **Mutation propagation during in-flight beats.** If a beat is running when v2 is approved, should we kill+restart the beat? Current answer: no — finish on v1, next beat gets v2. Verify this doesn't cause confusing telemetry (beat tagged with v1 but succeeded only because of v2-like-change in the environment).
4. **Tier-3 binary assets.** Inline `content: base64` is fine for <1MB. For larger (models, datasets), shell out to `supabase-storage.ts` with a signed-URL pattern instead — but that's deferred to a follow-up.
5. **Skill-level tool permissioning.** If skill A declares `allowed-tools: bash, edit` and skill B declares `allowed-tools: bash, edit, write`, what's the effective permission when both are loaded? Proposal: union, with `deny` tokens winning over `allow`.

---

## 17. Success Criteria

A successful landing of this spec:

1. **Zero pre-classify LLM calls.** `classifyTaskSkills` is deleted from the hot path; prompt tokens drop by ≥30%.
2. **Per-skill success rates are meaningful.** `successRate` EMA only updates when a skill was actually loaded (PostToolUse), not at dispatch guess.
3. **Tier-3 unlocked.** At least one skill ships with a `scripts/` file that the agent executes during a real beat.
4. **Arceus tools are the artifact channel.** `arceus_emit_artifact` is the only path to persisting artifacts; stdout parsing removed after one sprint of parallel run.
5. **Multi-tenant correctness.** In a scripted e2e with two companies, beats never see each other's skills (verified by filesystem assertion + prompt transcript diff).
6. **Rollback proven.** Phases A–E each rolled back in staging without data loss or dangling state.

---

## 18. Appendix: Key Files & Anchors

| File | Role after this spec |
|---|---|
| `packages/company-runtime/src/skill-registry.ts` | +DB write-through, unchanged API surface |
| `packages/contracts/src/domain.ts` | +SkillResource, SkillArtifact gains `resources`, `allowedTools`, `boundTools` |
| `packages/db/migrations/008_skill_resources.sql` | NEW — tier-3 payload table |
| `packages/db/migrations/009_tool_invocations.sql` | NEW — telemetry table |
| `apps/api/src/beat-materializer.ts` | NEW — writes per-beat `.opencode/` tree |
| `apps/api/src/orchestrator.ts` | `classifyTaskSkills`, `matchAndRecordSkills`, `buildSkillSection` removed |
| `apps/api/src/server.ts` | `/api/skill-usage` route; `/api/artifacts` is the backend for Arceus tools |
| `apps/api/tools-shipped/` | NEW — OpenCode plugin tools (`arceus_emit_artifact`, `arceus_mark_task_complete`, …) copied/symlinked into every beat's `.opencode/tools/` |
| `mcp-servers/arceus/` | **Deferred** — stdio MCP port of the same tools, when multi-harness portability is needed |
| `packages/company-runtime/skills/**/SKILL.md` | Baseline; still the seed source for `seedExistingSkills` |

---

## 19. References

**Arceus source (verified):**
- `packages/company-runtime/src/skill-registry.ts`
- `apps/api/src/orchestrator.ts` — `buildSkillCatalog`, `classifyTaskSkills`, `buildSkillSection`, `matchAndRecordSkills`
- `packages/company-runtime/skills/{role}/SKILL.md` — baseline markdown
- `packages/db/migrations/007_skill_artifacts.sql` — DB schema (present, unused)

**External patterns (2026-04):**
- Anthropic — Equipping Agents for Agent Skills
- anthropics/skills — `pdf/SKILL.md`, `mcp-builder/SKILL.md`, `skill-creator/SKILL.md`
- OpenCode — Custom Tools (`tool()`, Zod, file-to-tool-name mapping)
- OpenCode — Plugins (hooks, PostToolUse)
- DeepWiki — OpenCode Skills System
- nanobot-ai/nanobot — YAML agent + mcpServers manifest
- Model Context Protocol — TypeScript SDK (`McpServer`, `registerTool`)
- MCP Developer Guide 2026
- Shilkov — Inside Claude Code Skills (invocation mechanics)
- Hanchung — Claude Skills deep dive (progressive disclosure economics)
- OpenCode issue #18837 — `allowed-tools` enforcement caveats

---

*End of Spec 23.*
