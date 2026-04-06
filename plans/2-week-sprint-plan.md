# Arceus — 2-Week Execution Plan

> **Period:** April 7 — April 20, 2026
> **Goal:** Make Arceus a real product — multi-sprint, memory across sprints, cost-tracked, verified, deployable
> **Starting point:** Specs 0, 1, 2, 3, 4, 8 implemented. Sprint 1 works end-to-end. NO sprint cycle, NO memory, NO cost tracking, NO verification.

---

## What Works Right Now

- CEO chat with streaming ✅
- Strategy generation + approval ✅
- Agent execution (Developer builds code) ✅
- Preview iframe ✅
- Dashboard with CEO chat + sprint progress ✅
- Supabase Postgres persistence ✅
- Git workspace + Supabase Storage bundles ✅

## What's Broken (Pain Points in Order of Severity)

### P0: Company is a one-shot machine
Sprint 1 finishes. Nothing happens. No Sprint 2 proposal. No between-sprints state. The company is effectively dead after one sprint. **Spec 06 (Sprint Cycle) was not implemented.**

### P1: Sprint 2 agents have amnesia
Even if Sprint Cycle worked, agents would start Sprint 2 with zero memory of Sprint 1. Developer re-discovers the tech stack. CTO re-plans architecture. Tokens wasted, consistency lost. **No Hippocampus.**

### P2: No cost visibility
Azure tokens burn silently. No tracking, no alerts, no budget. A retry loop can drain $20 in minutes with nobody noticing. **No budget system.**

### P3: Broken code reaches the board
Developer writes code → orchestrator marks done → board sees blank page. No build check, no test check. **No verification gate.**

### P4: Transient failures kill sprints
One Azure rate limit or Supabase hiccup → sprint crashes. No retry, no fallback. **No resilience.**

### P5: Can't host anywhere
Everything is localhost. No Docker, no health check, no deployment path. **Can't demo without screen-sharing.**

### P6: Board is blind during execution
5-15 minutes of "executing..." with minimal visibility. Can't see what agents are doing. **SSE only, no real-time agent visibility.**

### P7: No institutional knowledge
No living company docs. Decisions scatter across artifacts. Sprint 5 doesn't know what Sprint 1 decided. **No company documents, no belief system.**

---

## Week 1: Make It Real (April 7-13)

The theme: **A company that survives Sprint 1 and gets smarter.**

### Day 1-2: Sprint Cycle (Spec 06) — THE CRITICAL PATH

Without this, nothing else matters. Company must be able to continue.

**What to build:**
- Sprint completion detection (all tasks done → status: reviewing)
- Board review approval → status: completed
- Between-sprints state in store
- CEO Sprint N+1 proposal (analyzes artifacts + chat + failures → proposes next sprint as strategy_proposal card)
- Board approval of next sprint → creates Sprint N+1 tasks → orchestrator executes
- Sprint numbering (1, 2, 3...)
- Sprint-aware orchestrator (executeSprint reads sprint.id, scopes tasks)
- `sprint-manager.ts` service (or extend orchestrator)

**API changes:**
- `POST /api/board-review/approve` → triggers sprint completion + CEO proposal
- Sprint status tracking in dashboard

**Verify:** Create company → Sprint 1 → approve → CEO proposes Sprint 2 → approve → Sprint 2 executes on top of Sprint 1's code.

### Day 2-4: Hippocampus Core (Spec 05a) — MVP Scope

Sprint Cycle makes Sprint 2 possible. Hippocampus makes Sprint 2 smart.

**MVP scope (2 tiers + 2 LLM calls instead of full 5+4):**
- **Static memory** (pgvector) — permanent facts: "We use Next.js", "Supabase for DB"
- **Dynamic memory** (pgvector, decays) — temporary context: "Sprint 2 focuses on auth"
- **Extraction** (LLM call #1, gpt-4o) — extract facts from agent output on task completion
- **Action decision** (LLM call #2, gpt-4o) — ADD/UPDATE/DELETE/NONE per fact
- **Retrieval** (pgvector cosine + tier boosting) — basic MMR, top_k=5
- **Embedding** (@xenova/transformers, local, free)

**Skip for now (add in Week 2 or Week 3):**
- Working memory (Redis) — agents work fine without ephemeral scratch space
- Procedural memory (habits) — nice but not blocking Sprint 2
- Priming (confidence/morale) — polish, not core
- Habit matching LLM call — skipped with procedural
- Priming generation LLM call — skipped with priming

**Integration:** 2 touch points in orchestrator:
```
prepareAgentContext(agentId, taskDescription) → { memories: string[] }
processTaskCompletion(agentId, taskId, { output, outcome }) → void
```

**Verify:** Sprint 1 builds quiz app. Sprint 2 Developer's context includes "Framework: Next.js", "Database: Supabase" from Sprint 1.

### Day 4-5: Budget & Cost Control (Spec 10) — Essential Safety

**What to build:**
- `cost-tracker.ts` — trackCost(), checkBudget(), getCompanySpend()
- `cost-config.ts` — Azure pricing table, computeCostCents()
- Wire into `azure-openai.ts` — extract response.usage, call trackCost()
- Wire into `ceo.ts`, `chat.ts` — track CEO and strategy costs
- Wire into orchestrator — estimated tracking for OpenCode calls
- $20 default budget on company creation
- Pre-task budget check in orchestrator
- Hard stop at 100% (block all dispatch, CEO posts warning)
- Warning thresholds: 50/75/90% events
- 3 API routes: GET /api/budget, GET /api/budget/breakdown, PATCH /api/budget

**Verify:** Run sprint. GET /api/budget returns real spend. Set budget to $1, verify hard stop.

### Day 5-6: Verification Gate (Spec 09) — Quality Floor

**What to build:**
- `verification-gate.ts` — runVerificationGate() with npm run build + npm run test
- Update orchestrator: run gate after Developer completes (before board review)
- Failure → Developer retry with error context (max 2 retries, then CTO escalation)
- Gate results stored as artifact

**Tester agent (Quinn) parallel execution — defer to Week 2.** For now, just the orchestrator gate (build + test if test script exists). Quinn writing tests is an enhancement on top.

**Verify:** Developer writes broken code → gate catches build failure → retries → if still broken, escalates.

### Day 6-7: Circuit Breaker + Delegation Memory

**Circuit Breaker (PG-8, 1 day):**
- `apps/api/src/utils/retry.ts` — withRetry() decorator + CircuitBreaker class
- Apply to: Azure OpenAI calls, Supabase operations, OpenCode session calls
- Retry: 3 attempts, exponential backoff (1s, 2s, 4s)
- Circuit breaker: open after 5 failures, cooldown 30s

**Delegation Memory (Spec 07, 1 day):**
- Extend `prepareAgentContext()` with optional `delegatorAgentId`
- Query delegator's shared/board memories (top_k=3, MMR)
- Copy into agent's context as "[from Lin/CTO]" marked memories
- Context budget: 5 own + 3 delegated = 8 max

**Verify:** CTO decides "use JWT for auth" → Developer sees "[from Lin/CTO] use JWT for auth" in Sprint 2 context.

---

## Week 2: Make It Hostable and Polished (April 14-20)

The theme: **Something you can put on a URL and show people.**

### Day 8-9: Deployment & Infrastructure (Spec 11)

**What to build:**
- `Dockerfile` — multi-stage: Node 22 + TS compile + minimal runtime
- `docker-compose.yml` — Arceus API + Redis (Supabase external)
- `docker/entrypoint.sh` — run Drizzle migrations, validate env, start server
- `GET /api/health` — checks Supabase + Redis + OpenCode
- `.env.example` — complete with all vars documented
- Sprint crash recovery: on startup, detect `status: 'executing'` sprints → mark as failed or resume

**Verify:** `docker compose up` → health check passes → create company → Sprint 1 works.

### Day 9-10: Product Preview & Hosting (Spec 12)

**What to build:**
- Extend `preview.ts` for multi-company port isolation
- Framework detection: read package.json → pick build + start commands
- Preview process lifecycle: start after execution, keep alive during review, kill on reset
- Reverse proxy config (Caddy or nginx) for preview URLs
- Fallback: serve static files if framework unknown

**Verify:** Sprint completes → preview auto-starts on random port → dashboard iframe loads the generated app.

### Day 10-11: Company Documents (PG-6) + Belief System (V3-11)

**Company Docs (PG-6, 1.5 days):**
- `company_documents` table: type (tech_notes, product_overview, brand_voice), content, version
- Auto-created empty templates on company bootstrap
- Agents update relevant docs after task completion (CTO → tech_notes, PM → product_overview)
- Injected into agent context alongside memories
- Dashboard view for docs

**Belief System (V3-11, 0.5 day):**
- Company beliefs extracted from strategy approval (CEO's rationale, CTO's tech choices)
- Stored as special static memories with `source_type = 'belief'`
- Highest retrieval priority (above regular statics)
- Injected first in agent prompt: "Company beliefs: ..."

**Verify:** After Sprint 1, tech_notes contains "Next.js 15, Supabase, Tailwind". Sprint 2 CTO reads it before planning.

### Day 11-12: Hippocampus Full Tiers + Tester Agent

**Complete Hippocampus (add what we skipped in Week 1):**
- Working memory (Redis TTL per task)
- Procedural memory (habits) + LLM trigger matching
- Priming (confidence/morale) + LLM disposition generation
- Memory GC background job (every 6h): expire temporals, decay dynamics, prune stale

**Tester Agent (from Spec 09):**
- Quinn runs in parallel with Developer
- Writes happy-path test files from CTO's plan
- Orchestrator creates Tester task automatically per sprint
- Tests accumulate across sprints = regression suite

**Verify:** Sprint 1 Developer + Tester parallel → gate runs build + test → Sprint 2 Tester writes new tests, Sprint 1 tests catch regressions.

### Day 12-13: WebSocket + Dashboard Polish (PG-7)

**WebSocket (1.5 days):**
- Replace or supplement SSE with WebSocket per company
- Pipe OpenCode event stream → Redis pub/sub → WebSocket → dashboard
- Events: agent_started, tool_call, tool_result, agent_completed, task_status_changed
- Dashboard shows: "Jules (Developer) is calling create_file..." live

**Dashboard polish (0.5 day):**
- Budget widget (progress bar, per-sprint cost)
- Sprint history with snapshot list
- Verification gate status (passed/failed badge)
- Agent memory indicators (how many memories per agent)

### Day 14: End-to-End Testing + Bug Fixes

Full lifecycle test:
1. Create company → CEO chat → strategy → approve
2. Sprint 1 executes → Tester writes tests → gate passes → preview works → board approves
3. CEO proposes Sprint 2 → board approves → Sprint 2 executes
4. Sprint 2 agents have Sprint 1 memories
5. Budget shows real costs
6. Kill server → restart → state restored from Supabase
7. Rollback to Sprint 1 works
8. Export tarball downloads

Fix whatever breaks. This is buffer day.

---

## What Ships on April 20

- [x] Multi-sprint companies (Sprint 1 → Sprint 2 → Sprint 3)
- [x] Agent memory across sprints (Hippocampus 5 tiers)
- [x] CTO context flows to Developer (delegation memory)
- [x] Build + test verification before board review
- [x] Tester agent writes tests parallel with Developer
- [x] $20 budget with hard stop, per-call Azure tracking
- [x] Retry + circuit breaker on all external calls
- [x] Company documents that evolve across sprints
- [x] Company belief system from strategy
- [x] Docker deployment with health checks
- [x] Product preview serving
- [x] WebSocket real-time agent visibility
- [x] Dashboard with budget, sprint history, verification status
- [x] Sprint crash recovery on server restart

## What Does NOT Ship (Week 3+)

| Item | Why Deferred |
|------|-------------|
| Auth & multi-tenancy (Spec 13) | Single-user works for demo/testing. Add before public launch. |
| Billing & credits (PG-4) | Need auth first. Budget tracking is sufficient for now. |
| Per-company infra (PG-1) | Big project (GitHub + Render + Neon). Products run locally for now. |
| Browser agent (PG-5) | Cool but not core. No web scraping/automation needed for MVP. |
| RAG pipeline upgrade (PG-2) | Basic pgvector works. Reranking + hybrid search is optimization. |
| Tool registry (PG-3) | OpenCode handles tools. Formal registry is for extensibility. |
| Meetings (V3-3) | Agents communicate through artifacts and delegation. Standups are enhancement. |
| Sub-agent spawning (V3-1) | OpenCode sessions work fine. Sub-agents are orchestration complexity. |
| A2A protocol (V3-2) | Orchestrator-driven dispatch works. Agent-to-agent messaging is post-MVP. |
| Meta Ads, Social, Email (PG-9,10,11) | Marketing stack. Build when there are users to market. |
| Autonomy levels (V3-9) | Fixed at Level 1 (board approves everything). Increase later. |
| Pipeline stages (V3-12) | Nice UX. Not blocking anything. |
| Observability (Spec 14) | console.log + cost tracking for now. Structured logging later. |
| Security sandboxing (Spec 15) | Acceptable risk at single-user scale. |

---

## Dependency Chain

```
Day 1-2: Sprint Cycle ←── CRITICAL PATH (nothing works without this)
    │
    ├── Day 2-4: Hippocampus (needs sprints to be useful across sprints)
    │     │
    │     └── Day 6: Delegation Memory (extends Hippocampus)
    │           │
    │           └── Day 11-12: Full tiers + Tester (extends Hippocampus)
    │
    ├── Day 4-5: Budget (needs orchestrator executing to track costs)
    │
    ├── Day 5-6: Verification Gate (needs orchestrator executing)
    │
    └── Day 6: Circuit Breaker (independent utility, apply to everything)

Day 8-9: Deployment (needs everything above working)
    │
    └── Day 9-10: Preview Hosting (needs deployment infra)

Day 10-11: Company Docs + Beliefs (needs persistence + Hippocampus)

Day 12-13: WebSocket + Dashboard (needs all data flowing)

Day 14: E2E testing (needs everything)
```

**Critical path:** Sprint Cycle → Hippocampus → Budget → Verification → Deploy

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sprint Cycle takes >2 days | Medium | Delays everything | Sprint manager can be minimal: completion detection + CEO proposal + Sprint 2 creation. Polish between-sprints UX later. |
| Hippocampus MVP scope creep | High | Eats Week 1 | Strict 2-tier + 2-LLM scope. No habits, no priming in Week 1. Add in Day 11-12. |
| OpenCode sessions don't report token usage | Known | Estimated costs for agent calls | Already planned: estimateTokens() fallback. tracking_method field. |
| Docker build fails with OpenCode | Medium | Blocks deploy | Test Docker build on Day 7 (buffer). OpenCode may need separate container. |
| Verification gate always fails (agents write bad code) | Medium | Sprint never completes | Max 2 retries + CTO escalation. Gate can be disabled as escape hatch. |
| Too many integration points in Week 1 | High | Bugs compound | Test after each day's work. Don't move to next item until current one works end-to-end. |
