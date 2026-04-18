# 03 — Tools and MCP

*Built-in tools, custom tools via `@opencode-ai/plugin`, and wiring MCP servers (local and remote).*

---

## 3.1 Built-in tools

Confirmed from `packages/opencode/src/tool/` on the `dev` branch. The 12 active built-ins:

| Tool | Source | What it does |
|---|---|---|
| `bash` | `bash.ts` | Execute shell commands |
| `edit` | `edit.ts` | Exact-string replacement in an existing file |
| `write` | (via edit perms) | Create / overwrite a file |
| `read` | `read.ts` | Read file contents (line-range supported) |
| `grep` | `grep.ts` | ripgrep-backed regex search |
| `glob` | `glob.ts` | Glob file discovery, sorted by mtime |
| `multiedit` | `multiedit.ts` | Batch edits to a single file in one call |
| `apply_patch` | `apply_patch.ts` | Apply a unified-patch string (paths relative to project root) |
| `webfetch` | `webfetch.ts` | Retrieve a URL |
| `websearch` | `mcp-exa.ts` | Exa-powered search — **gated on `OPENCODE_ENABLE_EXA=1`** |
| `task` | `task.ts` | Spawn a subagent session |
| `todowrite` / `todoread` | `todo.ts` | Manage the session todo list |
| `skill` | `skill.ts` | Load a `SKILL.md` into context (see [`04-skills.md`](./04-skills.md)) |
| `question` | `question.ts` | Ask the user a structured question |
| `lsp` (experimental) | `lsp.ts` | `goToDefinition`, `findReferences`, `hover`, symbol ops, call hierarchy |
| `codesearch` | `codesearch.ts` | *[unconfirmed — present in source, absent from public docs]* |

### Key argument shapes (verbatim from source)

**`bash`** — `packages/opencode/src/tool/bash.ts`:

```typescript
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
  ?? 2 * 60 * 1000                 // 120s default
const Parameters = z.object({
  command:     z.string().describe("The command to execute"),
  timeout:     z.number().optional().describe("Optional timeout in ms"),
  workdir:     z.string().optional()
                 .describe("The working directory... Use this instead of 'cd' commands."),
  description: z.string().describe("Clear, concise description in 5-10 words."),
})
const MAX_METADATA_LENGTH = 30_000
```

Notes:
- 120s default timeout. Claude Code's equivalent has a 600s cap.
- Bash commands are parsed through **tree-sitter** to classify them (`FILES`, `CWD`, `PS` sets) for permission-pattern matching. This is what makes `"git push": "deny"` work at command level.
- Output truncated at ~30 KB of metadata.
- Output is streamed through `effect/Stream` — imports suggest partial stdout reaches the model mid-run, but I did not trace the full call path.

**`task`** — `packages/opencode/src/tool/task.ts`:

```typescript
const parameters = z.object({
  description:    z.string().describe("A short (3-5 words) description"),
  prompt:         z.string().describe("The task for the agent to perform"),
  subagent_type:  z.string().describe("The type of specialized agent to use"),
  task_id:        z.string().optional(),   // resume a prior subagent session
  command:        z.string().optional(),
})
```

The task tool asks permission as `{ permission: "task", patterns: [subagent_type] }` — which is how `agent.<role>.permission.task` gates subagent invocations. It also propagates `todowrite: deny` into the child session by default.

### Differences from Claude Code tools

- **Custom tools can shadow built-ins by name** — "Custom tools override built-in tools with identical names" ([opencode.ai/docs/custom-tools/](https://opencode.ai/docs/custom-tools/)). No Claude Code equivalent.
- Tool names are lowercase (`task`, `glob`), not PascalCase.
- Bash permissions use glob patterns against the tree-sitter-parsed command, not string-prefix matching.
- `websearch` requires opt-in env var.
- `skill` is a first-class primitive — skills are pulled by the agent, not pre-injected.
- `lsp` directly exposes LSP ops to the model.

## 3.2 Custom tools

Canonical source of truth from `packages/plugin/src/tool.ts` (full file, 41 lines):

```typescript
import { z } from "zod"
import { Effect } from "effect"

export type ToolContext = {
  sessionID:   string
  messageID:   string
  agent:       string
  directory:   string                          // session project dir
  worktree:    string                          // worktree root — use for stable paths
  abort:       AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
  ask(input: AskInput): Effect.Effect<void>
}

type AskInput = {
  permission: string
  patterns:   string[]
  always:     string[]
  metadata:   Record<string, unknown>
}

export type ToolResult = string | {
  output:    string
  metadata?: Record<string, unknown>
}

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args:        Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z                                // `tool.schema.string()` is literally Zod

export type ToolDefinition = ReturnType<typeof tool>
```

### Canonical example (`packages/plugin/src/example.ts`)

```typescript
import { Plugin } from "./index.js"
import { tool } from "./tool.js"

export const ExamplePlugin: Plugin = async (_ctx) => ({
  tool: {
    mytool: tool({
      description: "This is a custom tool",
      args: { foo: tool.schema.string().describe("foo") },
      async execute(args) { return `Hello ${args.foo}!` },
    }),
  },
})
```

### File layout

Two separate locations, each with different semantics:

- **Standalone custom tools** (auto-registered, no plugin wrapper needed):
  - Project: `.opencode/tool/*.ts`
  - Global:  `~/.config/opencode/tool/*.ts`
  - Filename → tool name. Multiple named exports → `<filename>_<exportname>`.
- **Plugin-registered tools** (registered via the `tool:` key in the plugin's `Hooks` return):
  - Project: `.opencode/plugin/*.ts`
  - Global:  `~/.config/opencode/plugin/*.ts`
  - NPM:     top-level `"plugin": [...]` array in `opencode.json`.

Dependencies: `.opencode/package.json`.

### Arceus-shaped example: HTTP backend tool

```typescript
// .opencode/tool/emit_artifact.ts
import { tool } from "@opencode-ai/plugin"
const z = tool.schema

export default tool({
  description:
    "Emit a sprint artifact to Arceus. Call this once the beat produces a " +
    "reviewable document (PRD, design doc, sprint plan).",
  args: {
    beat_id:    z.string().describe("Active beat id, e.g. 'sprint-5.ceo-proposal'"),
    kind:       z.enum(["prd", "design", "plan", "review"]),
    title:      z.string(),
    body_md:    z.string().describe("Markdown body of the artifact"),
    trust_note: z.string().optional(),
  },
  async execute(args, ctx) {
    const res = await fetch(`${process.env.ARCEUS_API}/artifacts`, {
      method: "POST",
      headers: {
        "content-type":       "application/json",
        "x-arceus-token":     process.env.ARCEUS_TOKEN ?? "",
        "x-opencode-session": ctx.sessionID,
        "x-opencode-agent":   ctx.agent,
      },
      body: JSON.stringify({ ...args, worktree: ctx.worktree }),
      signal: ctx.abort,                       // OpenCode cancels on session abort
    })
    if (!res.ok) {
      throw new Error(`emit_artifact failed: ${res.status} ${await res.text()}`)
    }
    const data = await res.json() as { artifact_id: string; url: string }
    return {
      output:   `artifact ${data.artifact_id} emitted (${args.kind}: ${args.title})`,
      metadata: { artifact_id: data.artifact_id, url: data.url, kind: args.kind },
    }
  },
})
```

Auto-registers as `emit_artifact`. The `description` and `args` Zod shape are what the model sees.

### Dynamic tools from a plugin

If the tool set depends on per-beat context, register from a plugin instead of the filesystem:

```typescript
// .opencode/plugin/arceus-dynamic-tools.ts
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const ArceusDynamicTools: Plugin = async (ctx) => {
  const beatId   = process.env.ARCEUS_BEAT_ID ?? ""
  const manifest = await fetch(`${process.env.ARCEUS_API}/internal/beat/${beatId}/tools`)
    .then(r => r.json() as Promise<{ tools: string[] }>)

  const tools: Record<string, ReturnType<typeof tool>> = {}
  for (const name of manifest.tools) {
    tools[name] = tool({
      description: `Arceus tool: ${name}`,
      args: { input: tool.schema.record(tool.schema.any()) },
      execute: async (args) => {
        const r = await fetch(`${process.env.ARCEUS_API}/tools/${name}`, {
          method: "POST", body: JSON.stringify(args.input),
        })
        return await r.text()
      },
    })
  }

  return { tool: tools }
}
```

This is how Arceus delivers **per-beat tool surface** without materializing files per beat.

### Scoping summary

- **Global** — every project
- **Project** — committed in repo
- **Per-session / ephemeral** — no documented path. Achieve via plugin dynamic registration (preferred) or beat-entry filesystem materialization + cleanup.

## 3.3 MCP servers

OpenCode is an MCP client. Config schema from [opencode.ai/docs/mcp-servers/](https://opencode.ai/docs/mcp-servers/):

### Local (stdio)

```jsonc
{
  "mcp": {
    "arceus": {
      "type":        "local",
      "command":     ["node", "/srv/arceus-mcp/dist/index.js"],
      "enabled":     true,
      "environment": { "ARCEUS_TOKEN": "{env:ARCEUS_TOKEN}" },
      "timeout":     5000
    }
  }
}
```

### Remote (SSE / streamable HTTP)

```jsonc
{
  "mcp": {
    "context7": {
      "type":    "remote",
      "url":     "https://mcp.context7.com/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:CONTEXT7_API_KEY}" },
      "timeout": 5000
    },
    "sentry": {
      "type":    "remote",
      "url":     "https://mcp.sentry.dev/mcp",
      "oauth":   {},
      "enabled": true
    }
  }
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `type` | `"local" \| "remote"` | required |
| `command` | `string[]` | local only — argv form (first elem is exec) |
| `url` | string | remote only |
| `enabled` | boolean | defaults true |
| `environment` | object | local only — extra env vars |
| `headers` | object | remote only — extra HTTP headers |
| `oauth` | object | remote only — OAuth config (opaque) |
| `timeout` | number | default `5000` ms |

### Tool naming & scoping

The docs use `"mymcp_*"` (underscore separator) in scoping examples:

```jsonc
{
  "mcp":   { "my-mcp": { "type": "local", "command": ["bun","x","my-mcp-command"], "enabled": true } },
  "tools": { "my-mcp*": false },
  "agent": { "my-agent": { "tools": { "my-mcp*": true } } }
}
```

**Exposed names follow `<server-name><sep><tool-name>` with glob matching against the prefix.** The separator character is not printed bare in the docs I pulled — `mymcp_*` appears in the docs example. *[unconfirmed: `_` vs `-` vs `.`. Safe assumption for Arceus: treat the server name as a glob prefix and match `<server>*`.]*

This differs from Claude Code's `mcp__<server>__<tool>` convention.

### Per-agent MCP scoping

Globally deny, per-agent re-allow — matches Arceus's role-per-beat model perfectly:

```jsonc
{
  "tools": { "arceus*": false, "context7*": false },
  "agent": {
    "ceo":      { "tools": { "arceus*": true } },
    "engineer": { "tools": { "arceus*": true, "context7*": true } },
    "reviewer": { "tools": { "arceus*": true } }
  }
}
```

### Ecosystem examples called out by docs

- **Sentry** — `https://mcp.sentry.dev/mcp` (OAuth)
- **Context7** — `https://mcp.context7.com/mcp` (docs search)
- **Grep by Vercel** — `https://mcp.grep.app` (code snippet search)

Any standard stdio/SSE/HTTP MCP server that works with Claude Code also works here (filesystem, playwright, browser, Postgres, GitHub…).

## 3.4 Custom commands

*(Bonus — covered here for completeness; less important than tools/MCP for headless Arceus beats.)*

[opencode.ai/docs/commands/](https://opencode.ai/docs/commands/) — user-triggered slash commands, stored as markdown:

```
.opencode/commands/test.md
```

```markdown
---
description: Run tests with coverage
agent: build
subtask: true
model: anthropic/claude-3-5-sonnet-20241022
---
Run the full test suite for $ARGUMENTS.
Test results follow:
!`npm test -- --coverage $1`

Relevant source: @src/**/*.ts
```

Placeholders:
- `$ARGUMENTS` — whole argument string
- `$1`, `$2`, `$3` — positional
- `` !`cmd` `` — inline shell output injection
- `@path/to/file` — file content inlined

Commands can override built-ins (`/init`, `/undo`, `/redo`, `/share`, `/help`).

**For Arceus:** these are mostly for human operators of the shared repo (e.g. `/retro`, `/propose-sprint`). Beats run `opencode run` without typing `/`.

## 3.5 When to use tool vs MCP vs skill

| Need | Mechanism |
|---|---|
| Stable external contract reusable across agent harnesses | **MCP server** (`arceus-mcp`) |
| Per-beat dynamic tool surface based on role + trust | **Plugin-registered tool** |
| Fixed project-level tool committed to git | **Standalone custom tool** (`.opencode/tool/`) |
| Procedural knowledge the agent should pull on demand | **Skill** (see [`04-skills.md`](./04-skills.md)) |
| Human-invoked macro in the TUI | **Custom command** |

**Arceus recommendation:** the stable orchestration primitives (`emit_artifact`, `post_to_ceo_chat`, `request_sprint_review`, `read_org_chart`) go in an MCP server. Beat-scoped dynamic tools (tools that depend on the active role/beat context) are registered from the governance plugin. No standalone custom tools in Arceus — everything is either MCP (stable) or plugin-registered (dynamic).

## Sources

- [opencode.ai/docs/tools/](https://opencode.ai/docs/tools/) — full built-in tool list
- [opencode.ai/docs/custom-tools/](https://opencode.ai/docs/custom-tools/) — `.opencode/tool/`, filename→name, `tool.schema`
- [opencode.ai/docs/mcp-servers/](https://opencode.ai/docs/mcp-servers/) — mcp block schema, Sentry/Context7/Grep examples
- [opencode.ai/docs/commands/](https://opencode.ai/docs/commands/)
- `packages/plugin/src/tool.ts` — `tool()` signature, `ToolContext`, `ToolResult`
- `packages/plugin/src/example.ts` — minimal plugin + tool
- `packages/opencode/src/tool/bash.ts` — DEFAULT_TIMEOUT=120s, MAX_METADATA_LENGTH=30000
- `packages/opencode/src/tool/task.ts` — subagent permission/invocation semantics

## Flagged uncertainties

- Exact separator in MCP tool names (`_` vs `-` vs `.`) — docs show glob `mymcp_*` but don't print a bare tool name.
- Whether `bash` streams partial stdout to the model mid-execution (imports suggest yes, full call path not traced).
- `codesearch` tool semantics (present in source, absent from public tools doc).
- Whether plugins can register new `/slash` commands (only `command.execute.before` interception is documented).
