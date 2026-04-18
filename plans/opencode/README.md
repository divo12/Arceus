# OpenCode × Arceus

> Research digest + integration blueprint for using **OpenCode** (https://opencode.ai, github.com/sst/opencode) as the per-beat coding agent runtime inside Arceus.

*Compiled 2026-04-19. Sources: opencode.ai/docs, github.com/sst/opencode (dev branch, `packages/plugin/src/` and `packages/opencode/src/tool/`), agentskills.io/specification, github.com/anthropics/skills, github.com/nanobot-ai/nanobot. Flagged `[unconfirmed]` items listed at the end of each doc.*

---

## Why OpenCode?

OpenCode is SST's open-source, terminal-first AI coding agent. The qualities that matter for Arceus:

- **Provider-agnostic** — Anthropic, OpenAI, Google, Groq, Bedrock, Ollama, any OpenAI-compatible endpoint. We stay in control of model routing.
- **Client/server split** — a headless HTTP server (`opencode serve`) with an OpenAPI 3.1 contract, plus a TUI client. Arceus can spawn ephemeral servers per beat or attach many beats to one warm server.
- **Declarative config** — `opencode.json` covers model, agents, tools, permissions, MCP servers, plugins, instructions, hooks. Everything Arceus needs to say "for this beat, act as this role, with these tools, under these rules" is expressible without touching Claude Code–specific CLI flags.
- **First-class plugin API** — `@opencode-ai/plugin` exposes a rich `Hooks` interface covering session lifecycle, tool execution (before/after/definition rewrites), permission prompts, chat params, shell env, custom auth + provider hooks. This is the governance interception point Arceus needs.
- **Agent Skills built in** — OpenCode implements the Agent Skills open spec (agentskills.io) natively: filesystem discovery, three-tier progressive disclosure, a built-in `skill` tool. This replaces Arceus's current embedding-based `matchSkillsAsync` pre-flight.
- **MCP client** — wire in any stdio or SSE/HTTP MCP server through the `mcp` config block. Arceus orchestration API can live behind an MCP server and be reused across Cursor / Claude Code / OpenCode clients.

## What this folder contains

| File | Covers |
|---|---|
| [`01-architecture-and-config.md`](./01-architecture-and-config.md) | Client/server model, headless `opencode run`, full `opencode.json` surface, config precedence, per-beat env var strategy |
| [`02-hooks-and-plugins.md`](./02-hooks-and-plugins.md) | Full `Hooks` interface, event catalogue, `tool.execute.before/after`, `permission.ask`, `chat.params`, plugin authoring, Arceus telemetry plugin sketch |
| [`03-tools-and-mcp.md`](./03-tools-and-mcp.md) | Built-in tools (bash, edit, task, lsp, skill…), custom tools via `tool()` helper, MCP server config schema (local/remote), per-agent tool scoping |
| [`04-skills.md`](./04-skills.md) | Skills discovery paths, frontmatter schema, progressive disclosure, `skill` built-in tool, per-agent scoping, authoring conventions, tier-3 `scripts/references/assets` |
| [`05-arceus-integration.md`](./05-arceus-integration.md) | End-to-end blueprint: how `SkillArtifact` lifecycle materializes per-beat SKILL.md, governance mapping onto `agent.*.permission`, MCP-server vs plugin split, concrete first milestone |

## The big picture

```
Arceus Control Plane (Node)                          Per-beat OpenCode process
┌────────────────────────────────┐                   ┌──────────────────────────┐
│  SkillArtifact (DB, versioned) │                   │  opencode run --agent <r>│
│  governance / mutator / tester │                   │  --format json           │
│  skill-registry hot cache      │                   │                          │
│          │                     │  materialize      │  Tier-1 catalog injected │
│          └──► /tmp/beats/<id>/ │──────────────────►│  (name + description)    │
│              .opencode/        │                   │                          │
│              ├── opencode.json │                   │  Agent plans → calls     │
│              ├── AGENTS.md     │                   │  skill({name}) → Tier-2  │
│              ├── skills/*/     │                   │  body loaded             │
│              ├── agent/<role>  │                   │                          │
│              ├── plugin/       │                   │  Tool calls run through  │
│              │   arceus.ts    ◄────────────────────┤  plugin.tool.execute.* │
│              └── tool/        ◄────────────────────┤  Optional MCP tools     │
│                               │                    │                          │
│  /internal/skill-usage◄───────┤ POST from plugin   │                          │
│  recordUsage + EMA update     │                    │                          │
└────────────────────────────────┘                   └──────────────────────────┘
           ▲
           │  between beats: SkillHealthReport → skillMutator → skillTester
           │                 → new SkillArtifact version (active)
           └──────────────────────────────────────────────────────────────────
```

## Recommended repo layout

```
<arceus-repo>/
├── opencode.json                     # global defaults (committed)
├── AGENTS.md                         # shared rules for all roles (committed)
├── .opencode/
│   ├── plugin/
│   │   └── arceus-governance.ts      # Arceus plugin: tool.before/after, chat.params
│   ├── tool/                         # static custom tools (rare — prefer MCP)
│   ├── commands/                     # human-triggered /slash macros
│   ├── agent/                        # per-role agent markdown (ceo.md, engineer.md, …)
│   └── package.json                  # pins @opencode-ai/plugin, arceus-mcp client
└── (runtime only)
    /tmp/arceus/beats/<beatId>/
    └── .opencode/
        ├── opencode.json             # beat-scoped overrides (generated)
        ├── skills/<slug>/SKILL.md    # materialized from SkillArtifact
        └── hooks/post-tool-use.sh    # usage telemetry hook
```

## What replaces what

| Current Arceus component | Replacement after OpenCode integration |
|---|---|
| `buildSkillCatalog` + `classifyTaskSkills` LLM pre-flight | OpenCode's built-in `<available_skills>` catalog injection (free, no extra LLM call) |
| `matchSkillsAsync` embedding cosine matcher | Filesystem materialization + model-driven pull via `skill` tool |
| Stdout-parsing for structured agent output | Custom tools / MCP tools with typed Zod schemas |
| Role-based tool gating via hand-rolled checks | `agent.<role>.permission` + plugin `tool.execute.before` for dynamic policy |
| `recordSkillUsage` wired at dispatch | `postToolUse` hook on `skill` tool calls → POST `/internal/skill-usage` |

## What stays

- `SkillArtifact` type, versioning, status lifecycle, `successRate` EMA
- `skillMutator`, `skillTester`, `pattern-learner` (governance half — OpenCode has no equivalent)
- `failureAttribution` schema for beat-outcome → skill attribution
- All Arceus-specific orchestration concepts (beats, sprints, roles, company snapshots)

## Next steps

1. **Read** the five companion docs in order. They are written to be read end-to-end but each stands alone.
2. **Prototype the plugin first.** A minimal `.opencode/plugin/arceus-governance.ts` with just `tool.execute.before` + `tool.execute.after` emitting audit events gets you the governance spine with zero changes to OpenCode itself.
3. **Ship an MCP server** (`arceus-mcp`) for the 3–5 stable orchestration primitives (`emit_artifact`, `post_to_ceo_chat`, `request_sprint_review`). This is the external contract and is reusable across agent harnesses.
4. **Flip the skill loader.** Add `materializeBeatSkills` (see `05-arceus-integration.md`), write SKILL.md files per beat, delete `classifyTaskSkills`.
5. **Hook usage telemetry** via the plugin's `tool.execute.after` on `skill` calls → back-channel POST to Arceus.

See [`05-arceus-integration.md`](./05-arceus-integration.md) for the full migration sequence.
