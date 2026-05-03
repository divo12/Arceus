# Spec 17: Self-Healing & Night Shift

> **Status:** DRAFT v1
> **Last updated:** 2026-04-14
> **Depends on:** Spec 12 (Heartbeat — wake-on-event, idle detection), Spec 13 (Governance — blast-radius, auto-merge policies), Spec 14 (Self-Evolution — patterns from cleanup feed skill learning), Spec 15 (Long-Horizon — lifecycle stage determines night shift scope)
> **Absorbs:** PG-13 (Recurring Tasks)
> **Enables:** Spec 20 (Artifact UX — night shift reports as board artifacts)

---

## What This Is

Today, when no sprint is running, the company is dead. Agents sit idle. Bugs accumulate. Tech debt grows. The codebase degrades. The board has to manually trigger every piece of work.

This spec gives agents two modes of autonomous work:

1. **Self-Healing** — reactive fixes when things break (build fails, runtime errors, test regressions)
2. **Night Shift** — proactive improvement during idle time (tech debt, test coverage, docs, accessibility)
3. **Recurring Tasks** — scheduled work that runs on cadence (daily health checks, weekly reviews)
4. **Auto-Merge** — safe changes flow into the product without board review
5. **On-Call** — agents are primary responders, humans are escalation path

Agents should "always be the primary on-call. Humans just get escalated to as secondary." — Aman Sanger, Cursor

---

## Why This Matters

```
WITHOUT self-healing and night shift:
  Sprint 3 completes. Product deployed.
  3 AM: Runtime error in auth endpoint. Nobody knows until board checks dashboard.
  Next day: Board sees error. Manually asks CEO to fix it. CEO creates Sprint 4 task.
  2 days later: Developer fixes the one-line bug.
  Meanwhile: 6 other small issues accumulated. Test coverage is 40%. Unused imports everywhere.
  
  → Every fix requires human initiation. Codebase quality degrades between sprints.

WITH self-healing and night shift:
  Sprint 3 completes. Product deployed.
  3 AM: Runtime error detected → self-healing trigger fires
    → CTO investigates (1 heartbeat) → identifies root cause
    → Developer fixes (1 heartbeat) → auto-merge (green tier)
    → Board gets summary in morning: "Auth bug auto-fixed at 3:14 AM"
  Meanwhile: Night shift running —
    → Developer refactored 3 messy functions
    → Tester added 5 edge case tests (coverage: 40% → 52%)
    → CTO updated architecture docs
  Board wakes up to a BETTER product than when they went to sleep.
```

---

## The Five Systems

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    SPEC 17: SELF-HEALING & NIGHT SHIFT                    │
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────────┐   │
│  │ SYSTEM 1:      │  │ SYSTEM 2:      │  │ SYSTEM 3:                │   │
│  │ SELF-HEALING   │  │ NIGHT SHIFT    │  │ RECURRING TASKS          │   │
│  │                │  │                │  │                          │   │
│  │ Event-driven   │  │ Idle-time      │  │ Scheduled cadence        │   │
│  │ Reactive fixes │  │ Proactive work │  │ Daily/weekly/monthly     │   │
│  │ Auto-triage    │  │ Tech debt      │  │ Health checks            │   │
│  │ Auto-assign    │  │ Test coverage  │  │ Reviews                  │   │
│  └────────────────┘  └────────────────┘  └──────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────┐  ┌────────────────────────────────────┐   │
│  │ SYSTEM 4:                │  │ SYSTEM 5:                          │   │
│  │ AUTO-MERGE               │  │ ON-CALL                            │   │
│  │                          │  │                                    │   │
│  │ Green → auto-merge       │  │ Agents = primary responder         │   │
│  │ Yellow → merge + flag    │  │ Board = escalation path            │   │
│  │ Red → board approval     │  │ Severity-based routing             │   │
│  │ Staging → verify → main  │  │ Escalation chain                   │   │
│  └──────────────────────────┘  └────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## System 1: Self-Healing

Reactive fixes triggered by events. When something breaks, agents respond automatically without waiting for the board.

### Event Triggers

| Event | Source | Assigned To | Priority |
|-------|--------|------------|----------|
| Build failure | CI/CD, preview detection | Developer | Critical |
| Runtime error | Error monitoring, log scan | CTO (investigate) → Developer (fix) | High |
| Test regression | Test runner, verification gate | Tester (identify) → Developer (fix) | High |
| Performance degradation | Metric monitoring | CTO (analyze) → Developer (optimize) | Medium |
| Security vulnerability | Automated review (Spec 14 System 4) | CTO (assess) → Developer (patch) | Critical |
| Dependency issue | Package audit, npm audit | Developer | Medium |
| Preview crash | Preview monitor | Developer | High |
| Board-reported issue | CEO chat message | CEO (triage) → appropriate agent | Varies |

### Self-Healing Flow

```
Event detected (build fails, runtime error, test regression, etc.)
    │
    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 1: DETECT + CLASSIFY                                            │
│                                                                      │
│ Source: monitoring hook, verification gate, heartbeat observation     │
│                                                                      │
│ Classify severity:                                                    │
│   CRITICAL: production down, security vulnerability, data loss risk   │
│   HIGH: build broken, test regression, feature broken                 │
│   MEDIUM: performance degradation, dependency warning, code smell     │
│   LOW: style issues, unused imports, minor warnings                   │
│                                                                      │
│ Output: HealingEvent { type, severity, description, evidence }       │
│ Cost: $0 (pure logic — no LLM)                                       │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 2: TRIAGE + ASSIGN                                              │
│                                                                      │
│ Determine responsible agent by event type + skill match:             │
│                                                                      │
│   Build failure      → Developer (has build skills)                   │
│   Runtime error      → CTO first (investigate), Developer (fix)      │
│   Test regression    → Tester (identify), Developer (fix)            │
│   Security vuln      → CTO (assess severity), Developer (patch)      │
│   Performance issue  → CTO (analyze), Developer (optimize)           │
│   Board-reported bug → CEO (triage), route to best-match agent       │
│                                                                      │
│ LLM routing (gpt-4o-mini, ~$0.001) if assignment is ambiguous:       │
│   "Given this error and these agent skills, who should handle it?"    │
│                                                                      │
│ Output: HealingTask { agentId, description, evidence, severity }     │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 3: EXECUTE via Heartbeat                                        │
│                                                                      │
│ Assigned agent picks up HealingTask in their next heartbeat:         │
│                                                                      │
│ Phase 2 (Observe): Sees healing task in context                      │
│ Phase 3 (Execute): Investigates → diagnoses → implements fix         │
│ Phase 4 (Serialize): Records fix, updates workspace, creates artifact│
│                                                                      │
│ For CRITICAL severity:                                               │
│   - Trigger immediate beat (don't wait for next scheduled beat)      │
│   - CEO notified immediately                                         │
│                                                                      │
│ For investigation-then-fix (2-agent chain):                          │
│   - CTO investigates in beat N → produces diagnosis artifact         │
│   - Developer fixes in beat N+1 → uses CTO diagnosis as context     │
│                                                                      │
│ Cost: Same as regular task execution (~$0.05-0.30 depending on fix)  │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step 4: VERIFY + MERGE                                               │
│                                                                      │
│ After fix is applied:                                                │
│   1. Run verification gate (Spec 09): npm run build + npm run test   │
│   2. If passes → route to auto-merge (System 4)                     │
│   3. If fails → retry once with error context                       │
│   4. If still fails → escalate to CTO, then board                   │
│                                                                      │
│ Record in audit ledger: what broke, who fixed it, what changed       │
│ CEO posts summary to board chat: "Build fixed by Developer at 3:14AM"│
└──────────────────────────────────────────────────────────────────────┘
```

### Self-Healing Types

```typescript
interface HealingEvent {
  id: string;
  companyId: string;
  type: "build_failure" | "runtime_error" | "test_regression" | "performance_degradation" 
      | "security_vulnerability" | "dependency_issue" | "preview_crash" | "board_reported";
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  evidence: string;                    // error message, stack trace, test output
  sourceTaskId: string | null;         // task that caused it (if known)
  detectedAt: string;
  detectedBy: "monitor" | "verification_gate" | "heartbeat" | "board";
}

interface HealingTask {
  id: string;
  companyId: string;
  healingEventId: string;
  assignedAgentId: string;
  assignedRole: string;
  status: "pending" | "investigating" | "fixing" | "verifying" | "resolved" | "escalated";
  diagnosis: string | null;            // CTO's investigation result
  fixDescription: string | null;       // what was changed
  filesChanged: string[];
  verificationPassed: boolean | null;
  resolvedAt: string | null;
  escalatedTo: string | null;          // "cto" | "board" if escalated
}
```

---

## System 2: Night Shift

Proactive improvement during idle time. When no sprint is running (between sprints, off-peak hours), agents use spare compute to make the product better.

### What Each Agent Does

| Agent | Night Shift Tasks | Priority | Trigger |
|-------|-------------------|----------|---------|
| **Developer** | Refactor messy functions, improve error handling, remove dead code, update deprecated APIs, optimize hot paths | Medium | Idle > 30 min |
| **Tester** | Increase test coverage, add edge case tests, add integration tests for untested endpoints, fix flaky tests | Medium | Idle > 30 min |
| **CTO** | Review architecture decisions, update tech docs, audit dependency versions, assess tech debt backlog | Low | Idle > 1 hour |
| **UI Designer** | Audit accessibility (WCAG), check responsive breakpoints, validate color contrast, review component consistency | Low | Idle > 1 hour |
| **PM** | Review sprint outcomes, update company docs (Spec PG-6), refine backlog for next sprint | Low | Idle > 1 hour |

### Night Shift Flow

```
Agent heartbeat fires during idle time
    │
    ├─ Phase 2 (Observe): No active tasks. Company is idle.
    │
    ├─ Check: Is night shift enabled for this lifecycle stage?
    │     idea/planning: NO (no product to improve yet)
    │     building/testing/iterating/scaling: YES
    │     shipping: LIMITED (only critical fixes, no refactoring)
    │
    ├─ Check: Budget allows night shift work?
    │     Night shift has its own budget allocation (default: 10% of sprint budget)
    │     If night shift budget exhausted → skip
    │
    ├─ Select highest-priority improvement task:
    │
    │   ┌─────────────────────────────────────────────────────────────┐
    │   │ NIGHT SHIFT TASK SELECTION (per role)                       │
    │   │                                                             │
    │   │ Developer:                                                  │
    │   │   1. Check verification gate results for past failures      │
    │   │   2. Scan for TODO/FIXME/HACK comments in workspace        │
    │   │   3. Run linter → find fixable issues                       │
    │   │   4. Check for functions > 50 lines → refactor candidates   │
    │   │   5. Check for missing error handling in API routes          │
    │   │                                                             │
    │   │ Tester:                                                     │
    │   │   1. Calculate current test coverage                        │
    │   │   2. Identify untested files/functions                      │
    │   │   3. Review past test failures for flaky tests              │
    │   │   4. Add edge case tests for most-used components           │
    │   │                                                             │
    │   │ CTO:                                                        │
    │   │   1. Review architecture vs roadmap (Spec 15)               │
    │   │   2. Check for outdated dependencies (npm outdated)          │
    │   │   3. Review code review findings (Spec 14 System 4)         │
    │   │   4. Update tech notes in company docs                      │
    │   │                                                             │
    │   │ UI Designer:                                                │
    │   │   1. Run accessibility audit (axe-core or equivalent)       │
    │   │   2. Check responsive breakpoints                           │
    │   │   3. Verify design system consistency                       │
    │   └─────────────────────────────────────────────────────────────┘
    │
    ├─ Phase 3 (Execute): Implement the improvement
    │     - Single, bounded task per beat (not open-ended)
    │     - Must be completable in one heartbeat cycle
    │     - If task is too large → log it as tech debt for sprint backlog
    │
    ├─ Phase 4 (Serialize): Record what was done
    │     - Commit changes to workspace
    │     - Create NightShiftReport artifact
    │     - Route to auto-merge (System 4)
    │     - Feed patterns into Spec 14 skill evolution
    │
    └─ Continue to next idle heartbeat → pick next improvement
```

### Night Shift Task Selection

```typescript
interface NightShiftTask {
  id: string;
  companyId: string;
  role: string;
  category: "refactor" | "test_coverage" | "documentation" | "accessibility" 
          | "performance" | "dependency_update" | "dead_code" | "error_handling";
  description: string;
  targetFiles: string[];                // files to modify
  priority: "high" | "medium" | "low";
  estimatedTokens: number;             // budget estimate
  status: "pending" | "in_progress" | "completed" | "deferred";
  completedAt: string | null;
  filesChanged: string[];
  report: string | null;               // what was done
}

interface NightShiftConfig {
  enabled: boolean;
  budgetPercentOfSprint: number;        // default 0.10 (10% of sprint budget)
  maxTasksPerCycle: number;             // default 3 tasks per idle period
  minIdleMinutes: number;              // default 30 min before night shift starts
  allowedRoles: string[];              // which agents participate
  excludedFiles: string[];             // files night shift shouldn't touch
  excludedCategories: string[];        // categories to skip
}
```

### Night Shift Budget

Night shift work has its own budget allocation to prevent it from eating into sprint budget:

```
Company sprint budget: $20.00
Night shift allocation: 10% = $2.00 per sprint period

Per night shift task: ~$0.05-0.20 (similar to a regular task step)
$2.00 budget covers: ~10-40 improvement tasks between sprints

Night shift budget resets when a new sprint starts.
If night shift budget exhausted → agents go fully idle (only self-healing fires)
```

---

## System 3: Recurring Tasks

Scheduled work that runs on cadence. This is the infrastructure that night shift health checks and self-healing monitors run on.

### Recurring Task Templates

```typescript
interface RecurringTask {
  id: string;
  companyId: string;
  title: string;
  description: string;
  assignedRole: string;
  frequency: "hourly" | "daily" | "weekdays" | "weekly" | "monthly";
  cronExpression: string;               // "0 */4 * * *" = every 4 hours
  days: number[] | null;                // for weekly: [1,3,5] = Mon,Wed,Fri
  dayOfMonth: number | null;            // for monthly: 15 = 15th
  priority: "high" | "medium" | "low";
  category: "health_check" | "night_shift" | "monitoring" | "review" | "cleanup";
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  config: Record<string, unknown>;       // task-specific config
}

interface RecurringTaskInstance {
  id: string;
  recurringTaskId: string;
  taskId: string;                        // the actual task created
  scheduledFor: string;
  completedAt: string | null;
  status: "scheduled" | "running" | "completed" | "failed" | "skipped";
}
```

### Default Recurring Tasks (auto-created per company)

| Task | Frequency | Role | Category | What It Does |
|------|-----------|------|----------|-------------|
| **Build health check** | Every 4 hours | Developer | health_check | Run `npm run build`, report pass/fail |
| **Test suite run** | Daily (9 AM) | Tester | health_check | Run `npm run test`, report coverage + failures |
| **Dependency audit** | Weekly (Monday) | CTO | monitoring | Run `npm audit`, flag vulnerabilities |
| **Tech debt scan** | Daily (2 AM) | Developer | night_shift | Scan for TODOs, long functions, dead code |
| **Architecture review** | Weekly (Friday) | CTO | review | Review changes since last review, update docs |
| **Accessibility audit** | Weekly (Wednesday) | UI Designer | review | Run a11y scan, report violations |
| **Test coverage report** | Weekly (Monday) | Tester | monitoring | Calculate coverage delta, identify gaps |
| **Sprint retrospective prep** | On sprint completion | PM | review | Summarize outcomes, prepare for CEO |

### Scheduler

```typescript
class RecurringTaskScheduler {
  /** Check all recurring tasks, create instances for due tasks */
  async tick(now: Date): Promise<void> {
    const dueTasks = await this.findDueTasks(now);
    
    for (const recurring of dueTasks) {
      // Skip if company is in idea/planning stage (no product yet)
      if (!this.isNightShiftAllowed(recurring.companyId)) continue;
      
      // Skip if recurring task budget exhausted
      if (!this.hasBudget(recurring.companyId, recurring.category)) continue;
      
      // Create task instance
      const instance = await this.createInstance(recurring);
      
      // Update next run time
      recurring.lastRunAt = now.toISOString();
      recurring.nextRunAt = this.computeNextRun(recurring);
      recurring.totalRuns++;
      
      // Agent picks up task in their next heartbeat
    }
  }
  
  /** Compute next run time from cron expression */
  computeNextRun(task: RecurringTask): string { ... }
  
  /** Check if company lifecycle allows night shift work */
  isNightShiftAllowed(companyId: string): boolean { ... }
  
  /** Check budget for this category */
  hasBudget(companyId: string, category: string): boolean { ... }
}
```

### Scheduler Integration

```
// In server startup, alongside heartbeat tick:
const RECURRING_TICK_MS = 60_000; // check every minute

setInterval(async () => {
  await recurringTaskScheduler.tick(new Date());
}, RECURRING_TICK_MS);
```

---

## System 4: Auto-Merge

When self-healing or night shift produces a code change, it needs to get into the product workspace. Not everything needs board approval — safe changes should flow automatically.

### Merge Policy by Blast Radius

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    AUTO-MERGE POLICY                                      │
│                                                                          │
│  GREEN tier (read-only, reversible, no user-facing impact):              │
│    Examples: fix unused import, add code comment, update dependency       │
│              patch version, fix linting error, add unit test             │
│    → AUTO-MERGE immediately                                              │
│    → No board notification                                               │
│    → Logged in audit ledger                                              │
│    → Included in daily sync summary (Spec 18)                            │
│                                                                          │
│  YELLOW tier (state-changing, reversible, limited user impact):           │
│    Examples: refactor function, add error handling, update API route,     │
│              increase test coverage, fix non-critical bug                │
│    → AUTO-MERGE after verification gate passes                           │
│    → Flagged in daily sync summary                                       │
│    → CEO mentions in next board communication                            │
│    → Board can revert within 24 hours                                    │
│                                                                          │
│  RED tier (irreversible, significant user impact):                       │
│    Examples: add new feature, change database schema, modify auth flow,  │
│              deploy to production, delete files                          │
│    → BLOCKED — requires board approval                                   │
│    → CEO surfaces as approval card in chat                               │
│    → Agent waits until board approves or rejects                         │
│                                                                          │
│  NIGHT SHIFT tier (always green or yellow):                              │
│    Night shift tasks are pre-classified as green/yellow by design.       │
│    Night shift NEVER proposes red-tier changes.                          │
│    If an agent proposes a red-tier change during night shift → blocked,  │
│    queued for next sprint backlog instead.                               │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Auto-Merge Flow

```
Agent produces code change (self-healing or night shift)
    │
    ▼
Step 1: CLASSIFY blast radius
    Governance gateway (Spec 13) evaluates:
    - What files changed?
    - What's the nature of the change? (add/modify/delete)
    - Does it affect user-facing behavior?
    - Is it reversible?
    → Returns: green | yellow | red
    │
    ├── GREEN:
    │     Step 2: Run verification gate (build + test)
    │     Step 3: If passes → commit to workspace, log in audit
    │     Step 4: Include in daily sync batch
    │
    ├── YELLOW:
    │     Step 2: Run verification gate (build + test)
    │     Step 3: If passes → commit to workspace, log in audit
    │     Step 4: Flag for CEO → CEO mentions in next board update
    │     Step 5: Board has 24h revert window
    │
    └── RED:
          Step 2: Create approval request
          Step 3: CEO surfaces to board as card
          Step 4: Wait for board decision
          Step 5: If approved → commit + verify
          Step 6: If rejected → discard, log reason
```

### Auto-Merge Types

```typescript
interface AutoMergeDecision {
  changeId: string;
  companyId: string;
  source: "self_healing" | "night_shift" | "recurring_task";
  blastRadius: "green" | "yellow" | "red";
  filesChanged: string[];
  changeDescription: string;
  verificationPassed: boolean;
  decision: "auto_merged" | "flagged" | "blocked" | "reverted";
  mergedAt: string | null;
  revertedAt: string | null;
  revertedBy: string | null;           // "board" | "cto"
  auditEventId: string;
}
```

### Auto-Merge × Autonomy Level (Spec 15)

The auto-merge policy tightens or loosens based on company autonomy:

| Autonomy | Green | Yellow | Red |
|----------|-------|--------|-----|
| Level 1 (Supervised) | Board notified | Board approves | Board approves |
| Level 2 (Guided) | Auto-merge | Board notified | Board approves |
| Level 3 (Trusted) | Auto-merge | Auto-merge + flag | Board approves |
| Level 4 (Autonomous) | Auto-merge | Auto-merge + flag | CEO approves |
| Level 5 (Self-Governing) | Auto-merge | Auto-merge | Auto-merge + flag |

---

## System 5: On-Call

Agents are the primary responders for production issues. The board is the escalation path, not the first line of defense.

### Severity-Based Response

| Severity | Response Time | Primary | Escalation | Auto-Fix? |
|----------|--------------|---------|------------|-----------|
| **CRITICAL** | Immediate (next beat) | Developer + CTO | Board (if not fixed in 2 beats) | Yes if green/yellow |
| **HIGH** | Within 1 hour | Assigned agent | CTO → Board | Yes if green |
| **MEDIUM** | Within 4 hours | Assigned agent | CTO | No (queued for night shift) |
| **LOW** | Next night shift | Night shift | Never escalated | Via night shift |

### Escalation Chain

```
Issue detected
    │
    ├── Severity: CRITICAL or HIGH
    │     │
    │     ▼
    │   Agent assigned → investigates + fixes
    │     │
    │     ├── Fixed within 2 beats? → resolved, logged
    │     │
    │     └── NOT fixed?
    │           │
    │           ▼
    │         Escalate to CTO
    │           │
    │           ├── CTO resolves? → done
    │           │
    │           └── CTO can't resolve?
    │                 │
    │                 ▼
    │               Escalate to Board
    │               CEO posts: "Production issue. Agent couldn't fix.
    │                           Need board decision on [options]."
    │
    ├── Severity: MEDIUM
    │     → Queue for next agent heartbeat
    │     → If not resolved in 4 hours → escalate to CTO
    │
    └── Severity: LOW
          → Queue for night shift
          → Included in daily sync summary
          → Never escalated (gets fixed eventually or deprioritized)
```

### On-Call Schedule

```typescript
interface OnCallConfig {
  companyId: string;
  primaryResponders: Record<string, string>;  // event_type → agentRole
  escalationChain: string[];                  // ["assigned_agent", "cto", "board"]
  maxBeatsBeforeEscalation: number;           // default: 2 for critical, 6 for high
  criticalNotifyBoard: boolean;               // always notify board on critical (default: true)
  nightShiftOnCall: boolean;                  // agents respond to issues during night shift (default: true)
}
```

---

## Monitoring Hooks

Self-healing needs to detect issues. These hooks run during heartbeats and generate HealingEvents when problems are found.

### Build Health Monitor

```
Every Developer heartbeat (or recurring task every 4h):
  1. Run: npm run build (in workspace)
  2. If exit code != 0:
     → Create HealingEvent { type: "build_failure", severity: "high", evidence: stderr }
  3. If exit code == 0 but warnings:
     → Create HealingEvent { type: "build_failure", severity: "low", evidence: warnings }
```

### Test Health Monitor

```
Every Tester heartbeat (or recurring task daily):
  1. Run: npm run test (in workspace)
  2. If any tests fail:
     → Create HealingEvent { type: "test_regression", severity: "high", evidence: test output }
  3. Calculate coverage delta vs last run:
     → If coverage dropped > 5%:
        Create HealingEvent { type: "test_regression", severity: "medium", evidence: coverage diff }
```

### Preview Health Monitor

```
If preview is running (detected by preview.ts):
  1. Check: is preview process alive?
  2. If dead:
     → Create HealingEvent { type: "preview_crash", severity: "high", evidence: process exit code }
  3. If alive but returning 5xx:
     → Create HealingEvent { type: "runtime_error", severity: "high", evidence: HTTP response }
```

### Error Log Monitor

```
Periodically scan workspace for error patterns:
  1. Check: any new error files? (.error.log, crash reports)
  2. Check: console.error patterns in source code
  3. Check: unhandled promise rejections in recent logs
  → Create HealingEvents for any findings
```

---

## Database Schema

```sql
-- Healing events (detected issues)
CREATE TABLE healing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT,
  source_task_id UUID,
  detected_by TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open'     -- open | investigating | resolved | escalated
);

CREATE INDEX idx_healing_company ON healing_events(company_id, status);
CREATE INDEX idx_healing_severity ON healing_events(company_id, severity)
  WHERE status = 'open';

-- Healing tasks (assigned fixes)
CREATE TABLE healing_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  healing_event_id UUID NOT NULL REFERENCES healing_events(id),
  assigned_agent_id UUID,
  assigned_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  diagnosis TEXT,
  fix_description TEXT,
  files_changed JSONB NOT NULL DEFAULT '[]',
  verification_passed BOOLEAN,
  escalated_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Night shift tasks
CREATE TABLE night_shift_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  target_files JSONB NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'medium',
  estimated_tokens INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  files_changed JSONB NOT NULL DEFAULT '[]',
  report TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Recurring tasks
CREATE TABLE recurring_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  assigned_role TEXT NOT NULL,
  frequency TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  days INTEGER[],
  day_of_month INTEGER,
  priority TEXT NOT NULL DEFAULT 'medium',
  category TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  total_runs INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recurring_active ON recurring_tasks(company_id)
  WHERE is_active = true;

-- Recurring task instances
CREATE TABLE recurring_task_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_task_id UUID NOT NULL REFERENCES recurring_tasks(id),
  task_id UUID,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  completed_at TIMESTAMPTZ
);

-- Auto-merge decisions
CREATE TABLE auto_merge_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  source TEXT NOT NULL,
  blast_radius TEXT NOT NULL,
  files_changed JSONB NOT NULL DEFAULT '[]',
  change_description TEXT NOT NULL,
  verification_passed BOOLEAN,
  decision TEXT NOT NULL,
  merged_at TIMESTAMPTZ,
  reverted_at TIMESTAMPTZ,
  reverted_by TEXT,
  audit_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auto_merge_company ON auto_merge_decisions(company_id, created_at DESC);
```

---

## Integration Map

```
Spec 12 (Heartbeat)
  ├── Self-healing: event triggers immediate beat for critical issues
  ├── Night shift: runs during HEARTBEAT_OK idle beats
  └── Recurring tasks: scheduler ticks alongside heartbeat tick

Spec 13 (Governance)
  ├── Auto-merge: blast-radius classification gates merge decisions
  ├── Night shift: governance ensures agents stay within allowed scope
  └── Self-healing: trust score affects whether agent can auto-fix

Spec 14 (Self-Evolution)
  ├── Night shift patterns → feed into PatternLearner for skill formation
  ├── Code review findings (System 4) → trigger self-healing tasks
  └── Recurring review tasks → identify skill gaps

Spec 15 (Long-Horizon)
  ├── Lifecycle stage determines if night shift is allowed
  ├── Autonomy level determines auto-merge thresholds
  └── Night shift budget = 10% of sprint budget allocation

Spec 16 (Memory Consolidation)
  ├── Night shift runs ALONGSIDE sleep consolidation during idle time
  │   (Sleep = memory maintenance, Night shift = product maintenance)
  └── Self-healing events stored as high-valence memories (never forget)

Spec 18 (Meetings)
  └── Daily sync includes: auto-merged changes, night shift report, healing events

Spec 20 (Artifact UX)
  └── Night shift reports and healing summaries as board-readable artifacts
```

---

## Cost Model

```
Self-healing (per incident):
  Detection:        ~$0.00   (pure logic / shell commands)
  Triage:           ~$0.001  (LLM routing if ambiguous)
  Investigation:    ~$0.01-0.05 (CTO heartbeat)
  Fix:              ~$0.05-0.20 (Developer heartbeat)
  Verification:     ~$0.00   (build + test = shell commands)
  Total per fix:    ~$0.06-0.26

Night shift (per idle period):
  Task selection:   ~$0.003  (scan + LLM prioritize)
  Execution:        ~$0.05-0.15 per task
  3 tasks per cycle: ~$0.16-0.45
  Budget: 10% of sprint = ~$2.00

Recurring tasks (per run):
  Health check:     ~$0.00   (shell commands)
  Code scan:        ~$0.005  (LLM classify findings)
  Report:           ~$0.003  (LLM summarize)

Monthly overhead (active company):
  Self-healing: ~$1-3 (depends on issue frequency)
  Night shift: ~$4-8 (2-4 idle periods per sprint × 4 sprints)
  Recurring: ~$1-2
  Total: ~$6-13/month
```

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Night shift budget | 10% of sprint budget | Enough for meaningful improvements, not enough to bankrupt idle companies |
| Auto-merge for green | Always (at autonomy >= 2) | Safe changes shouldn't need human attention. Audit trail provides accountability. |
| Night shift scope | Single-beat tasks only | Prevents night shift from starting multi-beat work that blocks sprint execution |
| Escalation chain | Agent → CTO → Board | Three levels. Most issues resolve at agent level. Board is last resort. |
| Critical = immediate beat | Yes | Production down shouldn't wait for the next scheduled heartbeat |
| Night shift + sleep cycle | Run in parallel | Different targets (product vs memory). Both use idle compute. Non-competing. |
| Recurring task defaults | 8 auto-created per company | Provides baseline monitoring without manual setup. Board can customize. |
| Red tier during night shift | Blocked, queued for sprint | Night shift should never make irreversible changes without board knowledge |

---

## Implementation Phases

### Phase 1: Self-Healing Foundation (Detection + Triage)
**Build:** HealingEvent types, detection hooks (build/test/preview monitors), severity classification, agent assignment logic.
**Test:** Break the build intentionally → verify HealingEvent created → verify Developer assigned.
**Effort:** 3 days

### Phase 2: Self-Healing Execution
**Build:** Healing task flow in heartbeat, investigation → fix chain, verification after fix, escalation logic.
**Test:** Build failure → Developer fixes → verification passes → change committed. Runtime error → CTO investigates → Developer patches.
**Effort:** 3 days

### Phase 3: Auto-Merge
**Build:** Blast-radius classification, merge policy by tier, verification gate integration, 24h revert window, audit logging.
**Test:** Green change → auto-merged silently. Yellow change → merged + flagged. Red change → blocked for board.
**Effort:** 2 days

### Phase 4: Night Shift
**Build:** Night shift task selection per role, idle detection, budget allocation, task execution in heartbeat, night shift reports.
**Test:** Company idle > 30 min → Developer scans for TODOs → refactors one function → auto-merged (green) → logged.
**Effort:** 3 days

### Phase 5: Recurring Tasks
**Build:** RecurringTask scheduler, default task templates, cron evaluation, instance creation, integration with heartbeat tick.
**Test:** Create "build health check every 4h" → verify it fires → verify HealingEvent created on failure.
**Effort:** 2 days

### Phase 6: On-Call + Dashboard
**Build:** On-call config, escalation chain, response time tracking, self-healing dashboard (open issues, auto-fixes, night shift activity).
**Test:** Critical issue → immediate beat → CEO notified → if not fixed in 2 beats → board escalation.
**Effort:** 2 days

**Total: 15 days** (Phases 1-3 = 8 day MVP)

---

## Verification Checklist

### System 1: Self-Healing
- [ ] Build failure detected → HealingEvent created with severity "high"
- [ ] Runtime error detected → HealingEvent created, CTO assigned to investigate
- [ ] Test regression detected → Tester identifies, Developer assigned to fix
- [ ] CRITICAL severity → immediate beat triggered (don't wait for schedule)
- [ ] Agent fixes issue → verification gate runs → passes → change committed
- [ ] Agent can't fix → escalates to CTO → still can't fix → escalates to board
- [ ] All healing events logged in audit ledger
- [ ] CEO posts summary to board chat for resolved healing events

### System 2: Night Shift
- [ ] Night shift activates when company idle > 30 min (configurable)
- [ ] Night shift respects lifecycle stage (disabled in idea/planning)
- [ ] Night shift respects budget (10% of sprint, stops when exhausted)
- [ ] Developer scans for and fixes code quality issues
- [ ] Tester identifies and adds missing tests
- [ ] CTO reviews architecture and updates docs
- [ ] Each night shift task is bounded to one heartbeat cycle
- [ ] Night shift produces NightShiftReport artifact
- [ ] Night shift patterns feed into Spec 14 skill evolution

### System 3: Recurring Tasks
- [ ] 8 default recurring tasks auto-created per company
- [ ] Scheduler ticks every minute, creates instances for due tasks
- [ ] Tasks respect company lifecycle stage
- [ ] Tasks respect budget allocation
- [ ] Board can enable/disable/modify recurring tasks
- [ ] Task instances tracked with scheduled/running/completed status

### System 4: Auto-Merge
- [ ] Green tier changes → auto-merged without board notification (autonomy >= 2)
- [ ] Yellow tier changes → auto-merged + flagged in daily sync
- [ ] Red tier changes → blocked, board approval required
- [ ] Verification gate must pass before any auto-merge
- [ ] Board has 24h revert window for yellow merges
- [ ] Night shift NEVER produces red-tier changes
- [ ] Auto-merge decisions logged in `auto_merge_decisions` table
- [ ] Auto-merge policy adjusts by autonomy level (Spec 15)

### System 5: On-Call
- [ ] Critical issues get immediate response (next beat)
- [ ] High issues resolved within 1 hour or escalated
- [ ] Medium issues resolved within 4 hours or escalated to CTO
- [ ] Low issues queued for night shift
- [ ] Escalation chain: agent → CTO → board
- [ ] Board notified on all critical issues regardless of auto-fix

### End-to-End Scenario
- [ ] Sprint 3 completes. Product deployed. Company idle.
- [ ] Night shift activates: Developer refactors 2 functions (green, auto-merged), Tester adds 3 tests (green, auto-merged)
- [ ] 3 AM: Preview crashes (self-healing trigger)
  - [ ] HealingEvent created: type=preview_crash, severity=high
  - [ ] Developer assigned, investigates in next beat
  - [ ] Developer fixes null reference, verification passes
  - [ ] Auto-merged (yellow tier — flagged for daily sync)
  - [ ] CEO posts: "Preview crash auto-fixed at 3:14 AM"
- [ ] Morning: Board sees daily sync summary with night shift report + auto-fix summary
- [ ] Test coverage increased from 40% to 52% overnight
- [ ] Night shift budget: $0.45 of $2.00 used

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `packages/company-runtime/src/self-healing.ts` | HealingEvent detection, triage, assignment |
| `packages/company-runtime/src/night-shift.ts` | Task selection, execution, reporting per role |
| `packages/company-runtime/src/recurring-scheduler.ts` | Cron-based task scheduling, instance management |
| `packages/company-runtime/src/auto-merge.ts` | Blast-radius classification, merge policy, revert window |
| `packages/company-runtime/src/monitors/build-health.ts` | Build verification monitor |
| `packages/company-runtime/src/monitors/test-health.ts` | Test suite + coverage monitor |
| `packages/company-runtime/src/monitors/preview-health.ts` | Preview process health monitor |
| `packages/company-runtime/src/policies/healing-policies.ts` | Governance policies for self-healing + auto-merge |
| `packages/db/src/schema/healing.ts` | All healing + night shift + recurring + auto-merge tables |

### Modified Files

| File | Change |
|------|--------|
| `packages/contracts/src/domain.ts` | Add HealingEvent, HealingTask, NightShiftTask, RecurringTask, AutoMergeDecision types |
| `packages/company-runtime/src/heartbeat-checklist.ts` | Add healing events + night shift to agent checklists |
| `packages/company-runtime/src/policies/base-policies.ts` | Add auto-merge policies, night-shift-no-red policy |
| `apps/api/src/server.ts` | Add recurring scheduler tick alongside heartbeat |
| `apps/api/src/orchestrator.ts` | Integrate healing event detection into task completion path |
