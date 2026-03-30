# Arceus — System Architecture

> Complete technical reference for the Arceus platform (Paperclip).
> Covers frontend, backend, adapters, memory, org layer, and all key flows.

---

## 1. Monorepo Layout

```
Arceus/
├── server/                  # Express backend (TypeScript)
├── ui/                      # React frontend (TypeScript, Vite)
├── packages/
│   ├── db/                 # Drizzle ORM schema & migrations (60+ tables)
│   ├── shared/             # Shared types, validators, constants
│   ├── adapters/           # All adapter implementations
│   │   ├── arceus/         # Azure OpenAI adapter (built-in)
│   │   ├── opencode-local/ # OpenCode server adapter
│   │   ├── claude-local/   # Anthropic Claude adapter
│   │   ├── codex-local/    # Codex adapter
│   │   ├── gemini-local/   # Google Gemini adapter
│   │   ├── cursor-local/   # Cursor IDE adapter
│   │   ├── pi-local/       # Pi model adapter
│   │   ├── openclaw-gateway/ # External gateway adapter
│   │   └── hermes-local/   # Hermes adapter
│   ├── adapter-utils/      # Shared adapter utilities (skill sync, env builder, JWT)
│   └── plugins/            # Plugin SDK & tool definitions
├── services/
│   └── hippocampus-runtime/ # Python memory engine (pgvector, Redis, Neo4j)
├── skills/                  # AI agent skill definitions (SKILL.md files)
├── opencode/               # Git submodule: OpenCode SDK
├── cli/                    # Local dev CLI
├── tests/                  # E2E & integration tests (Playwright)
└── scripts/                # Build, deploy, release
```

**Package manager**: pnpm 9.15.4 | **Runtime**: Node >= 20 | **DB**: Embedded PostgreSQL (default) or remote

---

## 2. Backend (server/)

### 2.1 Entry Point & App Setup

`**server/src/index.ts`** — Bootstraps the server:

1. Initializes embedded PostgreSQL (or connects to remote via `DATABASE_URL`)
2. Starts Hippocampus bridge (Python subprocess for memory)
3. Creates Express app via `createApp()`
4. Starts WebSocket server for live events
5. Starts background schedulers (heartbeat cron, plugin jobs, DB backups)

`**server/src/app.ts**` — Express app with middleware + route mounting:

```
Middleware stack:
  HTTP logger → Actor resolution (board/agent JWT) → Board mutation guard
  → Private hostname gating → JSON body parser

Route mounting order (/api prefix):
  /health → /companies → /agents → /projects → /issues → /goals
  → /approvals → /routines → /meetings → /execution-workspaces
  → /memory → /roles → /hierarchy → /plugins → /access
  → /costs → /activity → /dashboard → /assets
```

### 2.2 Service Layer (`server/src/services/`)

Every service is a **factory function**: `serviceFactory(db: Db) → ServiceAPI`. Services are stateless — all state lives in the database.

#### Core Services


| Service            | File                       | Purpose                                                     |
| ------------------ | -------------------------- | ----------------------------------------------------------- |
| `agentService`     | `agents.ts`                | Agent CRUD, config revisions, API key management            |
| `heartbeatService` | `heartbeat.ts` (~3000 LOC) | **The engine** — orchestrates all agent execution           |
| `companyService`   | `companies.ts`             | Company CRUD, role seeding on create                        |
| `issueService`     | `issues.ts`                | Issue tracking, assignment, approval gates                  |
| `meetingService`   | `meetings.ts`              | Meeting lifecycle, participant management, event extraction |
| `routineService`   | `routines.ts`              | Recurring task definitions and dispatch                     |
| `approvalService`  | `approvals.ts`             | Approval workflows (hire, budget, issue)                    |


#### Memory Services


| Service             | File                    | Purpose                                |
| ------------------- | ----------------------- | -------------------------------------- |
| `hippocampusBridge` | `hippocampus-bridge.ts` | Node.js ↔ Python RPC bridge            |
| `memoryLifecycle`   | `memory-lifecycle.ts`   | Pre-run recall, post-run extraction    |
| `memoryScope`       | `memory-scope.ts`       | Container isolation, visibility rules  |
| `memoryProjections` | `memory-projections.ts` | Static memory types (habits, patterns) |
| `delegationMemory`  | `delegation-memory.ts`  | Delegation context builder             |


#### Org Layer Services


| Service                  | File                  | Purpose                                         |
| ------------------------ | --------------------- | ----------------------------------------------- |
| `roleDefinitionService`  | `role-definitions.ts` | Role matrix CRUD, seeding, agent FK resolution  |
| `hierarchyService`       | `hierarchy.ts`        | Org snapshots: propose → approve → activate     |
| `delegationGuardService` | `delegation-guard.ts` | Role-based delegation matrix enforcement        |
| `spawnGovernanceService` | `spawn-governance.ts` | Spawn budget tracking, employee-role hard guard |


#### Infrastructure Services


| Service                  | File                        | Purpose                                          |
| ------------------------ | --------------------------- | ------------------------------------------------ |
| `pluginLifecycleManager` | `plugin-lifecycle.ts`       | Plugin state machine (installed → ready → error) |
| `pluginWorkerManager`    | `plugin-worker-manager.ts`  | Spawns/kills plugin worker processes             |
| `pluginJobScheduler`     | `plugin-job-scheduler.ts`   | Async job queue for plugin work                  |
| `pluginToolDispatcher`   | `plugin-tool-dispatcher.ts` | Routes LLM tool calls to plugins                 |
| `budgetService`          | `budgets.ts`                | Monthly budget enforcement                       |
| `costService`            | `costs.ts`                  | Cost aggregation & reporting                     |
| `accessService`          | `access.ts`                 | RBAC, permission grants                          |
| `secretService`          | `secrets.ts`                | Encrypted secret storage                         |


### 2.3 Route Layer (`server/src/routes/`)

Routes handle HTTP, validate input (Zod), resolve actors, and delegate to services.

**Key routes:**


| Route file              | Endpoints                                                      | Auth                                               |
| ----------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `agents.ts` (~2400 LOC) | CRUD, hire, skill sync, heartbeat invoke, delegation authority | Board + Agent                                      |
| `hierarchy.ts`          | Active hierarchy, proposals, approve/activate/reject, diff     | Board (approve/reject), Agent (propose — CEO only) |
| `roles.ts`              | List, get by slug, create, update, authority matrix            | Board                                              |
| `memory.ts`             | Scoped recall, shareable memories, extract, graph search       | Board + Agent                                      |
| `issues.ts`             | CRUD, assign, checkout, comments, work products                | Board + Agent                                      |
| `meetings.ts`           | CRUD, participants, events, wakeup                             | Board + Agent                                      |
| `access.ts` (~2700 LOC) | Invites, join requests, permissions, OpenClaw invite           | Board                                              |


---

## 3. Adapter System

### 3.1 How Adapters Work

An adapter is the bridge between Paperclip and an LLM runtime. Each adapter implements:

```typescript
interface ServerAdapterModule {
  type: string
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>
  testEnvironment(config): Promise<AdapterEnvironmentTestResult>
  listSkills?(): Promise<string[]>
  syncSkills?(config): Promise<void>
  listModels?(): Promise<{ id: string; label: string }[]>
  sessionCodec?: AdapterSessionCodec      // multi-turn state
  models?: Array<{ id: string; label: string }>
  supportsLocalAgentJwt?: boolean
}
```

### 3.2 Adapter Types


| Type               | Runtime       | Skill Sync | Session Codec | How it executes                             |
| ------------------ | ------------- | ---------- | ------------- | ------------------------------------------- |
| `arceus`           | Azure OpenAI  | Yes        | No            | Writes AGENTS.md → OpenCode server HTTP API |
| `opencode_local`   | OpenCode      | Yes        | Yes           | Materializes instructions → OpenCode CLI    |
| `claude_local`     | Anthropic SDK | Yes        | Yes           | Materializes instructions → Claude CLI      |
| `codex_local`      | Codex         | Yes        | Yes           | Materializes instructions → Codex CLI       |
| `gemini_local`     | Google Gemini | Yes        | Yes           | Materializes instructions → Gemini CLI      |
| `cursor`           | Cursor IDE    | Yes        | Yes           | Materializes instructions → Cursor          |
| `pi_local`         | Pi model      | Yes        | Yes           | Materializes instructions → Pi CLI          |
| `openclaw_gateway` | External      | No         | No            | WebSocket to remote agent                   |
| `process`          | Shell         | No         | No            | Executes shell command                      |
| `http`             | Webhook       | No         | No            | POST to external URL                        |


### 3.3 The Two Instruction Paths

This is critical to understand:

**Path A: Materialized instructions** (`opencode_local`, `claude_local`, etc.)

- At hire time, onboarding assets from `server/src/onboarding-assets/{role}/` are written to disk
- Files: AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md (varies by role)
- Stored at `~/.paperclip/instances/default/companies/{companyId}/agents/{agentId}/instructions/`
- Agent's `adapterConfig.instructionsFilePath` points to the entry file
- Static — only changes if explicitly re-materialized

**Path B: Dynamic context** (`arceus` adapter)

- Every run, `writeAgentsMd()` in `execute.ts` generates a fresh AGENTS.md
- Injects: env vars, role context, delegation authority, spawn budget, org position, memory context, meeting context, session handoff, hiring instructions
- Written to `opencode/.opencode/AGENTS.md` (OpenCode picks this up)
- Dynamic — rebuilt from current state every run

**Implication**: Changes to onboarding templates only affect Path A agents. The `arceus` adapter builds its own context from service data injected by the heartbeat.

### 3.4 Arceus Adapter Deep Dive

`**server/src/adapters/arceus/execute.ts`**

Execution flow:

1. Inject skills into `~/.claude/skills/` (symlinks)
2. Write dynamic AGENTS.md with full agent context
3. Resolve provider + model from env/config (default: `azure/gpt-4.1`)
4. Create OpenCode session via HTTP (`POST /session`)
5. Send prompt via HTTP (`POST /session/{id}/message`)
6. Stream response, capture tool calls
7. Return result with token usage

The dynamic AGENTS.md includes:

- Agent identity and env vars (API key, company ID, run ID)
- Role context block (from `buildRoleContextBlock()`):
  - Role label and system prompt
  - Delegation authority (who can be delegated to, style hints)
  - Spawn authority (allowed types, budget)
  - Org position (reports to, direct reports)
- Hiring instructions (how to call `/agent-hires`)
- Reference to the `paperclip` skill for full procedure
- Memory context (from Hippocampus recall)
- Meeting context (active meetings)
- Session handoff (from previous session compaction)

---

## 4. Agent Lifecycle

### 4.1 Hiring

```
User/Agent → POST /api/companies/{id}/agent-hires
  ├── Validate: spawn governance (if agent-initiated)
  ├── Validate: delegation authority (if agent-initiated)
  ├── Create agent record (status: idle or pending_approval)
  ├── Materialize onboarding bundle (Path A adapters only)
  │   └── Load AGENTS.md, SOUL.md, HEARTBEAT.md from onboarding-assets/{role}/
  ├── Seed role definition memory (Hippocampus)
  ├── Create approval record (if company requires it)
  └── Return agent + approval
```

### 4.2 Heartbeat Execution (The Core Loop)

```
Trigger (scheduled / event / manual / delegation)
  │
  ▼
heartbeatService.executeRun()
  ├── Acquire execution lock (prevent concurrent runs)
  ├── Fetch agent + workspace + runtime state
  ├── Build context:
  │   ├── Role definition → paperclipRoleDefinition
  │   ├── Spawn budget → paperclipSpawnBudget
  │   ├── Org position → paperclipOrgPosition
  │   ├── Delegation depth → paperclipDelegationDepth
  │   ├── Delegation run context → paperclipDelegationStyle, paperclipDelegatorAgentId
  │   ├── Memory recall → paperclipMemoryContext
  │   ├── Meeting context → paperclipMeetingContext
  │   └── Session handoff → paperclipSessionHandoffMarkdown
  ├── Resolve adapter from agent.adapterType
  ├── Sync skills (symlink to ~/.claude/skills/)
  ├── Create agent JWT
  ├── adapter.execute(context)
  │   ├── Stream logs (8KB chunks → WebSocket live events)
  │   └── Return {success, output, usage}
  ├── Post-execution:
  │   ├── Extract memories (Hippocampus)
  │   ├── Record costs
  │   ├── Update agent last_heartbeat_at
  │   └── Persist run events
  └── Publish "run.completed" live event → UI updates
```

### 4.3 Delegation

```
Agent A wants to delegate to Agent B:
  1. delegationGuardService.canDelegate(A, B)
     ├── A must be kind="employee" (spawned agents can't delegate)
     ├── A and B must be in same company
     ├── A's role.canDelegateTo must include B's role slug
     ├── Delegation chain depth must be <= 3
     └── Return {allowed, reason}
  2. Build delegation context (A's memories relevant to B)
  3. Wake Agent B with delegatorAgentId=A, delegationStyle
  4. B runs with delegation context injected
  5. recordDelegationEvent() stores in both A's and B's memory
```

### 4.4 Spawning

```
Agent A wants to spawn ephemeral agent of type X:
  1. spawnGovernanceService.canSpawn(A, X)
     ├── A must be kind="employee"
     ├── X must NOT be an employee role (engineer, cto, etc.)
     ├── X must be in A's role.spawnRules.allowedAgentTypes
     ├── A must not have exceeded maxConcurrentSpawns
     └── Return {allowed, reason}
  2. Create agent with kind="spawned", spawnedByAgentId=A
  3. Spawned agent executes normally
  4. Spawned agent cannot delegate or spawn others
```

---

## 5. Memory System (Hippocampus)

### 5.1 Architecture

```
Paperclip Server (Node.js)
  │
  ├── hippocampus-bridge.ts ──── stdio RPC ────► Python Runtime
  │                                                ├── PostgreSQL + pgvector (relational + vector)
  │                                                ├── Redis (working memory)
  │                                                └── Neo4j (graph memory)
  │
  ├── memory-lifecycle.ts ── Pre/post-run hooks
  ├── memory-scope.ts ────── Container isolation
  └── memory-projections.ts ─ Static memory types
```

### 5.2 Modes

- `**off**` — Memory disabled. Heartbeats run without context.
- `**embedded**` — Python subprocess spawned on server start. Communicates via stdio JSON-RPC.

### 5.3 Core Operations


| Operation                | When       | What happens                                 |
| ------------------------ | ---------- | -------------------------------------------- |
| `recall()`               | Pre-run    | Fetch relevant memories for the current task |
| `getPriming()`           | Pre-run    | Get agent's identity/priming prompt          |
| `extract()`              | Post-run   | Analyze run trajectory, store learnings      |
| `remember()`             | Anytime    | Store a specific memory                      |
| `getDelegationContext()` | Delegation | Build context from delegator's memories      |
| `graphSearch()`          | On demand  | Query knowledge graph (Neo4j)                |
| `runGC()`                | Background | Garbage collect expired/decayed memories     |
| `runPromotions()`        | Background | Promote high-confidence memories             |


### 5.4 Delegation-Style Recall Limits


| Style         | Max memories | Use case                                  |
| ------------- | ------------ | ----------------------------------------- |
| Directive     | 10           | Full context — delegator retains control  |
| Collaborative | 5            | Shared context — balanced                 |
| Autonomous    | 3            | Minimal context — delegatee owns approach |


---

## 6. Org Layer

### 6.1 Role Definitions

Roles define what an agent can do:

```typescript
{
  slug: "ceo",
  label: "CEO",
  systemPrompt: "...",
  canDelegateTo: ["cto", "pm", "engineer", "designer"],
  delegationStyle: "directive",
  spawnRules: {
    allowedAgentTypes: ["researcher", "qa", "devops", "general"],
    maxConcurrentSpawns: 10,
    spawnDepth: 1,
  },
  isBuiltIn: true,
}
```

Built-in roles are seeded on company creation. Custom roles can be created via the API.

### 6.2 Hierarchy Snapshots

Org structure is managed through a proposal workflow:

```
proposed → approved → active
              ↘ rejected

When activated:
  - Previous active snapshot → superseded
  - reports_to edges synced to agent.reportsTo FK
  - Org position context updated for all agents
```

### 6.3 Delegation Guard

The delegation matrix is a directed graph of role permissions. The guard validates:

- Source agent must be `kind: "employee"` (spawned agents blocked)
- Source role's `canDelegateTo` must include target's role slug
- No cycles allowed
- Max chain depth: 3

### 6.4 Spawn Governance

Hard rules:

- Employee roles (ceo, cto, pm, engineer, designer) can **never** be spawned — must be hired by Board
- Only roles with `spawnRules.allowedAgentTypes` can spawn
- Budget tracked per-agent (active count vs maxConcurrentSpawns)

---

## 7. Frontend (ui/)

### 7.1 Tech Stack

- React 18 + TypeScript
- Vite (dev server + build)
- TanStack React Query v5 (server state)
- React Router v6 (routing)
- Tailwind CSS + shadcn/ui components
- Lucide icons

### 7.2 Routing (`ui/src/App.tsx`)

```
/auth                        → Login/signup
/board-claim/:token          → First admin setup
/invite/:token               → Invite redemption
/instance/settings/*         → Global settings
/:companyPrefix/
  ├── dashboard              → Company overview
  ├── agents                 → Agent list
  ├── agents/:agentId        → Agent detail (runs, config, memory)
  ├── agents/new             → Hire new agent
  ├── projects               → Project list
  ├── issues                 → Issue board
  ├── goals                  → Goal tracking
  ├── meetings               → Meeting list
  ├── memory                 → Memory explorer + graph
  ├── org                    → Org chart (visual)
  ├── roles                  → Role editor
  ├── hierarchy/proposals    → Hierarchy proposals
  ├── skills                 → Company skill management
  ├── approvals              → Pending approvals
  ├── costs                  → Cost dashboard
  ├── activity               → Activity log
  ├── design-guide           → Component showcase
  └── plugins/:pluginId      → Plugin pages
```

### 7.3 API Layer (`ui/src/api/`)

Typed HTTP client with `fetch`:

```typescript
const api = {
  get<T>(path): Promise<T>,
  post<T>(path, body): Promise<T>,
  put<T>(path, body): Promise<T>,
  patch<T>(path, body): Promise<T>,
  delete<T>(path): Promise<T>,
}
```

**API modules**: `agentsApi`, `companiesApi`, `issuesApi`, `meetingsApi`, `hierarchyApi`, `rolesApi`, `memoryApi`, `pluginApi`, `healthApi`

### 7.4 Key Components


| Component              | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `AgentDetail`          | Agent view — runs, config, memory tab, delegation |
| `OrgChart`             | Visual org hierarchy (SVG)                        |
| `RoleEditor`           | Role matrix editor with delegation/spawn rules    |
| `HierarchyProposals`   | Proposal review with diff viewer                  |
| `AuthorityMatrix`      | Visual delegation authority grid                  |
| `SpawnBudgetBar`       | Spawn budget progress indicator                   |
| `DelegationStyleBadge` | Style label (directive/collaborative/autonomous)  |
| `MemoryGraphExplorer`  | Knowledge graph visualization (Neo4j data)        |
| `MemoryAnalytics`      | Memory stats, version timeline                    |


### 7.5 State Management

- **Server state**: TanStack React Query (`useQuery`, `useMutation`, `queryKeys`)
- **UI state**: React `useState` + Context (CompanyContext, DialogContext)
- **Live updates**: WebSocket subscription for run status, agent state changes

---

## 8. Database Schema (Drizzle ORM)

**Location**: `packages/db/src/schema/` — 60+ tables

### Key Table Groups

**Agents & Execution**:
`agents`, `agent_config_revisions`, `agent_runtime_state`, `agent_task_sessions`, `agent_wakeup_requests`, `agent_api_keys`, `heartbeat_runs`, `heartbeat_run_events`

**Org Structure**:
`companies`, `company_memberships`, `role_definitions`, `hierarchy_snapshots`, `hierarchy_edges`

**Work Tracking**:
`issues`, `issue_comments`, `issue_approvals`, `issue_labels`, `issue_documents`, `issue_work_products`, `projects`, `project_goals`, `routines`

**Meetings**:
`meetings`, `meeting_participants`, `meeting_events`

**Plugins**:
`plugins`, `plugin_jobs`, `plugin_state`, `plugin_entities`, `plugin_webhooks`, `plugin_logs`, `plugin_company_settings`

**Auth & Access**:
`auth_users`, `invites`, `principal_permission_grants`, `instance_user_roles`

**Finance**:
`cost_events`, `finance_events`, `company_secrets`, `company_secret_versions`

---

## 9. Plugin System

### 9.1 Lifecycle

```
installed → ready → disabled
    │         │        │
    │         ├→ error  │
    │         ↓         │
    │   upgrade_pending │
    ↓         ↓         ↓
         uninstalled
```

### 9.2 Components

- **Registry** — Tracks plugin metadata & state
- **Worker Manager** — Spawns isolated worker processes per plugin
- **Job Scheduler** — Polls queue, dispatches async work
- **Tool Dispatcher** — Routes LLM tool calls to the right plugin worker
- **Event Bus** — Broadcasts plugin status changes

---

## 10. Environment & Deployment

### Key Environment Variables

```bash
# Server
HOST=127.0.0.1
PORT=3100
SERVE_UI=true|false

# Database
DATABASE_URL=                    # Remote Postgres (empty = embedded)

# Hippocampus
PAPERCLIP_HIPPOCAMPUS_MODE=embedded|off
ARCEUS_HIPPOCAMPUS_POSTGRES_URL= # pgvector storage
ARCEUS_HIPPOCAMPUS_REDIS_URL=    # Working memory
ARCEUS_NEO4J_URI=                # Graph memory

# Azure OpenAI (for arceus adapter + hippocampus LLM calls)
ARCEUS_AZURE_OPENAI_ENDPOINT=
ARCEUS_AZURE_OPENAI_API_KEY=
ARCEUS_AZURE_OPENAI_API_VERSION=

# Arceus adapter overrides
ARCEUS_OPENCODE_PROVIDER=azure   # default: azure-cognitive-services
ARCEUS_OPENCODE_MODEL=gpt-4.1   # default: gpt-5.1-chat

# OpenCode server
OPENCODE_URL=http://127.0.0.1:4098
```

### Deployment Modes

- `**local_trusted**` — No auth, single-user dev
- `**authenticated**` — Full auth, multi-user, bootstrap admin required

---

## 11. End-to-End Flow: CEO Hires a CTO

```
1. CEO agent heartbeat fires
   → heartbeatService.executeRun() builds context with:
     - paperclipRoleDefinition (CEO role, canDelegateTo: [cto, pm, ...])
     - paperclipSpawnBudget (active: 0, max: 10, remaining: 10)
     - paperclipOrgPosition (reportsTo: Board, directReports: [])
     - paperclipMemoryContext (recalled memories)

2. Arceus adapter writes dynamic AGENTS.md
   → Includes hiring instructions with curl command to /agent-hires

3. OpenCode server executes with gpt-4.1
   → LLM reads AGENTS.md, decides to hire CTO
   → Calls: POST /api/companies/{id}/agent-hires
     { name: "CTO", role: "cto", adapterType: "opencode_local", ... }

4. Server processes hire:
   → spawnGovernanceService: allowed (CEO can hire)
   → agentService.create(): new agent record
   → materializeDefaultInstructionsBundleForNewAgent():
     loads cto/AGENTS.md, cto/SOUL.md, cto/HEARTBEAT.md
     writes to ~/.paperclip/.../agents/{ctoId}/instructions/
   → seedRoleDefinitionMemory(): stores CTO identity in Hippocampus
   → Returns agent + approval (if required)

5. CTO agent is now ready
   → Has SOUL.md persona, HEARTBEAT.md checklist, AGENTS.md team context
   → Can be woken via heartbeat, delegation, or manual trigger
   → Delegation guard allows CEO → CTO delegation
```

