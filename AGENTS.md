# Arceus — Agent Contributor Guide

This file is for AI agents (Claude, Codex, OpenCode subprocesses, etc.) and humans contributing to the codebase. It explains what Arceus is, how the code is organized, and the operating rules. Read it before touching code.

> **For Claude-specific instructions** (graphify, project memory, the `## Agent skills` block) see [`CLAUDE.md`](./CLAUDE.md). The two files are complementary: `AGENTS.md` is the universal contributor guide; `CLAUDE.md` adds Claude-runtime hooks on top.

---

## 1. What Arceus is

A simulated software company that runs autonomously. The board (you, the human) gives it an idea; agents play CEO, CTO, PM, developer, tester, UI designer, marketing, and skills lead. They run on a heartbeat — every tick, the orchestrator wakes one agent, gives it a rendered view of the world, lets it act through the OpenCode session, and gets out of the way.

The platform itself is **single-tenant** (one user, many companies). Multi-tenancy is not implemented; if you're targeting a hosted release see Section 11.

## 2. Workspace shape

```
arceus/
├── apps/
│   ├── api/         Fastify HTTP server — the orchestrator
│   ├── web/         Next.js dashboard (legacy)
│   ├── web2/        Vite + React mockup-driven UI (newer)
│   └── tui/         CLI dashboard (Ink)
├── packages/
│   ├── contracts/        Zod schemas + types (single source of truth)
│   ├── db/               Drizzle ORM + repos + migrations
│   ├── hippocampus/      Memory subsystem (provider-agnostic)
│   ├── task-engine/      Pure task helpers
│   ├── arceus-mcp/       Internal MCP protocol
│   └── company-runtime/  Beat / meeting / skill orchestration
├── plans/                Specs + audit clusters (architecture record)
├── docs/                 VitePress public docs + agents/ guides
├── tools/                Codebase health automation (knip-ci, churn, budgets)
├── scripts/              One-off migrations + utilities
└── graphify-out/         Knowledge graph (gitignored, regenerated)
```

Three rules that the layout enforces:
- **Apps depend on packages, never the reverse.**
- **`packages/contracts` has zero runtime deps**; everyone else can depend on it.
- **`packages/db` is the only path to Postgres.** Anything else uses repos exposed by `db`.

## 3. Local setup

Prerequisites:
- Node ≥ 22, **Bun** ≥ 1.3 (used for tests + scripts)
- Postgres + Supabase (storage). See `.env.example` for env vars
- OpenCode CLI installed locally (the api spawns it as a subprocess)
- For Langfuse traces: `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` — optional

Install + first run:

```sh
bun install
bun run db:migrate            # apply Drizzle migrations
npm run dev:api               # api on :4000
npm run dev:web2              # web2 vite on :5273 (proxies /api → :4000)
```

Open http://localhost:5273 once both are up.

## 4. The four runtime subsystems

| Subsystem | Lives in | What it does |
|---|---|---|
| **Heartbeat** | `apps/api/src/heartbeats/`, `packages/company-runtime/heartbeat.ts` | Wakes agents on a tick. Loads context, applies mutations, commits beat record |
| **Meeting pipeline** | `apps/api/src/meetings/`, `packages/company-runtime/meeting-pipeline.ts` | Schedules + runs meetings; collects contributions, runs facilitator agent (synthesize → resolve → brief) |
| **Skill registry + ATA** | `apps/api/src/skills/`, `packages/company-runtime/skill-*.ts` | Loads skills from `.arceus/skills-seed/` at boot; mutates them via the ATA pipeline; serves `/api/skills/*` |
| **Hippocampus (memory)** | `packages/hippocampus/`, `apps/api/src/memory/` | Four-tier memory (static / dynamic / procedural / priming). Provider-agnostic; the api supplies LLM extractors via DI |

The orchestrator wires these together in `server.ts`. Each subsystem owns its own state machine; the orchestrator only handles cross-cutting concerns (state mutation, audit, cost tracking).

## 5. Observability

Every event flows through one entry point — `observability.logEvent(event)` — and lands in 5 sinks. See [`apps/api/src/observability/README.md`](./apps/api/src/observability/README.md) for the full picture.

Producers should NEVER bypass `logEvent` and write to a sink directly.

## 6. Persistence

DB is the source of truth. There is no separate in-memory snapshot layer — `buildSnapshotView(companyId)` assembles a `CompanySnapshot` from canonical reads (12 parallel queries) on demand.

Three patterns govern reads/writes:

- **Pattern A (row-locked read-modify-write):** `db.transaction()` + `repo.lockForUpdate(tx, id)` + `repo.findByIdHydrated(tx, id)` + `repo.upsert(tx, next)`. Used by every `update*` helper in `apps/api/src/persistence/mutations.ts`.
- **Pattern B (status-guarded transition):** `UPDATE ... WHERE id = ? AND status = expected_from`. Used by `meetingsRepo.transitionStatus`. Zero rows = lost race; caller decides.
- **Atomic counters:** `SET col = col + 1` in a single statement. No read-modify-write window. Used by skip-counts, total-runs, etc.

C1 audit cluster is mostly closed. The remaining open item (F-350 — `createSprintWithTasks` non-atomic across N task INSERTs) is documented in `plans/code-audit/clusters.md`.

## 7. Code style

| Concern | Rule |
|---|---|
| Module size | <500 lines warn (eslint), <800 hard limit |
| Functions | <50 lines, <4 levels of nesting |
| Errors | Use `swallowAndAudit("kind", fn, ctx)` instead of bare `.catch(() => {})`. CI guard: `bun scripts/check-no-silent-catch.ts` |
| Mutation | Spread operator for updates; never mutate in place |
| Types | Avoid `any`; use `unknown` + narrow at boundaries |
| Re-exports | If a barrel is dead (no consumer goes through it), drop the barrel; don't add un-consumed re-exports |
| Config | New env vars go through `apps/api/src/config/*.ts` readers (`readNumberEnv` etc.), never `process.env.X` direct in feature code |

## 8. Tests

The api workspace runs only `apps/api/src/verification-gate.test.ts` in CI. Drift test (`packages/db/tests/drift.test.ts`) is the schema gate.

Other `*.test.ts` files exist alongside the code but are NOT run in CI today (orphan tests). If you write a new test, either:
- Put it next to the code as `*.test.ts` AND wire it into the workspace's `test` script
- Put it in `tests/e2e/` (Playwright) for browser-driving e2e

CI status (the typecheck-only build) catches signature drift, not behavior drift. Adding behavioral coverage is a deliberate decision.

## 9. How to add a feature

1. **Read the spec** — `plans/specs/` has the design specs. Architectural changes are recorded in `plans/code-audit/clusters.md`.
2. **Update `packages/contracts/`** if a new entity / event variant / type is needed.
3. **Add a Drizzle migration** under `packages/db/src/migrations/` if you change the schema. Run `bun run db:migrate` to apply locally.
4. **Implement repo functions** in `packages/db/src/repos/`. Follow Pattern A or B from Section 6.
5. **Wire into the api** — usually a route in `apps/api/src/routes/`, a mutator in `persistence/mutations.ts`, and an emit in the relevant subsystem.
6. **Verify** — `npm run typecheck`, `npm run lint`, manually exercise via web2 or the TUI.
7. **Update affected docs** — `apps/api/src/observability/README.md` if you add a sink, `plans/code-audit/clusters.md` if you close an audit item.

## 10. How to debug

- **Start the api in dev mode:** `npm run dev:api` (tsx watch). Logs go to stdout via pino.
- **Inspector:** `/api/inspector/stream` is the firehose of every `ArceusEvent`. The web2 UI's Logs view consumes this.
- **Audit ledger:** `/api/audit/stream` is the curated subset (categorized + sequence-numbered). The TUI consumes this.
- **Beat-level traces:** Langfuse UI shows the full prompt → completion → tool-call tree per beat (when configured).
- **DB queries:** turn on `ARCEUS_DEBUG_PERSIST=1` to log every row write.
- **Knowledge graph:** `graphify` (see `CLAUDE.md`) exposes structural cross-module queries.

When stuck, search `plans/code-audit/clusters.md` for the affected area — the audit doc records what's been investigated and decided.

## 11. Release shape

Arceus is **single-tenant** today (one process serves one user). Three release shapes are coherent:

| Shape | What it means | Multi-tenancy needed? |
|---|---|---|
| Open-source | You publish the repo, others self-host | No |
| Hosted SaaS, container-per-customer | One container per customer, you run the orchestration | No (in-process) — yes (orchestration layer) |
| Hosted SaaS, in-process multi-tenant | Many customers share one process | Yes — significant work |
| Commercial license, customer self-hosts | You sell a container, customer runs it | No |

If you're picking up work on multi-tenancy, expect to touch `apps/api/src/orchestration/state.ts` (module-level mutables become per-customer), the workspace symlink (`productWorkspace/.opencode/skills`), the active-company seam (`apps/api/src/persistence/active-company.ts`), and add per-customer auth + RLS. None of this is in scope for current work.

---

## Quick links

- `plans/agent-redesign/00-vision.md` — the agentic system vision
- `plans/specs/34-folder-restructure-v3.md` — the active architectural cleanup
- `plans/code-audit/clusters.md` — audit cluster status
- `apps/api/src/observability/README.md` — observability layer architecture
- `docs/agents/issue-tracker.md` — how to file issues (uses GitHub via `gh`)
- `docs/agents/triage-labels.md` — triage label vocabulary
- `docs/agents/domain.md` — domain glossary consumer rules
