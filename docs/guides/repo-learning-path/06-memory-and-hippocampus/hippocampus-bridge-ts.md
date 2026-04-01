# `server/src/services/hippocampus-bridge.ts`

This guide explains [`server/src/services/hippocampus-bridge.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-bridge.ts).

If you want the shortest honest summary:

this file defines what “memory” looks like to the rest of the TypeScript server.

## Mental Model

The bridge is the server-facing memory gateway.

The rest of Paperclip does not want to know:

- how the Python runtime is spawned
- how JSON-RPC works
- whether memory is disabled
- which process id is alive

It wants one stable interface that answers:

- can I recall memories?
- can I extract facts?
- can I get priming or habits?
- can I ask for graph views or summaries?

That stable interface is the bridge.

## What This File Owns

This file owns five major things.

### 1. Bridge startup config

It defines the configuration shape needed to initialize Hippocampus:

- mode
- python binary
- startup timeout
- request timeout

### 2. Managed bridge interface

It extends the raw memory contract with process lifecycle methods like:

- `start()`
- `stop()`
- `diagnostics()`

That is what makes this a managed subsystem instead of only a pure API interface.

### 3. Disabled vs embedded bridge implementations

This file provides two concrete bridge modes:

- `DisabledHippocampusBridge`
- `EmbeddedHippocampusBridge`

### 4. Delegation context assembly

This file owns `buildDelegationContext(...)`, which formats delegation-related memory into markdown context.

### 5. Global lifecycle and service registration

This file owns the process-wide bridge instance and the logic that initializes or resets higher-level memory services.

## Why The Disabled Bridge Is A Real Class

This is one of the best design decisions in the file.

Instead of making “memory off” mean:

- `null`
- or `undefined`
- or lots of `if (memoryEnabled)` checks all over the codebase

the file provides a real disabled implementation.

That implementation:

- has mode `off`
- no-ops on `start()` and `stop()`
- returns `null` diagnostics
- throws `HippocampusDisabledError` for memory operations

This is great because the rest of the code can still hold “a bridge.”

It does not need special handling everywhere.

The bridge object exists in both modes.
Only its behavior changes.

## `ManagedHippocampusBridge`

This interface tells you what the rest of the server really expects from the bridge.

It expects both:

- memory operations from `HippocampusBridge`
- lifecycle/diagnostics behavior from the managed extension

That means the bridge is not just a set of memory functions.
It is the server’s managed handle to the memory subsystem.

## `buildDelegationContext(...)`

This helper is small but important.

It builds delegatee-facing markdown context using:

- the delegator’s priming prompt
- the delegator’s listed memories
- relationship bias toward memories mentioning the delegatee id

Then it formats that into sections like:

- `## Delegation Context For ...`

This is a very Paperclip-specific layer.

Hippocampus itself provides primitive memory operations.
Paperclip shapes some of those primitives into execution-ready context.

That is why this helper lives here, not in the raw runtime manager.

## `EmbeddedHippocampusBridge`

This class is the concrete adapter from TypeScript calls into the runtime manager.

Its job is not to invent memory semantics.
Its job is to translate method calls into runtime RPC calls.

Examples:

### `remember(...)`

Calls runtime method `remember` with:

- `agent_id`
- `content`
- `container`
- `memory_type`

### `recall(...)`

Calls runtime method `recall` with:

- `agent_id`
- `query`
- `container`
- `top_k`
- `include_graph: true`

### `extract(...)`

Calls runtime method `extract` with:

- `agent_id`
- `messages`
- `container`
- `mode: "agent"`

### `processTrajectory(...)`

Calls runtime method `processTrajectory` with:

- agent id
- task id
- outcome
- quality
- steps
- container

### Other methods

The class also forwards:

- `getPriming`
- `getHabits`
- `getSummary`
- `listMemories`
- graph search / neighbor / edge / history calls
- `runGC`
- `runPromotions`

So this class is very much a translator.

## What The Bridge Does Not Do

The bridge does not:

- spawn Python itself
- manage stdout parsing directly
- implement restart backoff
- make heartbeat decisions
- choose when memory should be used

Those jobs live elsewhere:

- runtime manager for process transport
- heartbeat and memory-lifecycle for usage timing

## Global Bridge State

This file has a global variable:

`hippocampusBridge`

That matters a lot.

It means memory is treated as a process-level subsystem, not a per-request object and not a per-agent object.

That makes sense because:

- the embedded runtime is a server-managed process
- memory helper services are shared across the backend

So when code calls `getHippocampusBridge()`, it is getting the current process-wide memory gateway.

## `initializeHippocampusBridge(...)`

This is one of the most important functions in the file.

It does three big things.

### Step 1: shut down any existing bridge

This prevents stale bridge/runtime state from lingering.

### Step 2: branch on mode

If mode is `off`:

- install the disabled bridge
- reset higher-level memory services

If mode is `embedded`:

- create the runtime manager
- create the embedded bridge
- start the bridge
- initialize higher-level memory services

### Step 3: register helper services

When memory is enabled, the file calls `initializeMemoryServices(hippocampusBridge)`.

That builds helper layers like:

- scope service
- projection service
- profile service
- delegation service

This is important because the bridge is the base primitive layer, but the route surface also depends on richer helper services.

## `shutdownHippocampusBridge(...)`

Shutdown is clean and deliberate.

It:

1. stops the current bridge
2. installs a new disabled bridge
3. resets higher-level memory services

That means “shutdown” is not just “kill the process.”

It also repairs the in-process TypeScript world so nobody accidentally keeps using stale helper objects.

## Test Helpers

The file also exports:

- `setHippocampusBridgeForTests(...)`
- `resetHippocampusBridgeForTests()`

These are useful because memory code often needs stable fake bridges in tests.

They also reinforce the design:

the rest of the system depends on the bridge abstraction, not on direct process management.

## Technical Thinking

The deepest design idea in this file is interface discipline.

Paperclip does not want every service or route poking the Python runtime directly.

So it creates a deliberate sequence:

1. contract defines the shape
2. bridge implements the TypeScript-facing semantics
3. runtime manager handles process transport underneath

That layering makes the subsystem easier to:

- reason about
- swap between enabled/disabled mode
- test
- diagnose

## Self-Check

You understand this file if you can answer:

1. Why is the disabled bridge a real implementation instead of `null`?
2. What is the difference between `EmbeddedHippocampusBridge` and `HippocampusRuntimeManager`?
3. Why is delegation context assembled in the bridge layer instead of the runtime manager?
4. Why does bridge initialization also initialize higher-level memory services?
5. What does the global `hippocampusBridge` variable tell you about how memory is treated inside the server?
