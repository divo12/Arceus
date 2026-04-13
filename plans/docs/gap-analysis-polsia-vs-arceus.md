# Gap Analysis: Polsia vs Arceus

> **Date:** 2026-04-06
> **Source:** Reverse-engineered from 432-page Polsia architecture doc (Spectra conversation export)
> **Purpose:** Identify every capability Polsia has that Arceus lacks, prioritize what to build

---

## Executive Summary

Polsia is a production AI company platform running real businesses. Arceus is an in-memory demo with 10 specs. After analyzing Polsia's full codebase (models, services, agents, integrations, frontend, retrieval pipeline, middleware), we identified **25 capability gaps** across 7 categories:

- **15 completely missing** — no equivalent exists in Arceus
- **10 partially missing** — we have a version, theirs is more mature

The highest-impact gaps are: per-company infrastructure provisioning (GitHub + hosting + DB), the retrieval/RAG pipeline (5-stage vs raw cosine), and the tool registry (MCP-style per-agent mounting). These three unlock the transition from "generates code locally" to "ships live products."

---

## What Polsia Is

An AI-native company operating system where:
- User talks to a CEO agent
- CEO routes tasks to specialist agents (engineer, browser, research, growth, content, ads)
- Agents execute autonomously using real tools (GitHub API, Render API, Playwright, Meta Ads API)
- Products deploy to live URLs with their own databases
- 3-layer memory system preserves context across conversations
- Credit-based billing with Stripe subscriptions

**Their stack:** Python FastAPI + Celery/Redis + SQLAlchemy + Postgres/pgvector + LangGraph + Docker + Playwright

**Our stack:** TypeScript Fastify + OpenCode SDK + Azure OpenAI + Supabase (planned)

---

## Category 1: Completely Missing Systems

### 1.1 Per-Company Infrastructure Provisioning

**What Polsia has:**

When a company is created, Polsia auto-provisions a full production stack:

```
Company created
    │
    ├── GitHub: Create private repo via GitHub App API
    │     └── Agents push code via tree/commit API (atomic multi-file)
    │
    ├── Render: Create web service linked to GitHub repo
    │     └── Auto-deploy on push. Agents trigger manual deploys.
    │
    ├── Neon: Create serverless Postgres project
    │     └── Connection string encrypted and stored per-company
    │
    ├── R2: Cloudflare R2 bucket for media/assets
    │
    └── Custom domain setup (optional)
```

**InfraProvisioner service** orchestrates all of the above in sequence. Each step has error handling and rollback. Infrastructure status tracked in `company_infrastructure` table.

**What Arceus has:** Local `/workspace` directory. Code stays on the server. No repo, no hosting, no per-company database.

**Impact:** Without this, Arceus generates code that lives and dies on a single machine. No live URL for the board to share. No real deployment pipeline.

**Polsia implementation:**
- `app/services/infra_provisioner.py` — 200+ lines orchestrating GitHub → Render → Neon → R2
- `app/models/infrastructure.py` — CompanyInfrastructure + DeployEvent models
- `app/integrations/github_client.py` — GitHub App auth, repo creation, tree/commit API, webhook setup
- `app/integrations/render_client.py` — Service creation, deploy triggers, status polling, env var management
- `app/integrations/neon_client.py` — Project creation, connection URI, SQL execution, branching
- `app/integrations/r2_client.py` — Bucket management, presigned URLs, upload/download

---

### 1.2 Outreach & Marketing Stack

**What Polsia has:**

A complete marketing engine with 3 dedicated agents:

**Meta Ads (Facebook + Instagram):**
- Programmatic ad campaign creation and management
- AI-generated video creatives via fal.ai
- Daily budget optimization ($10-1000/day per company)
- Performance tracking (impressions, clicks, CTR, CPC, conversions, ROAS)
- Ad billing: platform takes 20% fee on ad spend
- Full Meta Marketing API integration

**Twitter/X:**
- Auto-posting from shared @polsia account (1 tweet/day per company)
- Engagement tracking (likes, retweets, impressions, clicks)
- Twitter API v2 with OAuth 2.0

**Social scheduling:**
- Late.dev integration for Instagram/TikTok/LinkedIn
- Scheduled posts with status tracking

**Email:**
- Platform inbox per company (2/day outbound limit)
- Gmail API integration for higher volume
- Inbound email processing
- Thread tracking, read/unread status
- Resend for transactional email

**Agents:**
- Growth agent — marketing strategy, audience analysis, outreach planning
- Content agent — blog posts, newsletters, brand voice, copywriting
- Meta Ads agent — dedicated agent managing ad accounts and campaigns

**What Arceus has:** Nothing. No marketing, no social, no email, no ads.

**Polsia implementation:**
- `app/services/ads_service.py` — Campaign CRUD, creative generation, performance tracking
- `app/agents/meta_ads_agent.py` — Dedicated ads agent
- `app/agents/growth.py` — Growth strategy agent
- `app/agents/content.py` — Content writing agent
- `app/integrations/meta_ads_client.py` — Full Meta Marketing API wrapper
- `app/integrations/twitter_client.py` — Tweet posting, engagement reading
- `app/integrations/resend_client.py` — Transactional email
- `app/models/ads.py` — AdAccount, AdCampaign, AdCreative, AdPerformance, AdBillingEvent
- `app/models/email.py` — CompanyInbox, Email, EmailAttachment
- `app/models/social.py` — SocialAccount, SocialPost, SocialEngagement

---

### 1.3 Billing & Credits System

**What Polsia has:**

Complete monetization layer:

| Component | Details |
|-----------|---------|
| **Subscription tiers** | Trial (5 credits), Full Autonomy (15-1000 credits/mo), Hosting-only |
| **Credit system** | 1 task = 1 credit. Monthly refresh. Welcome bonus (5). Referral bonus (25). |
| **Stripe subscriptions** | Checkout sessions, subscription management, webhooks |
| **Stripe Connect** | Customers' customers pay through generated app → Polsia balance → withdrawal |
| **Referral system** | Unique codes per company, 25 credits per converted referral |
| **Ad billing** | Separate pipeline: ad spend + 20% platform fee charged via Stripe |
| **Balance & withdrawals** | Track earned revenue, enable bank/card withdrawals |

**What Arceus has:** Budget tracking (Spec 10) — per-company limit, cost per LLM call, hard stop at 100%. No monetization, no subscriptions, no credits, no Stripe.

**Polsia implementation:**
- `app/models/billing.py` — Subscription, CreditTransaction, PaymentAccount, CustomerPayment, Withdrawal, Referral
- `app/services/billing_service.py` — Credit management, subscription lifecycle
- `app/integrations/stripe_client.py` — Checkout, subscriptions, Connect, webhooks
- `app/api/billing.py` — Subscription routes, credit purchase, withdrawal

---

### 1.4 Browser Automation Agent

**What Polsia has:**

A dedicated browser agent backed by Playwright:

- Navigate to URLs, click elements, type text, fill forms
- Take screenshots, extract DOM, evaluate JavaScript
- Scrape data from websites
- Post on platforms that require browser interaction (CAPTCHAs block API-only approaches)
- Configurable browser pool (max concurrent sessions, idle timeout, proxy rotation)
- Browserbase/BrowserCloud option for managed scale

**What Arceus has:** Nothing. No browser agent, no Playwright, no web interaction capability.

**Polsia implementation:**
- `app/agents/browser_agent.py` — BrowserAgent with Playwright tools
- `app/agents/tools/browser_tools.py` — navigate, click, type, screenshot, fill_form, extract_text
- `app/models/browser.py` (types) — BrowserSession, BrowserAction, BrowserScreenshot, BrowserPoolConfig

---

### 1.5 Tool Registry (MCP-Style)

**What Polsia has:**

A formal tool registration and execution system:

```python
@register_tool(
    name="create_file",
    description="Create a file in the repository",
    input_schema={...},
    mcp_server="github",
)
async def create_file(input_data: dict, context: dict):
    github = GitHubClient()
    repo = context.get("github_repo")
    # ... execute
```

- **17 registered tools** across 8 categories (GitHub, deploy, browser, search, memory, email, social, ads)
- **Per-agent tool mounting** — each agent only sees the tools its role permits
- **Auth injection** — per-execution, per-company credentials injected automatically
- **Tool whitelist** — `AgentMCPMount` with optional `tool_whitelist` to limit which tools each agent can call

**What Arceus has:** OpenCode SDK manages tools internally. Agents get permissions via `opencode.json` (can_edit, can_bash, can_webfetch). No formal registry, no auth injection, no per-agent mounting.

**Polsia implementation:**
- `app/agents/tools/registry.py` — ToolRegistry class, @register_tool decorator
- `app/agents/tools/github_tools.py` — create_file, push_files, read_file, list_files
- `app/agents/tools/browser_tools.py` — navigate, click, type, screenshot, fill_form
- `app/agents/tools/search_tools.py` — web_search
- `app/agents/tools/deploy_tools.py` — trigger_deploy, get_deploy_status
- `app/agents/tools/memory_tools.py` — search_memory, update_memory, read_memory_layer
- `app/agents/tools/email_tools.py` — send_email
- `app/agents/tools/social_tools.py` — post_tweet

---

### 1.6 Night Shift / Autonomous Execution

**What Polsia has:**

Agents work without human triggering:

- **Night shift worker** — runs daily at 4 AM UTC. Picks up all pending tasks for all active companies. Executes sequentially with credit deduction.
- **Recurring tasks** — daily, weekdays, weekly, monthly schedules. System auto-creates task instances from templates.
- **Autonomous queue** — tasks queue up throughout the day, agents process them in priority order.

**What Arceus has:** Execution only happens when the board explicitly approves a sprint. No autonomous operation, no recurring tasks, no background processing.

**Polsia implementation:**
- `app/workers/night_shift.py` — Daily autonomous cycle
- `app/workers/recurring.py` — Recurring task scheduler
- `app/models/task.py` — RecurringTask, RecurringTaskInstance

---

### 1.7 Content & Growth Agents

**What Polsia has:**

Two specialized non-engineering agents:

**Content agent:**
- Blog posts, newsletters, landing page copy
- Brand voice enforcement
- Full article writing (not outlines)
- Metadata (title, meta description, OG tags)
- Production system prompts with detailed output format rules

**Growth agent:**
- Marketing strategy
- Channel analysis (SEO, paid, social, email, partnerships)
- Outreach planning with templates
- 30-day priority action plans
- Success metrics and KPI tracking

**What Arceus has:** We have PM, Designer, and Marketing SOULs, but Marketing has no tools and no integrations. Content creation is implicit in Developer's work, not a dedicated capability.

**Polsia implementation:**
- `app/agents/content.py` + `app/agents/prompts/content.py` — 200+ line system prompt
- `app/agents/growth.py` + `app/agents/prompts/growth.py` — 200+ line system prompt with channel frameworks
- `app/agents/prompts/support.py` — Customer support templates

---

## Category 2: Partially Missing (We Have a Version, Theirs Is Better)

### 2.1 Retrieval / RAG Pipeline

**Polsia:** 5-stage hybrid retrieval pipeline

```
Query → Analyze Intent → Embed → Hybrid Search (vector + BM25) → Rerank (LLM) → Assemble Context
```

| Stage | What It Does | Cost |
|-------|-------------|------|
| Query analysis | LLM classifies intent (technical, product, preference, historical) | ~$0.001 |
| Embedding | OpenAI text-embedding-3-small with Redis cache | ~$0.00002 |
| Hybrid search | pgvector cosine + BM25 keyword + cross-layer search | Free (DB query) |
| LLM reranking | gpt-4o-mini scores top results for relevance | ~$0.001 |
| Context assembly | Token budget, dedup, technical-first sorting | Free (logic) |

**Total: ~$0.002 per retrieval**

Additional features:
- SmartChunker — splits by markdown headers, code blocks, paragraph groups
- Redis-cached embeddings — avoids re-embedding unchanged content
- Cross-layer search — queries all 3 memory layers, weighted merge
- Token budget — context assembly respects max_context_tokens parameter

**Arceus (Spec 05a):** pgvector cosine similarity with tier boosting and MMR diversity filter. No chunking, no BM25, no reranking, no context assembly, no caching.

**Gap:** Our retrieval will return relevant results but won't be as precise. The LLM reranking step is the biggest quality difference — it eliminates false positives that vector search alone returns.

**Polsia implementation:**
- `app/retrieval/pipeline.py` — RetrievalPipeline orchestrator
- `app/retrieval/chunker.py` — SmartChunker (headers, code, paragraphs)
- `app/retrieval/embedder.py` — Embedder with Redis cache
- `app/retrieval/searcher.py` — HybridSearcher (vector + BM25)
- `app/retrieval/reranker.py` — LLMReranker
- `app/retrieval/context_assembler.py` — ContextAssembler with token budgets

---

### 2.2 Agent Execution Model

**Polsia:** LangGraph state machine with explicit states

```
load_context → select_agent → execute_agent → verify_result → save_result
                                    │
                                    ├── tool_call → tool_result → continue
                                    └── max_iterations (15-20) → force stop
```

- Every tool call logged with input, output, duration, status
- Container ID tracked per execution (Docker isolation)
- Token usage tracked per execution with model breakdown
- Cost computed per execution
- Explicit retry logic: if failed and retry_count < 2, loop back to execute

**Arceus:** OpenCode SDK sessions with event stream monitoring. We fire `prompt_async`, listen for `session.idle`, collect output. No state machine, no max iterations, no execution logging, no container isolation.

**Gap:** Our execution model works but is a black box. We don't see individual tool calls, can't enforce iteration limits, and can't log the execution trace for debugging.

---

### 2.3 Agent Routing

**Polsia:** LLM-based intelligent routing

```python
class AgentRouter:
    async def classify_task(self, description: str, company_context: dict) -> AgentMatch:
        # Uses gpt-4o-mini to classify task → agent tag
        # Returns: { agent_tag, confidence, reason, warnings }

    async def find_agent_for_tag(self, tag: str) -> Agent:
        # Looks up active agent by tag
        # Considers historical success rate
```

- Tracks historical outcomes per agent per task type (total attempts, successes, failures, avg duration)
- Confidence-based routing — if confidence < 0.5, flags for review
- Fallback logic when primary agent fails

**Arceus:** CTO plan assigns roles. Orchestrator maps role → OpenCode session. No intelligence, no confidence scoring, no historical tracking.

---

### 2.4 Memory System Architecture

**Polsia:** 3 layers, flat text, periodic summarization

| Layer | Content | Size | Update Trigger |
|-------|---------|------|----------------|
| 1: Domain knowledge | Company wiki — stack, decisions, what's built | 15K tokens | Every ~20 messages |
| 2: Preferences | User working style, priorities | 3K tokens | Every ~20 messages |
| 3: Cross-company patterns | Anonymized learnings from all companies | 15K tokens | Platform-level |

- All agents read from the same memory (shared brain)
- Periodic summarization compresses conversations → memory
- Sections within layers (headings like "## Tech Stack", "## Product")
- Memory tools available to agents: search_memory, update_memory, read_memory_layer

**Arceus (Spec 05a):** 5 tiers, vector embeddings, per-agent isolation

| Tier | Content | Storage | Update Trigger |
|------|---------|---------|----------------|
| 1: Working | Runtime task context | Redis (TTL) | Per task |
| 2: Static | Permanent facts | pgvector | LLM extraction on task completion |
| 3: Dynamic | Temporary context | pgvector (decays) | LLM extraction on task completion |
| 4: Procedural | Habits | Postgres | Pattern formation |
| 5: Priming | Confidence/morale | Postgres | EMA after task |

**Our advantages:** More granular tiers. Per-agent isolation. Habits and priming give behavioral continuity. Vector embeddings for semantic search.

**Their advantages:** Simpler (works). Better retrieval pipeline. Shared memory across all agents (agents know what other agents did). Cross-company learning.

---

### 2.5 Company Documents

**Polsia:** Structured, versioned, agent-writable documents

```python
class DocumentType(str, enum.Enum):
    MISSION = "mission"
    PRODUCT_OVERVIEW = "product_overview"
    TECH_NOTES = "tech_notes"
    BRAND_VOICE = "brand_voice"
    USER_RESEARCH = "user_research"
```

- Version history tracked per edit
- Agents can update docs (engineer updates tech_notes after building)
- Users can update docs through dashboard
- Documents injected into agent context for every task

**Arceus:** Artifacts per task (plan, code, output). No persistent company-level docs that evolve over time. Artifacts are snapshots, not living documents.

---

### 2.6 WebSocket Real-Time

**Polsia:** Full bidirectional WebSocket with Redis pub/sub bridge

- Per-company WebSocket channel
- Streaming: message_start → content_delta → tool_call_start → tool_call_result → content_done → done
- Tool call visibility — dashboard shows live tool calls as agents execute
- Redis pub/sub bridges background workers → WebSocket → dashboard

**Arceus:** SSE for activity feed + CEO chat streaming. One-directional. No tool call visibility. No WebSocket.

---

## Category 3: Missing Middleware & Infrastructure

### 3.1 Rate Limiting

**Polsia:** Per-route Redis-backed rate limiting

```python
LIMITS = {
    "/api/chat": "30/min",
    "/api/tasks": "60/min",
    "/api/agents": "30/min",
    "default": "100/min",
}
```

**Arceus:** None.

---

### 3.2 Circuit Breaker & Retry

**Polsia:** Decorator-based retry with circuit breaker

```python
@retry_async(max_retries=3, delay=1.0, backoff=2.0)
async def call_external_service():
    ...

class CircuitBreaker:
    # Tracks failures, opens circuit after threshold
    # Half-open recovery after cooldown
    # States: closed → open → half_open → closed
```

Applied to all integration clients (GitHub, Render, Neon, Stripe, etc.).

**Arceus:** None. External call failures crash the operation.

---

### 3.3 Observability & Metrics

**Polsia:**
- `@track_duration` decorator on all service methods
- Prometheus-style counters for LLM calls, tool calls, task completions
- Structured error handling middleware with request ID tracking
- Execution logging: every tool call with input/output/duration

**Arceus:** `console.log`. Activity feed for user-facing events. No structured logging, no metrics, no request tracing.

---

### 3.4 Security Middleware

**Polsia:**
- Tenant isolation middleware — every request scoped to company_id via JWT
- SQL injection detection (rejects UNION, DROP, etc.)
- XSS protection headers
- Request body size limits (1MB body, 5MB uploads)
- CSRF protection
- Private hostname guard

**Arceus:** CORS only. No tenant isolation (single-company). No input sanitization.

---

### 3.5 Magic Links

**Polsia:** One-click task execution URLs

```python
class MagicLink:
    task_id: int
    token: str        # unique, unguessable
    expires_at: Date
    used: bool
```

CEO agent includes clickable run links in chat messages. User clicks → task starts executing immediately.

**Arceus:** None. Tasks execute through orchestrator dispatch only.

---

## Priority Matrix

### Tier 1: Build This (Unlocks Core Value)

| Gap | Why Critical | Effort |
|-----|-------------|--------|
| **Per-company infra provisioning** | Without live URLs, Arceus is a local code generator. This is the leap to "ships real products." | 1-2 weeks |
| **Retrieval/RAG pipeline** | Raw pgvector isn't good enough. Reranking + context assembly = dramatically better agent context. | 3-5 days |
| **Tool registry** | Formal tool system enables new integrations without rewiring agents. Foundation for everything in Tier 2. | 3-5 days |

### Tier 2: Build Next (Differentiation)

| Gap | Why Important | Effort |
|-----|--------------|--------|
| **Billing & credits** | Can't charge users without this. Required for hosted product. | 1 week |
| **Browser agent** | Enables web scraping, form filling, platform posting. Unlocks growth/research capabilities. | 3-5 days |
| **Company documents** | Living docs > static artifacts. Agents build institutional knowledge. | 2-3 days |
| **WebSocket bidirectional** | Tool call visibility makes the dashboard dramatically better. Users see agents working. | 2-3 days |
| **Circuit breaker + retry** | Production reliability. External APIs fail. Need graceful handling. | 1-2 days |

### Tier 3: Build Later (Polish & Scale)

| Gap | Why Deferred | Effort |
|-----|-------------|--------|
| **Meta Ads** | Marketing is important but not core to the AI company OS. Can add post-launch. | 1-2 weeks |
| **Twitter/Social** | Same — valuable but not blocking. | 3-5 days |
| **Email outbound** | Useful for growth mode companies. Not needed for "build" mode MVP. | 3-5 days |
| **Night shift** | Autonomous execution is the dream but board-triggered is fine for MVP. | 2-3 days |
| **Recurring tasks** | Nice automation. Not critical for initial version. | 1-2 days |
| **Agent routing (LLM)** | CTO-assigned roles work. Intelligent routing is optimization, not foundation. | 2-3 days |
| **Rate limiting** | Needed for production multi-user. Not for single-user or small scale. | 1 day |
| **Security middleware** | Needed for production. Acceptable risk at MVP scale. | 2-3 days |
| **Magic links** | Cool UX feature. Not blocking anything. | 1 day |
| **Referral system** | Growth feature. Build when there are users to refer. | 1 day |
| **Content/Growth agents** | Specialized agents. Core agent system works without them. | 3-5 days |
| **fal.ai media gen** | Ad creative generation. Only needed when Meta Ads is built. | 1-2 days |
| **Observability** | Important for debugging production. console.log works for MVP. | 2-3 days |

---

## What Arceus Has That Polsia Doesn't

Not all gaps favor Polsia. Arceus has design advantages:

| Arceus Advantage | Details |
|-----------------|---------|
| **5-tier memory** | Habits + priming give behavioral continuity. Polsia has flat text summaries. |
| **Per-agent memory isolation** | Each agent has its own memory. Polsia shares one brain (can cause context pollution). |
| **Delegation memory** | CTO context flows to Developer with controlled scoping. Polsia has no delegation concept. |
| **Sprint cycle** | Structured sprint lifecycle with board review. Polsia has a flat task queue. |
| **Hierarchy & delegation** | Org chart with reporting lines. Polsia is flat (CEO → everyone). |
| **Verification gate** | Build + test check before board review. Polsia ships without automated verification. |
| **Git-based workspace versioning** | Sprint tags, rollback, diff. Polsia deploys without version management. |
| **Budget with hard stop** | $20 default, progressive alerts, hard stop at 100%. Polsia uses credits but no hard enforcement. |
| **CEO as company voice** | CEO naturally communicates budget, progress, proposals. Polsia's CEO is more of a router. |

---

## Recommended Reading Order

For anyone new to this analysis, read the Polsia codebase in this order:

1. **Types** (pages 13-34) — data model overview
2. **Models** (pages 110-120) — SQLAlchemy schemas
3. **Agent base class** (pages 191-193) — how agents work
4. **Task execution graph** (pages 200-203) — LangGraph state machine
5. **Tool registry** (pages 182-190) — MCP-style tool system
6. **CEO agent** (pages 196-200) — how the CEO routes and chats
7. **Retrieval pipeline** (pages 398-425) — the 5-stage RAG system
8. **Memory service** (pages 394-398) — 3-layer write/read
9. **Infrastructure provisioner** (pages 150-151) — per-company setup
10. **Workers** (pages 205-212) — Celery task execution + night shift
