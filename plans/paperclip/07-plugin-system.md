---
title: Plugin System
---

# 07 · Plugin System

Paperclip ships a **real plugin SDK** — the `@paperclipai/sdk` package plus a host-side orchestrator that spawns plugin workers as separate OS processes. This is the part of Paperclip most worth studying for Arceus, because Arceus has no equivalent and the path to having one is clear.

---

## Part A: What a plugin is

A plugin is an npm package (published or local) that implements the Paperclip Plugin SDK and ships:
- A **manifest** (`paperclip.plugin.json` or similar) declaring capabilities, entrypoints, config schema
- A **worker entrypoint** (`dist/worker.js`) — the server-side logic
- Optionally a **UI bundle** (`dist/ui/`) — React components rendered into named slots in the Board UI
- Optionally a **custom adapter** — if the plugin registers a new `adapterType`

Layout from the repo:
```
packages/plugins/
├─ sdk/
│  ├─ src/define-plugin.ts       # the main author-facing API
│  ├─ src/worker-rpc-host.ts     # host-side RPC bridge
│  ├─ src/protocol.ts            # JSON-RPC 2.0 types
│  ├─ src/dev-cli.ts             # `paperclip-plugin dev` command
│  ├─ src/dev-server.ts
│  ├─ src/host-client-factory.ts
│  ├─ src/testing/                # test harness for plugin authors
│  └─ src/ui/                     # shared UI primitives plugins can import
└─ examples/
   ├─ hello-world/                # minimal plugin template
   ├─ kitchen-sink/               # maximal example
   └─ file-browser/               # UI-heavy example
```

## Part B: The manifest schema

Representative shape (from validator + examples):

```json
{
  "id": "com.example.my-plugin",
  "apiVersion": 1,
  "version": "0.3.1",
  "displayName": "My Plugin",
  "description": "…",
  "categories": ["issue-action", "dashboard-widget"],
  "capabilities": [
    "issues.read",
    "issues.comment.create",
    "agents.tools.register",
    "ui.sidebar.mount"
  ],
  "entrypoints": {
    "worker": "dist/worker.js",
    "ui": "dist/ui"
  },
  "instanceConfigSchema": {
    "type": "object",
    "properties": {
      "githubToken": { "type": "string", "secret": true }
    },
    "required": ["githubToken"]
  },
  "uiSlots": [
    { "slot": "issueDetailTab", "name": "pr-preview", "title": "PR Preview" }
  ],
  "tools": [
    {
      "name": "fetch_pr",
      "description": "Fetch a PR by number",
      "inputSchema": { /* JSON Schema */ },
      "outputSchema": { /* JSON Schema */ }
    }
  ]
}
```

Validation: `server/src/services/plugin-manifest-validator.ts` uses a Zod schema. `PluginManifestValidator.parseOrThrow()` is called at install time and on every reload.

## Part C: The SDK — how you author a plugin

Simplified shape of `@paperclipai/sdk definePlugin`:

```ts
import { definePlugin } from "@paperclipai/sdk";

export default definePlugin({
  async setup(ctx) {
    // ctx is the plugin runtime context
    // - ctx.config  (validated instance config)
    // - ctx.secrets (accessed via ctx.secrets.get('githubToken'))
    // - ctx.host    (RPC client to call back into Paperclip API)
    // - ctx.events  (pub/sub: on('issue.created', handler))
    // - ctx.log     (structured logger → plugin_logs table)
    // - ctx.storage (keyed kv scoped to this plugin + company)
  },

  tools: {
    async fetch_pr({ prNumber }, ctx) {
      // params validated against inputSchema
      const res = await fetch(`https://api.github.com/repos/.../pulls/${prNumber}`, {...});
      return { content: [{ type: "text", text: await res.text() }] };
    }
  },

  hooks: {
    async onInstall(ctx) { /* run once when installed */ },
    async onConfigChanged(ctx, { oldConfig, newConfig }) { /* … */ },
    async onHealth(ctx) { return { ok: true } },
    async onShutdown(ctx) { /* cleanup */ },
  }
});
```

The SDK hides the JSON-RPC wire protocol. The plugin author sees a TypeScript-typed API.

## Part D: Worker isolation — how plugins actually run

At `server/src/services/plugin-worker-manager.ts:20-80`:

```
┌───────── Paperclip server (host) ─────────┐
│                                            │
│  PluginWorkerManager                       │
│   ├─ for each installed plugin:           │
│   │    child_process.fork('dist/worker.js')│
│   │    → stdin/stdout = JSON-RPC channel   │
│   │    → stderr logged to plugin_logs      │
│   │                                        │
│   ├─ initialize(30s timeout)               │
│   ├─ heartbeat (every 30s via onHealth)    │
│   ├─ graceful shutdown (10s drain)         │
│   └─ crash recovery (exponential backoff)  │
│                                            │
│  PluginToolDispatcher                      │
│   └─ routes tool calls → correct worker    │
│                                            │
└────────────────────────────────────────────┘

         ▲                      ▲
         │ JSON-RPC 2.0        │ JSON-RPC 2.0
         │                      │
┌────────┴──────┐       ┌───────┴──────┐
│ worker A      │       │ worker B     │
│ (plugin X)    │       │ (plugin Y)   │
└───────────────┘       └──────────────┘
```

Every plugin is a separate OS process. A crash in plugin A cannot affect plugin B or the host. The host restarts dead workers with exponential backoff (capped).

Init flow:
1. Host sends `initialize` RPC with `{ pluginId, runtimeVersion, config, secrets }`.
2. Worker runs `setup(ctx)`.
3. Worker responds with `{ capabilities: [...], tools: [...], uiSlots: [...] }`.
4. Host registers them; plugin is active.

## Part E: Tool dispatch

At `server/src/services/plugin-tool-dispatcher.ts:94-100`:

```ts
async executeTool(pluginId: string, toolName: string, params: unknown, ctx: RunCtx)
  → validate params against tool.inputSchema
  → find worker for pluginId
  → send JSON-RPC call
  → await result
  → validate result against tool.outputSchema
  → return to caller
```

Who calls tools?
1. **Agents**, when their runtime (Claude Code / OpenCode) has registered the plugin's tool into the agent's tool list. The agent calls the tool; Claude Code forwards via MCP/built-in tools to Paperclip, which routes to the plugin worker.
2. **Board users**, via the UI — custom actions on issues, workspace buttons, etc.
3. **Other plugins**, if the host allows cross-plugin calls.

Per-call latency: a few ms for the RPC roundtrip + the plugin's own work. Negligible for most workflows.

## Part F: Hooks and events

Plugins subscribe to events via `ctx.events.on(name, handler)`. Event topics include:
- `issue.created`, `issue.updated`, `issue.status_changed`, `issue.commented`
- `agent.invoked`, `agent.run_completed`, `agent.run_failed`
- `approval.requested`, `approval.decided`
- `workspace.opened`, `workspace.closed`
- `plugin.tool.called`, `plugin.tool.completed`

Event delivery is **at-most-once per handler call, durable per subscription**. Events are queued in `plugin_jobs`; the worker consumes them, marking each job complete on success. If the worker dies mid-handler, the job is retried on restart.

## Part G: UI slots

Plugins can mount React components into named slots. Slot names (from `uiSlots` inventory):
- `dashboardWidget` — on the main dashboard
- `sidebarPanel` — left sidebar
- `issueDetailTab` — a tab on an issue detail page
- `commentAnnotation` — annotation in comment threads
- `agentConfigPanel` — panel on the agent config page
- `workspaceActionButton` — button in workspace toolbar

The UI bundle is loaded via a dynamic `<script type="module">` tag from `/api/plugins/{id}/ui/{entrypoint}`. The host passes a `pluginSdk` global giving access to the Paperclip API via the user's board session.

## Part H: Example plugin: `file-browser`

A small plugin illustrating the pattern:
- **Worker**: exposes a `fs.list(path)` tool that lists files in the company's workspace root.
- **Manifest capabilities**: `workspaces.read`.
- **UI slot**: `issueDetailTab` — a tab that browses files live in the linked workspace.
- **Config**: `{ rootPath: string }`.

Total LOC: ~300. Written by a single engineer in a day.

## Part I: `kitchen-sink` — the maximal example

The `examples/kitchen-sink` plugin demonstrates every capability. Used for internal smoke tests. Reading it is the fastest way to learn the SDK after this doc.

## Part J: Plugin state storage

Three tables backing plugin persistence:
- **`plugin_config`** — per-company config (validated against `instanceConfigSchema`)
- **`plugin_state`** — KV scoped to `(pluginId, companyId, key)` — what `ctx.storage.set('key', value)` writes
- **`plugin_entities`** — larger structured records (e.g. a plugin tracking imported PRs creates one row per PR)
- **`plugin_jobs`** — event delivery queue
- **`plugin_logs`** — log stream (with retention via `plugin-log-retention.ts`)

Retention jobs prune old logs (`plugin-log-retention.ts`). Storage quotas are enforced at the DB level via row-count limits.

## Part K: Host plumbing inventory

The services directory has **21** plugin-related files — half of Paperclip's plugin complexity is host-side. Selected:

| File | Purpose |
|---|---|
| `plugin-registry.ts` | in-memory index of installed plugins |
| `plugin-loader.ts` | reads manifest, validates, installs |
| `plugin-manifest-validator.ts` | Zod schema enforcement |
| `plugin-worker-manager.ts` | process lifecycle |
| `plugin-runtime-sandbox.ts` | env scrubbing + capability enforcement |
| `plugin-tool-dispatcher.ts` | request routing |
| `plugin-tool-registry.ts` | what tools are available from what plugins |
| `plugin-event-bus.ts` | event pub/sub within the host |
| `plugin-job-coordinator.ts` | event delivery orchestration |
| `plugin-job-scheduler.ts` | cron jobs declared by plugins |
| `plugin-job-store.ts` | job queue persistence |
| `plugin-secrets-handler.ts` | secret injection into workers |
| `plugin-lifecycle.ts` | install / uninstall / update hooks |
| `plugin-config-validator.ts` | instance config validation |
| `plugin-capability-validator.ts` | capability allowlist check |
| `plugin-host-services.ts` | host-exposed host APIs |
| `plugin-host-service-cleanup.ts` | cleanup on plugin uninstall |
| `plugin-log-retention.ts` | log GC |
| `plugin-state-store.ts` | KV backing |
| `plugin-stream-bus.ts` | realtime event streams |
| `plugin-dev-watcher.ts` | dev-mode hot reload |

## Part L: Why this design

From `PLUGIN_SPEC.md` (1644 lines, partially surveyed):
1. **Process isolation → crash containment.** Plugins can be buggy or hostile; one bad plugin can't bring down the host.
2. **JSON-RPC over stdio → portable.** A plugin worker is just a Node script reading stdin; no HTTP server, no port, no TLS.
3. **Capability-based security → least privilege.** A plugin that declares `issues.read` but not `issues.comment.create` literally can't send a comment — the host rejects the call.
4. **Manifest-first → ship a plugin without running it.** CI can install and validate without executing worker code.
5. **Dev mode with hot reload → good author experience.** `paperclip-plugin dev` watches source, restarts worker on change.

## Implications for Arceus

Arceus has **no plugin system**. Everything that wants to extend the platform today has to be a core code change. Consequences:
- Can't let users add GitHub integrations without Arceus team shipping code.
- Can't let a company write company-specific tools.
- Can't let a researcher ship an experimental adapter.

The Paperclip plugin pattern is a ~3-week investment (SDK + host plumbing + one example plugin) but opens the platform to a community.

Not urgent, but before we take on more "just one more integration" tickets, we should seriously consider: **lift the Paperclip SDK nearly verbatim**. It's MIT-licensed, design is solid, patterns are battle-tested.

See `08-arceus-leverage.md §6` for the sequencing proposal.

## Citations

- `packages/plugins/sdk/src/define-plugin.ts`
- `packages/plugins/sdk/src/worker-rpc-host.ts`
- `packages/plugins/sdk/src/protocol.ts`
- `server/src/services/plugin-worker-manager.ts:20-80`
- `server/src/services/plugin-tool-dispatcher.ts:94-100`
- `server/src/services/plugin-manifest-validator.ts`
- `packages/plugins/examples/kitchen-sink/` (maximal)
- `packages/plugins/examples/hello-world/` (minimal)
- `PLUGIN_SPEC.md` (1644-line formal spec)
