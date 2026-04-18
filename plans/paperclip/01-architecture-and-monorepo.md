---
title: Paperclip Architecture & Monorepo Layout
---

# 01 · Architecture & Monorepo Layout

Source: `/tmp/paperclip-src`, `/tmp/paperclip/arch.md`, `/tmp/paperclip/SPEC.md`.

## The three things Paperclip actually is

From `SPEC.md:1-40` and `arch.md:1-80`, stated explicitly:

1. **A REST control plane** (Express 5, Node 20+) — `server/src/`. It owns identity, tasks, approvals, budget, activity audit, and run records.
2. **A React UI** (React 19 + Vite 6 + Radix + Tailwind 4 + TanStack Query) — `ui/src/`. The board operator's only interface.
3. **A set of adapters** (`packages/adapters/*`) that know how to spawn, observe, and bill a specific third-party agent runtime.

> "Paperclip is a control plane. It does not execute model calls, own prompts, or manage memory. Every AI-driven decision runs inside an adapter." — `SPEC.md`

This is the single most important architectural fact. Everything downstream — the heartbeat protocol, the adapter triad, env-var identity, stdout parsing — falls out of this one decision.

## Full monorepo layout

```
paperclip/
├─ cli/                          # `paperclip` CLI (local dev + install + smoke)
│  └─ src/
├─ server/                       # Node REST control plane
│  └─ src/
│     ├─ index.ts                # Boot (817 lines)
│     ├─ app.ts                  # Express app + middleware wiring (425 lines)
│     ├─ routes/                 # 30+ route modules (issues 2795, agents 2622)
│     ├─ services/               # 70+ service modules (heartbeat 5408, issues 2573)
│     ├─ adapters/               # Adapter *dispatch* layer (http + process modes)
│     ├─ auth/                   # Board + agent auth
│     ├─ onboarding-assets/      # Seed markdown for new companies (CEO + default)
│     │  ├─ ceo/{SOUL,HEARTBEAT,AGENTS,TOOLS}.md
│     │  └─ default/AGENTS.md
│     ├─ secrets/                # KMS-ish encrypted secret store
│     ├─ storage/                # Blob/attachment layer
│     ├─ realtime/               # WebSocket push (live-events.ts)
│     ├─ lib/                    # Shared server utilities
│     └─ middleware/
├─ ui/                           # React admin app (the "Board")
│  └─ src/
├─ packages/
│  ├─ adapters/                  # Pluggable runtime adapters, one dir each
│  │  ├─ claude-local/           # Claude Code CLI
│  │  ├─ codex-local/            # OpenAI Codex CLI
│  │  ├─ cursor-local/           # Cursor background agents
│  │  ├─ gemini-local/           # Gemini CLI
│  │  ├─ opencode-local/         # OpenCode
│  │  ├─ pi-local/               # Pi (placeholder / minimal)
│  │  └─ openclaw-gateway/       # HTTP-gateway adapter (see docker/openclaw-smoke)
│  ├─ adapter-utils/             # Shared helpers: symlink mgmt, parse helpers
│  ├─ db/                        # Drizzle schema + migrations (65+ tables)
│  │  └─ src/schema/*.ts         # One file per table
│  ├─ mcp-server/                # MCP tools exposed by Paperclip itself
│  ├─ plugins/                   # Plugin SDK + examples
│  └─ shared/                    # Zod contracts, enums, types
├─ skills/                       # Repo-root skills (platform-wide)
│  └─ paperclip/                 # The skill agents load to talk to Paperclip
│  └─ paperclip-create-agent/
│  └─ paperclip-create-plugin/
│  └─ para-memory-files/
├─ .agents/skills/               # Agent-scoped skills (company-creator, release, etc.)
├─ .claude/skills/               # Dev-env skills for repo contributors
├─ docs/                         # Public docs site source
├─ doc/                          # Internal/experimental design docs
├─ docker/                       # Deploy artifacts (quadlet, smoke env)
├─ releases/                     # Release bundles
├─ scripts/                      # Repo scripts + smoke runners
├─ tests/                        # e2e + release-smoke
├─ evals/                        # promptfoo eval suites
└─ patches/                      # pnpm patch files
```

## Tech stack (from `package.json` + `arch.md`)

| Layer | Choice | Why it matters for Arceus |
|---|---|---|
| Backend | **Express 5** (beta in 2025, stable now) | We already use Express; alignment is good |
| DB | **PostgreSQL 17 or embedded PGlite** | Same choice Arceus makes |
| ORM | **Drizzle** (schemas in `packages/db/src/schema/*.ts`) | Arceus uses Drizzle too |
| Auth | **Better Auth** | We use custom; consider switch |
| Frontend | React 19 + Vite 6 + Radix + Tailwind 4 + TanStack Query | Arceus: Next 15 app router — different |
| Realtime | Own WS via `server/src/realtime/live-events.ts` | Arceus uses SSE + direct streaming |
| Package mgr | **pnpm** workspaces | Same |
| Runtime | Node 20+ | Same |
| Container | Dockerfile (`Dockerfile:1`), quadlet (`docker/quadlet/`) | Good reference for self-host |

## Request flow (end-to-end, from a UI click to an agent heartbeat completing)

Distilled from `server/src/index.ts`, `server/src/app.ts`, and `arch.md`:

```
┌──────────────────────────────────────────────────────────┐
│ 1. UI action or external event                           │
│    (board user clicks "Invoke agent", cron fires,        │
│     comment @-mention, approval resolves)                │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ 2. REST endpoint (e.g. POST /api/agents/{id}/invoke)     │
│    Route handlers in server/src/routes/                  │
│    → writes an agent_wakeup_requests row                 │
│      (with idempotencyKey for dedupe)                    │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ 3. Heartbeat scheduler / queue drain                     │
│    services/heartbeat.ts:3180 startNextQueuedRunForAgent │
│    → claimQueuedRun (atomic CAS: status queued → running)│
│    → resolveExecutionRunAdapterConfig (env + secrets)    │
│    → resolveWorkspaceForRun (git worktree or /tmp dir)   │
│    → spawn adapter via getServerAdapter(adapterType)     │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ 4. Adapter.execute() — runs child process                │
│    e.g. claude-local/src/server/execute.ts spawns        │
│    `claude --print --output-format=json ...`             │
│    Env vars injected:                                    │
│      PAPERCLIP_AGENT_ID, _COMPANY_ID, _API_URL,          │
│      _API_KEY (JWT), _RUN_ID, _TASK_ID,                  │
│      _WAKE_REASON, _APPROVAL_ID, etc.                    │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ 5. Agent runtime follows the protocol                    │
│    The agent calls Paperclip REST endpoints with its     │
│    short-lived JWT — it's just another HTTP client.      │
│    GET /api/agents/me → check work → checkout → work     │
│    → comment / status update → exit                      │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ 6. stdout parse + cost capture                           │
│    Adapter yields JSON-lines events; heartbeat service   │
│    appends each to heartbeat_run_events (seq++)          │
│    Final summary (cost, tokens, session id) closes run   │
│    cost_events row + atomic increment on                 │
│    agent_runtime_state.totalCostCents / tokens           │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ 7. Run record finalised                                  │
│    heartbeat_runs.status = succeeded/failed/timed_out    │
│    activity_log row written                              │
│    WebSocket push to UI                                  │
└──────────────────────────────────────────────────────────┘
```

## Design principles stated in their own docs

From `SPEC.md` (principles section):

1. Control plane never runs models directly.
2. Adapters are the only place that knows a runtime's CLI.
3. Inter-agent communication *only* via tasks + comments (no side channel).
4. Every mutating call from an agent carries `X-Paperclip-Run-Id`.
5. Every state change is appended to `activity_log` (append-only audit).
6. V1 board is a single human; multi-board is later.
7. No in-process plugins — all plugins run as separate processes.
8. Onboarding is seed-file driven (markdown under `server/src/onboarding-assets/`), not database-seeded.
9. Self-host first: everything from DB to storage can run on one box (Dockerfile works, PGlite works).

## What this lets them ship that Arceus can't today

- **Multi-runtime out of the box.** Want to swap Claude Code for Codex? Just change the agent's `adapterType`. Arceus today is hard-wired to OpenCode in several places.
- **Clean audit.** Every tool use, every cost event, every state mutation is in `heartbeat_run_events` + `activity_log`. Arceus has partial equivalents (beat records, cost events in `costs` table) but no unified event log.
- **Cost attribution per run, per task, per project.** We have rollups at sprint level; they have rollups at issue + run + agent + project + company level.

## Open questions / gaps in their architecture

- **Single-box only for v1.** No horizontal scaling of the control plane — the heartbeat scheduler uses local PID tracking (`heartbeat_runs.pid`). Running two servers would double-spawn.
- **No real MCP bridge in agents.** They have `packages/mcp-server` but it's the direction *Paperclip exposes tools* (→ agents), not agents using MCP servers registered centrally.
- **Memory is pluggable but not built-in.** `/tmp/paperclip/memory-landscape.md` is explicit: they surveyed mem0, supermemory, MemOS, Memori, and shipped *no* default memory layer — each plugin brings its own.

Citations for this file: `server/src/index.ts`, `server/src/app.ts:1-425`, `SPEC.md`, `arch.md`, `packages/` tree from `ls`, `/tmp/paperclip/memory-landscape.md`.
