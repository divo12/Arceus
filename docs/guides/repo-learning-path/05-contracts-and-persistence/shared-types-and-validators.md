# `packages/shared/src/types/*` And `packages/shared/src/validators/*`

This guide explains the two most easily confused parts of `packages/shared`.

If you want one sentence first:

shared types describe system-shaped objects, while validators describe what untrusted runtime input is allowed to enter the system.

## 1. Why These Two Layers Need To Be Separated

At first glance, both types and validators seem to answer the same question:

"What shape does this thing have?"

But they solve different problems.

### Types solve:

- what shape should this object have once the system is already working with it?
- what fields can UI and server both rely on?
- what cross-layer data structures exist in the architecture?

### Validators solve:

- what payloads may enter from HTTP, forms, or external callers?
- what defaults should be inserted at runtime?
- what malformed values should be rejected before services run?

That split is crucial.

If you collapse them mentally, the repo feels inconsistent.

If you keep them separate, the design becomes much clearer.

## 2. How To Read The Type Layer

The types barrel file [`packages/shared/src/types/index.ts`](/Users/divyansh/Arceus/packages/shared/src/types/index.ts) is a contract inventory just like the shared root barrel, but focused specifically on object shapes.

It re-exports many domain families:

- `Agent`, `AgentDetail`, `AgentConfigRevision`
- `Issue`, `IssueComment`, `IssueDocument`
- `HeartbeatRun`, `AgentRuntimeState`, `AgentTaskSession`
- project, goal, budget, approval, plugin, portability, and more

This already tells you that the type layer is modeling both:

- business entities
- runtime/operational entities

## 3. Concrete Example: Agent Types

Look at [`packages/shared/src/types/agent.ts`](/Users/divyansh/Arceus/packages/shared/src/types/agent.ts).

The shared `Agent` interface includes:

- identity fields
- role/delegation fields
- adapter and runtime config
- budget and pause state
- permissions
- timestamps

Then `AgentDetail` extends it with:

- `chainOfCommand`
- `access`

That is a great example of shared types being richer than raw DB rows.

Why?

Because `AgentDetail` is not “the table.”

It is “the full shape the UI/server agree one detailed agent response should have.”

That extra richness usually comes from services enriching base storage records.

## 4. Concrete Example: Issue Types

Look at [`packages/shared/src/types/issue.ts`](/Users/divyansh/Arceus/packages/shared/src/types/issue.ts).

The `Issue` type is much richer than a minimal issue row:

- ancestors
- labels
- plan/document data
- related project and goal
- execution workspace data
- work products
- unread/touch metadata

This teaches an important lesson:

a shared type often models the response shape or domain projection, not only the narrow persisted core.

That is why a single schema file will rarely explain the full shared type by itself.

## 5. Concrete Example: Heartbeat Types

Look at [`packages/shared/src/types/heartbeat.ts`](/Users/divyansh/Arceus/packages/shared/src/types/heartbeat.ts).

You get:

- `HeartbeatRun`
- `HeartbeatRunEvent`
- `AgentRuntimeState`
- `AgentTaskSession`
- `AgentWakeupRequest`

This is a strong reminder that execution/runtime is first-class in the product model.

The type layer is not only about CRUD records like companies and issues.

It also models:

- process traces
- session continuity
- wakeup orchestration
- runtime summaries

## 6. How To Read The Validator Layer

The validators barrel [`packages/shared/src/validators/index.ts`](/Users/divyansh/Arceus/packages/shared/src/validators/index.ts) re-exports many Zod schemas and inferred types.

This layer answers:

- what payload shapes are accepted?
- what defaults are assigned?
- what literal vocabularies are enforced at runtime?
- what nested JSON needs extra validation?

Notice how many route-level operations have their own validator:

- create/update agent
- wake agent
- reset agent session
- create/update issue
- checkout issue
- add issue comment
- budget changes
- hierarchy proposals
- plugin installation

That is the runtime trust boundary layer.

## 7. Concrete Example: Agent Validators

Look at [`packages/shared/src/validators/agent.ts`](/Users/divyansh/Arceus/packages/shared/src/validators/agent.ts).

### What stands out

- `createAgentSchema` uses shared constants like `AGENT_ROLES`, `AGENT_ADAPTER_TYPES`, `DELEGATION_STYLES`
- default values are injected for many fields
- `adapterConfig.env` gets special validation through `envConfigSchema`
- `updateAgentSchema` is not just `createAgentSchema.partial()`

That last point matters.

`updateAgentSchema` explicitly forbids some fields and allows extra ones like:

- `status`
- `spentMonthlyCents`

So validators are not naive mirrors of the shared object type.

They are operation-specific contracts.

## 8. Concrete Example: Issue Validators

Look at [`packages/shared/src/validators/issue.ts`](/Users/divyansh/Arceus/packages/shared/src/validators/issue.ts).

This file shows how execution concerns enter task contracts.

The issue validators include:

- workspace preference
- workspace strategy
- workspace runtime settings
- assignee adapter overrides
- checkout payload rules
- document upsert rules

That tells you issues in Paperclip are not simple tickets.

Their input contracts are shaped by execution and workspace behavior too.

## 9. The Most Important Relationship Between Types And Validators

Types and validators are related, but not symmetrical.

### Shared types often represent:

- full server responses
- enriched domain objects
- stable cross-layer records

### Validators often represent:

- mutation payloads
- partial update shapes
- external input trust boundaries
- defaults and coercion behavior

That is why a type and a validator for the “same feature” may look similar but not identical.

This is correct, not drift.

## 10. Practical Reading Strategy

When you study a feature:

1. open the shared type to understand the full object the app talks about
2. open the validator to understand what input is allowed to create/change that object
3. compare both with the DB schema to understand what is persisted versus enriched

That three-way comparison is one of the best habits you can build in this repo.

## 11. What To Remember

- types model stable shared object shapes
- validators model untrusted runtime input boundaries
- validators often apply defaults and operation-specific restrictions
- shared types are often richer than any one table row
- you usually need both layers to truly understand a feature safely

## Self-Check

- Why is `AgentDetail` richer than the base `Agent` table row?
- Why is `updateAgentSchema` not just the same thing as the `Agent` type?
- What kind of bugs happen if the repo relies only on TypeScript types without runtime validators?
