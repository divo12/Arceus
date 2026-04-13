# Arceus Master Plan

> Living document. Updated as we discuss and design each piece.

## Vision
A startup that creates startups. User = Board of Directors. AI = the entire company.

## Specs

| # | Spec | Status | File |
|---|------|--------|------|
| 0 | System Architecture (complete runtime, data flow, file structure) | LOCKED | [specs/00-system-architecture.md](specs/00-system-architecture.md) |

## Feature Specs (in order of discussion)

| # | Spec | Status | File |
|---|------|--------|------|
| 1 | Onboarding → CEO Chat → Idea Refinement → Team Hire → Task Kickoff | LOCKED | [specs/01-onboarding-to-kickoff.md](specs/01-onboarding-to-kickoff.md) |
| 2 | Agent Execution (orchestrator-driven, parallel, artifacts) | LOCKED | [specs/02-agent-execution.md](specs/02-agent-execution.md) |
| 3 | The Living Dashboard (single page, phase-adaptive, CEO chat + preview) | LOCKED | [specs/03-living-dashboard.md](specs/03-living-dashboard.md) |
| 4 | Persistence (Supabase Postgres + Redis, 19 tables, Drizzle) | UPDATED | [specs/04-persistence.md](specs/04-persistence.md) |
| 5a | Hippocampus Core — Remember + Learn + Meeting Memory (4 LLM calls, 5 tiers, TypeScript) | LOCKED | [specs/05a-hippocampus-core.md](specs/05a-hippocampus-core.md) |
| 5b | Hippocampus Intelligence — Patterns + Promotion + Consolidation | POST-MVP | [specs/05b-hippocampus-intelligence.md](specs/05b-hippocampus-intelligence.md) |
| 6 | Sprint Cycle (incrementing sprints, CEO proposes next, fixed team) | LOCKED | [specs/06-sprint-cycle.md](specs/06-sprint-cycle.md) |
| 7 | Delegation Memory (CTO context flows to Developer via Hippocampus) | LOCKED | [specs/07-delegation-memory.md](specs/07-delegation-memory.md) |
| 8 | Product Storage (git per company, Supabase Storage bundles, workspace manager) | DRAFT | [specs/08-product-storage.md](specs/08-product-storage.md) |
| 9 | Product Verification (Tester writes tests, orchestrator gate, regression) | DRAFT | [specs/09-product-verification.md](specs/09-product-verification.md) |
| 10 | Budget & Cost Control ($20 default, hard stop, Azure token tracking) | DRAFT | [specs/10-budget-cost-control.md](specs/10-budget-cost-control.md) |

## Planned Specs (not yet written)

| # | Spec | Description |
|---|------|-------------|
| 11 | Deployment & Infrastructure | Docker, health checks, crash recovery, startup sequence |
| 12 | Product Preview & Hosting | Framework detection, preview builds, live iframe serving |
| 13 | Auth & Multi-Tenancy | Supabase Auth, company isolation, RLS |
| 14 | Observability | Structured logging, error alerting, sprint crash recovery |
| 15 | Security & Sandboxing | Code execution sandbox, network isolation, prompt injection defense |

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Infrastructure provider | **Supabase** (Postgres + Storage + future Auth) | One project, one bill. Free tier for MVP. Eliminates persistent volume need. |
| Storage strategy | **Local disk is cache, Supabase is truth** | Git bundles to Supabase Storage. Cold start restores from bundle. No persistent volumes. |
| Git per company | Auto-commit per task, tag per sprint | Versioning, rollback, diff for free. Sprint tags = rollback points. |
| Product testing | **Tester agent writes code, orchestrator runs gates** | Tester and Developer parallel. Tests accumulate across sprints = free regression. |
| Budget model | **$20 default, per-company hard limit, per-sprint soft limit** | Hard stop at 100%. Soft warning on sprint overage. Progressive alerts at 50/75/90%. |
| Cost tracking | **Exact for direct Azure calls, estimated for OpenCode** | Azure API returns token counts. OpenCode SDK doesn't expose usage. Estimate from text length. |
| Auth | Skip for MVP | Single-user, reduces friction |
| CEO chat engine | OpenCode SDK | Already integrated in this branch |
| Team hiring | Strategy approval (Option C) | One approval click, not per-hire |
| Chat → Strategy | Natural convergence | CEO decides when idea is concrete, no manual trigger |
| Agent names | Humanized | Avery, Lin, Mina, Jules — feels like real employees |
| Heartbeat | CEO: server-side event emission. Others: none | Orchestrator-driven execution, CEO voice for updates |
| Agent execution | Parallel where dependencies allow | PM + Designer can run simultaneously |
| Context handoff | Artifacts (server injects into next agent's prompt) | Cleaner than filesystem, server controls what each agent sees |
| Azure content filter | Test first, design for provider swappability | May not reproduce with SDK path |

## Post-MVP Backlog

| Feature | Why Deferred |
|---------|-------------|
| Auth / multi-user | Spec 13 planned. Single-user sufficient for first hosted version. |
| Tier 2 runtime verification (Playwright) | Spec 09 post-MVP section. ~200MB dependency. Tier 1 (build+test) sufficient for MVP. |
| CEO heartbeat with real autonomy | Needs CEO authority to reprioritize/reassign — complex orchestrator coordination |
| Hippocampus memory system | MVP works with artifact handoff; memory adds learning across sessions |
| Agent autonomy (pick own work, self-assign) | Requires heartbeat + inbox + delegation protocol |
| Sub-agent spawning | Phase 4+ complexity |
| Multi-company | Schema supports it; enforce with Supabase RLS when auth is added |
| GitHub export | Push workspace git repo to user's GitHub. Killer feature, not MVP. |
| Supabase Realtime | Replace custom SSE with Postgres change notifications. Nice-to-have. |

## Open Questions
(populated as we go)
