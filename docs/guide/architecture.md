# Architecture

## System Diagram

```
┌─────────────────────────────────────────────────────┐
│                   BOARD (User)                       │
│            Browser: localhost:3000                    │
│  ┌─────────────────────────────────────────────────┐│
│  │         LIVING DASHBOARD (Next.js)               ││
│  │  Boardroom Chat │ Task Board │ Activity Feed     ││
│  └────────────────────────┬────────────────────────┘│
└───────────────────────────┼─────────────────────────┘
                            │ REST + SSE
┌───────────────────────────┼─────────────────────────┐
│              CONTROL PLANE (Fastify API)             │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │Orchestr. │  │Heartbeat │  │  Meeting Pipeline  │  │
│  │  State   │  │ Engine   │  │  Scheduler + Fac.  │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       │              │                 │              │
│  ┌────┴──────────────┴─────────────────┴──────────┐  │
│  │           COMPANY RUNTIME (pure logic)          │  │
│  │  Roles │ Heartbeat │ Checklist │ Skills │ Pats  │  │
│  └────────────────────┬───────────────────────────┘  │
│                       │                              │
│  ┌────────────────────┴───────────────────────────┐  │
│  │              TASK ENGINE (pure logic)           │  │
│  │  State Machine │ Sprint Lifecycle │ Exec Cycle  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Hippocampus │  │   OpenCode   │  │  Workspace  │  │
│  │   Memory    │  │   (LLM I/O)  │  │   Manager   │  │
│  └──────┬──────┘  └──────────────┘  └────────────┘  │
│         │                                            │
│  ┌──────┴─────────────────────────────────────────┐  │
│  │         Postgres + pgvector (via Drizzle)       │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Package Dependency Graph

```
contracts  ←── db  ←── hippocampus
    ↑                      ↑
    ├── company-runtime     │
    ├── task-engine         │
    └── api ───────────────┘
```

- **contracts** — zero-dependency Zod schemas shared by everything
- **db** — Drizzle schema + migrations, depends on contracts for types
- **hippocampus** — memory system, depends on db for pgvector stores
- **company-runtime** — pure business logic (no I/O), depends on contracts
- **task-engine** — pure state machine and lifecycle, depends on contracts
- **api** — wires everything together, owns I/O (LLM, filesystem, HTTP)

## Data Flow

1. **HTTP/SSE** — Dashboard ↔ API for commands and live streaming
2. **Heartbeat ticks** — Scheduler fires agent beats at configurable intervals
3. **OpenCode sessions** — API ↔ OpenCode for LLM tool-use execution
4. **Store mutations** — Optimistic-concurrency writes to in-memory snapshot + Postgres
5. **Event bridge** — Streams OpenCode events back into agent state + prompt resolution
6. **Reactive events** — Task completions wake downstream agents immediately
