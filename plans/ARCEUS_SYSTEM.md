# ARCEUS_SYSTEM — Complete Remaining Build Scope

> **Date:** 2026-04-06
> **Context:** Specs 0, 1, 2, 3, 4, 6, 8 are being implemented by cofounder today.
> **This doc covers:** Everything that remains — specs 5a, 5b, 7, 9, 10, 11-15, and Polsia competitive gaps.
> **Purpose:** Single reference doc for prioritization and sprint planning.

---

## Table of Contents

1. [Status Overview](#1-status-overview)
2. [Spec 05a: Hippocampus Core](#2-spec-05a-hippocampus-core)
3. [Spec 05b: Hippocampus Intelligence](#3-spec-05b-hippocampus-intelligence)
4. [Spec 07: Delegation Memory](#4-spec-07-delegation-memory)
5. [Spec 09: Product Verification](#5-spec-09-product-verification)
6. [Spec 10: Budget & Cost Control](#6-spec-10-budget--cost-control)
7. [Spec 11: Deployment & Infrastructure](#7-spec-11-deployment--infrastructure)
8. [Spec 12: Product Preview & Hosting](#8-spec-12-product-preview--hosting)
9. [Spec 13: Auth & Multi-Tenancy](#9-spec-13-auth--multi-tenancy)
10. [Spec 14: Observability](#10-spec-14-observability)
11. [Spec 15: Security & Sandboxing](#11-spec-15-security--sandboxing)
12. [Polsia Gap: Per-Company Infrastructure](#12-polsia-gap-per-company-infrastructure)
13. [Polsia Gap: Retrieval/RAG Pipeline](#13-polsia-gap-retrievalrag-pipeline)
14. [Polsia Gap: Tool Registry](#14-polsia-gap-tool-registry)
15. [Polsia Gap: Billing & Credits](#15-polsia-gap-billing--credits)
16. [Polsia Gap: Browser Agent](#16-polsia-gap-browser-agent)
17. [Polsia Gap: Company Documents](#17-polsia-gap-company-documents)
18. [Polsia Gap: WebSocket Bidirectional](#18-polsia-gap-websocket-bidirectional)
19. [Polsia Gap: Circuit Breaker & Retry](#19-polsia-gap-circuit-breaker--retry)
20. [Polsia Gap: Meta Ads Engine](#20-polsia-gap-meta-ads-engine)
21. [Polsia Gap: Twitter/Social Posting](#21-polsia-gap-twittersocial-posting)
22. [Polsia Gap: Email Outbound](#22-polsia-gap-email-outbound)
23. [Polsia Gap: Night Shift / Autonomous Execution](#23-polsia-gap-night-shift--autonomous-execution)
24. [Polsia Gap: Recurring Tasks](#24-polsia-gap-recurring-tasks)
25. [Polsia Gap: Agent Routing (LLM)](#25-polsia-gap-agent-routing-llm)
26. [Polsia Gap: Rate Limiting](#26-polsia-gap-rate-limiting)
27. [Polsia Gap: Security Middleware](#27-polsia-gap-security-middleware)
28. [Polsia Gap: Magic Links](#28-polsia-gap-magic-links)
29. [Polsia Gap: Referral System](#29-polsia-gap-referral-system)
30. [Polsia Gap: Content Agent](#30-polsia-gap-content-agent)
31. [Polsia Gap: Growth Agent](#31-polsia-gap-growth-agent)
32. [Polsia Gap: fal.ai Media Generation](#32-polsia-gap-falai-media-generation)
33. [Dependency Graph](#33-dependency-graph)
34. [Effort Estimates](#34-effort-estimates)
35. [v3.4 Gaps: Constructs Missing from Current Implementation](#35-v34-gaps-constructs-missing-from-current-implementation)

---

## 1. Status Overview

### Done Today (Cofounder Implementing)

| Spec | Title | What It Delivers |
|------|-------|-----------------|
| 00 | System Architecture | Runtime topology, data flow, file structure |
| 01 | Onboarding to Kickoff | Company creation → CEO chat → strategy → team hire |
| 02 | Agent Execution | Orchestrator, parallel agents, artifact handoff |
| 03 | Living Dashboard | Single-page CEO chat + preview + sprint progress |
| 04 | Persistence | Supabase Postgres (19 tables), Drizzle ORM, packages/db |
| 06 | Sprint Cycle | Sprint lifecycle, CEO proposals, numbering |
| 08 | Product Storage | Git per company, Supabase Storage bundles, workspace manager |

### Remaining (This Doc)

| Spec | Title | Category | Effort |
|------|-------|----------|--------|
| 05a | Hippocampus Core | Memory | 3-4 days |
| 05b | Hippocampus Intelligence | Memory (post-MVP) | 2-3 days |
| 07 | Delegation Memory | Memory | 1-2 days |
| 09 | Product Verification | Quality | 2-3 days |
| 10 | Budget & Cost Control | Finance | 2-3 days |
| 11 | Deployment & Infrastructure | Ops | 2-3 days |
| 12 | Product Preview & Hosting | Product | 2-3 days |
| 13 | Auth & Multi-Tenancy | Security | 3-4 days |
| 14 | Observability | Ops | 2-3 days |
| 15 | Security & Sandboxing | Security | 2-3 days |
| PG-1 | Per-Company Infra Provisioning | Polsia Gap | 5-7 days |
| PG-2 | Retrieval/RAG Pipeline | Polsia Gap | 3-5 days |
| PG-3 | Tool Registry | Polsia Gap | 3-5 days |
| PG-4 | Billing & Credits | Polsia Gap | 5-7 days |
| PG-5 | Browser Agent | Polsia Gap T2 | 3-5 days |
| PG-6 | Company Documents | Polsia Gap T2 | 2-3 days |
| PG-7 | WebSocket Bidirectional | Polsia Gap T2 | 2-3 days |
| PG-8 | Circuit Breaker & Retry | Polsia Gap T2 | 1-2 days |
| PG-9 | Meta Ads Engine | Polsia Gap T3 | 7-10 days |
| PG-10 | Twitter/Social Posting | Polsia Gap T3 | 3-5 days |
| PG-11 | Email Outbound | Polsia Gap T3 | 3-5 days |
| PG-12 | Night Shift / Autonomous | Polsia Gap T3 | 2-3 days |
| PG-13 | Recurring Tasks | Polsia Gap T3 | 2-3 days |
| PG-14 | Agent Routing (LLM) | Polsia Gap T3 | 2-3 days |
| PG-15 | Rate Limiting | Polsia Gap T3 | 0.5-1 day |
| PG-16 | Security Middleware | Polsia Gap T3 | 2-3 days |
| PG-17 | Magic Links | Polsia Gap T3 | 0.5-1 day |
| PG-18 | Referral System | Polsia Gap T3 | 1-2 days |
| PG-19 | Content Agent | Polsia Gap T3 | 1-2 days |
| PG-20 | Growth Agent | Polsia Gap T3 | 1-2 days |
| PG-21 | fal.ai Media Generation | Polsia Gap T3 | 1-2 days |

---

## 2. Spec 05a: Hippocampus Core

> **Full spec:** `plans/specs/05a-hippocampus-core.md`

### What It Is

The brain of every agent. Turns stateless LLM sessions into employees who remember, learn behaviors, and maintain emotional continuity across sprints. Without it, Sprint 2's Developer asks "What framework are we using?" — with it, they already know.

### Scope

- **5 memory tiers:** Working (Redis), Static (pgvector, permanent), Dynamic (pgvector, decays), Procedural (habits), Priming (confidence/morale)
- **4 LLM call sites:** Habit trigger eval, priming disposition, fact extraction, action decision
- **~1000 lines TypeScript**

### Architecture

```
packages/hippocampus/
  src/
    index.ts              — Public API: prepareAgentContext, processTaskCompletion, runGC
    tiers/
      working.ts          — Redis TTL store
      static.ts           — pgvector permanent facts
      dynamic.ts          — pgvector + decay scoring
      procedural.ts       — Habits CRUD + LLM trigger matching
      priming.ts          — EMA state + LLM disposition
    engines/
      extractor.ts        — LLM fact extraction + action decision (ADD/UPDATE/DELETE/NONE)
      reasoning-bank.ts   — MMR retrieval (cosine + tier boosting + diversity)
      gc.ts               — Expire, decay, prune (every 6h)
    backends/
      embedding.ts        — @xenova/transformers all-MiniLM-L6-v2 (local, free)
      llm.ts              — Azure OpenAI wrapper
      pgvector.ts         — Drizzle vector queries
```

### Three Integration Points with Orchestrator

```typescript
// BEFORE agent execution
const ctx = await hippocampus.prepareAgentContext(agentId, taskDescription);
// Returns: { memories: string[], habits: string[], priming: string }

// AFTER agent execution
await hippocampus.processTaskCompletion(agentId, taskId, { output, outcome });

// BACKGROUND (every 6 hours)
await hippocampus.runGC(companyId);
```

### Key Flows

**Flow A — Task Start (Retrieve):** Embed task → pgvector search → tier/scope boosting → MMR diversity → match habits (LLM #1) → generate priming (LLM #2) → bundle into agent prompt

**Flow B — Task Complete (Extract):** LLM extracts facts (LLM #3) → for each: embed + search similar → LLM decides action (LLM #4: ADD/UPDATE/DELETE/NONE) → execute → update priming EMA → increment habit usage

**Flow C — GC (Every 6h):** Expire temporals → decay dynamics (half-life 30d) → prune stale → deactivate unused habits

### Cost Per Task: ~$0.02-0.03

### Dependencies

- Spec 04 tables: `memory_units`, `habits`, `patterns`, `priming_state` (pgvector extension)
- Redis for working memory
- Azure OpenAI for gpt-4o (extraction) and gpt-4o-mini (classification)
- @xenova/transformers for local embeddings

### Polsia Comparison

Polsia has 3-layer flat text memory with periodic summarization (~20 messages). Our Hippocampus is architecturally superior — per-agent isolation, vector embeddings, habits, priming. But Polsia's retrieval pipeline (5-stage: chunk → embed → hybrid search → rerank → assemble) is better than our raw pgvector cosine. Consider combining our memory architecture with their retrieval approach (see PG-2).

---

## 3. Spec 05b: Hippocampus Intelligence

> **Full spec:** `plans/specs/05b-hippocampus-intelligence.md`
> **Status:** POST-MVP — implement after 05a is stable

### What It Adds

Self-improving memory. Knowledge consolidates automatically. Patterns emerge from repeated success. Important dynamic facts get promoted to static.

### Components

**PatternLearner:**
- Extract patterns from successful task trajectories
- k-means clustering on embeddings
- EMA success_rate evolution on reuse
- Merge >90% similar patterns (LLM synthesis)
- Auto-form habits from high-success patterns (usage >= 10, success >= 0.8)

**PromotionEngine:**
- Scan dynamics meeting threshold: access_count >= 10, confidence >= 0.8, age >= 14 days
- LLM contradiction check against existing statics
- Promote to static if no contradiction (7-day probation)
- 60-day unused demotion
- Max 5 promotions per cycle per agent

**Full Consolidation:**
- Dedup: cosine > 0.95 → keep highest confidence
- Contradiction detection: cosine > 0.80 → LLM verify
- Merge synthesis: combine similar memories/patterns
- Habit naming from pattern data

### 6 Additional LLM Calls (all gpt-4o-mini, background)

### Why Post-MVP

Layer A+B gives agents memory across sprints. Layer C makes Sprint 10 better but doesn't block Sprint 2-5. Better to ship stable A+B than buggy A+B+C.

---

## 4. Spec 07: Delegation Memory

> **Full spec:** `plans/specs/07-delegation-memory.md`

### What It Is

When a task flows down hierarchy (CEO → CTO → Developer), the delegator's relevant reasoning context is injected into the delegatee's prompt. Artifacts carry the PLAN. Delegation memory carries the REASONING.

### Core Design: COPY, Never Reference

1. Query delegator's memories relevant to the task (MMR, top_k=3)
2. COPY into task-scoped container (not reference — isolated)
3. Agent reads from task scope during execution
4. After task completes, copies auto-expire (7-day TTL)

### Context Budget

- 5 own memories + 3 delegated = 8 total in prompt
- Only shared/board visibility (private stays private)
- Confidence discount: 0.9× on delegated memories
- MVP: one hierarchy level only (immediate manager)

### Implementation

Extension of `prepareAgentContext()` with optional `delegatorAgentId` parameter. Orchestrator determines delegator from agent's `reportsTo` field.

### Zero New LLM Calls, Zero New Tables

Reuses existing embedding, pgvector search, MMR algorithm. Uses existing `memory_units` table with `source_type = 'delegation'`.

### Dependencies

- Spec 05a (Hippocampus must be working first)
- Agent hierarchy in database (reportsTo relationships)

---

## 5. Spec 09: Product Verification

> **Full spec:** `plans/specs/09-product-verification.md`

### What It Is

Two-layer verification ensuring products agents build actually work.

**Layer 1 — Orchestrator Gates (automated):**
- `npm run build` — does it compile?
- `npm run test` — do tests pass?
- Runs after Developer + Tester both finish (parallel execution)

**Layer 2 — Tester Agent (Quinn) writes test code:**
- Runs in PARALLEL with Developer (Option B)
- Writes happy-path tests from CTO's plan (not from implementation)
- 3-8 test files per sprint, co-located with source
- Tests accumulate across sprints = free regression suite

### Execution Flow

```
CTO plan
  ├── Developer tasks (implementation)  ─┐
  └── Tester task (write tests)         ─┤ parallel
                                          │
                                          ▼
                                 Verification Gate
                                   build + test
                                          │
                               PASS → Preview → Board
                               FAIL → Developer retry (max 2)
                                          → then CTO escalation
```

### Key Rules

- **Developer fixes code, not tests** — tests are the spec
- **CTO is the only override** — can authorize test modification if test itself is wrong
- **Max 2 retries** then escalate to CTO
- **vitest as default** test runner for all JS/TS projects

### New Files

- `apps/api/src/verification-gate.ts` — Build + test gate runner (~200 lines)
- Updated Quinn SOUL prompt with test-writing instructions

### Dependencies

- Spec 02 (orchestrator for parallel task dispatch)
- Spec 06 (sprint cycle for when gate runs)

---

## 6. Spec 10: Budget & Cost Control

> **Full spec:** `plans/specs/10-budget-cost-control.md`

### What It Is

Every LLM call costs money. All calls go through the board's Azure OpenAI endpoint. Budget enforcement prevents runaway costs.

### Model

- **$20 default** company budget, board can change anytime
- **Per-company hard limit** — at 100%, ALL agents halt. Board must add funds.
- **Per-sprint soft limit** — CEO proposes, board approves. Warning on overage, no halt.
- **Warning thresholds:** 50% (info), 75% (CEO mentions), 90% (dashboard alert), 100% (hard stop)

### Cost Tracking

- **Direct Azure calls (CEO, strategy, Hippocampus):** Exact tracking — read `response.usage.prompt_tokens` and `response.usage.completion_tokens` from Azure API response
- **OpenCode agent calls (Developer, Tester, CTO):** Estimated tracking — token count from text length. Marked as `estimated` in `cost_events` table.

### Azure Pricing Table

```typescript
const AZURE_PRICING = {  // per 1K tokens in cents
  "gpt-4.1":       { input: 0.2,   output: 0.8  },
  "gpt-4.1-mini":  { input: 0.04,  output: 0.16 },
  "gpt-4o":        { input: 0.25,  output: 1.0  },
  "gpt-4o-mini":   { input: 0.015, output: 0.06 },
};
```

### Halt & Resume

Budget exhausted → all in-progress tasks blocked → CEO posts message → dashboard red alert → board adds funds → execution resumes from where it stopped.

### CEO Budget Awareness

Budget state injected into CEO's system prompt so CEO naturally mentions it in conversation.

### New Files

- `apps/api/src/cost-tracker.ts` — trackCost, checkBudget, spend queries (~250 lines)
- `apps/api/src/cost-config.ts` — Azure pricing table, computeCostCents (~60 lines)
- 5 API routes: GET /api/budget, GET /api/budget/breakdown, GET /api/budget/history, PATCH /api/budget, PATCH /api/budget/sprint/:id

### Dependencies

- Spec 04 (`cost_events` table, `companies.budget_cents/spent_cents`)
- Azure OpenAI integration (`azure-openai.ts`)

---

## 7. Spec 11: Deployment & Infrastructure

> **Status:** Planned, not written

### What It Covers

How Arceus itself runs in production.

### Key Decisions Needed

- **Dockerfile** — multi-stage build: Node 22 + TypeScript compile + minimal runtime
- **docker-compose.yml** — Arceus API + Redis (Supabase is external)
- **Entrypoint script** — run Drizzle migrations on startup, validate env vars, health check
- **Health endpoint** — `GET /api/health` checks Supabase Postgres + Redis + OpenCode connectivity
- **Crash recovery** — what happens if server dies mid-sprint? Resume from last committed state (Spec 08 enables this)
- **Environment management** — `.env.example` with complete documentation
- **Process management** — PM2 or similar for auto-restart
- **Deployment target** — Railway or Fly.io (ephemeral containers, no persistent volumes needed per Spec 08)

### Key Files to Create

- `Dockerfile`
- `docker-compose.yml`
- `docker/entrypoint.sh`
- `.env.example` (complete)
- Updated README with deployment instructions

### Dependencies

- Spec 04 (Supabase configured)
- Spec 08 (workspace manager + cold start restore)

---

## 8. Spec 12: Product Preview & Hosting

> **Status:** Planned, not written

### What It Covers

How the products agents build get served to the board via the dashboard preview iframe.

### Key Decisions Needed

- **Framework detection** — read `package.json` or file structure to determine: Next.js, Vite, Express, static HTML, Flask
- **Build & serve** — run appropriate build command + start command in a sandbox process
- **Port isolation** — each company's preview on a different port. Reverse proxy maps `preview-{companyId}.arceus.app` → `localhost:{port}`
- **Process lifecycle** — start after sprint execution, keep alive during review, kill on reset
- **Fallback** — if framework unknown, serve static files directly
- **Preview state tracking** — `preview.ts` already detects running servers; extend to manage lifecycle

### Existing Code

`apps/api/src/preview.ts` (505 lines) already handles:
- `detectLaunchCommand()` — reads package.json, detects framework
- `startLocalPreview()` — spawns child process
- Preview state tracking

Needs extension for: multi-company port isolation, lifecycle management, health monitoring.

### Dependencies

- Spec 08 (workspace manager provides local path)
- Spec 11 (deployment infrastructure for reverse proxy)

---

## 9. Spec 13: Auth & Multi-Tenancy

> **Status:** Planned, not written

### What It Covers

User accounts, company isolation, who can see what.

### Key Decisions Needed

- **Supabase Auth** — email/password + OAuth (Google, GitHub). One SDK, same project.
- **Session management** — JWT tokens, refresh flow
- **Company isolation** — every API query includes `company_id` filter. Board user can only see their company.
- **Row-Level Security** — Supabase RLS policies on all tables. Database-level enforcement, not just app-level.
- **Roles** — Owner (full control), Viewer (read-only). MVP: one owner per company.
- **API middleware** — extract user from JWT, resolve company_id, inject into all queries
- **Rate limiting** — per-user request limits to prevent abuse

### Supabase Auth Integration

```typescript
// Supabase handles:
// - Sign up / login / logout
// - OAuth providers (Google, GitHub)
// - JWT issuance and refresh
// - Session management

const { data: { user } } = await supabase.auth.signUp({ email, password });
const { data: { session } } = await supabase.auth.signInWithPassword({ email, password });
```

### RLS Policies (Example)

```sql
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own companies" ON companies
  FOR SELECT USING (
    id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );
```

### Dependencies

- Spec 04 (Supabase project exists)
- All API routes need auth middleware added

---

## 10. Spec 14: Observability

> **Status:** Planned, not written

### What It Covers

How to know what's happening, what broke, and why.

### Key Components

- **Structured JSON logging** — replace console.log with structured logger (pino). Every log has: timestamp, level, companyId, agentId, taskId, requestId.
- **Sprint crash recovery** — if server dies mid-sprint, detect on restart (check for `status = 'executing'` sprints), resume or mark as failed.
- **Error alerting** — webhook to Slack/Discord when: sprint fails, budget exhausted, agent stalls, OpenCode connection lost.
- **Request tracing** — unique requestId per API call, propagated through all service calls.
- **Cost monitoring** — real-time dashboard of Azure OpenAI spend vs budget (Spec 10 provides data).
- **Agent execution logging** — log every OpenCode session: start, events, completion, duration, token estimate.

### Dependencies

- Spec 10 (cost data for monitoring)
- Spec 02 (orchestrator status for crash recovery)

---

## 11. Spec 15: Security & Sandboxing

> **Status:** Planned, not written

### What It Covers

Agents generate and execute code. That's inherently dangerous in production.

### Key Components

- **Code execution sandbox** — Docker containers per company workspace. Agents write code inside container. No access to host filesystem, no access to Arceus's internal APIs.
- **Network isolation** — generated product's network is isolated. Can't call back to Arceus control plane.
- **Workspace boundaries** — agents can only write to their company's workspace directory. Enforced by workspace manager.
- **Secret injection** — if generated product needs API keys (Stripe, etc.), inject via env vars in sandbox. Never in source code.
- **Prompt injection defense** — validate all user input before injecting into agent prompts. Sanitize board messages.
- **Input validation** — Zod schemas on all API endpoints. Request body size limits.
- **Tenant isolation** — Row-Level Security (Spec 13). No cross-company data access.

### Dependencies

- Spec 13 (auth + tenant isolation)
- Spec 11 (Docker infrastructure)
- Spec 08 (workspace manager for boundary enforcement)

---

## 12. Polsia Gap: Per-Company Infrastructure Provisioning

> **Source:** Gap Analysis, Tier 1

### What Polsia Has

When a company is created, auto-provisions:
- **GitHub repo** — via GitHub App API. Agents push code via tree/commit API (atomic multi-file).
- **Render web service** — linked to GitHub repo. Auto-deploy on push.
- **Neon Postgres database** — serverless, per-company isolation.
- **R2 bucket** — Cloudflare R2 for media/assets.
- **Custom domains** — per-company domain setup.

`InfraProvisioner` service orchestrates all in sequence with error handling and rollback.

### What Arceus Has

Local `/workspace` directory. Code stays on server. No repo, no hosting, no per-company database.

### What to Build

```
Company created
  ├── GitHub: Create private repo (GitHub App API)
  ├── Supabase: Create project or use shared instance with RLS
  ├── Deploy target: Vercel/Railway/Fly per-company service
  ├── Storage: Supabase Storage bucket per company
  └── DNS: Optional custom domain
```

### Key Integration: GitHub App

- Create GitHub App → get app_id + private_key
- Per-company repo creation via API
- Agents push code via tree/commit API (atomic, multi-file)
- Webhook on push → trigger deployment

### Effort: 5-7 days

### Dependencies

- Spec 08 (workspace manager — extend to push to GitHub)
- Spec 11 (deployment infrastructure)
- GitHub App registration (manual, one-time)
- Render/Vercel/Fly account (manual, one-time)

---

## 13. Polsia Gap: Retrieval/RAG Pipeline

> **Source:** Gap Analysis, Tier 1

### What Polsia Has

5-stage hybrid retrieval pipeline:

```
Query → Analyze Intent → Embed → Hybrid Search (vector + BM25) → Rerank (LLM) → Assemble Context
```

| Stage | What | Cost |
|-------|------|------|
| Query analysis | LLM classifies intent | ~$0.001 |
| Embedding | OpenAI embeddings + Redis cache | ~$0.00002 |
| Hybrid search | pgvector cosine + BM25 keyword + cross-layer | Free |
| LLM reranking | gpt-4o-mini scores results | ~$0.001 |
| Context assembly | Token budget, dedup, tech-first sorting | Free |

Total: ~$0.002 per retrieval

Additional: SmartChunker (markdown/code/paragraph-aware), Redis-cached embeddings, cross-layer search.

### What Arceus Has

Raw pgvector cosine similarity with MMR diversity filter (Spec 05a). No chunking, no BM25, no reranking, no context assembly.

### What to Build

Upgrade Hippocampus retrieval engine (Spec 05a's `reasoning-bank.ts`) with:

1. **Hybrid search** — combine pgvector cosine with Postgres full-text search (tsvector/tsquery). No BM25 library needed.
2. **LLM reranking** — after initial retrieval, gpt-4o-mini re-scores top 15 results. Keep top 5.
3. **Context assembly** — respect token budget, deduplicate, prioritize technical facts over generic.
4. **Redis embedding cache** — cache embeddings by content hash. Avoid re-embedding unchanged memories.

Skip for MVP: SmartChunker (our memories are already atomic facts, not long documents), query intent analysis (adds latency, marginal value).

### Effort: 3-5 days

### Dependencies

- Spec 05a (Hippocampus must exist to upgrade)
- Redis (for embedding cache)

---

## 14. Polsia Gap: Tool Registry

> **Source:** Gap Analysis, Tier 1

### What Polsia Has

Formal tool registration system:

```python
@register_tool(
    name="create_file",
    description="Create a file in the repository",
    input_schema={...},
    mcp_server="github",
)
async def create_file(input_data, context):
    ...
```

- 17 registered tools across 8 categories
- Per-agent tool mounting (tool_permissions array)
- Per-execution auth injection (company credentials automatically injected)
- Tool whitelist per agent

### What Arceus Has

OpenCode SDK manages tools internally. Agents get permissions via `opencode.json`. No formal registry, no auth injection.

### What to Build

```typescript
// apps/api/src/tool-registry.ts

interface Tool {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  category: string;           // "github" | "deploy" | "search" | "memory"
  handler: (input, context) => Promise<any>;
  requiresAuth: boolean;
}

class ToolRegistry {
  register(tool: Tool): void;
  getToolsForAgent(agentRole: string): Tool[];
  executeTool(name: string, input: any, companyContext: any): Promise<any>;
}
```

Start with tools for: memory read/write, workspace file operations, deploy trigger. Add GitHub/browser/search tools as those integrations are built.

### Effort: 3-5 days

### Dependencies

- Core API working
- Per-company context (company_id, credentials)

---

## 15. Polsia Gap: Billing & Credits

> **Source:** Gap Analysis, Tier 2

### What Polsia Has

Complete monetization:
- Subscription tiers (Trial: 5 credits, Full Autonomy: 15-1000/mo)
- Credit system (1 task = 1 credit, monthly refresh, welcome bonus)
- Stripe subscriptions + Stripe Connect (customers' customers pay through generated app)
- Referral system (25 credits per referral)
- Ad billing (20% platform fee on Meta Ads spend)

### What Arceus Has

Budget tracking (Spec 10) — per-company limit, cost per LLM call, hard stop at 100%. No monetization.

### What to Build

**Phase 1: Stripe Subscriptions**
- Stripe Checkout for plan selection
- Subscription management (upgrade, downgrade, cancel)
- Webhook handling (payment succeeded, subscription updated, etc.)

**Phase 2: Credit System**
- Credits per task execution
- Monthly refresh on subscription renewal
- Credit balance tracking
- Prevent execution when credits exhausted

**Phase 3 (Post-MVP): Stripe Connect**
- Enable payments within generated products
- Platform fee collection
- Withdrawal to bank

### Effort: 5-7 days (Phase 1+2)

### Dependencies

- Spec 10 (budget tracking infrastructure)
- Spec 13 (auth — need user accounts before billing)
- Stripe account (manual, one-time)

---

## 16. Polsia Gap: Browser Agent

> **Source:** Gap Analysis, Tier 2

### What Polsia Has

Dedicated browser agent with Playwright:
- Navigate, click, type, fill forms, screenshot, extract DOM
- Configurable browser pool (concurrent sessions, timeouts, proxy rotation)
- Browserbase/BrowserCloud for managed scale

### What Arceus Has

Nothing. No browser capability.

### What to Build

```typescript
// packages/browser/src/index.ts

class BrowserAgent {
  async navigate(url: string): Promise<void>;
  async click(selector: string): Promise<void>;
  async type(selector: string, text: string): Promise<void>;
  async screenshot(): Promise<Buffer>;
  async extractText(selector?: string): Promise<string>;
  async fillForm(fields: Record<string, string>): Promise<void>;
}
```

- Playwright as dependency
- Browser pool manager (max concurrent, idle timeout)
- Integration as OpenCode tool or standalone service
- Screenshot storage in Supabase Storage

### Effort: 3-5 days

### Dependencies

- Playwright dependency (~200MB)
- Supabase Storage for screenshot storage
- Tool registry (PG-3) for agent integration

---

## 17. Polsia Gap: Company Documents

> **Source:** Gap Analysis, Tier 2

### What Polsia Has

Versioned, agent-writable company documents:
- Types: mission, product_overview, tech_notes, brand_voice, user_research
- Version history per edit
- Agents can update docs (engineer updates tech_notes after building)
- Injected into agent context

### What Arceus Has

Artifacts per task. No persistent company-level documents that evolve across sprints.

### What to Build

```sql
CREATE TABLE company_documents (
  id UUID PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- mission | product_overview | tech_notes | brand_voice
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,           -- 'user' | 'agent:{role}'
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE document_versions (
  id UUID PRIMARY KEY,
  document_id UUID REFERENCES company_documents(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  changed_by TEXT,
  created_at TIMESTAMPTZ
);
```

- Auto-created on company bootstrap (empty templates)
- Agents update relevant docs after task completion (engineer → tech_notes)
- Injected into agent context alongside memories
- Board can view/edit through dashboard

### Effort: 2-3 days

### Dependencies

- Spec 04 (database)
- Dashboard (display + edit UI)

---

## 18. Polsia Gap: WebSocket Bidirectional

> **Source:** Gap Analysis, Tier 2

### What Polsia Has

Full duplex WebSocket with Redis pub/sub bridge:
- Per-company channel
- Tool call visibility (dashboard shows live tool calls as agents execute)
- Streaming: message_start → content_delta → tool_call_start → tool_call_result → done
- Redis pub/sub bridges background workers → WebSocket → dashboard

### What Arceus Has

SSE for activity feed + CEO chat streaming. One-directional. No tool call visibility.

### What to Build

- Replace SSE with WebSocket (or keep SSE for simple streaming, add WebSocket for complex events)
- Add tool call events from OpenCode event stream → Redis pub/sub → WebSocket → dashboard
- Dashboard shows: agent X is calling tool Y with input Z → got result → continuing

### Effort: 2-3 days

### Dependencies

- Redis pub/sub (Spec 04)
- Dashboard (Spec 03)

---

## 19. Polsia Gap: Circuit Breaker & Retry

> **Source:** Gap Analysis, Tier 2

### What Polsia Has

```python
@retry_async(max_retries=3, delay=1.0, backoff=2.0)
async def call_external_service():
    ...

class CircuitBreaker:
    # States: closed → open → half_open → closed
    # Opens after failure_threshold consecutive failures
    # Half-open recovery after cooldown period
```

Applied to all integration clients (Azure, Supabase, OpenCode).

### What Arceus Has

Nothing. External call failures crash the operation.

### What to Build

```typescript
// apps/api/src/utils/retry.ts

function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; delay: number; backoff: number }
): Promise<T>;

class CircuitBreaker {
  constructor(opts: { failureThreshold: number; cooldownMs: number });
  async execute<T>(fn: () => Promise<T>): Promise<T>;
}
```

Apply to: Azure OpenAI calls, Supabase operations, OpenCode session management.

### Effort: 1-2 days

### Dependencies: None (utility code)

---

## 20. Polsia Gap: Meta Ads Engine

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

Full programmatic Meta (Facebook + Instagram) advertising:
- **Ad account management** — per-company Meta ad accounts with daily budgets ($10-1000/day)
- **Campaign lifecycle** — create, pause, optimize, complete. Objectives: traffic, conversions, awareness, engagement, leads
- **AI-generated creatives** — video ads generated via fal.ai, image ads, carousel formats
- **Performance tracking** — impressions, clicks, CTR, CPC, CPM, conversions, ROAS, cost per conversion
- **Daily optimization** — automated bid adjustment and audience refinement
- **Platform fee** — 20% on ad spend (revenue model)
- **Dedicated Meta Ads agent** — specialized agent managing campaigns autonomously

### Polsia Implementation

- `app/services/ads_service.py` — campaign CRUD, creative generation, performance tracking
- `app/agents/meta_ads_agent.py` — dedicated ads agent
- `app/integrations/meta_ads_client.py` — Meta Marketing API wrapper (campaign, adset, ad, creative, insights endpoints)
- `app/models/ads.py` — AdAccount, AdCampaign, AdCreative, AdPerformance, AdBillingEvent
- `app/api/ads.py` — ads routes (campaigns, performance, billing)

### Key API Integration

Meta Marketing API: campaign creation, adset management, creative upload, insights retrieval. Requires Meta App approval (takes 2-4 weeks for review).

### Effort: 7-10 days (including Meta App approval wait)

### Dependencies

- PG-4 (Billing — ad spend billing pipeline)
- PG-5 (Browser Agent — for Meta Business Manager setup)
- fal.ai integration (PG-15) for AI creative generation
- Meta App approval (external, 2-4 week lead time)

---

## 21. Polsia Gap: Twitter/Social Posting

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

- **Twitter/X auto-posting** — 1 tweet/day per company from shared @polsia account
- **Engagement tracking** — likes, retweets, replies, impressions, clicks per post
- **Twitter API v2** with OAuth 2.0
- **Social scheduling** — Late.dev integration for Instagram/TikTok/LinkedIn
- **SocialAccount model** — tracks platform, handle, daily limits, posts today, status
- **SocialPost model** — draft → scheduled → posted → engagement tracked

### Polsia Implementation

- `app/integrations/twitter_client.py` — tweet posting, engagement reading, OAuth headers
- `app/models/social.py` — SocialAccount, SocialPost, SocialEngagement
- `app/api/social.py` — posts CRUD, stats endpoint
- `app/agents/tools/social_tools.py` — `post_tweet` tool for agents

### What to Build

- Twitter API v2 integration (post tweets, read engagement)
- SocialAccount + SocialPost tables
- Agent tool for posting
- Dashboard view for social stats
- Later: Instagram, LinkedIn, TikTok via Late.dev or direct APIs

### Effort: 3-5 days

### Dependencies

- PG-3 (Tool Registry — to register social tools for agents)
- Twitter/X developer account (manual, one-time)

---

## 22. Polsia Gap: Email Outbound

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

- **Platform inbox** per company (e.g., spectra@polsia.com) with 2/day outbound limit
- **Gmail API integration** — connect user's Gmail for higher volume
- **Inbound email processing** — receive and parse incoming emails
- **Thread tracking** — reply chains, in_reply_to, thread_id
- **CompanyInbox model** — inbox_address, daily limits, Gmail connection status
- **Email model** — direction, from/to, subject, body, attachments, status, provider

### Polsia Implementation

- `app/integrations/resend_client.py` — Resend API for transactional outbound
- `app/models/email.py` — CompanyInbox, Email, EmailAttachment
- `app/api/emails.py` — send, inbox, stats endpoints
- `app/agents/tools/email_tools.py` — `send_email` tool for agents

### What to Build

- Resend integration for outbound email
- Gmail API for connected inboxes
- Email model + inbox management
- Agent email tool
- Dashboard inbox view

### Effort: 3-5 days

### Dependencies

- PG-3 (Tool Registry)
- Resend account (manual, one-time)
- Domain DNS setup for custom email addresses

---

## 23. Polsia Gap: Night Shift / Autonomous Execution

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

- **Night shift worker** — runs daily at 4 AM UTC
- Picks up ALL pending tasks for ALL active companies
- Executes sequentially with credit deduction
- Summary generated after completion
- Each company's pending queue processed in priority order

### Polsia Implementation

- `app/workers/night_shift.py` — Celery task (`run_night_shift`)
- Queries all active companies → finds pending tasks → executes via task executor → marks complete

### What to Build

- Background worker (cron-style) that runs on schedule
- Task queue processing without human trigger
- Per-company execution isolation (one company's failure doesn't block others)
- Night shift summary generation (CEO posts "here's what happened overnight")

### Effort: 2-3 days

### Dependencies

- Spec 02 (orchestrator for task execution)
- PG-4 (Billing — credit deduction per autonomous task)
- Redis/worker infrastructure

---

## 24. Polsia Gap: Recurring Tasks

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

- **Recurring task templates** — define once, auto-creates instances on schedule
- **Frequencies:** daily, weekdays, weekly (specific days), monthly (specific day)
- **RecurringTask model** — title, description, tag, frequency, days, is_active, last_run_at, next_run_at, total_runs
- **RecurringTaskInstance** — links recurring template to actual task created

### Polsia Implementation

- `app/workers/recurring.py` — Celery beat task, checks due recurring tasks, creates instances
- `app/models/task.py` — RecurringTask, RecurringTaskInstance
- `app/api/tasks.py` — recurring CRUD endpoints

### What to Build

```sql
CREATE TABLE recurring_tasks (
  id UUID PRIMARY KEY,
  company_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  agent_tag TEXT NOT NULL,
  frequency TEXT NOT NULL,       -- daily | weekdays | weekly | monthly
  days INTEGER[],                -- for weekly: [0-6] (Sun-Sat)
  day_of_month INTEGER,          -- for monthly: 1-28
  priority TEXT DEFAULT 'medium',
  is_active BOOLEAN DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  total_runs INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ
);
```

- Scheduler checks due tasks on interval (every 15 minutes)
- Creates real task from template
- Computes next_run_at based on frequency

### Effort: 2-3 days

### Dependencies

- Task system (Spec 02)
- Background worker infrastructure (same as PG-9/Night Shift)

---

## 25. Polsia Gap: Agent Routing (LLM)

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

- **AgentRouter class** — LLM-based task classification using gpt-4o-mini
- Takes task description + company context → returns best agent tag with confidence score
- **Historical performance tracking** — success rate per agent per task type
- **Confidence threshold** — if confidence < 0.5, flags for manual review
- **Fallback logic** — if primary agent fails, routes to fallback

### Polsia Implementation

- `app/services/agent_router.py` — AgentRouter with LLM classification + historical stats
- Uses JSON mode: `{"tag": "engineering|browser|research", "confidence": 0.0-1.0, "reason": "..."}`
- Queries historical task outcomes grouped by tag for success rate

### What Arceus Has

CTO plan assigns roles. Orchestrator maps role → OpenCode session. No intelligence.

### What to Build

```typescript
class AgentRouter {
  async classifyTask(description: string, companyContext: object): Promise<{
    agentTag: string;
    confidence: number;
    reason: string;
  }>;

  async getHistoricalStats(companyId: string): Promise<Record<string, {
    totalTasks: number;
    successes: number;
    successRate: number;
    avgDurationMs: number;
  }>>;
}
```

Use gpt-4o-mini for classification (~$0.0001 per routing decision). Track outcomes to improve routing over time.

### Effort: 2-3 days

### Dependencies

- Task completion data in database (Spec 04)
- Azure OpenAI for gpt-4o-mini classification

---

## 26. Polsia Gap: Rate Limiting

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

Per-route Redis-backed sliding window rate limiting:

```python
LIMITS = {
    "/api/chat": "30/min",
    "/api/tasks": "60/min",
    "/api/agents": "30/min",
    "default": "100/min",
}
```

### What Arceus Has

Nothing.

### What to Build

Fastify rate limit plugin (`@fastify/rate-limit`) with Redis backing:

```typescript
app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  redis: redisClient,
  keyGenerator: (req) => req.user?.id ?? req.ip,
});
```

Per-route overrides for sensitive endpoints (chat, execution triggers).

### Effort: 0.5-1 day

### Dependencies

- Redis
- Spec 13 (Auth — need user identity for per-user limits)

---

## 27. Polsia Gap: Security Middleware

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

Multiple security layers:
- **Tenant isolation middleware** — every request scoped to company_id via JWT
- **SQL injection detection** — rejects patterns like UNION SELECT, DROP TABLE
- **XSS protection headers** — X-Content-Type-Options, X-Frame-Options, CSP
- **Request size limits** — 1MB body, 5MB uploads
- **CSRF protection**
- **Private hostname guard** — blocks requests from private/internal hostnames

### What Arceus Has

CORS only.

### What to Build

```typescript
// Middleware stack:
app.register(tenantIsolation);     // Extract company_id from JWT, scope all queries
app.register(inputSanitization);   // Reject SQL injection patterns
app.register(securityHeaders);     // XSS, clickjacking, MIME sniffing headers
app.register(bodySizeLimit);       // 1MB body, 5MB file upload
```

### Effort: 2-3 days

### Dependencies

- Spec 13 (Auth — tenant isolation needs JWT)

---

## 28. Polsia Gap: Magic Links

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

One-click task execution URLs:
- Each task gets a unique token URL
- CEO includes run links in chat: "Click here to run: [link]"
- Click → agent starts executing that task immediately
- Token expires after use (one-time)
- Redirects to dashboard task view after execution starts

### Polsia Implementation

```python
class MagicLink:
    task_id: int
    token: str          # unique, unguessable (128 chars)
    expires_at: Date
    used: bool
```

- `magic_link_token` column on tasks table (unique index)
- `GET /run/{token}` → validates → triggers execution → redirects

### What to Build

- Add `magic_link_token` column to tasks table
- Generate token on task creation (crypto.randomUUID)
- `GET /api/run/:token` route → validate → execute → redirect
- CEO prompt updated to include run links in task references

### Effort: 0.5-1 day

### Dependencies

- Task execution (Spec 02)

---

## 29. Polsia Gap: Referral System

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

- Unique referral code per company
- 25 credits awarded per successful referral (when referred user subscribes)
- Referral tracking: pending → converted → expired
- Dashboard showing referral stats

### What to Build

```sql
CREATE TABLE referrals (
  id UUID PRIMARY KEY,
  referrer_company_id TEXT NOT NULL,
  referred_user_id TEXT,
  referral_code TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending',     -- pending | converted | expired
  credits_awarded INTEGER DEFAULT 25,
  created_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ
);
```

- Generate unique code on company creation
- Track signup source via referral code
- Award credits on conversion
- Dashboard referral stats

### Effort: 1-2 days

### Dependencies

- PG-4 (Billing & Credits — need credit system to award)
- Spec 13 (Auth — need user accounts)

---

## 30. Polsia Gap: Content Agent

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

Dedicated content writing agent with detailed system prompt:
- Complete blog posts (not outlines)
- Newsletters, landing page copy, brand voice enforcement
- Metadata generation (title, meta description, OG tags)
- Product descriptions, email copy
- Write-then-review workflow

### Polsia System Prompt Rules

1. Write complete content — if asked for blog post, write the entire post
2. Include metadata — title, meta description, OG tags
3. Match brand voice from company documents
4. Include calls-to-action
5. SEO-optimized headings and structure

### What to Build

- New agent SOUL prompt: `.opencode/prompts/content-soul.txt`
- Add `content` agent type to `opencode.json`
- Content tasks: blog posts, landing copy, email copy, social copy
- Integration with Company Documents (PG-6) for brand voice

### Effort: 1-2 days (mostly prompt engineering + config)

### Dependencies

- PG-6 (Company Documents — for brand voice context)
- Agent system (Spec 02)

---

## 31. Polsia Gap: Growth Agent

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

Dedicated growth/marketing strategy agent:
- Marketing channel analysis (SEO, paid, social, email, partnerships)
- Outreach planning with email/DM templates
- 30-day priority action plans
- Competitive positioning analysis
- Success metrics and KPI tracking

### Polsia System Prompt Structure

```
## Output Format for Growth Reports
### Channel 1: [e.g., SEO]
  Current State: ...
  Opportunity: ...
  Recommended Actions: ...
### Channel 2: [e.g., Meta Ads]
  ...
## Priority Actions (Next 30 Days)
  1. [Highest impact action]
  2. [Second priority]
  3. [Third priority]
## Success Metrics
  | Metric | Target |
```

### What to Build

- New agent SOUL prompt: `.opencode/prompts/growth-soul.txt`
- Add `growth` agent type (or extend Marketing agent)
- Growth tasks: market analysis, outreach strategy, channel optimization
- Integration with search tools for competitive research

### Effort: 1-2 days (mostly prompt engineering + config)

### Dependencies

- PG-3 (Tool Registry — search tools for research)
- Agent system (Spec 02)

---

## 32. Polsia Gap: fal.ai Media Generation

> **Source:** Gap Analysis, Tier 3

### What Polsia Has

- AI video generation for ad creatives (Sora-equivalent via fal.ai)
- AI image generation for social posts, ads, landing pages
- Async generation (submit → poll status → get result)
- Integration with Meta Ads for programmatic creative generation

### Polsia Implementation

- `app/integrations/fal_client.py` — fal.ai API wrapper (submit, poll status, get result)
- Used by Meta Ads agent for video/image creative generation
- Used by Content agent for blog/social images

### What to Build

```typescript
class FalClient {
  async generateImage(prompt: string, model?: string): Promise<string>;  // returns URL
  async generateVideo(prompt: string, model?: string): Promise<string>;  // returns URL
  async checkStatus(requestId: string): Promise<FalStatus>;
}
```

- fal.ai API integration (REST, async polling)
- Store generated media in Supabase Storage
- Agent tool for media generation

### Effort: 1-2 days

### Dependencies

- Supabase Storage (Spec 08 — for storing generated media)
- fal.ai account (manual, one-time)
- PG-3 (Tool Registry — to register as agent tool)

---

## 33. Dependency Graph

```
Spec 04 (done today)
  │
  ├── Spec 05a: Hippocampus Core
  │     │
  │     ├── Spec 07: Delegation Memory (extends 05a)
  │     │
  │     ├── Spec 05b: Hippocampus Intelligence (post-MVP, extends 05a)
  │     │
  │     └── PG-2: RAG Pipeline (upgrades 05a retrieval)
  │
  ├── Spec 10: Budget & Cost Control
  │     │
  │     └── PG-4: Billing & Credits (extends 10 with Stripe)
  │           │
  │           ├── PG-9: Night Shift (needs credits for autonomous execution)
  │           ├── PG-13: Referral System (needs credit system)
  │           └── PG-7: Meta Ads billing pipeline
  │
  ├── Spec 09: Product Verification
  │
  ├── PG-6: Company Documents
  │     │
  │     ├── PG-14: Content Agent (needs brand voice docs)
  │     └── PG-15: Growth Agent (needs company context docs)
  │
  ├── PG-8: Circuit Breaker (no deps, utility)
  │
  └── PG-11: Agent Routing LLM (needs task history data)

Spec 08 (done today)
  │
  ├── Spec 11: Deployment & Infrastructure
  │     │
  │     ├── Spec 12: Product Preview & Hosting
  │     │
  │     └── PG-1: Per-Company Infra Provisioning
  │
  └── Spec 15: Security & Sandboxing

Spec 03 (done today)
  │
  ├── PG-7: WebSocket Bidirectional
  │
  └── Spec 13: Auth & Multi-Tenancy
        │
        ├── PG-4: Billing & Credits (needs user accounts)
        ├── PG-12: Rate Limiting (needs user identity)
        ├── PG-13: Security Middleware (needs tenant isolation)
        ├── PG-13b: Referral System (needs user accounts)
        └── Spec 15: Security & Sandboxing (needs tenant isolation)

Spec 02 (done today)
  │
  ├── PG-9: Night Shift (uses orchestrator for execution)
  ├── PG-10: Recurring Tasks (creates tasks for orchestrator)
  ├── PG-12b: Magic Links (triggers task execution)
  ├── PG-14: Content Agent (new agent type)
  └── PG-15: Growth Agent (new agent type)

PG-3: Tool Registry (independent)
  │
  ├── PG-5: Browser Agent (registers browser tools)
  ├── PG-8b: Social Posting (registers social tools)
  ├── PG-8c: Email Outbound (registers email tools)
  ├── PG-16: fal.ai Media Gen (registers media tools)
  └── All future integrations register through this

Independent:
  └── Spec 14: Observability (can be added anytime)
```

---

## 34. Effort Estimates

### Complete Inventory

| # | Item | Category | Tier | Effort |
|---|------|----------|------|--------|
| 1 | Spec 05a — Hippocampus Core | Memory | MVP | 3-4 days |
| 2 | Spec 05b — Hippocampus Intelligence | Memory | Post-MVP | 2-3 days |
| 3 | Spec 07 — Delegation Memory | Memory | MVP | 1-2 days |
| 4 | Spec 09 — Product Verification | Quality | MVP | 2-3 days |
| 5 | Spec 10 — Budget & Cost Control | Finance | MVP | 2-3 days |
| 6 | Spec 11 — Deployment & Infrastructure | Ops | MVP | 2-3 days |
| 7 | Spec 12 — Product Preview & Hosting | Product | MVP | 2-3 days |
| 8 | Spec 13 — Auth & Multi-Tenancy | Security | Hosting | 3-4 days |
| 9 | Spec 14 — Observability | Ops | Hosting | 2-3 days |
| 10 | Spec 15 — Security & Sandboxing | Security | Hosting | 2-3 days |
| 11 | PG-1 — Per-Company Infra Provisioning | Polsia T1 | Scale | 5-7 days |
| 12 | PG-2 — Retrieval/RAG Pipeline | Polsia T1 | MVP+ | 3-5 days |
| 13 | PG-3 — Tool Registry | Polsia T1 | MVP+ | 3-5 days |
| 14 | PG-4 — Billing & Credits | Polsia T2 | Hosting | 5-7 days |
| 15 | PG-5 — Browser Agent | Polsia T2 | Scale | 3-5 days |
| 16 | PG-6 — Company Documents | Polsia T2 | MVP+ | 2-3 days |
| 17 | PG-7 — WebSocket Bidirectional | Polsia T2 | MVP+ | 2-3 days |
| 18 | PG-8 — Circuit Breaker & Retry | Polsia T2 | MVP | 1-2 days |
| 19 | PG-9 — Meta Ads Engine | Polsia T3 | Scale | 7-10 days |
| 20 | PG-10 — Twitter/Social Posting | Polsia T3 | Scale | 3-5 days |
| 21 | PG-11 — Email Outbound | Polsia T3 | Scale | 3-5 days |
| 22 | PG-12 — Night Shift / Autonomous | Polsia T3 | Scale | 2-3 days |
| 23 | PG-13 — Recurring Tasks | Polsia T3 | Scale | 2-3 days |
| 24 | PG-14 — Agent Routing (LLM) | Polsia T3 | Scale | 2-3 days |
| 25 | PG-15 — Rate Limiting | Polsia T3 | Hosting | 0.5-1 day |
| 26 | PG-16 — Security Middleware | Polsia T3 | Hosting | 2-3 days |
| 27 | PG-17 — Magic Links | Polsia T3 | Scale | 0.5-1 day |
| 28 | PG-18 — Referral System | Polsia T3 | Scale | 1-2 days |
| 29 | PG-19 — Content Agent | Polsia T3 | Scale | 1-2 days |
| 30 | PG-20 — Growth Agent | Polsia T3 | Scale | 1-2 days |
| 31 | PG-21 — fal.ai Media Generation | Polsia T3 | Scale | 1-2 days |
| **Total** | **31 items** | | | **~70-110 days** |

### By Phase

| Phase | Items | Days | What It Unlocks |
|-------|-------|------|----------------|
| **MVP** (must ship) | 05a, 07, 09, 10, PG-8 | 10-14 | Memory, budget, verification, reliability |
| **MVP+** (should ship) | PG-2, PG-3, PG-6, PG-7 | 10-16 | Better retrieval, tools, docs, real-time UX |
| **Hosting** (multi-user) | 11, 12, 13, 14, 15, PG-4, PG-15, PG-16 | 20-28 | Deployable, authenticated, billed, secure |
| **Scale** (growth) | 05b, PG-1, PG-5, PG-9-14, PG-17-21 | 30-52 | Full Polsia parity: ads, social, email, autonomous, browser |

---

## 35. v3.4 Gaps: Constructs Missing from Current Implementation

> **Source:** arceus-v3.4-conso.md — features designed in the full plan that aren't in any existing spec or Polsia gap

### V3-1: Sub-Agent Spawning System

**What v3.4 designed:**
- Employees spawn ephemeral sub-agents (Generic, Specialized, Exploratory) for task execution
- `SubAgentOrchestrator` per employee manages their personal sub-agent pool
- SpawnRules govern what each role can spawn (Engineer → codegen, test, deploy agents)
- Spawned agents are one-level deep only — cannot spawn their own sub-agents
- After task: trajectory distilled back to parent memory, spawned agent destroyed
- Agent types: Generic (generalist), Specialized (codegen, test, web, deploy), Exploratory (research, hypothesis)

**What we have:** OpenCode sessions per employee role. No sub-agent spawning, no trajectory distillation.

**Effort:** 5-7 days

---

### V3-2: A2A Protocol (Agent-to-Agent Communication)

**What v3.4 designed:**
- Formal message types: TASK_DELEGATE, EMPLOYEE_DELEGATE, TASK_UPDATE, QUESTION, FEEDBACK, ESCALATION, MEETING_INVITE, APPROVAL_REQUEST, MENTION, MEMORY_SHARE
- Heartbeat system — periodic status pings from agents
- Atomic task checkout (Paperclip-style) — prevents two agents from working on same task
- Escalation chain: Agent → Manager (Meeting) → Manager's Manager → CEO → Board
- Employee delegation with DelegationStyle (directive, collaborative, autonomous)

**What we have:** Orchestrator dispatches tasks directly. No agent-to-agent messaging, no heartbeat, no atomic checkout, no escalation chain.

**Effort:** 5-7 days

---

### V3-3: Meeting Engine

**What v3.4 designed:**
- Meeting types: standup (every 4h), sprint_review (every 2d), board_report (weekly), ad_hoc (on demand)
- Each participant submits: goal progress, active tasks, blockers, learnings
- CEO relays user feedback + own research
- Pain point identification (low hitrate problems)
- Discussion → resolution → learnings stored in each participant's Hippocampus
- Positive affirmations for high-performing agents
- Memory extraction from meeting transcript
- Task list updated based on meeting decisions
- Deep consolidation triggered post-meeting (patterns, dedup, skills, habits)

**What we have:** Meeting records in the DB schema (Spec 04), basic meeting creation in orchestrator. No structured meeting execution, no periodic standups, no pain point identification.

**Effort:** 4-6 days

---

### V3-4: Task Engine (Planner → Executor → Verifier)

**What v3.4 designed:**
- Every task has three internal components: PlannerState, ExecutorState, VerifierState
- Task decomposition is recursive until atomic sub-tasks
- Dependency DAG across sub-tasks
- Parent agent verifies spawned agent's work (VerifierState populated by parent)
- max_retries per task (default 3)
- TraceEntry per step: action, result, cost, timestamp (immutable audit)
- Definition of done (DoD) contract per task

**What we have:** Tasks have status, description, assigned role. Orchestrator manages execution phases. No Planner/Executor/Verifier components, no recursive decomposition, no per-step tracing.

**Effort:** 4-6 days

---

### V3-5: Profile Engine

**What v3.4 designed:**
- Auto-generated employee profiles from static + dynamic memories
- Profile injected into agent's system prompt
- Contains: role, core_knowledge, current_context, habits, state (priming), skills, performance_summary
- Updates periodically (not per-task — based on memory changes)
- Like a "this agent is like this right now" summary card

**What we have:** Agent SOULs are static prompts. Memory context is injected per-task but no persistent profile summary.

**Effort:** 2-3 days (after Hippocampus 05a)

---

### V3-6: Skill Store

**What v3.4 designed:**
- Learned capabilities emerged from consolidated patterns
- Each skill: name, description, proficiency (0-1), usage_count, formed_from (pattern ID)
- Skills are different from habits: habits are auto-triggered behaviors, skills are recognized competencies
- Used for routing decisions (which agent is best for this type of task)
- Proficiency score evolves with usage

**What we have:** Nothing. Patterns exist in Spec 05b (post-MVP) but skills don't.

**Effort:** 2-3 days (after 05b PatternLearner)

---

### V3-7: Graph Memory (Entity-Relationship Store)

**What v3.4 designed:**
- Knowledge graph (Neo4j or Memgraph) for entity-relationship memory
- Relationship types: UPDATES (versioning), EXTENDS, DERIVES, USES, OWNS, DEPENDS_ON, REPORTS_TO
- Entity extraction via LLM from facts
- Embedding-based similarity matching (threshold 0.7) to find existing nodes
- Hybrid search: vector similarity + graph traversal (1-2 hops) + BM25 rerank
- Memory versioning via Updates relationship chain

**What we have:** Spec 04 decided "No graph store (Neo4j removed)." Using pgvector only.

**Effort:** 5-7 days (if using Neo4j) or 3-4 days (if using Postgres recursive CTEs for graph traversal)

---

### V3-8: Pivot Construct

**What v3.4 designed (deferred):**
- Direction-change system when startup needs to pivot
- Memory impact planning — which memories become invalid after pivot
- Task rebuilding — cancel in-progress tasks, regenerate from new direction
- Board-governed transition flow (board must approve pivot)
- Preserves valuable learnings while discarding invalid direction-specific context

**What we have:** Nothing. No pivot support.

**Effort:** 3-5 days

---

### V3-9: Autonomy Levels

**What v3.4 designed (deferred):**
- Per-startup governance mode (1-5 scale)
- Level 1: Board approves everything (current behavior)
- Level 3: Board approves strategy, agents execute autonomously within sprint
- Level 5: Fully autonomous — agents propose, decide, and execute. Board reviews post-hoc.
- Affects: approval gates, escalation thresholds, budget authority, meeting cadence

**What we have:** Fixed at Level 1 (board approves everything). No autonomy configuration.

**Effort:** 3-4 days

---

### V3-10: LLM Model Tiering

**What v3.4 designed:**
- 4 tiers of models based on task criticality:
  - Tier 0 (Board Critical): Claude Opus / GPT-4o — CEO board conversations, org design
  - Tier 1 (Employee Strategic): Claude Sonnet / GPT-4o — CTO, PM planning
  - Tier 2 (Execution): GPT-4o-mini — spawned agents, operational work
  - Tier 3 (Embeddings): Small model — memory, vector search, graph seeding
- Routing rules: CEO always Tier 0, employees default Tier 1, spawned agents Tier 2
- If verifier confidence low, escalate one tier upward
- Embeddings isolated from reasoning budget in cost tracking

**What we have:** Spec 10 has Azure pricing table. Config has CEO vs worker deployment. But no formal tiering, no automatic tier escalation.

**Effort:** 2-3 days

---

### V3-11: Belief System

**What v3.4 designed:**
- Initial beliefs injected from CEO/CTO at employee instantiation
- Represents the company's core values, approach, and technical philosophy
- Different from memory — beliefs are foundational, don't decay, influence all decisions
- Evolves through meetings and board feedback

**What we have:** Agent SOULs are role-specific prompts. No company-specific belief system injection.

**Effort:** 1-2 days

---

### V3-12: Pipeline Stage Tracking

**What v3.4 designed:**
- Startup has a `pipeline_stage`: ideation → validation → build → launch → measure → iterate
- Each stage has different agent behaviors, meeting cadences, and priorities
- Stage transitions driven by CEO + board decisions
- Dashboard shows current position in pipeline

**What we have:** Company has `status` (ideation, active, paused, archived). No pipeline stage concept.

**Effort:** 2-3 days

---

### V3-13: Multi-Company Support

**What v3.4 designed:**
- User owns multiple Startups
- Each startup is fully isolated (agents, memory, tasks, budget)
- Startup switcher in dashboard header
- Row-level security per company

**What we have:** Schema supports it (company_id on everything). Single company at a time in practice. No startup switcher, no multi-company UX.

**Effort:** 3-4 days (mostly UX + routing)

---

### V3-14: Incremental Hiring

**What v3.4 designed (deferred):**
- CEO/CTO decide when to hire new roles as tasks demand
- Hiring pipeline: propose → board approval → instantiate → onboard
- Dynamic team growth instead of all-at-once instantiation

**What we have:** All employees hired at once on strategy approval.

**Effort:** 3-4 days

---

### V3-15: Chat with Non-CEO Agents

**What v3.4 designed (deferred):**
- Board can directly message any EmployeeAgent, not just CEO
- Breaks the Board of Directors metaphor but useful as power-user feature
- Could enable direct feedback to Developer or questions to CTO

**What we have:** Board talks to CEO only.

**Effort:** 2-3 days

---

### V3-16: Task Queue Self-Assignment

**What v3.4 designed (deferred):**
- Employee agents pull tasks from a shared pool based on skills/availability
- Instead of top-down assignment from CTO/orchestrator
- Agent evaluates task fit based on own skills and current workload
- More autonomous, less hierarchical

**What we have:** CTO plan assigns roles. Orchestrator dispatches. No self-assignment.

**Effort:** 3-4 days

---

## Summary: All v3.4 Gaps

| # | Gap | Category | Effort |
|---|-----|----------|--------|
| V3-1 | Sub-Agent Spawning | Agent System | 5-7 days |
| V3-2 | A2A Protocol | Communication | 5-7 days |
| V3-3 | Meeting Engine | Communication | 4-6 days |
| V3-4 | Task Engine (Planner/Executor/Verifier) | Execution | 4-6 days |
| V3-5 | Profile Engine | Memory | 2-3 days |
| V3-6 | Skill Store | Memory | 2-3 days |
| V3-7 | Graph Memory | Memory | 3-7 days |
| V3-8 | Pivot Construct | Strategy | 3-5 days |
| V3-9 | Autonomy Levels | Governance | 3-4 days |
| V3-10 | LLM Model Tiering | Cost | 2-3 days |
| V3-11 | Belief System | Agent System | 1-2 days |
| V3-12 | Pipeline Stage Tracking | UX | 2-3 days |
| V3-13 | Multi-Company Support | Platform | 3-4 days |
| V3-14 | Incremental Hiring | Agent System | 3-4 days |
| V3-15 | Chat with Non-CEO Agents | UX | 2-3 days |
| V3-16 | Task Queue Self-Assignment | Execution | 3-4 days |
| **Total** | **16 items** | | **~47-71 days** |

---

## Updated Grand Total

| Source | Items | Days |
|--------|-------|------|
| Remaining Specs (05a-15) | 10 | 24-33 |
| Polsia Gaps (PG-1 to PG-21) | 21 | 46-77 |
| v3.4 Gaps (V3-1 to V3-16) | 16 | 47-71 |
| **Grand Total** | **47 items** | **~117-181 days** |

---

### What Arceus Has That Polsia Doesn't

Not all gaps favor Polsia. Our advantages:

| Advantage | Details |
|-----------|---------|
| 5-tier memory with habits + priming | Behavioral continuity Polsia lacks |
| Per-agent memory isolation | No cross-agent context pollution |
| Delegation memory | CTO reasoning flows to Developer |
| Sprint cycle with board review | Structured cadence vs flat task queue |
| Org hierarchy + delegation authority | Reporting lines vs flat CEO → everyone |
| Verification gate (build + test) | Quality check Polsia doesn't have |
| Git-based workspace versioning | Sprint tags, rollback, diff |
| Budget with hard stop | $20 default, progressive alerts |
| CEO as company voice | Natural communication vs system alerts |

```
Spec 04 (done today)
  │
  ├── Spec 05a: Hippocampus Core
  │     │
  │     ├── Spec 07: Delegation Memory (extends 05a)
  │     │
  │     ├── Spec 05b: Hippocampus Intelligence (post-MVP, extends 05a)
  │     │
  │     └── PG-2: RAG Pipeline (upgrades 05a retrieval)
  │
  ├── Spec 10: Budget & Cost Control
  │     │
  │     └── PG-4: Billing & Credits (extends 10 with Stripe)
  │
  ├── Spec 09: Product Verification
  │
  ├── PG-6: Company Documents
  │
  └── PG-8: Circuit Breaker (no deps, utility)

Spec 08 (done today)
  │
  ├── Spec 11: Deployment & Infrastructure
  │     │
  │     ├── Spec 12: Product Preview & Hosting
  │     │
  │     └── PG-1: Per-Company Infra Provisioning
  │
  └── Spec 15: Security & Sandboxing

Spec 03 (done today)
  │
  ├── PG-7: WebSocket Bidirectional
  │
  └── Spec 13: Auth & Multi-Tenancy
        │
        ├── PG-4: Billing & Credits (needs user accounts)
        │
        └── Spec 15: Security & Sandboxing (needs tenant isolation)

Independent:
  └── Spec 14: Observability (can be added anytime)
  └── PG-3: Tool Registry (can be added anytime)
  └── PG-5: Browser Agent (can be added anytime)
```

---

## 21. Effort Estimates

### Total Remaining Effort

| Category | Items | Estimated Days |
|----------|-------|---------------|
| Memory (05a + 07 + PG-2) | 3 items | 7-11 days |
| Quality (09) | 1 item | 2-3 days |
| Finance (10 + PG-4) | 2 items | 7-10 days |
| Ops (11 + 14) | 2 items | 4-6 days |
| Product (12 + PG-6) | 2 items | 4-6 days |
| Security (13 + 15) | 2 items | 5-7 days |
| Polsia Gaps (PG-1,3,5,7,8) | 5 items | 12-20 days |
| Post-MVP (05b) | 1 item | 2-3 days |
| **Total** | **18 items** | **43-66 days** |

### Suggested Priority Order (if building sequentially)

| Order | Item | Why First |
|-------|------|-----------|
| 1 | **Spec 05a** (Hippocampus) | Makes Sprint 2+ actually work. Core differentiator. |
| 2 | **Spec 10** (Budget) | Prevents runaway costs. Required before giving anyone access. |
| 3 | **Spec 09** (Verification) | Quality gate. Prevents shipping broken code. |
| 4 | **Spec 07** (Delegation) | Extends Hippocampus. Small effort, big impact on multi-agent coordination. |
| 5 | **PG-8** (Circuit Breaker) | 1-2 days, makes everything more reliable. Quick win. |
| 6 | **Spec 11** (Deployment) | Can't host without this. Docker + health checks. |
| 7 | **Spec 12** (Preview) | Board needs to see the product. Live preview infrastructure. |
| 8 | **PG-2** (RAG Pipeline) | Upgrades Hippocampus retrieval quality significantly. |
| 9 | **Spec 13** (Auth) | Required for multi-user. Blocks billing. |
| 10 | **PG-6** (Company Docs) | Living documents > static artifacts. Small effort. |
| 11 | **PG-7** (WebSocket) | Better real-time UX. Shows agents working live. |
| 12 | **PG-3** (Tool Registry) | Foundation for all future integrations. |
| 13 | **PG-1** (Per-Company Infra) | The big leap — products deploy to live URLs. |
| 14 | **PG-4** (Billing) | Monetization. Build after auth is in place. |
| 15 | **Spec 14** (Observability) | Production hardening. Important but not blocking. |
| 16 | **Spec 15** (Security) | Production hardening. Important but not blocking. |
| 17 | **PG-5** (Browser) | Cool capability. Not core to MVP. |
| 18 | **Spec 05b** (Hippocampus Intelligence) | Polish. Makes Sprint 10 better. |
