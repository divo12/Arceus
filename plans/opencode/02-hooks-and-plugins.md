# 02 — Hooks and Plugins

*OpenCode's plugin system — the single most powerful surface for Arceus integration.*

---

## 2.1 Plugins are the hook API

OpenCode's hook surface is delivered **via the plugin system** ([opencode.ai/docs/plugins/](https://opencode.ai/docs/plugins/)). There is no separate `hooks.*` config block like Claude Code's `~/.claude/settings.json` — you ship a JS/TS plugin that returns a `Hooks` object.

Plugins are loaded from:
- `.opencode/plugin/*.ts` (project)
- `~/.config/opencode/plugin/*.ts` (global)
- or npm packages named in `plugin: []` in `opencode.json`

Dependencies go in `.opencode/package.json`.

## 2.2 Plugin signature

From `@opencode-ai/plugin` (source: `packages/plugin/src/index.ts`):

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const ArceusGovernance: Plugin = async (input) => {
  // input shape:
  //   client:                @opencode-ai/sdk client (call back into OpenCode server)
  //   project:               Project info
  //   directory:             cwd
  //   worktree:              git worktree path
  //   serverUrl:             URL for the local server
  //   $:                     Bun template-literal shell
  //   experimental_workspace: { register(type, adaptor): void }

  return {
    // hooks object — see 2.3
  }
}
```

Plugin factories are async — they can do startup work (fetch beat manifest from Arceus, prime caches) before returning the hooks object.

## 2.3 Full `Hooks` interface

Confirmed from `packages/plugin/src/index.ts` (333 lines) on the `dev` branch:

| Hook key | Signature (abbreviated) | When it fires |
|---|---|---|
| `event` | `(input: { event: Event }) => Promise<void>` | **Firehose** — every internal event passes through |
| `config` | `(input: Config) => Promise<void>` | Mutate/observe resolved config at load time |
| `tool` | `{ [name: string]: ToolDefinition }` | Register named tools (see [`03-tools-and-mcp.md`](./03-tools-and-mcp.md)) |
| `auth` | `AuthHook` | Register a custom auth provider |
| `provider` | `ProviderHook` | Register a custom model provider |
| `chat.message` | `(input, output) => Promise<void>` | Fired when a user message arrives |
| `chat.params` | `(ctx, params) => void` | Modify `{ temperature, topP, topK, maxOutputTokens, options }` before LLM call |
| `chat.headers` | `(ctx, headers) => void` | Modify outbound HTTP headers to LLM provider |
| `permission.ask` | `(input) => { status: "ask"\|"deny"\|"allow" }` | Programmatically answer permission prompts |
| `command.execute.before` | `(input) => void` | Mutate parts for a `/command` before it runs |
| **`tool.execute.before`** | `(input, output) => void` | **Mutate `{ args }` before a tool runs; throw to deny** |
| **`tool.execute.after`** | `(input, output) => void` | Observe `{ title, output, metadata }` after a tool runs |
| `tool.definition` | `(input, output) => void` | Rewrite `{ description, parameters }` the LLM sees for any tool |
| `shell.env` | `(env) => env` | Inject env vars into every shell invocation |

### Session & file lifecycle (also available via `event`)

`session.created`, `session.idle`, `session.compacted`, `session.deleted`, `session.diff`, `session.error`, `session.status`, `session.updated`, `file.edited`, `file.watcher.updated`, `message.part.updated`, `message.part.removed`, `message.updated`, `message.removed`, `todo.updated`, `permission.asked`, `permission.replied`, `lsp.client.diagnostics`, `lsp.updated`, `installation.updated`, `command.executed`, `server.connected`, `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`.

### Experimental

`experimental.chat.messages.transform` (rewrite full history), `experimental.chat.system.transform` (append/replace system prompt), `experimental.session.compacting` (customize compaction prompt), `experimental.compaction.autocontinue` (skip continue turn), `experimental.text.complete` (post-process text parts), `session.compacting`.

**Do not rely on `experimental.*` in Arceus production code.**

## 2.4 The Arceus-shaped plugin

The governance plugin is the single most important file in the integration. It does three things:

1. **`tool.execute.before`** — enforces Arceus governance policy (role/trust-band aware) *at runtime*, not just at config load time.
2. **`tool.execute.after`** — emits audit events back to Arceus for every tool call.
3. **`chat.params` / `chat.headers`** — stamps beat context (beatId, role, trust band) on every LLM call so proxies/observability can attribute cost/usage.

Minimal sketch:

```typescript
// .opencode/plugin/arceus-governance.ts
import type { Plugin } from "@opencode-ai/plugin"

const ARCEUS_API    = process.env.ARCEUS_API_URL   ?? "http://localhost:3001"
const ARCEUS_TOKEN  = process.env.ARCEUS_BEAT_TOKEN ?? ""
const BEAT_ID       = process.env.ARCEUS_BEAT_ID    ?? ""
const ROLE          = process.env.ARCEUS_ROLE       ?? "engineer"

async function postEvent(path: string, body: unknown): Promise<void> {
  try {
    await fetch(`${ARCEUS_API}${path}`, {
      method:  "POST",
      headers: { "content-type": "application/json", "x-arceus-token": ARCEUS_TOKEN },
      body:    JSON.stringify(body),
    })
  } catch (err: unknown) {
    // do not fail the beat on telemetry errors
    console.warn("[arceus-governance] telemetry post failed", err)
  }
}

export const ArceusGovernance: Plugin = async ({ client, worktree }) => {
  // Fetch beat-scoped policy once on startup
  const policy = await fetch(`${ARCEUS_API}/internal/beat/${BEAT_ID}/policy`, {
    headers: { "x-arceus-token": ARCEUS_TOKEN }
  }).then(r => r.json() as Promise<{
    allow:  ReadonlyArray<string>
    deny:   ReadonlyArray<string>
    ask:    ReadonlyArray<string>
  }>)

  return {
    // 1. Dynamic governance enforcement
    "tool.execute.before": async (input, output) => {
      const tool = input.tool
      if (policy.deny.some(p => globMatch(tool, p))) {
        throw new Error(`[arceus] tool '${tool}' denied for role '${ROLE}'`)
      }
      if (tool === "bash" && /rm\s+-rf\s+\//.test(output.args.command ?? "")) {
        throw new Error("[arceus] catastrophic bash command blocked")
      }
      await postEvent("/internal/audit/tool-before", {
        beatId: BEAT_ID, role: ROLE, tool, args: output.args,
      })
    },

    // 2. Audit every result, attribute skills
    "tool.execute.after": async (input, output) => {
      await postEvent("/internal/audit/tool-after", {
        beatId: BEAT_ID, role: ROLE,
        tool:   input.tool,
        title:  output.title,
        metadata: output.metadata,
        ok: !output.error,
      })

      // Skill usage telemetry — the hook that replaces classifyTaskSkills
      if (input.tool === "skill" && output.metadata?.["arceus-skill-id"]) {
        await postEvent("/internal/skill-usage", {
          beatId:   BEAT_ID,
          skillId:  output.metadata["arceus-skill-id"],
          outcome:  output.error ? "error" : "activated",
          ts:       new Date().toISOString(),
        })
      }
    },

    // 3. Stamp every LLM call with beat context
    "chat.params": async (_ctx, params) => {
      params.temperature = params.temperature ?? 0.2
    },
    "chat.headers": async (_ctx, headers) => {
      headers["x-arceus-beat-id"] = BEAT_ID
      headers["x-arceus-role"]    = ROLE
    },

    // 4. Programmatic permission answers (never hang headless)
    "permission.ask": async (input) => {
      // if Arceus policy says allow, short-circuit to allow; else deny
      if (policy.allow.some(p => globMatch(input.tool ?? "", p))) {
        return { status: "allow" }
      }
      return { status: "deny" }
    },

    // 5. Worktree-level session lifecycle
    "session.idle": async () => {
      await postEvent("/internal/beat-complete", { beatId: BEAT_ID, worktree })
    },
    "session.error": async ({ event }) => {
      await postEvent("/internal/beat-error", { beatId: BEAT_ID, error: event })
    },
  }
}

function globMatch(s: string, pattern: string): boolean {
  const rx = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
  return rx.test(s)
}
```

### Why this shape

- **`tool.execute.before` is where governance belongs.** It runs in-process, sees sessionID + agent + messageID, and can throw to deny. Doing it only in config (`permission.*`) loses dynamic context like trust band or per-beat overrides.
- **`permission.ask` auto-answers.** Headless beats must never hang. This hook programmatically resolves any prompt that sneaks through.
- **`session.idle` is the completion signal.** Listen for it instead of polling the session state.

## 2.5 Pre/post-tool payload contract

The public docs describe the hook signature but do not enumerate every field on `input` / `output`. From the plugin source:

```typescript
// tool.execute.before
// input contains (at minimum):
//   tool:        string          // tool name, e.g. "bash", "skill", "edit"
//   sessionID:   string          // [unconfirmed public contract — present internally]
//   messageID:   string          // [unconfirmed]
//   agent:       string          // active agent name
// output is mutable:
//   args:        Record<string, unknown>  // tool args; throwing here cancels the call
```

```typescript
// tool.execute.after
// input:  same as before
// output:
//   title?:    string
//   output?:   string | object   // tool's return value
//   metadata?: Record<string, unknown>
//   error?:    Error | string
```

**Defensive read pattern** — do not rely on undocumented field names without a null check:

```typescript
const toolName   = input.tool ?? "unknown"
const args       = output.args ?? {}
const resultMeta = output.metadata ?? {}
```

## 2.6 Other useful hooks for Arceus

### `tool.definition` — rewrite tool schemas on the fly

Lets you nudge the model per beat without editing OpenCode core:

```typescript
"tool.definition": async (input, output) => {
  if (input.tool === "bash" && ROLE === "ceo") {
    output.description += "\n\nNOTE: as CEO you rarely run bash. Prefer arceus_post_to_ceo_chat or skill('ceo-delegate-task')."
  }
}
```

### `chat.headers` — proxy all LLM traffic through your gateway

Injecting `x-helicone-user`, `x-litellm-metadata`, `x-otel-trace-id` is clean via this hook. Arceus can centralize LLM accounting without per-provider changes.

### `shell.env` — inject env vars into every bash call

Useful for `ARCEUS_API_URL`, `ARCEUS_TOKEN`, `BEAT_ID` — so custom tools / MCP clients spawned from `bash` see them:

```typescript
"shell.env": async (env) => {
  env.ARCEUS_API_URL = ARCEUS_API
  env.ARCEUS_BEAT_ID = BEAT_ID
  return env
}
```

## 2.7 Plugin loading & lifecycle

- Plugin factory runs **once per OpenCode server startup**. For per-beat servers this means per-beat.
- The factory is `async` — do all init work (fetch policy, validate env) before returning. Errors thrown here fail server startup.
- Hooks are called per event — keep them fast. If you need to do expensive work (LLM calls, heavy I/O), fire-and-forget:

```typescript
"tool.execute.after": async (input, output) => {
  void (async () => {
    await heavyAuditPipeline(input, output)
  })().catch(err => console.warn("audit failed", err))
}
```

## 2.8 Testing plugins

The `@opencode-ai/plugin` package exports types only — testing a plugin is "call the returned hook functions with synthetic inputs and assert side effects." Example shape:

```typescript
import { describe, it, expect, vi } from "vitest"
import { ArceusGovernance } from "../plugin/arceus-governance"

describe("ArceusGovernance", () => {
  it("blocks rm -rf /", async () => {
    const mockInput = { client: {} as any, project: {} as any, directory: "/tmp", worktree: "/tmp", serverUrl: new URL("http://localhost"), $: vi.fn() as any, experimental_workspace: {} as any }
    const hooks = await ArceusGovernance(mockInput)
    await expect(
      hooks["tool.execute.before"]!(
        { tool: "bash", sessionID: "s", messageID: "m", agent: "engineer" } as any,
        { args: { command: "rm -rf /" } }
      )
    ).rejects.toThrow(/catastrophic/)
  })
})
```

## 2.9 Custom commands vs plugins

There's a separate `.opencode/commands/<name>.md` surface for **user-triggered** slash commands (`/review`, `/test`). These are prompt templates, not hooks. Covered in [`03-tools-and-mcp.md`](./03-tools-and-mcp.md#custom-commands) — for Arceus they are less important than plugins/tools/skills because beats run headless without humans typing `/`.

**Flagged:** whether a plugin can *register* a new slash command (as opposed to *intercepting* one via `command.execute.before`) is not documented. Assume no until verified.

## Sources

- [opencode.ai/docs/plugins/](https://opencode.ai/docs/plugins/)
- [github.com/sst/opencode `packages/plugin/src/index.ts`](https://github.com/sst/opencode/blob/dev/packages/plugin/src/index.ts) — full `Hooks` interface (333 lines)
- [github.com/sst/opencode `packages/plugin/src/example.ts`](https://github.com/sst/opencode/blob/dev/packages/plugin/src/example.ts) — minimal plugin + tool
- [github.com/sst/opencode `packages/plugin/src/tool.ts`](https://github.com/sst/opencode/blob/dev/packages/plugin/src/tool.ts) — `ToolContext`, `tool.schema = z`

## Flagged uncertainties

- Exact field names on `tool.execute.before`'s `input` object (`sessionID`, `messageID`, `callID` — present internally but not fully enumerated in public docs). Read from `packages/plugin/src/index.ts` at integration time.
- Whether plugins can register new `/slash` commands (only `command.execute.before` interception is documented).
- Whether a top-level `hooks` key exists in `opencode.json` (some third-party write-ups suggest it does; the confirmed path is still the plugin API).
