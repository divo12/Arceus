# Overview

Arceus is an AI company operating system. It boots a team of LLM-powered agents (CEO, CTO, PM, Developer, Tester, UI Designer, Marketing, Skills Lead) that autonomously plan sprints, write code, run QA, and ship products — with the human acting as a board of directors.

## Repository Structure

```
apps/
  api/          Fastify backend — orchestration, LLM, heartbeat, workspace
  web/          Next.js dashboard — boardroom chat, task board, activity feed
packages/
  contracts/    Zod schemas and shared TypeScript types
  db/           Drizzle ORM, migrations, Postgres/pgvector
  hippocampus/  Three-tier memory system (static, dynamic, procedural)
  company-runtime/  Pure business logic — heartbeat, meetings, skills, patterns
  task-engine/  Task state machine, sprint lifecycle, execution cycle
```

## How It Works

1. **Bootstrap** — User describes a company idea; CEO generates a strategy
2. **Sprint Proposal** — CEO proposes the next sprint with tasks, roles, and dependencies
3. **Execution** — Heartbeat engine drives agent beats; developer writes code via OpenCode
4. **Review** — Tester runs QA, verification gate checks build/tests, rework cycles on failure
5. **Ship** — Sprint completes, cross-sprint pattern transfer runs, CEO proposes next sprint

## Key Concepts

- **Heartbeat** — periodic tick scheduler, four-phase executor (Wake → Observe → Execute → Serialize)
- **Beat** — one agent's turn: run checklist, pick task, execute, flush mutations
- **Sprint** — a planning unit containing tasks with a DAG of dependencies
- **Meeting Pipeline** — scheduled multi-agent alignment (daily sync, escalation)
- **Hippocampus** — three-tier memory (L1 static, L2 dynamic, L3 procedural) + priming
- **Skills** — versioned Markdown procedures agents follow; evolved via pattern learning
- **Governance** — trust scores, budget caps, policy gates on tool access and mutations
