---
title: Agent Adapter Pattern
---

# 04 · Agent Adapter Pattern

The adapter pattern is how Paperclip decouples "how an agent is invoked" from "what an agent does." Six adapters ship at HEAD (`claude-local`, `codex-local`, `cursor-local`, `gemini-local`, `opencode-local`, `pi-local`) plus an HTTP gateway (`openclaw-gateway`). All follow the same 3-module shape.

---

## The interface (distilled)

Every adapter is an npm package under `packages/adapters/{name}/` with the same entry points:

```
packages/adapters/{name}/
├─ package.json
├─ src/
│  ├─ index.ts                 # exports `type`, `label`, `models`, agentConfigurationDoc
│  ├─ server/
│  │  ├─ index.ts              # barrel: execute, parse, listSkills, syncSkills, models
│  │  ├─ execute.ts            # main entry — spawns child process
│  │  ├─ parse.ts              # stdout JSON-lines parser
│  │  ├─ skills.ts             # filesystem skill materialization
│  │  ├─ models.ts             # list of model ids
│  │  ├─ prompt-cache.ts       # adapter-specific caching (claude-local)
│  │  ├─ quota.ts              # rate/quota tracking (claude-local)
│  │  └─ test.ts               # dev-time smoke
│  ├─ ui/
│  │  ├─ index.ts              # barrel for bundler
│  │  ├─ parse-stdout.ts       # UI-side stdout renderer (streams line events)
│  │  └─ build-config.ts       # Zod/JSON schema for the config form in the Board UI
│  └─ cli/
│     ├─ index.ts              # barrel
│     ├─ format-event.ts       # pretty-print for `paperclip` CLI
│     └─ quota-probe.ts        # CLI probe for quota headroom
```

Claude-local file sizes give a sense of surface area:
| File | LOC |
|---|---|
| `server/execute.ts` | 629 |
| `server/quota.ts` | 541 |
| `server/test.ts` | 249 |
| `server/parse.ts` | 179 |
| `server/prompt-cache.ts` | 172 |
| `ui/parse-stdout.ts` | 144 |
| `cli/format-event.ts` | 139 |
| `server/skills.ts` | 121 |
| `ui/build-config.ts` | 101 |
| `server/index.ts` | 81 |
| `cli/quota-probe.ts` | 124 |
| `server/models.ts` | 33 |
| `index.ts` | 38 |

Total claude-local: ~2,500 LOC.  OpenCode-local, by contrast: ~1,200 LOC — the simpler adapter.

---

## Part A: `server/execute.ts` — the real work

This is the function the heartbeat engine calls. At `packages/adapters/claude-local/src/server/execute.ts:1-629`, the signature (paraphrased):

```ts
export async function executeClaudeLocalRun(
  input: AdapterExecutionInput,
): Promise<AdapterExecutionResult>

interface AdapterExecutionInput {
  runId: string;
  agent: AgentRecord;
  config: ClaudeLocalConfig;        // merged from agent.adapterConfig + company defaults
  context: RunContext;              // issue, workspace, env, prior session
  onEvent: (event: RunEvent) => Promise<void>;   // called for every parsed event
  signal: AbortSignal;              // cancellation
}

interface AdapterExecutionResult {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  summary: { sessionId, model, costUsd, usage, finalText } | null;
  errorReason?: string;
  processGroupId?: number;
}
```

What `executeClaudeLocalRun` does:
1. Reconcile `~/.claude/skills` via `syncClaudeSkills` (see `03-skills-system.md`).
2. Optionally hydrate prompt cache (`prompt-cache.ts`).
3. Build CLI args: `claude --print --output-format=stream-json --model <m> --resume <sessionId?> ...`.
4. Spawn child process with `detached: true` to get its own process group (for kill-group on timeout).
5. Stream stdout lines → `parseClaudeStreamJson` → call `onEvent(evt)` for each.
6. Wait for exit. Read final summary from last event.
7. Return `AdapterExecutionResult`.

`parse.ts:7` `parseClaudeStreamJson()` is a ~180-line state machine that turns newline-delimited JSON into typed events: `session_start`, `tool_call`, `tool_result`, `assistant_message`, `usage_update`, `final`.

## Part B: `ui/parse-stdout.ts` — UI-side event renderer

Separate file, separate lifecycle. At `packages/adapters/claude-local/src/ui/parse-stdout.ts:1-144`, the UI bundle imports a browser-safe parser that takes raw stdout chunks (as streamed via WebSocket from `heartbeat_run_events`) and yields rendered React-friendly event objects.

Why it's separate:
- The server parser knows about cost fields and secret redaction; the UI parser doesn't need secrets and shouldn't bloat the browser bundle.
- The UI parser can also emit partial-state events during streaming (tool-call-started) for live views before `tool_result` arrives.

This separation means a third-party plugin could reuse `ui/parse-stdout.ts` standalone — e.g. embed a Claude Code event viewer in a custom panel.

## Part C: `ui/build-config.ts` — the config form schema

101 LOC at `packages/adapters/claude-local/src/ui/build-config.ts`. Exports a function returning a JSON Schema describing `ClaudeLocalConfig`. The Board UI renders a form from this schema automatically.

The agent config schema (from `index.ts:13-38`, verbatim fields):

| Field | Type | Default | Purpose |
|---|---|---|---|
| `cwd` | string | optional | default CWD for the agent process |
| `instructionsFilePath` | string | optional | absolute path to markdown instructions injected at runtime |
| `model` | string | optional | Claude model id |
| `effort` | string | optional | `low` \| `medium` \| `high` (reasoning effort) |
| `chrome` | boolean | optional | pass `--chrome` |
| `promptTemplate` | string | optional | run prompt template |
| `maxTurnsPerRun` | number | optional | cap turns |
| `dangerouslySkipPermissions` | boolean | `true` | defaults true because Paperclip runs Claude in headless `--print` mode |
| `command` | string | `claude` | binary override |
| `extraArgs` | string[] | optional | pass-through CLI flags |
| `env` | object | optional | KEY=VALUE env overrides |
| `workspaceStrategy` | object | optional | `{ type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }` |
| `workspaceRuntime` | object | optional | reserved |
| `timeoutSec` | number | optional | run timeout |
| `graceSec` | number | optional | SIGTERM grace period |

The `dangerouslySkipPermissions` default of `true` + the explanatory comment is a good example of design documentation *in the code*.

## Part D: `cli/format-event.ts` — CLI pretty-printer

At `packages/adapters/claude-local/src/cli/format-event.ts:1-139`. Imports the same event types from `server/parse.ts`, but renders with ANSI colors for terminal use.

Why separate from the UI parser:
- Different output target (terminal vs DOM).
- Different formatting (prefers compact multi-column vs expandable tree).
- Runs in the CLI process, not the server process.

## Part E: `cli/quota-probe.ts` — optional health probe

124 LOC at `packages/adapters/claude-local/src/cli/quota-probe.ts`. Runs as `paperclip adapters probe claude-local` and uses Claude Code's quota-check mechanism to report headroom before a long run. Optional — not all adapters implement it.

---

## How they compare

Looking at `claude-local` vs `opencode-local`:

| Aspect | claude-local | opencode-local |
|---|---|---|
| Binary | `claude --print` | `opencode` headless mode |
| Session resume | `--resume <id>` | config-based | 
| Stream format | Claude stream-json | OpenCode JSONL | 
| Skill mechanism | `~/.claude/skills/` symlinks | `.opencode/skills/` per-run workdir |
| Plugin/hook surface | n/a | OpenCode plugin APIs (`tool.execute.after`, `session.idle`) |
| Adapter LOC | ~2,500 | ~1,200 |

Both adapters export the same five server-side surfaces: `execute`, `parse`, `listSkills`, `syncSkills`, `models`. That five-name contract is effectively **the adapter SDK**, though Paperclip hasn't formalised it as an `AbstractAdapter` class — it's a structural contract enforced by how `getServerAdapter(type)` looks up and calls them.

## What an adapter does *not* do

Explicit from `/tmp/paperclip/adapters-overview.md`:
- Never makes REST calls on behalf of the agent. The agent process does that itself.
- Never mutates issues, approvals, costs, or any Paperclip state. Only the server writes state; the adapter streams events.
- Never holds long-lived connections. It starts a child, streams stdout, returns.
- Never authenticates as a board user. It only passes the agent JWT into the child process env.

This is why adapters can be written by third parties without giving them any privileges over Paperclip state.

## How an adapter is registered

At server boot (`server/src/index.ts`), a registry function calls `registerAdapter(type, { execute, parse, models, listSkills, syncSkills, uiBundle, cliBundle })`. The type string (`"claude_local"`, etc.) becomes the value stored in `agents.adapterType`. Looking up an adapter is a simple map.

Third-party adapters can ship as plugins (see `07-plugin-system.md`) — the plugin lifecycle hook `registerAdapter` exposes the same registration function. This is why they can ship `openclaw-gateway` as an HTTP-based adapter — same interface, different invocation (HTTP request instead of child process).

---

## Arceus implications

Arceus today has **zero** adapter layer. The orchestrator directly assumes OpenCode and spawns it inline. Consequences:
- Can't run Claude Code beats for cheap roles.
- Can't swap to Codex when testing.
- Can't let companies choose their runtime.

Proposed change (full detail in `08-arceus-leverage.md`):
1. Create `packages/adapters/` at the Arceus root. Move the OpenCode spawn logic out of `orchestrator.ts` into `packages/adapters/opencode-local/src/server/execute.ts`.
2. Define an `AbstractAdapter` TS interface with the five-method contract.
3. Store `adapterType` on the agent record (we currently don't have this field; add it).
4. Load adapters via a registry at server boot.

Effort: ~1 week to extract the first adapter cleanly. The gain is strategic optionality.

## Citations

- `packages/adapters/claude-local/src/index.ts:1-38` — adapter metadata + agent config doc
- `packages/adapters/claude-local/src/server/execute.ts:1-629` — full execute flow
- `packages/adapters/claude-local/src/server/parse.ts:7-179` — stream parser
- `packages/adapters/claude-local/src/server/skills.ts:1-121` — skill materialization
- `packages/adapters/opencode-local/src/server/execute.ts:57-90` — OpenCode-specific symlink injection
- `/tmp/paperclip/adapters-overview.md`, `/tmp/paperclip/adapter-plugin.md`
