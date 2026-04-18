---
title: Paperclip — System Design Research
generated: 2026-04-19
sources:
  - https://github.com/paperclipai/paperclip (v-from-HEAD, Apr 19 2026)
  - local clone: /tmp/paperclip-src
  - /tmp/paperclip/*.md (extracted docs)
confidence: high
---

# Paperclip System Design — Research Folder

Comprehensive read of the Paperclip codebase (cloned to `/tmp/paperclip-src`) and its public docs. The goal: extract the design patterns Arceus should adopt or explicitly reject.

**Paperclip in one sentence:** an open-source **control plane** (Node/Express + React) that orchestrates AI agents as **employees of a company**, where the agents themselves run in third-party runtimes (Claude Code, Codex CLI, OpenCode, Cursor, Gemini, etc.) via pluggable *adapters*. Paperclip never executes model calls itself — it dispatches, observes, bills, and governs.

This is the closest real-world analog to Arceus that exists today. Nearly every architectural choice they made, we face too.

---

## Folder contents

| File | What it covers |
|---|---|
| [`01-architecture-and-monorepo.md`](01-architecture-and-monorepo.md) | Monorepo layout (cli/server/ui/packages), tech stack, request flow |
| [`02-heartbeat-and-agent-runtime.md`](02-heartbeat-and-agent-runtime.md) | The 5,408-line heartbeat engine: trigger → claim → execute → capture; stranded-run recovery; session persistence |
| [`03-skills-system.md`](03-skills-system.md) | Filesystem-injected SKILL.md model, progressive disclosure, `~/.claude/skills` symlink materialization, `company_skills` table |
| [`04-agent-adapters.md`](04-agent-adapters.md) | The three-module adapter triad (`server/execute.ts` + `cli/format-event.ts` + `ui/parse-stdout.ts`); how six adapters coexist behind one interface |
| [`05-board-and-governance.md`](05-board-and-governance.md) | Approval kinds, budget policies + incidents, board-vs-agent permission boundary |
| [`06-data-model-and-migrations.md`](06-data-model-and-migrations.md) | 65+ Drizzle tables; the key ones for execution, cost, and audit |
| [`07-plugin-system.md`](07-plugin-system.md) | Plugin SDK, JSON-RPC worker isolation, manifest schema, tool dispatch, UI slots |
| [`08-arceus-leverage.md`](08-arceus-leverage.md) | **Crown file.** Concrete mapping: paperclip pattern → Arceus change, with file-level proposals |

Read `08` first if short on time. Read `02` and `04` before touching Arceus's orchestrator.

---

## TL;DR — top 7 ideas to steal

1. **Control plane, not execution plane.** Paperclip deliberately does not run models. It publishes a REST contract, spawns adapter processes with env-var identity, and reads stdout. Arceus's orchestrator conflates these layers; separating them would let us support OpenCode, Codex, and Claude Code side-by-side without orchestrator edits. → `08 §1`, `04`.

2. **Heartbeat as a contract, not a daemon.** Agents don't run continuously. A *heartbeat* is a single execution burst: `trigger → GET /api/agents/me → GET assignments → checkout → work → status → exit`. The exact nine steps are encoded as a markdown file (`server/src/onboarding-assets/ceo/HEARTBEAT.md:1-83`) that the agent literally reads on every wake. This is how Paperclip keeps the runtime simple: *the agent is responsible for following the protocol*, not some scheduler inside the server. → `02`, `08 §2`.

3. **Atomic checkout with SELECT FOR UPDATE + multi-condition CAS.** At `server/src/services/issues.ts:1779-1851`, checkout uses a pessimistic row lock followed by a compound `UPDATE ... WHERE id = ? AND status IN (...) AND (checkoutRunId IS NULL OR checkoutRunId = ?)`. Two agents racing → exactly one wins, other gets 409. No lost updates, no split-brain. → `06 §issues`, `08 §3`.

4. **Adapter triad = 3 modules per runtime.** Every adapter exports `server/execute.ts` (process spawn + parse), `ui/parse-stdout.ts` + `ui/build-config.ts` (what the web UI renders + form schema), and `cli/format-event.ts` (what the CLI pretty-prints). Six adapters follow the same 3-module shape. Adding Gemini took someone ~500 LOC. → `04`.

5. **Filesystem-injected skills, per-run symlinked.** Skills live as `SKILL.md` on disk. At run dispatch, the adapter (see `packages/adapters/claude-local/src/server/skills.ts:31-103`) materializes a symlink tree into `~/.claude/skills/` so the agent runtime discovers them natively. No embedding, no classifier. The LLM picks from the in-prompt catalog. → `03`, `08 §4`.

6. **Stranded-run reconciliation loop.** A background sweeper (`heartbeat.ts:2987` `reconcileStrandedAssignedIssues`) detects dead child PIDs and issues *at most one* automatic recovery wake, then marks the issue `blocked` with a visible comment. Bounded retry (`processLossRetryCount` cap, 40). Arceus has no equivalent — we'd lose work on crash. → `02 §stranded`, `08 §5`.

7. **Plugins = JSON-RPC workers over stdio, not in-process modules.** Each plugin is a separate child process. Host calls `definePlugin({ setup, tools, hooks, ui })`; SDK translates to JSON-RPC 2.0. Crash in a plugin → just the worker dies, host restarts with exponential backoff. This is how they let third parties extend Paperclip without sandbox escapes. → `07`, `08 §6`.

---

## Methodology

- Cloned HEAD of https://github.com/paperclipai/paperclip to `/tmp/paperclip-src` (32 MB, shallow).
- Read key source files directly (heartbeat engine, two adapters, approvals, budgets, onboarding assets, a handful of Drizzle schemas).
- Cross-referenced with Paperclip's own `/tmp/paperclip/*.md` documentation (SPEC, arch, core-concepts, heartbeat-protocol, execution-semantics, writing-a-skill, task-workflow, memory-landscape, etc.).
- Every non-trivial claim in this folder cites a `file:line`. Anything marked `[unconfirmed]` was inferred from naming or structure, not verified.

Source snapshot: HEAD of `main` as of 2026-04-19 03:45 PDT.

## How this differs from Arceus's current state

Arceus already made some of the same choices (heartbeats, sprint-based execution, SKILL.md progressive disclosure). The structural *gaps* are what `08` documents:
- No adapter layer — orchestrator directly spawns OpenCode
- No stranded-run reconciliation
- No generic plugin/extension SDK
- Skills are DB-backed + filesystem-materialized (a hybrid they don't have, but we should keep)
- No atomic CAS on task checkout yet (races possible)
- No budget policy / incident split

See `08-arceus-leverage.md` for concrete edit plans.
