# Paperclip Repo Learning Path

This is a practical learning path for understanding this repo as an engineer, especially if you understand backend concepts at a surface level and want a reliable way to go deeper without getting overwhelmed.

The main idea is simple:

1. Do not read the repo folder-by-folder.
2. Read it in execution order.
3. Then trace one real feature end-to-end.
4. Only after that, branch into advanced systems like memory, governance, and plugins.

If you follow this order, the repo starts feeling coherent much faster.

---

## 1. The Mental Model

Paperclip is a control plane for AI-agent companies.

At a high level, the system is:

`UI -> API routes -> services -> DB / adapters / Hippocampus runtime`

That is the backbone of almost everything in the repo.

Use these docs first for product and system framing:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DATABASE.md`
5. `doc/Architecture.md`

What each one gives you:

- `doc/GOAL.md`: why the repo exists
- `doc/PRODUCT.md`: product concepts like company, agent, goals, org, heartbeat
- `doc/SPEC-implementation.md`: what V1 is actually supposed to do
- `doc/DATABASE.md`: what data the system persists
- `doc/Architecture.md`: how the moving parts fit together

Do not skip the product docs. If you only read code first, many design decisions feel random when they are actually product-driven.

---

## 2. Phase 1: Understand Where Execution Starts

Goal: learn how the server boots, how requests enter, and how the app is assembled.

Read in this order:

1. `server/src/config.ts`
2. `server/src/index.ts`
3. `server/src/app.ts`
4. `server/src/startup-banner.ts`
5. `server/src/board-claim.ts`

What to learn from each file:

- `server/src/config.ts`
  Learn how env vars are turned into a typed runtime configuration.
- `server/src/index.ts`
  Learn the real startup order: config, database, migrations, Hippocampus runtime, HTTP server, websocket/live services, shutdown handling.
- `server/src/app.ts`
  Learn middleware order, route mounting, and how the Express app is composed.
- `server/src/startup-banner.ts`
  Learn what the server considers important enough to show at boot.
- `server/src/board-claim.ts`
  Learn the authenticated-mode bootstrap story: how the first board/admin is claimed safely.

Questions to answer for yourself after Phase 1:

- Where does the process actually begin?
- Where are migrations checked?
- Where does Hippocampus get initialized?
- In what order do middleware run?
- Where are routes mounted under `/api`?
- What is special bootstrap logic versus normal business logic?

Checkpoint:

If you can explain `startServer()` in plain English, you are past the first major hump.

---

## 3. Phase 2: Understand the Backend Shape

Goal: see how backend responsibilities are separated.

Read:

1. `server/src/services/index.ts`
2. `server/src/routes/agents.ts`
3. `server/src/services/agents.ts`
4. `server/src/routes/authz.ts`
5. `server/src/middleware/auth.ts`
6. `server/src/middleware/board-mutation-guard.ts`

What to notice:

- Route files mostly handle HTTP concerns:
  validation, auth checks, request parsing, response shaping
- Service files mostly handle domain logic:
  reads, writes, invariants, orchestration
- Middleware handles cross-cutting concerns:
  actor resolution, logging, safety guards

This repo becomes much easier once you stop expecting route files to contain the real business logic.

Focus especially on `server/src/routes/agents.ts`.
It is one of the best “map files” in the repo because it touches:

- auth
- services
- approvals
- heartbeat
- role definitions
- memory seeding
- delegation rules

Checkpoint:

You should be able to answer:

- What belongs in a route here?
- What belongs in a service here?
- How does the current actor get resolved?
- How does the code enforce company boundaries?

---

## 4. Phase 3: Trace One Feature End-to-End

Goal: build confidence by following one full request from UI to DB and back.

Best first feature: agents.

Trace this path:

1. `ui/src/App.tsx`
2. `ui/src/pages/Agents.tsx`
3. `ui/src/pages/AgentDetail.tsx`
4. `ui/src/api/*` files used by those pages
5. `server/src/routes/agents.ts`
6. `server/src/services/agents.ts`
7. `packages/shared/src/index.ts`
8. `packages/db/src/schema/index.ts`

What to learn:

- how frontend routes map to pages
- how pages call API wrappers
- how API wrappers hit backend routes
- how backend routes call services
- how shared types/constants keep UI and server aligned
- how persisted entities map back to schema tables

Exercise:

Pick one agent action and trace it completely.

Good examples:

- list agents
- create agent
- update agent
- wake an agent
- view agent detail

Write down:

1. which UI component triggers it
2. which frontend API function it uses
3. which backend route handles it
4. which service executes it
5. which tables it reads/writes

Do this once carefully and the rest of the repo gets dramatically easier.

---

## 5. Phase 4: Learn the Heartbeat Engine

Goal: understand the most important runtime loop in the system.

Read:

1. `server/src/services/heartbeat.ts`
2. `server/src/adapters/index.ts`
3. the adapter package for the runtime you care about most
4. `server/src/services/workspace-runtime.ts`
5. `server/src/services/execution-workspace-policy.ts`

What heartbeat is doing conceptually:

- decides whether an agent should run
- gathers execution context
- prepares workspace/runtime state
- chooses the adapter
- launches the agent execution
- streams/logs results
- writes run state back to the database
- emits live events
- extracts memory after the run

This file is large, so do not try to memorize it.
Read it in passes:

1. public API surface
2. run lifecycle
3. adapter handoff
4. persistence/logging
5. cleanup/recovery

Questions to answer:

- What is a heartbeat run?
- How does Paperclip know an agent is running?
- Where do adapter executions plug in?
- How are logs and token usage captured?
- Where does memory extraction happen after a run?

Checkpoint:

If you can explain a single heartbeat from “wake agent” to “run finished”, you understand one of the hardest parts of the repo.

---

## 6. Phase 5: Understand Contracts and Persistence

Goal: learn how type and schema changes ripple across the monorepo.

Read:

1. `packages/shared/src/index.ts`
2. `packages/shared/src/constants.ts`
3. `packages/shared/src/types/*`
4. `packages/shared/src/validators/*`
5. `packages/db/src/schema/index.ts`
6. a few concrete schema files like:
   - `packages/db/src/schema/agents.ts`
   - `packages/db/src/schema/issues.ts`
   - `packages/db/src/schema/heartbeat_runs.ts`

What to learn:

- `packages/shared` is the cross-layer contract package
- `packages/db` is the persistence truth
- when a feature changes, UI/server/shared/db usually all need to move together

A good mental model:

- `packages/db`: what exists in storage
- `packages/shared`: what the app agrees things mean
- `server`: how the system behaves
- `ui`: how humans see and drive it

Exercise:

Pick one concept like `Agent`, `Issue`, or `HierarchySnapshot` and find it in:

1. db schema
2. shared type
3. server route/service
4. UI page/component

That is how you build full-stack fluency in this repo.

---

## 7. Phase 6: Understand Memory and Hippocampus

Goal: understand where “memory” fits without confusing it with the core control plane.

Read:

1. `server/src/services/hippocampus-bridge.ts`
2. `server/src/services/memory-lifecycle.ts`
3. `server/src/services/delegation-memory.ts`
4. `server/src/routes/memory.ts`
5. `services/hippocampus-runtime/python/`

What to learn:

- Paperclip is the control plane
- Hippocampus is the memory runtime
- the server talks to Hippocampus through a bridge layer
- memory is pulled before runs and extracted after runs
- not all product behavior is “memory”; memory is one subsystem among many

Focus on these ideas:

- bridge contract
- embedded runtime lifecycle
- recall before run
- extraction after run
- production backends like Postgres, Redis, pgvector, Neo4j

Checkpoint:

You should be able to answer:

- What is the boundary between server and Hippocampus?
- Why is there a bridge?
- When does memory influence an agent run?
- What does the Python runtime own that the TypeScript server does not?

---

## 8. Phase 7: Understand Governance and Org Modeling

Goal: understand how Paperclip models employees, hierarchy, roles, and approvals.

Read:

1. `server/src/services/role-definitions.ts`
2. `server/src/services/delegation-guard.ts`
3. `server/src/services/spawn-governance.ts`
4. `server/src/services/hierarchy.ts`
5. `server/src/routes/roles.ts`
6. `server/src/routes/hierarchy.ts`
7. `server/src/routes/issues.ts`

Why this matters:

This repo is not just “run an LLM agent”.
It is trying to model an AI company with:

- employees
- reporting structure
- assignment authority
- approvals
- governance

That is a big part of what makes Paperclip different from a normal agent runner.

Questions to answer:

- What is the difference between role definition and agent record?
- What is the difference between org hierarchy and task delegation?
- How are assignment permissions enforced?
- What actions require approval?

---

## 9. Phase 8: Understand the Frontend as a System Map

Goal: use the UI to reinforce your backend understanding.

Read:

1. `ui/src/App.tsx`
2. `ui/src/components/Layout.tsx`
3. `ui/src/context/CompanyContext.tsx`
4. pages for the domains you already studied:
   - `ui/src/pages/Agents.tsx`
   - `ui/src/pages/AgentDetail.tsx`
   - `ui/src/pages/Issues.tsx`
   - `ui/src/pages/OrgChart.tsx`
   - `ui/src/pages/Memory.tsx`

How to think about the UI:

- `App.tsx` is the route map
- page files are domain entrypoints
- component files are reusable view pieces
- `api/` is the HTTP boundary to the backend
- `context/` holds cross-page app state

The UI is useful as a navigation tool even when your real target is backend understanding.

---

## 10. A 7-Day Learning Schedule

If you want a concrete plan, use this.

### Day 1: Product and architecture

Read:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `doc/Architecture.md`

Output:

- explain Paperclip in 5 sentences
- explain what a company, agent, heartbeat, and goal are

### Day 2: Server startup

Read:

- `server/src/config.ts`
- `server/src/index.ts`
- `server/src/app.ts`
- `server/src/board-claim.ts`

Output:

- explain boot flow from process start to listening server

### Day 3: One route deeply

Read:

- `server/src/routes/agents.ts`
- `server/src/services/agents.ts`
- `server/src/middleware/auth.ts`
- `server/src/routes/authz.ts`

Output:

- trace one agent request from HTTP to DB

### Day 4: Heartbeat

Read:

- `server/src/services/heartbeat.ts`
- `server/src/adapters/index.ts`
- one adapter package

Output:

- explain one full run lifecycle

### Day 5: Data model

Read:

- `packages/shared/src/index.ts`
- `packages/shared/src/constants.ts`
- `packages/db/src/schema/index.ts`
- 3 schema files tied to a feature you know

Output:

- explain how contract and schema changes propagate

### Day 6: Memory

Read:

- `server/src/services/hippocampus-bridge.ts`
- `server/src/services/memory-lifecycle.ts`
- `server/src/routes/memory.ts`
- `services/hippocampus-runtime/python/`

Output:

- explain the Paperclip/Hippocampus boundary

### Day 7: Governance and org

Read:

- `server/src/services/role-definitions.ts`
- `server/src/services/delegation-guard.ts`
- `server/src/services/spawn-governance.ts`
- `server/src/services/hierarchy.ts`

Output:

- explain how Paperclip models an AI company rather than just a bag of agents

---

## 11. Best Way to Read Code in This Repo

Use this method every time:

1. Start from a user-visible behavior.
2. Find the UI page.
3. Find the frontend API call.
4. Find the backend route.
5. Find the service call.
6. Find the DB tables or external runtime it touches.
7. Then come back up and read tests.

That is much better than trying to “read the backend” abstractly.

Helpful commands:

```sh
rg "agentRoutes" server/src
rg "heartbeatService" server/src
rg "getById" server/src/services
rg "Route path=" ui/src/App.tsx
rg "export { agents }" packages/db/src/schema
```

---

## 12. What Not to Do

- Do not start with the biggest file and try to understand every line.
- Do not read all services alphabetically.
- Do not treat Hippocampus as the whole system.
- Do not ignore product docs and jump straight to code.
- Do not assume route files are the main logic.

---

## 13. Milestones That Mean You Really Understand the Repo

You are making real progress when you can do these without guessing:

1. Explain startup from `server/src/index.ts`
2. Explain request flow through `server/src/app.ts`
3. Trace an agent feature end-to-end
4. Explain a heartbeat run lifecycle
5. Explain how a schema change affects shared, server, and UI layers
6. Explain where Hippocampus begins and ends
7. Explain why org structure and delegation are first-class in the product

---

## 14. Recommended Next Deep Dives After This

Once this path feels comfortable, the best next files are:

1. `server/src/app.ts`
2. `server/src/routes/agents.ts`
3. `server/src/services/heartbeat.ts`
4. `ui/src/App.tsx`
5. `server/src/services/memory-lifecycle.ts`

If you master those, the rest of the repo stops looking like a giant monorepo and starts looking like a set of connected systems.
