# Spec 20: Agent Output & Artifact UX

> **Status:** DRAFT v1
> **Last updated:** 2026-04-14
> **Depends on:** Spec 12 (Heartbeat — artifacts produced per beat), Spec 15 (Long-Horizon — checkpoints produce artifacts), Spec 18 (Meetings — meeting summaries as artifacts)
> **Enables:** All specs — this is a quality standard that applies across the entire system
> **Cross-cutting:** Every spec produces artifacts. This spec defines what "good" looks like.

---

## What This Is

Every spec produces output that someone needs to understand — the board reviewing a sprint, the CEO reading a meeting summary, the CTO evaluating a code review. But today, there's no standard for what these outputs look like. A CTO plan might be a wall of text. A sprint summary might bury the important decision in paragraph 4. A meeting recap might be 2000 tokens when 200 would do.

This spec defines five things:

1. **Artifact Standards** — every agent output has a structured format with a schema
2. **Progressive Disclosure** — summary first, details on demand
3. **Demo Generation** — visual proof that code changes work
4. **Ambiguity Surfacing** — when agents face unclear decisions, surface the options explicitly
5. **Board-Readable Summaries** — every sprint produces a curated summary the board can understand in 30 seconds

> "As models get arbitrarily good at producing correct code, the quality of their non-code outputs becomes the differentiator." — Aman Sanger, Cursor

---

## Why This Matters

```
WITHOUT artifact UX:
  Sprint 1 completes.
  Board opens dashboard.
  Sees: 6 tasks completed. 10 files created.
  CTO review: 2000 words of technical analysis.
  Sprint summary: "Sprint 1 done. Built todo app with auth and CRUD."
  Board: "...did it work? What does it look like? What decisions were made?
          Do I need to do anything?"
  → Board has to dig through artifacts to understand what happened.
  → Important decisions buried in task descriptions.
  → No visual proof the product works.

WITH artifact UX:
  Sprint 1 completes.
  Board opens dashboard.
  Sees:
    ┌────────────────────────────────────────────────────────────┐
    │ Sprint 1 Complete ✅                                       │
    │                                                            │
    │ "Built todo app with add, complete, delete functionality.  │
    │  Auth system working. 4 components, 10 files, 0 failures." │
    │                                                            │
    │ [Preview Screenshot]  [View Code Changes]  [Full Report]   │
    │                                                            │
    │ Key Decisions:                                             │
    │   • Using jose for JWT (not jsonwebtoken)                  │
    │   • Tailwind for styling (not CSS modules)                 │
    │   • LocalStorage for state (no backend DB yet)             │
    │                                                            │
    │ Needs Your Input:                                          │
    │   ⚠ Sprint 2: Should we add user accounts or stay local?   │
    │   [Add Accounts] [Stay Local] [Discuss with CEO]           │
    └────────────────────────────────────────────────────────────┘
  → Board understands in 30 seconds. Can act immediately.
```

---

## The Five Systems

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    SPEC 20: ARTIFACT UX                                    │
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────────┐   │
│  │ SYSTEM 1:      │  │ SYSTEM 2:      │  │ SYSTEM 3:                │   │
│  │ ARTIFACT       │  │ PROGRESSIVE    │  │ DEMO GENERATION          │   │
│  │ STANDARDS      │  │ DISCLOSURE     │  │                          │   │
│  │                │  │                │  │ Screenshots of product   │   │
│  │ Schema per     │  │ Summary first  │  │ Test result summaries    │   │
│  │ artifact type  │  │ Expand for     │  │ Before/after diffs       │   │
│  │ Consistent     │  │ details        │  │ Build status badges      │   │
│  │ formatting     │  │ Never dump     │  │                          │   │
│  └────────────────┘  └────────────────┘  └──────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────┐  ┌────────────────────────────────────┐   │
│  │ SYSTEM 4:                │  │ SYSTEM 5:                          │   │
│  │ AMBIGUITY SURFACING      │  │ BOARD SUMMARIES                    │   │
│  │                          │  │                                    │   │
│  │ When agent faces unclear │  │ Sprint reports                     │   │
│  │ decision → surface       │  │ Night shift reports                │   │
│  │ options with tradeoffs   │  │ Self-healing reports               │   │
│  │ Board picks, agent acts  │  │ Weekly company brief               │   │
│  └──────────────────────────┘  └────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## System 1: Artifact Standards

Every agent output follows a typed schema. No free-form text dumps.

### Artifact Type Registry

| Artifact Type | Producer | Consumer | Schema |
|---------------|----------|----------|--------|
| `strategy_proposal` | CEO | Board | Vision, phases, scope, team, OKRs |
| `technical_plan` | CTO | PM, Developer | Architecture, stack, components, file structure |
| `acceptance_criteria` | PM | Developer, Tester | Definition of done, criteria checklist, non-goals |
| `code_change` | Developer | CTO (review), Board | Files changed, what/why summary, verification status |
| `test_report` | Tester | CTO, Board | Pass/fail counts, coverage %, failing tests |
| `code_review` | CTO / Automated (Spec 14) | Developer | Findings by severity, skill violations, suggestions |
| `sprint_summary` | CEO | Board | What was built, decisions made, what's next, needs input |
| `meeting_summary` | CEO (facilitator) | Board, all agents | Highlights, decisions, action items |
| `night_shift_report` | System | Board | What was improved, files changed, coverage delta |
| `healing_report` | System | Board | What broke, how it was fixed, who fixed it |
| `skill_mutation_report` | Skills Lead | Board (optional) | What skill changed, why, test results |
| `roadmap_update` | CEO | Board | Phase progress, milestone status, OKR movement |
| `checkpoint` | CEO | Board | Mid-sprint status, preview state, needs attention? |
| `escalation` | Any agent | Board | What's blocked, options, recommended action |
| `decomposition_plan` | CTO | Developer (sub-agents) | Sub-task DAG, dependencies, assignments |

### Base Artifact Schema

Every artifact has these fields:

```typescript
interface ArtifactBase {
  id: string;
  companyId: string;
  sprintId: string | null;
  type: ArtifactType;
  producedBy: string;                     // agentRole or "system"
  
  // Progressive disclosure (System 2)
  headline: string;                       // ≤15 words — the one thing to know
  summary: string;                        // 2-3 sentences — enough to decide if you care
  fullContent: string;                    // complete details (Markdown)
  
  // Metadata
  importance: "critical" | "high" | "medium" | "low";
  actionRequired: boolean;               // does the board need to do something?
  actionOptions: ActionOption[] | null;   // if actionRequired, what can they do?
  
  // Relationships
  relatedTaskIds: string[];
  relatedArtifactIds: string[];
  relatedMeetingId: string | null;
  
  createdAt: string;
}

interface ActionOption {
  label: string;                          // "Add Accounts" / "Stay Local"
  description: string;                    // what happens if they pick this
  action: string;                         // API action to execute
  isRecommended: boolean;                 // CEO's recommendation highlighted
}
```

### Artifact Production Rules

Every agent MUST follow these when producing artifacts:

1. **Headline first** — the single most important thing. ≤15 words.
2. **Summary second** — 2-3 sentences. Enough for a busy board member to decide if they need to read more.
3. **Details third** — full Markdown content. Only read by people who expanded.
4. **Action if needed** — if the board needs to decide something, provide explicit options with tradeoffs.
5. **Never dump raw output** — no unformatted LLM responses, no raw code diffs, no wall-of-text plans.

### Formatting Standards

```
GOOD artifact summary:
  "Sprint 1 built a working todo app with add, complete, and delete.
   4 React components, Tailwind styling, localStorage persistence.
   All 6 tasks passed. Ready for board review."

BAD artifact summary:
  "The sprint execution resulted in the completion of all assigned
   tasks including the implementation of CRUD functionality for todo
   items using React components with TypeScript and Tailwind CSS
   for styling with data persistence via the browser's localStorage
   API as specified in the CTO's technical plan document."

GOOD headline: "Todo app built — 6/6 tasks done, 0 failures"
BAD headline: "Sprint 1 Execution Complete"
```

---

## System 2: Progressive Disclosure

Never show everything at once. Board members should understand the company's state in 30 seconds, then drill deeper only where they need to.

### Three Disclosure Levels

```
LEVEL 1: DASHBOARD GLANCE (5 seconds)
  ┌────────────────────────────────────────────────────────┐
  │  Sprint 2 ███████████░░░░ 71%  │  Budget: $8/$20      │
  │  Stage: 🏗️ building            │  Autonomy: ⭐⭐⭐       │
  │  Last: "Auth + CRUD complete"  │  Issues: 0 open       │
  └────────────────────────────────────────────────────────┘

LEVEL 2: ARTIFACT SUMMARY (30 seconds)
  Board clicks on Sprint 2 →
  ┌────────────────────────────────────────────────────────┐
  │  Sprint 2: "Add payments and checkout"                 │
  │                                                        │
  │  ✅ Stripe client setup                                 │
  │  ✅ Checkout API endpoint                               │
  │  🔄 Webhook handler (in progress)                       │
  │  ⬜ Billing dashboard                                   │
  │                                                        │
  │  Key Decision: Using Stripe (not PayPal) — CTO decided │
  │  Preview: [View Screenshot]                            │
  │                                                        │
  │  ⚠ Needs Input: Webhook secret — use env var or vault? │
  │  [Env Variable] [Secret Vault] [Ask CEO]               │
  └────────────────────────────────────────────────────────┘

LEVEL 3: FULL DETAIL (2+ minutes)
  Board clicks "Full Report" →
  Complete CTO plan, PM spec, code changes, test results,
  review findings, meeting notes. Markdown rendered.
  Only for deep investigation.
```

### Disclosure Rules by Autonomy (Spec 15)

| Autonomy Level | What Board Sees by Default | Expands to |
|----------------|---------------------------|-----------|
| Level 1 (Supervised) | Level 2 for everything | Level 3 always available |
| Level 2 (Guided) | Level 1 dashboard + Level 2 for sprints | Level 3 on demand |
| Level 3 (Trusted) | Level 1 dashboard + Level 2 for flagged items only | Level 3 on demand |
| Level 4-5 (Autonomous) | Level 1 dashboard only | Level 2/3 on demand |

Higher autonomy = less noise in the board's view. The board can always drill down, but default view gets quieter as trust grows.

---

## System 3: Demo Generation

After code changes, automatically generate visual proof that the product works. This is the "artifact" that Cursor found most valuable — review the demo, not the diff.

### Demo Types

| Demo Type | When Generated | What It Shows | How |
|-----------|---------------|---------------|-----|
| **Preview Screenshot** | After build completes | Main page of the product | Headless browser → screenshot → store in Supabase Storage |
| **Test Summary Badge** | After test run | Pass/fail/coverage as a visual badge | Generate SVG badge from test results |
| **File Manifest** | After sprint completes | Tree view of all product files | Walk workspace directory |
| **Build Status** | After every build | ✅ Pass or ❌ Fail with error excerpt | Parse build output |
| **Diff Summary** | After code change | Which files changed, lines added/removed | Git diff --stat |

### Preview Screenshot Flow

```
Sprint task completes (build passes)
    │
    ▼
Preview server starts (existing preview.ts)
    │
    ▼
Wait for preview to be reachable (health check)
    │
    ▼
Capture screenshot:
  Option A (MVP): Headless curl + simple HTML snapshot
  Option B (with Playwright/PG-5): Full browser screenshot
    │
    ▼
Store screenshot:
  - Supabase Storage: assets/{companyId}/screenshots/sprint-{N}.png
  - Reference in sprint artifact
    │
    ▼
Include in sprint summary artifact:
  "Preview: [screenshot thumbnail]"
  Board clicks → full-size image
```

**MVP approach (no Playwright needed):**

```typescript
async function capturePreviewSnapshot(previewUrl: string): Promise<string> {
  // Simple approach: fetch the HTML and store as text artifact
  const response = await fetch(previewUrl);
  const html = await response.text();
  
  // Extract key elements for display
  const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? "Preview";
  const bodyLength = html.length;
  const hasReactRoot = html.includes("__next") || html.includes("root");
  
  return {
    type: "preview_snapshot",
    headline: `Preview running: "${title}"`,
    summary: `${bodyLength} bytes HTML, React: ${hasReactRoot ? "yes" : "no"}`,
    url: previewUrl,
    capturedAt: new Date().toISOString(),
  };
}
```

**Post-MVP (with Playwright/PG-5):**

```typescript
async function capturePreviewScreenshot(previewUrl: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(previewUrl, { waitUntil: "networkidle" });
  
  const screenshot = await page.screenshot({ type: "png" });
  const key = `assets/${companyId}/screenshots/sprint-${sprintNumber}.png`;
  await uploadToSupabaseStorage(key, screenshot);
  
  await browser.close();
  return createSignedUrl(key, 3600);  // 1-hour signed URL
}
```

---

## System 4: Ambiguity Surfacing

When agents face unclear decisions, they should NOT silently pick one option. They should surface the ambiguity to the board with structured options.

### When to Surface

```
Agent is executing a task and encounters:
    │
    ├── Technical choice with no clear winner
    │     "Should auth use JWT sessions or cookie sessions?"
    │     → Both are valid. CTO plan didn't specify.
    │
    ├── Scope ambiguity
    │     "Board said 'add payments' — does that include subscriptions?"
    │     → Could mean one-time OR recurring billing.
    │
    ├── Conflicting requirements
    │     "PM spec says 'simple UI' but CTO plan has 4 complex components"
    │     → Misalignment between spec and plan.
    │
    └── Resource tradeoff
          "Can finish Feature A or Feature B in this sprint, not both"
          → Board needs to prioritize.
```

### Ambiguity Artifact

```typescript
interface AmbiguityCard {
  type: "ambiguity";
  headline: string;                       // "Auth approach: JWT or cookies?"
  context: string;                        // why this decision matters
  options: AmbiguityOption[];
  recommendation: string | null;          // agent's recommendation (if any)
  urgency: "blocking" | "soon" | "informational";
  raisedBy: string;                       // agentRole
  raisedDuring: string;                   // taskId
}

interface AmbiguityOption {
  label: string;                          // "JWT Sessions"
  description: string;                    // "Stateless, scalable, needs refresh logic"
  pros: string[];
  cons: string[];
  estimatedImpact: string;               // "Adds 1 task to Sprint 2"
}
```

### Ambiguity Response Flow

```
Agent encounters ambiguity
    │
    ▼
Creates AmbiguityCard artifact
    │
    ├── urgency = "blocking"?
    │     → PAUSE task execution
    │     → CEO surfaces to board immediately
    │     → Board picks option → agent resumes with decision
    │
    ├── urgency = "soon"?
    │     → Continue with recommendation (if agent has one)
    │     → Surface in next checkpoint or meeting
    │     → Board can override within sprint
    │
    └── urgency = "informational"?
          → Log decision and rationale
          → Include in sprint summary
          → Board sees in Level 2 disclosure
```

### Ambiguity vs Autonomy

| Autonomy Level | Blocking Ambiguity | Soon Ambiguity | Informational |
|----------------|-------------------|----------------|---------------|
| Level 1 | Board decides | Board decides | Board informed |
| Level 2 | Board decides | Agent decides + flags | Board informed |
| Level 3 | Board decides | Agent decides + flags | Logged only |
| Level 4 | Agent decides + flags | Agent decides | Logged only |
| Level 5 | Agent decides | Agent decides | Logged only |

Higher autonomy = agents handle more ambiguity themselves. But truly blocking ambiguity (multiple valid approaches, significant cost difference) always surfaces to the board at levels 1-3.

---

## System 5: Board Summaries

Curated reports that give the board a complete picture without reading individual artifacts.

### Sprint Report

Generated when a sprint completes:

```typescript
interface SprintReport {
  type: "sprint_report";
  sprintNumber: number;
  
  headline: string;                       // "Sprint 2 shipped payments — 6/7 tasks done"
  
  summary: {
    tasksPlanned: number;
    tasksCompleted: number;
    tasksFailed: number;
    filesCreated: number;
    linesOfCode: number;                  // approximate
    testsPassing: number;
    testCoverage: number;                 // percentage
    costCents: number;
    durationMinutes: number;
  };
  
  whatWasBuilt: string[];                 // ["Stripe checkout", "Webhook handler", "Billing UI"]
  
  keyDecisions: Array<{
    decision: string;
    madeBy: string;                       // "CTO" / "CEO" / "meeting"
    rationale: string;
  }>;
  
  issuesEncountered: Array<{
    issue: string;
    resolution: string;
    resolvedBy: string;
  }>;
  
  needsAttention: Array<{
    item: string;
    urgency: "blocking" | "soon" | "informational";
    options: ActionOption[] | null;
  }>;
  
  nextSprintProposal: string | null;      // CEO's suggestion for next sprint
  
  previewUrl: string | null;
  previewScreenshot: string | null;       // Supabase Storage URL
  
  roadmapProgress: {
    currentPhase: string;
    phaseCompletion: number;              // percentage
    okrProgress: Array<{ objective: string; progress: number }>;
  };
}
```

### Night Shift Report

Generated when night shift runs:

```typescript
interface NightShiftReport {
  type: "night_shift_report";
  
  headline: string;                       // "Night shift: 5 improvements, coverage 40% → 52%"
  
  improvements: Array<{
    agent: string;
    category: string;                     // "refactor" | "test_coverage" | "documentation"
    description: string;
    filesChanged: string[];
    blastRadius: "green" | "yellow";
    autoMerged: boolean;
  }>;
  
  testCoverageBefore: number;
  testCoverageAfter: number;
  techDebtItemsFixed: number;
  budgetUsed: number;                     // cents
}
```

### Healing Report

Generated when self-healing resolves an issue:

```typescript
interface HealingReport {
  type: "healing_report";
  
  headline: string;                       // "Auth bug auto-fixed at 3:14 AM"
  
  incident: {
    type: string;                         // "runtime_error" | "build_failure"
    severity: string;
    description: string;
    detectedAt: string;
  };
  
  resolution: {
    investigatedBy: string;               // "CTO"
    fixedBy: string;                      // "Developer"
    description: string;
    filesChanged: string[];
    autoMerged: boolean;
    resolvedAt: string;
    durationMinutes: number;
  };
  
  preventionAction: string | null;        // "Added input validation to prevent recurrence"
}
```

### Weekly Company Brief

Aggregated summary for board review:

```typescript
interface WeeklyBrief {
  type: "weekly_brief";
  
  headline: string;                       // "Week 3: Phase 1 complete, starting collaboration features"
  
  sprintsSummary: Array<{
    sprintNumber: number;
    headline: string;
    tasksCompleted: number;
    costCents: number;
  }>;
  
  roadmapMovement: {
    phaseBefore: string;
    phaseAfter: string;
    milestonesAchieved: string[];
    milestonesRemaining: string[];
  };
  
  okrProgress: Array<{
    objective: string;
    lastWeek: number;                     // percentage
    thisWeek: number;
    trend: "improving" | "stable" | "declining";
  }>;
  
  nightShiftSummary: {
    tasksCompleted: number;
    coverageChange: number;               // +12%
    techDebtFixed: number;
  };
  
  healingSummary: {
    incidentsDetected: number;
    autoResolved: number;
    escalatedToBoard: number;
  };
  
  topDecisions: Array<{
    decision: string;
    madeIn: string;                       // "Sprint 3 meeting" / "Self-healing"
  }>;
  
  needsAttention: string[];               // items requiring board input
  
  budgetSummary: {
    totalSpent: number;
    remaining: number;
    burnRate: number;                     // per sprint average
    estimatedRunway: number;              // sprints remaining
  };
}
```

---

## Artifact Rendering in Dashboard

### CEO Chat Cards

Artifacts that need board attention surface as typed cards in the CEO chat:

```
┌──────────────────────────────────────────────────────────┐
│ 📋 SPRINT REPORT                          Sprint 2       │
│                                                          │
│ "Payments built — Stripe checkout, webhooks, billing UI. │
│  6/7 tasks done. 1 failed (webhook retry logic — fixed   │
│  in night shift). Test coverage: 67%."                   │
│                                                          │
│ Key: Using Stripe (CTO decided). JWT for auth sessions.  │
│                                                          │
│ [View Preview]  [Full Report]  [Approve Sprint 3]        │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ ⚠️ AMBIGUITY — Needs Your Input                          │
│                                                          │
│ "Sprint 3 scope: Add user accounts or stay localStorage? │
│  CTO recommends accounts (needed for collaboration)."    │
│                                                          │
│ [Add Accounts (recommended)]  [Stay Local]  [Discuss]    │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 🔧 SELF-HEALING REPORT                    3:14 AM        │
│                                                          │
│ "Auth endpoint was returning 500 on expired tokens.      │
│  Developer auto-fixed: added token refresh check.        │
│  Green tier — auto-merged. Tests passing."               │
│                                                          │
│ [View Fix]  [Revert]                                     │
└──────────────────────────────────────────────────────────┘
```

---

## Cost Model

```
Artifact generation is mostly FREE — it's formatting and structuring
data that already exists. The only LLM costs are:

Sprint report generation:    ~$0.005  (gpt-4o-mini, summarize sprint data)
Weekly brief generation:     ~$0.008  (gpt-4o-mini, aggregate weekly data)
Ambiguity card:              ~$0.003  (gpt-4o-mini, structure options)
Preview snapshot (MVP):      ~$0.00   (HTTP fetch, no LLM)
Preview screenshot (future): ~$0.00   (Playwright, no LLM)

Per sprint: ~$0.01-0.02 (negligible)
Per week: ~$0.02-0.03
```

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Headline ≤15 words | Strict limit | Forces clarity. If you can't say it in 15 words, you don't understand it. |
| Progressive disclosure (3 levels) | Dashboard → Summary → Full | Respects board time. They should understand in 30 seconds. |
| Ambiguity surfacing | Explicit options with tradeoffs | Prevents agents from silently making consequential decisions. |
| Demo = screenshots (MVP) | HTTP snapshot, not Playwright | No extra dependency. Playwright added post-MVP with PG-5 (Browser). |
| Board summaries | Generated per sprint + weekly | Cadence matches board attention. Sprint = per-change, weekly = big picture. |
| Artifact schema | Typed with headline/summary/full | Consistent across all spec outputs. Dashboard can render without parsing. |
| Autonomy × disclosure | Higher autonomy = quieter board view | Trust earned = less noise. Board can always drill down. |
| Action options | Explicit buttons with recommended choice | Board doesn't have to think about what to say. Just pick. |

---

## Implementation Phases

### Phase 1: Artifact Schema + Standards
**Build:** ArtifactBase type, artifact type registry, headline/summary/full structure, formatting rules.
**Modify:** All existing artifact producers (CEO strategy, CTO plan, PM spec, code review) to use the new schema.
**Test:** Every artifact type has headline ≤15 words, summary ≤3 sentences, full content as Markdown.
**Effort:** 3 days

### Phase 2: Progressive Disclosure in Dashboard
**Build:** Dashboard renders Level 1 (glance), Level 2 (summary card), Level 3 (full expandable). Autonomy level controls default disclosure.
**Test:** At autonomy 1: board sees Level 2 for everything. At autonomy 3: only flagged items at Level 2.
**Effort:** 3 days

### Phase 3: Sprint Report + Board Summaries
**Build:** Sprint report generator, weekly brief aggregator, night shift report, healing report. Posted to CEO chat as typed cards.
**Test:** Sprint completes → sprint report card in CEO chat with headline, key decisions, needs attention, preview link.
**Effort:** 2 days

### Phase 4: Ambiguity Surfacing
**Build:** AmbiguityCard type, detection hook in agent execution (when agent faces unclear choice), board response flow, urgency × autonomy matrix.
**Test:** Developer faces "JWT vs cookies" ambiguity → card surfaces → board picks → agent resumes with decision.
**Effort:** 2 days

### Phase 5: Demo Generation
**Build:** Preview snapshot (MVP — HTTP fetch), file manifest, build status badge, diff summary. Stored in Supabase Storage.
**Test:** Sprint completes → preview snapshot captured → included in sprint report card.
**Effort:** 2 days

**Total: 12 days** (Phases 1-3 = 8 day MVP)

---

## Verification Checklist

### System 1: Artifact Standards
- [ ] Every artifact has: headline (≤15 words), summary (2-3 sentences), fullContent (Markdown)
- [ ] Every artifact has: importance, actionRequired, actionOptions
- [ ] CEO strategy proposal uses ArtifactBase schema
- [ ] CTO technical plan uses ArtifactBase schema
- [ ] PM acceptance criteria uses ArtifactBase schema
- [ ] Code review uses ArtifactBase schema
- [ ] Sprint summary uses ArtifactBase schema
- [ ] No raw LLM output reaches the board (always formatted)

### System 2: Progressive Disclosure
- [ ] Dashboard Level 1: shows status bars, badges, one-line headline per sprint
- [ ] Dashboard Level 2: expandable card with summary + key decisions + action buttons
- [ ] Dashboard Level 3: full Markdown content rendered on expand
- [ ] Autonomy 1: Level 2 shown by default for all artifacts
- [ ] Autonomy 3: only flagged items shown at Level 2
- [ ] Autonomy 5: Level 1 only, everything else on demand

### System 3: Demo Generation
- [ ] Preview snapshot captured after build completes
- [ ] Snapshot stored in Supabase Storage
- [ ] Snapshot included in sprint report artifact
- [ ] File manifest generated (tree view of product files)
- [ ] Build status badge generated (pass/fail)
- [ ] Diff summary generated (files changed, lines added/removed)

### System 4: Ambiguity Surfacing
- [ ] Agent detects ambiguity → creates AmbiguityCard artifact
- [ ] Blocking ambiguity pauses task execution until board responds
- [ ] "Soon" ambiguity: agent continues with recommendation, flags for review
- [ ] Board sees options with pros/cons and recommended choice
- [ ] Board response routes back to agent → execution resumes
- [ ] Higher autonomy = agents handle more ambiguity themselves

### System 5: Board Summaries
- [ ] Sprint report generated on sprint completion
- [ ] Sprint report includes: headline, tasks summary, key decisions, needs attention, preview
- [ ] Night shift report generated after night shift cycle
- [ ] Healing report generated after auto-fix
- [ ] Weekly brief aggregates sprint + night shift + healing + roadmap
- [ ] All reports surface as CEO chat cards with action buttons
- [ ] Board can act directly from cards (approve, revert, respond)

### End-to-End Scenario
- [ ] Sprint 2 completes. Sprint report card appears in CEO chat:
  - [ ] Headline: "Payments built — 6/7 tasks, Stripe integrated"
  - [ ] Preview screenshot visible
  - [ ] Key decisions listed
  - [ ] "Approve Sprint 3" button
- [ ] Board clicks "Full Report" → Level 3 expands with CTO plan, code changes, test results
- [ ] During Sprint 3: Developer faces scope ambiguity → AmbiguityCard surfaces
  - [ ] Board sees options: [Add Accounts] [Stay Local]
  - [ ] Board clicks "Add Accounts" → Developer receives decision → continues
- [ ] Night shift runs → Night shift report card: "Coverage 52% → 64%, 3 refactors"
- [ ] Weekly brief arrives: "Phase 1 complete, Phase 2 at 40%, budget healthy"

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `packages/company-runtime/src/artifact-schema.ts` | ArtifactBase type, type registry, formatting validators |
| `packages/company-runtime/src/report-generator.ts` | Sprint report, weekly brief, night shift report, healing report generators |
| `packages/company-runtime/src/demo-capture.ts` | Preview snapshot, file manifest, build badge, diff summary |
| `packages/company-runtime/src/ambiguity-detector.ts` | Ambiguity detection hooks, AmbiguityCard creation, board response routing |

### Modified Files

| File | Change |
|------|--------|
| `packages/contracts/src/domain.ts` | Add ArtifactBase, SprintReport, WeeklyBrief, AmbiguityCard, ActionOption types |
| `apps/api/src/ceo.ts` | Strategy proposal uses ArtifactBase schema |
| `apps/api/src/orchestrator.ts` | CTO plan, PM spec, code changes use ArtifactBase schema; ambiguity detection hook |
| `apps/web/components/` | Dashboard disclosure levels, artifact cards, action buttons |
| `apps/web/app/page.tsx` | Sprint report cards, ambiguity cards, healing report cards in CEO chat |
