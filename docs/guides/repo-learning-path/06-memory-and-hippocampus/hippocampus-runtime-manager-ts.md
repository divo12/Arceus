# `server/src/services/hippocampus-runtime-manager.ts`

This guide explains [`server/src/services/hippocampus-runtime-manager.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-runtime-manager.ts).

If the bridge is “what memory looks like to the server,” the runtime manager is “how the embedded memory process is actually kept alive.”

## Mental Model

This file is the embedded Hippocampus process manager and RPC transport.

It is responsible for all the low-level operational facts the rest of the memory system does not want to think about:

- how to spawn Python
- how to speak JSON-RPC over stdio
- how to match responses to requests
- how to time out stuck requests
- how to stop cleanly
- how to restart after crashes

So this file is not about memory meaning.
It is about runtime reliability.

## What This File Owns

It owns six major responsibilities.

### 1. Default launch configuration

It knows how to launch the embedded Python memory runtime by default.

### 2. Runtime status tracking

It tracks statuses like:

- `stopped`
- `starting`
- `running`
- `stopping`
- `crashed`
- `backoff`

### 3. JSON-RPC request/response transport

It serializes requests, writes them to stdin, parses stdout lines, and resolves pending promises.

### 4. Timeout handling

It prevents the server from waiting forever on broken or stuck memory requests.

### 5. Crash and restart behavior

It tracks crash history and applies restart backoff.

### 6. Diagnostics

It exposes operational details the rest of the server can inspect.

## `resolveDefaultHippocampusRuntimeOptions(...)`

This function already tells you a lot about the architecture.

It resolves the default embedded runtime launch shape as:

- configured Python binary
- module `arceus.core.hippocampus.stdio_rpc`
- cwd inside `services/hippocampus-runtime/python`
- `PYTHONPATH` extended to include the runtime `src` directory

This means the server is not speaking HTTP to Hippocampus.

It is launching a local Python module and communicating over stdio.

That is an important architectural fact.

## The Status Model

The manager tracks a real lifecycle, not just a boolean “up or down.”

Those statuses matter because different callers need to know different things:

- `starting` means the child exists but is not ready yet
- `running` means health passed and requests may proceed
- `stopping` means shutdown is in progress
- `crashed` means the child died unexpectedly
- `backoff` means restart is delayed on purpose

This is more honest than pretending process management is always instant and binary.

## `start()`

The public `start()` method is mostly about coordination.

It avoids duplicate work by checking:

- already running
- start already in progress
- restart already in progress

Then it delegates to `startInternal()`.

This is a good concurrency guard because several parts of the server might try to use memory around the same time.

## `startInternal()`: Real Startup

This is the true startup path.

It does much more than “call `spawn()`.”

### Step 1: reset startup state

It clears restart timers, resets intentional-stop state, clears stderr excerpt, and marks status `starting`.

### Step 2: spawn the child process

It launches the configured Python command with:

- cwd
- env
- stdio pipes

### Step 3: set up stdout/stderr readers

It uses readline interfaces to consume:

- stdout as JSON-RPC response lines
- stderr as diagnostic text

Stderr lines are accumulated into a bounded excerpt.

That excerpt becomes very important when failures happen.

### Step 4: install process event handlers

It listens for:

- `error`
- `exit`

and rejects pending requests appropriately if the process becomes unavailable.

### Step 5: require a health handshake

This is one of the best parts of the file.

The manager does not consider the runtime ready just because the process exists.

It sends a `health` RPC and waits for success before marking status `running`.

That means startup readiness is semantic, not just process-level.

In plain language:

“Python started” is not enough.
“Python answered a health call correctly” is the real readiness condition.

## `call(...)`: The Most Important Method

This is the central transport boundary.

Everything interesting the bridge asks Hippocampus to do eventually becomes a call through this method.

### What it does

It:

1. ensures the runtime is ready unless the caller explicitly allows startup-time calls
2. checks that stdin is writable
3. allocates a request id
4. builds a JSON-RPC request object
5. stores a pending request record with:
   - resolve
   - reject
   - timeout timer
6. writes the serialized request to child stdin

Then it waits for `handleStdoutLine(...)` to match a response back to that request id.

### Why pending maps matter

Because many requests can be in flight at once.

Without a request id map, the manager could not reliably answer:

- which response belongs to which call?
- which promise should resolve?
- which timeout should be cleared?

This is a standard RPC problem, and this file solves it explicitly.

## `ensureReady()`

This method explains the runtime philosophy well.

If status is:

- `running` -> proceed
- `starting` -> wait for startup promise
- `stopped` or `crashed` -> try starting
- `backoff` -> wait for restart promise
- `stopping` -> unavailable

So the manager tries to be helpful and self-healing, not merely passive.

## `handleStdoutLine(...)`

This is the response parser.

It:

- ignores empty lines
- tries to parse JSON
- validates that the message is a Hippocampus JSON-RPC response
- finds the matching pending request
- clears the timeout
- resolves or rejects the right promise

If the response contains an error, it wraps that as `HippocampusUnavailableError` with stderr excerpt attached when useful.

So stdout is treated as the machine-readable RPC channel.

## Stderr Excerpts

The file keeps only a bounded trailing stderr excerpt.

That seems like a small implementation detail, but it is operationally very smart.

It gives the server:

- useful failure context
- without unbounded memory growth

Then `formatRuntimeFailureMessage(...)` can splice that excerpt into error messages.

This makes failures much easier to understand from the TypeScript side.

## `stop()`: Graceful Shutdown First

Shutdown happens in layers.

### Step 1: stop restart behavior

It clears restart timers and marks the stop as intentional.

### Step 2: try RPC shutdown

It asks the runtime to shut down politely through RPC.

### Step 3: wait for clean exit

If it does not exit during the shutdown drain window, the manager escalates.

### Step 4: send `SIGTERM`

If needed, it sends `SIGTERM` and waits again.

### Step 5: send `SIGKILL`

If the process still refuses to die, it is force-killed.

This is exactly what a responsible embedded-process manager should do:

- ask nicely
- wait
- escalate only when needed

## `handleExit(...)`: Crash Logic

When the child exits, this method does all cleanup and crash accounting.

It:

- closes readline interfaces
- clears child references
- resolves the exit promise
- rejects all pending requests

Then it branches based on whether the stop was intentional.

### If intentional

- status becomes `stopped`
- no restart is scheduled

### If unintentional

- total crashes increments
- consecutive crashes are tracked within a crash window
- status becomes `crashed`

Then, if auto-restart is still allowed, it schedules a delayed restart and moves status to `backoff`.

## Restart Backoff

The manager uses restart backoff values like:

- 1s
- 2s
- 4s
- 8s
- 16s
- 30s

This prevents crash loops from thrashing the server.

It also enforces a maximum consecutive crash threshold.

That means:

the server tries to self-heal, but not forever and not irresponsibly.

## Diagnostics

`diagnostics()` returns a structured operational snapshot including:

- mode
- status
- pid
- pending request count
- consecutive crashes
- total crashes
- last crash time
- next restart time
- stderr excerpt

This is extremely useful because memory failures are otherwise very easy to hand-wave as “some Python thing broke.”

This file makes that subsystem inspectable.

## What This File Does Not Decide

This file does not decide:

- when memory should be used for a run
- how memory context is formatted for agents
- which routes exist
- how scoped recall or profiles work

Those live in:

- bridge
- memory-lifecycle
- scope/projection/profile helper services
- routes

This file is only the transport and lifecycle manager.

## Technical Thinking

The deepest lesson in this file is that embedded AI subsystems should be treated like real infrastructure.

This repo does not pretend memory is just a library import.

It treats memory as:

- a separate process
- with readiness
- with request multiplexing
- with timeouts
- with graceful shutdown
- with crash recovery
- with diagnostics

That is a much more production-minded integration model.

## Self-Check

You understand this file if you can explain:

1. Why does startup wait for a `health` RPC instead of trusting `spawn()` alone?
2. Why does `call(...)` need request ids, pending maps, and timeout timers?
3. Why does the manager preserve stderr excerpts?
4. What is the difference between `crashed` and `backoff`?
5. Which responsibilities belong here, and which belong in the bridge?
