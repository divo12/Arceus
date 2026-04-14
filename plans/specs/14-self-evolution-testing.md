# Spec 14: Self-Evolution & Autonomous Testing Pipeline

> Status: DRAFT
> Last updated: 2026-04-13
> Depends on: Spec 12 (Heartbeat — iterative refinement cycles), Spec 13 (Governance — policy-gated mutation)
> Enables: Spec 15 (Long-Horizon — agents that improve over company lifetime)

## What This Is

Agents today are frozen. Their skills are Markdown files checked into the repo. If a developer agent repeatedly fails at a specific task pattern — say, Supabase RLS policies — it will fail the same way next sprint. It has memory (Hippocampus), but no ability to evolve its own procedures.

This spec gives agents the ability to:
1. **Diagnose failures** — trace back to the specific skill, strategy, or tool pattern that failed
2. **Mutate skills** — rewrite the failing skill artifact to patch the failure mode
3. **Discover new skills** — create entirely new skill artifacts when no existing skill covers a capability gap
4. **Test mutations** — validate changes through an autonomous 3-agent testing pipeline before they merge
5. **All under policy governance** — every mutation is cross-referenced against Spec 13 policies before it can take effect

The agents design themselves. But they do it safely.

## Why This Matters

```
WITHOUT self-evolution:
  Sprint 1: Developer writes auth code. Gets JWT wrong. CTO sends back 3x rework.
  Sprint 2: Developer writes auth code. Gets JWT wrong AGAIN. Same 3x rework.
  Sprint 5: Developer writes auth code. Gets JWT wrong AGAIN.
  → The agent never learns the procedure.
  → Hippocampus stores "JWT failed" as a memory, but doesn't fix the HOW.

WITH self-evolution:
  Sprint 1: Developer writes auth code. Gets JWT wrong. CTO reviews, sends rework.
  → Failure Attribution: "jwt-auth" skill lacks refresh token handling
  → Skill Mutation: Developer rewrites jwt-auth skill to include refresh tokens
  → ATA Pipeline: tests pass
  → Merge: skill updated in procedural memory
  Sprint 2: Developer writes auth code. Uses updated skill. Gets it right first time.
  → 0 rework cycles.
```

## Skill Architecture

### Current State

Skills live in `packages/company-runtime/skills/` as Markdown files:

```
packages/company-runtime/skills/
  developer/SKILL.md          — Developer coding patterns and conventions
  tester/SKILL.md             — Testing strategies and frameworks
  ui-designer/SKILL.md        — Design system rules and patterns
  marketing/SKILL.md          — Content and launch playbooks
  skills-lead/SKILL.md        — Skill packaging guidelines
  apple-design-system/SKILL.md — Apple HIG design patterns
```

These are static. They're injected into agent prompts but never updated by agents.

### After This Spec

Skills become **versioned, mutable, executable artifacts** stored in the Control Plane:

```
Skill Artifact:
  ┌────────────────────────────────────────────────────────────────┐
  │ id:           "skill-jwt-auth-v3"                              │
  │ name:         "JWT Authentication Implementation"              │
  │ role:         "developer"                                      │
  │ version:      3                                                │
  │ status:       "active"                                         │
  │                                                                │
  │ trigger:      "When implementing authentication or JWT tokens" │
  │                                                                │
  │ content:      (Markdown — procedural instructions)             │
  │               "## JWT Auth Pattern                             │
  │                1. Use jose library (not jsonwebtoken)           │
  │                2. Always implement refresh tokens               │
  │                3. Store refresh token in httpOnly cookie        │
  │                4. Access token lifetime: 15 minutes             │
  │                5. Refresh token lifetime: 7 days                │
  │                6. Validate issuer and audience claims           │
  │                7. Use RS256 for production, HS256 for dev"     │
  │                                                                │
  │ test_cases:   (structured test expectations)                   │
  │               [{ input: "auth endpoint needs JWT",             │
  │                  expected: "uses jose, implements refresh" }]  │
  │                                                                │
  │ success_rate: 0.87                                             │
  │ usage_count:  12                                               │
  │ last_used:    "2026-04-12T..."                                 │
  │ mutated_from: "skill-jwt-auth-v2"                              │
  │ mutated_by:   "developer" (agent role)                         │
  │ mutation_reason: "v2 lacked refresh token handling → 3 rework  │
  │                   cycles in Sprint 4"                          │
  │                                                                │
  │ created_at:   "2026-04-10T..."                                 │
  │ approved_at:  "2026-04-10T..."                                 │
  └────────────────────────────────────────────────────────────────┘
```

```typescript
// packages/contracts/src/domain.ts — new types

interface SkillArtifact {
  id: string;
  companyId: string;
  name: string;
  role: RoleSoul["role"];
  version: number;
  status: "draft" | "testing" | "active" | "deprecated";
  trigger: string;                          // when to apply this skill
  content: string;                          // Markdown procedural instructions
  testCases: SkillTestCase[];
  successRate: number;                      // 0.0 - 1.0, updated on each use
  usageCount: number;
  lastUsedAt: string | null;
  mutatedFromId: string | null;             // previous version
  mutatedBy: string | null;                 // agent role that mutated
  mutationReason: string | null;
  createdAt: string;
  approvedAt: string | null;               // when ATA pipeline approved it
}

interface SkillTestCase {
  id: string;
  description: string;
  input: string;                            // task scenario
  expectedBehavior: string;                 // what the skill should produce
  validationCriteria: string[];             // concrete checks
}

interface SkillMutation {
  id: string;
  companyId: string;
  originalSkillId: string | null;           // null for new skills
  proposedSkill: SkillArtifact;
  reason: string;
  failureTraceId: string | null;            // link to the task that triggered this
  status: "proposed" | "testing" | "approved" | "rejected" | "merged";
  testResults: SkillTestResult[];
  proposedBy: string;                       // agentId
  proposedAt: string;
  resolvedAt: string | null;
}

interface SkillTestResult {
  testCaseId: string;
  status: "pass" | "fail" | "error";
  output: string;
  duration_ms: number;
  executedAt: string;
}
```

## The Reflective Learning Loop

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    REFLECTIVE LEARNING LOOP                               │
│                                                                          │
│   TRIGGER: Task reaches terminal state (completed OR failed)             │
│   RUNS: During Phase 4 (Serialization) of heartbeat, async              │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ Step 1: FAILURE ATTRIBUTION                                     │    │
│  │                                                                 │    │
│  │ Input:  Task outcome + execution trace + artifacts             │    │
│  │ Ask:    "Did the agent's procedural skills contribute to       │    │
│  │          this outcome? If failure: what specific skill or      │    │
│  │          missing skill caused the failure?"                    │    │
│  │                                                                 │    │
│  │ Output: FailureAttribution                                     │    │
│  │   {                                                             │    │
│  │     taskId: "task-123",                                        │    │
│  │     outcome: "failed",                                         │    │
│  │     attributedSkillId: "skill-jwt-auth-v2" | null,             │    │
│  │     failureMode: "missing_refresh_tokens",                     │    │
│  │     confidence: 0.85,                                          │    │
│  │     suggestedFix: "Add refresh token handling to JWT skill",   │    │
│  │     isSkillGap: false   // true if NO skill exists for this    │    │
│  │   }                                                             │    │
│  │                                                                 │    │
│  │ LLM: gpt-4o-mini (~500 tokens, ~$0.003)                       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                    ┌─────────┴──────────────┐                           │
│                    │                        │                            │
│               Skill failure            Skill gap                        │
│               (existing skill          (no skill for                    │
│                was wrong)               this task)                      │
│                    │                        │                            │
│                    ▼                        ▼                            │
│  ┌──────────────────────────┐  ┌──────────────────────────┐            │
│  │ Step 2A: SKILL MUTATION  │  │ Step 2B: SKILL DISCOVERY │            │
│  │                          │  │                          │            │
│  │ Load original skill      │  │ Generate new skill from  │            │
│  │ Apply failure context    │  │ task context + outcome   │            │
│  │ LLM rewrites content    │  │ LLM creates content      │            │
│  │ Preserve trigger         │  │ Define trigger           │            │
│  │ Increment version        │  │ Version = 1              │            │
│  │                          │  │                          │            │
│  │ LLM: gpt-4o             │  │ LLM: gpt-4o             │            │
│  │ (~1000 tokens, ~$0.01)  │  │ (~1500 tokens, ~$0.015) │            │
│  └──────────────────────────┘  └──────────────────────────┘            │
│                    │                        │                            │
│                    └────────────┬───────────┘                           │
│                                 │                                        │
│                                 ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Step 3: GOVERNANCE CHECK (Spec 13)                               │   │
│  │                                                                  │   │
│  │ PolicyEngine.evaluate({                                          │   │
│  │   tool: "skill_mutate",                                          │   │
│  │   parameters: { skillId, proposedChanges, reason }               │   │
│  │ })                                                               │   │
│  │                                                                  │   │
│  │ Checks:                                                          │   │
│  │  - Agent has "skills_lead" or is mutating own role's skills     │   │
│  │  - Skill content doesn't contain shell commands or system calls  │   │
│  │  - Mutation count within per-sprint limits (max 5 per sprint)    │   │
│  │  - Agent trust score >= 0.5 (restricted agents can't mutate)    │   │
│  │                                                                  │   │
│  │ If DENY → mutation rejected, logged to audit                    │   │
│  │ If ALLOW → proceed to ATA pipeline                              │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                 │                                        │
│                                 ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Step 4: AUTONOMOUS TESTING ARCHITECTURE (ATA)                    │   │
│  │ (see next section)                                               │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                 │                                        │
│                    ┌────────────┴───────────┐                           │
│                    │                        │                            │
│                 PASS                     FAIL                           │
│                    │                        │                            │
│                    ▼                        ▼                            │
│  ┌──────────────────────────┐  ┌──────────────────────────┐            │
│  │ Step 5A: MERGE           │  │ Step 5B: REJECT + LOG    │            │
│  │                          │  │                          │            │
│  │ - Mark old version       │  │ - Mark mutation rejected │            │
│  │   "deprecated"           │  │ - Log failure reason     │            │
│  │ - Activate new version   │  │ - Increment failure      │            │
│  │ - Update success_rate    │  │   count on original      │            │
│  │ - Record in audit ledger │  │ - May retry in next      │            │
│  │ - Notify Skills Lead     │  │   sprint with more data  │            │
│  └──────────────────────────┘  └──────────────────────────┘            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Autonomous Testing Architecture (ATA)

The ATA is a 3-agent pipeline that evaluates skill mutations in isolation. This is NOT the company's regular testing workflow — it's a meta-level quality gate for the skill system itself.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    ATA PIPELINE                                          │
│                                                                          │
│   Input: SkillMutation (proposed skill change)                          │
│   Output: PASS or FAIL (with detailed report)                           │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ AGENT 1: Test Generation Agent (TGA)                            │    │
│  │                                                                 │    │
│  │ Role: Create test scenarios that stress-test the proposed skill  │    │
│  │                                                                 │    │
│  │ Input:                                                          │    │
│  │   - Original skill (if mutation, not discovery)                 │    │
│  │   - Proposed skill content                                      │    │
│  │   - Failure context that triggered mutation                     │    │
│  │   - Skill's trigger condition                                   │    │
│  │                                                                 │    │
│  │ Output: 3-5 test scenarios                                     │    │
│  │   [{                                                            │    │
│  │     id: "test-1",                                              │    │
│  │     scenario: "Build JWT auth with refresh tokens",            │    │
│  │     taskPrompt: "Implement auth endpoints using jose...",      │    │
│  │     expectedOutcomes: [                                        │    │
│  │       "Creates /api/auth/login endpoint",                      │    │
│  │       "Creates /api/auth/refresh endpoint",                    │    │
│  │       "Uses httpOnly cookie for refresh token",                │    │
│  │       "Access token expires in 15 minutes"                     │    │
│  │     ],                                                          │    │
│  │     edgeCases: [                                               │    │
│  │       "Expired refresh token returns 401",                     │    │
│  │       "Invalid token signature returns 403"                    │    │
│  │     ]                                                           │    │
│  │   }]                                                            │    │
│  │                                                                 │    │
│  │ LLM: gpt-4o-mini (~800 tokens, ~$0.005)                       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ AGENT 2: Execution Agent (EAA)                                  │    │
│  │                                                                 │    │
│  │ Role: Simulate executing the skill against each test scenario   │    │
│  │                                                                 │    │
│  │ For each test scenario:                                         │    │
│  │   1. Load the proposed skill content into agent context         │    │
│  │   2. Present the task prompt                                    │    │
│  │   3. Ask agent to describe what it would do (dry-run)           │    │
│  │   4. Evaluate: does the described approach match expected       │    │
│  │      outcomes?                                                  │    │
│  │                                                                 │    │
│  │ WHY dry-run (not real execution):                               │    │
│  │   - Skills are procedural guidance, not executable code         │    │
│  │   - Real execution would require a full workspace sandbox       │    │
│  │   - Dry-run validates that the skill steers the agent correctly │    │
│  │   - Real build verification happens in the actual sprint        │    │
│  │                                                                 │    │
│  │ Output: Per-scenario results                                    │    │
│  │   [{                                                            │    │
│  │     testId: "test-1",                                          │    │
│  │     agentPlan: "1. Install jose, 2. Create /api/auth/...",     │    │
│  │     outcomeMatches: [true, true, true, true],                  │    │
│  │     edgeCaseMatches: [true, false],                            │    │
│  │     notes: "Agent didn't handle invalid signature case"        │    │
│  │   }]                                                            │    │
│  │                                                                 │    │
│  │ LLM: gpt-4o (~2000 tokens per scenario, ~$0.02)               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ AGENT 3: Review Agent (ROA)                                     │    │
│  │                                                                 │    │
│  │ Role: Analyze test results and make final verdict               │    │
│  │                                                                 │    │
│  │ Input:                                                          │    │
│  │   - Proposed skill                                              │    │
│  │   - All test scenarios                                          │    │
│  │   - All execution results                                      │    │
│  │   - Original failure context                                    │    │
│  │                                                                 │    │
│  │ Evaluation criteria:                                            │    │
│  │   - Does the mutation fix the original failure?  (required)     │    │
│  │   - Do all core outcomes pass?  (required)                     │    │
│  │   - Do edge cases pass?  (nice-to-have, not blocking)          │    │
│  │   - Is the skill content clear and actionable?  (required)     │    │
│  │   - Does the skill introduce any security risks?  (required)   │    │
│  │                                                                 │    │
│  │ Output: ReviewVerdict                                           │    │
│  │   {                                                             │    │
│  │     verdict: "approve" | "reject" | "revise",                  │    │
│  │     overallScore: 0.85,  // 0-1                                │    │
│  │     fixesOriginalFailure: true,                                │    │
│  │     coreOutcomesPassing: 4/4,                                  │    │
│  │     edgeCasesPassing: 1/2,                                     │    │
│  │     securityConcerns: [],                                      │    │
│  │     feedback: "Skill properly handles refresh tokens. Edge     │    │
│  │               case for invalid signature needs work but       │    │
│  │               doesn't block approval."                         │    │
│  │   }                                                             │    │
│  │                                                                 │    │
│  │ LLM: gpt-4o-mini (~600 tokens, ~$0.004)                       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Total ATA cost per skill mutation: ~$0.04-0.08                         │
│  Total ATA duration: ~30-60 seconds (3 sequential LLM calls)           │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## When Does Evolution Happen?

Evolution is triggered by the reflective learning loop, which runs during specific moments:

### Trigger 1: Task Failure (Immediate)

```
Task fails → Hippocampus.processTaskCompletion() fires
           → In parallel: SkillMutator.analyzeFailure(task)
           → If attributed to a skill: propose mutation
           → ATA pipeline runs in Skills Lead's next heartbeat
```

### Trigger 2: Excessive Rework (Pattern Detection)

```
Task completes after 3+ rework cycles (iterationCount >= 3)
  → Hippocampus records "high-friction task"
  → SkillMutator.analyzeHighFriction(task)
  → Even though task succeeded, the procedure was inefficient
  → Propose mutation to reduce future rework
```

### Trigger 3: Skills Lead Heartbeat (Proactive)

```
Skills Lead beats every 2 minutes
  Phase 2: Check skill health metrics
    - Any skills with success_rate < 0.6?
    - Any skill gaps? (task types with no matching skill)
    - Any skills unused for 30+ days? (candidate for deprecation)
  Phase 3: If issues found → initiate mutation for worst-performing skill
```

### Trigger 4: Cross-Sprint Learning (Sprint Boundary)

```
Sprint N completes → CEO proposes Sprint N+1
  → Skills Lead reviews Sprint N outcomes
  → Identifies recurring patterns across tasks
  → Proposes new skills based on patterns that repeated 3+ times
```

## Skill Registry

```typescript
// packages/company-runtime/src/skill-registry.ts

interface SkillRegistry {
  /** Get all active skills for a role. */
  getSkillsForRole(companyId: string, role: RoleSoul["role"]): Promise<SkillArtifact[]>;

  /** Find skills matching a task description (trigger matching). */
  matchSkills(
    companyId: string,
    role: RoleSoul["role"],
    taskDescription: string
  ): Promise<SkillArtifact[]>;

  /** Register a new skill (from discovery). */
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
}
```

## Skill Usage in Heartbeat

Skills are loaded during Phase 1 (Context Assembly) and injected into the agent's prompt:

```
Phase 1 (Context Assembly):
  1. Load agent SOUL
  2. Load task details
  3. SkillRegistry.matchSkills(companyId, role, task.description)
     → Returns: 0-3 matching skills (by trigger relevance)
  4. Inject into prompt:
     "## Relevant Skills
      The following procedural skills are available for this task:

      ### JWT Authentication Implementation (v3)
      Trigger: When implementing authentication or JWT tokens
      ...
      [full skill content]

      ### API Route Patterns (v2)
      Trigger: When creating API endpoints
      ...
      [full skill content]"

Agent uses the skills as procedural guidance.
After task completion, skill usage is tracked (usageCount++) and
success/failure updates success_rate.
```

## Database Changes

```sql
-- Skill artifacts (versioned, mutable)
CREATE TABLE skill_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft|testing|active|deprecated
  trigger_condition TEXT NOT NULL,
  content TEXT NOT NULL,                  -- Markdown procedural instructions
  test_cases JSONB NOT NULL DEFAULT '[]',
  success_rate REAL NOT NULL DEFAULT 0.5,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  mutated_from_id UUID REFERENCES skill_artifacts(id),
  mutated_by TEXT,                        -- agent role
  mutation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,

  UNIQUE(company_id, name, version)
);

CREATE INDEX idx_skills_role ON skill_artifacts(company_id, role, status);
CREATE INDEX idx_skills_active ON skill_artifacts(company_id, status) WHERE status = 'active';

-- Skill mutations (proposed changes)
CREATE TABLE skill_mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  original_skill_id UUID REFERENCES skill_artifacts(id),
  proposed_skill_id UUID NOT NULL REFERENCES skill_artifacts(id),
  reason TEXT NOT NULL,
  failure_trace_id UUID,               -- link to task that triggered this
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed|testing|approved|rejected|merged
  test_results JSONB NOT NULL DEFAULT '[]',
  proposed_by UUID NOT NULL,           -- agentId
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_mutations_status ON skill_mutations(company_id, status);
```

## Migration: Existing Skills → Skill Registry

The 6 existing Markdown skill files get seeded into the registry on first boot:

```typescript
async function seedExistingSkills(companyId: string, registry: SkillRegistry) {
  const existingSkills = [
    { name: "Developer Coding Patterns",    role: "developer",    file: "developer/SKILL.md" },
    { name: "Testing Strategies",           role: "tester",       file: "tester/SKILL.md" },
    { name: "UI Design Patterns",           role: "ui_designer",  file: "ui-designer/SKILL.md" },
    { name: "Marketing Playbook",           role: "marketing",    file: "marketing/SKILL.md" },
    { name: "Skills Packaging Guidelines",  role: "skills_lead",  file: "skills-lead/SKILL.md" },
    { name: "Apple Design System",          role: "ui_designer",  file: "apple-design-system/SKILL.md" },
  ];

  for (const s of existingSkills) {
    const content = await fs.readFile(
      path.join("packages/company-runtime/skills", s.file), "utf-8"
    );
    await registry.registerSkill({
      id: crypto.randomUUID(),
      companyId,
      name: s.name,
      role: s.role as RoleSoul["role"],
      version: 1,
      status: "active",
      trigger: `When performing ${s.role} tasks`,      // broad trigger — refine as skills mutate
      content,
      testCases: [],
      successRate: 0.7,         // assume baseline competence
      usageCount: 0,
      lastUsedAt: null,
      mutatedFromId: null,
      mutatedBy: null,
      mutationReason: null,
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),    // pre-approved (seed skills)
    });
  }
}
```

## Governance Integration

Skill mutation is a **yellow** blast-radius tool governed by Spec 13 policies:

```typescript
// Added to base-policies.ts

const SKILL_POLICIES: PolicyRule[] = [
  {
    id: "skill-mutate-own-role",
    name: "Agents can only mutate their own role's skills",
    priority: 2,
    roles: [],
    tools: ["skill_mutate", "skill_discover"],
    condition: (ctx) => {
      const targetRole = ctx.toolParameters["targetRole"] as string;
      // Skills Lead can mutate any role's skills
      if (ctx.agentRole === "skills_lead") return false;
      // Others can only mutate their own role's skills
      return targetRole !== ctx.agentRole;
    },
    effect: "deny",
    reason: "Agents can only mutate skills for their own role. Use Skills Lead for cross-role mutations."
  },
  {
    id: "skill-mutation-limit",
    name: "Max 5 skill mutations per sprint",
    priority: 3,
    roles: [],
    tools: ["skill_mutate", "skill_discover"],
    condition: (ctx) => {
      const mutationsThisSprint = ctx.toolParameters["mutationCount"] as number || 0;
      return mutationsThisSprint >= 5;
    },
    effect: "deny",
    reason: "Sprint skill mutation limit (5) reached. Further mutations deferred to next sprint."
  },
  {
    id: "skill-trust-gate",
    name: "Low-trust agents cannot mutate skills",
    priority: 1,
    roles: [],
    tools: ["skill_mutate", "skill_discover"],
    condition: (ctx) => ctx.agentTrust < 0.5,
    effect: "deny",
    reason: "Agent trust too low for skill mutation. Must be above 0.5."
  },
];
```

## Cost Model

```
Per skill mutation cycle:
  Failure attribution: ~$0.003  (gpt-4o-mini, 500 tokens)
  Skill rewrite:       ~$0.01   (gpt-4o, 1000 tokens)
  Governance check:    ~$0.00   (pure TypeScript, no LLM)
  ATA pipeline:        ~$0.04   (3 LLM calls)
  Total:               ~$0.05 per mutation

Expected frequency:
  Sprint with 3 failures: 3 mutations × $0.05 = $0.15
  Sprint with 0 failures: $0 (no mutations triggered)

Per-sprint evolution budget: $0.25 (covers 5 mutations — the max per sprint)
```

## Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| ATA validation | Dry-run simulation, not real execution | Skills are guidance Markdown, not executable code. Testing their effectiveness through simulated task planning is appropriate. Real build testing happens in the sprint itself. |
| Mutation limit | 5 per sprint | Prevents runaway self-modification. Skills should evolve gradually, not rewrite themselves every beat. |
| Trigger matching | LLM-based (via Hippocampus habit matching) | Skills have natural language triggers. Exact matching would miss semantic overlap. |
| Skills Lead role | Proactive skill gardener via heartbeat | Skills Lead's primary purpose is now justified — they monitor skill health and orchestrate evolution. |
| Version history | Linked list via mutated_from_id | Simple, queryable. Can trace any skill back to v1. |
| Seed skills | Import existing Markdown on first boot | Backward compatible. Existing skills become the v1 baseline. |

## Files Changed

| File | Change |
|------|--------|
| NEW: `packages/company-runtime/src/skill-mutator.ts` | Reflective learning loop + failure attribution |
| NEW: `packages/company-runtime/src/skill-tester.ts` | ATA pipeline (TGA + EAA + ROA) |
| NEW: `packages/company-runtime/src/skill-registry.ts` | Skill CRUD + trigger matching + health metrics |
| NEW: `packages/company-runtime/src/policies/skill-policies.ts` | Skill mutation governance rules |
| MODIFY: `packages/contracts/src/domain.ts` | Add SkillArtifact, SkillMutation, SkillTestCase, SkillTestResult types |
| NEW: `packages/db/src/schema/skills.ts` | skill_artifacts, skill_mutations tables |
| MODIFY: `packages/company-runtime/src/heartbeat-checklist.ts` | Add Skills Lead checklist items |
| MODIFY: `apps/api/src/orchestrator.ts` | Integrate failure attribution into task completion path |
| MODIFY: `packages/company-runtime/skills/` | Existing Markdown files preserved (seeded into registry on first boot) |

## Deferred from Spec 11

### 1. Skill Mutation Types in Contracts

Spec 11's `AuditEventType` enum includes `skill_mutated`, `skill_tested`, `skill_merged` event types. These are not yet defined in the `StateMutation` discriminated union or the `AuditEventType` type in `packages/contracts/src/events.ts`. This spec must add them when building the skill mutation pipeline.

### 2. Service Registry `registerTool()` Integration

Spec 11 implemented `registerTool()` in the Service Registry specifically for this spec's use case — skill-evolved tools. When a skill mutation produces a new tool capability, call `registerTool()` to add it to the registry with `source: "skill"` and `addedBy: agentId`. The infrastructure is ready.
