# Arceus Monorepo Restructuring Plan

> **Status:** Draft  
> **Date:** 2026-04-18  
> **Scope:** Full monorepo — `apps/api/src/`, `packages/contracts`, `apps/web/`, new `packages/task-engine`  
> **Migration style:** Big-bang — single coordinated restructure, all imports updated at once  
> **Constraint:** Pure structural refactor — zero behavior changes

---

## 1. Problem Statement

The codebase grew from an MVP into a complex autonomous-company platform with 25+ domain concerns. The code structure never caught up. The result:

| File | LOC | Problem |
|------|-----|---------|
| `apps/api/src/orchestrator.ts` | **~5,100** | 25 domains crammed into one file: tasks, sprints, meetings, agents, heartbeats, memory, workspace, preview, skills, skill evolution, ATA pipeline, pattern learning, prompts, governance, artifacts, event bridge |
| `apps/api/src/server.ts` | **~1,990** | ~87 HTTP routes across 22 domains, engine initialization, inline business logic |
| `apps/api/src/` (total) | **45 files** | Flat directory — no domain grouping, new features (skill-evolution, skill-governance, graph-store, graph-emitter, meeting-resolution, meeting-synthesis) added as more flat files |
| `packages/contracts/src/domain.ts` | **~900** | Single file with all Zod schemas — company, tasks, agents, sprints, meetings, memory, audit, AND the entire Spec 14 type system (skills, ATA, patterns, mutations, attributions) |
| `store.ts` ↔ `control-plane.ts` | — | Circular dependency via `cpNotifyStateChange` |

### Recent additions that worsened the structure

The Spec 14 (Self-Evolution) and Spec 18 (Meeting Pipeline) implementations added significant new code without restructuring:

**Spec 14 — Skill Evolution (new in last 6 commits):**
- `skill-evolution.ts` (544 LOC) — LLM integration layer, 8 prompt builders, 8 Zod schemas
- `skill-governance.ts` (415 LOC) — trust-tier gating, budget caps, shell-command linting
- ~500 lines added to `orchestrator.ts` — skill classification, cross-sprint transfer, pattern promotion
- ~130 lines added to `server.ts` — 12 new routes for skills, mutations, attributions, patterns
- ~361 lines added to `contracts/domain.ts` — SkillArtifact, SkillMutation, ATA types, Pattern types

**Spec 18 — Meeting Pipeline (new):**
- `meeting-resolution.ts` (328 LOC) — CEO resolution + decision execution
- `meeting-synthesis.ts` (155 LOC) — LLM conflict/blocker detection

**Spec 22 — Graph Debug UI (new):**
- `graph-store.ts` (405 LOC) — in-memory execution graph
- `graph-emitter.ts` (484 LOC) — orchestrator → graph event translation

All added as flat files in `apps/api/src/`. The pattern is clear: every new feature adds 1-3 more flat files, making the directory harder to navigate.

---

## 2. Design Principles

1. **Feature-slice architecture** — group by domain, not by technical layer
2. **One file, one purpose** — each file handles a single cohesive concern
3. **Barrel exports** — each domain folder has an `index.ts`; consumers import from the folder
4. **Dependency injection** — pure logic modules receive side-effect callbacks, no direct imports of I/O
5. **Route plugins** — each domain's HTTP routes are a Fastify plugin, registered by a slim `server.ts`
6. **Packages own domain logic** — reusable business rules live in `packages/`, API-specific glue lives in `apps/api/`

---

## 3. Phase 1: Expand `packages/contracts` — Domain Type Modules

Split the monolith `domain.ts` into per-domain type files. This is the foundation — every package and app imports from here.

### Current state
```
packages/contracts/src/
├── domain.ts    # ~900 lines — ALL Zod schemas and types
├── events.ts    # Domain events
└── index.ts     # Re-exports
```

### Target state
```
packages/contracts/src/
├── index.ts                # Re-exports everything (backward compatible)
├── events.ts               # Keep as-is
├── company.ts              # Company, FundamentalIdea, Strategy
├── agents.ts               # Agent, AgentIdentity, SessionBinding, Role, Hierarchy
├── tasks.ts                # Task, TaskStatus, TaskKind, priority, PlannerState, ExecutorState, VerifierState
├── sprints.ts              # Sprint, SprintStatus, SprintSnapshot
├── meetings.ts             # Meeting, MeetingSchedule, Contribution, Synthesis, Resolution
├── approvals.ts            # Approval, ApprovalType, ApprovalStatus
├── artifacts.ts            # Artifact, ArtifactKind
├── memory.ts               # MemoryUnit, Habit, PrimingState
├── governance.ts           # PolicyRule, TrustTier, ServiceRegistryEntry
├── audit.ts                # AuditEvent, AuditCategory, AuditSeverity
├── state.ts                # CompanySnapshot, StateMutation, SnapshotVersion, Transition
├── chat.ts                 # ChatMessage, CardType
├── workspace.ts            # Workspace, Asset
├── beats.ts                # BeatRecord, BeatRequest
├── skills.ts               # SkillArtifact, SkillStatus, SkillTestCase, SkillHealthReport,
│                           #   FailureAttribution, SkillMutation, SkillMutationStatus,
│                           #   SkillTestResult
├── ata.ts                  # ATATestScenario, ATADryRunResult, ATAReviewVerdict, ATAPipelineResult
└── patterns.ts             # Pattern, PatternOutcome, PatternCluster, SkillCandidate
```

**Why separate `skills.ts`, `ata.ts`, `patterns.ts`?** The Spec 14 type system is large (~360 lines) and internally cohesive. Three files align with the three phases: skill CRUD, automated testing, and emergent discovery.

**Verification:** `tsc --noEmit` across monorepo — all imports via `@arceus/contracts` resolve unchanged.

---

## 4. Phase 2: Create `packages/task-engine` — Reusable Task/Sprint Logic

Extract pure domain logic from `orchestrator.ts` that has no dependency on API infrastructure (no OpenCode, no HTTP, no Azure OpenAI).

```
packages/task-engine/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── task-state-machine.ts    # setTaskStatus cascading logic, dependency promotion, artifact propagation
    ├── task-helpers.ts          # createWorkflowTask, attachChildTask, isTaskReady, sort weights
    ├── sprint-lifecycle.ts      # createSprintRecord, checkSprintCompletion, finalizeSprintCompletion
    └── execution-cycle.ts       # shouldPauseForBoardReview, completeExecutionCycle, queue management
```

**Dependencies:** `@arceus/contracts` only. Side effects (audit, emit, store mutations, memory, escalation) are injected as callbacks — keeps it testable and reusable.

**Verification:** Unit tests for task state transitions pass. `tsc --noEmit`.

---

## 5. Phase 3: Restructure `apps/api/src/` — The Main Event

This is the primary restructuring. `orchestrator.ts` (~5,100 LOC) is decomposed across 14 domain folders. `server.ts` (~1,990 LOC) is split into a slim bootstrap + 20 route plugins.

### Current state (45 flat files)
```
apps/api/src/
├── orchestrator.ts          # 5,100 LOC god file
├── server.ts                # 1,990 LOC route monolith
├── skill-evolution.ts       # 544 LOC
├── skill-governance.ts      # 415 LOC
├── graph-emitter.ts         # 484 LOC
├── graph-store.ts           # 405 LOC
├── meeting-resolution.ts    # 328 LOC
├── meeting-synthesis.ts     # 155 LOC
├── control-plane.ts         # 900 LOC
├── store.ts                 # 700 LOC
├── ceo.ts                   # 600 LOC
├── preview.ts               # 600 LOC
├── workspace-scaffold.ts    # 500 LOC
├── workspace-manager.ts     # 400 LOC
├── service-registry.ts      # 400 LOC
├── task-planner.ts          # 350 LOC
├── sprint-review.ts         # 200 LOC
├── ... (14 more flat files)
└── config/                  # Already organized — keep as-is
```

### Target state
```
apps/api/src/
├── server.ts                       # ~150 LOC: Fastify create, CORS, register route plugins, init engines
├── index.ts                        # Entry point
│
├── config/                         # UNCHANGED — already organized
│   ├── env.ts
│   ├── audit.ts / audit.json
│   ├── heartbeat.ts / heartbeat.json
│   ├── orchestrator.ts
│   ├── persistence.ts
│   ├── planner.ts
│   ├── preview.ts
│   ├── runtime.ts
│   ├── server.ts
│   └── index.ts
│
├── routes/                         # HTTP route plugins — one file per domain
│   ├── company.routes.ts           # /api/company, /api/company/bootstrap          (~60 LOC)
│   ├── strategy.routes.ts          # /api/strategy/*, /api/company/strategy         (~80 LOC)
│   ├── chat.routes.ts              # /api/chat/ceo, /api/chat/ceo/stream            (~30 LOC)
│   ├── tasks.routes.ts             # /api/tasks                                     (~20 LOC)
│   ├── sprints.routes.ts           # /api/sprints, /api/sprint-proposal/*           (~60 LOC)
│   ├── meetings.routes.ts          # /api/meetings                                  (~20 LOC)
│   ├── agents.routes.ts            # /api/employees, /api/employee-*                (~100 LOC)
│   ├── heartbeat.routes.ts         # /api/heartbeat/*                               (~120 LOC)
│   ├── orchestrator.routes.ts      # /api/orchestrator/*, /api/board-review/*       (~80 LOC)
│   ├── governance.routes.ts        # /api/governance/*                              (~100 LOC)
│   ├── control-plane.routes.ts     # /api/control-plane/*                           (~60 LOC)
│   ├── audit.routes.ts             # /api/audit/*                                   (~60 LOC)
│   ├── workspace.routes.ts         # /api/workspace/*                               (~80 LOC)
│   ├── preview.routes.ts           # /api/preview/*                                 (~40 LOC)
│   ├── artifacts.routes.ts         # /api/artifacts, /api/artifacts/:id             (~50 LOC)
│   ├── debug.routes.ts             # /api/debug/*, /api/execution-flow              (~80 LOC)
│   ├── service-registry.routes.ts  # /api/service-registry/*                        (~60 LOC)
│   ├── hippocampus.routes.ts       # /api/hippocampus/*                             (~60 LOC)
│   ├── skills.routes.ts            # /api/skills/*, /api/patterns/*  [NEW]          (~160 LOC)
│   └── health.routes.ts            # /health, /api/runtime, /logs                   (~40 LOC)
│
├── agents/                         # Agent identity, sessions, CEO logic
│   ├── index.ts
│   ├── ceo.ts                      # ← from ceo.ts
│   ├── chat.ts                     # ← from chat.ts
│   ├── sessions.ts                 # ← from orchestrator.ts: createAgentSession, ensureAgentSession,
│   │                               #   touchAgentSession, updateAgentSessionState, resolveRoleBySessionId
│   └── directory.ts                # ← from server.ts inline: getEmployeeDirectory
│
├── tasks/                          # Task planning & specialist execution
│   ├── index.ts
│   ├── planner.ts                  # ← from task-planner.ts (LLM workflow plan generation)
│   ├── specialist-executor.ts      # ← from orchestrator.ts: executeSpecialistTask,
│   │                               #   pruneAlreadyCompletedSpecialistTasks
│   ├── autonomous.ts               # ← from orchestrator.ts: runAutonomousReadyTasks, queue counting
│   └── bug-fields.ts               # ← from orchestrator.ts: buildGateFailureBugFields, buildBugFixTaskFields
│
├── meetings/                       # Meeting coordination (Spec 18)
│   ├── index.ts
│   ├── synthesis.ts                # ← from meeting-synthesis.ts (LLM conflict detection)
│   ├── resolution.ts               # ← from meeting-resolution.ts (CEO decisions + execution)
│   ├── recording.ts                # ← from orchestrator.ts: recordMeeting, recordCeoCardMeeting,
│   │                               #   deriveMeetingMemoryModifications
│   └── effects.ts                  # ← from orchestrator.ts: applyMeetingEffects, applyTaskModification,
│                                   #   applyMemoryModification, createMarketingExternalApproval,
│                                   #   approvePendingBoardApprovals
│
├── sprints/                        # Sprint orchestration (calls task-engine)
│   ├── index.ts
│   ├── proposals.ts                # ← from orchestrator.ts: triggerCeoSprintProposal,
│   │                               #   approveSprintProposal, rejectSprintProposal
│   ├── review.ts                   # ← from orchestrator.ts + sprint-review.ts:
│   │                               #   executeSprintReviewVerification, executeSprintFinalGate,
│   │                               #   executeRetestAfterRework
│   └── execution.ts                # ← from orchestrator.ts: beginSprintExecution
│
├── heartbeats/                     # Heartbeat execution layer (Spec 12)
│   ├── index.ts
│   ├── beat-executor.ts            # ← from orchestrator.ts: executeBeatTask (~263 LOC)
│   ├── checklist-executor.ts       # ← from orchestrator.ts: executeChecklistAction,
│   │                               #   triggerCeoSprintProposalFromBeat, executeSprintReviewEscalation
│   └── event-bridge.ts             # ← from orchestrator.ts: startEventBridge, processEvent (~195 LOC)
│
├── memory/                         # Hippocampus integration bridge (Spec 05a)
│   ├── index.ts
│   ├── extractors.ts               # ← from orchestrator.ts: llmFactExtractor, llmActionDecider,
│   │                               #   llmPrimingGenerator, llmHabitMatcher
│   ├── context.ts                  # ← from orchestrator.ts: formatHippocampusContext
│   └── operations.ts               # ← from orchestrator.ts: updateRoleMemory, enrichRoleMemory,
│                                   #   clearRoleBlockers, deliverUiDesignerMemoryHandoff,
│                                   #   deliverSkillsLeadMemoryHandoff
│
├── skills/                         # Skill system + Evolution (Spec 14)  [EXPANDED]
│   ├── index.ts
│   ├── loader.ts                   # ← from orchestrator.ts: parseSkillFrontmatter, loadSkillsForRole,
│   │                               #   buildSkillMenu, getSkillBody
│   ├── catalog.ts                  # ← from orchestrator.ts: ensureSkillsSeeded, buildSkillCatalog,
│   │                               #   buildSkillSection (Spec 14 Phase 1 LLM classification support)
│   ├── classifier.ts               # ← from orchestrator.ts: skillClassifierSchema, classifyTaskSkills,
│   │                               #   matchAndRecordSkills (LLM-based skill → task matching)
│   ├── evolution.ts                # ← from skill-evolution.ts: initSkillEvolution, all prompt builders,
│   │                               #   all Zod schemas (LLM dependency injection for ATA + mutations)
│   ├── governance.ts               # ← from skill-governance.ts: canProposeMutation, recordMutationProposal,
│   │                               #   applyGovernanceToMutation, lintSkillContent
│   ├── packaging.ts                # ← from orchestrator.ts: materializeSkillPackage, slugifySkillName,
│   │                               #   buildSkillAuthoringArtifact
│   └── cross-sprint.ts             # ← from orchestrator.ts: runCrossSprintTransfer,
│                                   #   runPatternPromotionSweep (Phase 6 lifecycle)
│
├── orchestration/                  # High-level flow control
│   ├── index.ts
│   ├── execution-cycle.ts          # ← from orchestrator.ts: completeExecutionCycle,
│   │                               #   pauseForBoardReview, reconcilePostReviewExecution
│   ├── board-review.ts             # ← from orchestrator.ts: approveBoardReview, stopExecution
│   ├── bootstrap.ts                # ← from bootstrap.ts: bootstrapCompanyWithWorkspace
│   └── reactive.ts                 # ← from orchestrator.ts: setReactiveEventEmitter, emitReactive,
│                                   #   emitReactiveBroadcast, triggerEscalationMeeting
│
├── prompts/                        # Prompt construction
│   ├── index.ts
│   ├── specialist.ts               # ← from orchestrator.ts: buildSpecialistTaskPrompt
│   ├── developer.ts                # ← from orchestrator.ts: buildDeveloperBeatPrompt
│   ├── artifacts.ts                # ← from orchestrator.ts: resolveIncomingArtifacts,
│   │                               #   buildTesterArtifact, buildDesignDirectionArtifact,
│   │                               #   buildMarketingArtifact
│   └── llm.ts                      # ← from orchestrator.ts: runPromptText, getToolsForPrompt
│
├── workspace/                      # Workspace & preview (Spec 08/09)
│   ├── index.ts
│   ├── manager.ts                  # ← from workspace-manager.ts
│   ├── scaffold.ts                 # ← from workspace-scaffold.ts
│   ├── monitor.ts                  # ← from orchestrator.ts: pollDeveloperWorkspaceChanges,
│   │                               #   startDeveloperWorkspaceMonitor, stopDeveloperWorkspaceMonitor,
│   │                               #   collectWorkspaceSnapshot
│   ├── preview.ts                  # ← from preview.ts
│   └── watchdog.ts                 # ← from orchestrator.ts: scheduleDeveloperWatchdog,
│                                   #   failDeveloperStall, clearDeveloperWatchdog
│
├── persistence/                    # Data access layer
│   ├── index.ts
│   ├── store.ts                    # ← from store.ts
│   ├── company-state.ts            # ← from company-state.ts
│   ├── artifact-persistence.ts     # ← from artifact-persistence.ts
│   ├── supabase-storage.ts         # ← from supabase-storage.ts
│   └── control-plane.ts            # ← from control-plane.ts
│
├── governance/                     # Trust, policy, service registry (Spec 13)
│   ├── index.ts
│   ├── service-registry.ts         # ← from service-registry.ts
│   └── stats.ts                    # ← from server.ts inline: governance stats aggregation
│
├── observability/                  # Audit, activity, graph instrumentation (Spec 11/22)
│   ├── index.ts
│   ├── audit-ledger.ts             # ← from audit-ledger.ts
│   ├── activity.ts                 # ← from activity.ts
│   ├── graph-store.ts              # ← from graph-store.ts (Spec 22 in-memory DAG)
│   └── graph-emitter.ts            # ← from graph-emitter.ts (Spec 22 orchestrator → graph bridge)
│
└── infra/                          # Infrastructure clients & utilities
    ├── index.ts
    ├── azure-openai.ts             # ← from azure-openai.ts
    ├── opencode.ts                 # ← from opencode.ts
    ├── resilience.ts               # ← from resilience.ts
    ├── runtime.ts                  # ← from runtime.ts
    ├── pg-errors.ts                # ← from pg-errors.ts
    └── utils.ts                    # ← from orchestrator.ts: nowIso, truncateTelemetry, uniqueStrings,
                                    #   extractPreviewUrls, sanitizeToolArgs
```

### What happens to `orchestrator.ts` (~5,100 LOC)

Every function moves to its domain folder. Here's the complete extraction map:

| Lines | Functions | Destination |
|-------|-----------|-------------|
| 64–120 | `setReactiveEventEmitter`, `emitReactive`, `emitReactiveBroadcast`, `triggerEscalationMeeting` | `orchestration/reactive.ts` |
| 133–220 | `llmFactExtractor`, `llmActionDecider`, `llmPrimingGenerator`, `llmHabitMatcher` | `memory/extractors.ts` |
| 255–435 | `ensureSkillsSeeded`, `buildSkillCatalog`, `buildSkillSection`, `classifyTaskSkills` | `skills/catalog.ts` + `skills/classifier.ts` |
| 437–496 | `matchAndRecordSkills` | `skills/classifier.ts` |
| 484–600 | `updateAgentSessionState`, `touchAgentSession`, `scheduleDeveloperWatchdog`, `failDeveloperStall` | `agents/sessions.ts` + `workspace/watchdog.ts` |
| 603–819 | Workspace monitoring, snapshot collection, live preview auto-start | `workspace/monitor.ts` |
| 865–930 | `addArtifact`, `writeArtifactToWorkspace`, `syncWorkspaceCheckpoint` | `workspace/monitor.ts` |
| 1071–1310 | `createSprintRecord`, `triggerCeoSprintProposal`, `checkSprintCompletion` | `sprints/proposals.ts` (API layer calls `packages/task-engine`) |
| 1315–1365 | `finalizeSprintCompletion`, `tagCurrentSprintSnapshot` | `sprints/proposals.ts` |
| 1369–1776 | `executeSprintReviewVerification`, `executeSprintFinalGate`, `executeRetestAfterRework` | `sprints/review.ts` |
| 2076–2380 | Task CRUD helpers, `createWorkflowTask`, `setTaskStatus`, `isTaskReady` | `packages/task-engine` (pure logic) |
| 2413–2629 | `recordCeoCardMeeting`, `recordMeeting`, meeting memory/effects | `meetings/recording.ts` + `meetings/effects.ts` |
| 2650–2895 | `buildSpecialistTaskPrompt`, `buildDeveloperBeatPrompt`, artifact builders | `prompts/specialist.ts` + `prompts/developer.ts` + `prompts/artifacts.ts` |
| 2898–3093 | Meeting context builders, approval helpers | `meetings/effects.ts` |
| 3120–3190 | `runCrossSprintTransfer`, `runPatternPromotionSweep` | `skills/cross-sprint.ts` |
| 3534–3841 | `executeSpecialistTask`, `pruneAlreadyCompletedSpecialistTasks`, `runAutonomousReadyTasks` | `tasks/specialist-executor.ts` + `tasks/autonomous.ts` |
| 3843–3976 | `shouldPauseForBoardReview`, `completeExecutionCycle`, `reconcilePostReviewExecution` | `orchestration/execution-cycle.ts` |
| 3978–4167 | `createAgentSession`, `ensureAgentSession`, `runPromptText`, `getToolsForPrompt` | `agents/sessions.ts` + `prompts/llm.ts` |
| 4286–4710 | `executeBeatTask`, `executeChecklistAction`, `triggerCeoSprintProposalFromBeat` | `heartbeats/beat-executor.ts` + `heartbeats/checklist-executor.ts` |
| 4940–5056 | `approveSprintProposal`, `rejectSprintProposal`, `beginSprintExecution`, session getters | `sprints/proposals.ts` + `sprints/execution.ts` |
| 5058–5291 | `startEventBridge`, `processEvent` | `heartbeats/event-bridge.ts` |
| 5293–5372 | `approveBoardReview` | `orchestration/board-review.ts` |

After extraction: **`orchestrator.ts` is deleted.**

### What happens to `server.ts` (~1,990 LOC)

Split into a slim `server.ts` (~150 LOC) that:
1. Creates Fastify instance with CORS, error handler
2. Registers each `routes/*.routes.ts` as a Fastify plugin
3. Initializes HeartbeatEngine, MeetingPipeline, MeetingScheduler at startup
4. Handles graceful shutdown

Each route plugin is `async function (app, opts)` — standard Fastify pattern.

### What happens to existing flat files

**Files that move (content unchanged, just new path):**

| From | To |
|------|-----|
| `ceo.ts` | `agents/ceo.ts` |
| `chat.ts` | `agents/chat.ts` |
| `task-planner.ts` | `tasks/planner.ts` |
| `meeting-synthesis.ts` | `meetings/synthesis.ts` |
| `meeting-resolution.ts` | `meetings/resolution.ts` |
| `sprint-review.ts` | `sprints/review-helpers.ts` |
| `skill-evolution.ts` | `skills/evolution.ts` |
| `skill-governance.ts` | `skills/governance.ts` |
| `workspace-manager.ts` | `workspace/manager.ts` |
| `workspace-scaffold.ts` | `workspace/scaffold.ts` |
| `preview.ts` | `workspace/preview.ts` |
| `store.ts` | `persistence/store.ts` |
| `company-state.ts` | `persistence/company-state.ts` |
| `control-plane.ts` | `persistence/control-plane.ts` |
| `artifact-persistence.ts` | `persistence/artifact-persistence.ts` |
| `supabase-storage.ts` | `persistence/supabase-storage.ts` |
| `service-registry.ts` | `governance/service-registry.ts` |
| `audit-ledger.ts` | `observability/audit-ledger.ts` |
| `activity.ts` | `observability/activity.ts` |
| `graph-store.ts` | `observability/graph-store.ts` |
| `graph-emitter.ts` | `observability/graph-emitter.ts` |
| `azure-openai.ts` | `infra/azure-openai.ts` |
| `opencode.ts` | `infra/opencode.ts` |
| `resilience.ts` | `infra/resilience.ts` |
| `bootstrap.ts` | `orchestration/bootstrap.ts` |
| `runtime.ts` | `infra/runtime.ts` |
| `pg-errors.ts` | `infra/pg-errors.ts` |

### Key architectural fixes

**1. Circular dependency** (`store.ts` ↔ `control-plane.ts`)

Currently: every mutation in `store.ts` directly calls `cpNotifyStateChange` from `control-plane.ts`, and `control-plane.ts` calls `store.ts` mutation functions. Refactor to EventEmitter:
- `store.ts` emits `'state-changed'` events after mutations
- `control-plane.ts` subscribes at initialization
- No direct cross-import

**2. Skill evolution wiring**

Currently: `skill-evolution.ts` calls `setSkillMutatorDeps()`, `setSkillTesterDeps()`, `setPatternLearnerDeps()` at startup with LLM prompt builders. This DI pattern is good — it stays. The file just moves to `skills/evolution.ts` and the orchestrator functions that call into it (`classifyTaskSkills`, `matchAndRecordSkills`, `runCrossSprintTransfer`) move to `skills/classifier.ts` and `skills/cross-sprint.ts`.

---

## 6. Phase 4: Clean Up `apps/web/`

Minor — group components into sub-folders, remove compiled `.js` duplicates:

### Current
```
apps/web/components/
├── chat-context.tsx
├── debug-detail-panel.tsx
├── debug-edge.tsx
├── debug-graph.tsx
├── debug-node.tsx
├── execution-flow.tsx
├── layout-shell.tsx
├── nav-shell.tsx
├── page-shell.tsx
├── resizable-split.tsx
├── sidebar.tsx
├── theme-provider.tsx
└── ui/
```

### Target
```
apps/web/components/
├── ui/                     # Keep existing primitives
├── layout/                 # ← layout-shell, nav-shell, page-shell, sidebar
├── debug/                  # ← debug-graph, debug-node, debug-edge, debug-detail-panel
├── chat/                   # ← chat-context
├── execution-flow.tsx      # Keep (standalone)
├── resizable-split.tsx     # Keep (standalone)
└── theme-provider.tsx      # Keep (standalone)
```

Also: remove compiled `.js` duplicates where `.tsx` source exists.

---

## 7. Packages Left Untouched

These packages are already well-organized with clear internal structure:

| Package | Structure | Reason to leave |
|---------|-----------|----------------|
| `packages/company-runtime/` | 18 files, domain-focused modules | Already clean. New Spec 14 files (skill-mutator, skill-tester, pattern-learner, skill-registry) follow existing patterns with DI + test files. |
| `packages/hippocampus/` | `backends/`, `engines/`, `tiers/` | Well-organized 3-tier hierarchy |
| `packages/db/` | 8 files (schema, client, tables) | Clean Drizzle ORM layer |
| `apps/api/src/config/` | 12 files | Already per-domain config |

---

## 8. Execution Steps

### Phase 1: Contracts expansion
| # | Step | Verify |
|---|------|--------|
| 1 | Split `domain.ts` → 18 type files (no logic changes, only file moves + re-exports) | `tsc --noEmit` |
| 2 | Update `index.ts` to re-export from new files | All `@arceus/contracts` imports resolve |

### Phase 2: Task engine package *(parallel with Phase 1)*
| # | Step | Verify |
|---|------|--------|
| 3 | Create `packages/task-engine/` with `package.json`, `tsconfig.json` | Package builds |
| 4 | Extract pure task/sprint state machine logic, inject side effects as callbacks | Unit tests pass |

### Phase 3: API restructuring *(depends on Phase 1 + 2)*
| # | Step | Verify |
|---|------|--------|
| 5 | Create all 14 domain folders + `index.ts` barrels | Folders exist |
| 6 | **Leaf modules first** (no internal deps): `infra/utils.ts`, `memory/extractors.ts` | `tsc --noEmit` |
| 7 | **Skills system**: `skills/loader.ts`, `skills/catalog.ts`, `skills/classifier.ts`, `skills/evolution.ts`, `skills/governance.ts`, `skills/cross-sprint.ts`, `skills/packaging.ts` | `tsc --noEmit` |
| 8 | **Mid-level**: `agents/sessions.ts`, `memory/operations.ts`, `prompts/*` | `tsc --noEmit` |
| 9 | **Heavy modules**: `tasks/specialist-executor.ts`, `heartbeats/beat-executor.ts`, `heartbeats/event-bridge.ts`, `sprints/review.ts` | `tsc --noEmit` |
| 10 | **Top-level**: `orchestration/*` (execution-cycle, board-review, reactive, bootstrap) | `tsc --noEmit` |
| 11 | Move existing flat files to domain folders (28 files) | `tsc --noEmit` |
| 12 | Split `server.ts` → `routes/*.routes.ts` (20 route plugins) | All routes respond |
| 13 | Fix circular dep: `store.ts` → EventEmitter pattern | `tsc --noEmit` |
| 14 | Delete `orchestrator.ts` and all flat files that were moved | Files gone, zero dangling imports |

### Phase 4: Web cleanup *(parallel with Phase 3)*
| # | Step | Verify |
|---|------|--------|
| 15 | Create `components/layout/`, `components/debug/`, `components/chat/` | Folders exist |
| 16 | Move components, update imports | `npm run build` |
| 17 | Remove `.js` duplicates | Build still works |

### Phase 5: Final validation
| # | Step | Verify |
|---|------|--------|
| 18 | `tsc --noEmit` | Zero type errors across monorepo |
| 19 | Start API server | `/health` returns 200 |
| 20 | Verify all ~87 routes respond | Fastify route table logged at startup |
| 21 | Start web app | Dashboard loads |
| 22 | Run `scripts/test-heartbeat-e2e.ts` | Heartbeat E2E passes |
| 23 | Run `scripts/test-governance-e2e.ts` | Governance routes respond |
| 24 | Verify heartbeat + meeting scheduler start/stop | Engine lifecycle works |
| 25 | Verify skill evolution: `/api/skills`, `/api/patterns` routes | Skill API responds |
| 26 | Grep for old import paths | Zero matches |

---

## 9. File Count Summary

| Area | Before | After | Delta |
|------|--------|-------|-------|
| `apps/api/src/` (flat files) | 45 | 0 | -45 |
| `apps/api/src/` (domain folders) | 1 (`config/`) | 15 | +14 |
| `apps/api/src/` (total files) | 57 | ~95 | +38 (but each is focused) |
| `apps/api/src/routes/` | 0 | 20 | +20 |
| `packages/contracts/src/` | 3 | 20 | +17 |
| `packages/task-engine/` | 0 | 5 | +5 |
| Largest single file | 5,100 LOC | ~350 LOC | -93% |
| Average file size | ~340 LOC | ~120 LOC | -65% |

---

## 10. Dependency Graph (Simplified)

```
                    ┌─────────────────────────┐
                    │    routes/*.routes.ts    │  ← HTTP layer (20 plugins)
                    └────────────┬────────────┘
                                 │ imports
            ┌────────────────────┼────────────────────┐
            ▼                    ▼                    ▼
     ┌──────────┐      ┌──────────────┐      ┌──────────┐
     │ agents/  │      │ orchestration │      │ skills/  │
     │ tasks/   │      │ sprints/     │      │ meetings/│
     │ prompts/ │      │ heartbeats/  │      │ memory/  │
     └────┬─────┘      └──────┬───────┘      └────┬─────┘
          │                   │                    │
          ▼                   ▼                    ▼
     ┌──────────┐      ┌──────────────┐      ┌──────────────┐
     │ infra/   │      │ persistence/ │      │ observability/│
     │          │      │ governance/  │      │              │
     └────┬─────┘      └──────┬───────┘      └──────────────┘
          │                   │
          ▼                   ▼
  ┌───────────────┐   ┌──────────────┐   ┌────────────────┐
  │ @arceus/      │   │ @arceus/     │   │ @arceus/       │
  │ contracts     │   │ task-engine  │   │ company-runtime│
  │               │   │              │   │ hippocampus    │
  └───────────────┘   └──────────────┘   └────────────────┘
```

**Import rules:**
- `routes/` → domain folders (never direct to infra or persistence)
- Domain folders → `infra/`, `persistence/`, `observability/`, packages
- `infra/` → external clients only
- `persistence/` → `@arceus/db` + external storage
- No circular imports between domain folders (enforce via barrel exports)

---

## 11. Decisions

| Decision | Rationale |
|----------|-----------|
| Scope IN: `apps/api/src/`, `packages/contracts`, new `packages/task-engine`, `apps/web/` | These have the structural debt |
| Scope OUT: `company-runtime`, `hippocampus`, `db` | Already well-organized |
| Big-bang migration | Avoids dual-import period; single clean commit |
| `*.routes.ts` naming | Distinguishes route plugins from domain modules |
| `index.ts` barrels per folder | Consumers import from folder, implementation files stay internal |
| EventEmitter for store↔control-plane | Breaks circular dep without changing behavior |
| `skills/` folder expanded (7 files) | Spec 14 is a major subsystem — deserves proper domain folder, not 2 flat files |
| `packages/task-engine` as new package | Task state machine is pure domain logic used by multiple consumers |
| No behavior changes | Pure structural refactor — every function keeps its exact implementation |
