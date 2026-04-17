# Spec 14: Self-Evolution & Skill Learning

> **Status:** DRAFT v2
> **Last updated:** 2026-04-14
> **Depends on:** Spec 05a (Hippocampus — memory tiers, extraction), Spec 12 (Heartbeat — iterative cycles), Spec 13 (Governance — policy-gated mutation)
> **Absorbs:** Spec 05b PatternLearner + Habit Formation (memory intelligence pieces)
> **Enables:** Spec 15 (Long-Horizon), Spec 16 (Memory Consolidation), Spec 17 (Self-Healing)

---

## What This Is

Agents today are frozen. Their skills are Markdown files checked into the repo. If the Developer fails at JWT auth in Sprint 1, it fails the same way in Sprint 5. Hippocampus stores "JWT failed" as a memory, but doesn't fix the HOW — the procedural instructions the agent follows.

This spec gives agents four abilities:

1. **Diagnose** — trace failures to specific skills or skill gaps
2. **Evolve** — mutate failing skills, discover new ones, form habits from patterns
3. **Verify** — test mutations through a 3-agent pipeline before they go live
4. **Review** — automated quality gates on every code change before it reaches the board

The agents design themselves. But they do it safely, under governance.

---

## Why This Matters

```
WITHOUT self-evolution:
  Sprint 1: Developer writes auth. Gets JWT wrong. 3x rework.
  Sprint 2: Developer writes auth. Gets JWT wrong AGAIN. 3x rework.
  Sprint 5: Developer writes auth. Gets JWT wrong AGAIN.
  → Hippocampus says "JWT failed" but the skill still says "use jsonwebtoken"
  → Same failure, every sprint, forever.

WITH self-evolution:
  Sprint 1: Developer writes auth. Gets JWT wrong. 3x rework.
  → Failure Attribution: jwt-auth skill lacks refresh token handling
  → Skill Mutation: rewrite to use jose + refresh tokens
  → ATA Pipeline: 4/5 tests pass, edge case noted
  → Merge: skill v2 activated
  Sprint 2: Developer writes auth. Uses updated skill. First-time success.
  → 0 rework cycles. Pattern extracted. Habit formed.
  Sprint 5: Developer's auth skill is at v4. Success rate: 0.94.
```

---

## The Four Systems

```
┌──────────────────────────────────────────────────────────────────────┐
│                    SPEC 14: SELF-EVOLUTION                            │
│                                                                      │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐ │
│  │  SYSTEM 1:     │  │  SYSTEM 2:     │  │  SYSTEM 3:             │ │
│  │  SKILL         │  │  PATTERN       │  │  AUTONOMOUS            │ │
│  │  EVOLUTION     │  │  LEARNING      │  │  TESTING (ATA)         │ │
│  │                │  │                │  │                        │ │
│  │  Mutate        │  │  Extract       │  │  Test Generation       │ │
│  │  Discover      │  │  Cluster       │  │  Execution (dry-run)   │ │
│  │  Version       │  │  Evolve        │  │  Review + Verdict      │ │
│  │  Deprecate     │  │  Form habits   │  │  Recursive revision    │ │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────────────┘ │
│          │                   │                    │                   │
│          └───────────────────┼────────────────────┘                   │
│                              │                                        │
│  ┌───────────────────────────▼────────────────────────────────────┐  │
│  │  SYSTEM 4: AUTOMATED CODE REVIEW                               │  │
│  │                                                                │  │
│  │  Every code change → security + architecture + quality check   │  │
│  │  Findings block merge or flag for CTO review                   │  │
│  │  Review insights feed back into skill evolution                │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## System 1: Skill Evolution

### Skill Architecture

Skills transform from static Markdown files to **versioned, mutable, executable artifacts** stored in the Control Plane:

```
Skill Artifact:
  ┌────────────────────────────────────────────────────────────┐
  │ id:              "skill-jwt-auth-v3"                        │
  │ name:            "JWT Authentication Implementation"        │
  │ role:            "developer"                                │
  │ version:         3                                          │
  │ status:          "active"                                   │
  │                                                            │
  │ trigger:         "When implementing authentication or JWT" │
  │                                                            │
  │ content:         (Markdown — procedural instructions)       │
  │                  "## JWT Auth Pattern                       │
  │                   1. Use jose library (not jsonwebtoken)    │
  │                   2. Always implement refresh tokens        │
  │                   3. Store refresh in httpOnly cookie       │
  │                   4. Access token: 15 min, Refresh: 7 days │
  │                   5. Validate issuer + audience claims      │
  │                   6. RS256 for production, HS256 for dev"   │
  │                                                            │
  │ test_cases:      [{input, expected, validationCriteria}]   │
  │ success_rate:    0.87                                       │
  │ usage_count:     12                                         │
  │ mutated_from:    "skill-jwt-auth-v2"                        │
  │ mutation_reason: "v2 lacked refresh token handling"         │
  └────────────────────────────────────────────────────────────┘
```

### Types

```typescript
interface SkillArtifact {
  id: string;
  companyId: string;
  name: string;
  role: string;
  version: number;
  status: "draft" | "testing" | "active" | "deprecated";
  trigger: string;
  content: string;                    // Markdown procedural instructions
  testCases: SkillTestCase[];
  successRate: number;                // 0.0 - 1.0, updated on each use
  usageCount: number;
  lastUsedAt: string | null;
  mutatedFromId: string | null;
  mutatedBy: string | null;
  mutationReason: string | null;
  createdAt: string;
  approvedAt: string | null;
}

interface SkillTestCase {
  id: string;
  description: string;
  input: string;                      // task scenario
  expectedBehavior: string;
  validationCriteria: string[];       // concrete checks
}

interface SkillMutation {
  id: string;
  companyId: string;
  originalSkillId: string | null;     // null for new skills (discovery)
  proposedSkill: SkillArtifact;
  reason: string;
  failureTraceId: string | null;
  status: "proposed" | "testing" | "approved" | "rejected" | "revision" | "merged";
  revisionCycle: number;              // 0 = first attempt, max 2
  testResults: SkillTestResult[];
  reviewFeedback: string | null;      // from ATA rejection, used for revision
  proposedBy: string;
  proposedAt: string;
  resolvedAt: string | null;
}

interface SkillTestResult {
  testCaseId: string;
  status: "pass" | "fail" | "error";
  output: string;
  durationMs: number;
  executedAt: string;
}
```

### The Reflective Learning Loop

Triggered when a task reaches terminal state (completed or failed).

```
Task completes or fails
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 1: FAILURE ATTRIBUTION                                         │
│                                                                     │
│ Input:  Task outcome + execution trace + artifacts + rework count   │
│ Ask:    "Did the agent's procedural skills contribute to this       │
│          outcome? If failure or high rework: what specific skill    │
│          or missing skill caused the problem?"                      │
│                                                                     │
│ Output: FailureAttribution                                          │
│   {                                                                 │
│     taskId, outcome,                                                │
│     attributedSkillId: "skill-jwt-auth-v2" | null,                 │
│     failureMode: "missing_refresh_tokens",                          │
│     confidence: 0.85,                                               │
│     suggestedFix: "Add refresh token handling",                     │
│     isSkillGap: false     // true if NO skill exists                │
│   }                                                                 │
│                                                                     │
│ LLM: gpt-4o-mini (~500 tokens, ~$0.003)                            │
│                                                                     │
│ ALSO TRIGGERS ON SUCCESS:                                           │
│   If task completed with 0 rework and used a skill → increment     │
│   success_rate. No mutation needed.                                  │
│   If task completed after 3+ rework cycles → treat as "high        │
│   friction" and propose optimization even though it succeeded.      │
└─────────────────────────────────────────────────────────────────────┘
         │
         ├─── Skill failure ───────────── Skill gap ─────────────┐
         │    (existing skill wrong)      (no skill for task)     │
         ▼                                                        ▼
┌─────────────────────────┐              ┌─────────────────────────┐
│ Step 2A: SKILL MUTATION │              │ Step 2B: SKILL DISCOVERY│
│                         │              │                         │
│ Load original skill     │              │ Generate new skill from │
│ Apply failure context   │              │ task context + outcome  │
│ LLM rewrites content   │              │ LLM creates content     │
│ Preserve trigger        │              │ Define trigger          │
│ Increment version       │              │ Version = 1             │
│ Generate test cases     │              │ Generate test cases     │
│                         │              │                         │
│ LLM: gpt-4o            │              │ LLM: gpt-4o            │
│ (~1000 tokens, ~$0.01) │              │ (~1500 tokens, ~$0.015)│
└────────────┬────────────┘              └────────────┬────────────┘
             │                                        │
             └──────────────┬─────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 3: GOVERNANCE CHECK (Spec 13)                                  │
│                                                                     │
│ PolicyEngine.evaluate({                                              │
│   tool: "skill_mutate",                                              │
│   parameters: { skillId, proposedChanges, reason, mutationCount }   │
│ })                                                                   │
│                                                                     │
│ Checks:                                                              │
│  - Agent mutating own role's skills (or is Skills Lead)             │
│  - Content doesn't contain shell commands or system calls            │
│  - Mutation count within per-sprint limits (max 5)                  │
│  - Agent trust score >= 0.5                                          │
│                                                                     │
│ DENY → mutation rejected, logged to audit                           │
│ ALLOW → proceed to ATA pipeline                                     │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 4: ATA PIPELINE (see System 3 below)                           │
└─────────────────────────────────────────────────────────────────────┘
                            │
               ┌────────────┼─────────────────┐
               │            │                  │
            APPROVE       REJECT            REVISE
               │            │                  │
               ▼            │                  ▼
┌──────────────────┐        │    ┌──────────────────────────────────┐
│ Step 5A: MERGE   │        │    │ Step 5C: RECURSIVE REVISION       │
│                  │        │    │                                    │
│ Deprecate old    │        │    │ Feed rejection reason + ATA        │
│ Activate new     │        │    │ feedback back to Step 2.           │
│ Update rates     │        │    │ LLM revises the skill using       │
│ Audit ledger     │        │    │ the specific failure.             │
│ Notify Skills    │        │    │                                    │
│ Lead             │        │    │ Max 2 revision cycles.            │
└──────────────────┘        │    │ If still fails after 2 →          │
                            │    │ REJECT and log for next sprint.   │
                            ▼    │                                    │
               ┌──────────────┐  │ LLM: gpt-4o (~800 tokens, ~$0.008│
               │ Step 5B:     │  └──────────────────────────────────┘
               │ REJECT + LOG │
               │              │
               │ Log failure   │
               │ Increment     │
               │ failure count │
               │ Queue for     │
               │ next sprint   │
               └──────────────┘
```

### Triggers for Evolution

| Trigger | When | What Happens | Cost |
|---------|------|-------------|------|
| **Task failure** | Immediately after task fails | Attribute → propose mutation → ATA | ~$0.05 |
| **High friction** | Task completed after 3+ rework cycles | Attribute → propose optimization | ~$0.05 |
| **Skills Lead heartbeat** | Every 2 minutes (proactive) | Check skill health → initiate mutation for worst performer | ~$0.05 |
| **Cross-sprint transfer** | Sprint N completes | Review Sprint N patterns → propose new skills for Sprint N+1 | ~$0.08 |
| **Automated review finding** | Code review detects pattern violation | Attribute to skill gap → propose skill | ~$0.05 |

### Cross-Sprint Skill Transfer (New)

When Sprint N completes, the system doesn't wait for Sprint N+1 to fail before creating skills. It proactively identifies patterns:

```
Sprint N completes
    │
    ▼
Analyze all Sprint N task outcomes:
  - What patterns repeated 3+ times? (e.g., "always add Zod validation")
  - What new tools/libraries were used? (e.g., "first time using Stripe")
  - What decisions were made that future sprints should know?
    │
    ▼
For each pattern with frequency >= 3:
  - Check if a matching skill already exists
  - If not: create candidate skill (status: "draft")
  - Queue for ATA pipeline validation
  - If passes: activate for Sprint N+1
    │
    ▼
Result: Sprint N+1 Developer starts with skills the
company EARNED in Sprint N. No failure required.
```

LLM: gpt-4o (~2000 tokens for pattern analysis, ~$0.02)

---

## System 2: Pattern Learning & Habit Formation

> Absorbed from Spec 05b (Hippocampus Intelligence — PatternLearner + Habit Formation)

### What Patterns Are

Patterns are rare, high-value insights extracted from successful task trajectories. They're different from memories (facts) and skills (procedures):

| Construct | What | Example | Storage |
|-----------|------|---------|---------|
| **Memory** | A fact | "We use Next.js 15" | pgvector (Spec 05a) |
| **Skill** | A procedure | "How to implement JWT auth" | skill_artifacts table |
| **Pattern** | A deep lesson | "Zod validation on every API route prevents 80% of input bugs" | patterns table (Spec 04) |
| **Habit** | An auto-trigger | "When writing API routes → add Zod validation" | habits table (Spec 04) |

### PatternLearner

Runs during Phase 4 (Serialization) of heartbeat, async. Extracts patterns from successful trajectories.

```typescript
class PatternLearner {
  clusters: PatternCluster[];     // Dynamic k-means (min(50, ceil(n/5)))

  async extractPattern(trajectory: TaskTrajectory): Promise<Pattern | null> {
    // Quality filter: only from tasks with quality >= 0.5
    // Duplicate check: skip if >95% cosine similar to existing pattern
    // Create: embedding = weighted avg of steps, strategy from actions
    // Assign to nearest cluster (or create new if <0.7 similarity)
  }

  async evolvePattern(pattern: Pattern, quality: number): Promise<void> {
    // EMA update: successRate = rate * (1-lr) + quality * lr
    // Track: improvement (+5%), prune (-15%), merge (>90% sim), split
  }

  async consolidatePatterns(): Promise<void> {
    // Merge: >90% similarity in same domain → weighted average
    // Split: create 2+ specialized sub-patterns with 10% noise
    // Prune: quality * log(usage) below 20th percentile → delete
  }
}
```

### Habit Formation (Pattern → Procedural Memory)

When a pattern proves itself (high usage + high success), it becomes a habit — an auto-triggered behavior injected directly into the agent's system prompt:

```
Pattern: "Zod validation on API routes prevents input bugs"
  usage_count: 14
  success_rate: 0.91
  
  14 uses × 0.91 success → EXCEEDS threshold (usage >= 10, success >= 0.8)
  
  → AUTO-FORM HABIT:
    trigger_condition: "When writing API routes"
    action: "Always add Zod input validation with typed schemas"
    confidence: 0.91
    formation_mode: "auto" (from pattern) or "explicit" (from LLM extraction)
    
  → Habit injected into Developer's prompt on matching tasks
  → No LLM call needed — trigger matching already exists in Spec 05a
```

Two formation paths:
- **Path 1 (auto):** Pattern meets threshold → auto-form habit. No LLM needed.
- **Path 2 (explicit):** LLM extracts procedure from conversation (mem0 pattern). e.g., CEO says "always validate with users before building" → procedural memory.

### Pattern → Skill Promotion

When a pattern is strong enough AND there's no existing skill covering it, the PatternLearner proposes a new skill:

```
Pattern: "Supabase RLS policies require auth.uid() check on every table"
  usage_count: 8
  success_rate: 0.88
  No matching skill exists for "Supabase RLS"
  
  → Propose new skill via Skill Discovery (Step 2B)
  → ATA validates
  → New skill: "Supabase RLS Patterns" (v1)
```

This connects Pattern Learning (System 2) to Skill Evolution (System 1). Patterns are the raw material, skills are the refined product.

---

## System 3: Autonomous Testing Architecture (ATA)

The ATA is a 3-agent pipeline that evaluates skill mutations in isolation. This is NOT the product's test suite — it's a meta-level quality gate for the skill system itself.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ATA PIPELINE                                      │
│                                                                     │
│  Input: SkillMutation (proposed skill change)                       │
│  Output: APPROVE | REJECT | REVISE (with feedback for revision)     │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ AGENT 1: Test Generation Agent (TGA)                       │     │
│  │                                                            │     │
│  │ Input:                                                     │     │
│  │   - Original skill (if mutation)                           │     │
│  │   - Proposed skill content                                 │     │
│  │   - Failure context that triggered mutation                │     │
│  │   - Skill's trigger condition                              │     │
│  │                                                            │     │
│  │ Output: 3-5 test scenarios                                 │     │
│  │   [{                                                       │     │
│  │     scenario: "Build JWT auth with refresh tokens",        │     │
│  │     taskPrompt: "Implement auth endpoints using jose...",  │     │
│  │     expectedOutcomes: [                                    │     │
│  │       "Creates /api/auth/login endpoint",                  │     │
│  │       "Creates /api/auth/refresh endpoint",                │     │
│  │       "Uses httpOnly cookie for refresh token",            │     │
│  │     ],                                                     │     │
│  │     edgeCases: [                                           │     │
│  │       "Expired refresh token returns 401",                 │     │
│  │       "Invalid token signature returns 403"                │     │
│  │     ]                                                      │     │
│  │   }]                                                       │     │
│  │                                                            │     │
│  │ LLM: gpt-4o-mini (~800 tokens, ~$0.005)                   │     │
│  └──────────────────────────┬─────────────────────────────────┘     │
│                             ▼                                        │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ AGENT 2: Execution Agent (EAA)                             │     │
│  │                                                            │     │
│  │ For each test scenario:                                    │     │
│  │   1. Load proposed skill content into agent context        │     │
│  │   2. Present the task prompt                               │     │
│  │   3. Ask agent to describe what it would do (dry-run)      │     │
│  │   4. Evaluate: does the plan match expected outcomes?       │     │
│  │                                                            │     │
│  │ WHY dry-run:                                               │     │
│  │   - Skills are procedural guidance, not executable code    │     │
│  │   - Real execution requires a full workspace sandbox       │     │
│  │   - Dry-run validates the skill steers the agent correctly │     │
│  │   - Real build verification happens in the actual sprint   │     │
│  │                                                            │     │
│  │ Output: Per-scenario results                               │     │
│  │   [{ testId, agentPlan, outcomeMatches: [bool],           │     │
│  │      edgeCaseMatches: [bool], notes }]                     │     │
│  │                                                            │     │
│  │ LLM: gpt-4o (~2000 tokens per scenario, ~$0.02)           │     │
│  └──────────────────────────┬─────────────────────────────────┘     │
│                             ▼                                        │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ AGENT 3: Review Agent (ROA)                                │     │
│  │                                                            │     │
│  │ Evaluation criteria:                                       │     │
│  │   - Does mutation fix the original failure? (required)     │     │
│  │   - Do all core outcomes pass? (required)                  │     │
│  │   - Do edge cases pass? (nice-to-have, not blocking)       │     │
│  │   - Is skill content clear and actionable? (required)      │     │
│  │   - Any security risks? (required)                         │     │
│  │                                                            │     │
│  │ Output: ReviewVerdict                                      │     │
│  │   {                                                        │     │
│  │     verdict: "approve" | "reject" | "revise",              │     │
│  │     overallScore: 0.85,                                    │     │
│  │     fixesOriginalFailure: true,                            │     │
│  │     coreOutcomesPassing: 4/4,                              │     │
│  │     edgeCasesPassing: 1/2,                                 │     │
│  │     securityConcerns: [],                                  │     │
│  │     revisionGuidance: "Handle invalid signature case"      │     │
│  │   }                                                        │     │
│  │                                                            │     │
│  │ REVISE verdict: ROA provides specific feedback that gets   │     │
│  │ fed back to Step 2 for a revision attempt. Max 2 cycles.   │     │
│  │                                                            │     │
│  │ LLM: gpt-4o-mini (~600 tokens, ~$0.004)                   │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                     │
│  Total per mutation: ~$0.04-0.08                                    │
│  With 1 revision cycle: ~$0.08-0.14                                 │
│  Duration: ~30-90 seconds (3-6 sequential LLM calls)                │
└─────────────────────────────────────────────────────────────────────┘
```

### Recursive Revision (New)

When ATA returns `revise`:

```
ROA verdict: "revise"
ROA feedback: "Skill handles happy path but doesn't address
              expired refresh token edge case. Add step for
              token expiry validation."
    │
    ├── revisionCycle < 2?
    │       │
    │      YES → Feed feedback to Step 2A (Skill Mutation)
    │             LLM sees: original skill + failure context
    │             + PREVIOUS attempt + ROA rejection reason
    │             Produces: improved skill v3.1
    │             → Run ATA again
    │
    │      NO → Final REJECT. Log all attempts.
    │            Queue for next sprint with accumulated context.
    │            Skills Lead picks it up proactively.
    │
    └── Why limit to 2: Prevents runaway self-modification.
        If 3 attempts can't fix it, the problem needs human
        insight or more context from future sprints.
```

---

## System 4: Automated Code Review

> From Cursor/Aman: "Agents doing code review on every PR, finding security vulnerabilities."

Every code change from any agent gets an automated review BEFORE it reaches the preview or board review stage. This is a quality gate, not a human review replacement.

### When It Runs

```
Developer completes a step in the step loop
    │
    ▼
AUTOMATED REVIEW runs (parallel, non-blocking to execution)
    │
    ├── Security scan
    │     "Any hardcoded secrets? SQL injection? XSS vectors?"
    │
    ├── Architecture compliance
    │     "Does this follow the CTO's plan? Are file paths correct?
    │      Does it use the approved tech stack?"
    │
    ├── Skill compliance
    │     "Did the agent follow the active skills for this role?
    │      If jwt-auth skill says 'use jose' and code uses
    │      jsonwebtoken, flag it."
    │
    └── Code quality
          "Dead code? Unused imports? Missing error handling?
           Console.log left in production code?"

Output: ReviewReport
  {
    status: "pass" | "warn" | "block",
    findings: [
      { severity: "critical" | "high" | "medium" | "low",
        category: "security" | "architecture" | "skill" | "quality",
        description: "Hardcoded API key in src/lib/stripe.ts",
        file: "src/lib/stripe.ts",
        line: 14,
        suggestion: "Use environment variable STRIPE_API_KEY" }
    ],
    skillViolations: [
      { skillId: "skill-api-patterns-v2",
        rule: "Use environment variables for all API keys",
        violation: "Hardcoded key found" }
    ]
  }
```

### What Happens With Findings

| Severity | Action |
|----------|--------|
| **Critical** (secrets, injection) | BLOCK — Developer must fix before proceeding. Step loops back. |
| **High** (wrong architecture, skill violation) | WARN — flagged in CTO review artifact. CTO decides. |
| **Medium** (code quality) | NOTE — logged in audit. Included in sprint summary. |
| **Low** (style, unused imports) | SILENT — logged but not surfaced. Cleaned up in Night Shift (Spec 17). |

### Feedback Loop to Skill Evolution

Review findings feed back into System 1:

```
Automated review finds: "Developer used jsonwebtoken instead of jose"
    │
    ▼
This is a SKILL VIOLATION:
  skill-jwt-auth-v3 says "Use jose library"
  Developer ignored it
    │
    ├── Is this a one-time miss? → just flag in review
    │
    └── Has this happened 3+ times? → skill trigger needs improvement
        → SkillMutator.analyzeHighFriction()
        → Maybe the trigger condition is too vague
        → Propose trigger refinement: "When implementing JWT"
           → "When implementing JWT or any token-based auth"
```

### Cost

Review runs on gpt-4o-mini — it's pattern matching, not creative reasoning:
- Per step review: ~$0.005 (500 tokens)
- Per sprint (8-12 steps): ~$0.04-0.06
- Negligible vs skill mutation costs

---

## Skill Registry

```typescript
interface SkillRegistry {
  /** Get all active skills for a role. */
  getSkillsForRole(companyId: string, role: string): Promise<SkillArtifact[]>;

  /** Find skills matching a task description (trigger matching). */
  matchSkills(
    companyId: string,
    role: string,
    taskDescription: string
  ): Promise<SkillArtifact[]>;

  /** Register a new skill (from discovery or cross-sprint transfer). */
  registerSkill(skill: SkillArtifact): Promise<void>;

  /** Update a skill (from mutation — must pass ATA first). */
  updateSkill(skillId: string, updates: Partial<SkillArtifact>): Promise<void>;

  /** Deprecate a skill. */
  deprecateSkill(skillId: string, reason: string): Promise<void>;

  /** Get version history for a skill. */
  getSkillHistory(skillId: string): Promise<SkillArtifact[]>;

  /** Get skill health metrics across the company. */
  getSkillHealth(companyId: string): Promise<SkillHealthReport>;
}

interface SkillHealthReport {
  totalSkills: number;
  activeSkills: number;
  averageSuccessRate: number;
  worstPerformers: Array<{ skill: SkillArtifact; issues: string[] }>;
  gaps: Array<{ taskPattern: string; frequency: number; suggestedSkill: string }>;
  recentMutations: SkillMutation[];
  habitsFormed: number;
  patternsExtracted: number;
}
```

---

## Skill Usage in Heartbeat

Skills are loaded during Phase 1 (Context Assembly) and injected into the agent's prompt:

```
Phase 1 (Context Assembly):
  1. Load agent SOUL
  2. Load task details
  3. Load Hippocampus context (memories + habits + priming) [Spec 05a]
  4. SkillRegistry.matchSkills(companyId, role, task.description)
     → Returns: 0-3 matching skills (by trigger relevance)
  5. Inject into prompt:

     "## Relevant Skills
      The following procedural skills are available for this task:

      ### JWT Authentication Implementation (v3, success: 87%)
      Trigger: When implementing authentication or JWT tokens
      [full skill content]

      ### API Route Patterns (v2, success: 92%)
      Trigger: When creating API endpoints
      [full skill content]"

Phase 3 (Execute):
  Agent uses skills as procedural guidance.
  
Phase 4 (Serialize):
  Track skill usage: usageCount++
  Track outcome: update successRate
  If failure: trigger reflective learning loop (System 1)
  If success: extract patterns (System 2)
  Run automated review on any code changes (System 4)
```

---

## Database Schema

```sql
-- Skill artifacts (versioned, mutable)
CREATE TABLE skill_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  trigger_condition TEXT NOT NULL,
  content TEXT NOT NULL,
  test_cases JSONB NOT NULL DEFAULT '[]',
  success_rate REAL NOT NULL DEFAULT 0.5,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  mutated_from_id UUID REFERENCES skill_artifacts(id),
  mutated_by TEXT,
  mutation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  UNIQUE(company_id, name, version)
);

CREATE INDEX idx_skills_role ON skill_artifacts(company_id, role, status);
CREATE INDEX idx_skills_active ON skill_artifacts(company_id, status)
  WHERE status = 'active';

-- Skill mutations (proposed changes with revision tracking)
CREATE TABLE skill_mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  original_skill_id UUID REFERENCES skill_artifacts(id),
  proposed_skill_id UUID NOT NULL REFERENCES skill_artifacts(id),
  reason TEXT NOT NULL,
  failure_trace_id UUID,
  status TEXT NOT NULL DEFAULT 'proposed',
  revision_cycle INTEGER NOT NULL DEFAULT 0,
  test_results JSONB NOT NULL DEFAULT '[]',
  review_feedback TEXT,
  proposed_by UUID NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_mutations_status ON skill_mutations(company_id, status);

-- Automated review findings
CREATE TABLE review_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  task_id UUID NOT NULL,
  sprint_id UUID,
  agent_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pass',
  findings JSONB NOT NULL DEFAULT '[]',
  skill_violations JSONB NOT NULL DEFAULT '[]',
  total_findings INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reviews_task ON review_findings(company_id, task_id);
CREATE INDEX idx_reviews_critical ON review_findings(company_id)
  WHERE critical_count > 0;
```

---

## Migration: Existing Skills → Skill Registry

The 6 existing Markdown skill files get seeded into the registry on first boot:

```typescript
async function seedExistingSkills(companyId: string, registry: SkillRegistry) {
  const existingSkills = [
    { name: "Developer Coding Patterns",   role: "developer",    file: "developer/SKILL.md" },
    { name: "Testing Strategies",          role: "tester",       file: "tester/SKILL.md" },
    { name: "UI Design Patterns",          role: "ui_designer",  file: "ui-designer/SKILL.md" },
    { name: "Marketing Playbook",          role: "marketing",    file: "marketing/SKILL.md" },
    { name: "Skills Packaging Guidelines", role: "skills_lead",  file: "skills-lead/SKILL.md" },
    { name: "Apple Design System",         role: "ui_designer",  file: "apple-design-system/SKILL.md" },
  ];

  for (const s of existingSkills) {
    const content = await readFile(
      join("packages/company-runtime/skills", s.file), "utf-8"
    );
    await registry.registerSkill({
      // ... seed with version: 1, status: "active", successRate: 0.7
    });
  }
}
```

---

## Governance Policies

```typescript
const SKILL_POLICIES: PolicyRule[] = [
  {
    id: "skill-mutate-own-role",
    name: "Agents can only mutate their own role's skills",
    priority: 2,
    tools: ["skill_mutate", "skill_discover"],
    condition: (ctx) => {
      const targetRole = ctx.toolParameters["targetRole"];
      if (ctx.agentRole === "skills_lead") return false; // exempt
      return targetRole !== ctx.agentRole;
    },
    effect: "deny",
    reason: "Agents can only mutate skills for their own role."
  },
  {
    id: "skill-mutation-limit",
    name: "Max 5 skill mutations per sprint",
    priority: 3,
    tools: ["skill_mutate", "skill_discover"],
    condition: (ctx) => (ctx.toolParameters["mutationCount"] || 0) >= 5,
    effect: "deny",
    reason: "Sprint skill mutation limit (5) reached."
  },
  {
    id: "skill-trust-gate",
    name: "Low-trust agents cannot mutate skills",
    priority: 1,
    tools: ["skill_mutate", "skill_discover"],
    condition: (ctx) => ctx.agentTrust < 0.5,
    effect: "deny",
    reason: "Agent trust too low for skill mutation."
  },
  {
    id: "review-critical-blocks",
    name: "Critical review findings block merge",
    priority: 1,
    tools: ["task_complete"],
    condition: (ctx) => (ctx.toolParameters["criticalFindings"] || 0) > 0,
    effect: "deny",
    reason: "Critical review findings must be resolved before task completion."
  },
];
```

---

## Cost Model

```
Per skill mutation cycle (no revision):
  Failure attribution:     ~$0.003  (gpt-4o-mini)
  Skill rewrite:           ~$0.01   (gpt-4o)
  Governance check:        ~$0.00   (pure TypeScript)
  ATA pipeline:            ~$0.04   (3 LLM calls)
  Total:                   ~$0.05

Per skill mutation cycle (1 revision):
  Above + revision:        +$0.008  (rewrite)
  + ATA re-run:            +$0.04
  Total:                   ~$0.10

Per automated code review:
  Per step:                ~$0.005  (gpt-4o-mini)
  Per sprint (10 steps):   ~$0.05

Per pattern extraction:
  Per task:                ~$0.003  (embedding + clustering)
  Per sprint (6 tasks):    ~$0.02

Cross-sprint transfer:
  Per sprint boundary:     ~$0.02   (pattern analysis)

Per-sprint evolution budget: $0.30 (covers 5 mutations + reviews + patterns)
```

---

## Integration Map

```
Spec 05a (Hippocampus)
  ├── Provides: memories, habits, priming for skill context
  ├── Receives: new habits formed from patterns (System 2)
  └── Receives: updated procedural memory from skill mutations

Spec 12 (Heartbeat)
  ├── Phase 1: loads matched skills into agent context
  ├── Phase 4: triggers reflective learning loop
  └── Skills Lead heartbeat: proactive skill health monitoring

Spec 13 (Governance)
  ├── Gates: all skill mutations (trust + limits + role)
  ├── Gates: review findings block critical changes
  └── Trust score: affected by skill violation frequency

Spec 15 (Long-Horizon)
  └── Cross-sprint transfer runs at sprint boundaries

Spec 17 (Self-Healing)
  └── Low-severity review findings cleaned up during night shift

Spec 20 (Artifact UX)
  └── Skill health reports and review summaries as board artifacts
```

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| ATA validation | Dry-run simulation, not real execution | Skills are guidance Markdown. Dry-run validates steering. Real testing in sprint. |
| Mutation limit | 5 per sprint | Prevents runaway self-modification. Gradual evolution. |
| Revision cycles | Max 2 | Balance between persistence and wasted compute. 3+ = needs human insight. |
| Trigger matching | LLM-based (via Hippocampus habit matching) | Natural language triggers. Exact matching misses semantic overlap. |
| Skills Lead role | Proactive skill gardener | Primary purpose now justified. Monitors health, orchestrates evolution. |
| Pattern → Habit threshold | usage >= 10, success >= 0.8 | High bar ensures habits are proven, not speculative. |
| Automated review | On every step, gpt-4o-mini | Cheap, fast, catches obvious issues. Not a replacement for CTO review. |
| Cross-sprint transfer | Proactive, not waiting for failure | Aman's insight: don't wait for things to break. Learn from success. |
| 05b absorption | PatternLearner + habits → Spec 14 | They're "how agents learn" — same concern as skill evolution. |

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `packages/company-runtime/src/skill-mutator.ts` | Reflective learning loop + failure attribution |
| `packages/company-runtime/src/skill-tester.ts` | ATA pipeline (TGA + EAA + ROA + revision) |
| `packages/company-runtime/src/skill-registry.ts` | Skill CRUD + trigger matching + health metrics |
| `packages/company-runtime/src/pattern-learner.ts` | Pattern extraction + clustering + habit formation |
| `packages/company-runtime/src/code-reviewer.ts` | Automated review (security, architecture, skills, quality) |
| `packages/company-runtime/src/policies/skill-policies.ts` | Skill mutation + review governance rules |
| `packages/db/src/schema/skills.ts` | skill_artifacts, skill_mutations, review_findings tables |

### Modified Files

| File | Change |
|------|--------|
| `packages/contracts/src/domain.ts` | Add SkillArtifact, SkillMutation, Pattern, ReviewReport types |
| `packages/company-runtime/src/heartbeat-checklist.ts` | Add Skills Lead checklist items |
| `apps/api/src/orchestrator.ts` | Integrate failure attribution + review into task completion path |
| `packages/hippocampus/src/tiers/procedural.ts` | Accept habits from pattern formation |
| `packages/company-runtime/skills/` | Preserved — seeded into registry on first boot |

---

## Implementation Phases

### Phase 1: Skill Registry + Database (Foundation)

**Goal:** Skills exist as versioned artifacts in the database. Agents can read them. Nothing mutates yet.

**Build:**
1. Create `packages/db/src/schema/skills.ts` — `skill_artifacts` table + indexes
2. Create `packages/company-runtime/src/skill-registry.ts`:
   - `getSkillsForRole(companyId, role)` → query active skills
   - `matchSkills(companyId, role, taskDescription)` → token-based trigger matching (same approach as existing `procedural.ts:findMatching`)
   - `registerSkill(skill)` → insert
   - `updateSkill(skillId, updates)` → update
   - `deprecateSkill(skillId, reason)` → set status = 'deprecated'
   - `getSkillHealth(companyId)` → aggregate metrics query
3. Create `seedExistingSkills()` — migrate 6 Markdown files to registry on first boot
4. Add `SkillArtifact` type to `packages/contracts/src/domain.ts`
5. Wire into orchestrator: after `prepareAgentContext()`, also call `matchSkills()` and append matching skill content to agent prompt

**Test:**
- Boot server → verify 6 skills seeded in database
- Start a sprint → verify Developer's prompt includes matching skill content
- Query `/api/skills` (new route) → returns list of active skills with usage counts

**Estimated effort:** 2 days

---

### Phase 2: Failure Attribution + Skill Mutation (Core Loop)

**Goal:** When a task fails or has high rework, the system identifies the responsible skill and proposes a mutation.

**Build:**
1. Create `packages/company-runtime/src/skill-mutator.ts`:
   - `analyzeFailure(task, outcome, executionTrace)` → LLM call (gpt-4o-mini) returns `FailureAttribution`
   - `proposeSkillMutation(attribution, originalSkill)` → LLM call (gpt-4o) rewrites skill content
   - `proposeSkillDiscovery(attribution, taskContext)` → LLM call (gpt-4o) creates new skill
2. Create `skill_mutations` table in `packages/db/src/schema/skills.ts`
3. Add `SkillMutation` type to contracts
4. Wire into orchestrator `processTaskCompletion` path:
   ```
   task completes/fails
     → if failed OR iterationCount >= 3:
       → skillMutator.analyzeFailure(task)
       → if attribution.confidence > 0.6:
         → skillMutator.proposeSkillMutation() OR proposeSkillDiscovery()
         → store as SkillMutation with status: "proposed"
   ```
5. Create LLM prompts:
   - `FAILURE_ATTRIBUTION_PROMPT` — structured output: `{ attributedSkillId, failureMode, confidence, suggestedFix, isSkillGap }`
   - `SKILL_MUTATION_PROMPT` — input: original skill + failure context → output: rewritten skill Markdown
   - `SKILL_DISCOVERY_PROMPT` — input: task context + failure → output: new skill Markdown + trigger

**Test:**
- Force a task failure → verify `FailureAttribution` is logged
- Verify mutation is proposed with status "proposed" in `skill_mutations` table
- Verify mutation contains rewritten skill content that addresses the failure
- Verify a skill gap (no matching skill) triggers discovery, not mutation

**Estimated effort:** 3 days

---

### Phase 3: ATA Pipeline (Verification Gate)

**Goal:** Proposed mutations get tested by the 3-agent pipeline before going live.

**Build:**
1. Create `packages/company-runtime/src/skill-tester.ts`:
   - `runATAPipeline(mutation: SkillMutation)` → orchestrates TGA → EAA → ROA
   - `generateTests(mutation)` → TGA: LLM call (gpt-4o-mini), produces 3-5 test scenarios
   - `executeDryRun(proposedSkill, testScenarios)` → EAA: LLM call (gpt-4o) per scenario, simulates agent plan
   - `reviewResults(mutation, testResults)` → ROA: LLM call (gpt-4o-mini), produces verdict
2. Implement recursive revision:
   ```
   verdict = runATAPipeline(mutation)
   if verdict === "revise" AND mutation.revisionCycle < 2:
     mutation.revisionCycle++
     revisedSkill = skillMutator.reviseSkill(mutation, verdict.revisionGuidance)
     verdict = runATAPipeline(revisedMutation)
   ```
3. On APPROVE: deprecate old skill version, activate new version, update `skill_artifacts`
4. On REJECT: log rejection, increment failure count, queue for next sprint
5. Create LLM prompts:
   - `TGA_PROMPT` — "Create 3-5 test scenarios that stress-test this skill..."
   - `EAA_PROMPT` — "Given this skill, describe step-by-step what you would do for this task..."
   - `ROA_PROMPT` — "Evaluate: does the mutation fix the original failure? Do outcomes pass?..."

**Test:**
- Create a mutation → run ATA → verify 3 test scenarios generated
- Verify EAA produces per-scenario dry-run results
- Verify ROA produces approve/reject/revise verdict
- Test revision: create a mutation that ROA returns "revise" → verify it loops back with feedback → verify max 2 cycles
- Verify approved mutation activates new skill version and deprecates old

**Estimated effort:** 3 days

---

### Phase 4: Automated Code Review (Quality Gate)

**Goal:** Every code change from any agent gets reviewed before reaching preview/board.

**Build:**
1. Create `packages/company-runtime/src/code-reviewer.ts`:
   - `reviewCodeChange(task, codeChanges, activeSkills)` → LLM call (gpt-4o-mini)
   - Returns `ReviewReport { status, findings[], skillViolations[] }`
2. Create `review_findings` table
3. Create review prompt:
   - `CODE_REVIEW_PROMPT` — "Check for: hardcoded secrets, SQL injection, XSS, architecture violations, skill compliance. For each finding: severity, category, description, file, suggestion."
4. Wire into orchestrator step loop:
   ```
   Developer completes a step
     → codeReviewer.reviewCodeChange(task, files, skills)
     → if critical findings: block step, loop back with findings
     → if high findings: flag in CTO review artifact
     → if medium/low: log only
   ```
5. Feedback loop: if same skill violation found 3+ times → trigger `analyzeFailure` on the skill

**Test:**
- Developer writes code with a hardcoded API key → review catches it as critical → step blocked
- Developer ignores a skill (uses jsonwebtoken instead of jose) → review flags skill violation
- 3+ skill violations of same type → verify failure attribution triggers

**Estimated effort:** 2 days

---

### Phase 5: Pattern Learning → Skill Formation (Intelligence Layer)

**Goal:** The system detects recurring patterns across tasks and graduates them into skills.

**Build:**
1. Create `packages/company-runtime/src/pattern-learner.ts`:
   - `extractPattern(task, outcome)` → embed task trajectory, store in patterns table
   - `clusterPatterns(companyId)` → group similar patterns by cosine similarity (threshold 0.7)
   - `checkSkillCandidates(companyId)` → find habit clusters with no matching skill
   - `proposeSkillFromCluster(cluster)` → LLM synthesizes a skill from related habits
2. Wire into task completion: after Hippocampus extraction, also run `patternLearner.extractPattern()`
3. Wire into sprint boundary: `patternLearner.checkSkillCandidates()` → proposes skills → ATA validates
4. Habit → Skill promotion:
   ```
   Cluster of habits about "auth/JWT" domain
     combined usage: 12
     combined success: 0.88
     no matching skill exists
     → proposeSkillFromCluster() → creates "JWT Authentication" skill
     → ATA validates → activate
   ```

**Test:**
- Run 3 sprints → verify patterns accumulated in database
- Verify similar patterns get clustered together
- Create 4+ habits about the same domain → verify skill candidate proposed
- Verify proposed skill goes through ATA before activation

**Estimated effort:** 3 days

---

### Phase 6: Cross-Sprint Transfer + Skills Lead (Proactive)

**Goal:** Skills Lead agent proactively monitors skill health and proposes improvements. Sprint boundaries trigger skill transfer.

**Build:**
1. Add Skills Lead heartbeat checklist items:
   - Check skill health: any `success_rate < 0.6`?
   - Check skill gaps: task types with no matching skill?
   - Check unused skills: unused for 30+ days → candidate for deprecation
2. Wire Skills Lead Phase 3: if issues found → initiate mutation for worst-performing skill
3. Cross-sprint transfer at sprint boundary:
   ```
   Sprint N completes
     → patternLearner.analyzeSprintPatterns(sprintId)
     → for each pattern with frequency >= 3 and no matching skill:
       → propose skill → ATA → activate for Sprint N+1
   ```
4. Create governance policies for skill mutations (from spec)

**Test:**
- Create a skill with `success_rate: 0.4` → verify Skills Lead heartbeat flags it
- Create an unused skill (30+ days) → verify deprecation proposed
- Complete Sprint N with 3 repeated patterns → verify candidate skills proposed for Sprint N+1

**Estimated effort:** 2 days

---

## Total Implementation Effort

| Phase | Days | What You Get |
|-------|------|-------------|
| 1. Skill Registry | 2 | Skills in DB, matched to tasks, injected into prompts |
| 2. Failure Attribution + Mutation | 3 | System diagnoses failures and proposes fixes |
| 3. ATA Pipeline | 3 | Mutations are validated before going live |
| 4. Automated Code Review | 2 | Quality gate on every code change |
| 5. Pattern Learning | 3 | Recurring patterns become skills |
| 6. Cross-Sprint + Skills Lead | 2 | Proactive skill improvement |
| **Total** | **15 days** | **Full self-evolution pipeline** |

**Phases 1-3 are the MVP** (8 days). Skills exist, get matched, mutate on failure, and are validated before merge. This alone makes Sprint 2+ dramatically better.

**Phase 4** adds quality gates. Phase 5-6 add intelligence. These can ship after the MVP is stable.

---

## Verification Checklist

### Phase 1: Skill Registry
- [ ] `skill_artifacts` table exists in Supabase with correct schema and indexes
- [ ] 6 seed skills imported from Markdown files on first boot
- [ ] `GET /api/skills` returns list of active skills with metadata
- [ ] `GET /api/skills/:id/history` returns version chain
- [ ] `GET /api/skills/health` returns health report (success rates, gaps, worst performers)
- [ ] Agent prompt includes matched skill content when skills are relevant to the task
- [ ] Agent prompt does NOT include skills when no trigger matches (empty task = no skills injected)
- [ ] `usageCount` increments each time a skill is matched and used
- [ ] `successRate` updates after task completion (EMA: `rate * 0.85 + outcome * 0.15`)

### Phase 2: Failure Attribution + Mutation
- [ ] Task failure triggers `analyzeFailure()` → `FailureAttribution` stored in DB
- [ ] Task with `iterationCount >= 3` (high friction) also triggers attribution
- [ ] Task success with 0 rework does NOT trigger attribution (only updates success_rate)
- [ ] Attribution with `confidence > 0.6` triggers mutation proposal
- [ ] Attribution with `confidence <= 0.6` is logged but no mutation proposed
- [ ] Attribution with `isSkillGap: true` triggers skill discovery (not mutation)
- [ ] Proposed mutation stored in `skill_mutations` with status "proposed"
- [ ] Proposed skill content is valid Markdown with trigger + steps
- [ ] Mutation reason references the specific failure mode

### Phase 3: ATA Pipeline
- [ ] TGA generates 3-5 test scenarios with task prompts + expected outcomes + edge cases
- [ ] EAA produces per-scenario dry-run plan that references the skill's steps
- [ ] ROA verdict is one of: "approve" | "reject" | "revise"
- [ ] On "approve": old skill deprecated, new skill activated, mutation status = "merged"
- [ ] On "reject": mutation status = "rejected", failure count incremented
- [ ] On "revise": feedback fed back to mutation step, `revisionCycle` incremented
- [ ] Revision loops max 2 times, then falls back to "reject"
- [ ] Total ATA cost per mutation is within budget (~$0.04-0.08 without revision)
- [ ] ATA runs async — does not block the active sprint execution

### Phase 4: Automated Code Review
- [ ] Review runs after each Developer step completion
- [ ] Review detects hardcoded secrets → returns critical finding
- [ ] Review detects skill violation (e.g., wrong library) → returns high finding
- [ ] Critical findings block step (Developer must fix before proceeding)
- [ ] High findings are flagged in CTO review artifact
- [ ] Medium/low findings are logged in `review_findings` table
- [ ] 3+ identical skill violations of same type trigger `analyzeFailure` on the skill
- [ ] Review cost per step is under $0.01

### Phase 5: Pattern Learning
- [ ] `extractPattern()` runs on every task completion (success or failure)
- [ ] Patterns stored with embeddings in `patterns` table
- [ ] Similar patterns (cosine > 0.7) clustered together
- [ ] Pattern usage count and success rate tracked and updated via EMA
- [ ] Cluster of 4+ related habits with no matching skill → skill candidate proposed
- [ ] Proposed skill from cluster goes through ATA pipeline
- [ ] Pattern extraction cost is under $0.005 per task

### Phase 6: Cross-Sprint Transfer + Skills Lead
- [ ] Skills Lead heartbeat checks skill health metrics
- [ ] Skills with `success_rate < 0.6` flagged for mutation
- [ ] Skills unused for 30+ days flagged for deprecation
- [ ] Sprint boundary triggers `analyzeSprintPatterns()`
- [ ] Patterns recurring 3+ times in Sprint N become candidate skills for Sprint N+1
- [ ] Candidate skills pass ATA before activation
- [ ] Cross-sprint transfer cost is under $0.03 per sprint boundary

### Governance (All Phases)
- [ ] Only agents with `trust >= 0.5` can propose skill mutations
- [ ] Agents can only mutate their own role's skills (except Skills Lead)
- [ ] Max 5 skill mutations per sprint enforced
- [ ] Skill content cannot contain shell commands or system calls
- [ ] Critical review findings block task completion regardless of trust score
- [ ] All mutations logged in audit ledger with full context
- [ ] Per-sprint evolution budget of $0.30 is not exceeded

### End-to-End Scenario
- [ ] Sprint 1: Developer fails at JWT auth (uses wrong library)
  - [ ] Failure attributed to "Developer Coding Patterns" skill
  - [ ] Mutation proposed: add JWT-specific guidance
  - [ ] ATA approves mutation
  - [ ] Skill v2 activated
- [ ] Sprint 2: Developer gets JWT task again
  - [ ] Skill v2 matched and injected into prompt
  - [ ] Developer uses correct library (jose)
  - [ ] 0 rework cycles
  - [ ] Success rate updates upward
- [ ] Sprint 3: Pattern detected — "Zod validation" habit used 10+ times
  - [ ] PatternLearner clusters related habits
  - [ ] Proposes "API Input Validation" skill
  - [ ] ATA approves
  - [ ] New skill active for Sprint 4