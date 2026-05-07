# Production Launch Audit — Output Quality & Reliability

> Generated: 2026-05-07 | Focus: Consistent, high-quality agent output for investor demo

---

## How to Read This Document

- **Section 1** — Output quality & reliability (primary focus)
- **Section 2** — Infra/ops reliability (uptime, crashes)
- **Section 3** — Deferred (not relevant for MVP: budget, rate-limiting, high traffic)

---

# Section 1: Output Quality & Reliability

These are the issues that will make agents produce bad, inconsistent, or incomplete work.

---

## CRITICAL — Will Cause Visible Failures

### 1.1 Developer Can Complete Tasks Without Evidence

**Problem:** The developer agent can call `task_complete()` without first running `workspace_run_typecheck()`, `workspace_run_acceptance_suite()`, or `workspace_collect_evidence()`. These verification tools exist but are **advisory, not enforced**. The LLM decides whether to use them.

**Impact:** A developer agent in a hurry (or with degraded prompt context) will mark tasks "done" with broken code. CTO review catches this — but only after burning a full review beat (45–120s), a rework cycle (another 30–120s dev beat), and more LLM tokens. In the worst case, 3 rework cycles fire before escalation, wasting ~10 minutes of wall-clock time on a task that should have been caught in 5 seconds by `tsc --noEmit`.

**Fix:** Make `task_complete()` MCP tool reject calls unless a verification gate artifact exists for the claimed task. Pseudocode:
```typescript
// In task_complete handler:
const evidence = await artifactsRepo.findByTaskAndKind(taskId, "evidence");
if (!evidence) {
  return { ok: false, error: "Must call workspace_collect_evidence() before completing" };
}
```
This is a 10-line change in the MCP tool handler that prevents the most common quality failure.

---

### 1.2 No Automated Pre-Review Gate on Developer Output

**Problem:** The verification gate (`runVerificationGate()`) runs in `pre_review` phase, but only checks `npm run build`. It does **not** run:
- `tsc --noEmit` (type check — separate from build in many setups)
- `npm test` (deferred to `final` phase only)
- Preview reachability (warns but doesn't fail in pre_review)

This means a developer can complete a task, the system transitions to "reviewing", and the CTO spends an entire beat discovering the code doesn't even compile.

**Impact:** Wasted CTO beats. The CTO is the most expensive agent (highest-priority, longest prompts). Every wasted CTO beat is 30–90s of wall-clock time where nothing productive happens.

**Fix:** Run typecheck + tests in `pre_review` phase too:
```typescript
// In verification-gate.ts:
if (phase === "pre_review" || phase === "final") {
  const testRes = await runShell("npm", ["run", "test"], productDir, 120_000);
  if (testRes.exitCode !== 0) {
    return { passed: false, testResult: testRes };
  }
}
```

---

### 1.3 Memory Injection Silently Fails

**Problem:** If Hippocampus crashes or returns empty results, the beat continues with **zero memory context** — no facts, no habits, no learnings. The agent doesn't know it has amnesia. There's no `[NO RELEVANT MEMORY FOUND]` signal injected into the prompt.

**Impact:** The agent repeats mistakes it already learned from. Example: Developer learned in Sprint 1 that the project uses Tailwind, not CSS modules. In Sprint 2, if memory retrieval fails silently, the developer writes CSS modules again. CTO catches it in review → rework cycle → wasted time.

**Fix:** Two changes:
1. If memory retrieval throws, inject a warning into the beat context: `"⚠️ Memory system unavailable — proceed carefully, you may not have full history."`
2. Log a `memory.retrieval_failed` event to the audit bus so operators can see it.

---

### 1.4 Skill Matching Is Token-Based, Not Semantic

**Problem:** The skill registry matches skills to tasks via simple token overlap (`tokenOverlap(taskTitle, skillKeywords)`). This means:
- Task "Build a payment form" won't match skill "stripe-checkout-integration" (no token overlap)
- Task "Add CSS animations" will match skill "css-grid-layout" (overlaps on "CSS")

**Impact:** Agents get wrong or no skill guidance for tasks. Skills are the primary mechanism for injecting domain knowledge (framework patterns, API usage, best practices). Wrong skill = wrong patterns in the generated code.

**Fix:** Replace token overlap with embedding-based similarity. The Hippocampus already has an embedding provider — reuse it:
```typescript
const taskEmbedding = await embed(taskTitle + " " + taskDescription);
const bestSkills = skills
  .map(s => ({ skill: s, score: cosineSimilarity(taskEmbedding, s.embedding) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 3);
```

---

### 1.5 No Introspective Self-Correction on Developer Agent

**Problem:** The developer agent writes code, but never re-reads its own output to check for consistency. The quality loop is entirely **external** (CTO review → rework). There's no internal "does this look right?" step before calling `task_complete()`.

**Impact:** Obvious mistakes that a simple re-read would catch (incomplete function, missing import, wrong variable name) go through the full review cycle instead of being caught in the same beat.

**Fix:** Add a self-review prompt step before `task_complete()`:
```
Before completing, review your changes:
1. Read every file you modified
2. Check: does the code match ALL acceptance criteria?
3. Check: are there any TODO comments or placeholder values?
4. If you find issues, fix them now. Do not complete until clean.
```
This is a prompt engineering change in the developer's system prompt (roles.ts). No code change needed — just append to the developer ROLE_SOUL.

---

## HIGH — Will Cause Quality Degradation

### 1.6 Context Staleness Between Beats

**Problem:** `buildSnapshotView()` fires 12 parallel queries to assemble the company state for each beat. But between the time the snapshot is built and the time the beat completes (up to 15 minutes), other agents may have changed the state. The beat is operating on stale context.

**Impact:** Developer claims a task that CTO already blocked. PM plans a sprint that CEO already rejected. Tester verifies code that developer already reworked. These conflicts are caught by `FOR UPDATE` locks on write, but the agent still wastes the entire beat reasoning about stale state.

**Fix:** For the developer beat specifically, re-fetch task status just before `task_claim()`:
```typescript
// In task_claim MCP handler:
const freshTask = await tasksRepo.findById(db, taskId);
if (freshTask.status !== "planned" && freshTask.status !== "created") {
  return { ok: false, error: `Task already ${freshTask.status}` };
}
```
This is likely already partially done (the `FOR UPDATE` lock catches race conditions at write time), but a pre-check avoids wasting the entire beat context on a stale claim.

---

### 1.7 CTO Review Has No Code Diff — Only Artifact Summaries

**Problem:** The CTO review prompt receives artifacts (which may be summaries or evidence bundles), but does **not** get the actual git diff of files changed. The CTO is reviewing the developer's *description* of what they did, not the *actual code*.

**Impact:** Developer writes "Implemented login form with validation" in the artifact. CTO approves based on the description. But the actual code has an XSS vulnerability, or the validation doesn't actually work — CTO never saw it.

**Fix:** Inject the git diff into the CTO review context:
```typescript
// In CTO review beat:
const diff = await runShell("git", ["diff", "--stat", "HEAD~1"], productDir);
const fileDiffs = await runShell("git", ["diff", "HEAD~1"], productDir);
// Truncate to fit context window
const truncatedDiff = fileDiffs.stdout.slice(0, 8000);
ctoContext.codeDiff = truncatedDiff;
```

---

### 1.8 Tester Runs Acceptance Suite but Can't Write New Tests

**Problem:** The tester agent calls `workspace_run_acceptance_suite()` which runs `npm test`. But if the developer didn't write tests (and many tasks don't require it), the tester is verifying against an empty or pre-existing test suite. The tester has tools to write test files, but the current prompt doesn't strongly guide test creation.

**Impact:** Tasks pass QA with "test suite: passed (0 tests)". The Definition of Done checklist walks through criteria manually (LLM-based), but this is subjective and doesn't create durable regression coverage.

**Fix:** Add to the tester's ROLE_SOUL:
```
When reviewing a task, if no test file was created by the developer:
1. Write at least one test file covering the main acceptance criterion
2. Run the test suite and include results in the QA report
3. If test fails, this is a valid QA finding — file it as a bug
```

---

### 1.9 Meeting Pipeline — Facilitator Synthesizes Without Verifying Claims

**Problem:** The meeting pipeline (synthesize → resolve → brief) has the facilitator agent synthesize contributions from all participants. But it doesn't verify that the claims in contributions are accurate. If the developer claims "I completed the API endpoint" but the code doesn't work, the meeting summary reports it as done.

**Impact:** CEO makes decisions based on inaccurate meeting summaries. Sprint planning proceeds with incorrect assumptions about completed work.

**Fix:** Cross-reference meeting contributions against actual task statuses and build health before synthesizing:
```typescript
// In meeting-pipeline.ts facilitator step:
const taskStatuses = await tasksRepo.listBySprintHydrated(db, sprintId);
const buildHealth = await runVerificationGate(productDir, "pre_review");
facilitatorContext.groundTruth = { taskStatuses, buildHealth };
```

---

### 1.10 Rework Context Doesn't Include Full Prior Failure Details

**Problem:** When a task enters rework, the developer gets the task back with `reviewState.reworkCycleCount` incremented. But the **specific findings** from the QA report or CTO review are not always fully injected into the developer's next beat context. The developer may not know *exactly* what to fix.

**Impact:** Developer fixes something random instead of the specific issue. Another rework cycle follows. 3 cycles burn through in 15–30 minutes with the same bug unfixed.

**Fix:** When transitioning a task to `rework`, attach the QA findings as a structured field on the task itself:
```typescript
task.reworkGuidance = {
  cycle: reviewState.reworkCycleCount,
  findings: qaReport.findings,
  ctoComments: ctoReview.reasoning,
  failedCriteria: dodChecklist.filter(c => c.status === "fail")
};
```
Then inject `task.reworkGuidance` prominently in the developer's beat context.

---

### 1.11 `maxConcurrentBeats=1` Serializes Everything

**Problem:** Only one agent runs at a time. This means the Developer → CTO review → Tester QA loop is strictly sequential. A task that needs 3 beats to complete (dev + review + test) takes 3 × beat interval minimum.

**Impact:** Slow iteration. Investor watching the demo sees agents taking turns one at a time. A 5-task sprint that should take 10 minutes takes 30+ minutes because every action is serialized.

**Fix:** Increase to `ARCEUS_HEARTBEAT_MAX_CONCURRENT=3`. The `FOR UPDATE` locks prevent data corruption. The semaphore already supports >1. The only risk is OpenCode session contention (single OpenCode server), but sessions are isolated.

---

## MEDIUM — Quality Improvements Worth Making

### 1.12 Structured Output Truncation — No Automatic Retry

**Problem:** When Azure OpenAI returns `finish_reason="length"` (output too long for max_tokens), the system throws `LlmTruncatedOutputError`. Only the CEO classifier retries with "BREVITY RULES". Other callers (strategy generation, memory extraction) just fail.

**Impact:** Intermittent failures on complex tasks where the LLM needs more output space. These are the most important tasks (complex strategy, detailed plans) — exactly where you want reliability.

**Fix:** Add a generic retry-with-increased-budget handler in `structuredCompletion()`:
```typescript
if (choice.finish_reason === "length" && maxTokens < 16_000) {
  return structuredCompletion(schema, messages, { maxTokens: maxTokens * 2 });
}
```

---

### 1.13 Trivial Fact Filter Is Regex-Based

**Problem:** Memory deduplication uses `isTrivialFact()` with hardcoded regex patterns to skip useless facts. Patterns like `/completed task/i`, `/working on/i` filter obvious noise. But novel trivial facts slip through.

**Impact:** Memory fills with noise ("I started working on the login form", "I completed the footer component"). When the agent retrieves memory, relevant facts are diluted by trivial entries.

**Fix:** Replace regex with an LLM classifier call during fact extraction (already have the LLM context hot):
```typescript
// During memory extraction:
const isUseful = await classifyFact(fact, "Is this fact useful for future tasks? yes/no");
```

---

### 1.14 Habit Success Tracking Uses EMA but Doesn't Decay Stale Habits

**Problem:** Procedural habits (when→do patterns) track success via EMA (`emaSuccess`). But habits that haven't been triggered in 30+ days still sit in the retrieval pool at their last EMA score. No decay for staleness.

**Impact:** Ancient habits from Sprint 1 ("always use Create React App") interfere with Sprint 20 patterns ("project now uses Vite"). Agent follows outdated guidance.

**Fix:** Apply time-decay to habit retrieval scoring:
```typescript
const daysSinceLastTrigger = (Date.now() - habit.lastTriggeredAt) / 86400000;
const decayFactor = Math.exp(-0.03 * daysSinceLastTrigger); // Half-life ~23 days
const adjustedScore = habit.emaSuccess * decayFactor;
```

---

### 1.15 No Output Diversity — Same Model for All Roles

**Problem:** Every agent (CEO, Developer, CTO, Tester, PM) uses the same Azure OpenAI deployment. If the model is weak at code review, every CTO beat suffers. If it's strong at coding but weak at planning, PM output degrades.

**Fix:** Support per-role deployment overrides:
```
ARCEUS_AZURE_OPENAI_CEO_DEPLOYMENT=gpt-4o (reasoning-heavy)
ARCEUS_AZURE_OPENAI_WORKER_DEPLOYMENT=gpt-4o (code-heavy)
```
This config already exists for CEO vs Worker split. Extend to per-role if needed.

---

### 1.16 Beat Scoring Only Checks "Did Something Happen" — Not "Was It Good"

**Problem:** The beat scoring system (`beat-scoring.ts`) checks for observable state changes (artifact created, task completed, etc.) but doesn't evaluate the *quality* of those changes. A developer that writes a 3-line placeholder function and calls `task_complete()` gets scored `pass`.

**Impact:** Trust scores don't reflect output quality. An agent with 90% pass rate may be producing mediocre work that always needs rework.

**Fix (medium-term):** Add a quality dimension to beat scoring:
- If task enters rework after this beat's completion → retroactively downgrade to `partial`
- If task passes QA first try → bonus score

---

# Section 2: Infrastructure Reliability (Uptime)

Issues that cause crashes, downtime, or data loss.

### 2.1 No Graceful Shutdown Timeout — CRITICAL

The shutdown handler waits indefinitely for `app.close()`. If an LLM call is mid-flight (90s timeout), Railway SIGKILL after ~10s grace period leaves state inconsistent.

**Fix:** Add 30-second force-exit timeout around shutdown sequence.

---

### 2.2 Memory Leaks Will OOM the Container — CRITICAL

| Leak | Growth | Fix |
|---|---|---|
| `graph-store.ts` — completed sprints never pruned | ~100KB–1MB/sprint | Delete from heap on completion |
| `watchdog.ts` — `lastActivity` map never cleared | ~60 bytes/beat | Drain entries >1h old periodically |

---

### 2.3 Database Pool Starvation Under Concurrent Beats — HIGH

Pool size is 10, `buildSnapshotView()` fires 12 parallel queries per call. With `maxConcurrentBeats=3` (recommended above), that's 36 parallel queries. Set `ARCEUS_DB_POOL_SIZE=25`.

---

### 2.4 OpenCode Subprocess Has No Health Monitoring — HIGH

Single shared OpenCode server. If it crashes, nothing detects it for up to 2 minutes. Add a 30-second health ping interval.

---

### 2.5 Postgres Circuit Breaker Is Mostly Unused — HIGH

`breakers.postgres` exists but only wraps cost-event inserts. All repo calls and `buildSnapshotView` hit DB unprotected. Wrap critical paths.

---

### 2.6 Railway Restart Limit Is 5 — MEDIUM

`restartPolicyMaxRetries = 5`. Memory leak → OOM → 5 restarts → permanent down. Increase to 10+.

---

### 2.7 Single Container, No Redundancy — MEDIUM

Railway deploys one instance. Every deploy or crash = downtime. Accept for MVP.

---

### 2.8 `createSprintWithTasks` Non-Atomic — MEDIUM

N task INSERTs without wrapping transaction. Process death mid-way = partial sprint. Wrap in `db.transaction()`.

---

# Section 3: Deferred (Not MVP Concerns)

These are real issues but explicitly deprioritized per the user's direction.

### 3.1 `pauseWhenBudgetExhausted` Defaults to `false`

Agents won't stop at $0 budget. **Not an MVP concern** — budget is unconstrained for now. Set this when you have paying customers.

### 3.2 Per-Beat Token Budget Is a Soft Cap

Beat flags `BUDGET_EXCEEDED` but doesn't kill the beat. For MVP with unconstrained budget, this is fine.

### 3.3 No HTTP Rate Limiting

No `@fastify/rate-limit`. For MVP with limited users, not needed. Add before public launch.

### 3.4 No API Rate Limiting on External Calls

No throttle on how fast agents call Azure OpenAI. With unconstrained budget, not a concern. Azure's own rate limits (429) are handled by the circuit breaker.

### 3.5 SSE Connections Have No Max Limit

Inspector and audit SSE streams accept unlimited connections. Not a concern with 1-3 users watching the dashboard.

### 3.6 Cost Recording Is Best-Effort

`recordLlmCost()` swallows Postgres errors. Cost events can be lost. Not critical when budget isn't a constraint.

### 3.7 Single Container Performance Ceiling

One process, one OpenCode server. Throughput ceiling is ~1 beat every 30-60s. Fine for MVP demo.

---

# Priority Action List (This Week)

## Output Quality Fixes (highest impact on demo quality)

| # | Fix | Effort | Impact |
|---|---|---|---|
| 1 | Add self-review step to developer ROLE_SOUL prompt | 30min | Catches obvious mistakes before review cycle |
| 2 | Run typecheck+tests in pre_review gate (not just final) | 1hr | Prevents broken code reaching CTO |
| 3 | Inject rework findings into developer beat context | 2hr | Fixes "blind rework" where dev doesn't know what broke |
| 4 | Increase `maxConcurrentBeats` to 2-3 | 5min env var | 2-3x faster sprint execution for demo |
| 5 | Inject git diff into CTO review context | 2hr | CTO reviews actual code, not just descriptions |
| 6 | Add memory retrieval failure warning to beat context | 30min | Prevents silent amnesia |
| 7 | Require evidence artifact before `task_complete()` | 1hr | Hard gate on unverified completions |

## Infra Stability Fixes

| # | Fix | Effort | Impact |
|---|---|---|---|
| 8 | Add 30s shutdown timeout | 15min | Prevents hung shutdown on Railway deploy |
| 9 | Add graph-store pruning + watchdog drain | 1hr | Prevents OOM over multi-day run |
| 10 | Set `ARCEUS_DB_POOL_SIZE=25` | 5min env var | Prevents connection starvation |
| 11 | Add OpenCode health ping (30s interval) | 1hr | Detects subprocess crash quickly |

## Recommended Railway Env Vars

```bash
ARCEUS_HEARTBEAT_MAX_CONCURRENT=3
ARCEUS_DB_POOL_SIZE=25
# restartPolicyMaxRetries=10 (in railway.toml)
```
