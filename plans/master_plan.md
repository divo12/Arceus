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
| 4 | Persistence (PostgreSQL + Redis, 15 tables, Drizzle) | DRAFT | [specs/04-persistence.md](specs/04-persistence.md) |
| 5a | Hippocampus Core — Remember + Learn + Meeting Memory (4 LLM calls, 5 tiers, TypeScript) | LOCKED | [specs/05a-hippocampus-core.md](specs/05a-hippocampus-core.md) |
| 5b | Hippocampus Intelligence — Patterns + Promotion + Consolidation | POST-MVP | [specs/05b-hippocampus-intelligence.md](specs/05b-hippocampus-intelligence.md) |
| 6 | Sprint Cycle (incrementing sprints, CEO proposes next, fixed team) | LOCKED | [specs/06-sprint-cycle.md](specs/06-sprint-cycle.md) |
| 7 | Delegation Memory (CTO context flows to Developer via Hippocampus) | LOCKED | [specs/07-delegation-memory.md](specs/07-delegation-memory.md) |

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
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
| Auth / multi-user | Single-user sufficient for demo |
| CEO heartbeat with real autonomy | Needs CEO authority to reprioritize/reassign — complex orchestrator coordination |
| Hippocampus memory system | MVP works with artifact handoff; memory adds learning across sessions |
| Agent autonomy (pick own work, self-assign) | Requires heartbeat + inbox + delegation protocol |
| Sub-agent spawning | Phase 4+ complexity |
| Database persistence | In-memory sufficient for demo; add when stability matters |
| Cost tracking | Fields exist but unused; add when budget enforcement needed |
| Multi-company | Schema supports it; not needed for single demo |

## Open Questions
(populated as we go)
