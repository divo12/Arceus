# Spec 04: Persistence

> Status: DRAFT (may change based on Hippocampus + Sprint Cycle discussions)
> Last updated: 2026-04-05

## Stack

- **PostgreSQL** (pgvector extension) — all persistent data
- **Redis** — working memory (TTL), pub/sub for real-time events, activity stream
- **Filesystem** — /workspace (product code)
- **Drizzle ORM** — TypeScript schema, auto-migrations, type-safe queries

## Infrastructure

```
Podman (local dev):
  arceus-pg    → PostgreSQL 17 + pgvector  (port 5433)
  arceus-redis → Redis 7 alpine            (port 6379)

Filesystem:
  /workspace   → product code (persists across sprints)
```

## Schema: 15 Tables, 6 Domains

### Domain 1: COMPANY

```sql
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ideation',  -- ideation|active|paused|archived
  budget_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  current_strategy_id UUID,
  current_sprint_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  summary TEXT,
  first_release TEXT,
  scope_boundary TEXT[],
  role_rationale TEXT[],
  roles JSONB,             -- [{role, title, parent_role, capabilities}]
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed|approved|rejected
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

### Domain 2: PEOPLE

```sql
CREATE TABLE role_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  slug TEXT NOT NULL,       -- ceo|cto|pm|developer|tester|ui_designer|marketing|skills_lead
  label TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  can_write_code BOOLEAN NOT NULL DEFAULT false,
  can_edit_files BOOLEAN NOT NULL DEFAULT false,
  can_run_shell BOOLEAN NOT NULL DEFAULT false,
  can_delegate_to TEXT[] NOT NULL DEFAULT '{}',
  allowed_direct_reports TEXT[] NOT NULL DEFAULT '{}',
  delegation_style TEXT NOT NULL DEFAULT 'collaborative',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, slug)
);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'idle',  -- idle|working|error|paused
  reports_to UUID REFERENCES agents(id),
  role_definition_id UUID REFERENCES role_definitions(id),
  soul_prompt TEXT,
  capabilities JSONB,
  session_id TEXT,           -- OpenCode session ID
  session_status TEXT,       -- active|idle|error
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Domain 3: WORK

```sql
CREATE TABLE sprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  strategy_id UUID REFERENCES strategies(id),
  number INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',  -- planning|executing|reviewing|done
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  sprint_id UUID REFERENCES sprints(id),
  parent_task_id UUID REFERENCES tasks(id),
  kind TEXT NOT NULL DEFAULT 'custom',  -- technical_plan|acceptance_spec|implementation|preview|review|specialist|custom
  title TEXT NOT NULL,
  description TEXT,
  deliverable TEXT,
  definition_of_done TEXT,
  status TEXT NOT NULL DEFAULT 'todo',  -- todo|in_progress|blocked|done|failed
  priority TEXT NOT NULL DEFAULT 'medium',  -- critical|high|medium|low
  assigned_role TEXT,
  assigned_agent_id UUID REFERENCES agents(id),
  depends_on_task_ids UUID[] NOT NULL DEFAULT '{}',
  cost_cents INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  task_id UUID REFERENCES tasks(id),
  agent_id UUID REFERENCES agents(id),
  kind TEXT NOT NULL DEFAULT 'output',  -- plan|spec|code|review|output
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Domain 4: COMMS

```sql
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL,         -- user|assistant
  content TEXT NOT NULL,
  card_type TEXT,             -- strategy_proposal|clarifying_question|status_update
  card_data JSONB,
  card_state JSONB,
  agent_id UUID REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  sprint_id UUID REFERENCES sprints(id),
  type TEXT NOT NULL DEFAULT 'ad_hoc',  -- standup|escalation|handoff|review|ad_hoc
  title TEXT,
  summary TEXT,
  participants UUID[] NOT NULL DEFAULT '{}',
  decisions JSONB NOT NULL DEFAULT '[]',
  learnings JSONB NOT NULL DEFAULT '[]',
  task_modifications JSONB NOT NULL DEFAULT '[]',
  memory_modifications JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',  -- active|completed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,         -- strategy|hire|board_review|external
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  title TEXT NOT NULL,
  description TEXT,
  requested_by_agent_id UUID REFERENCES agents(id),
  resolution_summary TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

### Domain 5: MEMORY (Hippocampus — detailed in Spec 05)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  embedding vector(384),     -- all-MiniLM-L6-v2
  memory_type TEXT NOT NULL DEFAULT 'dynamic',  -- static|dynamic|procedural|priming
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  relevance_score DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  container TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',  -- private|task_scoped|shared|board
  source_type TEXT,
  source_id TEXT,
  provenance TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  previous_version_id UUID,
  promotion_status TEXT,     -- NULL|promoted
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  delete_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE habits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  trigger_condition TEXT NOT NULL,
  action TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  formed_from_id TEXT NOT NULL DEFAULT '',
  formation_mode TEXT NOT NULL DEFAULT 'auto',  -- auto|explicit
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  description TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT '',
  embedding vector(384),
  usage_count INTEGER NOT NULL DEFAULT 0,
  success_rate DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  domain TEXT NOT NULL DEFAULT '',
  cluster_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active|merged|pruned|archived
  formed_from UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE priming_state (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  caution DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  morale DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  recent_events JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Domain 6: AUDIT

```sql
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',  -- board|agent|system
  actor_id TEXT,
  summary TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cost_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID REFERENCES agents(id),
  task_id UUID REFERENCES tasks(id),
  sprint_id UUID REFERENCES sprints(id),
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Indexes

```sql
-- Company lookups
CREATE INDEX idx_agents_company ON agents(company_id);
CREATE INDEX idx_tasks_company ON tasks(company_id);
CREATE INDEX idx_tasks_sprint ON tasks(sprint_id);
CREATE INDEX idx_tasks_assignee ON tasks(assigned_agent_id);
CREATE INDEX idx_tasks_status ON tasks(company_id, status);
CREATE INDEX idx_sprints_company ON sprints(company_id);
CREATE INDEX idx_chat_company ON chat_messages(company_id, created_at);

-- Memory search
CREATE INDEX idx_memory_agent_type ON memory_units(agent_id, memory_type);
CREATE INDEX idx_memory_container ON memory_units(container);
CREATE INDEX idx_memory_embedding ON memory_units USING hnsw (embedding vector_cosine_ops);

-- Pattern search
CREATE INDEX idx_patterns_agent ON patterns(agent_id);
CREATE INDEX idx_patterns_embedding ON patterns USING hnsw (embedding vector_cosine_ops);

-- Audit
CREATE INDEX idx_events_company ON events(company_id, created_at);
CREATE INDEX idx_cost_company ON cost_events(company_id);
```

## Redis Usage

```
Working Memory (TTL-based):
  wm:{agentId}:{taskId} → JSON context (TTL: 2 hours)

Pub/Sub Channels:
  activity:{companyId}    → employee activity events (for SSE)
  tasks:{companyId}       → task status changes (for dashboard)
  chat:{companyId}        → new chat messages (for live updates)

Caching (optional, post-MVP):
  snapshot:{companyId}    → cached company snapshot (TTL: 60s)
```

## Migration Tool: Drizzle

```
packages/db/
  src/
    schema/        — Drizzle table definitions (one file per domain)
      company.ts
      people.ts
      work.ts
      comms.ts
      memory.ts
      audit.ts
    client.ts      — Database connection
    index.ts       — Re-exports
  drizzle/
    migrations/    — Auto-generated SQL migrations
  drizzle.config.ts
```

Workflow:
```bash
pnpm db:generate    # Generate migration from schema diff
pnpm db:migrate     # Apply pending migrations
pnpm db:push        # Push schema directly (dev only)
```

## Decisions Made

- PostgreSQL + pgvector for everything persistent
- Redis for working memory (TTL), pub/sub (real-time events)
- Drizzle ORM for type-safe schema + migrations
- 15 tables across 6 domains
- No graph store (Neo4j removed)
- Filesystem for workspace (/workspace persists across sprints)
- HNSW indexes for vector similarity search on memory_units and patterns

## Lessons from Paperclip

- Paperclip had 69 tables — too many. We have 15.
- Paperclip used Supabase session pooler — pool exhaustion was constant. We use local Postgres.
- Paperclip's startup_id/company_id mismatch caused UUID errors. We use company_id consistently.
- Paperclip's Drizzle migrations auto-applied on startup — keeping that (PAPERCLIP_MIGRATION_AUTO_APPLY pattern).

## Post-MVP

- Graph relationships (Neo4j or PostgreSQL recursive CTEs)
- Full-text search on artifacts and chat
- Read replicas for dashboard queries
- Backup/restore automation
- Multi-company isolation (row-level security)
