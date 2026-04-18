# Spec 18: Automated Code Review (Quality Gate)

> **Status:** DRAFT v1
> **Last updated:** 2026-04-15
> **Deferred from:** Spec 14 Phase 4 — standalone because it requires solving the code visibility problem first
> **Depends on:** Spec 14 Phases 1-3 (skill registry, mutation, ATA pipeline), Spec 02 (agent execution via OpenCode)
> **Required by:** nothing (standalone quality gate)
> **Enhances:** Spec 14 Phase 2 (provides additional failure signal via skill violation tracking)

---

## What This Is

Every line of code an agent writes goes through an automated review gate before it can progress. Critical issues block the step. Recurring skill violations trigger skill evolution. This is the immune system for agent-generated code.

---

## Why This Matters

```
WITHOUT code review:
  Beat 3: Developer writes API route with hardcoded database password
  Beat 5: Developer uses eval() to parse user JSON
  Beat 8: Developer ignores jwt-auth skill, uses deprecated library
  → All passes silently → reaches preview → reaches board review
  → Human catches it (maybe) → expensive rework
  → Same mistakes repeat because no signal feeds back to skills

WITH code review:
  Beat 3: Developer writes API route with hardcoded password
  → BLOCKED. "Critical: hardcoded secret on line 14. Use process.env.DB_PASSWORD."
  → Developer rewrites. Clean on retry.
  Beat 5: Developer uses eval()
  → BLOCKED. "Critical: eval() with user input. Use JSON.parse()."
  Beat 8: Developer uses deprecated library
  → WARN. Skill violation logged. (2nd occurrence)
  Beat 12: Same skill violated 3rd time
  → Skill mutation triggered → ATA rewrites skill → agents improve
```

---

## The Problem: Code Visibility

Today we are **blind** to what agents write. This is the prerequisite that must be solved before any review can happen.

### Current State (broken)

```
┌─────────────────────────────────────────────────────────┐
│                   DEVELOPER BEAT                         │
│                                                          │
│  runPromptText(role, session, system, prompt, tools)     │
│       │                                                  │
│       ▼                                                  │
│  OpenCode executes tool calls                            │
│       │                                                  │
│       ├── edit("src/api.ts", old, new)  ──► filePath ✓  │
│       │                                     content ✗   │
│       │                                     diff ✗      │
│       │                                                  │
│       ├── write("src/db.ts", content)   ──► filePath ✓  │
│       │                                     content ✗   │
│       │                                                  │
│       ├── bash("sed -i 's/foo/bar' x")  ──► command ✓   │
│       │                                     changes ✗   │
│       │                                                  │
│       ▼                                                  │
│  output = text response only                             │
│  filesModified = []  ◄── ALWAYS EMPTY                    │
│  git commits = 0     ◄── NO BASELINE, NO COMMITS         │
│                                                          │
│  Result: ZERO visibility into code changes               │
└─────────────────────────────────────────────────────────┘
```

**Evidence from codebase:**

| What | Where | Problem |
|------|-------|---------|
| `filesModified: []` | `orchestrator.ts:5816` | Always empty, never populated |
| Tool args discarded | `orchestrator.ts:5501-5514` | Only `filePath` extracted, content thrown away |
| No git HEAD | `workspace/.git` | Git initialized but zero commits — `git diff HEAD` fails |
| Single checkpoint | `orchestrator.ts:4411` | `syncWorkspaceCheckpoint` only called at preview validation |
| Text-only output | `orchestrator.ts:3450-3455` | `runPromptText` filters for `type: "text"` parts only |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     SPEC 18: CODE REVIEW PIPELINE                        │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  PHASE 1: CODE VISIBILITY                                        │    │
│  │                                                                   │    │
│  │  ┌─────────────────────┐    ┌──────────────────────────────┐     │    │
│  │  │  1A. Git Commit     │    │  1B. Tool Call Capture        │     │    │
│  │  │  Per Beat           │    │  (fine-grained)               │     │    │
│  │  │                     │    │                                │     │    │
│  │  │  before: HEAD sha   │    │  edit → filePath + old + new  │     │    │
│  │  │  after: git commit  │    │  write → filePath + content   │     │    │
│  │  │  diff: before..after│    │  bash → command (no content)  │     │    │
│  │  │                     │    │                                │     │    │
│  │  │  SOURCE OF TRUTH    │    │  ATTRIBUTION LAYER            │     │    │
│  │  │  (catches ALL edits │    │  (knows which tool call       │     │    │
│  │  │   including bash)   │    │   produced which change)      │     │    │
│  │  └─────────┬───────────┘    └──────────────┬───────────────┘     │    │
│  │            │                                │                     │    │
│  │            └───────────┬────────────────────┘                     │    │
│  │                        ▼                                          │    │
│  │              ┌─────────────────┐                                  │    │
│  │              │  Unified Diff   │                                  │    │
│  │              │  + File List    │                                  │    │
│  │              │  + Attribution  │                                  │    │
│  │              └────────┬────────┘                                  │    │
│  └───────────────────────┼──────────────────────────────────────────┘    │
│                          │                                               │
│  ┌───────────────────────┼──────────────────────────────────────────┐    │
│  │  PHASE 2: CODE REVIEW │                                          │    │
│  │                       ▼                                          │    │
│  │  ┌─────────────────────────────────────────────────────────┐     │    │
│  │  │  code-reviewer.ts (pure logic, DI pattern)              │     │    │
│  │  │                                                         │     │    │
│  │  │  reviewBeatOutput(beatId, diff, context)                │     │    │
│  │  │       │                                                 │     │    │
│  │  │       ▼                                                 │     │    │
│  │  │  deps.reviewCode(diff, context, matchedSkills)          │     │    │
│  │  │       │         ▲                                       │     │    │
│  │  │       │         │ LLM wiring in skill-evolution.ts      │     │    │
│  │  │       │         │ gpt-4o-mini, ~$0.003/call             │     │    │
│  │  │       ▼                                                 │     │    │
│  │  │  ReviewReport { status, findings[], skillViolations[] } │     │    │
│  │  └────────────────────────┬────────────────────────────────┘     │    │
│  │                           │                                      │    │
│  └───────────────────────────┼──────────────────────────────────────┘    │
│                              │                                           │
│  ┌───────────────────────────┼──────────────────────────────────────┐    │
│  │  PHASE 3: ENFORCEMENT     │                                      │    │
│  │                           ▼                                      │    │
│  │  ┌──────────────────────────────────────────────────────────┐    │    │
│  │  │                  DECISION GATE                            │    │    │
│  │  │                                                          │    │    │
│  │  │  CRITICAL finding?                                       │    │    │
│  │  │    YES → BLOCK step, return findings as rework feedback  │    │    │
│  │  │    NO  ↓                                                 │    │    │
│  │  │  HIGH finding?                                           │    │    │
│  │  │    YES → WARN, create CTO review artifact                │    │    │
│  │  │    NO  ↓                                                 │    │    │
│  │  │  MEDIUM/LOW?                                             │    │    │
│  │  │    → Log only, continue                                  │    │    │
│  │  │                                                          │    │    │
│  │  │  Skill violation count >= 3?                             │    │    │
│  │  │    YES → Trigger analyzeFailure() on that skill          │    │    │
│  │  │         (feeds into Spec 14 Phase 2 → Phase 3 ATA)      │    │    │
│  │  └──────────────────────────────────────────────────────────┘    │    │
│  │                                                                  │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Code Visibility

### 1A. Git Commit Per Beat (source of truth)

**Goal:** After every developer beat, we have a clean git diff of exactly what changed.

**How it works:**

```
                    DEVELOPER BEAT LIFECYCLE
                    ========================

    ┌─────────────────────────────────────────────┐
    │  1. BEFORE BEAT                              │
    │                                              │
    │  beforeSha = getHeadSha(productDir)          │
    │  if (!beforeSha) {                           │
    │    // First beat ever — create baseline      │
    │    beforeSha = commitAllChanges(             │
    │      productDir, "baseline: workspace init"  │
    │    );                                        │
    │  }                                           │
    └──────────────────┬──────────────────────────┘
                       │
                       ▼
    ┌─────────────────────────────────────────────┐
    │  2. EXECUTE BEAT                             │
    │                                              │
    │  output = runPromptText(...)                  │
    │  // Agent writes code via OpenCode tools     │
    │  // edit(), write(), patch(), bash()          │
    └──────────────────┬──────────────────────────┘
                       │
                       ▼
    ┌─────────────────────────────────────────────┐
    │  3. AFTER BEAT                               │
    │                                              │
    │  // Check if anything changed                │
    │  status = git status --porcelain             │
    │  if (status is empty) → skip (no changes)    │
    │                                              │
    │  afterSha = commitAllChanges(                │
    │    productDir,                               │
    │    "[Beat {beatId}] {task.title}"            │
    │  );                                          │
    │                                              │
    │  diff = diffFullContent(                     │
    │    productDir, beforeSha, afterSha           │
    │  );                                          │
    │  filesChanged = diffNameOnly(                │
    │    productDir, beforeSha, afterSha           │
    │  );                                          │
    └──────────────────┬──────────────────────────┘
                       │
                       ▼
    ┌─────────────────────────────────────────────┐
    │  4. REVIEW (Phase 2)                         │
    │                                              │
    │  report = reviewBeatOutput(beatId, diff, {   │
    │    taskId, taskTitle, beatId, filesChanged,   │
    │    assignedRole, companyId                    │
    │  });                                         │
    └─────────────────────────────────────────────┘
```

**New git-ops functions needed:**

```typescript
// Returns full unified diff content (not --stat)
export async function diffFullContent(
  workspacePath: string, fromRef: string, toRef: string,
): Promise<string>

// Returns list of changed file paths
export async function diffNameOnly(
  workspacePath: string, fromRef: string, toRef: string,
): Promise<string[]>
```

**Why git diff is the source of truth:**

```
  Tool call:  edit("src/api.ts", old, new)     → Git catches ✓
  Tool call:  write("src/db.ts", content)      → Git catches ✓
  Tool call:  bash("sed -i 's/foo/bar' x.ts")  → Git catches ✓
  Tool call:  bash("echo 'pwd=123' > .env")    → Git catches ✓
  Tool call:  bash("npm install express")      → Git catches ✓ (package.json)
  Manual SDK event with no args                → Git catches ✓

  Git misses nothing. It is filesystem truth.
```

### 1B. Tool Call Content Capture (attribution)

**Goal:** Know which specific tool call produced which file change.

**How it works:**

```
  ┌────────────────────────────────────────────────────────┐
  │  OpenCode Tool Event Handler (orchestrator.ts:5501)     │
  │                                                         │
  │  CURRENT:                                               │
  │    filePath = args.filePath        ← we keep this      │
  │    args.content                    ← DISCARDED          │
  │    args.old_string                 ← DISCARDED          │
  │    args.new_string                 ← DISCARDED          │
  │                                                         │
  │  NEW:                                                   │
  │    filePath = args.filePath                              │
  │    change = {                                           │
  │      tool: toolName,        // "edit" | "write" | ...  │
  │      filePath,                                         │
  │      content: args.content,           // write/patch   │
  │      oldString: args.old_string,      // edit          │
  │      newString: args.new_string,      // edit          │
  │      timestamp: Date.now(),                            │
  │    }                                                   │
  │    accumulateBeatFileChange(beatId, change)             │
  │                                                         │
  │  Stored in: beatFileChanges: Map<beatId, FileChange[]>  │
  │  Cleared after review completes for that beat.          │
  └────────────────────────────────────────────────────────┘
```

**FileChange type:**

```typescript
interface FileChange {
  tool: "edit" | "write" | "patch" | "apply_patch" | "bash";
  filePath: string;
  content?: string;        // for write/patch — full file content
  oldString?: string;      // for edit — the string being replaced
  newString?: string;      // for edit — the replacement
  command?: string;        // for bash — the command that modified files
  timestamp: number;
}
```

### Why Both Mechanisms?

```
  ┌──────────────────────────────────────────────────────────────┐
  │                    COMPARISON                                 │
  │                                                               │
  │  Mechanism        │ Granularity │ Reliable │ Catches bash? │  │
  │  ─────────────────┼─────────────┼──────────┼───────────────│  │
  │  Git diff         │ Per-beat    │ 100%     │ Yes           │  │
  │  Tool call args   │ Per-edit    │ ~90%     │ No            │  │
  │                                                               │
  │  Use git diff as SOURCE OF TRUTH for the code review LLM.    │
  │  Use tool call args for ATTRIBUTION in review findings.       │
  │                                                               │
  │  Example:                                                     │
  │    Git diff shows: +const API_KEY = "sk-proj-abc123"          │
  │    Tool args show: edit("src/config.ts", ...) at 14:32:05     │
  │    Review finding: "Hardcoded secret in src/config.ts:14,     │
  │                     introduced by edit tool call at 14:32:05" │
  └──────────────────────────────────────────────────────────────┘
```

---

## Phase 2: Code Review Engine

### Dependency Injection Pattern

Same pattern as `skill-mutator.ts` (Phase 2) and `skill-tester.ts` (Phase 3):

```
  ┌───────────────────────────────┐     ┌───────────────────────────┐
  │  company-runtime              │     │  apps/api                 │
  │  (pure logic, no LLM)        │     │  (LLM wiring)            │
  │                               │     │                           │
  │  code-reviewer.ts             │     │  skill-evolution.ts       │
  │  ├── CodeReviewerDeps iface   │◄────│  ├── setCodeReviewerDeps()│
  │  ├── reviewBeatOutput()       │     │  ├── CODE_REVIEW_PROMPT   │
  │  ├── shouldBlockStep()        │     │  ├── reviewReportSchema   │
  │  ├── shouldFlagForCTO()       │     │  └── gpt-4o-mini call     │
  │  └── trackSkillViolation()    │     │                           │
  │                               │     │                           │
  │  code-reviewer.test.ts        │     │  (not tested here —       │
  │  └── 100% testable with       │     │   tested via E2E)         │
  │      mock deps, no LLM       │     │                           │
  └───────────────────────────────┘     └───────────────────────────┘
```

### Interfaces

```typescript
export interface CodeReviewerDeps {
  reviewCode(
    diff: string,
    taskContext: TaskReviewContext,
    activeSkills: SkillArtifact[],
  ): Promise<ReviewReport>;
}

export interface TaskReviewContext {
  taskId: string;
  taskTitle: string;
  assignedRole: string;
  beatId: string;
  filesChanged: string[];
  companyId: string;
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "architecture" | "skill_violation" | "quality" | "performance";
  file: string;
  line: number | null;
  description: string;
  suggestion: string;
  skillId: string | null;
}

export interface ReviewReport {
  status: "pass" | "block" | "warn";
  findings: ReviewFinding[];
  skillViolations: string[];
  reviewedFiles: number;
  diffSizeChars: number;
}
```

### Pure Logic Functions

```typescript
// Decision functions — no LLM, fully testable
export function shouldBlockStep(report: ReviewReport): boolean {
  return report.findings.some(f => f.severity === "critical");
}

export function shouldFlagForCTO(report: ReviewReport): boolean {
  return report.findings.some(f => f.severity === "high");
}

// Diff budget management — large diffs get truncated for LLM
export function truncateDiffForReview(diff: string, maxChars: number = 12000): string {
  if (diff.length <= maxChars) return diff;
  // Keep first N chars + "... truncated" warning
  // Prioritize: new files first, then modified files, skip deleted files
}

// Skill violation tracking — in-memory counter per (companyId, skillId)
// Resets when the skill is mutated (version changes)
export function trackSkillViolation(
  companyId: string,
  skillId: string,
): { count: number; shouldTriggerMutation: boolean } {
  // Increment counter
  // Return shouldTriggerMutation = true when count >= 3
}

// Main orchestration function
export async function reviewBeatOutput(
  beatId: string,
  diff: string,
  context: TaskReviewContext,
): Promise<ReviewReport> {
  // 1. Truncate diff if needed
  // 2. Match skills for the task (from registry)
  // 3. Call deps.reviewCode(truncatedDiff, context, matchedSkills)
  // 4. For each skill_violation finding: trackSkillViolation()
  // 5. If any skill crossed threshold → trigger processTaskOutcome()
  // 6. Return report
}
```

### LLM Wiring

Added to `initSkillEvolution()` in `skill-evolution.ts`:

```typescript
setCodeReviewerDeps({
  async reviewCode(diff, context, activeSkills) {
    return structuredCompletion(
      "workerDeployment",         // gpt-4o-mini (~$0.003)
      [
        { role: "system", content: CODE_REVIEW_SYSTEM_PROMPT },
        { role: "user", content: buildCodeReviewPrompt(diff, context, activeSkills) },
      ],
      reviewReportSchema,
      "code_review",
      { temperature: 0.2 },       // low temperature for consistent reviews
    );
  },
});
```

### What The LLM Reviews

```
  ┌──────────────────────────────────────────────────────────────┐
  │  CODE REVIEW CATEGORIES                                       │
  │                                                               │
  │  SECURITY (→ critical/high)                                   │
  │  ├── Hardcoded secrets (API keys, passwords, tokens)          │
  │  ├── SQL injection (string concat in queries)                 │
  │  ├── XSS (unsanitized HTML, dangerouslySetInnerHTML)          │
  │  ├── eval() / Function() with external input                  │
  │  ├── Path traversal (user input in file paths)                │
  │  └── Insecure crypto (MD5, SHA1 for passwords)                │
  │                                                               │
  │  SKILL COMPLIANCE (→ high)                                    │
  │  ├── Agent used wrong library vs skill instruction            │
  │  ├── Agent skipped mandatory steps from skill                 │
  │  └── Agent violated skill's "Don't" section                   │
  │                                                               │
  │  ARCHITECTURE (→ medium)                                      │
  │  ├── Circular imports                                         │
  │  ├── Wrong layer access (UI importing DB directly)            │
  │  └── God files (>500 lines added in single file)              │
  │                                                               │
  │  QUALITY (→ low)                                              │
  │  ├── console.log left in production code                      │
  │  ├── TODO/FIXME/HACK comments                                 │
  │  └── Unused imports or variables                              │
  │                                                               │
  │  PERFORMANCE (→ low)                                          │
  │  ├── N+1 query patterns                                       │
  │  ├── Missing index hints in queries                           │
  │  └── Unbounded loops or recursion                             │
  └──────────────────────────────────────────────────────────────┘
```

---

## Phase 3: Enforcement (Orchestrator Integration)

### Decision Gate Flow

```
                        ReviewReport received
                              │
                              ▼
                    ┌─────────────────────┐
                    │ Any CRITICAL finding?│
                    └─────────┬───────────┘
                         YES  │  NO
                    ┌─────────┘  └──────────┐
                    ▼                        ▼
          ┌─────────────────┐     ┌─────────────────────┐
          │  BLOCK STEP     │     │ Any HIGH finding?    │
          │                 │     └─────────┬────────────┘
          │  - Don't mark   │          YES  │  NO
          │    complete     │     ┌─────────┘  └──────────┐
          │  - Return       │     ▼                        ▼
          │    findings as  │  ┌──────────────┐  ┌─────────────────┐
          │    rework       │  │  WARN         │  │  PASS            │
          │    feedback     │  │               │  │                  │
          │  - Developer    │  │  - Continue   │  │  - Continue      │
          │    must fix     │  │    execution  │  │    execution     │
          │    before       │  │  - Create CTO │  │  - Log findings  │
          │    proceeding   │  │    artifact   │  │    (if any)      │
          └─────────────────┘  │  - Log all    │  └──────────────────┘
                               │    findings   │
                               └──────────────┘
```

### Block Behavior Detail

When a step is blocked:

```
  Developer Beat N:
    Agent writes: const DB_PASS = "hunter2";
                                    │
                                    ▼
    Review: CRITICAL — hardcoded secret in src/db.ts:14
                                    │
                                    ▼
    Beat result: {
      summary: "Code review BLOCKED: 1 critical finding",
      blocked: true,
      reviewFindings: [{ severity: "critical", ... }]
    }
                                    │
                                    ▼
    Step NOT marked complete. Developer gets:
    "Your code has been blocked by automated review.
     CRITICAL: Hardcoded database password in src/db.ts:14.
     Fix: Use process.env.DB_PASSWORD instead.
     Rewrite the code to resolve this finding."
                                    │
                                    ▼
  Developer Beat N+1:
    Agent rewrites: const DB_PASS = process.env.DB_PASSWORD;
                                    │
                                    ▼
    Review: PASS — no findings
                                    │
                                    ▼
    Step proceeds normally.
```

---

## Skill Violation Feedback Loop

This is the connection back to Spec 14's self-evolution pipeline:

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                SKILL VIOLATION → MUTATION LOOP                    │
  │                                                                   │
  │  Beat 1:  skill "jwt-auth" says "use jose library"               │
  │           Developer uses jsonwebtoken instead                     │
  │           → skill_violation logged (count: 1)                     │
  │                                                                   │
  │  Beat 4:  Same skill, developer stores token in localStorage     │
  │           Skill says "use httpOnly cookies"                       │
  │           → skill_violation logged (count: 2)                     │
  │                                                                   │
  │  Beat 7:  Developer uses jsonwebtoken again                       │
  │           → skill_violation logged (count: 3) ◄── THRESHOLD       │
  │                                                                   │
  │           ┌─────────────────────────────────────────────┐         │
  │           │  Trigger: processTaskOutcome()               │         │
  │           │  with synthetic failure context:             │         │
  │           │                                              │         │
  │           │  {                                           │         │
  │           │    status: "failed",                         │         │
  │           │    reason: "Skill jwt-auth violated 3 times  │         │
  │           │            across beats. Violations:         │         │
  │           │            - wrong library (2x)              │         │
  │           │            - wrong storage (1x)"             │         │
  │           │  }                                           │         │
  │           └──────────────────┬──────────────────────────┘         │
  │                              │                                     │
  │                              ▼                                     │
  │           ┌──────────────────────────────────────────┐             │
  │           │  Spec 14 Phase 2: analyzeFailure()        │             │
  │           │  → "Skill is ambiguous about library       │             │
  │           │     choice and storage mechanism"          │             │
  │           └──────────────────┬───────────────────────┘             │
  │                              │                                     │
  │                              ▼                                     │
  │           ┌──────────────────────────────────────────┐             │
  │           │  Spec 14 Phase 2: proposeSkillMutation()  │             │
  │           │  → Rewrite skill with explicit:           │             │
  │           │    "MUST use jose (NOT jsonwebtoken)"     │             │
  │           │    "MUST store in httpOnly cookie"        │             │
  │           └──────────────────┬───────────────────────┘             │
  │                              │                                     │
  │                              ▼                                     │
  │           ┌──────────────────────────────────────────┐             │
  │           │  Spec 14 Phase 3: ATA Pipeline            │             │
  │           │  → TGA generates test scenarios           │             │
  │           │  → EAA dry-runs against new skill         │             │
  │           │  → ROA approves                           │             │
  │           │  → Skill v2 activated                     │             │
  │           └──────────────────┬───────────────────────┘             │
  │                              │                                     │
  │                              ▼                                     │
  │           Violation counter RESETS for this skill                   │
  │           Future beats use improved skill v2                       │
  │                                                                   │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Types (contracts/domain.ts)

```typescript
// ── Spec 18: Automated Code Review ──────────────────────

export const reviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["security", "architecture", "skill_violation", "quality", "performance"]),
  file: z.string(),
  line: z.number().nullable(),
  description: z.string(),
  suggestion: z.string(),
  skillId: z.string().nullable(),
});

export const reviewReportSchema = z.object({
  status: z.enum(["pass", "block", "warn"]),
  findings: z.array(reviewFindingSchema),
  skillViolations: z.array(z.string()),
  reviewedFiles: z.number(),
  diffSizeChars: z.number(),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;
```

---

## API Endpoints

```
GET  /api/reviews/:beatId              → ReviewReport for a specific beat
GET  /api/reviews/task/:taskId         → all ReviewReports for a task
GET  /api/reviews/violations           → skill violation leaderboard
GET  /api/reviews/violations/:skillId  → violation history for one skill
```

**Violation leaderboard response:**

```json
{
  "violations": [
    {
      "skillId": "skill-jwt-auth-v1",
      "skillName": "jwt-authentication",
      "count": 5,
      "lastViolatedAt": "2026-04-15T14:32:00Z",
      "mutationTriggered": true,
      "mutationId": "mutation-jwt-auth-1"
    }
  ]
}
```

---

## Implementation Phases

```
  Phase 1: Code Visibility          Phase 2: Review Engine         Phase 3: Enforcement
  ========================          ======================         ====================

  ┌──────────────────────┐         ┌──────────────────────┐       ┌──────────────────────┐
  │ 1. git-ops.ts:       │         │ 1. code-reviewer.ts: │       │ 1. orchestrator.ts:  │
  │    diffFullContent()  │         │    interfaces         │       │    wire review gate  │
  │    diffNameOnly()     │         │    reviewBeatOutput() │       │    after developer   │
  │                       │         │    shouldBlockStep()  │       │    beat completes    │
  │ 2. orchestrator.ts:  │         │    shouldFlagForCTO() │       │                      │
  │    git commit before  │         │    trackViolation()   │       │ 2. block/warn/pass   │
  │    git commit after   │         │    truncateDiff()     │       │    decision logic    │
  │    capture tool args  │         │                       │       │                      │
  │                       │         │ 2. skill-evolution.ts:│       │ 3. rework feedback   │
  │ 3. populate           │         │    review prompt      │       │    on block           │
  │    filesModified[]    │         │    Zod schema         │       │                      │
  │                       │         │    LLM wiring         │       │ 4. CTO artifact      │
  │                       │         │                       │       │    on warn             │
  │                       │         │ 3. contracts:         │       │                      │
  │                       │         │    types              │       │ 5. skill violation   │
  │                       │         │                       │       │    → mutation trigger │
  └──────────────────────┘         └──────────────────────┘       └──────────────────────┘

        Est: 1 day                       Est: 1 day                     Est: 1 day
```

**Total: ~3 days** (was 2 in Spec 14, added 1 day for the visibility layer which didn't exist before)

---

## Files to Create

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `packages/company-runtime/src/code-reviewer.ts` | Pure logic: review orchestration, violation tracking, block/flag decisions, diff truncation | ~180 |
| `packages/company-runtime/src/code-reviewer.test.ts` | Tests: block on critical, flag on high, pass on clean, violation counting, 3+ threshold, diff truncation | ~250 |

## Files to Modify

| File | Change | Impact |
|------|--------|--------|
| `apps/api/src/git-ops.ts` | Add `diffFullContent()`, `diffNameOnly()` | Low — 2 new functions |
| `apps/api/src/orchestrator.ts` | (1) Git commit before/after developer beat, (2) capture tool call args, (3) review gate, (4) populate `filesModified` | Medium — 4 insertion points |
| `apps/api/src/skill-evolution.ts` | Add `setCodeReviewerDeps` wiring, `CODE_REVIEW_PROMPT`, `buildCodeReviewPrompt()`, Zod schema | Low — additive |
| `packages/company-runtime/src/index.ts` | Export code-reviewer functions and types | Low — additive |
| `packages/contracts/src/domain.ts` | Add ReviewFinding + ReviewReport schemas and types | Low — additive |
| `apps/api/src/server.ts` | 4 review API endpoints | Low — additive |

---

## Cost Estimate

| Component | Model | Cost/call | Calls/sprint | Sprint cost |
|-----------|-------|-----------|-------------|-------------|
| Code review | gpt-4o-mini | ~$0.003 | 10-20 beats | $0.03-0.06 |
| Skill mutation (triggered by violations) | gpt-4o | ~$0.01 | 0-2 | $0.00-0.02 |
| ATA pipeline (for violation-triggered mutations) | mixed | ~$0.05 | 0-2 | $0.00-0.10 |

**Total: ~$0.03-0.18 per sprint** — negligible. The review itself is the cheapest part.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Beat produces no file changes | Skip review entirely (no diff = no review) |
| Diff > 12,000 chars | Truncate: prioritize new files, then modifications, skip deletions |
| Diff is only `node_modules` or `package-lock.json` | Exclude from review (gitignore-aware diff) |
| LLM review call fails | Log warning, continue without blocking (fail-open, not fail-closed) |
| Same file edited by multiple beats | Each beat gets its own diff (git commit per beat isolates changes) |
| Non-developer role (tester, CTO) writes code | Only developer beats trigger review (tester reads, CTO plans) |
| Review blocks a step 3+ times | After 3 blocks on same step, escalate to CTO meeting instead of looping |

---

## Verification Checklist

### Phase 1: Code Visibility
- [ ] Workspace gets initial commit on first developer beat (baseline)
- [ ] Before developer beat: HEAD sha recorded as `beforeSha`
- [ ] After developer beat: `git add -A && git commit` creates new commit
- [ ] `git diff --no-color beforeSha afterSha` returns full unified diff
- [ ] `git diff --name-only beforeSha afterSha` returns file path list
- [ ] Tool call args (`content`, `old_string`, `new_string`) captured per beat into `beatFileChanges` map
- [ ] `filesModified` in `cpCommitTaskResult` populated with actual file paths from diff
- [ ] No-change beats (agent only reads files) skip commit and review
- [ ] `node_modules`, `package-lock.json`, `.git` excluded from diff

### Phase 2: Code Review Engine
- [ ] `code-reviewer.ts` uses DI pattern (same as skill-mutator, skill-tester)
- [ ] Review runs after each developer beat that has a non-empty diff
- [ ] Hardcoded API key in diff → critical finding → `status: "block"`
- [ ] Wrong library vs skill instruction → high finding → `status: "warn"`, `category: "skill_violation"`
- [ ] Clean diff → `status: "pass"`, `findings: []`
- [ ] Large diff (>12000 chars) truncated before sending to LLM
- [ ] Review cost per beat: ~$0.003 (gpt-4o-mini)
- [ ] LLM failure → fail-open (log warning, don't block)

### Phase 3: Enforcement
- [ ] Critical finding blocks step — developer gets findings as rework feedback in next beat prompt
- [ ] High finding creates CTO review artifact but does NOT block
- [ ] Medium/low findings logged only (emitEmployeeActivity)
- [ ] Blocked step gets max 3 review-block retries before CTO escalation
- [ ] Review report stored and queryable via `GET /api/reviews/:beatId`

### Skill Feedback Loop
- [ ] Skill violation count tracked per (companyId, skillId) across beats
- [ ] Counter increments on each `category: "skill_violation"` finding
- [ ] 3+ violations of same skill → `processTaskOutcome()` triggered with synthetic failure
- [ ] Resulting mutation goes through ATA pipeline (Spec 14 Phase 3)
- [ ] After skill version changes (mutation merged), violation counter resets
- [ ] Violation leaderboard queryable via `GET /api/reviews/violations`

---

## Relationship to Spec 14

```
  Spec 14                              Spec 18
  ══════                              ═══════

  Phase 1: Skill Registry ─────────► Skills matched for review context
  Phase 2: Failure Attribution ◄────── 3+ violations trigger analyzeFailure()
  Phase 3: ATA Pipeline ◄────────── Violation-triggered mutations validated here
  Phase 4: DEFERRED ──────────────► THIS SPEC (Spec 18)
  Phase 5: Pattern Learning           (independent, no dependency)
  Phase 6: Cross-Sprint Transfer      (independent, no dependency)
```

Spec 18 is a **consumer** of Phases 1-3 (reads skills, triggers mutations, uses ATA) and a **producer** of failure signals (skill violations feed back into Phase 2). It does not block or depend on Phases 5-6.
