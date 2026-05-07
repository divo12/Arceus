# Output Quality — Production Audit

> Generated: 2026-05-07  
> Goal: Every agent beat produces correct, complete, high-quality output — every time.

---

## Table of Contents

1. [The Quality Pipeline Today](#1-the-quality-pipeline-today)
2. [Critical — Will Cause Visible Bad Output](#2-critical)
3. [High — Will Degrade Output Consistency](#3-high)
4. [Medium — Worth Fixing Post-Launch](#4-medium)
5. [Architecture Strengths](#5-architecture-strengths)
6. [Priority Action List](#6-priority-action-list)

---

## 1. The Quality Pipeline Today

### Current Flow

```
PM writes task + Definition of Done
       ↓
Developer claims task → writes code → calls task_complete()
       ↓
Verification Gate (pre_review) → npm run build only
       ↓
CTO Review → reads artifact summaries → approve / changes_requested
       ↓
Tester QA → runs acceptance suite + DoD walkthrough → pass / fail + bug_fix tasks
       ↓
Rework (up to 3 cycles) → Escalation to CTO decision (fix / skip / abort)
       ↓
Final Verification Gate → build + tests + preview
       ↓
Sprint complete
```

### What's Good

- Zod + JSON Schema strict validation on all structured LLM outputs
- Tolerant JSON parser handles models that append commentary
- Role-based tool restrictions (CEO can't write code, Tester can't write production code)
- Trust-based tool gating (low-trust agents lose write/shell access)
- Beat scoring based on observable state changes (not LLM self-reports)
- Bounded rework cycles (3 max) with escalation
- Layered timeouts (90s fetch, 15m beat, 30m sweep)
- Mandatory role injection (CEO, CTO, PM, Developer, Tester, Skills Lead always present)
- 4-tier memory system with MMR-ranked retrieval and deduplication

### What's Weak

- Verification is advisory, not enforced
- CTO reviews descriptions, not code
- Rework is blind (dev doesn't get specific findings)
- Skill matching is token-overlap, not semantic
- Memory fails silently
- Beat scoring measures activity, not quality
- No developer self-review step
- All roles use same model

---

## 2. Critical

### 2.1 Developer Can Complete Tasks Without Verification

**Where:** MCP tool handler for `task_complete()`

**Problem:** `task_complete()` is a simple status transition. It doesn't check whether the developer ran `workspace_run_typecheck()`, `workspace_run_acceptance_suite()`, or `workspace_collect_evidence()`. These tools exist and are available in every developer beat — but the LLM decides whether to call them. Nothing enforces it.

**What Goes Wrong:**
- Developer writes a component, decides it "looks right", calls `task_complete()` immediately
- Code has a type error on line 42 — but no typecheck was run
- Task moves to `code_complete` status
- CTO beat wakes (45–120s later), loads artifacts, sees no evidence of verification
- CTO runs typecheck manually, finds the error, sends task to rework
- Developer beat wakes again (30–60s later), gets the rework task
- **Total waste: 2–4 minutes + 3 LLM calls for a bug a 5-second typecheck would have caught**

**In worst case:** Developer writes code that passes typecheck but fails tests. No tests run until `final` verification phase — after CTO approves. Entire review cycle wasted.

**Fix — Enforce evidence before completion:**
```typescript
// In task_complete MCP tool handler:
async function handleTaskComplete(params: { taskId: string; evidenceArtifactIds?: string[] }) {
  // Gate: require at least one evidence artifact
  const evidence = await artifactsRepo.findByTaskAndKind(params.taskId, "evidence");
  if (!evidence && (!params.evidenceArtifactIds || params.evidenceArtifactIds.length === 0)) {
    return {
      ok: false,
      error: "Cannot complete task without evidence. Call workspace_collect_evidence() first, "
           + "which runs typecheck + tests and bundles proof artifacts."
    };
  }
  // ... existing completion logic
}
```

**Effort:** ~30 min. 10 lines in the MCP handler.

**Alternative (softer):** Don't block, but inject a warning into the beat context when `task_complete` is called without prior verification tool calls in the same session. The agent gets a "you didn't verify — are you sure?" nudge.

---

### 2.2 Pre-Review Verification Gate Is Too Weak

**Where:** `apps/api/src/sprints/verification-gate.ts`

**Problem:** The `pre_review` phase only runs `npm run build`. It does NOT run:

| Check | Pre-Review | Final | Gap |
|---|---|---|---|
| `npm run build` | ✅ | ✅ | — |
| `tsc --noEmit` | ❌ | via build | Type errors reach CTO |
| `npm test` | ❌ | ✅ | Test failures reach CTO |
| Preview health probe | ⚠️ warn only | ✅ fail | Broken preview reaches CTO |

**What Goes Wrong:**
1. Developer completes task. `pre_review` gate fires. Build passes (no TS errors in this case, but tests fail).
2. Sprint transitions to `reviewing`.
3. CTO loads the review context, doesn't see test failures (tests weren't run).
4. CTO approves based on build success + artifact description.
5. Sprint reaches `final` verification. Tests run. **Tests fail.**
6. All tasks sent back to rework. Sprint stalls.

The entire CTO review cycle was wasted because the pre_review gate didn't catch the test failure.

**Fix — Run full verification in pre_review:**
```typescript
export async function runVerificationGate(
  productDir: string,
  phase: "pre_review" | "final",
  config = DEFAULT_GATE_CONFIG
): Promise<VerificationGateResult> {
  // 1. Build (already exists)
  const buildRes = await runShell("npm", ["run", "build"], productDir, 120_000);
  if (buildRes.exitCode !== 0) {
    return { passed: false, phase, buildResult: buildRes };
  }

  // 2. Tests — run in BOTH phases (NEW)
  const pkg = JSON.parse(await readFile(join(productDir, "package.json"), "utf8"));
  if (pkg.scripts?.test) {
    const testRes = await runShell("npm", ["run", "test"], productDir, 120_000);
    if (testRes.exitCode !== 0) {
      return { passed: false, phase, testResult: testRes };
    }
  }

  // 3. Preview — fail in both phases if unreachable (CHANGED from warn-only)
  const probe = await probePreviewHealth(config.previewPort);
  if (!probe.reachable) {
    return { passed: false, phase, previewResult: probe };
  }

  return { passed: true, phase };
}
```

**Effort:** ~1 hr. Modify `verification-gate.ts` and adjust the phase conditional.

---

### 2.3 Memory System Fails Silently — Agent Gets Amnesia

**Where:** Beat context builder → Hippocampus retrieval call

**Problem:** When the Hippocampus `retrieve()` call throws (DB down, embedding service timeout, malformed query), the beat context builder catches the error and continues with an empty memory block. The agent prompt says nothing about memory being unavailable. The agent believes it has no relevant past experience.

**What Goes Wrong:**
- Sprint 1: Developer learns the project uses Tailwind CSS (stored as memory fact)
- Sprint 2: Hippocampus retrieval fails (transient DB timeout)
- Developer prompt has no memory section → agent picks CSS Modules (its training default)
- CTO review catches it ("we use Tailwind") → rework cycle
- Developer fixes it, but the *same failure* could happen in the next beat

**Fix — Two-part:**

**Part A: Inject warning into prompt**
```typescript
// In beat-context-builder.ts:
let memoryBlock: string;
try {
  const memories = await hippocampus.retrieve(taskContext);
  memoryBlock = formatMemoriesForPrompt(memories);
} catch (err) {
  observability.logEvent({ event: "memory.retrieval_failed", error: err.message, beatId });
  memoryBlock = "⚠️ MEMORY SYSTEM UNAVAILABLE\n"
    + "Your memory retrieval failed this beat. You may be missing important context.\n"
    + "Proceed carefully. If unsure about project conventions, ask via handoff to CTO.\n";
}
```

**Part B: Log retrievable metric**
```typescript
// Emit to audit bus so the operator dashboard shows memory health
observability.logEvent({
  event: "memory.retrieval_failed",
  beatId,
  agentRole: ctx.role,
  error: err instanceof Error ? err.message : String(err),
  severity: "warn",
});
```

**Effort:** ~30 min. Two changes in beat-context-builder.ts.

---

### 2.4 Skill Matching Is Token Overlap — Wrong Skills Get Injected

**Where:** `packages/company-runtime/src/skill-registry.ts`

**Problem:** `matchSkillsForTask(taskTitle)` uses `tokenOverlap(title, skill.keywords)` — split both strings into words, count how many overlap. This is purely lexical.

**Failure cases:**

| Task | Expected Skill Match | Actual Match | Why |
|---|---|---|---|
| "Build payment checkout" | `stripe-integration` | ❌ No match | Zero word overlap |
| "Add CSS animations" | `css-animations` | `css-grid-layout` ⚠️ | "CSS" overlaps |
| "Implement auth flow" | `oauth-setup` | ❌ No match | "auth" ≠ "oauth" |
| "Create REST API" | `fastify-api-patterns` | `rest-api-testing` ⚠️ | "REST" + "API" overlap |

**Impact:** 
- **No match:** Agent gets zero domain guidance. Falls back to LLM training data. May pick outdated or wrong patterns.
- **Wrong match:** Agent gets actively misleading guidance. Follows CSS Grid patterns when building animations.

**Fix — Embedding-based matching:**
```typescript
// Pre-compute skill embeddings at registry load time:
async function hydrateSkillEmbeddings(skills: Skill[]): Promise<void> {
  for (const skill of skills) {
    skill.embedding = await hippocampus.embed(
      `${skill.title} ${skill.description} ${skill.keywords.join(" ")}`
    );
  }
}

// At match time:
async function matchSkillsForTask(taskTitle: string, taskDescription: string): Promise<Skill[]> {
  const taskEmbedding = await hippocampus.embed(`${taskTitle} ${taskDescription}`);
  return skills
    .map(s => ({ skill: s, score: cosineSimilarity(taskEmbedding, s.embedding) }))
    .filter(s => s.score > 0.3)  // minimum relevance threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.skill);
}
```

**Effort:** ~2–3 hrs. Need to add embedding column/cache to skill registry, modify match function.

---

### 2.5 Developer Has No Self-Review Step

**Where:** `packages/company-runtime/src/roles.ts` — Developer ROLE_SOUL

**Problem:** The developer agent's system prompt tells it to claim tasks, write code, and call `task_complete()`. There is no instruction to **re-read its own changes** and verify them against the acceptance criteria before completing. The quality loop is entirely external (CTO + Tester catch problems). 

The LLM is capable of self-review — but it needs to be prompted to do it.

**What Goes Wrong:**
- Developer writes a React component, forgets to add a `key` prop in a `.map()` call
- Developer calls `task_complete()` immediately
- CTO review catches the warning → rework
- Fix takes 5 seconds, but the round-trip took 3 minutes

**Fix — Add self-review directive to developer ROLE_SOUL:**
```
## Pre-Completion Checklist

Before calling task_complete(), you MUST:

1. **Re-read every file you modified** — open each file and read it end-to-end
2. **Check against acceptance criteria** — compare your code against each DoD item:
   - If a criterion says "renders X", verify the JSX contains X
   - If a criterion says "validates Y", verify validation logic exists
   - If a criterion says "calls API Z", verify the API call is wired
3. **Run verification tools:**
   - workspace_run_typecheck() — must return 0 errors
   - workspace_run_acceptance_suite() — must pass (or explain why skipped)
4. **Check for placeholders** — search for TODO, FIXME, placeholder, lorem ipsum
5. **Collect evidence** — call workspace_collect_evidence() to bundle proof

If ANY check fails, fix it before completing. Do not complete with known issues.
```

**Effort:** ~30 min. Prompt-only change in `roles.ts`.

**Complementary to 2.1:** The hard gate (2.1) prevents completion without evidence. The self-review prompt (2.5) teaches the agent *why* and *how* to verify. Together they cover both enforcement and guidance.

---

## 3. High

### 3.1 CTO Reviews Descriptions, Not Actual Code

**Where:** CTO review beat context assembly

**Problem:** The CTO review prompt receives:
- Task metadata (title, DoD, status)
- Artifact summaries (kind, title, content — which is the developer's *description* of what they did)
- Build status (from verification gate)

It does **not** receive:
- The actual `git diff` of files changed
- File contents of modified files
- Line-by-line code review context

The CTO is reviewing a book report, not the book.

**What Goes Wrong:**
- Developer writes "Implemented login form with email validation" in artifact
- Actual code: form renders but validation is `if (email) return true` — accepts anything
- CTO reads artifact, sees "email validation" ✅, approves
- Tester catches it in QA (if they test thoroughly), or it reaches production

**Fix — Inject git diff into CTO review context:**
```typescript
// In CTO review beat context builder:
async function buildCtoReviewContext(ctx: BeatRenderContext): Promise<string> {
  const existing = renderReviewContext(ctx); // current implementation

  // Add code diff
  const diffResult = await runShell(
    "git", ["diff", "--no-color", "HEAD~1", "--", ".", ":(exclude)package-lock.json"],
    ctx.productDir,
    30_000
  );

  if (diffResult.exitCode === 0 && diffResult.stdout.length > 0) {
    // Truncate to fit context window (8K chars ≈ 2K tokens)
    const diff = diffResult.stdout.slice(0, 8000);
    const truncated = diffResult.stdout.length > 8000
      ? "\n... [diff truncated — review key files manually]"
      : "";

    return existing + "\n\n## Code Changes (git diff)\n```diff\n" + diff + truncated + "\n```\n";
  }

  return existing + "\n\n## Code Changes\nNo git diff available.\n";
}
```

**Effort:** ~2 hrs. Modify CTO review context builder + test that diff injection works.

**Context budget concern:** An 8K-char diff is ~2K tokens. With a typical CTO prompt at 3–4K tokens, this stays well within the 12K max structured output budget. For large diffs, the `--stat` summary (files changed, insertions, deletions) fits in 500 chars and still gives the CTO actionable info.

---

### 3.2 Rework Is Blind — Developer Doesn't Get Specific Failure Details

**Where:** Task rework transition + developer beat context builder

**Problem:** When a task enters rework, the developer gets:
- Task title and DoD (same as before)
- `reviewState.reworkCycleCount` incremented (so the developer knows it's cycle 2)
- Maybe a generic "changes requested" status

The developer does **NOT** reliably get:
- The specific QA findings ("email field accepts 'abc' without error")
- The CTO's review comments ("validation logic is incomplete")
- Which DoD items failed ("renders login form ✅, validates email ❌")

**What Goes Wrong:**
- QA report says: "Email field accepts 'abc' — should show 'Invalid email' error"
- Developer gets rework task but sees only: "Task: Build login form — rework cycle 2"
- Developer guesses what's wrong, adds a `required` attribute to the input (wrong fix)
- CTO reviews again → still fails → rework cycle 3
- Escalation fires → CTO takes over → fixes the actual validation → 15 minutes wasted

**Fix — Attach rework findings to the task:**
```typescript
// When transitioning task to rework:
async function transitionToRework(
  taskId: string,
  qaReport?: QAReport,
  ctoReview?: CtoReviewResult
): Promise<void> {
  const reworkGuidance = {
    cycle: (task.reviewState?.reworkCycleCount ?? 0) + 1,
    findings: qaReport?.tasks?.flatMap(t => t.findings) ?? [],
    ctoComments: ctoReview?.reasoning ?? null,
    failedCriteria: qaReport?.tasks?.flatMap(
      t => t.dodChecklist?.filter(c => c.status === "fail") ?? []
    ) ?? [],
  };

  await tasksRepo.update(db, taskId, {
    status: "in_progress",
    reworkGuidance: JSON.stringify(reworkGuidance),
    reviewState: {
      ...task.reviewState,
      reworkCycleCount: reworkGuidance.cycle,
    },
  });
}
```

**Then in beat context builder:**
```typescript
// When rendering a rework task:
if (task.reworkGuidance) {
  const guidance = JSON.parse(task.reworkGuidance);
  taskBlock += "\n\n## ⚠️ REWORK REQUIRED (Cycle " + guidance.cycle + ")\n";
  taskBlock += "### Specific Issues to Fix:\n";
  for (const finding of guidance.findings) {
    taskBlock += `- **${finding.defectArea}** (${finding.severity}): ${finding.description}\n`;
    taskBlock += `  Expected: ${finding.expected}\n`;
    taskBlock += `  Actual: ${finding.actual}\n`;
    taskBlock += `  Fix suggestion: ${finding.fixSuggestion}\n`;
  }
  taskBlock += "\n### Failed Acceptance Criteria:\n";
  for (const criteria of guidance.failedCriteria) {
    taskBlock += `- ❌ ${criteria.item}\n`;
  }
}
```

**Effort:** ~2–3 hrs. Schema change on task (add `reworkGuidance` text column), modify rework transition, modify beat context builder.

---

### 3.3 Tester Doesn't Create Tests When None Exist

**Where:** Tester ROLE_SOUL in `packages/company-runtime/src/roles.ts`

**Problem:** The tester agent calls `workspace_run_acceptance_suite()` which runs `npm test`. If the developer didn't write tests, the suite exits with "0 tests passed" — which is technically a pass. The tester then relies on LLM-based DoD walkthrough (reading the preview, checking criteria manually). This is subjective and doesn't produce regression coverage.

**What Goes Wrong:**
- Task: "Build contact form with email validation"
- Developer writes the form, no tests
- `npm test` → 0 tests, exit 0 → "passed"
- Tester does LLM walkthrough, says "looks good" (may miss edge cases)
- Sprint 2: Another developer refactors the form, breaks validation
- No test catches it → regression shipped

**Fix — Update tester ROLE_SOUL:**
```
## Test Creation Responsibility

When reviewing a task:

1. Run workspace_run_acceptance_suite() to see existing test coverage
2. If test output shows 0 tests or no test file for this feature:
   a. Write at least ONE test file covering the primary acceptance criterion
   b. Test file should live in `__tests__/` or `*.test.ts` alongside the source
   c. Test should verify the main happy path AND one error case
3. Run the test suite again after writing tests
4. Include test results (pass/fail) in the QA report
5. If your new test fails, this is a valid QA finding — file a bug_fix task

A task with 0 test coverage for its main feature should NOT pass QA.
```

**Effort:** ~30 min. Prompt-only change.

---

### 3.4 Meeting Pipeline Doesn't Verify Claims Against Ground Truth

**Where:** `packages/company-runtime/src/meeting-pipeline.ts` — facilitator synthesis step

**Problem:** In the synthesize step, the facilitator aggregates contributions from all agents. If the developer contributes "I completed tasks 1, 2, and 3", the facilitator includes this in the summary. It doesn't check whether tasks 1, 2, 3 are actually in `completed` status.

**Impact:** CEO reads meeting brief → believes sprint is 80% done → makes resource decisions based on this → sprint actually 40% done. Sprint planning proceeds with incorrect velocity assumptions.

**Fix — Inject ground truth into facilitator context:**
```typescript
// Before facilitator synthesis:
const sprintTasks = await tasksRepo.listBySprintHydrated(db, sprintId);
const taskSummary = sprintTasks.map(t => `${t.title}: ${t.status}`).join("\n");

const buildHealth = await runVerificationGate(productDir, "pre_review");

facilitatorPrompt += `\n## Ground Truth (verified from database — use this to validate claims)\n`;
facilitatorPrompt += `### Task Statuses:\n${taskSummary}\n`;
facilitatorPrompt += `### Build Health: ${buildHealth.passed ? "PASSING" : "FAILING"}\n`;
facilitatorPrompt += `\nIf any contribution contradicts this ground truth, note the discrepancy.\n`;
```

**Effort:** ~1–2 hrs.

---

### 3.5 Context Staleness Within Long Beats

**Where:** `apps/api/src/orchestration/run-beat.ts`, `beat-context-builder.ts`

**Problem:** `buildSnapshotView()` fires 12 parallel queries at beat start. The agent then operates for up to 15 minutes on this snapshot. During that time, other agents may have:
- Blocked a task the developer is about to claim
- Completed a dependency the PM doesn't see yet
- Reworked code the tester is about to verify

**Impact:** Agent wastes entire beat reasoning about stale state. The `FOR UPDATE` lock catches the race at write time, but the agent has already burned 30–120 seconds of LLM context on a task it can't actually claim.

**Fix — Fresh check at claim time:**
```typescript
// In task_claim MCP handler (add pre-check):
async function handleTaskClaim(params: { taskId: string }) {
  const freshTask = await tasksRepo.findById(getDb(), params.taskId);

  // Pre-check before acquiring lock
  if (!["planned", "created"].includes(freshTask.status)) {
    return {
      ok: false,
      error: `Task "${freshTask.title}" is now ${freshTask.status} (claimed by another agent). `
           + "Pick a different task."
    };
  }

  // ... existing FOR UPDATE lock + claim logic
}
```

This doesn't prevent all staleness (the snapshot is still stale for the prompt), but it prevents the most expensive case: claiming a task mid-beat and then failing at write time.

**Effort:** ~30 min.

---

### 3.6 Increase `maxConcurrentBeats` for Faster Iteration

**Where:** `ARCEUS_HEARTBEAT_MAX_CONCURRENT` env var (default: 1)

**Problem:** With `maxConcurrentBeats=1`, the Developer → CTO → Tester pipeline is strictly sequential. Each step waits for the previous beat to fully complete before the next agent can wake.

**Timeline with `maxConcurrentBeats=1` (5-task sprint):**
```
t=0:00  Developer claims task 1, writes code        (60-120s)
t=2:00  CTO reviews task 1                          (45-90s)
t=3:30  Tester QAs task 1                           (45-90s)
t=5:00  Developer claims task 2...
...
t=25:00 Sprint complete (5 tasks × 5 min each)
```

**Timeline with `maxConcurrentBeats=3`:**
```
t=0:00  Developer claims task 1 + PM plans task 6 + CTO reviews backlog  (parallel)
t=2:00  Developer claims task 2 + CTO reviews task 1 + Tester QAs task 0 (parallel)
...
t=10:00 Sprint complete (overlapping pipelines)
```

**Fix:** Set `ARCEUS_HEARTBEAT_MAX_CONCURRENT=3` in Railway env vars.

**Safety:** The `FOR UPDATE` locks prevent data corruption. OpenCode sessions are isolated per-beat. The semaphore already supports >1. The only prerequisite is increasing DB pool size (see reliability.md §2.3).

**Effort:** 5 seconds. One env var.

---

## 4. Medium

### 4.1 Structured Output Truncation — No Auto-Retry with Larger Budget

**Where:** `apps/api/src/infra/azure-openai.ts` — `structuredCompletion()`

**Problem:** When `finish_reason="length"`, `LlmTruncatedOutputError` is thrown. Only the CEO classifier has retry logic for this. Other callers (strategy generation, memory extraction, meeting synthesis) just fail.

**Fix:** Generic retry in `structuredCompletion()` with doubled `maxTokens`:
```typescript
if (choice.finish_reason === "length" && opts.maxTokens < 16_000) {
  return structuredCompletion(schema, messages, { ...opts, maxTokens: opts.maxTokens * 2 });
}
```

### 4.2 Beat Scoring Measures Activity, Not Quality

**Where:** Beat scoring system (event-bus introspection)

**Problem:** A beat that calls `task_complete()` with a broken implementation scores `pass` (it made an observable state change). A beat that carefully reads code for 5 minutes but decides not to complete (because acceptance criteria aren't met) scores `fail` (no state change). The scoring system rewards speed over quality.

**Fix:** Add retroactive quality signal:
- If a task enters `rework` after a beat's `task_complete()` → retroactively downgrade that beat's score to `partial`
- If a task passes QA first try after `task_complete()` → retroactively upgrade to `pass_clean`
- Feed `partial` / `pass_clean` into trust EMA with different weights

### 4.3 Trivial Fact Filter Is Regex — Misses Novel Noise

**Where:** `packages/hippocampus/src/` — `isTrivialFact()`

**Problem:** Hardcoded regex patterns (`/completed task/i`, `/working on/i`) filter obvious noise. But "I looked at the login form and it seemed fine" isn't caught — it has no pattern match.

**Fix:** LLM-based fact quality classifier during extraction:
```typescript
const isUseful = await structuredCompletion(
  z.object({ useful: z.boolean(), reason: z.string() }),
  [{ role: "user", content: `Is this fact useful for future development tasks?\nFact: "${fact}"` }],
  { maxTokens: 100 }
);
if (!isUseful.useful) skip;
```

### 4.4 Stale Habits Persist Indefinitely

**Where:** `packages/hippocampus/src/service.ts` — habit retrieval

**Problem:** Habits track EMA success but have no time-decay. A habit from Sprint 1 ("use Create React App") with `emaSuccess=0.9` outscores a Sprint 20 habit ("use Vite") with `emaSuccess=0.7`.

**Fix:** Time-decay on retrieval:
```typescript
const daysSince = (Date.now() - habit.lastTriggeredAt) / 86_400_000;
const decay = Math.exp(-0.03 * daysSince); // ~23-day half-life
const score = habit.emaSuccess * decay;
```

### 4.5 Same Model for All Roles — No Per-Role Optimization

**Where:** `apps/api/src/config/runtime.ts`

**Problem:** CEO planning and developer coding use the same deployment. Models have different strengths — reasoning-heavy models are better for planning, code-focused models for implementation.

**Fix:** Already partially supported (`CEO_DEPLOYMENT` vs `WORKER_DEPLOYMENT`). Extend to per-role if specific quality issues emerge with one role.

### 4.6 No Evidence of Test Writing in Developer Beat

**Where:** Developer ROLE_SOUL prompt

**Problem:** Developer is not instructed to write tests alongside implementation. Tests are treated as the Tester's responsibility. But the developer understands the implementation best and can write targeted unit tests faster.

**Fix:** Add to developer ROLE_SOUL:
```
When implementing a feature, write at least one test file covering:
- The main happy-path behavior
- One edge case or error case
Place tests in __tests__/ or *.test.ts next to the source file.
```

---

## 5. Architecture Strengths

Things that are already well-designed for output quality:

| Area | Implementation | Status |
|---|---|---|
| **Structured output enforcement** | Zod → JSON Schema → `strict: true` on all LLM calls | ✅ Excellent |
| **Tolerant JSON parsing** | Handles model commentary after JSON | ✅ Robust |
| **Role-based tool restrictions** | CEO can't write code, Tester can't write prod code | ✅ Well-implemented |
| **Trust-based tool gating** | Low-trust agents lose write/shell access | ✅ Multi-tiered |
| **Memory deduplication** | LLM action-decider (ADD/UPDATE/DELETE/NONE) on every completion | ✅ Smart |
| **Memory retrieval** | MMR-ranked (60% relevance, 40% diversity), top-K=5 | ✅ Good balance |
| **Bounded rework** | Max 3 cycles → CTO escalation (fix/skip/abort) | ✅ Prevents loops |
| **Beat hard cap** | 15-minute timeout, stale sweep at 30 minutes | ✅ Layered |
| **Mandatory roles** | CEO/CTO/PM/Dev/Tester/Skills always present | ✅ Deterministic |
| **Dependency blocking** | Agents see "⛔ NOT CLAIMABLE" for tasks with unmet deps | ✅ Clear signal |
| **Hallucinated task ID detection** | Beat context records shown task IDs; claims checked against list | ✅ Anti-hallucination |
| **Retry on Zod violation** | Hierarchy violations echo'd back with correction guidance | ✅ Smart retry |
| **CEO classifier fallback** | Truncation → retry with brevity rules → fallback card | ✅ 3-tier resilience |

---

## 6. Priority Action List

### This Week (Before Demo)

| # | Fix | Effort | Impact |
|---|---|---|---|
| 1 | Add self-review to developer ROLE_SOUL | 30 min | Catches obvious mistakes in-beat |
| 2 | Run typecheck + tests in `pre_review` gate | 1 hr | Stops broken code before CTO |
| 3 | Attach rework findings to task context | 2–3 hrs | Eliminates blind rework cycles |
| 4 | Set `ARCEUS_HEARTBEAT_MAX_CONCURRENT=3` | 5 sec | 2–3x faster sprint execution |
| 5 | Inject git diff into CTO review context | 2 hrs | CTO reviews real code |
| 6 | Warn on memory retrieval failure | 30 min | Prevents silent amnesia |
| 7 | Enforce evidence before `task_complete()` | 30 min | Hard gate on unverified completions |

### Next Sprint

| # | Fix | Effort | Impact |
|---|---|---|---|
| 8 | Embedding-based skill matching | 2–3 hrs | Correct domain guidance |
| 9 | Update tester ROLE_SOUL for test creation | 30 min | Regression coverage |
| 10 | Ground-truth injection in meeting pipeline | 1–2 hrs | Accurate status reporting |
| 11 | Retroactive beat quality scoring | 3–4 hrs | Trust reflects actual quality |
| 12 | Auto-retry on structured output truncation | 1 hr | Reliability for complex outputs |
