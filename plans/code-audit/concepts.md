# Cluster Concepts — Software Engineering Primer

Companion to [clusters.md](./clusters.md). This doc explains the **underlying CS concept** for each cluster — what it is, why systems need it, and what goes wrong without it. Read this if the audit talks about "CAS" or "TOCTOU" and you want to know what that means in general, not just in this codebase.

Each section follows the same shape:
1. **The concept** — plain definition
2. **Why systems need it** — what breaks without it
3. **Canonical symptoms** — how the bug presents in production
4. **The fix pattern** — the generic primitive that solves the class

---

## Table of contents

| | Concept | One-line definition |
|---|---|---|
| C1 | [Compare-and-Swap](#c1--compare-and-swap-cas--optimistic-concurrency) | Atomic read-compare-write; reject stale writes |
| C2 | [Error handling discipline](#c2--error-handling-discipline) | The contract between `try` and `catch` |
| C3 | [Fire-and-forget / unawaited promises](#c3--fire-and-forget--unawaited-promises) | Async work whose completion nobody tracks |
| C4 | [Least privilege / defense in depth](#c4--least-privilege--defense-in-depth) | Don't give a layer more power than it needs |
| C5 | [Trust boundaries & injection](#c5--trust-boundaries--injection) | Where data becomes code |
| C6 | [TOCTOU & async interleaving](#c6--toctou--async-interleaving) | State changes between check and use |
| C7 | [Cooperative cancellation](#c7--cooperative-cancellation) | How to stop work that's already running |
| C8 | [Transactions / atomicity](#c8--transactions--atomicity) | All-or-nothing semantics |
| C9 | [Bounded resources / backpressure](#c9--bounded-resources--backpressure) | Every buffer must have a lid |
| C10 | [Algorithmic complexity](#c10--algorithmic-complexity) | How cost scales with data |
| C11 | [Making illegal states unrepresentable](#c11--making-illegal-states-unrepresentable) | Types as correctness proofs |
| C12 | [Type-safety at boundaries](#c12--type-safety-at-boundaries) | `any` is an unchecked assertion |
| C13 | [REST resource modeling](#c13--rest-resource-modeling) | HTTP verbs mean something |
| C14 | [Cohesion, coupling, SRP](#c14--cohesion-coupling-and-the-single-responsibility-principle) | Why big files cost more than big brains |
| C15 | [Observability](#c15--observability) | Successes need a trail too |
| C16 | [Code as liability](#c16--code-as-liability) | Every line is maintenance surface |
| C17 | [Named values / configuration](#c17--named-values--configuration) | Magic numbers vs named constants |
| C18 | [Database layer](#c18--database-layer) | Schemas, migrations, indexes, FKs, pooling |

---

## C1 · Compare-and-Swap (CAS) / optimistic concurrency

### The concept
**CAS** is an atomic operation that does three things as one indivisible step:
1. Read the current value
2. Compare it to the value you expected
3. Write the new value *only if* they still match

If someone changed the value between your read and your write, CAS fails. You're told "stale" and must re-read and retry. The database equivalent is `UPDATE t SET x = $new WHERE id = $id AND version = $expected` — if zero rows are affected, someone beat you.

CAS is the primitive behind **optimistic concurrency control**: let writes proceed in parallel, catch conflicts at commit, retry the losers. The opposite is **last-writer-wins (LWW)** — just overwrite — which silently loses updates.

### Why systems need it
Any system where two actors can touch the same record concurrently needs *some* concurrency control. The options are:
- **Pessimistic locks** (`SELECT … FOR UPDATE`) — safe but slow, deadlock-prone
- **Serial execution** — correct but doesn't scale
- **CRDTs** — concurrent writes merge mathematically; powerful but restrictive
- **CAS** — best default for business systems: no locking, no waiting, no silent overwrite

### Canonical symptoms without it
- **Lost updates** — Alice +$50 and Bob +$30 on the same balance both land; one amount vanishes
- **Write skew** — each transaction individually valid, together violate an invariant
- **Duplicate side effects** — same payment processed twice, same email sent twice
- **Cache-DB divergence** — two writers both update the in-memory view, the second write's cache is what sticks, DB state is inconsistent
- **"Reconciliation scripts become a feature"** — nightly jobs comparing sources because they drift

### The fix pattern
```
1. Every mutable row has a `version` column.
2. Every read returns the version.
3. Every write includes WHERE version = $expected.
4. 0 rows affected → someone beat you; re-read, re-decide, retry (bounded).
5. Multi-row ops wrap in a transaction with the same pattern.
```

---

## C2 · Error handling discipline

### The concept
`try/catch` creates a contract: **if you catch an error, you assume responsibility for handling it.** Handling means one of three things:
1. **Recover** — the error was expected, you have a fallback
2. **Transform** — wrap it in a higher-level error and re-throw
3. **Record** — log it to a durable sink *and* surface it somehow (metric, audit, retry queue)

What's *not* handling: `.catch(() => {})`, `catch {}`, `catch(e) { console.log(e) }`. Those are **error-swallowing** — the caller believes the operation succeeded when it didn't.

### Why systems need it
An unhandled exception is loud — it crashes, it gets logged, ops see it. A swallowed exception is silent: the operation looks successful, the system continues, state drifts. The worst bugs are silent ones because they compound before anyone notices.

There's a rule: **never catch what you can't handle.** If you don't have a fallback and don't want to propagate, you shouldn't be catching.

### Canonical symptoms without it
- Data in the cache doesn't match the DB, and nobody knows when it diverged
- Ghost records: row written with partial state because a downstream write silently failed
- "The job ran but nothing happened" — the job caught its own failure and returned success
- Transient DB/network outages are invisible in metrics — the errors were swallowed before they could be counted
- Bug reports that look like "impossible state" because state transitions happened out of order

### The fix pattern
```
1. Default to NOT catching. Let errors propagate until someone can handle them.
2. When you must catch, route to a sink: audit ledger, error counter, DLQ.
3. Bare .catch(() => {}) is a lint error. Every catch must do one of {recover, rethrow, record}.
4. Log errors with structured context, not console.log.
```

---

## C3 · Fire-and-forget / unawaited promises

### The concept
A promise represents an async operation. **Awaiting** the promise means your code waits for completion and receives the result (or the error). **Not awaiting** it — `void doWork()`, `doWork().catch(...)` with no await, launching a promise without keeping the reference — means the work runs in the background, and the caller moves on immediately.

Fire-and-forget is sometimes correct: a metric emit you don't care about, a best-effort cleanup. It's dangerous when:
- The work is important (a pipeline, a transactional side effect)
- Failures need retry, alerting, or user feedback
- Order matters (subsequent code assumes it completed)

### Why systems need discipline
An unawaited promise is a **dangling commitment**. If the process shuts down, the work may not finish. If it fails, the error has nowhere to go. Node.js even prints a warning for unhandled rejections because it's such a common footgun.

A related hazard: **work that outlives its caller.** Serverless functions terminate when the handler returns; fire-and-forget work gets killed mid-flight. Long-lived servers leak them into obscurity.

### Canonical symptoms
- "The pipeline ran but we don't know the outcome"
- Retry queues that are only ever added to, never drained
- The UI says "done" before the backend actually finished
- Process shutdown leaves zombie work
- Error logs show stack traces with no context (because the originator already returned)

### The fix pattern
- Every important async operation is either **awaited** or **enqueued in a durable job queue** with retry metadata
- Background work gets a supervisor — a tracker that knows it's running, can log its completion, and can time it out
- Use `AbortController` to actually kill fire-and-forget work on shutdown
- Lint rule: no naked `void promise`

---

## C4 · Least privilege / defense in depth

### The concept
**Least privilege** — each component gets the minimum access it needs, nothing more.
**Defense in depth** — no single control is enough; failures at one layer are caught at the next.

In web systems, the layers are typically:
1. **Network** — who can reach the endpoint at all
2. **Authentication** — who are you
3. **Authorization** — what are you allowed to do
4. **Input validation** — is this request well-formed
5. **Runtime privileges** — can this code even perform this action (sandboxing, capability checks)
6. **Data access** — scoped to the caller's ownership

A good system has *all* of these. A bad system relies on one. When one fails (and one always eventually fails), the rest should catch it.

### Why systems need it
Security isn't a feature — it's a posture. The moment an application exposes a mutation endpoint without authentication, it's vulnerable regardless of how well the business logic is written. The moment an agent has unrestricted tool access, a single prompt injection becomes RCE. Layers buy you time to detect and respond.

A related concept: the **confused deputy problem.** A privileged component (like a server process) performs an action on behalf of a less-privileged caller, forgetting to check whether the caller was allowed to request it. "I'm running with admin rights, but I'm doing it for the user — should I check the user's rights first?" If you don't, you're a confused deputy.

### Canonical symptoms
- "Anyone with the URL can reset the database"
- Admin panels exposed on the same port as public traffic
- Debug endpoints live in production
- Error messages leak internal paths, SQL, or stack traces (gives attackers reconnaissance)
- A single compromised component = full system compromise (no blast-radius containment)

### The fix pattern
- Authentication on every mutation (HTTP verb + auth middleware, not opt-in)
- Authorization *inside* the handler (ownership checks, role checks — the confused deputy antidote)
- Separate production surface from debug surface (different ports, different auth)
- Rate limits even on authenticated endpoints
- Feature flags default to **off** for dangerous capabilities, not on

---

## C5 · Trust boundaries & injection

### The concept
A **trust boundary** is any place where data crosses from a less-trusted source to a more-trusted interpreter. Examples:
- User's HTTP body → your application code
- LLM output → your shell / DB / file system
- Third-party API response → your internal cache

**Injection** is what happens when you build a string on one side of the boundary and let the interpreter on the other side parse it without escape semantics. The interpreter can't tell **data** from **instructions**.

Canonical forms:
- **Shell injection** — `exec("ls " + user)` where user is `; rm -rf /`
- **SQL injection** — concatenated queries
- **Template injection** — template engines that eval expressions in user input
- **Prompt injection** — untrusted text in an LLM system prompt
- **Deserialization** — parsing untrusted JSON/YAML/pickle that invokes constructors

**RCE (remote code execution)** is the worst outcome: the attacker runs code in your process. Once they have it, they have everything the process has.

### Why systems need boundaries
Your trust assumptions get stale as the system grows. The CEO agent was "internal" yesterday; today its output influences a shell command. The LLM was "helpful" yesterday; today it's writing SQL. Every interpretive layer (shell, SQL engine, templating, LLM) must treat external strings as **data only**, never as programs.

### Canonical symptoms
- Error messages contain file paths, stack traces, DB strings (reconnaissance for attackers)
- User input round-trips through a shell command (`exec(userInput)`)
- String-concatenated SQL queries (`"WHERE name = '" + name + "'"`)
- LLM prompt built from `systemPrompt + "\n" + user_message` with no escape
- "We sanitize with a regex" — regex-based sanitization is almost always incomplete

### The fix pattern
- **Structured primitives instead of string concatenation:** parameterized SQL, `spawn(argv, {shell:false})`, templating engines with autoescape
- **Validate once at the boundary** (Zod, JSON Schema)
- **Least-privilege interpreters** — the shell that executes skill content shouldn't be able to read env vars; the DB role should only have CRUD on specific tables
- **Generic error responses with correlation IDs** — don't give attackers reconnaissance
- **Assume the LLM is adversarial** in any path where its output becomes code

---

## C6 · TOCTOU & async interleaving

### The concept
**TOCTOU** — Time-Of-Check To Time-Of-Use. A bug where state changes between the moment you check it and the moment you act on it.

```
if (balance >= 100) {     // time of check
  await someIO();
  withdraw(100);          // time of use — balance may have changed
}
```

In single-threaded languages (Node.js, Python asyncio), TOCTOU is common **because of `await`**. Every await is a yield point where another promise chain can run. "Single-threaded" means one call stack at a time, not "no interleaving."

A related concept: **race condition** — any bug whose outcome depends on the timing of concurrent operations. TOCTOU is a specific kind.

### Why systems need protection
The intuition "my code isn't multi-threaded so I don't have races" is wrong in async environments. You have cooperative interleaving, which is almost as dangerous as preemptive threading for correctness — just easier to reason about locally.

Global mutable state makes it worse: two async functions can both read, both decide, both write, and the second write wins with no error.

### Canonical symptoms
- Duplicate actions: two requests both see `status === "pending"`, both mark it complete, both side-effect
- Lost flags: `if (!inFlight) { inFlight = true; do(); }` — two invocations both see `inFlight = false`
- Idempotency holes: "we check before creating, why are there duplicates?"
- Bugs that only appear under load
- Bugs that go away when you add a `setTimeout` (revealing the timing dependency)

### The fix pattern
- Encapsulate state in an object with locks or CAS methods, never raw module-level `let`
- Use a semaphore / mutex for "only one at a time" semantics
- For idempotency, back the check with a DB-level uniqueness constraint — the check is advisory, the constraint is the truth
- When in doubt, make operations atomic at the DB (CAS) rather than in application code

---

## C7 · Cooperative cancellation

### The concept
When you want to stop work that's already running — on user abort, on timeout, on shutdown — you need a way to *ask* the work to stop. Operating-system threads can be forcibly killed, but that leaves resources in weird states. Modern systems use **cooperative cancellation**: the work checks a token and decides to stop gracefully.

The standard primitive in JS is `AbortSignal`, in Go it's `context.Context`, in .NET it's `CancellationToken`. They all have the same shape: a token gets threaded through every layer of the call stack; each layer either polls it at checkpoints or passes it to cancellable operations (fetch, DB queries, child processes).

**Structured concurrency** extends this: child tasks inherit their parent's cancellation. Cancel the parent and all children cancel too.

### Why systems need it
Without cancellation:
- A hung LLM call or slow DB query blocks a request forever
- Graceful shutdown takes 30+ seconds (or never happens)
- Orphan child processes accumulate after restarts
- Users clicking "cancel" on the UI does nothing until the work naturally finishes
- Timeouts can fire, but the underlying work keeps running and eventually lands anyway (causing effects the user thought they cancelled)

Related concept: **crash recovery / stranded work.** A process crash leaves long-running work in an unknown state. You need a sweeper that detects stranded operations (via a heartbeat column, PID check, timeout) and either resumes or cancels them.

### Canonical symptoms
- `SIGTERM` followed by a forced-kill after 30s because the process won't exit
- `ps` shows orphan child processes
- UI cancellation buttons don't actually cancel
- "The job timed out but then completed anyway and caused problems"
- No way to bound worst-case response time

### The fix pattern
- Accept `AbortSignal` at every entry point that does I/O
- Pass it down through every layer — fetch, child-process spawn, DB query
- Check `signal.aborted` at loop iterations
- On shutdown, call `controller.abort()` and wait with a bounded join
- Have a supervisor that tracks in-flight work and can force-kill strays

---

## C8 · Transactions / atomicity

### The concept
A **transaction** is a group of operations that either **all succeed or all fail** — never partial. This is the "A" in **ACID**: Atomicity. The other three:
- **Consistency** — transactions move the system between valid states
- **Isolation** — concurrent transactions don't observe each other's partial work
- **Durability** — once committed, changes survive crashes

Outside a database, the same idea is called **unit of work** — a logical operation is a single commit. Either the whole thing lands or none of it does.

### Why systems need it
Almost every business operation is multi-step: "mark task complete" is really "update status + append artifact + update trust + emit audit event." If those are four separate writes and the process crashes between #2 and #3, you have a task marked complete with no trust update — state that shouldn't exist. Without atomicity, crashes produce **invalid states**, and invalid states cascade.

A special case: **the dual-write problem.** Writing to two systems (DB + message queue, DB + cache) is never atomic without a coordinator. You get outbox patterns, change-data-capture, or two-phase commit to fix it.

### Canonical symptoms
- "The order exists but has no line items" (insert succeeded, inserts into children failed)
- Cache and DB disagree because one write succeeded and the other didn't
- Cleanup scripts that find orphan rows and delete them nightly
- "Half-completed workflows" after a crash
- Race conditions between services because they write to their own DBs independently

### The fix pattern
- Every logical operation = single transaction, single commit point
- Never span a transaction across an async network call (hold the DB lock too long = deadlock)
- For cross-service consistency, use an outbox: write to DB + outbox table atomically; a separate worker drains the outbox to other systems at-least-once
- Compensating actions for operations that genuinely can't be atomic (book flight, charge card — if charge fails, book cancellation)

---

## C9 · Bounded resources / backpressure

### The concept
Every finite resource — memory, file descriptors, connections, threads — must have a **bound**. Code that appends to a list forever will eventually run out of memory. Code that opens a connection per request without closing them will exhaust the kernel's file-descriptor table.

**Backpressure** is how producers are told "slow down" when consumers can't keep up. Without it, a fast producer fills the queue until OOM. With it, the producer either blocks, drops, or signals upstream to throttle.

Related primitives:
- **Ring buffers** — fixed-size append; oldest entries drop off
- **Bounded queues** — `send` blocks (or rejects) when full
- **Connection pools** — cap on concurrent connections
- **Rate limits** — cap on requests per unit time

### Why systems need bounds
Unbounded resources work fine in development and during the first week in production, then fail catastrophically. The OOM killer terminates the process; file descriptors exhaust and new connections fail with cryptic errors; thread pools block every incoming request.

Related: **pagination** on list endpoints. An endpoint that returns "all records" is unbounded by design. As data grows, it becomes first slow, then costly, then OOM.

### Canonical symptoms
- Memory usage grows linearly with uptime
- Process restart every N days "to clear a leak"
- "EMFILE: too many open files"
- Slow queries on a list endpoint that used to be fast
- The dashboard that was snappy at 100 users is 30s-to-load at 10k

### The fix pattern
- Every in-memory collection has a max size and an eviction policy (LRU, ring buffer, timed expiry)
- Every queue has a bound; producers handle the `full` case
- Every list endpoint paginates; no "return everything"
- Connection pools sized for steady-state load
- Profile memory under realistic load before you ship

---

## C10 · Algorithmic complexity

### The concept
**Big-O** describes how cost scales with input size.
- **O(1)** — constant: hash lookup
- **O(log n)** — logarithmic: binary search
- **O(n)** — linear: scan a list
- **O(n log n)** — sorted merge
- **O(n²)** — nested loop over the same collection (filter-then-find, compare-all-pairs)
- **O(n³), O(2ⁿ)** — avoid in production

A common sin is **hidden quadratic**: you write `.filter(x => array.find(...))` without realizing the `.find` makes it O(n) per filter iteration, total O(n²). Works great on 10 items, painful on 10k.

### Why systems need awareness
Data grows. The MVP has 100 rows; the success case has 100M. An algorithm that's "fine" at MVP becomes the reason for a Friday-night incident. Code that's O(n²) and runs on every beat turns a 100-task sprint into a 10 000-op scan per heartbeat.

Related concepts:
- **Indexes** — pre-compute lookups so a query that would be O(n) becomes O(log n) or O(1)
- **Memoization** — cache expensive computations by key
- **Batching** — N+1 query problem: one SELECT plus N follow-up queries is O(n) round trips; one JOIN is O(1)

### Canonical symptoms
- "It was fast last month"
- Latency growth proportional to data growth
- The same operation runs N times inside a loop, each taking "acceptable" time
- CPU profiles dominated by string scans or array searches
- Full table scans on queries that should hit indexes

### The fix pattern
- Know the complexity of every loop you write
- Pre-index lookups: build a `Map<id, T>` once, use it N times
- Index the DB for every column in a `WHERE`
- Paginate; never return "all" of anything unbounded
- Benchmark under realistic data size, not `n=10`

---

## C11 · Making illegal states unrepresentable

### The concept
A design principle: use the type system to **rule out invalid states** so you can't even write code that produces them. Instead of a `status: string` that allows any value, use an enum. Instead of `{email?: string, phone?: string}` where both can be missing, use a discriminated union that forces exactly one.

Strings are the default bottom type — they represent *anything*. Every time you compare `=== "completed"`, you're reimplementing an enum by hand, with no help from the compiler when someone types `"completted"` in one place out of fifteen.

### Why systems need it
Runtime checks catch bugs at runtime — often in production. Type-level checks catch them at compile time, before the code ships. A missing role in a switch is a compile error with `switch(role) { case "ceo": …; exhaustive check }`; with string literals scattered across 10 files, you ship the bug.

Discriminated unions are the stronger form: `{kind: "paid", amount: number} | {kind: "pending"}` — you can't accidentally create `{kind: "paid"}` with no amount, because the type rejects it.

### Canonical symptoms
- Grep returns 80 hits for a role name literal
- "Add a new role" takes a day and touches 15 files
- Typos: `"ui-designer"` vs `"ui_designer"` silently miscompare
- Nested ternaries mapping strings to behaviors
- "We have a schema for this but it's `z.string()`" — useless

### The fix pattern
- Define enums (or discriminated unions) in one place
- Import the type everywhere the literals are used
- Exhaustiveness-check switches (TypeScript: `never` in the default case)
- For dynamic strings from external sources, validate-and-narrow with Zod at the boundary

---

## C12 · Type-safety at boundaries

### The concept
Static type systems only know about the code they can see. At the **boundary** — HTTP bodies, DB results, messages off a queue — there's no type information; it's just bytes and JSON. Something has to *narrow* that into typed data.

`as any` (TypeScript) / `unchecked cast` (any language) is an **unchecked assertion**: you're telling the compiler "trust me, this shape is correct." If you're wrong, you get runtime errors inside code that thought it was safe. It's a lie told at the boundary, propagated everywhere downstream.

Zod / io-ts / Pydantic are **runtime validators** that produce a typed value at the boundary. They don't trust the input; they verify it. After validation, your TypeScript types are actually true.

### Why systems need it
Without boundary validation:
- External shape changes silently break your code months later
- A schema field added to the producer doesn't reach the consumer until something crashes
- `as any` casts spread like mold — once one exists, the surrounding code also gets loose
- Tests pass because they mock the boundary with typed data that doesn't reflect reality

### Canonical symptoms
- `request.body as { …thing… }` in HTTP handlers
- `z.record(z.string(), z.unknown())` for things that have a known shape
- `(someObj as any).someField` sprinkled through the codebase
- Tests green but prod crashes on input shapes the tests didn't cover
- "We have a contract" but the contract is `unknown`

### The fix pattern
- Validate at the boundary, always (Zod, etc.)
- After validation, types are truth; inside the app, trust them
- `as any` is a lint error. If you must escape, comment *why* and validate-before-use
- Contract schemas reference domain schemas (`TaskSchema`, `UserSchema`), not `z.unknown()`

---

## C13 · REST resource modeling

### The concept
**REST** (Representational State Transfer) is a set of conventions for HTTP APIs:
- URLs identify **resources** (nouns, plural)
- HTTP verbs describe **what you're doing** (GET=read, POST=create, PATCH=update, DELETE=remove)
- **Status codes** distinguish success from failure (200 OK vs 404 Not Found vs 409 Conflict)
- Responses have a **consistent shape** so clients can parse generically

REST isn't a religion — it's a set of defaults that make APIs legible to humans and SDKs. When you break them, clients have to special-case every endpoint.

### Why systems need conventions
A consistent API:
- Plays nicely with caches (GET is safe to cache; POST isn't)
- Monitored correctly by default (404 ≠ 500 in metrics)
- Works with generic client libraries (retry policies depend on verb + status)
- Teachable — new engineers don't relearn per endpoint

### Canonical symptoms (of inconsistency)
- `GET /api/users` mutates state (not safe, breaks caching assumptions)
- Errors returned as HTTP 200 with `{error: "..."}` in the body (monitoring can't tell)
- Verbs in URLs (`/get-users`, `/delete-order`) instead of proper verbs
- Each endpoint returns a different envelope (`{data}`, bare array, `{users, total}`)
- No pagination on list endpoints
- No API versioning (breaking changes ship with no migration story)
- No rate limiting; any endpoint can be hammered

### The fix pattern
- Nouns + plural + kebab-case URLs
- Correct verbs; GET is safe and idempotent, DELETE is idempotent, PUT is idempotent, POST isn't
- One envelope: `{data, meta?, links?}`
- Status codes: 200 for read-success, 201 for create-success (+ Location header), 204 for delete, 400 for malformed, 404 for not-found, 409 for conflict, 422 for semantic invalid, 429 for rate limit
- `/api/v1/` from day one
- OpenAPI spec as source of truth

---

## C14 · Cohesion, coupling, and the Single Responsibility Principle

### The concept
- **Cohesion** — how related the things inside a module are. High cohesion = one clear purpose.
- **Coupling** — how dependent modules are on each other. Low coupling = changes don't ripple.
- **SRP (Single Responsibility Principle)** — a module should have one reason to change.

"God files" and "god functions" — large files/functions that do many unrelated things — have low cohesion and high coupling. They break SRP. They're everywhere because they start small and accrete: "I'll just add this one more thing to `utils.ts`."

Related: **fan-in / fan-out.** A file that imports from 20 other files (high fan-in) is a god file. A file that's imported by 20 others (high fan-out) is a utility hub; cycles with hubs are particularly bad because breaking them requires ripping things apart.

### Why it matters
Big files are a **testing** problem first: you can't unit-test a 600-line function without instantiating half the universe. They're a **refactoring** problem second: every change risks breaking something seemingly unrelated. They're a **comprehension** problem third: a new engineer spends an hour reading the file before they can change a line.

### Canonical symptoms
- Functions over 100 lines
- Files over 500 lines
- Import header that's 30+ lines
- "It works but I'm scared to touch it"
- Test files that mock 15 dependencies to test one function
- Every change ships with "also fix a bunch of unrelated things because I was in the neighborhood"

### The fix pattern
- Split by phase, role, or concern, not by type (`developer-executor.ts` not `all-executors.ts`)
- Function = one thing, one paragraph of explanation, under 50 lines when possible
- Each file has a clear "why does this file exist" answer in one sentence
- When you catch yourself adding to a file because "it's where that kind of thing lives," ask if *that kind of thing* has outgrown the file

---

## C15 · Observability

### The concept
**Observability** = the ability to understand what a system is doing from its outputs. Three pillars:
- **Logs** — narrative of what happened
- **Metrics** — counters + gauges + histograms of what's happening
- **Traces** — the path a single request took through the system

Good observability lets you answer questions you didn't know to ask when you wrote the code. "Why did this agent pick that action on that beat?" should be answerable by querying past data — not reproducing the run.

Distinction from C2: **C2 catches failures that need handling; C15 records successful decisions for later inspection.** Both require structured output instead of `console.log`.

### Why systems need it
You cannot operate what you cannot see. Every production incident begins with "what's happening right now?" If the answer requires SSH and grep-ing log files, your mean-time-to-recovery is measured in hours. If it's a dashboard plus a query, it's measured in minutes.

Related concept: **decisions as data.** When the system makes a choice — "this check passed, that one failed, I picked this action" — emit a structured event with the full input and the decision. Later you can query "show me all beats where the scope check failed" without replaying.

### Canonical symptoms
- Debugging in production requires re-deploying with more logs
- Incident postmortems include "we don't know why it happened"
- `console.log` statements that never make it to a centralized log system
- Truncations like `output.slice(0, 500)` with no way to recover the original
- Decisions with no audit trail ("the system decided X — why?")
- Correlation IDs missing, so you can't follow a request across services

### The fix pattern
- Structured logger (JSON output) routed to a centralized sink (Loki, Datadog, ELK)
- Metrics on every significant decision (counter for each outcome)
- Distributed tracing for multi-service flows
- Correlation ID on every request, propagated to every downstream call
- Emit decision events with full context — not "completed" but `{outcome, reason, inputs}`
- Truncate with a marker AND save the full version to object storage if inspection might matter

---

## C16 · Code as liability

### The concept
**Every line of code is a liability.** It's bytes to read, behavior to test, maintenance to keep alive, and attack surface to defend. The only code that doesn't cost you is code you didn't write (or deleted).

Deprecated exports, unused fields, dead branches, `//TODO: remove this` comments from 2022 — all of these are liability with no value. They mislead readers, resist refactoring, and hide the real architecture.

Related principle: **YAGNI** (You Aren't Gonna Need It). Don't write code for hypothetical futures. Don't add a parameter "in case we need it." Don't leave deprecated code around "in case someone's still using it" — either delete it or document its active callers.

### Why it matters
Dead code misleads. A new engineer reads it, assumes it's live, bases their mental model on it, and gets things wrong. It inflates diff sizes on unrelated PRs. It makes grep results noisier. It's tested (costing CI time) for a case that no longer exists.

### Canonical symptoms
- `@deprecated` exports still reachable from the outside
- Fields declared but never read
- `if (config.flag)` for a flag that's been `true` in production for three years
- Functions that are identities, passthrough wrappers, or unreferenced
- Comments saying "leave this here, we might use it later"

### The fix pattern
- Delete on sight; you can always recover from git
- Run dead-code analyzers (knip, ts-prune, depcheck) in CI
- Mark deprecations with a removal date; delete on that date
- Don't write "for flexibility" — write for today, refactor when tomorrow's requirement is concrete

---

## C17 · Named values / configuration

### The concept
A **magic number** or **magic string** is a literal value embedded in code with no name and no explanation: `timeout = 45000`, `if (score < 0.6)`. Names give intent (`NETWORK_TIMEOUT_MS`, `UNDERPERFORMER_THRESHOLD`). Names are also **single sources of truth** — tune the value once, every caller updates.

Two kinds of magic values:
1. **Constants** that belong in code — a protocol-defined value, a math constant
2. **Configuration** that belongs outside code — thresholds, timeouts, caps that vary by environment or tenant

### Why naming matters
An unnamed `0.6` in three different files is three independent decisions. Change one, and the other two quietly stay at `0.6`. Change the "obvious" meaning of `0.6` (was it a threshold, a ratio, a probability?), and nobody remembers.

Related: **configuration as data.** Things that might change per deployment belong in environment variables or a config service, not inlined. Things that never change belong in a named constant. Nothing belongs inlined as a bare literal.

### Canonical symptoms
- Same number appearing in 5 files
- `setTimeout(() => {}, 3000)` — why 3000?
- `.slice(0, 500)` — why 500?
- `if (x > 0.6)` — 0.6 of what?
- Tuning a parameter requires grep + multi-file edit

### The fix pattern
- Named constants at module top or in a `config/` file
- Per-domain config objects injected as dependencies (`ChecklistConfig`, `RateLimitConfig`)
- Environment variables for things that vary by deployment
- Comment the *why* next to the name: `// Chosen to match OpenCode's max stream idle`

---

## C18 · Database layer

### The concept
The database is where bytes **durably** live. Everything else is an optimization on top. A good DB layer has five disciplines:

- **Schema as contract** — tables and columns are the source of truth; ORM types and app-level schemas mirror the DB, not the other way around
- **Indexes match access patterns** — every column in a frequent `WHERE`, `ORDER BY`, or `JOIN` has an index
- **Foreign keys enforced at the DB** — integrity is a DB concern, not an app concern
- **Migrations are forward-only, versioned, and locked** — you roll forward; production never runs unversioned DDL
- **Connection pool is explicit** — sized for steady-state load, with circuit breakers so DB issues don't cascade

Three DB-specific ideas recur:

**Normalization.** Split entities into tables so each fact lives in one place. A `users` table, an `orders` table, a `user_orders` relation — not a `user` blob with orders nested inside.

**jsonb (the schemaless escape hatch).** Postgres supports storing arbitrary JSON in a column. Use case: truly unstructured external payloads (webhook bodies, LLM outputs). Anti-use case: storing entities you'll query by inner fields. A jsonb column is indexable in Postgres with GIN, but each query is more expensive than a regular column, and you lose FK integrity entirely for anything inside the blob.

**The migration ratchet.** Schema evolves. Every change must work with both the old and new code during rollout. The safe pattern is always: **add, dual-write, read-new, delete-old** across three deploys. "Rename column" in one migration breaks anything still reading the old name.

### Why systems need DB discipline
The DB is the first thing to feel scale. A query that's fine at 1k rows becomes a 30-second full table scan at 10M. An `ALTER TABLE` that took 50ms in dev locks the whole table for 2 minutes in prod. A missing FK that never fired in testing quietly produces orphan rows for months. A jsonb blob that was "fast to prototype" turns every update into a full-document read-modify-write and becomes the contention hotspot.

### Canonical symptoms
- `EXPLAIN` returns `Seq Scan` on a query you thought was indexed
- Deploy causes a table lock for minutes, traffic queues up, everything else times out
- Two pods deploy simultaneously, one runs `CREATE INDEX` while the other does `ALTER TABLE`, deadlock or inconsistent schema
- Orphan rows referencing deleted parents — no FK to catch it
- "We store it as jsonb because the shape was changing" — three years later, still jsonb, still awful to query
- `DATABASE_URL` misconfigured in one environment, discovered at 3am
- Migrations that worked in dev fail in prod because prod has data

### Related CS ideas
- **ACID** (Atomicity, Consistency, Isolation, Durability) — the transactional guarantees of a traditional RDBMS
- **Isolation levels** — Read Committed, Repeatable Read, Serializable — tradeoffs between consistency and concurrency
- **MVCC** (multi-version concurrency control) — how Postgres lets readers and writers coexist without blocking each other
- **VACUUM / bloat** — Postgres-specific operational concern; MVCC creates dead tuples that need cleanup
- **Connection-pool sizing** — too small blocks requests, too large exhausts DB; standard formula is roughly `(CPU cores × 2) + effective spindle count`
- **Read replicas and hot-cold separation** — when one primary isn't enough
- **CAP theorem** — distributed systems pick two of Consistency, Availability, Partition-tolerance; relevant for multi-region setups

### The fix pattern
- Schema lives in migration files, one change per migration
- ORM schema (Drizzle, Prisma, TypeORM) mirrors the DB — don't use ORM schema as the source of truth if your DB gets touched by anything else
- Every `WHERE`, `ORDER BY`, `JOIN` column: indexed. Verify with `EXPLAIN`
- Every cross-table reference: FK with explicit `ON DELETE` behavior
- Migrations run with a DB-level advisory lock; second runner no-ops
- Migrations are **additive first**: add new column / table, dual-write, migrate readers, delete old column in a later deploy
- jsonb only for genuinely unstructured data; default to columns
- Connection pool config: documented, sized for load-tested throughput, health checks on the pool
- `CREATE INDEX CONCURRENTLY` on large tables; never `CREATE INDEX` in a traffic window

### Why this is distinct from other clusters
| It touches | Not covered by |
|---|---|
| **Schema shape at the DB** — what tables/columns exist | C11 (enums in code) — C11 is at the TS level; this is at the DB level |
| **Indexes + query plans** | C10 (complexity) — C10 is about loops in app code; this is about the DB's own query planner |
| **FK enforcement** | C8 (app-level transactions) — C8 is about grouping writes; FKs are about integrity of the data itself |
| **Migrations + pool** | C9 (memory bounds) — C9 is about process memory; this is about durable storage lifecycle |
| **jsonb blob choice** | C14 (god files) — one file isn't a DB concern; one blob column is |

### What it doesn't cover
App-level persistence (`store.ts`, `control-plane.ts`, `company-state.ts` — the write-back cache implementations) lives in C1 (CAS for concurrent writes), C8 (transactional grouping), and C2 (silent write failures). Those are about how *app code* drains to DB; C18 is about what the DB *itself* looks like.

---

## Cross-cluster themes

A few themes recur across multiple clusters:

### "Errors need a sink"
C2 (silent swallowing), C3 (fire-and-forget), C15 (observability) are all variations of "bad things must go somewhere." Build the sink once (structured logger + audit ledger + error counter), route all failure paths through it.

### "Boundaries need validation"
C5 (injection), C11 (illegal states), C12 (type safety) all hinge on **what you trust**. Validate aggressively at boundaries, trust internals. The absence of a boundary check is a promise you can't keep.

### "State needs owners"
C1 (CAS), C6 (TOCTOU), C8 (atomicity) are about **concurrent modification**. When multiple things can write the same state, someone must serialize or merge the writes — either a lock, a CAS, a transaction, or a CRDT. Shared mutable state with no coordinator is a bug.

### "Finite resources need bounds"
C7 (cancellation), C9 (memory), C10 (pagination) are about **what happens at scale**. Every resource has a limit; every limit deserves a policy for what happens when you hit it.

### "Data outlives code"
C18 speaks to this: the DB schema is a contract with every version of your application — past, present, future. Code you haven't written yet will read what you store today; code you've already shipped will read what you store tomorrow. Every schema change must work across the gap. This is why migrations are additive-first, why FKs are declared at the DB, why jsonb blobs that were "fine for the MVP" become scar tissue three years in. The DB is the slowest layer to refactor and the fastest to regret.

### "Code is read more than it's written"
C11, C14, C16, C17 are about **legibility**. A reader — future you, a new engineer, a code-review bot — should be able to understand a module without reading the whole system. Names, types, SRP, and deletion all serve that goal.

---

## How to use this doc

- When the audit in [clusters.md](./clusters.md) says "C3 · Fire-and-forget" and you want to know what that *means in SE terms*, come here.
- When you're writing a fix proposal and want to cite the underlying concept, link to the section here.
- When onboarding someone to the audit, hand them this doc first, then the clusters.
