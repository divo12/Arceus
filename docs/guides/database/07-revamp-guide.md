# Database Revamp Guide

This guide is for bigger work:

- redesigning part of the schema
- splitting or merging tables
- changing company-scoping patterns
- changing migration strategy
- replacing operational assumptions around runtime tables

This is the "slow down and think first" document.

## 1. Start With The Right Mental Model

Paperclip's database is not only a persistence layer for CRUD data.

It also stores:

- tenant boundaries
- governance rules
- task workflow state
- runtime execution history
- budget and finance events
- secrets metadata
- plugin state

A revamp is therefore not just a schema exercise. It is a control-plane behavior change.

## 2. Separate The DB Into Risk Classes

Before proposing a redesign, classify tables into groups.

### Core business truth

Examples:

- `companies`
- `agents`
- `issues`
- `projects`
- `goals`
- `company_memberships`
- `role_definitions`

These are high-risk because many services and UI flows depend on them.

### Governance and policy

Examples:

- `hierarchy_snapshots`
- `hierarchy_edges`
- `principal_permission_grants`
- approval-related tables

These are risky because they encode rules, not just records.

### Runtime and recovery

Examples:

- `heartbeat_runs`
- `heartbeat_run_events`
- `agent_runtime_state`
- `agent_task_sessions`
- `workspace_runtime_services`
- `agent_wakeup_requests`

These may be easier to regenerate in some cases, but they are tightly tied to execution recovery and observability.

### Logs and event history

Examples:

- `activity_log`
- `cost_events`
- `finance_events`

These are important, but they often have different retention and migration needs from core transactional tables.

### Secrets, plugins, and integrations

Examples:

- `company_secrets`
- `company_secret_versions`
- `plugins`
- `plugin_*`

These are integration-sensitive and can affect operator trust quickly if changed carelessly.

This classification helps you decide which parts can move aggressively and which need staged rollout.

## 3. Preserve The Core Invariants

Any DB revamp needs to protect these repo-level truths unless the product spec is intentionally changing them.

### Company scoping

Many entities must remain company-bound.

If you weaken or remove that pattern, you likely create auth, isolation, and query bugs.

### Control-plane governance

Approval gates, hierarchy rules, role definitions, and budget constraints are not optional side features. They are part of the product model.

### Task execution linkage

Issues, heartbeat runs, workspaces, and runtime services are connected. Breaking those relationships can break task orchestration and recovery.

### Mutation traceability

Activity logs, finance events, and related history tables help explain what happened. That matters in a system coordinating autonomous agents.

## 4. Know What Type Of Revamp You Are Proposing

Different revamps need different rollout styles.

### Logical cleanup

Examples:

- improve naming
- add missing indexes
- normalize a JSON field into a real table

This is often manageable in incremental PRs.

### Structural redesign

Examples:

- split `issues` into multiple workflow tables
- move hierarchy representation to a different model
- redesign role-definition or permissions storage

This usually needs a phased plan, not a one-shot migration.

### Operational redesign

Examples:

- changing how embedded Postgres is managed
- changing backup/restore assumptions
- changing migration journal handling

This is risky because it affects developer ergonomics and safety, not just schema shape.

## 5. Prefer Expand-Contract Over Big Bang

For major changes, the safest pattern is usually:

1. add new structure
2. write both old and new where needed
3. migrate reads
4. backfill existing data
5. verify behavior
6. remove old structure later

This is especially important for:

- column renames
- table splits
- relationship changes
- changes to fields used across server and UI

## 6. Audit The Blast Radius Before Designing

Before changing a core table, audit these layers:

- `packages/db`
- `packages/shared`
- `server/src/routes`
- `server/src/services`
- `ui/src`
- tests
- docs

For central tables like `issues`, `agents`, or `role_definitions`, expect the blast radius to be large.

## 7. Do Not Forget Runtime Consumers

A DB revamp is not only about REST routes and UI screens.

There are runtime consumers too:

- server startup
- background schedulers
- heartbeat execution recovery
- workspace runtime services
- auth bootstrap
- board claim flow
- adapter/runtime integrations that depend on persisted state

If you only audit routes and screens, you will miss some of the highest-risk behavior.

## 8. Migration Strategy Questions

Before approving a revamp, answer these clearly:

1. Can this be done with additive migrations first?
2. Do any current rows need backfill?
3. Are we preserving `__drizzle_migrations` history correctly?
4. Do we need temporary compatibility code in services?
5. Can old data be restored cleanly from backups if rollout fails?
6. Which tables are safe to rebuild, and which are source-of-truth?

## 9. Revamp Checklist

Use this checklist for any serious proposal.

### Design

- define the problem being solved
- list affected tables
- list invariants that must stay true
- decide additive vs breaking rollout

### Migration planning

- sketch schema transitions
- identify backfills
- decide how to handle old reads/writes
- define rollback expectations

### Cross-layer impact

- enumerate shared type changes
- enumerate server service and route changes
- enumerate UI/API changes
- enumerate test fixture updates

### Operations

- confirm how local embedded instances will migrate
- confirm how hosted DBs will migrate
- confirm backup coverage before rollout

## 10. When A Revamp Is Probably Too Large For One PR

Break it up when:

- more than one core table changes shape significantly
- both runtime behavior and business workflow change together
- you need backfill plus API changes plus UI changes
- rollback would be hard to reason about
- migration SQL is doing destructive operations on central tables

In those cases, make a staged plan and land it across multiple PRs.

## 11. A Practical Way To Start A Revamp

If you are just beginning, do this:

1. map the current table group you want to change
2. identify all service/UI consumers
3. write the target shape and the invariants
4. design an expand-contract migration path
5. decide what temporary compatibility code is needed
6. only then start editing schema

That sequence will save a lot of pain.

## 12. Final Advice

The fastest way to create DB pain in this repo is to treat the database like a passive storage box.

It is not passive.

It is one of the main places where Paperclip stores:

- product rules
- execution state
- governance structure
- operational history

A good revamp respects that and moves in stages.
