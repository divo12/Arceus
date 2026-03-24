# Arceus — Your AI-Powered Founding Team

## Table of Contents

1. [Vision](#1-vision)
2. [Problem Statement](#2-problem-statement)
3. [Target Users](#3-target-users)
4. [Core Thesis](#4-core-thesis)
5. [System Overview](#5-system-overview)
6. [End-to-End Flow](#6-end-to-end-flow)
7. [Foundational Constructs](#7-foundational-constructs)
   - [Layer 0: Platform Entities](#layer-0-platform-entities)
   - [Layer 1: Organization — Hierarchy & Roles](#layer-1-organization--hierarchy--roles)
   - [Layer 2: Agent System](#layer-2-agent-system)
   - [Layer 3: Task System](#layer-3-task-system)
   - [Layer 4: Memory System — Hippocampus](#layer-4-memory-system--hippocampus)
   - [Layer 5: Communication — Meeting Protocol](#layer-5-communication--meeting-protocol)
   - [Layer 6: Cross-Cutting — Audit, Tools & Skills](#layer-6-cross-cutting--audit-tools--skills)
8. [Construct Reference Table](#8-construct-reference-table)
9. [Relationships & Data Model](#9-relationships--data-model)
10. [Persistence Strategy](#10-persistence-strategy)
11. [Key Design Decisions](#11-key-design-decisions)
12. [Constraints & Rules](#12-constraints--rules)
13. [Dashboard](#13-dashboard)
14. [Backend API Design](#14-backend-api-design)
15. [Post-MVP Roadmap](#15-post-mvp-roadmap)

---

## 1. Vision

A startup is a temporal, evolving entity that solves a given problem within industrial, technological, and emotional constraints. The startup creation process itself is a pattern — a trajectory that attempts to solve the problem.

Today's dynamics: **10 employees × 1,000 companies.**

With the advancement of LLMs, their training techniques, and mathematics, we can shift this to: **<5 employees × N companies**, where N is very large.

**Arceus is a platform where a user provides an idea and a budget, and the system spins up an AI-staffed startup to build it.** The user operates as a Board of Directors — setting vision, making key decisions, and overseeing progress — while AI agents handle the entire execution: planning, engineering, research, and coordination.

---

## 2. Problem Statement

Arceus solves two fundamental problems:

1. **What to build?** — Refining a raw idea into a viable product through structured reasoning, market awareness, and first-principles decomposition.
2. **How to build it?** — Encompassing the full dynamics of the startup process so the user can delegate like a Board of Directors rather than personally executing every function.

---

## 3. Target Users

- **Idea-rich, resource-poor individuals** — People who have ideas or see patterns but lack the team, capital, or bandwidth to build.
- **Solo builders** — Folks who enjoy working alone but want to create something substantial.
- **Skill-focused creators** — Someone who wants to focus on one skill (coding, design, strategy) and delegate everything else to AI rather than hiring a team.

---

## 4. Core Thesis

Every startup always starts with a **core idea** — the Fundamental Idea. Even when a startup pivots, the core idea persists as the immutable truth. Examples:

- **Slack**: Started as a game with an in-chat feature. The chat became more popular than the game. Core idea: *a place where people meet for strategic interaction.*
- **Instagram**: Started with photo sharing, check-ins, and to-do lists. Pivoted to photos and reels as that was profitable. Core idea: *a platform where two users interact with activity.*

In Arceus, the `FundamentalIdea` construct captures this — `core_idea` is immutable; `current_direction` can evolve through user refinement.

---

## 5. System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│                      USER                            │
│            (Board of Directors)                       │
│  ┌──────────┐  ┌────────────────────────────────┐   │
│  │ CEO Chat │  │         Dashboard               │   │
│  │(bidir.)  │  │  Stats · Agents · Tasks · Memory│   │
│  └────┬─────┘  └──────────────┬─────────────────┘   │
└───────┼─────────────────────────┼────────────────────┘
        │                         │
┌───────┴─────────────────────────┴────────────────────┐
│                   STARTUP                             │
│                                                       │
│  ┌─────┐     ┌─────┐                                │
│  │ CEO │────→│ CTO │                                 │
│  └──┬──┘     └──┬──┘                                │
│     │           ├────────────┐                       │
│  ┌──┴───┐   ┌──┴───┐   ┌───┴────┐                  │
│  │  PM  │   │ Dev  │   │ML Eng  │   ← EmployeeAgents│
│  └──────┘   └──┬───┘   └────────┘                   │
│                 │                                     │
│          ┌──────┼──────┐                             │
│          │      │      │                             │
│         [G]    [S]    [E]    ← Spawned Agents        │
│       Generic Spec. Explor.    (ephemeral)           │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ Meetings (ONLY inter-employee comm channel)  │    │
│  │ Standups (scheduled) + Escalations (instant) │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  FundamentalIdea · Budget · Hierarchy · Tasks        │
│  Hippocampus · ReasoningBank · Tickets               │
└───────────────────────────────────────────────────────┘
```

### Dynamics of a Startup (Replicated in AI)

| Real Startup Role | Arceus Equivalent | Behavior |
|---|---|---|
| Board of Directors | **User** | Sets vision, approves direction, oversees budget, resolves escalations |
| CEO | **CEO EmployeeAgent** | Refines idea with user, decomposes vision into goals, coordinates with CTO |
| CTO | **CTO EmployeeAgent** | Translates goals into technical tasks, manages engineering |
| Product Manager | **PM EmployeeAgent** | Prioritizes features, manages scope, coordinates delivery |
| Developer | **Developer EmployeeAgent** | Executes technical tasks, spawns coding/browsing agents |
| ML Engineer | **ML EmployeeAgent** | Handles data/model tasks (when budget allows) |
| Contractors | **Spawned Agents** (Generic/Specialized/Exploratory) | Ephemeral workers that execute specific tasks and are destroyed after |

---

## 6. End-to-End Flow

### Phase 1: Idea → Startup Initialization

```
User enters idea + budget
        │
        ▼
┌─────────────────────────────────────────────┐
│  CEO Agent instantiated (first and only      │
│  agent at this point). Engages in            │
│  bidirectional chat with User to refine      │
│  the idea.                                   │
│                                              │
│  Output: FundamentalIdea                     │
│    - core_idea (immutable)                   │
│    - current_direction (can evolve)          │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  System (LLM-powered module, NOT an agent)   │
│  proposes org hierarchy based on:            │
│    - Refined idea (what skills are needed)   │
│    - Budget (what can be afforded)           │
│                                              │
│  Default templates:                          │
│    Minimum:  CEO → Full-stack Dev            │
│    Standard: CEO → CTO → [PM, Dev]           │
│    Full:     CEO → CTO → [PM → Dev, ML Eng]  │
│                                              │
│  User reviews, modifies, approves.           │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  All EmployeeAgents instantiated at once.    │
│  Each receives:                              │
│    - Role template (system prompt, tools,    │
│      skills, hierarchy level)                │
│    - Empty Hippocampus                       │
│    - Position in Hierarchy                   │
│    - SpawnRules for their role               │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
        Startup status: ACTIVE
```

### Phase 2: Task Decomposition & Execution

```
CEO decomposes FundamentalIdea into top-level Tasks
  (goals ARE Tasks — no separate Goal entity)
        │
        ▼
CEO assigns Tasks to direct reports ONLY
  (Tasks flow DOWN the hierarchy)
        │
        ▼
┌─────────────── TASK EXECUTION LOOP ─────────────────┐
│                                                      │
│  Employee receives Task                              │
│       │                                              │
│       ▼                                              │
│  LLM reasoning: Is this simple or complex?           │
│       │                     │                        │
│    Simple               Complex                      │
│       │                     │                        │
│  Self-execute          Decompose into sub-tasks      │
│       │                     │                        │
│       │              Spawn agents (parallel OK)      │
│       │              - GenericAgent                   │
│       │              - SpecializedAgent               │
│       │              - ExploratoryAgent               │
│       │              (governed by SpawnRules)         │
│       │                     │                        │
│       │              ReasoningBank selects relevant   │
│       │              top-k memories as context for    │
│       │              the spawned agent                │
│       │                     │                        │
│       │              Agent executes task              │
│       │              (has own WorkingMemory)          │
│       │                     │                        │
│       │              ┌──────┴──────┐                 │
│       │           Success       Failure/Blocker      │
│       │              │              │                 │
│       │         Parent agent    Escalation Meeting   │
│       │         verifies work   with parent's parent │
│       │              │              │                 │
│       │         Always distill  Chain of Meetings    │
│       │         trajectory back  up hierarchy →      │
│       │         to parent memory  eventually → User  │
│       │              │                               │
│       │         Spawned agent destroyed               │
│       │              │                               │
│       ▼              ▼                               │
│  Light consolidation (ReasoningBank)                 │
│  - distill trajectory → MemoryUnits                  │
│  - quick skill creation if applicable                │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Phase 3: Ongoing Operation — Meetings & Memory

```
┌──────────── STANDUP MEETING (Scheduled) ────────────┐
│                                                      │
│  Trigger: Periodic schedule (e.g., daily)            │
│                                                      │
│  Structured format, each Employee submits:           │
│  ┌─────────────────────────────────────────────┐     │
│  │  1. What I did (completed tasks, outcomes)  │     │
│  │  2. What I'm doing (active tasks)           │     │
│  │  3. Blockers (unresolvable at my level)     │     │
│  │  4. Learnings & pattern observations        │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
│  CEO provides:                                       │
│  - User feedback                                     │
│  - Insights from own research                        │
│  - Company vision updates                            │
│                                                      │
│  Outputs:                                            │
│  ┌─────────────────────────────────────────────┐     │
│  │  → Decisions recorded (persisted in Postgres)│    │
│  │  → Learnings distilled to employee memory    │    │
│  │  → Task list modified (reprioritize/cancel)  │    │
│  │  → Unresolved blockers escalated up          │    │
│  │  → DEEP consolidation triggered:             │    │
│  │    · Patterns evolve / merge / prune          │   │
│  │    · Memory deduplicated                      │   │
│  │    · Skills updated or created                │   │
│  │    · Habits formed (from repeated usage)      │   │
│  │  → Positive affirmations stored in memory     │   │
│  └─────────────────────────────────────────────┘     │
│                                                      │
└──────────────────────────────────────────────────────┘

┌──────────── ESCALATION MEETING (Immediate) ─────────┐
│                                                      │
│  Trigger: Unresolvable blocker at current level      │
│                                                      │
│  Example flow:                                       │
│    Specialized Agent needs API key                    │
│      → reports to Developer (within task loop)       │
│    Developer can't resolve                            │
│      → Escalation Meeting with PM                    │
│    PM can't resolve                                   │
│      → Escalation Meeting with CEO                   │
│    CEO can't resolve                                  │
│      → Presented to User on Dashboard                │
│    User provides API key                              │
│      → Resolution flows back down the chain          │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 7. Foundational Constructs

### Layer 0: Platform Entities

#### User
The Board of Directors. Owns and oversees multiple Startups.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `name` | `str` | Display name |
| `email` | `str` | Login credential |
| `created_at` | `datetime` | Account creation |

#### Startup
Top-level container. Each Startup is an independent AI-run company. In MVP, one Startup = one Project.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `user_id` | `str` | Owner reference |
| `name` | `str` | Startup name |
| `fundamental_idea` | `FundamentalIdea` | Core thesis |
| `budget` | `Budget` | Financial tracking |
| `hierarchy` | `Hierarchy` | Org chart |
| `status` | `StartupStatus` | `ideation → active → paused → archived` |
| `created_at` | `datetime` | Creation timestamp |

#### FundamentalIdea
The immutable core thesis. `core_idea` never changes; `current_direction` can evolve through user refinement with the CEO.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `startup_id` | `str` | Parent startup |
| `core_idea` | `str` | Immutable core thesis |
| `current_direction` | `str` | Current interpretation/focus of the core idea |
| `refined_with_user` | `bool` | Whether CEO-User refinement is complete |

#### Budget
Tracks real LLM API spend against user's allocated budget. Tracked at three granularities: per-LLM-call → aggregated per-task → aggregated per-agent.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `startup_id` | `str` | Parent startup |
| `total_allocated` | `float` | User's budget cap |
| `spent` | `float` | Total spent so far |
| `remaining` | `float` | Budget remaining |
| `cost_log` | `list[CostEntry]` | Per-call cost records |

**CostEntry**: `{ timestamp, agent_id, task_id, llm_model, tokens_in, tokens_out, cost }`

---

### Layer 1: Organization — Hierarchy & Roles

#### Hierarchy
The org chart and spawning governance for a Startup. Proposed by the system (an LLM-powered module, not an agent) based on the idea and budget. User approves or modifies before any EmployeeAgents are created.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `startup_id` | `str` | Parent startup |
| `nodes` | `list[HierarchyNode]` | All positions |
| `edges` | `list[HierarchyEdge]` | Reporting relationships |

**Key methods:**
- `get_parent(agent_id)` → returns the manager of an agent
- `get_children(agent_id)` → returns direct reports
- `can_spawn(spawner, target_type)` → checks SpawnRules
- `get_escalation_path(from_agent)` → returns the chain of managers up to CEO

**Default templates (budget-dependent):**

| Budget Tier | Structure |
|---|---|
| Minimum | CEO → Full-stack Developer |
| Standard | CEO → CTO → [PM, Full-stack Developer] |
| Full | CEO → CTO → [PM → Full-stack Developer, ML Engineer] |

#### HierarchyNode

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `role` | `Role` | Role template for this position |
| `agent_id` | `str \| None` | Which agent fills this position |
| `level` | `int` | Depth in hierarchy (0 = CEO) |
| `spawn_rules` | `list[SpawnRule]` | What this position can spawn |

#### HierarchyEdge

| Field | Type | Description |
|---|---|---|
| `parent_node_id` | `str` | Manager position |
| `child_node_id` | `str` | Report position |
| `relationship` | `str` | `reports_to` or `collaborates_with` |

#### Role
Template defining an employee type. Used to instantiate EmployeeAgents with appropriate tools, skills, and system prompts.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `name` | `str` | CEO, CTO, PM, Developer, ML Engineer, etc. |
| `default_tools` | `list[str]` | Tools this role starts with |
| `default_skills` | `list[str]` | Skills this role starts with |
| `system_prompt_template` | `str` | Base system prompt for the role |
| `level` | `int` | Hierarchy level (0=CEO, 1=CTO, 2=PM/Dev, ...) |

#### SpawnRule
Governs what agent types a role can spawn. Enforces hierarchy constraints — a Developer cannot spawn a CEO, but can spawn a BrowserUse SpecializedAgent.

| Field | Type | Description |
|---|---|---|
| `role_id` | `str` | Which role this rule applies to |
| `allowed_agent_types` | `list[AgentType]` | Generic, Specialized, Exploratory |
| `allowed_specialized_types` | `list[str]` | browser_use, code_execution, etc. |
| `max_concurrent_spawns` | `int` | Parallel spawn limit |

---

### Layer 2: Agent System

Everything that does work is an **Agent**. This is the universal base. There are four types, organized in a clear inheritance:

```
Agent (base)
  ├── EmployeeAgent    — Persistent, has Hippocampus, lives for startup lifetime
  ├── GenericAgent     — Ephemeral, general-purpose task executor
  ├── SpecializedAgent — Ephemeral, fixed capability (browser, codegen, etc.)
  └── ExploratoryAgent — Ephemeral, research & fallback reasoning
```

#### Agent (Base)

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `type` | `AgentType` | `EMPLOYEE \| GENERIC \| SPECIALIZED \| EXPLORATORY` |
| `status` | `AgentStatus` | `idle → running → blocked → completed → failed` |
| `parent_agent_id` | `str \| None` | Who spawned this agent (None for Employees) |
| `startup_id` | `str` | Parent startup |
| `current_task_id` | `str \| None` | Currently assigned task |
| `local_memory` | `WorkingMemory` | Runtime context (one per agent, clears between tasks) |
| `created_at` | `datetime` | Creation timestamp |
| `destroyed_at` | `datetime \| None` | When destroyed (None for Employees) |

#### EmployeeAgent (extends Agent)
Persistent agent with identity, Hippocampus, and the ability to spawn sub-agents. Lives for the entire lifetime of the startup.

| Additional Field | Type | Description |
|---|---|---|
| `role` | `Role` | Role template |
| `hierarchy_node_id` | `str` | Position in org chart |
| `hippocampus` | `Hippocampus` | Full memory system |
| `reasoning_bank` | `ReasoningBank` | Memory processor |
| `habits` | `list[Habit]` | Auto-triggered prompt injections |
| `skills` | `list[Skill]` | Learned capabilities |
| `task_queue` | `list[str]` | Pending task IDs |
| `performance_metrics` | `AgentMetrics` | Stats |

**Key behaviors:**
- Can self-execute simple tasks (decided by LLM reasoning)
- Can spawn GenericAgent, SpecializedAgent, or ExploratoryAgent (governed by SpawnRules)
- Verifies work of its spawned agents (parent-verifies pattern)
- Attends Meetings (the only inter-employee communication channel)
- Runs consolidation cycles (light: after each task; deep: during standups)

#### GenericAgent (extends Agent)
Ephemeral. Spawned by an Employee for a specific task. Uses LLM + context engineering (delegated memory + tools + skills) to execute.

| Additional Field | Type | Description |
|---|---|---|
| `spawned_by` | `str` | Employee agent ID |
| `task_id` | `str` | Assigned task |
| `tools` | `list[Tool]` | Available tools |
| `skills` | `list[Skill]` | Relevant skills |
| `delegated_memory` | `list[MemoryUnit]` | Context selected by parent's ReasoningBank |

**Lifecycle:** Spawned → executes task → trajectory always distilled back to parent's memory → destroyed.

#### SpecializedAgent (extends Agent)
Ephemeral. Fixed capability interface for specific tasks.

| Additional Field | Type | Description |
|---|---|---|
| `spawned_by` | `str` | Employee agent ID |
| `task_id` | `str` | Assigned task |
| `specialization` | `str` | `browser_use \| code_execution \| code_generation \| design \| research` |
| `capability_config` | `dict` | Specialization-specific configuration |

**Lifecycle:** Same as GenericAgent.

#### ExploratoryAgent (extends Agent)
Ephemeral. Spawned when Generic/Specialized agents fail, or for pure research and reasoning tasks. Thinks from first principles.

| Additional Field | Type | Description |
|---|---|---|
| `spawned_by` | `str` | Employee agent ID |
| `task_id` | `str` | Assigned task |
| `exploration_objective` | `str` | What to research/reason about |
| `findings` | `list[Finding]` | Discovered insights |

**Lifecycle:** Same as GenericAgent.

#### AgentMetrics

| Field | Type | Description |
|---|---|---|
| `tasks_completed` | `int` | Total completed |
| `tasks_failed` | `int` | Total failed |
| `avg_task_duration` | `float` | Average time per task |
| `success_rate` | `float` | Completion percentage |
| `total_cost` | `float` | Total LLM spend |
| `sub_agents_spawned` | `int` | Total agents spawned |

---

### Layer 3: Task System

**Everything is a Task.** This is the atomic unit of work in Arceus. Goals are Tasks. Sub-goals are Tasks. Technical implementation steps are Tasks. There is no separate Goal, Epic, or Story entity — just Tasks with parent-child relationships forming a first-principles decomposition tree.

#### Task

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `startup_id` | `str` | Parent startup |
| `title` | `str` | Short description |
| `description` | `str` | Detailed description |
| `problem_statement` | `str` | The problem this task solves |
| `status` | `TaskStatus` | `CREATED → PLANNED → IN_PROGRESS → VERIFYING → BLOCKED → COMPLETED → FAILED` |
| `priority` | `Priority` | `CRITICAL \| HIGH \| MEDIUM \| LOW` |
| `assigned_agent_id` | `str \| None` | Who is working on this |
| `parent_task_id` | `str \| None` | Parent in decomposition tree (None = top-level) |
| `children_task_ids` | `list[str]` | Sub-tasks |
| `created_by_agent_id` | `str` | Who created this task |
| `planner_state` | `PlannerState` | Planning component |
| `executor_state` | `ExecutorState` | Execution component |
| `verifier_state` | `VerifierState` | Verification component (populated by PARENT agent) |
| `task_memory` | `WorkingMemory` | Task-scoped runtime context |
| `cost` | `float` | Total cost of this task |
| `created_at` | `datetime` | Creation time |
| `started_at` | `datetime \| None` | Execution start |
| `completed_at` | `datetime \| None` | Completion time |
| `trace` | `list[TraceEntry]` | Immutable audit log |

**Task decomposition is recursive.** CEO creates top-level tasks → CTO decomposes into sub-tasks → Developer decomposes further → spawned agents receive leaf-level tasks.

#### Task Internal Components

Each Task has three internal engines, inspired by the AgentFlow architecture:

**PlannerState** — Plans the approach to solving the task.

| Field | Type | Description |
|---|---|---|
| `query_analysis` | `QueryAnalysis` | Analysis of the problem |
| `sub_goals` | `list[SubGoal]` | Breakdown of the task |
| `selected_tools` | `list[str]` | Tools chosen for execution |
| `plan_steps` | `list[PlanStep]` | Ordered execution plan |
| `current_step_index` | `int` | Progress pointer |

**ExecutorState** — Executes tool commands and records results.

| Field | Type | Description |
|---|---|---|
| `commands_executed` | `list[ToolCommand]` | History of commands |
| `results` | `list[ExecutionResult]` | Outcomes |
| `current_command` | `ToolCommand \| None` | In-flight command |

**VerifierState** — Populated by the **parent agent** that spawned the executor (not self-verified).

| Field | Type | Description |
|---|---|---|
| `verification_result` | `MemoryVerification \| None` | Result of parent's review |
| `is_verified` | `bool` | Whether parent approved |
| `feedback` | `str \| None` | Parent's feedback if rejected |

#### TraceEntry
Immutable audit log. Every tool call, LLM request, decision, and status change is recorded.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `task_id` | `str` | Parent task |
| `timestamp` | `datetime` | When it happened |
| `entry_type` | `str` | `tool_call \| decision \| llm_request \| status_change \| error` |
| `agent_id` | `str` | Which agent produced this |
| `content` | `dict` | Entry-specific payload |
| `cost` | `float` | LLM cost for this entry |

---

### Layer 4: Memory System — Hippocampus

The Hippocampus is the memory system exclusive to EmployeeAgents. It is modeled after human neuroscience with multiple memory types serving different purposes. Spawned agents (Generic, Specialized, Exploratory) only have WorkingMemory — they receive delegated context from their parent's Hippocampus via the ReasoningBank.

#### Hippocampus

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `agent_id` | `str` | Owner EmployeeAgent |
| `working_memory` | `WorkingMemory` | Runtime context |
| `semantic_memory` | `SemanticMemoryStore` | General knowledge |
| `episodic_memory` | `EpisodicMemoryStore` | Event-specific memories |
| `priming_memory` | `PrimingMemoryStore` | State-based biases |
| `procedural_memory` | `ProceduralMemoryStore` | Habits |
| `patterns` | `list[Pattern]` | Deep insights (rare, high-value) |
| `skills` | `list[Skill]` | Learned capabilities (frequent) |

#### Memory Types

```
Hippocampus
  ├── Working Memory (ephemeral, per-agent runtime context)
  │
  ├── Long-Term Memory (Conscious)
  │     ├── Semantic Memory — General knowledge of the domain
  │     └── Episodic Memory — "While doing task X, I learned Y"
  │
  └── Long-Term Memory (Unconscious)
        ├── Priming Memory — State-based response biases
        └── Procedural Memory — Habits (auto-triggered actions)
```

#### MemoryUnit (Base)
The atomic unit of memory storage. All memory types store collections of MemoryUnits.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `type` | `MemoryType` | `WORKING \| SEMANTIC \| EPISODIC \| PRIMING \| PROCEDURAL` |
| `content` | `str` | The actual memory content |
| `embedding` | `list[float] \| None` | Vector embedding for semantic retrieval |
| `quality_score` | `float` | How valuable this memory is |
| `created_at` | `datetime` | When formed |
| `last_accessed_at` | `datetime` | Last retrieval |
| `access_count` | `int` | Times retrieved |
| `source_task_id` | `str \| None` | Task that produced this memory |
| `tags` | `list[str]` | Categorization |

#### WorkingMemory
Runtime context. One per agent, clears between tasks. Stored in Redis.

| Field | Type | Description |
|---|---|---|
| `entries` | `list[MemoryUnit]` | Current context |
| `max_size` | `int` | Context window budget |
| `agent_id` | `str` | Owner agent |

#### SemanticMemoryStore
General knowledge about the domain, world, and technology. Stored in Vector DB for retrieval.

#### EpisodicMemoryStore
Event-specific memories structured as Episodes.

| Field | Type | Description |
|---|---|---|
| `episodes` | `list[Episode]` | Collection of episodes |

**Episode:** `{ task_id, summary, key_learnings: list[MemoryUnit], outcome, timestamp }`

#### PrimingMemoryStore
State-based response biases — "When I see pattern X, I tend to do Y."

**PrimingEntry:** `{ trigger_pattern: str, response_bias: str, strength: float }`

#### ProceduralMemoryStore / Habits
Auto-triggered instructions injected into the agent's system prompt when conditions match.

#### Pattern
**Rare, high-value insights** that emerge over time across many experiences. Patterns represent deep wisdom, not routine capabilities.

Example: *"When users describe a marketplace idea, the MVP should always start with the supply side, not the demand side."*

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `name` | `str` | Pattern name |
| `description` | `str` | What this pattern captures |
| `source_memories` | `list[str]` | MemoryUnit IDs that contributed |
| `quality_score` | `float` | Confidence/value rating |
| `usage_count` | `int` | Times applied |
| `status` | `str` | `active \| merged \| pruned` |
| `merged_into` | `str \| None` | If merged, which pattern |
| `created_at` | `datetime` | When formed |

#### Skill
**Frequently added learned capabilities.** Lower bar than Patterns. Skills represent what an agent knows how to do.

Example: *"I know how to set up a React project with TypeScript."*

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `agent_id` | `str` | Owner agent |
| `name` | `str` | Skill name |
| `description` | `str` | What this skill enables |
| `quality_score` | `float` | Proficiency |
| `usage_count` | `int` | Times used |
| `active` | `bool` | Currently available |

#### Habit
Auto-triggered system prompt injections. When a condition is met, the instruction is injected into the agent's prompt without explicit reasoning.

Example: *Trigger: "setting up a new API endpoint" → Action: "Always add input validation and rate limiting."*

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `trigger_condition` | `str` | When to activate |
| `action` | `str` | Instruction text injected into system prompt |
| `strength` | `float` | Usage frequency (stronger = more automatic) |
| `created_from_pattern_id` | `str \| None` | If formed from a Pattern |
| `active` | `bool` | Currently enabled |

#### ReasoningBank
The memory processor unique to each EmployeeAgent. Manages how memories are stored, retrieved, and evolved.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `agent_id` | `str` | Owner EmployeeAgent |
| `config` | `dict` | Configuration parameters |

**Four core operations:**

| Operation | When | What It Does |
|---|---|---|
| `retrieve(query, top_k)` | Before spawning an agent or self-executing | Semantic search over Hippocampus → returns top-k relevant MemoryUnits to delegate as context |
| `judge(trajectory, memories)` | After spawned agent completes | Evaluates trajectory against retrieved memories → decides what's worth keeping |
| `distill(trajectory)` | After spawned agent completes | Extracts MemoryUnits from agent's execution trajectory → adds to Hippocampus |
| `consolidate()` | Light: after each task. Deep: during standups | **The self-learning cycle:** patterns evolve/merge/prune, memory dedup, skills update, habits form |

**Consolidation — The Self-Learning Cycle:**

```
After task completion (light) or standup (deep):
  │
  ├── Patterns evolve, merge, or get pruned
  ├── Memory store is deduplicated
  ├── Skills are updated or newly created
  ├── Habits form (when a skill/pattern is used repeatedly)
  └── New tools may be registered (via exploratory agents)
```

---

### Layer 5: Communication — Meeting Protocol

**Meetings are the ONLY mechanism for inter-employee communication.** Employees cannot access each other's memories directly. All knowledge sharing, escalation, and coordination happens through Meetings.

#### Meeting

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `startup_id` | `str` | Parent startup |
| `type` | `MeetingType` | `STANDUP \| ESCALATION \| SYNC` |
| `participants` | `list[str]` | EmployeeAgent IDs |
| `agenda` | `list[AgendaItem]` | Items to discuss |
| `decisions` | `list[Decision]` | Outcomes |
| `learnings` | `list[Learning]` | Insights extracted |
| `task_modifications` | `list[TaskModification]` | Changes to task list |
| `status` | `str` | `scheduled \| in_progress \| completed` |
| `scheduled_at` | `datetime` | When scheduled |
| `completed_at` | `datetime \| None` | When finished |
| `meeting_notes` | `str` | Summary text |

**Meeting Types:**

| Type | Trigger | Purpose |
|---|---|---|
| `STANDUP` | Scheduled (periodic) | Status, blockers, learnings, pattern observations. Triggers deep consolidation. |
| `ESCALATION` | Immediate (unresolvable blocker) | Blocker at current level → instant meeting with manager → chains up until resolved |
| `SYNC` | On-demand | Peer information exchange between employees at same level |

**Execution format:** Structured protocol — each agent submits to a template (agenda items → responses in turn → decisions recorded). Not a free-form multi-agent chat.

#### AgendaItem

| Field | Type | Description |
|---|---|---|
| `topic` | `str` | What this item is about |
| `raised_by_agent_id` | `str` | Who raised it |
| `type` | `str` | `update \| blocker \| question \| proposal` |
| `content` | `str` | Details |

#### Decision

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `meeting_id` | `str` | Parent meeting |
| `description` | `str` | What was decided |
| `decided_by` | `list[str]` | Agents who agreed |
| `impacts` | `list[str]` | Task/agent IDs affected |

#### Learning

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `meeting_id` | `str` | Parent meeting |
| `agent_id` | `str` | Who learned |
| `content` | `str` | The learning |
| `converted_to_memory` | `bool` | Whether distilled into Hippocampus |
| `memory_unit_id` | `str \| None` | If converted, the MemoryUnit |

#### TaskModification

| Field | Type | Description |
|---|---|---|
| `task_id` | `str` | Which task |
| `modification_type` | `str` | `reprioritize \| reassign \| cancel \| decompose_further` |
| `details` | `str` | Specifics |

---

### Layer 6: Cross-Cutting — Audit, Tools & Skills

#### Ticket
Immutable audit log for user-facing activity. Every conversation, tool call, and decision point visible on the dashboard.

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `startup_id` | `str` | Parent startup |
| `task_id` | `str` | Related task |
| `agent_id` | `str` | Primary agent |
| `title` | `str` | Ticket title |
| `thread` | `list[ThreadEntry]` | Conversation thread |
| `status` | `str` | Open, in progress, resolved |
| `created_at` | `datetime` | Creation time |

**ThreadEntry:** `{ timestamp, author_type (user|agent), author_id, content, trace_entries }`

#### Tool
An external capability an agent can use (code execution, browser, API, file system, etc.).

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Unique identifier |
| `name` | `str` | Tool name |
| `description` | `str` | What it does |
| `interface` | `dict` | Input/output schema |
| `category` | `str` | `code \| browser \| api \| file \| design` |
| `requires_auth` | `bool` | Whether it needs credentials |

Tools are predefined per Role template. A Developer gets code tools; a CEO gets research tools; etc.

---

## 8. Construct Reference Table

| # | Construct | Layer | Purpose | Persistent? |
|---|---|---|---|---|
| 1 | User | 0 | Board of directors | Postgres |
| 2 | Startup | 0 | Top-level container | Postgres |
| 3 | FundamentalIdea | 0 | Immutable core thesis | Postgres |
| 4 | Budget / CostEntry | 0 | Financial tracking at 3 granularities | Postgres |
| 5 | Hierarchy | 1 | Org chart + spawn governance | Postgres |
| 6 | HierarchyNode | 1 | Position in org chart | Postgres |
| 7 | HierarchyEdge | 1 | Reporting relationships | Postgres |
| 8 | Role | 1 | Employee type template | Postgres |
| 9 | SpawnRule | 1 | Spawn governance per role | Postgres |
| 10 | Agent (base) | 2 | Universal executor | Postgres |
| 11 | EmployeeAgent | 2 | Persistent, has Hippocampus | Postgres |
| 12 | GenericAgent | 2 | Ephemeral task executor | Postgres |
| 13 | SpecializedAgent | 2 | Ephemeral, fixed capability | Postgres |
| 14 | ExploratoryAgent | 2 | Ephemeral, research/fallback | Postgres |
| 15 | AgentMetrics | 2 | Performance statistics | Postgres |
| 16 | Task | 3 | Atomic unit of work | Postgres |
| 17 | PlannerState | 3 | Task planning component | Postgres |
| 18 | ExecutorState | 3 | Task execution component | Postgres |
| 19 | VerifierState | 3 | Parent's verification | Postgres |
| 20 | TraceEntry | 3 | Immutable audit log | Postgres |
| 21 | Hippocampus | 4 | Memory system container | Postgres + Vector DB |
| 22 | MemoryUnit | 4 | Atomic memory storage | Vector DB |
| 23 | WorkingMemory | 4 | Ephemeral runtime context | Redis |
| 24 | SemanticMemoryStore | 4 | General knowledge | Vector DB |
| 25 | EpisodicMemoryStore | 4 | Event-specific memories | Vector DB + Postgres |
| 26 | PrimingMemoryStore | 4 | State-based response biases | Postgres |
| 27 | Pattern | 4 | Rare deep insights | Postgres + Vector DB |
| 28 | Skill | 4 | Learned capabilities | Postgres |
| 29 | Habit | 4 | Auto-triggered prompt injections | Postgres |
| 30 | ReasoningBank | 4 | Memory processor | Postgres (config only) |
| 31 | Meeting | 5 | Inter-employee communication | Postgres |
| 32 | AgendaItem | 5 | Meeting item | Postgres |
| 33 | Decision | 5 | Meeting outcome | Postgres |
| 34 | Learning | 5 | Meeting insight → memory | Postgres |
| 35 | TaskModification | 5 | Meeting-driven task changes | Postgres |
| 36 | Ticket | 6 | Dashboard audit log | Postgres |
| 37 | Tool | 6 | External capability | Postgres |

---

## 9. Relationships & Data Model

```
User ──1:N──→ Startup
Startup ──1:1──→ FundamentalIdea
Startup ──1:1──→ Budget
Startup ──1:1──→ Hierarchy
Startup ──1:N──→ EmployeeAgent
Startup ──1:N──→ Task
Startup ──1:N──→ Meeting
Startup ──1:N──→ Ticket

Hierarchy ──contains──→ HierarchyNode ──has──→ Role, SpawnRule
HierarchyEdge ──connects──→ HierarchyNode (parent ↔ child)

EmployeeAgent ──1:1──→ Hippocampus
EmployeeAgent ──1:1──→ ReasoningBank
EmployeeAgent ──1:N──→ Skill
EmployeeAgent ──1:N──→ Habit
EmployeeAgent ──spawns──→ GenericAgent | SpecializedAgent | ExploratoryAgent
  (governed by SpawnRules, only 1 level deep — spawned agents do NOT spawn)

Agent ──assigned──→ Task
Task ──1:N──→ Task (parent/child decomposition tree)
Task ──1:N──→ TraceEntry
Task ──1:1──→ PlannerState, ExecutorState, VerifierState

Meeting ──N:N──→ EmployeeAgent (participants)
Meeting ──produces──→ Decision, Learning, TaskModification
Meeting ──contains──→ AgendaItem (including escalated blockers)

Hippocampus ──contains──→ WorkingMemory, SemanticMemoryStore,
                          EpisodicMemoryStore, PrimingMemoryStore,
                          ProceduralMemoryStore, list[Pattern]
All memory stores ──contain──→ MemoryUnit
```

---

## 10. Persistence Strategy

### Hybrid Architecture

| Layer | Technology | What It Stores | Why |
|---|---|---|---|
| **Structured data** | PostgreSQL | Users, Startups, Hierarchy, Agents, Tasks, Meetings, Tickets, Patterns (metadata), Skills, Habits | Relational integrity, ACID transactions, complex queries |
| **Semantic retrieval** | Vector DB (Qdrant) | MemoryUnits (with embeddings), Pattern embeddings, Task embeddings | Similarity search for ReasoningBank.retrieve(), finding related past tasks |
| **Ephemeral state** | Redis | WorkingMemory, Agent status, Active task state, Meeting scheduling queue | Fast reads/writes, TTL-based expiry, pub/sub for real-time dashboard updates |

---

## 11. Key Design Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Agent is the universal base class** | Clean inheritance: Employee, Generic, Specialized, Exploratory all extend Agent |
| 2 | **Everything is a Task** | Goals, sub-goals, technical tasks are all Tasks with parent-child relationships. No separate Goal/Epic/Story constructs |
| 3 | **Spawned agents are ephemeral** | Created for a task → trajectory distilled back to parent → destroyed. No pooling. |
| 4 | **System proposes hierarchy, user confirms** | LLM-powered module generates org chart from (idea, budget). User approves/modifies. CEO is part of the proposal, not the proposer |
| 5 | **All employees hired at once** | Simplifies MVP. No hiring pipeline construct. Everyone ready when CEO starts decomposing tasks |
| 6 | **Meetings are the ONLY inter-employee channel** | No direct memory access between employees. Forces structured communication, traceable decisions, clean information flow |
| 7 | **Parent agent verifies spawned agent's work** | VerifierState on a Task is populated by the parent, not self-verified. Ensures quality control at every level |
| 8 | **Patterns = wisdom, Skills = capabilities** | Patterns are rare, high-value, emergent insights formed over many experiences. Skills are frequent, lower-bar learned capabilities |
| 9 | **Two-tier consolidation** | Light: after each task (quick distill + skill check). Deep: during standups (full pattern evolution, memory dedup, habit formation) |
| 10 | **One Startup = One Project (MVP)** | No separate Project entity. Simplifies the model. Multiple projects per startup is a post-MVP feature |
| 11 | **User interacts via Dashboard + CEO chat only** | User cannot chat with non-CEO agents. CEO is the interface between user intent and company execution |
| 12 | **Bidirectional CEO ↔ User chat** | User can proactively message CEO at any time, not just respond to CEO's questions |
| 13 | **Budget tracked at three granularities** | Per-LLM-call (atomic) → aggregated per-task → aggregated per-agent. Full cost visibility |

---

## 12. Constraints & Rules

### Spawning Rules
- Only EmployeeAgents can spawn sub-agents
- Spawning is **one level deep only** — spawned agents cannot spawn their own sub-agents
- What an Employee can spawn is governed by their Role's SpawnRules
- A Developer cannot spawn a CEO agent, but can spawn a BrowserUse SpecializedAgent
- CEO can spawn specialized agents + anything below it in the hierarchy
- Parallel spawns allowed (bounded by `max_concurrent_spawns`)

### Memory Rules
- Higher-level agents can **read** lower-level agents' memory but **cannot modify** it
- Cross-employee memory sharing happens **only through Meetings**
- WorkingMemory is scoped per-agent and clears between tasks
- Every spawned agent's trajectory is **always distilled** back to the parent (no selective discarding)
- ReasoningBank selects top-k relevant memories to delegate to spawned agents

### Communication Rules
- Meetings are the **only** mechanism for inter-employee communication
- Scheduled Standups: periodic sync with structured format
- Escalation Meetings: triggered **immediately** when an unresolvable blocker is hit
- Escalation chains up the hierarchy: Agent → Manager (Meeting) → Manager's Manager (Meeting) → ... → CEO → User Dashboard
- Meeting format is **structured**: agenda → responses → decisions (not free-form chat)

### Task Rules
- Tasks assigned **only to direct reports** (flow down the hierarchy)
- Task decomposition is recursive (each level can decompose further)
- Employee decides via LLM reasoning whether to self-execute or spawn
- Verification is done by the **parent** agent, not by the executing agent

---

## 13. Dashboard

The user's window into the running startup. A **Next.js + React** web application with real-time agent visibility.

### 13.1 Tech Stack

| Layer | Choice |
|---|---|
| **Framework** | Next.js (App Router) + React |
| **Component Library** | shadcn/ui |
| **Charts** | Recharts |
| **State Management** | Zustand (client) + React Query (server/cache) |
| **Real-time** | WebSocket/SSE — fully real-time (tasks, agents, meetings stream live) |
| **Styling** | Tailwind CSS (dark + light theme toggle) |
| **Auth** | Multi-user team — Owner (full control) + Viewers (read-only) |
| **Platform** | Web-only, responsive |

### 13.2 Shell Layout

```
┌──────────────────────────────────────────────────────────┐
│  [Startup Switcher ▼]           🔔 Notifications  [👤]  │
├─────────────┬────────────────────────────────────────────┤
│  SIDEBAR    │                                            │
│  (tabbed)   │              MAIN CONTENT                  │
│             │                                            │
│  Tab 1: Nav │   /startup/[id]/overview                   │
│  ─────────  │   /startup/[id]/agents/[name]              │
│  • Overview │   /startup/[id]/tasks                      │
│  • Agents   │   /startup/[id]/meetings                   │
│  • Tasks    │   /startup/[id]/tickets                    │
│  • Meetings │   /startup/[id]/budget                     │
│  • Tickets  │   /startup/[id]/settings                   │
│  • Budget   │                                            │
│  • Settings │                                            │
│             │                                            │
│  Tab 2: CEO │                                            │
│  ─────────  │                                            │
│  [Chat UI]  │                                            │
│  CEO conv.  │                                            │
│  streaming  │                                            │
│  + approve  │                                            │
│  buttons    │                                            │
│             │                                            │
└─────────────┴────────────────────────────────────────────┘
```

- **Sidebar** — Two tabs: **Navigation** and **CEO Chat**
- **Startup Switcher** — Dropdown at top-left of sidebar (name + logo), switches all views
- **Notifications** — Toast/snackbar for real-time events + bell icon with history
- **URL Structure** — Startup-scoped: `/startup/[id]/agents/[name]`, `/startup/[id]/tasks`, etc.

### 13.3 Key Metrics (Overview Page — Default Landing)

When the user opens the dashboard, they land on the **Overview** page:

- **Agents Enabled** — count, running/paused/error breakdown
- **Tasks In Progress** — open, blocked, completed counts
- **Month Spend** — budget consumed vs. remaining
- **Pending Approvals** — decisions/blockers waiting for user input
- **Recent Activity Feed** — chronological log of agent actions, status changes
- **Recent Tasks** — prioritized task list with status indicators

### 13.4 Views

#### CEO Chat (Sidebar Tab 2)
- Bidirectional messaging with the CEO agent
- Streaming responses
- **Approval workflow** — CEO presents escalations with **Accept / Reject** buttons inline
- Also accessible from a **dedicated Approval Queue** page (dual-surface — approvals appear in both chat and queue)

#### Agent Pages (`/startup/[id]/agents/[name]`)
Per-employee view showing:
- Run Activity chart (last N days)
- Issues by Priority breakdown
- Budget consumption
- Success Rate over time
- Recent issues/tasks assigned
- **Summary of memory** — Pattern and Skill cards (not raw MemoryUnits)
- **View-only** — all actions (pause, reassign, adjust) go through CEO Chat

#### Org Hierarchy (`/startup/[id]/org`)
- **Interactive tree** — click nodes to drill into agent detail pages
- Real-time status indicators: 🟢 working, 🟡 idle, 🔴 error
- Shows all EmployeeAgents and their reporting structure

#### Task Board (`/startup/[id]/tasks`)
- **Toggle** between Kanban board (Backlog → In Progress → Review → Done) and List view
- Status badges, priority indicators, assigned agent
- Filterable by agent, priority, status

#### Meeting Notes (`/startup/[id]/meetings`)
- **Timeline feed** — chronological list of meetings with expandable summaries
- RollupItems shown per meeting
- Filter by meeting type (standup, escalation) and participants

#### Ticket / Audit Log (`/startup/[id]/tickets`)
- **Activity stream** — like GitHub issue comments
- Each action is a timestamped entry: agent, action type, decision, tool calls
- Immutable audit trail of all agent decisions and escalations

#### Budget Dashboard (`/startup/[id]/budget`)
- **Detailed cost dashboard** — token usage, API costs, per-agent spend breakdown
- Monthly burn rate graph
- Cost by agent role, by task, by model tier
- Budget alerts and threshold warnings

### 13.5 Startup Creation Flow

1. **Sign up** → lands on **empty dashboard** (no startups yet)
2. Click **"New Startup"** → **minimal form** (name, core idea, initial budget)
3. Form submits → CEO agent spawns → **CEO Chat opens** and guides the user through direction refinement, team setup, and first task planning conversationally

### 13.6 First-Time User Experience

```
Sign Up → Empty Dashboard → Click "New Startup"
    → Minimal Form (name, idea, budget)
    → CEO Chat opens → Conversational onboarding
    → CEO creates team, sets direction, plans first tasks
    → Dashboard populates → Overview page shows live metrics
```

### 13.7 Approval Workflow (Dual-Surface)

Escalations that require user input surface in **two places**:
1. **CEO Chat** — inline message with Accept/Reject buttons
2. **Approval Queue** — dedicated list under notifications or a sub-page

Both are synced in real-time. Acting on one updates the other.

### 13.8 Auth & Multi-User

| Role | Permissions |
|---|---|
| **Owner** | Full control — create/delete startup, approve decisions, configure agents, manage team members |
| **Viewer** | Read-only — view dashboard, agents, tasks, meetings, tickets. Cannot approve or modify. |

- Invite viewers via email or link
- Owner is the primary "Board of Directors" member
- MVP: one Owner per startup, multiple Viewers

---

## 14. Backend API Design

### 14.1 Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| **Web Framework** | FastAPI | Async, Pydantic-native, WebSocket + SSE support, auto OpenAPI docs |
| **ORM** | SQLAlchemy 2.0 (async) + Alembic | Async engine, Pydantic model compat, mature migration tooling |
| **Task Queue** | Celery + Redis | Distributed agent job execution, retry logic, priority queues |
| **Database** | PostgreSQL | Structured data — all 37 constructs |
| **Vector DB** | Managed by Mem0 | Mem0 handles its own vector storage under the hood |
| **Cache / Ephemeral** | Redis | WorkingMemory, agent status, pub/sub for real-time, Celery broker |
| **Real-time** | WebSocket + SSE | WebSocket for dashboard events, SSE for CEO chat streaming |
| **Auth** | TBD | Multi-user (Owner + Viewer). Provider decision deferred. |

### 14.2 Build vs. Reuse Matrix

| Component | Build or Reuse | Tool | What We Build on Top |
|---|---|---|---|
| **Agent Runtime** | Reuse | PydanticAI | Agent definitions, system prompts, tool bindings per Role |
| **Orchestration** | Reuse | PydanticAI Graph | Task routing, spawn manager, meeting scheduler as graph nodes |
| **Memory System** | Reuse | Mem0 (self-hosted) | Hippocampus wrapper, ReasoningBank (retrieve/judge/distill/consolidate) |
| **Coding Agent** | Reuse | GitHub Copilot SDK | SpecializedAgent(codegen) wrapping Copilot's agent runtime |
| **Web Browsing** | Reuse | browser-use | SpecializedAgent(browser) wrapping browser-use API |
| **Web Scraping/Research** | Deferred | TBD | Skip for MVP — revisit Tavily + Crawl4AI later |
| **Tool Integrations** | Reuse | MCP Servers (community + custom) | PydanticAI's native MCP client → community servers for GitHub, Slack, etc. |
| **Code Execution** | Reuse | E2B | Sandbox per spawned agent for safe code execution |
| **Platform API** | Build | FastAPI | All REST endpoints, WebSocket handlers, SSE streams |
| **Data Layer** | Build | SQLAlchemy + Postgres | Models, migrations, repositories for all 37 constructs |
| **Task Queue** | Build | Celery + Redis | Agent job workers, spawn lifecycle, meeting triggers |
| **Dashboard API** | Build | FastAPI + WebSocket | Real-time events, CRUD for all views |
| **CEO Chat** | Build | FastAPI SSE + PydanticAI | Streaming chat endpoint, approval workflow |
| **Hierarchy Engine** | Build | Custom + LLM | Org chart proposal from (idea, budget), user approval |
| **Meeting Protocol** | Build | Custom | Structured meeting execution, agenda → responses → decisions |
| **Budget Tracker** | Build | Custom | Per-call → per-task → per-agent cost aggregation |

### 14.3 Service Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        FRONTEND                               │
│                   Next.js (Section 13)                        │
│                                                               │
│    REST (/api/*)    WebSocket (/ws)    SSE (/stream/*)       │
└──────┬──────────────────┬──────────────────┬─────────────────┘
       │                  │                  │
┌──────┴──────────────────┴──────────────────┴─────────────────┐
│                     FASTAPI SERVER                            │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │  REST API   │  │  WebSocket  │  │  SSE Streams         │ │
│  │  Routers    │  │  Manager    │  │  (CEO Chat, Events)  │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬───────────┘ │
│         │                │                     │              │
│  ┌──────┴────────────────┴─────────────────────┴───────────┐ │
│  │                   SERVICE LAYER                          │ │
│  │                                                          │ │
│  │  StartupService  AgentService  TaskService  MeetingServ  │ │
│  │  MemoryService   BudgetService  HierarchyService        │ │
│  │  ChatService     NotificationService  AuthService        │ │
│  └──────┬───────────────┬──────────────────┬───────────────┘ │
│         │               │                  │                  │
│  ┌──────┴───────┐ ┌─────┴──────┐ ┌────────┴───────────────┐ │
│  │  AGENT       │ │  DATA      │ │  EXTERNAL              │ │
│  │  ENGINE      │ │  LAYER     │ │  INTEGRATIONS          │ │
│  │              │ │            │ │                        │ │
│  │  PydanticAI  │ │  SQLAlch.  │ │  Mem0 (memory)        │ │
│  │  Graph       │ │  Repos     │ │  Copilot SDK (code)   │ │
│  │  (orchestr.) │ │  Postgres  │ │  browser-use (web)    │ │
│  │              │ │  Redis     │ │  E2B (sandbox)        │ │
│  │              │ │            │ │  MCP Servers (tools)  │ │
│  └──────────────┘ └────────────┘ └────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                 CELERY WORKERS                          │  │
│  │  agent_executor  │  meeting_runner  │  consolidation   │  │
│  │  spawn_manager   │  escalation      │  budget_tracker  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 14.4 API Routes

#### Auth & Users

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/auth/signup` | Create account |
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/logout` | Logout |
| `GET` | `/api/users/me` | Current user profile |
| `PATCH` | `/api/users/me` | Update profile |

#### Startups

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/startups` | Create startup (name, idea, budget) → triggers CEO spawn |
| `GET` | `/api/startups` | List user's startups |
| `GET` | `/api/startups/{id}` | Get startup details |
| `PATCH` | `/api/startups/{id}` | Update startup (pause, resume, archive) |
| `DELETE` | `/api/startups/{id}` | Archive startup |
| `GET` | `/api/startups/{id}/overview` | Dashboard overview (metrics, recent activity) |
| `POST` | `/api/startups/{id}/invite` | Invite viewer to startup |
| `GET` | `/api/startups/{id}/members` | List team members (owner + viewers) |
| `DELETE` | `/api/startups/{id}/members/{uid}` | Remove viewer |

#### Hierarchy

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/hierarchy` | Get org chart (nodes + edges + status) |
| `POST` | `/api/startups/{id}/hierarchy/propose` | LLM proposes hierarchy from (idea, budget) |
| `PUT` | `/api/startups/{id}/hierarchy` | User approves/modifies proposed hierarchy |

#### Agents

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/agents` | List all agents (employees + active spawned) |
| `GET` | `/api/startups/{id}/agents/{agent_id}` | Agent detail (stats, memory summary, tasks) |
| `GET` | `/api/startups/{id}/agents/{agent_id}/metrics` | Agent performance metrics |
| `GET` | `/api/startups/{id}/agents/{agent_id}/memory` | Memory summary (Patterns + Skills, not raw units) |
| `GET` | `/api/startups/{id}/agents/{agent_id}/tasks` | Tasks assigned to agent |

#### Tasks

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/tasks` | List tasks (filterable: status, priority, agent, parent) |
| `GET` | `/api/startups/{id}/tasks/{task_id}` | Task detail (planner, executor, verifier states) |
| `GET` | `/api/startups/{id}/tasks/{task_id}/trace` | Task trace entries (audit log) |
| `GET` | `/api/startups/{id}/tasks/{task_id}/children` | Sub-tasks |
| `GET` | `/api/startups/{id}/tasks/tree` | Full task decomposition tree |

#### Meetings

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/meetings` | List meetings (filterable: type, participant, date) |
| `GET` | `/api/startups/{id}/meetings/{meeting_id}` | Meeting detail (agenda, decisions, learnings) |
| `GET` | `/api/startups/{id}/meetings/upcoming` | Scheduled meetings |

#### Tickets (Audit Log)

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/tickets` | Activity stream (paginated) |
| `GET` | `/api/startups/{id}/tickets/{ticket_id}` | Ticket thread detail |

#### Budget

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/budget` | Budget overview (allocated, spent, remaining) |
| `GET` | `/api/startups/{id}/budget/breakdown` | Per-agent, per-task, per-model cost breakdown |
| `GET` | `/api/startups/{id}/budget/history` | Cost log over time |
| `PATCH` | `/api/startups/{id}/budget` | Adjust budget allocation |

#### Approvals

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/approvals` | Pending approval queue |
| `POST` | `/api/startups/{id}/approvals/{id}/accept` | Accept escalation |
| `POST` | `/api/startups/{id}/approvals/{id}/reject` | Reject with feedback |

#### CEO Chat

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/chat/history` | Chat history (paginated) |
| `POST` | `/api/startups/{id}/chat/send` | Send message to CEO → triggers SSE response |
| `GET` | `/stream/startups/{id}/chat` | **SSE** — Streaming CEO responses |

#### Fundamental Idea

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/startups/{id}/idea` | Get FundamentalIdea (core + direction) |
| `PATCH` | `/api/startups/{id}/idea/direction` | Update current_direction (via CEO approval) |

### 14.5 WebSocket Events

Single WebSocket connection per startup session: `ws://host/ws/startups/{id}`

#### Server → Client Events

| Event | Payload | When |
|---|---|---|
| `agent.status_changed` | `{ agent_id, old_status, new_status }` | Agent transitions (idle→running, etc.) |
| `agent.spawned` | `{ agent_id, type, spawned_by, task_id }` | New spawned agent created |
| `agent.destroyed` | `{ agent_id, task_id, outcome }` | Spawned agent completed/failed and destroyed |
| `task.created` | `{ task_id, title, assigned_to, parent_id }` | New task created |
| `task.status_changed` | `{ task_id, old_status, new_status }` | Task transitions |
| `task.completed` | `{ task_id, outcome, cost }` | Task finished |
| `meeting.started` | `{ meeting_id, type, participants }` | Meeting in progress |
| `meeting.completed` | `{ meeting_id, decisions[], learnings[] }` | Meeting finished |
| `approval.new` | `{ approval_id, type, description, from_agent }` | New approval needed |
| `approval.resolved` | `{ approval_id, decision }` | Approval handled |
| `budget.updated` | `{ spent, remaining, last_entry }` | Cost changed |
| `notification` | `{ type, title, body, severity }` | General notification (toast) |

#### Client → Server Events

| Event | Payload | Purpose |
|---|---|---|
| `subscribe` | `{ startup_id }` | Join startup's event stream |
| `unsubscribe` | `{ startup_id }` | Leave startup's event stream |

### 14.6 Celery Worker Queues

| Queue | Workers | Purpose |
|---|---|---|
| `agent_execution` | `agent_executor` | Run agent tasks (PydanticAI agent invocations) |
| `agent_spawn` | `spawn_manager` | Spawn lifecycle: create agent → assign task → monitor → distill → destroy |
| `meetings` | `meeting_runner` | Execute meeting protocol (agenda → collect responses → decide) |
| `escalation` | `escalation_handler` | Propagate blockers up hierarchy, notify user if chain reaches CEO |
| `consolidation` | `memory_consolidator` | Light consolidation (post-task) and deep consolidation (post-standup) |
| `budget` | `budget_tracker` | Aggregate costs: per-call → per-task → per-agent |

### 14.7 Service Layer Contracts

```python
# Core service interfaces (not implementation — just contracts)

class StartupService:
    async def create(user_id, name, core_idea, budget) -> Startup
    async def get(startup_id) -> Startup
    async def list_for_user(user_id) -> list[Startup]
    async def update_status(startup_id, status) -> Startup
    async def get_overview(startup_id) -> OverviewMetrics

class HierarchyService:
    async def propose(startup_id, idea, budget) -> Hierarchy  # LLM-powered
    async def approve(startup_id, hierarchy) -> Hierarchy
    async def get(startup_id) -> Hierarchy
    async def instantiate_all_agents(startup_id) -> list[EmployeeAgent]

class AgentService:
    async def get(agent_id) -> Agent
    async def list_for_startup(startup_id, include_spawned) -> list[Agent]
    async def get_metrics(agent_id) -> AgentMetrics
    async def get_memory_summary(agent_id) -> MemorySummary  # Patterns + Skills
    async def spawn(parent_id, agent_type, task_id, config) -> SpawnedAgent
    async def destroy(agent_id, distill_to_parent) -> None

class TaskService:
    async def create(startup_id, title, description, assigned_to, parent_id) -> Task
    async def get(task_id) -> Task
    async def list_for_startup(startup_id, filters) -> list[Task]
    async def get_tree(startup_id) -> TaskTree
    async def update_status(task_id, status) -> Task
    async def get_trace(task_id) -> list[TraceEntry]

class MemoryService:
    # Wraps Mem0 — maps Hippocampus model to Mem0's multi-level API
    async def store(agent_id, content, memory_type) -> MemoryUnit
    async def retrieve(agent_id, query, top_k) -> list[MemoryUnit]
    async def get_patterns(agent_id) -> list[Pattern]
    async def get_skills(agent_id) -> list[Skill]
    async def consolidate(agent_id, depth: "light" | "deep") -> None

class MeetingService:
    async def schedule_standup(startup_id, participants) -> Meeting
    async def trigger_escalation(blocker_agent_id, blocker_description) -> Meeting
    async def execute(meeting_id) -> MeetingResult  # Runs protocol
    async def get(meeting_id) -> Meeting
    async def list_for_startup(startup_id, filters) -> list[Meeting]

class ChatService:
    # CEO ↔ User bidirectional chat
    async def send_message(startup_id, user_message) -> None  
    async def stream_response(startup_id) -> AsyncIterator[str]  # SSE
    async def get_history(startup_id, page) -> list[ChatMessage]

class BudgetService:
    async def record_cost(agent_id, task_id, model, tokens_in, tokens_out, cost) -> None
    async def get_overview(startup_id) -> BudgetOverview
    async def get_breakdown(startup_id) -> BudgetBreakdown
    async def update_allocation(startup_id, new_total) -> Budget

class ApprovalService:
    async def create(startup_id, type, description, from_agent) -> Approval
    async def list_pending(startup_id) -> list[Approval]
    async def accept(approval_id) -> None
    async def reject(approval_id, feedback) -> None

class NotificationService:
    async def send_toast(startup_id, title, body, severity) -> None  # via WebSocket
    async def send_bell(user_id, notification) -> None  # persisted
    async def get_history(user_id, page) -> list[Notification]
```

### 14.8 Agent Execution Flow (Backend Perspective)

```
User sends message via POST /api/startups/{id}/chat/send
    │
    ▼
ChatService.send_message()
    │
    ├── Store user message in Postgres (chat history)
    ├── Enqueue: Celery → agent_execution queue
    │
    ▼
agent_executor worker picks up job
    │
    ├── Load CEO Agent (PydanticAI Agent[CEODeps, CEOOutput])
    ├── Inject: FundamentalIdea + recent chat + WorkingMemory (Redis)
    ├── CEO agent reasons via Azure OpenAI (gpt-5)
    │
    ├── If CEO decides to decompose into tasks:
    │     └── TaskService.create() for each → enqueue agent_execution
    │
    ├── If CEO decides to assign to CTO:
    │     └── TaskService.create(assigned_to=CTO) → enqueue agent_execution
    │
    ├── If CEO needs user approval:
    │     └── ApprovalService.create() → WebSocket: approval.new
    │
    ├── CEO response tokens stream via SSE → GET /stream/startups/{id}/chat
    │
    ├── BudgetService.record_cost() for every LLM call
    │
    └── WebSocket: agent.status_changed, task.created, etc.

Employee agent receives task (from Celery queue):
    │
    ├── MemoryService.retrieve(query=task.description, top_k=10)
    ├── LLM reasoning: simple → self-execute | complex → spawn
    │
    ├── If self-execute:
    │     ├── Execute with tools (via MCP servers)
    │     ├── Record TraceEntries
    │     ├── MemoryService.consolidate(depth="light")
    │     └── TaskService.update_status(COMPLETED)
    │
    ├── If spawn:
    │     ├── AgentService.spawn(type, task, config)
    │     ├── Celery → agent_spawn queue
    │     │
    │     ├── spawn_manager creates agent:
    │     │     ├── GenericAgent → PydanticAI Agent + delegated memory
    │     │     ├── SpecializedAgent(codegen) → GitHub Copilot SDK
    │     │     ├── SpecializedAgent(browser) → browser-use
    │     │     └── Code execution → E2B sandbox
    │     │
    │     ├── Agent executes → result returned
    │     ├── Parent verifies (VerifierState)
    │     ├── MemoryService.store(distilled trajectory)
    │     └── AgentService.destroy(spawned_agent)
    │
    └── If blocked:
          └── MeetingService.trigger_escalation()
              → Celery: escalation queue
              → Chain up hierarchy
              → Eventually → ApprovalService.create() if reaches user
```

### 14.9 Project Structure

```
arceus/
├── api/                         # FastAPI routers
│   ├── __init__.py
│   ├── app.py                   # FastAPI app factory
│   ├── deps.py                  # Dependency injection
│   ├── middleware.py             # Auth, CORS, rate limiting
│   ├── routers/
│   │   ├── auth.py
│   │   ├── startups.py
│   │   ├── hierarchy.py
│   │   ├── agents.py
│   │   ├── tasks.py
│   │   ├── meetings.py
│   │   ├── tickets.py
│   │   ├── budget.py
│   │   ├── approvals.py
│   │   ├── chat.py              # REST + SSE for CEO chat
│   │   └── ws.py                # WebSocket handler
│   └── schemas/                 # Pydantic request/response models
│       ├── startup.py
│       ├── agent.py
│       ├── task.py
│       ├── meeting.py
│       └── ...
│
├── core/                        # Business logic
│   ├── services/
│   │   ├── startup.py           # StartupService
│   │   ├── hierarchy.py         # HierarchyService
│   │   ├── agent.py             # AgentService
│   │   ├── task.py              # TaskService
│   │   ├── memory.py            # MemoryService (wraps Mem0)
│   │   ├── meeting.py           # MeetingService
│   │   ├── chat.py              # ChatService
│   │   ├── budget.py            # BudgetService
│   │   ├── approval.py          # ApprovalService
│   │   └── notification.py      # NotificationService
│   │
│   ├── agents/                  # PydanticAI agent definitions
│   │   ├── base.py              # Base agent config
│   │   ├── ceo.py               # CEO Agent[CEODeps, CEOOutput]
│   │   ├── cto.py               # CTO Agent
│   │   ├── developer.py         # Developer Agent
│   │   ├── pm.py                # PM Agent
│   │   ├── ml_engineer.py       # ML Engineer Agent
│   │   └── spawned/
│   │       ├── generic.py       # GenericAgent
│   │       ├── coding.py        # SpecializedAgent(codegen) → Copilot SDK
│   │       ├── browser.py       # SpecializedAgent(browser) → browser-use
│   │       └── exploratory.py   # ExploratoryAgent
│   │
│   ├── orchestration/           # PydanticAI Graph flows
│   │   ├── task_router.py       # Route tasks down hierarchy
│   │   ├── spawn_lifecycle.py   # Spawn → execute → verify → distill → destroy
│   │   ├── meeting_protocol.py  # Structured meeting execution
│   │   ├── escalation_chain.py  # Blocker propagation up hierarchy
│   │   └── startup_init.py      # Idea → hierarchy → agents → first tasks
│   │
│   └── memory/                  # Hippocampus implementation
│       ├── hippocampus.py       # Wraps Mem0 multi-level API
│       ├── reasoning_bank.py    # retrieve, judge, distill, consolidate
│       └── patterns.py          # Pattern evolution, merge, prune
│
├── db/                          # Data layer
│   ├── models/                  # SQLAlchemy models
│   │   ├── user.py
│   │   ├── startup.py
│   │   ├── hierarchy.py
│   │   ├── agent.py
│   │   ├── task.py
│   │   ├── meeting.py
│   │   ├── ticket.py
│   │   ├── budget.py
│   │   └── memory.py            # Pattern, Skill, Habit metadata
│   ├── repos/                   # Repository pattern
│   │   ├── base.py
│   │   ├── startup.py
│   │   ├── agent.py
│   │   ├── task.py
│   │   └── ...
│   ├── session.py               # Async SQLAlchemy session
│   └── migrations/              # Alembic migrations
│
├── integrations/                # External service wrappers
│   ├── mem0_client.py           # Mem0 self-hosted client
│   ├── copilot_sdk.py           # GitHub Copilot SDK wrapper
│   ├── browser_use.py           # browser-use wrapper
│   ├── e2b_sandbox.py           # E2B sandbox manager
│   ├── azure_openai.py          # Azure OpenAI client (model tiering)
│   └── mcp/                     # MCP server connections
│       ├── registry.py          # MCP server registry
│       └── servers/             # Custom MCP server implementations
│
├── workers/                     # Celery workers
│   ├── celery_app.py            # Celery configuration
│   ├── agent_executor.py        # Execute agent tasks
│   ├── spawn_manager.py         # Spawn lifecycle management
│   ├── meeting_runner.py        # Meeting protocol execution
│   ├── escalation_handler.py    # Escalation chain processing
│   ├── memory_consolidator.py   # Light + deep consolidation
│   └── budget_tracker.py        # Cost aggregation
│
├── config/                      # Configuration
│   ├── settings.py              # Pydantic Settings (env-based)
│   └── models.py                # LLM model tier config
│
└── tests/
    ├── api/
    ├── core/
    ├── db/
    └── workers/
```

### 14.10 LLM Model Tiering

| Agent Tier | Model | Use Case | Cost Profile |
|---|---|---|---|
| **CEO** | gpt-5 / o4-mini | Strategic reasoning, user interaction, task decomposition | Highest — few calls, high stakes |
| **Employee** | gpt-4.1-mini | Task execution, meeting participation, memory consolidation | Medium — frequent calls |
| **Spawned** | gpt-4.1-nano | Tool use, focused execution, code gen support | Lowest — many calls, simple tasks |
| **Embeddings** | text-embedding-3-small | MemoryUnit embeddings, semantic search | Bulk — every memory operation |

All routed through `integrations/azure_openai.py` which handles:
- Model selection based on agent type
- Token counting and cost recording → `BudgetService.record_cost()`
- Rate limiting and retry logic
- Structured outputs via PydanticAI

---

## 15. Post-MVP Roadmap

### Deferred Constructs

| Feature | Description | Why Deferred |
|---|---|---|
| **SSM/Mamba Personality** | Pretrained Mamba weights per Employee that filter instructions through a personality state. Customizable personality widgets. | Requires training infrastructure. MVP uses system prompts only. |
| **Domain-Driven Distillation** | RL-based continual training pipeline to align memory distillation with the startup's domain. Feedback loop at sub-agent level measuring alignment to FundamentalIdea. | Needs context from running startups (data collection). Post-architecture feature. |
| **RL Training for GenericAgents** | GRPO training on SLMs (Qwen3) for trajectory optimization. Makes spawned agents better at planning multi-step tasks. | Requires training pipeline. MVP uses plain LLM + context engineering. |
| **Pivot Construct** | Direction change mechanism with `PivotMemoryImpact` — which patterns to prune, memories to deprecate, skills to update across all employees. Special pivot meeting. | Complex memory surgery. MVP focuses on getting the core loop right. |
| **Multiple Projects per Startup** | A Startup contains multiple Projects, each with its own task tree. | Adds entity complexity. MVP: one startup = one project. |
| **Chat with Non-CEO Agents** | User can directly message any EmployeeAgent, not just CEO. | Breaks the Board of Directors metaphor. May add as power-user feature. |
| **Full Memory Transparency** | User can inspect raw MemoryUnits, not just Pattern/Skill summaries. | Information overload. Summary view is sufficient for MVP. |
| **Incremental Hiring** | CEO/CTO decide when to hire new roles as tasks demand, rather than instantiating all at once. | Adds hiring pipeline complexity. All-at-once is simpler for MVP. |
| **Task Queue Self-Assignment** | Employee agents pull tasks from a shared pool based on skills/availability instead of top-down assignment. | Interesting optimization but breaks clear hierarchy routing for MVP. |

---

*Last updated: March 17, 2026*
