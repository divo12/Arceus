# `server/src/routes/memory.ts`

This guide explains [`server/src/routes/memory.ts`](/Users/divyansh/Arceus/server/src/routes/memory.ts).

This file is the HTTP surface for the memory subsystem.

If you want one sentence first:

it exposes memory mostly as an operator-facing control/debug/maintenance API rather than as a general public application API.

## Mental Model

This file is not where memory semantics live.

It is where the server:

- checks access
- validates input
- decides which helper service to call
- translates memory errors into HTTP responses
- publishes live events for memory maintenance actions

So it is best read as an integration and control surface, not as the place where memory logic is invented.

## What This File Owns

It owns five kinds of responsibility.

### 1. Memory enabled/disabled gating

It decides whether memory routes are usable in the current config mode.

### 2. Error translation

It turns memory-specific failures into consistent HTTP responses.

### 3. Bridge surface access

For simpler operations, it forwards directly to the bridge.

### 4. Helper-service routing

For richer operations, it resolves higher-level services like:

- `MemoryScopeService`
- `MemoryProjectionService`
- `ProfileService`
- `DelegationMemoryService`

### 5. Live event publication

For operations like GC and promotions, it emits company-scoped live events.

## The First Thing To Notice: This Surface Is Mostly Board-Oriented

Most routes begin with:

`assertBoard(req)`

That is a very strong product signal.

Memory is currently treated mostly as:

- operator tooling
- board insight
- debugging and maintenance surface

not as a general end-user API.

This makes sense because memory is powerful and easy to misuse.

The system is keeping it behind a more privileged operational surface.

## One Exception: Health Shape

Most per-agent memory routes are board-only.

But the `/memory/health` route is a different kind of endpoint.

It is not asking about one agent’s private memory contents.
It is asking whether the subsystem itself is healthy.

That is an operational concern.

## Enabled/Disabled Gating

The route file resolves Hippocampus mode and defines `ensureEnabled(...)`.

If mode is `off`, many endpoints return `503`.

That means route callers do not need to guess from lower-level transport errors whether memory is configured off.

The route layer exposes that clearly.

## `handleMemoryError(...)`

This helper is more important than it first looks.

It distinguishes among:

- `MemoryServiceError`
- `HippocampusDisabledError`
- `ZodError`
- unexpected failures

That means the memory subsystem has its own error vocabulary instead of being flattened into generic 500s.

This is one sign the subsystem has matured beyond “just call some helper.”

## Helper Service Resolution

The file resolves higher-level helper services through `getMemoryServices()`.

If they are not already registered, it falls back to constructing them directly from the current bridge.

That is very useful to notice because it tells you:

- the bridge is the primitive layer
- helper services are optional enrichments built on top

Those helper layers include:

### `MemoryScopeService`

For scoped recall and shareable-memory views.

### `MemoryProjectionService`

For graph view, explorer, promotion projection, and version history.

### `ProfileService`

For generated memory-backed employee profiles.

### `DelegationMemoryService`

For delegation-specific transfer and internalization flows.

## Route Families

The best way to understand this file is by grouping routes by purpose.

### 1. Raw bridge routes

These are the thinnest routes.

They mostly proxy directly to the bridge:

- summary
- list
- priming
- habits
- remember
- recall

These tell you what the basic memory primitive surface looks like.

### 2. Extraction route

`extract-meeting` is interesting because it turns one transcript into extraction calls for multiple participants.

That means memory can be populated from shared meeting context, not only from heartbeat run output.

### 3. Scoped memory routes

These use `MemoryScopeService`:

- `scoped-recall`
- `shareable`

This tells you the product has moved beyond one flat “recall” API.
It understands that memory visibility and scope matter.

### 4. Higher-level projection routes

These use `MemoryProjectionService`:

- `graph`
- `explorer`
- `promotions`
- version history

These are read-model routes.

They are not asking Hippocampus only for raw memory items.
They are asking for richer views over memory state.

### 5. Profile route

The `profile` route uses `ProfileService` to synthesize a structured employee profile from:

- static memories
- dynamic memories
- habits
- priming

This is a nice example of taking raw memory primitives and shaping them into something product-level.

### 6. Delegation routes

These use `DelegationMemoryService`:

- `delegate`
- `internalize-delegation`

That is a specialized operational surface for memory transfer during work handoff.

### 7. Maintenance routes

These include:

- `gc`
- `promotions`
- health

These are clearly control-plane/operator actions, not everyday agent behavior.

## A Few Important Real-Code Details

There are some subtle truths in this file worth noticing.

### `extract-meeting`

This route does not create one shared memory record and point everyone at it.

Instead it runs `extract(...)` for each participant.

So meeting extraction is participant-oriented, not just meeting-oriented.

### `delegate`

This route returns `207` when some copies failed and some succeeded.

That is a nice signal that delegation transfer is intentionally partial-success aware.

### `promotions` GET vs POST

The read-style promotions route comes from `MemoryProjectionService`, whose current implementation synthesizes promotion events from `runPromotions(...)`.

So this is not necessarily a durable historical audit table.
It is a projection over current promotion behavior.

That is an important detail if you are expecting immutable audit semantics.

### GC and promotion live events

The route publishes company-scoped live events after maintenance actions.

That means the memory subsystem is tied into the same operator-observability story as the rest of the control plane.

## Why This File Matters

This route file is the clearest map of the memory product surface today.

It shows that memory in this repo is not only:

- remember
- recall

It also includes:

- scoped retrieval
- shareability filtering
- profile generation
- graph exploration
- delegation transfer
- meeting extraction
- promotions and GC maintenance

That is a much richer subsystem than a flat memory API.

## Technical Thinking

The deepest lesson in this file is that a mature subsystem usually grows helper layers on top of primitives.

The bridge gives raw operations.

The helper services give:

- scope logic
- projections
- profiles
- delegation workflows

And the routes expose all of that as a controlled operator surface.

That is a very normal and healthy evolution for a subsystem that started from lower-level primitives.

## Self-Check

You understand this file if you can answer:

1. Why are most memory routes board-only?
2. Which routes are thin bridge proxies and which use higher-level services?
3. Why is `207` used for delegation copy partial success?
4. Why do GC and promotion routes publish live events?
5. What does this route surface tell you about how mature the memory subsystem has become?
