# 05 — Arceus × OpenCode Integration Blueprint

> End-to-end mapping of Arceus's `SkillArtifact` lifecycle, governance pipeline, and orchestration primitives onto OpenCode's client/server + plugin + skill model. This is the *what-to-build* companion to the four preceding docs.

---

## TL;DR

1. **Keep** the `SkillArtifact` record, version history, EMA `successRate`, `skillMutator`, `skillTester`, pattern learner, failure attribution. These are Arceus-specific IP that OpenCode has no analogue for.
2. **Materialize** the *currently-active* subset of skills into a per-beat `.opencode/skills/<slug>/SKILL.md` tree at dispatch time. OpenCode's built-in Tier-1 catalog injection + `skill` tool replaces `buildSkillCatalog` / `classifyTaskSkills` / the embedding matcher entirely.
3. **Plug in** a single `arceus-governance.ts` plugin that wires `tool.execute.before` → trust-band policy, `tool.execute.after` → usage telemetry + audit, `chat.params` / `chat.headers` → LLM routing, `permission.ask` → dynamic gating.
4. **Expose** orchestration primitives (`emit_artifact`, `post_to_ceo_chat`, `request_sprint_review`, `submit_review_verdict`) via a small `arceus-mcp` stdio server. Every harness (Claude Code, Cursor, OpenCode) can consume the same contract.
5. **Filesystem is the isolation boundary.** OpenCode never sees `companyId`, `beatId`, `role`, or trust-band — it just sees the working directory Arceus handed it. Per-tenant isolation is perfect because each beat gets its own `.opencode/`.

---

## 1. The handoff picture

```
┌─────────────────────────────── Arceus control plane (Node/TS) ────────────────────────────────┐
│                                                                                                │
│  SkillArtifact DB  ──► skillRegistry hot cache  ──► materializeBeatSkills(beatId, role)       │
│        ▲                                                 │                                     │
│        │                                                 ▼                                     │
│        │                                   /tmp/arceus/beats/<beatId>/                         │
│        │                                   ├── opencode.json          (per-beat overrides)    │
│        │                                   ├── AGENTS.md              (role rules)            │
│        │                                   ├── .opencode/                                      │
│        │                                   │   ├── agent/<role>.md                             │
│        │                                   │   ├── skills/<slug>/SKILL.md     ← materialized  │
│        │                                   │   ├── skills/<slug>/scripts/*    ← tier-3        │
│        │                                   │   ├── plugin/arceus.ts  (governance hooks)       │
│        │                                   │   └── command/<macro>.md                          │
│        │                                   └── .env    (BEAT_ID, COMPANY_ID, ARCEUS_TOKEN)    │
│        │                                                 │                                     │
│        │                                                 ▼                                     │
│        │                                     spawn `opencode run --agent <role>`               │
│        │                                                 │                                     │
│        │                     ┌───────────────────────────┼───────────────────────────┐         │
│        │                     │                           ▼                           │         │
│        │                     │  OpenCode process:                                    │         │
│        │                     │    Tier-1 catalog auto-injected from SKILL.md files   │         │
│        │                     │    Model reasons → calls skill({name}) → body loaded  │         │
│        │                     │    Tool calls flow through plugin hooks               │         │
│        │                     │    MCP tools (arceus_emit_artifact, ...) available    │         │
│        │                     └─────────────┬─────────────────────────┬───────────────┘         │
│        │                                   │                         │                         │
│        │                        tool.execute.after                   │                         │
│        │                        on skill tool                        │                         │
│        │                                   │                         │                         │
│        │                                   ▼                         ▼                         │
│        │         POST /internal/skill-usage                  POST /api/arceus/artifact        │
│        │                 { beatId, skillId, outcome? }        { kind, content, taskId }        │
│        │                                   │                         │                         │
│        └───────────────────────────────────┴─────────────────────────┘                         │
│                                            │                                                   │
│                                            ▼                                                   │
│                           updateSuccessRate(skillId, outcome)                                  │
│                           recordSkillUsage(beatId, skillId)                                    │
│                                                                                                │
│  After beat exits → beat outcome (pass/fail) attributed to used skills → drives mutation loop │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The only two things that cross the boundary:

1. **Into** OpenCode: a directory tree. Arceus owns its composition.
2. **Out of** OpenCode: (a) exit code + JSON output from `opencode run --format json`, (b) plugin-emitted HTTP calls back to Arceus, (c) MCP tool invocations against `arceus-mcp`.

---

## 2. `materializeBeatSkills` — the core glue function

Signature:

```typescript
// apps/api/src/opencode/materialize-beat-skills.ts
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SkillArtifact, SkillResource } from "@arceus/company-runtime/skill-registry"

export interface MaterializeBeatSkillsInput {
  beatId: string
  companyId: string
  role: string                    // "ceo" | "cto" | "engineer" | ...
  workDir: string                 // e.g. /tmp/arceus/beats/<beatId>
  trustBand?: "probation" | "standard" | "senior"
}

export interface MaterializedSkill {
  skillId: string
  slug: string                    // filename-safe form of name
  version: number
  path: string                    // absolute path to SKILL.md
}

export async function materializeBeatSkills(
  input: MaterializeBeatSkillsInput,
  deps: { registry: SkillRegistry },
): Promise<MaterializedSkill[]> {
  const { beatId, companyId, role, workDir, trustBand = "standard" } = input
  const skillsDir = path.join(workDir, ".opencode", "skills")
  await mkdir(skillsDir, { recursive: true })

  // 1. Pull active skills for this company+role from the registry.
  const artifacts = deps.registry.listActive({ companyId, role, trustBand })

  // 2. Write SKILL.md + tier-3 resources per skill.
  const materialized: MaterializedSkill[] = []
  for (const artifact of artifacts) {
    const slug = slugify(artifact.name)
    const skillDir = path.join(skillsDir, slug)
    await mkdir(skillDir, { recursive: true })

    const frontmatter = buildFrontmatter(artifact)
    const body = artifact.content.trim()
    const skillMdPath = path.join(skillDir, "SKILL.md")
    await writeFile(skillMdPath, `${frontmatter}\n\n${body}\n`, "utf8")

    for (const resource of artifact.resources ?? []) {
      await writeResource(skillDir, resource)
    }

    materialized.push({
      skillId: artifact.id,
      slug,
      version: artifact.version,
      path: skillMdPath,
    })
  }

  // 3. Write a beat manifest (Arceus-side lookup: slug → artifact id/version).
  await writeFile(
    path.join(workDir, ".opencode", "arceus-skills.json"),
    JSON.stringify({ beatId, companyId, role, trustBand, skills: materialized }, null, 2),
  )

  return materialized
}

function buildFrontmatter(a: SkillArtifact): string {
  const descr = [
    a.trigger ? `Use when: ${a.trigger}.` : null,
    a.description,
    `(trust ${Math.round(a.successRate * 100)}%, v${a.version})`,
  ].filter(Boolean).join(" ")

  const metadata: Record<string, unknown> = {
    "arceus.id": a.id,
    "arceus.version": a.version,
    "arceus.role": a.role,
    "arceus.status": a.status,
    "arceus.trust": a.successRate.toFixed(3),
  }

  return [
    "---",
    `name: ${a.name}`,
    `description: ${jsonString(descr)}`,
    `metadata: ${JSON.stringify(metadata)}`,
    "---",
  ].join("\n")
}

async function writeResource(skillDir: string, r: SkillResource): Promise<void> {
  const target = path.join(skillDir, r.path)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, r.content, "utf8")
  if (r.kind === "script") await chmod(target, 0o755)
}
```

Call site inside the orchestrator:

```typescript
// apps/api/src/orchestrator.ts (replaces buildSkillCatalog + classifyTaskSkills for this beat)
const workDir = await prepareBeatWorkdir(beat)      // creates /tmp/arceus/beats/<id>/
await writeBeatAgent(beat, workDir)                  // .opencode/agent/<role>.md
await writeBeatPlugin(beat, workDir)                 // .opencode/plugin/arceus.ts
await writeBeatOpencodeConfig(beat, workDir)         // opencode.json (model, MCP, permissions)
const skills = await materializeBeatSkills(
  { beatId: beat.id, companyId: beat.companyId, role: beat.role, workDir, trustBand: beat.trustBand },
  { registry: getSkillRegistry() },
)

// Kick off the beat — no skill IDs in the prompt, no LLM pre-flight, no embeddings.
const result = await runOpencode({ workDir, agent: beat.role, prompt: beat.task.description })
```

---

## 3. Closing the loop: usage → EMA update

OpenCode doesn't know anything about EMAs. It just calls the built-in `skill` tool when the model picks one. We hook that tool's completion in the plugin:

```typescript
// /tmp/arceus/beats/<beatId>/.opencode/plugin/arceus.ts  (written per beat)
import type { Plugin } from "@opencode-ai/plugin"

const BEAT_ID = process.env.ARCEUS_BEAT_ID!
const COMPANY_ID = process.env.ARCEUS_COMPANY_ID!
const ARCEUS_API = process.env.ARCEUS_API_URL!
const ARCEUS_TOKEN = process.env.ARCEUS_TOKEN!

export const ArceusGovernance: Plugin = async ({ client, worktree }) => {
  const manifestPath = `${worktree}/.opencode/arceus-skills.json`
  const manifest = JSON.parse(await Bun.file(manifestPath).text())
  const slugToId = new Map<string, { id: string; version: number }>(
    manifest.skills.map((s: any) => [s.slug, { id: s.skillId, version: s.version }]),
  )

  const usedSkills = new Set<string>()     // ids pulled in during this beat

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "skill") return
      const name = (input.args as any)?.name as string | undefined
      if (!name) return
      const entry = slugToId.get(slugify(name))
      if (!entry) return
      usedSkills.add(entry.id)

      await fetch(`${ARCEUS_API}/internal/skill-usage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ARCEUS_TOKEN}` },
        body: JSON.stringify({
          beatId: BEAT_ID,
          companyId: COMPANY_ID,
          skillId: entry.id,
          skillVersion: entry.version,
          at: new Date().toISOString(),
        }),
      }).catch(() => { /* telemetry must never break the beat */ })
    },

    "session.idle": async () => {
      // Beat finished. Emit the list of skills the agent pulled so outcome
      // attribution has the full set in one place (in addition to the per-call events).
      await fetch(`${ARCEUS_API}/internal/beat/${BEAT_ID}/skills-used`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ARCEUS_TOKEN}` },
        body: JSON.stringify({ skillIds: [...usedSkills] }),
      }).catch(() => {})
    },
  }
}
```

**Server side:**

```typescript
// apps/api/src/routes/internal-skill-usage.ts
app.post("/internal/skill-usage", async (req, res) => {
  const { beatId, companyId, skillId } = parseInternalSkillUsage(req.body)
  await getSkillRegistry().recordSkillUsage(skillId, beatId)
  res.status(204).end()
})

app.post("/internal/beat/:beatId/skills-used", async (req, res) => {
  const { skillIds } = parseSkillsUsed(req.body)
  await beatStore.setSkillsUsed(req.params.beatId, skillIds)
  res.status(204).end()
})
```

Outcome attribution (unchanged from today): when a beat's parent sprint/task verdict arrives, every skill in `skillsUsed` gets `updateSuccessRate(id, outcome)`. The EMA math stays in `skillRegistry` untouched.

---

## 4. Extending `SkillArtifact` for Tier-3

OpenCode skills can ship scripts, reference docs, and assets alongside `SKILL.md`. Today's `SkillArtifact` is a single `content: string`. Small extension:

```typescript
// packages/company-runtime/src/skill-registry.ts
export interface SkillResource {
  path: string                                     // relative path under skill dir, e.g. "scripts/run-tests.sh"
  kind: "script" | "reference" | "asset"
  contentType?: string                              // e.g. "text/markdown", "application/x-sh"
  content: string                                   // inline text; binary assets base64-encoded
  encoding?: "utf8" | "base64"
}

export interface SkillArtifact {
  // ... existing fields (id, companyId, role, name, trigger, description,
  //     content, version, status, successRate, usageCount, createdAt, ...)
  resources?: SkillResource[]
}
```

DB migration: add a `resources` JSONB column to the `skill_artifacts` table. Governance pipeline gets one new rule: when `skillMutator` proposes a new version, `resources` diffs are shown to the Skills Lead alongside the body diff.

Example use case: the built-in `write-tests-first` skill ships a `scripts/setup-fixtures.sh` that the agent can `bash setup-fixtures.sh` before running the test loop. The mutator can rev that script without touching the body.

---

## 5. Governance gateway mapping

| Arceus concept                          | OpenCode knob                                       | Where it lives                                      |
|-----------------------------------------|-----------------------------------------------------|----------------------------------------------------|
| Role-based tool access (stable)         | `agent.<role>.tools` allowlist                      | `.opencode/agent/<role>.md` frontmatter            |
| Filesystem scope (can write where)      | `agent.<role>.permission.edit` / `write` globs      | per-beat `opencode.json`                           |
| Shell command allowlist                 | `permission.bash` glob rules                        | per-beat `opencode.json`                           |
| Trust-band-aware dynamic policy         | plugin `tool.execute.before` + `permission.ask`     | `.opencode/plugin/arceus.ts`                       |
| Budget / cost cap                       | plugin `chat.params` (max_tokens) + abort on limit  | plugin state, calls `/internal/beat/<id>/budget`   |
| Skill allow/deny per role               | filesystem: only write materialized skills          | `materializeBeatSkills` filters by role            |
| Audit log (every tool call)             | plugin `tool.execute.after` → POST to Arceus        | `.opencode/plugin/arceus.ts`                       |
| Sprint-level artifact emission          | MCP tool `arceus_emit_artifact`                     | `arceus-mcp` server                                |
| CEO-channel messages                    | MCP tool `arceus_post_to_ceo_chat`                  | `arceus-mcp` server                                |
| Sprint review request                   | MCP tool `arceus_request_sprint_review`             | `arceus-mcp` server                                |
| Model routing (Haiku vs Sonnet vs Opus) | `agent.<role>.model` or plugin `chat.params.model`  | per-beat `opencode.json` (static) or plugin (dyn.) |

**Rule of thumb:** static rules → JSON config. Dynamic rules that need runtime context (trust band, budget, incident mode) → plugin.

---

## 6. `arceus-mcp` — the orchestration MCP server

Ship a tiny Node stdio MCP server (`packages/arceus-mcp/`) with four tools. Every beat's `opencode.json` wires it under `mcp.arceus.command`.

```typescript
// packages/arceus-mcp/src/server.ts (sketch)
import { McpServer } from "@modelcontextprotocol/sdk/server"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio"
import { z } from "zod"

const server = new McpServer({ name: "arceus", version: "1.0.0" })

server.tool(
  "emit_artifact",
  "Emit a versioned artifact (plan, code, review, test) back to the Arceus orchestrator.",
  {
    kind: z.enum(["plan", "code", "review", "test", "output"]),
    title: z.string().min(1).max(200),
    content: z.string().min(1),
    taskId: z.string().optional(),
  },
  async (args) => { /* POST ${ARCEUS_API}/api/arceus/artifact with BEAT_ID + auth */ },
)

server.tool("post_to_ceo_chat",         /* schema */, /* handler */)
server.tool("request_sprint_review",    /* schema */, /* handler */)
server.tool("submit_review_verdict",    /* schema */, /* handler */)

await server.connect(new StdioServerTransport())
```

Per-beat `opencode.json`:

```jsonc
{
  "mcp": {
    "arceus": {
      "type": "local",
      "command": ["node", "./node_modules/@arceus/mcp/dist/server.js"],
      "enabled": true,
      "environment": {
        "ARCEUS_BEAT_ID":   "{env:ARCEUS_BEAT_ID}",
        "ARCEUS_COMPANY_ID":"{env:ARCEUS_COMPANY_ID}",
        "ARCEUS_API_URL":   "{env:ARCEUS_API_URL}",
        "ARCEUS_TOKEN":     "{env:ARCEUS_TOKEN}"
      }
    }
  },
  "agent": {
    "engineer": {
      "tools": {
        "arceus_emit_artifact":      true,
        "arceus_post_to_ceo_chat":   false,
        "arceus_request_sprint_review": false,
        "arceus_submit_review_verdict": false
      }
    },
    "ceo": {
      "tools": { "arceus_*": true }
    }
  }
}
```

Why MCP (not a plugin tool)? The four primitives are stable Arceus-level contracts. Putting them behind MCP means the same contract works when you swap OpenCode for Claude Code or Cursor without rewriting. The plugin stays focused on governance/telemetry, which *are* OpenCode-specific.

---

## 7. Per-role agent files

```markdown
<!-- .opencode/agent/engineer.md -->
---
description: Arceus engineer role. Implements one task per beat. TDD required.
mode: primary
model: anthropic/claude-sonnet-4-5
temperature: 0.2
tools:
  bash: true
  edit: true
  write: true
  read: true
  grep: true
  glob: true
  task: false
  skill: true
  webfetch: false
  websearch: false
  arceus_emit_artifact: true
permission:
  edit: { "src/**": "allow", "**/*.env*": "deny", "*": "ask" }
  bash:
    - pattern: "pnpm test*"
      action: allow
    - pattern: "pnpm install*"
      action: ask
    - pattern: "*"
      action: ask
---

You are the Arceus engineer for this beat. Work the single task given. Pull in the
relevant skill with the `skill` tool before you start coding. Emit your final
output with `arceus_emit_artifact` when the task is complete. Do not chat — use
tools.
```

Arceus generates one of these per role per beat (`ceo.md`, `cto.md`, `pm.md`, `engineer.md`, `qa.md`, `designer.md`). The `.opencode/agent/` directory mirrors the seven-role hierarchy in the current company runtime.

---

## 8. What code in Arceus goes away

| File / function (current)                                    | Replacement                                               | Savings                |
|--------------------------------------------------------------|-----------------------------------------------------------|------------------------|
| `orchestrator.ts` `buildSkillCatalog(role)`                  | `materializeBeatSkills()` + OpenCode Tier-1 injection     | 1 LLM-call/beat        |
| `orchestrator.ts` `classifyTaskSkills(...)`                  | Built-in `skill` tool; model picks at runtime             | 1 LLM-call/beat        |
| `orchestrator.ts` `buildSkillSection(...)` prompt injection  | OpenCode auto-wraps `<available_skills>`                  | ~200–800 tokens/beat   |
| `matchSkillsAsync` / `matchSkills` (embedding + fallback)    | — (not needed; model chooses from catalog)                | one embedding call     |
| `matchAndRecordSkills` dispatch wrapper                      | Plugin `tool.execute.after` on `skill`                    | simplifies call site   |
| 6× scattered `seedExistingSkills(...)` calls in `server.ts`  | one at bootstrap; materialization is per-beat             | less defensive churn   |
| Stdout parsing for structured agent output                   | `arceus_emit_artifact` MCP tool w/ Zod schema             | no regex, typed IO     |
| Hand-rolled role tool gating                                 | `agent.<role>.tools` + plugin `tool.execute.before`       | declarative            |

---

## 9. What stays

- `SkillArtifact` type + versioning + status lifecycle (`draft` → `testing` → `active` → `deprecated`)
- `skillRegistry` hot cache + DB write-through
- `successRate` EMA (lr = 0.15, clamped)
- `skillMutator`, `skillTester`, `pattern-learner` — pipeline is unchanged; it operates on artifacts, not files
- `failureAttribution` schema
- All orchestration concepts: beats, sprints, roles, company snapshots, trust bands
- The seven-role hierarchy and heartbeat engine
- All of Arceus's governance: approval flow, budget gating, incident mode

Arceus's evolution loop is completely invisible to OpenCode. Each beat's `.opencode/skills/` is just "today's active set" — OpenCode has no idea the skill was v2 last beat and is v3 this one.

---

## 10. End-to-end beat lifecycle

```
T0   sprintPlanner schedules beat B for company C, role engineer, task "Add JWT refresh".
T1   orchestrator.prepareBeatWorkdir(B)
        → /tmp/arceus/beats/<B>/
T2   writeBeatAgent / writeBeatPlugin / writeBeatOpencodeConfig
T3   materializeBeatSkills({ beatId: B, companyId: C, role: "engineer", workDir, trustBand })
        → writes 8 SKILL.md files from the 8 active engineer-role artifacts for C
T4   spawn `opencode run --agent engineer --format json` in workDir
        │
        │  OpenCode: reads .opencode/skills/**/SKILL.md, builds <available_skills>.
        │  Model plans, calls skill({name: "write-tests-first"}).
        │    → plugin.tool.execute.after → POST /internal/skill-usage
        │  Model writes failing test, runs pnpm test (permission: allow).
        │  Model edits src/auth/jwt.ts (permission: allow src/**).
        │  Model runs pnpm test again — passes.
        │  Model calls arceus_emit_artifact({ kind: "code", title: "...", content: <diff> }).
        │    → MCP server POSTs to Arceus; artifact stored in DB with beatId.
        │  session.idle fires.
        │    → plugin POSTs /internal/beat/<B>/skills-used { skillIds: ["write-tests-first", ...] }.
        │
T5   opencode exits 0 with JSON summary → orchestrator captures.
T6   Beat verdict: pass (tests green, artifact produced).
T7   updateSuccessRate("write-tests-first", 1.0) applies EMA.
        → new successRate = 0.85 * old + 0.15 * 1.0
T8   Workdir torn down (or retained for audit, configurable).

Between sprints:
  patternLearner scans last N beats → proposes mutation on a skill that's drifting down.
  skillMutator generates v+1, skillTester shadow-runs it on past beats.
  Skills Lead + governance gateway approve → applyMergedMutation writes v+1 to DB.
  Next beat that materializes this skill pulls v+1; OpenCode has no idea anything changed.
```

---

## 11. Migration sequence (safe, reversible)

**Phase A — Backbone (no behavior change):**

1. Add `SkillArtifact.resources: SkillResource[]` (schema + migration).
2. Add `skillRegistry.listActive({ companyId, role, trustBand })` method.
3. Build `packages/arceus-mcp` with the four tools; wire it but don't require any agent to use it yet.
4. Ship `.opencode/plugin/arceus.ts` template + per-beat materializer script. Commit, but do *not* flip the dispatch path.

**Phase B — Shadow mode (new path runs, old path still authoritative):**

5. For a fraction of beats, write the `.opencode/skills/` tree in parallel with the current prompt injection. Diff what the model *would* pull vs. what `classifyTaskSkills` picked. Log divergence.
6. Wire `tool.execute.after` telemetry even in shadow mode — validates the HTTP round-trip.

**Phase C — Flip:**

7. Replace `classifyTaskSkills` + `buildSkillSection` call sites with `materializeBeatSkills`. Delete the embedding/token matcher.
8. Flip artifact capture from stdout parsing to `arceus_emit_artifact`.
9. Move role tool gating from hand-rolled checks to `agent.<role>.tools` + plugin `tool.execute.before`.

**Phase D — Cleanup:**

10. Delete the 6 defensive `seedExistingSkills` calls; leave one at bootstrap.
11. Remove dead helpers from `orchestrator.ts`.
12. Archive old code paths behind a feature flag for one release, then delete.

Rollback at any phase = revert the feature flag. Nothing about the `SkillArtifact` schema change is destructive.

---

## 12. Concrete first milestone (one-week target)

Build the minimum vertical slice that proves the whole loop without deleting anything:

1. `materializeBeatSkills` (no resources yet — skip Tier-3).
2. A per-beat `.opencode/plugin/arceus.ts` with *only* `tool.execute.after` hitting `/internal/skill-usage`.
3. One engineer-role `.opencode/agent/engineer.md`.
4. `arceus-mcp` with just `emit_artifact`.
5. A feature-flagged orchestrator path that, for one beat per sprint, runs the new loop while the old loop runs for the others.

If telemetry arrives, artifacts land in the DB, and `successRate` moves after outcome attribution — the architecture is validated end-to-end. Everything in §§ 8–11 is incremental from there.

---

## 13. Flagged / unconfirmed

- `[unconfirmed]` Exact path of OpenCode's Tier-1 XML wrapper (`<available_skills>`) may differ by version. Verified against `packages/opencode/src/tool/skill.ts` on the `dev` branch as of this compilation; pin the OpenCode version in `package.json`.
- `[unconfirmed]` `session.idle` fires exactly once per beat in headless `opencode run` (not streamed). If not, move the `skills-used` POST to a `--post-run` shell hook in the beat workdir.
- `[unconfirmed]` Whether OpenCode re-reads `.opencode/skills/` mid-session. If it caches at startup (expected), our "current active set" guarantee holds without further work.
- MCP stdio servers inherit env from the OpenCode parent by default; the explicit `environment` block in `opencode.json` is belt-and-braces.

---

## 14. What this unlocks

- **No per-beat LLM pre-flight cost** for skill selection.
- **Real progressive disclosure.** The agent loads only the bodies it actually needs, mid-task, instead of being front-loaded with everything.
- **Per-company isolation for free.** Filesystem is the tenant boundary; OpenCode never sees `companyId`.
- **Versioned, auditable evolution** — `SkillArtifact` keeps full history and governance, but the agent only ever sees today's approved set.
- **Reusable MCP contract.** `arceus-mcp` works with Claude Code, Cursor, and any future harness with zero changes.
- **Typed, schema-validated artifact emission.** No more parsing stdout for JSON blocks.
- **Declarative governance** for the static 80%, dynamic plugin for the trust-band-aware 20%.

Arceus keeps its IP (lifecycle + governance + evolution). OpenCode gets what it's great at (tool execution + skill loading + plugin hooks + MCP). The integration surface is narrow, well-typed, and reversible.
