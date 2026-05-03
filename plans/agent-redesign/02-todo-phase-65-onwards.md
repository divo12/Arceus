# Agent Redesign — TODO (Phase 6.5 → 9)

> Self-contained. This is the complete specification of the heartbeat runtime, shadow mode, specialist-executor deletion, and the optional tool-search bridge. You should not need to open `plans/24-ops-harness-plan.md` to execute this — if you do, the gap in this doc is a bug. The companion doc `01-done-phase-0-to-pre-65.md` lists everything already shipped.

---

## 0. Philosophy — heartbeat-driven, not orchestration-driven

**Current system (to be deleted):** The orchestrator picks a task, assembles a prompt embedding that task, fires one LLM call, parses the text output, manually creates artifacts, manually delivers handoffs, manually transitions task status. The "agent" is a text generator; the orchestrator is the reasoner.

**Target:** The heartbeat is a metronome. On each tick the orchestrator:

1. Builds a **read-only view of the world** (company state, open tasks, recent artifacts, memory, progress notes).
2. Wakes one agent (one role, one OpenCode session).
3. Gets out of the way.

The agent is the only thing that reasons. Its reasoning is bounded by (a) the context we hand it, (b) the tools in its allowlist, (c) the skills we materialized. The agent picks its task, claims it, does the work via tools, hands off via tools, and completes via tools. When `session.prompt` returns, the beat dies. **Nothing survives across beats except what the agent wrote to Arceus via tool calls.**

### Concrete shift

| Orchestration (today) | Heartbeat (target) |
|---|---|
| `executeSpecialistTask(taskId)` | `runBeat(role, companyId)` |
| Orchestrator picks task, builds prompt with task embedded | Orchestrator builds state; agent picks task via `task_claim` |
| Orchestrator parses LLM output for artifact content | Agent calls `artifact_create` itself |
| `if (role === "tester") buildTesterArtifact` | Tester agent structures its own artifact |
| `deliverUiDesignerMemoryHandoff(task, artifactId)` | Designer calls `memory_handoff` |
| `createMarketingExternalApproval(task, artifactId)` | Marketing calls `approval_request` |
| Orchestrator calls `setTaskStatus(taskId, "completed")` | Agent calls `task_complete({ evidence })` |
| specialist-executor.ts: 350 LOC, 12 role branches | specialist-executor.ts: **deleted** |
| Role branching scattered across 10+ files | Role appears only as a key into `ROLE_CONFIGS` |

---

## 1. Path layout: stable vs ephemeral

Arceus has ONE long-lived OpenCode server for the process lifetime. **Beats do not spawn new servers** (avoids 30–45s cold starts). Per-beat isolation is achieved through three mechanisms:

- **Session ID as isolation boundary.** The plugin and MCP server resolve `sessionID → beat context` via an Arceus-owned HTTP route. Nothing beat-specific in any `process.env`.
- **`/tmp/arceus/beats/<beatId>/` as ephemeral scratch.** Holds materialized skills, cleaned up on beat death.
- **Symlinked skills directory.** `<productWorkspace>/.opencode/skills` is a symlink swapped per beat to point at the current beat's `/tmp/arceus/beats/<beatId>/skills/` tree.

| Path | Lifetime | Writer | Reader |
|---|---|---|---|
| `productWorkspace/opencode.json` | Stable (boot) | `writeSharedOpencodeConfig()` | OpenCode server |
| `productWorkspace/.opencode/agent/<role>.md` (×8) | Stable (boot) | `writeBeatAgent()` for each role at boot | OpenCode (picks via `body.agent`) |
| `productWorkspace/.opencode/plugin/arceus.ts` | Stable (boot) | Copied from `<repo>/.opencode/plugin/arceus.ts` | OpenCode plugin runtime |
| `productWorkspace/.opencode/arceus-skills.json` | Per-beat (replaced) | `materializeBeatSkills()` | Plugin reads for usage-POST `slug→id` lookup |
| `productWorkspace/.opencode/skills/` → **symlink** | Per-beat (swapped) | `swapSkillsSymlink()` | OpenCode native skills loader |
| `/tmp/arceus/beats/<beatId>/skills/<slug>/SKILL.md + resources/` | Per-beat (cleaned on death) | `materializeBeatSkills()` | Symlink target |

**Symlink swap pseudocode:**

```typescript
const beatSkillDir = `/tmp/arceus/beats/${beatId}/skills`;
await materializeIntoBeatSkillDir(beatSkillDir, companyId, role, trustBand);

const symlink = path.join(productWorkspace, ".opencode", "skills");
try { await fs.unlink(symlink); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
await fs.symlink(beatSkillDir, symlink);

await fs.writeFile(path.join(productWorkspace, ".opencode", "arceus-skills.json"), manifestJson);
```

Beats serialize (one at a time for v1), so a single symlink is race-free. When concurrent beats become a v2 requirement, replace with per-session OpenCode support (SDK improvement) or per-beat OpenCode spawn (costly).

---

## 2. Boot-time sequence (once per Arceus API process)

| Step | Actor | Action |
|---|---|---|
| 0.1 | Arceus API | Connect Postgres; run `seedExistingSkillsDetailed()` from `.arceus/skills-seed/` into the `SkillArtifact` registry (idempotent upsert) |
| 0.2 | Arceus API | Initialize `sessionContextMap = new Map<sessionId, BeatContext>()` |
| 0.3 | Arceus API | Mount internal routes incl. `GET /api/internal/telemetry/session-context/:sessionId` and `POST /api/internal/telemetry/skills/:id/usage` |
| 0.4 | Arceus API | `warmUpOpencode()` — spawn one `opencode serve` child process at `productWorkspace` |
| 0.5 | Arceus API | `writeSharedOpencodeConfig()` — write `opencode.json` with 8 agent defs + MCP wiring + plugin path |
| 0.6 | OpenCode | Plugin init: read `arceus-skills.json` manifest (empty on boot); initialize session-context cache |
| 0.7 | OpenCode | Spawn MCP server child with `ARCEUS_API` + `ARCEUS_TOKEN` in env (process-wide secrets only — nothing beat-specific) |

**Post-boot invariant:** nothing beat-specific exists in any `process.env`, in any cache, or on disk. All state is ready to accept the first beat.

---

## 3. Per-beat lifecycle — the 22 steps

Concrete walkthrough: **developer beat to implement a login form.**

| Step | Actor | Action |
|---|---|---|
| **1** | Arceus orchestrator | Heartbeat tick. Pick `role=developer`, `companyId=comp_abc`. Generate `beatId=beat_xyz`. **Do NOT pick a task** — that's the agent's job. |
| **2** | Arceus orchestrator | `buildBeatContext(role, companyId)`: read-only assembly of `{companyState, openTasks, recentArtifacts, myMemory, recentProgress, trustBand, allowedTools}`. No instructions — just state. |
| **3** | Arceus orchestrator | `opencode.session.create({ title })` → `session.id = sess_123`. |
| **4** | Arceus orchestrator | `sessionContextMap.set(sess_123, ctx)`. Context now resolvable via `GET /api/internal/telemetry/session-context/sess_123`. |
| **5** | Arceus orchestrator | `materializeBeatSkills({ beatId, companyId, role, trustBand, workDir: /tmp/arceus/beats/beat_xyz })` → writes SKILL.md + resources + manifest; `swapSkillsSymlink()` swaps `productWorkspace/.opencode/skills` symlink to the new tree. |
| **6** | Arceus orchestrator | `opencode.session.prompt({ path: { id: sess_123 }, body: { agent: "developer", system: soul, parts: [{ type: "text", text: renderStateForAgent(ctx) }], tools: ctx.allowedTools } })`. **Wrapped in `Promise.race([prompt, setTimeout(15 * 60_000)])` — hard cap.** Orchestrator now blocks. |
| **7** | OpenCode + agent | OpenCode loads `developer.md` agent definition, reads materialized skills catalog (native `<available_skills>`), receives the state prompt. Agent reasons: *"tsk_42 login form is the highest-value unblocked task."* |
| **8** | Agent | Emits first tool call: `task_claim({ taskId: "tsk_42", reason: "..." })`. |
| **9** | Plugin (`tool.execute.before`) | Cache miss → `GET /api/internal/telemetry/session-context/sess_123` → cache `ctx`. Check `task_claim ∈ ctx.allowedTools` → OK. Check 3-strike circuit breaker → OK. Emit audit `{phase: "before", tool, callID, sessionID, startedAt}`. |
| **10** | MCP server | Receive call, resolve session context the same way (first call caches), proxy to `POST /api/internal/v1/tasks/tsk_42/claim` with headers `x-beat-id: beat_xyz`, `x-company-id: comp_abc`, `x-role: developer`, `idempotency-key: claim:beat_xyz:tsk_42`, `Authorization: Bearer ...`. Return `ToolResult` envelope to agent. |
| **11** | Arceus API | Verify claimable (status=ready, assignable to developer, not locked). Transition `ready → in_progress`. Record `claimedByBeatId`. Return envelope with task details. |
| **12** | Plugin (`tool.execute.after`) | Compute `latencyMs`. Emit audit `{phase: "after", tool, callID, sessionID, status, cause, latencyMs}`. On envelope error: increment circuit tally for `(tool, cause)`. |
| **13** | Agent | Does the work: `task_append_plan_step → edit → write → bash → task_append_command → skill(name="developer-tdd-loop") → ...`. Every tool call flows through steps 9–12. Every `skill(...)` call fires a fire-and-forget POST to `/api/internal/telemetry/skills/:id/usage` via the plugin's `tool.execute.after` branch. |
| **14** | Agent | Decides work is complete. Emits `memory_handoff({ targets: ["tester"], context })` → `task_complete({ taskId, evidence })`. No orchestrator branching — the agent initiates the handoff itself. |
| **15** | OpenCode | `session.prompt` returns (or timer fires — either way, control unblocks Arceus orchestrator). |
| **16** | Arceus orchestrator | `scoreBeatVerdict(beatId)` → `pass`/`fail` from task transitions emitted by the agent. |
| **17** | Arceus orchestrator | For each skillId in `getBeatSkillUsage(beatId)`: `registry.updateSuccessRate(skillId, outcome)`. EMA math (lr=0.15, clamped). |
| **18** | Arceus orchestrator | `updateTrustScore(role, companyId, verdict)`. |
| **19** | Arceus orchestrator | `sessionContextMap.delete(sess_123)` — context bridge gone. |
| **20** | Arceus orchestrator | `opencode.session.delete({ path: { id: sess_123 } })`. Plugin + MCP caches self-evict on next activity or explicit eviction. |
| **21** | Arceus orchestrator | `rm -rf /tmp/arceus/beats/beat_xyz` — ephemeral scratch cleanup. Symlink is stale; gets re-swapped on next beat's Step 5. |
| **22** | Arceus orchestrator | Emit final SSE events, write progress note for this beat, advance heartbeat counter, `clearBeatSkillUsage(beatId)`. **Beat is dead.** |

**Shared through the beat:** OpenCode server, plugin instance, MCP server instance, secrets env, registry connection.
**Beat-scoped:** session, context-map entry, `/tmp/arceus/beats/<beatId>/` dir, symlink target, plugin/MCP per-session cache entries.

---

## 4. Actors and responsibilities

| Actor | Lifetime | Job | Does NOT do |
|---|---|---|---|
| **Arceus orchestrator** | Process-wide | Curate context, wake agents, score beats, cleanup | Pick tasks, parse output, create artifacts, trigger handoffs, branch on role |
| **`sessionContextMap`** | Process-wide | Bridge `sessionID → beat metadata` | Store agent state (that's in the session) |
| **OpenCode server** | Process-wide | Host sessions, route tool calls | Know anything about beats (it just sees sessions) |
| **Plugin** | Shared across sessions | Enforce allowlist, circuit break, audit, skill-usage POST, resolve session context | Know task-level state |
| **MCP server** | Shared across sessions | Proxy 24 ops → Arceus API with correct headers, resolve session context | Contain business logic |
| **Session** | One beat | Conversation state, message history, tool log | Persist past `session.delete` |
| **Agent (inside session)** | One beat | Read state, reason, act via tools, complete | Know anything beyond what tools return |

---

## 5. New tools introduced by heartbeat design (Phase 7)

Beyond the 24 already catalogued, heartbeat-driven execution needs the agent to read its own situation and claim work explicitly.

| Tool | Purpose | Who |
|---|---|---|
| `task_claim` | Transition `ready → in_progress` by the claiming agent. Idempotency key = `claim:${beatId}:${taskId}`. Returns task detail. | All executors |
| `board_list_ready` | List tasks `status === "ready"` assignable to this role, ranked by priority + dependency satisfaction. Read-only. | All executors |
| `beat_read_last_progress` | Read structured progress notes from this role's last N beats (accomplishments, issues, next-steps). Read-only. | All executors |

These push the 24-ops surface to 26-27. Token budget per role still fits under 2,500 (Phase 5 measured ~650–750 tokens + 3 × ~55 char descriptions = +165 tokens).

---

## 6. Anti-patterns resolved by this runtime (from `plans/code-audit/flaws.md`)

| # | Anti-pattern | How the lifecycle resolves it |
|---|---|---|
| **#3, #4, #20** | specialist-executor does agent's job | Orchestrator does only Steps 1–6 and 15–22. Steps 7–14 are the agent. Specialist-executor deletes in Phase 8. |
| **#9** | `role === "..."` magic strings | Role shows up only in `ROLE_CONFIGS` (Phase 5) and `body.agent` selection (Step 6). No post-work branching survives. |
| **#10, #28** | governance hardcoded OFF | Plugin's allowlist (Step 9) is populated from `ctx.allowedTools` per session. Every tool call gated. |
| **#12** | no idempotency | Every mutation carries `idempotency-key` derived from `(beatId, op, target)` (Step 10). |
| **#17, #18** | system ops called procedurally | All 24 ops are tools (Steps 8–14). Orchestrator owns only Steps 1–6 + 15–22 — all reads + cleanup, zero mutations on agent's behalf. |
| **#19** | action-like skills should be tools | `memory_handoff`, `approval_request`, `task_complete` are all agent-called tools in Step 14. |
| **#23** | no progress notes between beats | `task_append_plan_step` + `task_append_command` are tools (Step 13); `beat_read_last_progress` reads them next beat. |

Outstanding after Phase 8 (out of scope — separate specs):

| # | Anti-pattern | Addressing phase / spec |
|---|---|---|
| #5, #6, #7 | Meeting / memory / skill-evolution as disconnected `structuredCompletion` calls | Separate agent-consolidation specs |
| #21, #22 | No baseline verify / no git safety net | Spec 18 |
| #27 | Self-improving instructions | v2 |
| #30 | `task.reportBug` tool | Tier C candidate for v2 |

---

## 7. Phase 6.5 — Heartbeat lifecycle runtime: 12 work packages

Twelve packages, dependency-ordered. Each has a concrete file path, exact signature, acceptance gate, LOC estimate, and time estimate. Packages marked **(P)** can run in parallel once their deps land.

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

**Total estimate:** ~20 h ≈ 2.5 engineer-days. Execution order (sequential + parallel lanes):

```
Day 1 AM:  A (contract) → B (sessionMap+route) → C (paths)        [~1.5 h total]
Day 1 PM:  D (materialize symlink upgrade)                         [~1 h — Phase 6 already shipped most of it]
Day 2 AM:  E (writeSharedOpencodeConfig) + H (already done)        [~1.5 h]
Day 2 PM:  F (plugin resolver) + G (MCP resolver) + I (buildBeatContext)   [~6 h, 3 parallel lanes]
Day 3 AM:  J (runBeat) + K (scoreBeat)                             [~3.5 h]
Day 3 PM:  L (e2e test) + bug fixes                                [~3 h]
```

---

### Package A — `BeatContext` contract  [~30 LOC, 15 min]

**File:** `packages/contracts/src/beat-context.ts` (new)

```typescript
import { z } from "zod";

export const trustBandSchema = z.enum(["probation", "standard", "senior"]);
export type TrustBand = z.infer<typeof trustBandSchema>;

export const roleSchema = z.enum([
  "ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead",
]);

export const beatContextSchema = z.object({
  beatId: z.string(),
  sessionId: z.string(),
  companyId: z.string(),
  role: roleSchema,
  trustBand: trustBandSchema,
  allowedTools: z.array(z.string()),
  taskId: z.string().optional(),             // optional — agent may claim later
  startedAt: z.string().datetime(),
});
export type BeatContext = z.infer<typeof beatContextSchema>;
```

Re-export from `packages/contracts/src/index.ts`.

**Acceptance:** `cd packages/contracts && npx tsc --noEmit` green; `BeatContext` importable from `@arceus/contracts`.

---

### Package B — Session-context map + internal route  [~80 LOC, 45 min]

**Files:**
- `apps/api/src/orchestration/session-context.ts` (new)
- `apps/api/src/routes/internal-telemetry.routes.ts` (extend existing — the telemetry namespace, not MCP)

```typescript
// session-context.ts
import type { BeatContext } from "@arceus/contracts";

const sessionContextMap = new Map<string, BeatContext>();

export const registerSessionContext = (ctx: BeatContext): void => {
  sessionContextMap.set(ctx.sessionId, ctx);
};
export const getSessionContext = (sessionId: string): BeatContext | undefined =>
  sessionContextMap.get(sessionId);
export const unregisterSessionContext = (sessionId: string): void => {
  sessionContextMap.delete(sessionId);
};
export const sessionContextSize = (): number => sessionContextMap.size;
```

Extend `apps/api/src/routes/internal-telemetry.routes.ts` with:

```typescript
app.get(`${TELEMETRY_BASE}/session-context/:sessionId`, async (req, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).safeParse(req.params);
  if (!params.success) { sendValidation(reply, params.error); return; }

  const ctx = getSessionContext(params.data.sessionId);
  if (!ctx) {
    reply.code(404).send(
      failure(`No context for session ${params.data.sessionId}.`, "not_found", "never", "session ended"),
    );
    return;
  }
  reply.code(200).send(ctx);
});
```

**Why `/telemetry/` namespace:** plugin + MCP callers are NOT agent-invoked tool proxies. They need bearer auth but not idempotency replay. Same reasoning as skill-usage POST (Phase 6 item 6).

**Acceptance:** unit test — `register → get → unregister` returns correct values and 404 after unregister. HTTP test — GET returns 200 with body, GET after unregister returns 404.

---

### Package C — Beat path utilities + symlink swap  [~60 LOC, 30 min]

**File:** `apps/api/src/infra/beat-paths.ts` (new)

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import { productWorkspace } from "./opencode.js";

export const beatScratchDir = (beatId: string): string =>
  path.join("/tmp", "arceus", "beats", beatId);
export const beatSkillsDir = (beatId: string): string =>
  path.join(beatScratchDir(beatId), "skills");
export const productWorkspaceSkillsSymlink = (): string =>
  path.join(productWorkspace, ".opencode", "skills");

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

**Wiring note:** Update Phase 6's `materializeBeatSkills` to call `swapSkillsSymlink` at the end of materialization (so OpenCode reads the materialized tree via the symlink when the session spawns). Currently it writes directly to the caller-provided `workDir` — once C lands, the caller passes `beatSkillsDir(beatId)` and the function also swaps the symlink.

**Acceptance:** integration test — mkdir target, swap symlink, `readlink` matches target; call swap twice to verify it overwrites without error; `cleanupBeatScratch` removes the tree.

---

### Package D — `materializeBeatSkills` symlink upgrade  [~20 LOC, 30 min]

**File:** `apps/api/src/opencode/materialize-beat-skills.ts` (extend existing)

Phase 6 shipped the function without the symlink swap. Update:

1. Change `workDir` semantics: materializer now writes to `beatSkillsDir(beatId)` directly, not to `<workDir>/.opencode/skills/`.
2. Write the manifest to `productWorkspaceSkillsSymlink()`'s parent (`<productWorkspace>/.opencode/arceus-skills.json`), not into the beat scratch dir (so the plugin finds it at its known path).
3. Call `swapSkillsSymlink(beatSkillsDir(beatId))` at the end.
4. Update the signature to remove `workDir` (now derived from `beatId`):

```typescript
export async function materializeBeatSkills(input: {
  beatId: string;
  companyId: string;
  role: string;
  trustBand: TrustBand;
}): Promise<MaterializedSkill[]> { ... }
```

**Keep Phase 6 test** (`materialize-beat-skills.test.ts`) working by passing `workDir` as the old API would have — add a second test pathway that calls the new signature and asserts the symlink was swapped.

**Acceptance:** new test — call `materializeBeatSkills({beatId, companyId, role, trustBand})` → assert `productWorkspace/.opencode/skills` is a symlink pointing at `/tmp/arceus/beats/<beatId>/skills/`; call twice back-to-back → second symlink points at second beat's dir (atomicity proven).

---

### Package E — `writeSharedOpencodeConfig` (boot-time)  [~120 LOC, 1.5 h]

**File:** `apps/api/src/infra/opencode.ts` (extend existing module)

Call this from `warmUpOpencode()` BEFORE spawning the OpenCode server. Idempotent — safe to run on every boot.

```typescript
import { ROLES } from "../../../../.opencode/agent/config.js";
import { writeBeatAgent } from "../../../../.opencode/agent/write-beat-agent.js";
import { runtimeConfig } from "../config/index.js";

export async function writeSharedOpencodeConfig(): Promise<void> {
  // 1. Copy plugin into productWorkspace
  const pluginSrc = resolve(projectRoot, "..", "..", ".opencode", "plugin", "arceus.ts");
  const pluginDst = resolve(productWorkspace, ".opencode", "plugin", "arceus.ts");
  await fs.mkdir(path.dirname(pluginDst), { recursive: true });
  await fs.copyFile(pluginSrc, pluginDst);

  // 2. Write all 8 agent files
  for (const role of ROLES) {
    await writeBeatAgent(role, productWorkspace);
  }

  // 3. Write opencode.json with MCP wiring + plugin reference
  const config = {
    "$schema": "https://opencode.ai/config.json",
    share: "disabled",
    mcp: {
      arceus: {
        command: ["node", "./node_modules/@arceus/mcp/dist/server.js"],
        env: {
          ARCEUS_API: runtimeConfig.arceusApi,
          ARCEUS_TOKEN: runtimeConfig.arceusToken,
        },
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

**Acceptance:** after `warmUpOpencode()` completes, assert:
- `productWorkspace/opencode.json` exists + has valid `mcp.arceus` section
- 8 `.opencode/agent/<role>.md` files exist
- `.opencode/plugin/arceus.ts` matches source

---

### Package F — Plugin session-context + skill-usage (extend existing plugin)  [~150 LOC, 2 h]  **(P)**

**File:** `.opencode/plugin/arceus.ts` (extend)

Add closure-scoped session-context cache and resolver. Replace env-based allowlist lookup with ctx-based. Keep existing governance + circuit + audit + skill-usage POST logic.

```typescript
import type { BeatContext } from "@arceus/contracts";

const sessionCtxCache = new Map<string, BeatContext>();

async function ensureCtx(sessionId: string): Promise<BeatContext | null> {
  if (sessionCtxCache.has(sessionId)) return sessionCtxCache.get(sessionId)!;
  try {
    const res = await fetch(
      `${process.env.ARCEUS_API}/api/internal/telemetry/session-context/${sessionId}`,
      { headers: { authorization: `Bearer ${process.env.ARCEUS_TOKEN}` } },
    );
    if (!res.ok) return null;
    const ctx = await res.json() as BeatContext;
    sessionCtxCache.set(sessionId, ctx);
    return ctx;
  } catch {
    return null;
  }
}

// Inside tool.execute.before handler (before governance check):
const ctx = await ensureCtx(input.sessionID);
const allowed = ctx?.allowedTools
  ?? (governance.allowedTools.size > 0 ? [...governance.allowedTools] : []);
if (allowed.length > 0 && !allowed.includes(input.tool)) {
  throw new Error(`[arceus-governance] Tool '${input.tool}' not in this beat's allowlist.`);
}

// Inside tool.execute.after handler, replace process.env.BEAT_ID with ctx.beatId:
if (input.tool === "skill") {
  await ensureManifest();
  const slug = resolveSkillSlug((output as { args?: unknown }).args);
  const entry = slug ? manifest[slug] : undefined;
  if (entry && ctx) {
    void fetch(
      `${process.env.ARCEUS_API}/api/internal/telemetry/skills/${entry.skillId}/usage`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.ARCEUS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ beatId: ctx.beatId, version: entry.version }),
      },
    ).catch(() => {});
  }
}
```

**Cache eviction:** closure-scoped map; self-evicts on process restart. Optional future hook: explicit eviction via a `session.end` notification from Arceus. Not needed v1 because beats serialize.

**Acceptance:** extend `.opencode/test/smoke.ts` with:
- Mock fetch for the session-context endpoint; verify allowlist comes from ctx when present (not from `process.env`).
- Mock skill tool call with a known sessionID + manifest entry; verify usage POST fires with `ctx.beatId` (not `process.env.BEAT_ID`).

---

### Package G — MCP server session-context resolver  [~100 LOC, 1.5 h]  **(P)**

**Files:**
- `packages/arceus-mcp/src/context-resolver.ts` (new)
- `packages/arceus-mcp/src/http-client.ts` (extend existing)

```typescript
// context-resolver.ts
import type { BeatContext } from "@arceus/contracts";

const cache = new Map<string, BeatContext>();

export async function resolveSessionContext(sessionId: string): Promise<BeatContext | null> {
  if (cache.has(sessionId)) return cache.get(sessionId)!;
  try {
    const res = await fetch(
      `${process.env.ARCEUS_API}/api/internal/telemetry/session-context/${sessionId}`,
      { headers: { authorization: `Bearer ${process.env.ARCEUS_TOKEN}` } },
    );
    if (!res.ok) return null;
    const ctx = await res.json() as BeatContext;
    cache.set(sessionId, ctx);
    return ctx;
  } catch {
    return null;
  }
}
```

Every tool handler receives `callContext.sessionID`. Extend `http-client.ts`:

```typescript
export async function proxyToArceus<T>(
  callContext: { sessionID: string },
  req: { method: string; path: string; body?: unknown; op?: string; target?: string },
): Promise<ToolResult<T>> {
  const ctx = await resolveSessionContext(callContext.sessionID);
  if (!ctx) {
    return failure(
      `No beat context for session ${callContext.sessionID}.`,
      "unknown_session",
      "never",
      "session ended or malformed",
    );
  }

  const res = await fetch(`${process.env.ARCEUS_API}${req.path}`, {
    method: req.method,
    body: req.body ? JSON.stringify(req.body) : undefined,
    headers: {
      "x-beat-id": ctx.beatId,
      "x-company-id": ctx.companyId,
      "x-role": ctx.role,
      "x-session-id": callContext.sessionID,
      "idempotency-key": deriveKey(ctx, req.op ?? req.path, req.target ?? ""),
      authorization: `Bearer ${process.env.ARCEUS_TOKEN}`,
      "content-type": "application/json",
    },
  });
  return res.json() as Promise<ToolResult<T>>;
}
```

Update every tool in `packages/arceus-mcp/src/tools/*.ts` to call `proxyToArceus` instead of the current env-based client.

**`deriveKey` implementation** (per the idempotency modes in §2 of doc 1):

```typescript
function deriveKey(ctx: BeatContext, op: string, target: string): string {
  const NATURAL = new Set(["task_complete", "task_block", "task_verify", "task_set_preview_url", "workspace_checkpoint"]);
  const CONTENT_HASH = new Set(["task_append_plan_step", "task_append_result", "memory_enrich", "artifact_create"]);
  if (NATURAL.has(op)) return `${op}:${target}`;                                              // natural key
  if (CONTENT_HASH.has(op)) return `${op}:${target}:${sha256(body).slice(0, 16)}`;            // content hash
  return `${ctx.beatId}:${op}:${target}`;                                                     // beat-scoped default
}
```

**Acceptance:** integration test — stub Arceus API with a session-context route; invoke one MCP tool with a known sessionID; assert downstream call arrived with correct `x-beat-id` + `x-company-id` + `x-role` + `idempotency-key` headers.

---

### Package H — Per-beat skill tally (already shipped in Phase 6)

`recordBeatSkillUsage` / `getBeatSkillUsage` / `clearBeatSkillUsage` already exist in `apps/api/src/routes/internal-telemetry.routes.ts`. No new file needed. Package J uses them directly (no HTTP).

---

### Package I — `buildBeatContext` + `renderStateForAgent`  [~180 LOC, 2.5 h]  **(P)**

**File:** `apps/api/src/orchestration/beat-context-builder.ts` (new)

Two separate concerns:
- `BeatContext` carries the **metadata** that plugin + MCP resolve against.
- `renderStateForAgent` builds the **prompt body** the agent reasons over.

```typescript
import type { BeatContext, Role, TrustBand } from "@arceus/contracts";
import { getAllowedArceusTools } from "../../../.opencode/agent/config.js";

export async function buildBeatContext(
  role: Role,
  companyId: string,
  beatId: string,
  sessionId: string,
): Promise<BeatContext> {
  return {
    beatId,
    sessionId,
    companyId,
    role,
    trustBand: await computeTrustBand(role, companyId),       // v1: always "standard" until policy matrix exists
    allowedTools: getAllowedArceusTools(role),                // from Phase 5 ROLE_CONFIGS
    startedAt: new Date().toISOString(),
  };
}

export function renderStateForAgent(role: Role, companyId: string): string {
  const sections = [
    renderCompanyState(companyId),           // sprint goal, current phase, stakeholder asks
    renderOpenTasksForRole(companyId, role), // status ∈ {ready, in_progress, blocked}, with dependency state
    renderRecentArtifacts(companyId, 10),    // last 10 artifacts from any role, with authorship
    renderRoleMemory(role, companyId),       // hippocampus read for this role
    renderLastProgressNotes(role, companyId, 5),  // last 5 beats' progress notes for this role
  ];
  return sections.join("\n\n---\n\n");
}

async function computeTrustBand(_role: Role, _companyId: string): Promise<TrustBand> {
  return "standard";  // v1 stub — full policy matrix Phase 7+
}
```

Individual section renderers (`renderCompanyState`, `renderOpenTasksForRole`, `renderRecentArtifacts`, `renderRoleMemory`, `renderLastProgressNotes`) each read DB/memory state and emit a markdown-ish string. Each ≤30 LOC. Section headers use `## <Section>` to help the agent parse.

**Acceptance:** unit test with seeded DB state — all 5 sections present in the rendered prompt; `trustBand === "standard"`; `allowedTools` matches `ROLE_CONFIGS[role]`.

---

### Package J — `runBeat` orchestrator  [~150 LOC, 2 h]

**File:** `apps/api/src/orchestration/run-beat.ts` (new) — the entry point replacing `executeSpecialistTask`.

```typescript
import crypto from "node:crypto";
import type { Role } from "@arceus/contracts";
import { getOpencode } from "../infra/opencode.js";
import { updateSuccessRate } from "@arceus/company-runtime";
import { buildBeatContext, renderStateForAgent } from "./beat-context-builder.js";
import { registerSessionContext, unregisterSessionContext } from "./session-context.js";
import { materializeBeatSkills } from "../opencode/materialize-beat-skills.js";
import { cleanupBeatScratch } from "../infra/beat-paths.js";
import { scoreBeatVerdict } from "./beat-scoring.js";
import { getBeatSkillUsage, clearBeatSkillUsage } from "../routes/internal-telemetry.routes.js";
import { updateTrustScore } from "../governance/trust.js";
import { ROLE_SOULS } from "../agents/roles.js";
import { ensureDeployment } from "../config/index.js";

const HARD_CAP_MS = 15 * 60 * 1000;

export interface BeatResult {
  beatId: string;
  sessionId: string;
  verdict: "pass" | "fail";
  cause?: string;
}

export async function runBeat(input: { role: Role; companyId: string }): Promise<BeatResult> {
  const beatId = `beat_${crypto.randomBytes(6).toString("hex")}`;
  const opencode = await getOpencode();

  // Step 3: create session
  const session = await opencode.client.session.create({
    body: { title: `Beat ${beatId} — ${input.role}` },
  });
  if (!session.data) throw new Error(`session.create failed for ${input.role}`);
  const sessionId = session.data.id;

  // Step 2+4: build context, register
  const ctx = await buildBeatContext(input.role, input.companyId, beatId, sessionId);
  registerSessionContext(ctx);

  // Step 5: materialize skills + swap symlink
  await materializeBeatSkills({
    beatId,
    companyId: input.companyId,
    role: input.role,
    trustBand: ctx.trustBand,
  });

  let cause: string | undefined;
  try {
    // Step 6: wake the agent (blocks, with hard cap)
    const stateText = renderStateForAgent(input.role, input.companyId);
    const soul = ROLE_SOULS[input.role].systemPrompt;

    const promptPromise = opencode.client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: "azure", modelID: ensureDeployment("workerDeployment") },
        agent: input.role,
        system: soul,
        parts: [{ type: "text", text: stateText }],
        tools: Object.fromEntries(ctx.allowedTools.map((t) => [t, true])),
      } as any,
    });

    let hardCapTimer: NodeJS.Timeout | undefined;
    const hardCapPromise = new Promise<never>((_, reject) => {
      hardCapTimer = setTimeout(() => reject(new Error("beat_hard_cap")), HARD_CAP_MS);
    });

    try {
      await Promise.race([promptPromise, hardCapPromise]);
    } catch (e) {
      cause = (e as Error).message === "beat_hard_cap" ? "beat_hard_cap" : "prompt_failed";
    } finally {
      if (hardCapTimer) clearTimeout(hardCapTimer);
    }
  } finally {
    // Steps 16–22: cleanup, always runs
    const verdict = cause === "beat_hard_cap" ? "fail" : await scoreBeatVerdict(beatId);

    const usedSkills = getBeatSkillUsage(beatId);
    for (const skillId of usedSkills) {
      updateSuccessRate(skillId, verdict === "pass" ? 1 : 0);
    }
    clearBeatSkillUsage(beatId);
    updateTrustScore(input.role, input.companyId, verdict);

    unregisterSessionContext(sessionId);
    try { await opencode.client.session.delete({ path: { id: sessionId } }); } catch {}
    await cleanupBeatScratch(beatId);

    return { beatId, sessionId, verdict, cause };
  }
}
```

**Acceptance:** mocked-OpenCode unit test — happy path runs cleanup; hard-cap timeout triggers cleanup with `verdict=fail` + `cause="beat_hard_cap"`; thrown error inside prompt still runs cleanup. Test asserts:
- `sessionContextMap.size === 0` after return
- `/tmp/arceus/beats/<beatId>/` does not exist
- `updateSuccessRate` called once per skill in `getBeatSkillUsage(beatId)`
- `opencode.client.session.delete` called

---

### Package K — `scoreBeatVerdict`  [~100 LOC, 1.5 h]

**File:** `apps/api/src/orchestration/beat-scoring.ts` (new)

**v1 heuristic** (kept minimal; richer logic Phase 7+ — artifact quality, test pass rate, preview-probe status):

```typescript
export async function scoreBeatVerdict(beatId: string): Promise<"pass" | "fail"> {
  const completed = await queryTaskTransitions(beatId, "completed");
  const blocked   = await queryTaskTransitions(beatId, "blocked");

  if (blocked > 0)   return "fail";
  if (completed > 0) return "pass";
  return "fail";  // no completion signal → failed beat
}

async function queryTaskTransitions(beatId: string, to: "completed" | "blocked"): Promise<number> {
  // Read from store — count tasks whose most recent transition in this beat was into the target state.
  // Implementation reads from the audit log / task state change history.
}
```

**Acceptance:** unit test — 3 transition fixtures:
- `(completed: 1, blocked: 0)` → `pass`
- `(completed: 0, blocked: 1)` → `fail`
- `(completed: 0, blocked: 0)` → `fail`

---

### Package L — End-to-end integration test  [~200 LOC, 3 h]

**File:** `apps/api/test/heartbeat-lifecycle.e2e.ts` (new — create `apps/api/test/` dir if missing)

```typescript
test("heartbeat-driven beat: wake → claim → complete → cleanup", async () => {
  await seedCompany("comp_test");
  await seedTask({ id: "tsk_1", companyId: "comp_test", role: "developer", status: "ready" });
  seedExistingSkillsDetailed("comp_test", SEED_DIR);

  const mockOpencode = mockOpencodeServer({
    onPrompt: async ({ sessionId }) => {
      await fakeToolCall({ sessionId, tool: "task_claim", args: { taskId: "tsk_1" } });
      await fakeToolCall({ sessionId, tool: "task_complete", args: { taskId: "tsk_1", evidence: {} } });
    },
  });

  const result = await runBeat({ role: "developer", companyId: "comp_test" });

  assert.equal(result.verdict, "pass");
  assert.equal(getTask("tsk_1").status, "completed");
  assert.equal(sessionContextSize(), 0);
  assert.equal(existsSync(beatScratchDir(result.beatId)), false);
  const linkTarget = await readlink(productWorkspaceSkillsSymlink()).catch(() => null);
  // Symlink may still point at a now-gone dir — that's fine; next beat re-swaps
  assert.ok(linkTarget === null || !existsSync(linkTarget));
});

test("back-to-back beats do not bleed skills", async () => {
  // Beat 1: developer — developer-tdd-loop materialized
  // Beat 2: tester — qa-verification-loop materialized; developer-tdd-loop gone
  // Assert after each: symlink target contains only current beat's skills
});

test("plugin + MCP receive correct session context via resolver", async () => {
  // Use the real plugin + stub Arceus API with session-context route
  // Invoke one tool, assert downstream HTTP call arrived with x-beat-id matching the session's beatId
});

test("hard cap fires if prompt hangs", async () => {
  const mockOpencode = mockOpencodeServer({
    onPrompt: () => new Promise(() => {}),   // never resolves
  });
  const HARD_CAP_MS_TEST = 100;  // override for test
  const result = await runBeat({ role: "developer", companyId: "comp_test" });
  assert.equal(result.verdict, "fail");
  assert.equal(result.cause, "beat_hard_cap");
});
```

**Acceptance:** `cd apps/api && npx tsx --test test/heartbeat-lifecycle.e2e.ts` passes (all 4 tests).

---

### Exit criteria for Phase 6.5 (before Phase 7 can start)

- [ ] All 12 packages land with acceptance tests green
- [ ] `pnpm --filter @arceus/contracts build` + `pnpm --filter @arceus/api test` + `npm run typecheck` in `.opencode/` all green
- [ ] `runBeat({ role: "developer", companyId })` completes against a real OpenCode server (warm, local Postgres)
- [ ] Plugin audit log shows governance gate enforcement (at least one rejected call with wrong allowlist)
- [ ] Registry shows `usageCount` incremented and `successRate` updated after one real beat
- [ ] `/tmp/arceus/beats/<beatId>/` cleaned, `sessionContextMap.size === 0` post-beat

---

## 8. Phase 7 — Heartbeat shadow mode + self-direction tools (2d)

Phase 6.5 ships the machinery. Phase 7 proves the heartbeat design works and adds the 3 tools that let agents self-direct.

**Goal:** for ≥10% of beats, skip `executeSpecialistTask` entirely and route through `runBeat(role, companyId)`. Compare outcomes against the orchestration path on the remaining 90% to quantify divergence before we flip.

### 7.1 — Add 3 self-direction tools to the MCP server

| Tool | Signature | Owner route |
|---|---|---|
| `board_list_ready` | `(filter?: { priority?: "high"|"normal" }) → ReadyTask[]` | `GET /api/internal/v1/tasks/ready?role=<role>&companyId=<companyId>` |
| `task_claim` | `(taskId: string, reason: string) → ClaimedTask` | `POST /api/internal/v1/tasks/:id/claim` — idempotency key = `claim:${beatId}:${taskId}` |
| `beat_read_last_progress` | `(n: number = 3) → ProgressNote[]` | `GET /api/internal/v1/beats/recent?role=<role>&companyId=<companyId>&n=<n>` |

All three go under the MCP tool namespace (agent-invoked). `task_claim` is mutation (transitions `ready → in_progress`); the other two are read-only.

Update per-role tool allowlists in `.opencode/agent/config.ts` to include all three for every executor role (ceo/cto/pm/developer/tester/ui_designer/marketing/skills_lead).

**Budget check:** Phase 5 measured ~650–750 tokens per role. +3 tools × ~55 char descriptions = +165 tokens. Max role still under 2,500.

**Routes to add on the Arceus API side:**

```typescript
// GET /api/internal/v1/tasks/ready
// Query params: role, companyId
// Returns: ToolResult<ReadyTask[]> where ReadyTask = {
//   taskId, title, kind, priority, assignedRole, dependsOn, blockers, createdAt
// }
// Sorted by: priority desc, createdAt asc, skip tasks whose dependsOn are not completed

// POST /api/internal/v1/tasks/:id/claim
// Body: { reason: string }
// Headers: x-beat-id, idempotency-key = claim:${beatId}:${taskId}
// Transitions: status ready → in_progress, sets claimedByBeatId
// Rejects if: task not ready, claimedByBeatId != this beat (409), wrong assignee (403)

// GET /api/internal/v1/beats/recent
// Query params: role, companyId, n (default 3)
// Returns: ToolResult<ProgressNote[]> where ProgressNote = {
//   beatId, taskId, accomplished, issues, nextSteps, verdict, endedAt
// }
```

### 7.2 — Shadow routing with feature flag `ARCEUS_HEARTBEAT_SHADOW`

```typescript
// heartbeat tick handler (pseudocode)
function shouldShadow(companyId: string, role: Role, tick: number): boolean {
  if (process.env.ARCEUS_HEARTBEAT_SHADOW !== "true") return false;
  const h = hash(`${companyId}:${role}:${tick}`) % 10;
  return h === 0;  // ~10%
}

if (shouldShadow(companyId, role, tick)) {
  const shadowResult = await runBeat({ role, companyId });
  emitShadowTelemetry(shadowResult, /* counterfactual info */);
} else {
  await executeSpecialistTask(taskId);
}
```

**Shadow and live paths never run for the same tick** — one or the other. Comparison is statistical across many beats, not per-beat.

### 7.3 — Divergence metrics (5 axes, logged per shadow beat)

| Axis | What we measure | How |
|---|---|---|
| Task selection | Did the agent claim the same task the orchestrator would have picked? | Log `orchestratorWouldHaveChosen` alongside `agentPicked` |
| Completion | Did the agent reach `task_complete` or `task_block` within the beat? | Check task state transitions for this beatId |
| Artifacts | Did the agent produce artifacts similar in count/kind to orchestration? | Compare `artifact.count` + `artifact.kind[]` per role |
| Handoffs | Did the agent call `memory_handoff` when orchestration would have? | Compare presence of `memory_handoff` tool call vs orchestrator-triggered wrapper |
| Verdict | Did `scoreBeatVerdict` agree? | Compare pass/fail between shadow and counterfactual |

### 7.4 — Recovery contract (v1 scope, honest)

| Concern | Mechanism | Status |
|---|---|---|
| **Hard cap** per beat | `runBeat` wraps `session.prompt` in `Promise.race([prompt, setTimeout(15 * 60_000)])`. Timeout → force `session.delete`, mark beat verdict `fail`, cause=`beat_hard_cap`, retry=`unsafe`. | Ships in Phase 6.5 (package J) |
| **Developer stall** | Existing `scheduleDeveloperWatchdog` in `apps/api/src/workspace/watchdog.ts` continues to run for developer sessions — unchanged. | Already live |
| **Idle detection for non-developer roles** | None in v1. Tester/designer/marketing/etc. beats get hard-cap only. | Deferred (§10 "Outer watchdog generalization") |
| **Last-tool diagnostic on timeout** | Plugin's `tool.execute.before`/`after` pair gives before-without-after as the smoking gun. No persistent audit sink yet. | Deferred (§10) |
| **Force-complete after idle** | Not implemented. Plan 05 prescribed `session.idle` — SDK `@opencode-ai/plugin@1.3.17` lacks it. `event`-based watchdog deleted in Phase 4 cleanup (redundant with outer developer timer, inferior to it). | Deferred |

### 7.5 — Benchmarks (6 per beat)

- completion rate (did task reach terminal state without hard-cap)
- retries per task
- pass@1 (terminal state on first try, no corrections)
- cost per successful task ($)
- time-to-first-tool-call (agent bootstrap latency)
- tool-calls-per-beat (breadth of agent action)

### 7.6 — Flip criteria (before Phase 8)

- Shadow divergence ≤5% on all 5 axes (7.3) for one full sprint
- Hard-cap rate ≤2% of shadow beats

### Deliverable

- 3 new MCP tools registered, descriptions ≤160 chars, lint green
- 3 new Arceus API routes under `/api/internal/v1/` with full MCP middleware
- `ARCEUS_HEARTBEAT_SHADOW=true` routes 10% of beats through `runBeat`
- Divergence report surfaced in audit log with 5 axes
- 6 benchmark metrics tracked in observability dashboard
- Flip criteria published

---

## 9. Phase 8 — Delete specialist-executor (1d)

When Phase 7 flip criteria are met.

### 8.1 — Promote the flag

Set `ARCEUS_HEARTBEAT_DEFAULT=true`. Heartbeat routes 100% through `runBeat`.

### 8.2 — Delete, don't shrink

Specialist-executor is not shrunk to 30 lines. It's **deleted outright**. The only external caller becomes `runBeat`.

| File | Action | Reason |
|---|---|---|
| `apps/api/src/tasks/specialist-executor.ts` | **delete file** | Entire responsibility moved to `runBeat` + agent tool calls |
| `apps/api/src/memory/handoffs.ts` → `deliverUiDesignerMemoryHandoff`, `deliverSkillsLeadMemoryHandoff` | **delete functions** | Agents call generic `memory_handoff` tool themselves |
| `apps/api/src/approvals/*` → `createMarketingExternalApproval` | **delete function** | Marketing agent calls `approval_request` tool itself |
| `apps/api/src/tasks/*` → `buildTesterArtifact`, `buildDesignDirectionArtifact`, all role-specific builders | **delete functions** | Agent structures its own artifact via `artifact_create` |
| `apps/api/src/tasks/planner.ts` → `generateWorkflowTaskPlan` standalone LLM call | **leave for ATA spec** | Orthogonal; stays in place if anything calls it |

### 8.3 — Skill pre-flight deletion list

Made redundant by §3.6 + Phase 6 materialization:

| File / symbol | Action | Reason |
|---|---|---|
| `apps/api/src/skills/classifier.ts` (entire file) | delete | `classifyTaskSkills` + `matchAndRecordSkills` replaced by OpenCode native `<available_skills>` read |
| `buildSkillCatalog` / `buildSkillSection` / `buildSkillMenu` / `getSkillBody` in `apps/api/src/skills/catalog.ts` | delete | No prompt-side catalog injection — OpenCode loads from `.opencode/skills/` symlink |
| `matchedSkillIds` parameter in `runPromptText` at `apps/api/src/prompts/llm.ts:176` | delete | Call site gone; catalog comes from filesystem |
| `matchAndRecordSkills` import at `apps/api/src/heartbeats/beat-executor.ts:25` and call at `:81` | delete | beat-executor itself gets replaced by `runBeat`; these paths disappear with it |
| `skillClassifierSchema` + barrel exports in `apps/api/src/skills/index.ts` | delete | Schema unused after classifier deletion |
| Pre-Phase-6 client-side `recordSkillUsage` call sites in `apps/api/src/skills/*` | delete | Usage now recorded by the plugin hook → telemetry route → `recordSkillUsage` in `skill-registry.ts` (server-side). **Keep the server-side function; delete only the old client-side filter callers.** |

### 8.4 — CI grep guards (PR check)

```bash
# No role-branching in post-beat logic
! rg -n 'if\s*\(\s*(?:role|agent\.role|task\.assignedRole)\s*===\s*"' apps/ packages/

# Skill pre-flight symbols fully removed
! rg -n 'classifyTaskSkills|matchAndRecordSkills|buildSkillCatalog|buildSkillSection|buildSkillMenu|getSkillBody|matchedSkillIds|skillClassifierSchema' apps/ packages/

# specialist-executor.ts does not exist
[ ! -f apps/api/src/tasks/specialist-executor.ts ]
```

If any check returns a hit, the PR fails.

### 8.5 — Update callers

Search for remaining `executeSpecialistTask` / `runAutonomousReadyTasks` callers; route them to `runBeat({ role, companyId })`. Heartbeat tick handler is the primary caller; anything else is either a test (update) or dead code (delete).

### Deliverable

- `specialist-executor.ts` deleted
- `deliverUiDesignerMemoryHandoff`, `createMarketingExternalApproval`, role-specific artifact builders all deleted
- Skill pre-flight layer fully removed; CI grep guards wired into PR check
- `runBeat` is the sole beat entry point; heartbeat tick → `runBeat`
- All tests green; no hidden orchestration-mode code paths remain

---

## 10. Phase 9 — Optional: `arceus_tool_search` bridge (0.5d)

**Almost certainly not needed in v1.** Phase 5 measurement showed per-role eager catalogs at ~650–750 tokens each. Even after Phase 7 adds 3 more tools (~165 tokens), we're well under the 2,500-token budget per role.

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

## 11. File-level impact (after all phases complete)

### New files

**Contracts:**
- `packages/contracts/src/beat-context.ts` (~30 LOC, package A)

**Arceus API orchestration & infra:**
- `apps/api/src/orchestration/session-context.ts` (~40 LOC, package B)
- `apps/api/src/orchestration/beat-context-builder.ts` (~180 LOC, package I)
- `apps/api/src/orchestration/run-beat.ts` (~150 LOC, package J)
- `apps/api/src/orchestration/beat-scoring.ts` (~100 LOC, package K)
- `apps/api/src/infra/beat-paths.ts` (~60 LOC, package C)

**MCP package extension:**
- `packages/arceus-mcp/src/context-resolver.ts` (~100 LOC, package G)

**Phase 7 Arceus API routes:**
- `apps/api/src/routes/internal-mcp/tasks-ready.routes.ts` (~40 LOC — `board_list_ready`)
- Extension to `tasks.routes.ts` for `task_claim`
- `apps/api/src/routes/internal-mcp/beats.routes.ts` (~40 LOC — `beat_read_last_progress`)

**MCP tools (Phase 7):**
- `packages/arceus-mcp/src/tools/board.ts` or extension to `tools/task.ts` (`board_list_ready`, `task_claim`, `beat_read_last_progress`)

**Phase 9 (conditional):**
- `packages/arceus-mcp/src/tools/search.ts` (~100 LOC)

**Tests:**
- `apps/api/test/heartbeat-lifecycle.e2e.ts` (~200 LOC, package L)
- Tests per package (A through K each have ≥1 test file)

### Modified files

- `packages/contracts/src/index.ts` — export `BeatContext`, `TrustBand`, `Role`
- `packages/company-runtime/src/index.ts` — (already exporting what's needed from Phase 6)
- `apps/api/src/routes/internal-telemetry.routes.ts` — add session-context route (package B)
- `apps/api/src/opencode/materialize-beat-skills.ts` — symlink swap + signature change (package D)
- `apps/api/src/infra/opencode.ts` — add `writeSharedOpencodeConfig()`; call from `warmUpOpencode()` (package E)
- `.opencode/plugin/arceus.ts` — session-context resolver (package F)
- `packages/arceus-mcp/src/http-client.ts` — proxy via session-context resolver (package G)
- `packages/arceus-mcp/src/tools/*.ts` — each tool call uses new `proxyToArceus` signature
- `.opencode/agent/config.ts` — add 3 Phase 7 tools to executor allowlists
- `apps/api/src/heartbeats/beat-executor.ts` — route to `runBeat` under flag (Phase 7); delete under flag (Phase 8)

### Deleted files (Phase 8 — one-shot post-flip)

- `apps/api/src/tasks/specialist-executor.ts` (entire file)
- `apps/api/src/skills/classifier.ts` (entire file)
- `buildSkillCatalog` / `buildSkillSection` / `buildSkillMenu` / `getSkillBody` from `apps/api/src/skills/catalog.ts`
- `matchedSkillIds` parameter from `apps/api/src/prompts/llm.ts`
- Role-specific handoff wrappers (`deliverUiDesignerMemoryHandoff`, `deliverSkillsLeadMemoryHandoff`)
- `createMarketingExternalApproval` and similar role-bound approval helpers
- Role-specific artifact builders (`buildTesterArtifact`, `buildDesignDirectionArtifact`)
- `skillClassifierSchema` + related barrel exports

---

## 12. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Agent doesn't call `task_complete` → task stays in-progress forever | HIGH | 15-min hard cap in `runBeat` (package J). Verdict becomes `fail` with `cause=beat_hard_cap`; next beat can reclaim. |
| Governance whitelist too strict → agent can't do its job | HIGH | Start permissive (Phase 5 allowlists as measured); grow whitelist from shadow telemetry |
| Agent stuck in retry loop on same error (LLMs ignore `retry: "never"`) | HIGH | Plugin `tool.execute.before` tracks `(tool_id, error.cause) → count`; hard-refuses at count ≥ 3 (already live from Phase 4) |
| MCP SDK API drift breaks `registerTool`/transport calls | HIGH | Pin exact `@modelcontextprotocol/sdk` version; Context7 lookup before every SDK upgrade |
| Tool description bloat creeps back in | MEDIUM | Pre-commit hook: fail if any `src/tools/*.ts` description > 160 chars or lacks side-effect hint for network/storage ops |
| Eager catalog token count creeps past budget | MEDIUM | CI **hard-fails** on `eager_token_count ≥ 2500` per role with list of demotion candidates. No auto-demotion — human picks |
| Stdio serialization overhead higher than expected | MEDIUM | Measure in Phase 3 with Inspector; if p95 > 20ms, promote offenders to Tier A |
| Shadow-mode divergence: agent skips `memory_enrich` systematically | MEDIUM | Skill-creator pass on `memory-handoff-protocol` SKILL.md; if still drifting, make `memory_enrich` a soft requirement via plugin `tool.execute.after` on `task_complete` |
| `ToolResult<T>` envelope drift across MCP vs plugin | MEDIUM | Single `envelope.ts` used by both; Zod-parsed in integration test for every tool |
| Cross-beat accidental double-mutation (agent loses context) | MEDIUM | Per-op idempotency mode (natural / content-hash / beat-scoped) in §2 of doc 1 |
| Static skills drift from runtime needs (no EMA feedback in v1) | LOW | Registry now has EMA feedback loop (Phase 6). Probation band filters low-confidence skills. |
| Symlink race between beats | LOW | Beats serialize in v1. Concurrent beats flagged as v2 concern; swap to per-session OpenCode or per-beat server. |
| Role-check ripple beyond `specialist-executor.ts` | LOW | Grep audit in Phase 8 before deletion (CI guards catch remainders) |
| `arceus_tool_search` needed sooner than Phase 9 | LOW | Phase 9 is ready to ship standalone |
| Need for remote (non-local) clients in future | LOW | `transport-stdio.ts` / `transport-http.ts` split means Streamable HTTP is an entrypoint swap, not a rewrite |

---

## 13. Verification ladder (end-to-end, after all phases)

1. **Unit** — each MCP tool → internal route → mutator round-trip. Mock Arceus API, assert correct side effects + envelope shape.
2. **Integration** — spin up full Arceus + `opencode run --agent developer` in a sandbox workdir. Task: "add JWT refresh." Assert: `task_complete` called, artifact in DB, workspace checkpointed, sprint advances.
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

## 14. Complexity & timeline

| Phase | Complexity | Est. | Status |
|---|---|---|---|
| 0 — Scaffolding + `ToolResult<T>` | Low | 0.5d | ✅ done |
| 1 — Internal routes | Medium | 1.5d | ✅ done |
| 2 — Generalize helpers | Low | 1d | ✅ done |
| 3 — MCP handlers + `tool_help` | Medium | 1.5d | ✅ done |
| 4 — Plugin + Tier A | Medium | 1d | ✅ done |
| 5 — Per-role agent files | Low | 0.5d | ✅ done |
| 6 — Registry materialization (items 1–8) | Medium | 1d | ✅ done |
| **6.5 — Heartbeat runtime (A–L)** | **Medium-High** | **~2.5d** | **🟡 TODO** |
| 7 — Shadow mode + 3 self-direction tools + benchmarks | High | 2d | 🟡 TODO |
| 8 — Flip + delete | Medium | 1d | 🟡 TODO |
| 9 — `arceus_tool_search` bridge (conditional) | Low | 0.5d | 🟡 Maybe |

**Remaining: ~5.5 engineer-days** (6d with Phase 9).

---

## 15. What this plan deliberately does NOT do

- No Strata 4-stage funnel — 24 tools don't justify the complexity.
- No embedding-based tool selection — per-role scoping + `arceus_tool_search` is enough.
- No "code-as-tools" sandbox — revisit if benchmarks show context pressure after Phase 8.
- No rewrite of the skill-evolution ATA pipeline — orthogonal, separate spec. The 8-call ATA lambda chain in `apps/api/src/skills/evolution.ts` keeps writing to the registry as today. Collapsing those 8 standalone `structuredCompletion` calls into one agent-session conversation is a separate spec. v1 benefits from the registry + EMA even without touching ATA.
- No change to the 180 remaining orchestrator-internal ops.
- No MCP Resources or Prompts in v1 — Tools only. Revisit Resources for `tool_help` once OpenCode's Resource behavior is measured.
- No Streamable HTTP transport in v1 — stdio only. Entrypoint split in Phase 0 makes HTTP a swap, not a rewrite.
- No full trust-band policy matrix in v1 — `trustBandAllows()` ships with a minimal three-band filter (probation / standard / senior). Full role × band × skill-status matrix is Phase 7+.
- No `session.idle` batched skill-usage flush — SDK 1.3.17 has no such hook. Per-call POST in `tool.execute.after` is the v1 substitute; batch when SDK adds the hook.
- **Runtime skill-resource authoring deferred.** v1 ships seed-time authoring only (`.arceus/skills-seed/` → registry via `seedExistingSkillsDetailed`). Agents cannot add or edit resources on a live artifact during a beat. The two runtime paths — (a) admin API `PUT /api/internal/v1/skills/:id/resources` + CLI (`arceus skill add-resource`), and (b) a `skill.upsert_resource` MCP tool granted to the skills_lead agent — are deferred until there's a concrete need. The ATA pipeline's `skillMutator` also can't propose resource changes yet; extending its output schema to include resource diffs is part of the separate ATA-rewrite spec. v1 contract: **humans author at seed time, agents consume at runtime.**
- **Memory handoff generalization deferred.** `deliverUiDesignerMemoryHandoff` and `deliverSkillsLeadMemoryHandoff` remain as role-specific wrappers. A generic `deliverMemoryHandoff({ fromRole, targets: [{ role, currentFocus, activePatterns, ... }] })` is the right shape, but the role-specific side effects (what each target cares about) are still best expressed as orchestrator-authored templates until specialist agents learn to emit handoff intents in their own output.
- **Memory tools postponed from per-role allowlists.** The three memory tools (`memory_enrich`, `memory_clear_blockers`, `memory_handoff`) have server-side implementations but are **removed from every role's allowlist in Phase 5 config** per user decision. They re-enter the allowlist when the memory integration is prioritized.
- **Outer watchdog generalization deferred to Phase 7.** `scheduleDeveloperWatchdog` is developer-only and fused to workspace file-change monitoring (a developer-specific signal) and `activeExecution.buildTaskId` (single-task model). Making it per-role requires: (a) per-role timer map in `state.ts` replacing single `developerWatchdog`, (b) per-role activity signal (non-developer roles have no workspace monitor equivalent), (c) per-role escalation meeting templates, (d) per-role active-task resolution. The plugin-level watchdog was removed in Phase 4 cleanup (SDK has no `session.idle` hook; `event` firehose cannot fire in true silence — redundant with outer timer, inferior to it). Status quo: developer is the only role with stall-detection teeth; other roles rely on beat-level scheduling cadence + 15-min hard cap.
- **Last-tool diagnostic blocked on audit sink.** When the outer watchdog fires, we want "last tool call was `bash` (callID c43), started 14m ago, no matching `after` event" in the failure message. The plugin's `tool.execute.before`/`after` audit pair is the right evidence (we emit both, with `callID` + `sessionID` + `startedAt` + `latencyMs`), but today it writes to stderr only — no persistent, queryable store the outer watchdog can grep. Requires: (1) audit sink decision (stderr-tee to file, append-only JSONL per session, or DB table), (2) `readLastToolEvent(sessionID)` helper, (3) `failBeatStall` enriches its diagnostic message. Low value to half-build; wire alongside audit sink when Phase 7 needs observability anyway.
- **Agent-authored approval requests deferred.** In v1, specialist-executor still hardcodes `if (role === "marketing" && kind === "distribution_campaign")` to fire `requestApproval(...)` with a templated title/description. The correct shape is: marketing agent gets the `POST /api/internal/v1/approvals` MCP tool in its toolbelt and decides *whether* and *what* to request during its own run — deleting the post-task branch entirely. Requires a tool-use loop (not one-shot `structuredCompletion`), MCP bearer threaded into the agent session, and a governance fallback for "agent didn't request one but the kind says it's required." Belongs in the same spec as the rest of the rigid `if (role === ...)` branches.

---

## 16. Transport & SDK strategy

**Transport: stdio only in v1.**
- Every MCP client we care about (OpenCode, Claude Code, Inspector) supports stdio natively.
- `transport-stdio.ts` and `transport-http.ts` are split at the entrypoint layer. Server logic (`server.ts` + `tools/*`) is transport-agnostic.
- Promoting to Streamable HTTP later = wire `transport-http.ts` + add `ARCEUS_MCP_BIND=0.0.0.0:7777` env. No tool code changes.

**SDK discipline:**
- Pin exact `@modelcontextprotocol/sdk` version in `package.json`. Never use `^` or `~`.
- Before any SDK upgrade: Context7 lookup → diff release notes → run Level 1 Inspector smoke test.
- SDK API naming (`registerTool` vs `tool`, `StdioServerTransport` constructor shape) has churned. Treat it as unstable until the spec ships 1.0.

**Testing ladder (runs without full Arceus):**
1. **Level 0** — unit tests on schemas + envelope.
2. **Level 1** — MCP Inspector → stdio server with mock env.
3. **Level 2** — Inspector → MCP → 30-line mock Express at `/internal/mcp/*`.
4. **Level 3** — `opencode run --agent developer` against Level 2 mock + generated `.opencode/*` tree.
5. **Level 4** — `claude mcp add arceus ...` proves cross-harness reuse.

Levels 0–3 require zero Arceus runtime. Build the whole 24-tool surface before wiring it in.

---

## 17. Order of operations when picking this up

1. **Run the done-phase verification from `01-done-phase-0-to-pre-65.md` §8** — confirm nothing regressed.
2. **Package A** (trivial, unblocks B and I).
3. **Package B** (unblocks F and G).
4. **Package C** (unblocks the symlink in materializer).
5. **Package D** (small patch to Phase 6 materializer).
6. **Package E** (boot-time wiring — safe to do any time once A exists).
7. **Packages F, G, I in parallel** (three independent lanes — F + G use the route from B, I uses the contract from A and existing state readers).
8. **Package J** (`runBeat`) — depends on all prior.
9. **Package K** — wires into J's `finally` block. Can overlap with J since it's a separate file.
10. **Package L** (end-to-end test) — exit criteria for Phase 6.5.
11. **Phase 7** — 3 self-direction tools + shadow flag + divergence telemetry + 6 benchmarks. Two-day slice.
12. **Phase 8** — deletion spree once Phase 7 flip criteria (≤5% divergence, ≤2% hard-cap) are met.
13. **Phase 9** — skip unless Phase 7 metrics trigger it.

Each step has an acceptance test defined above. Ship the test before moving to the next package.

---

## 18. Summary (the one-pager)

- Phase 6.5 is the runtime that makes the heartbeat design real. 12 work packages, ~20 h.
- Phase 7 ships 3 self-direction tools (`board_list_ready`, `task_claim`, `beat_read_last_progress`), shadow-routes 10% of beats through `runBeat`, tracks divergence on 5 axes + 6 benchmarks.
- Phase 8 deletes specialist-executor entirely (not shrinks), along with all role branching and skill pre-flight infrastructure. 3 CI grep guards enforce it stays gone.
- Phase 9 is conditional — only if token budgets blow up.
- ~5.5 engineer-days remain after Phase 6.5 is complete, or ~8 days if you include 6.5 itself.
