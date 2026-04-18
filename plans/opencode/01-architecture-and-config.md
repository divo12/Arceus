# 01 — OpenCode Architecture and Configuration

*How OpenCode is structured and how to drive it programmatically from Arceus.*

---

## 1.1 Architecture: client/server split

OpenCode ships as a single binary that embeds both a **TUI** and an **HTTP server** ([opencode.ai/docs/server/](https://opencode.ai/docs/server/)).

```
┌───────────────────────┐    HTTP / SSE    ┌──────────────────────────┐
│  TUI (Go)             │  ◄────────────►  │  opencode server         │
│  or opencode run CLI  │                  │  (TypeScript / Bun)       │
│  or @opencode-ai/sdk  │                  │  - sessions               │
└───────────────────────┘                  │  - model calls            │
                                           │  - tools + plugins        │
                                           │  - permissions            │
                                           │  - event bus              │
                                           └──────────────────────────┘
```

- **The TUI is just one client.** The server exposes an OpenAPI 3.1 contract at `/doc` that any client can drive.
- Multiple clients can attach to the same server concurrently. For Arceus, two viable shapes:
  - **One warm server, many beats** — `opencode serve --port 4096` once, then each beat `--fork`s its own session. Good for throughput; one failure domain.
  - **One server per beat** — spawn ephemeral server, do the work, tear it down. Good for isolation; more process overhead.

## 1.2 Headless execution — `opencode run`

[opencode.ai/docs/cli/](https://opencode.ai/docs/cli/) confirms:

```bash
opencode run "<prompt>" [flags]
```

Important flags for an orchestrator:

| Flag | Purpose |
|---|---|
| `--model, -m <provider/model>` | e.g. `anthropic/claude-sonnet-4-5` |
| `--agent <name>` | select a configured primary agent |
| `--continue, -c` | resume last session |
| `--session, -s <id>` | resume specific session |
| `--fork` | branch from an existing session (parallel beats!) |
| `--file, -f <path>` | attach files to the message (repeatable) |
| `--title <str>` | session title |
| `--share` | publish the session |
| `--format <default\|json>` | **`json` emits a raw event stream on stdout** — this is the one Arceus wants |
| `--attach <url>` | attach to a running `opencode serve` instance |
| `--port <n>` | port if spawning an ephemeral server |

**Canonical Arceus invocation:**

```bash
OPENCODE_CONFIG=/tmp/arceus/beats/$BEAT_ID/.opencode/opencode.json \
OPENCODE_DISABLE_AUTOUPDATE=1 \
opencode run --agent $ROLE --format json "<beat prompt>" \
  > /tmp/arceus/beats/$BEAT_ID/events.ndjson
```

Exit codes follow UNIX convention (0 success, non-zero failure).

## 1.3 SDK path (for long-lived orchestration)

From [opencode.ai/docs/sdk/](https://opencode.ai/docs/sdk/):

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })
const session = await client.session.create({ title: "beat-14" })
await client.session.prompt({ sessionID: session.id, text: "...", agent: "build" })

const events = await client.event.subscribe()
for await (const ev of events.stream) {
  // route into Arceus event bus
}
```

This is the production path if you want:
- streaming events over SSE without stdout parsing,
- session `--fork` per beat from a warm server,
- mid-session prompt appends.

## 1.4 Model provider abstraction

Providers are configured under a single `provider` block keyed by provider ID. Known providers (from [opencode.ai/docs/config/](https://opencode.ai/docs/config/)): `anthropic`, `openai`, `google`, `groq`, `openrouter`, `bedrock`, `ollama`, `openai-compatible`.

Auth is stored at `~/.local/share/opencode/auth.json` via `opencode auth login`.

Models are referenced everywhere as `"<provider>/<model>"`:

```jsonc
{
  "model":       "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",
  "provider": {
    "anthropic": { "timeout": 300000, "chunkTimeout": 30000 },
    "openai":    { "timeout": 180000 }
  },
  "enabled_providers":  ["anthropic", "openai"],
  "disabled_providers": ["ollama"]      // wins over enabled_providers
}
```

## 1.5 Full `opencode.json` surface

[opencode.ai/docs/config/](https://opencode.ai/docs/config/) lists the top-level keys. For Arceus, the orchestrator-relevant ones:

| Key | Type | Purpose |
|---|---|---|
| `$schema` | string | `"https://opencode.ai/config.json"` — enables IDE validation |
| `model` | string | Primary model |
| `small_model` | string | Cheap model for titles/compaction |
| `provider` | object | Per-provider options (timeout, chunkTimeout, setCacheKey) |
| `enabled_providers` | string[] | Allowlist |
| `disabled_providers` | string[] | Blocklist (wins over allowlist) |
| `agent` | object | Named primary/subagent configs (see §1.6) |
| `default_agent` | string | Fallback; must be primary |
| `command` | object | Reusable templated slash commands |
| `tools` | object | `{ "<tool>": boolean }` global enable/disable |
| `permission` | object | `allow` / `ask` / `deny` with glob patterns (see §1.7) |
| `mcp` | object | MCP server configs (see `03-tools-and-mcp.md`) |
| `plugin` | string[] | npm package names or local module paths |
| `instructions` | string[] | File paths / globs / URLs appended to system prompt |
| `server` | object | `port`, `hostname`, `mdns`, `mdnsDomain`, `cors` |
| `formatter` | object | Custom per-extension formatters |
| `snapshot` | boolean | File-change snapshots for undo (default `true`) |
| `autoupdate` | boolean \| `"notify"` | Update policy (default `true`) |
| `compaction` | object | `auto`, `prune`, `reserved` token buffer |
| `watcher` | object | `{ "ignore": string[] }` glob list |
| `share` | string | `"manual"` (default) \| `"auto"` \| `"disabled"` |
| `experimental` | object | Unstable flags — do not rely on in Arceus |

TUI-only settings (`theme`, `keybinds`, `tui.*`) live in a separate `tui.json` and can be ignored for Arceus orchestration.

### Variable substitution

Values support `{env:VAR}` and `{file:path}`. Arceus can keep a stable baseline config and inject per-beat settings via env:

```jsonc
{
  "instructions": ["AGENTS.md", "{env:ARCEUS_BEAT_BRIEF}"],
  "model": "{env:ARCEUS_MODEL}"
}
```

### Config precedence (lowest → highest)

From [opencode.ai/docs/config/](https://opencode.ai/docs/config/):

1. Remote config at `.well-known/opencode`
2. Global: `~/.config/opencode/opencode.json`
3. `OPENCODE_CONFIG` env var (custom path)
4. Project: `./opencode.json` or `./opencode.jsonc`
5. `.opencode/` directory contents
6. `OPENCODE_CONFIG_CONTENT` env var (inline JSON)
7. Managed config files
8. macOS managed preferences (highest)

**Arceus strategy:** commit a baseline `opencode.json` + `.opencode/` at the repo root; use `OPENCODE_CONFIG_CONTENT='{"permission":…}'` or write per-beat `opencode.json` to layer role-specific overrides.

## 1.6 Agents — where roles live

Two definition surfaces ([opencode.ai/docs/agents/](https://opencode.ai/docs/agents/)):

### JSON (in `opencode.json`)

```jsonc
{
  "agent": {
    "ceo": {
      "mode":        "primary",
      "model":       "anthropic/claude-sonnet-4-5",
      "temperature": 0.3,
      "description": "Arceus CEO — strategy, delegation, sprint reviews",
      "tools":       { "arceus_emit_artifact": true, "bash": false, "edit": false },
      "permission":  { "skill": { "ceo-*": "allow", "*": "deny" } }
    },
    "engineer": {
      "mode":        "primary",
      "model":       "anthropic/claude-sonnet-4-5",
      "temperature": 0.2,
      "tools":       { "edit": true, "bash": true },
      "permission":  { "edit": "allow", "bash": { "rm *": "deny", "*": "allow" } }
    },
    "reviewer": {
      "mode":        "subagent",
      "description": "Reviews code for security + correctness",
      "model":       "anthropic/claude-haiku-4-5",
      "tools":       { "read": true, "grep": true, "edit": false, "bash": false }
    }
  },
  "default_agent": "engineer"
}
```

### Markdown (in `.opencode/agent/<name>.md`)

```markdown
---
description: Reviews code for best practices
mode: primary | subagent | all
model: anthropic/claude-sonnet-4-5
temperature: 0.1
tools:
  write: false
  edit: false
  bash: false
permission:
  edit: deny
  bash:
    "git *": ask
  skill:
    "review-*": allow
---
You are an expert code reviewer. Focus on correctness and security.
```

Filename becomes the agent ID. Markdown body becomes the agent's system prompt.

### Primary vs subagent vs `all`

- **Primary** — selectable by user (`--agent`) or by Arceus. Appears in TUI Tab cycle.
- **Subagent** — invoked only by a primary via the `task` tool or `@<name>` mention.
- **`mode: all`** — both directly selectable *and* callable as a subagent.

`default_agent` in config must be a primary.

### Per-agent scoping

Each agent carries its own `model`, `temperature`, `prompt`, `tools`, `permission`. This is how Arceus maps roles → OpenCode agents 1:1.

## 1.7 Permissions

[opencode.ai/docs/permissions/](https://opencode.ai/docs/permissions/) — each rule resolves to:

- `"allow"` — run silently
- `"ask"` — prompt user (blocks in headless mode — avoid in Arceus)
- `"deny"` — hard block

### Permission categories

`read`, `edit` (covers write/edit/multiedit/apply_patch), `bash`, `webfetch`, `websearch`, `external_directory`, `task` (subagent spawning), `skill` (skill tool), `doom_loop` (repeated identical tool calls). Wildcard `*` = fallback.

Defaults:
- Most categories default permissive
- `.env` files deny by default
- `external_directory` defaults to `"ask"`

### Pattern rules

Values can be maps keyed by glob-like patterns; **last matching rule wins**:

```jsonc
{
  "permission": {
    "*": "allow",
    "bash": {
      "rm *":   "deny",
      "git push *": "deny",
      "git *":  "allow",
      "*":      "ask"
    },
    "edit": "allow"
  }
}
```

### Fully non-interactive Arceus setup

To guarantee no prompts ever block:

```jsonc
{
  "permission": {
    "*":                  "allow",
    "bash":               "allow",
    "edit":               "allow",
    "webfetch":           "allow",
    "websearch":          "allow",
    "external_directory": "allow",
    "task":               "allow",
    "skill":              "allow"
  }
}
```

Pair with `--format json`. **Never set `"ask"`** in a headless Arceus config, or handle it via the `permission.ask` plugin hook (see [`02-hooks-and-plugins.md`](./02-hooks-and-plugins.md)) to programmatically answer. *[unconfirmed whether `"ask"` auto-denies or hangs in `opencode run` — doc doesn't state explicitly; treat as hangs.]*

### Tool disable vs permission deny

- `tools: { "<name>": false }` — **removes the tool from the toolset entirely**. Model never sees it.
- `permission.<name>: "deny"` — tool visible but invocation blocked at runtime.

Use `tools: false` for hard role boundaries (e.g. CEO never sees `bash`). Use `permission: deny` with patterns for fine-grained command-level gating.

## 1.8 Instructions and rules

OpenCode assembles the system prompt from multiple sources ([opencode.ai/docs/rules/](https://opencode.ai/docs/rules/)):

1. Walks up from cwd collecting the first `AGENTS.md` (or `CLAUDE.md` fallback) found.
2. Global `~/.config/opencode/AGENTS.md`.
3. Claude Code fallback `~/.claude/CLAUDE.md` if no OpenCode file exists. Disable with `OPENCODE_DISABLE_CLAUDE_CODE=1`.
4. Every entry in `instructions: [...]` (local paths, globs, or URLs) is appended.
5. The active agent's `prompt` field or markdown body.

All of these combine. An Arceus beat can drop `.arceus/beat-brief.md` into the working dir and reference it via `"instructions": [".arceus/beat-brief.md"]` to merge it in without touching `AGENTS.md`.

## 1.9 Modes are folded into agents

[opencode.ai/docs/modes/](https://opencode.ai/docs/modes/): *"Modes are now configured through the `agent` option in the opencode config. The `mode` option is now deprecated."*

Two built-ins remain:
- **build** (default, all tools)
- **plan** (no write/edit/patch/bash; for analysis)

Legacy `.opencode/modes/*.md` files still load but new work should use `agent.*` entries. Arceus: always use agents, never modes.

## 1.10 Canonical Arceus per-beat `opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model":       "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",
  "default_agent": "{env:ARCEUS_ROLE}",
  "permission": {
    "*":                  "allow",
    "edit":               "allow",
    "bash":               "allow",
    "external_directory": "allow",
    "skill":              "allow"
  },
  "instructions": ["AGENTS.md", ".arceus/beat-brief.md"],
  "plugin":       ["./.opencode/plugin/arceus-governance.ts"],
  "mcp": {
    "arceus": {
      "type":        "local",
      "command":     ["node", "/srv/arceus-mcp/dist/index.js"],
      "enabled":     true,
      "environment": { "ARCEUS_BEAT_ID": "{env:ARCEUS_BEAT_ID}" }
    }
  },
  "watcher": { "ignore": ["node_modules/**", "dist/**", ".arceus/**"] },
  "share":      "disabled",
  "autoupdate": false
}
```

## Sources

- [opencode.ai/docs/](https://opencode.ai/docs/)
- [opencode.ai/docs/cli/](https://opencode.ai/docs/cli/)
- [opencode.ai/docs/server/](https://opencode.ai/docs/server/)
- [opencode.ai/docs/sdk/](https://opencode.ai/docs/sdk/)
- [opencode.ai/docs/config/](https://opencode.ai/docs/config/)
- [opencode.ai/docs/agents/](https://opencode.ai/docs/agents/)
- [opencode.ai/docs/permissions/](https://opencode.ai/docs/permissions/)
- [opencode.ai/docs/modes/](https://opencode.ai/docs/modes/)
- [opencode.ai/docs/rules/](https://opencode.ai/docs/rules/)
- [github.com/sst/opencode](https://github.com/sst/opencode) — README

## Flagged uncertainties

- Whether `permission: "ask"` in headless `opencode run` auto-denies or hangs. Safe move: never set `"ask"` in Arceus configs, or handle via `permission.ask` plugin hook.
- Whether the `hooks` top-level key exists in `opencode.json` (some skill research suggests it may, but not confirmed from the config docs I pulled). The confirmed path for tool-execution hooks is the plugin API — see next doc.
