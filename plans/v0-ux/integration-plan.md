# v7 → real system integration plan

Wire every visible element in [plans/v0-ux/mockup-v7.html](plans/v0-ux/mockup-v7.html) to a typed handshake. Every string the user reads is either (a) a literal label, or (b) AI-generated text returned through a Zod-validated envelope. No untyped strings cross the wire.

The backend already has substantial coverage — `packages/contracts` (~20 Zod modules) and `apps/api/src/routes` (24 route files). This plan inventories what's reusable, calls out gaps as `❌ NEW`, and proposes the smallest typed additions to close them.

---

## 1. Handshake conventions

### 1.1 Response envelope
All view endpoints return one shape, defined once in `packages/contracts/src/view.ts`:

```ts
export const viewEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) => z.object({
  view: z.string(),                    // e.g. "today.v1"
  generatedAt: z.string().datetime(),
  source: z.enum(["live", "cache", "stale"]),
  trace: z.object({                    // for debug / lineage
    runId: z.string().nullable(),
    sources: z.array(z.string()),      // contributing data sources
  }).optional(),
  data,
});
```

Every UI page calls **one** view endpoint. The page is a pure projection of `data`. No client-side aggregation.

### 1.2 AI-generated narrative
Any field containing prose written by an agent is wrapped in `narrativeTextSchema`:

```ts
export const narrativeTextSchema = z.object({
  text: z.string(),                    // the rendered string
  authorAgentId: z.string().nullable(),
  generatedAt: z.string().datetime(),
  sourceBeatId: z.string().nullable(), // for lineage / "show your work"
  confidence: z.number().min(0).max(1).optional(),
});
```

Examples in v7 that are narratives, not labels:
- The 30px serif sentence on every page (`"What the company can do."`)
- The subline (`"Two skills evolved this week..."`)
- `.ask` (the verb-bearing line on every `.item`)
- `.why` (the second-clause prose)
- `.memory` blockquote text
- `Open thread` decision summaries

Labels (`Sprint`, `Done`, `Pause`, `v3`, `used 14×`) are NOT narratives — they're enum-driven.

### 1.3 Action handshake
Every button is a `POST` to a typed action endpoint that returns the new state of the affected resource so the page can re-render without a refetch:

```ts
export const actionResultSchema = <T extends z.ZodTypeAny>(resource: T) => z.object({
  ok: z.literal(true),
  resource,                            // the post-action resource
  derived: z.object({                  // recomputed counts / sublines
    sublineDelta: narrativeTextSchema.nullable(),
    badgeDeltas: z.record(z.string(), z.number()),
  }).optional(),
  audit: z.object({                    // links into Logs tab
    eventId: z.string(),
    category: auditCategorySchema,
  }),
});
```

### 1.4 Streaming (live updates)
The breathing dot, working-agent pips, and any "now" view subscribe to a single SSE channel `/api/view/stream` that emits a discriminated union:

```ts
export const viewStreamEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("badge"),    tab: tabIdSchema, value: z.string() }),
  z.object({ kind: z.literal("invalidate"), view: viewIdSchema }),
  z.object({ kind: z.literal("agent.pip"),  agentId: z.string(), pip: z.enum(["green","amber","none"]) }),
  z.object({ kind: z.literal("toast"),    text: narrativeTextSchema }),
]);
```

The page listens, increments badges, and refetches the affected view envelope. No bespoke websocket per tab.

### 1.5 Error envelope
```ts
export const viewErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum(["unauthorized","not_found","stale","upstream_failed","ai_unavailable","budget_exceeded"]),
  message: narrativeTextSchema,        // AI-written user-facing prose
  retryAfterMs: z.number().nullable(),
});
```

`ai_unavailable` is its own code so the UI can render the calm "the company is thinking" placeholder rather than a stack trace.

---

## 2. Tab → endpoint map

Sidebar reads from one shell endpoint, then each tab has one view endpoint and N action endpoints.

### 2.0 Shell — `GET /api/view/shell`
Drives the sidebar (badges, brand, footer, settings link).

| UI element | Field | Schema | Status |
|---|---|---|---|
| Brand `Acme.` | `company.shortName` | `companySchema` | ✅ |
| `Today` green dot | `health.live: boolean` | `❌ NEW shellSchema.health` | ❌ NEW |
| `Sprint 11/14` | `sprint.activeIndex / sprint.total` | `sprintSchema` (count derived) | ⚠ derive |
| `Team 14` | `team.activeCount` | `agentSchema[]` count | ✅ |
| `Memory 42` | `memory.lessonCount` | `memoryUnitSchema[]` count | ✅ |
| `Skills 9 · 3` | `skills.libraryCount / skills.formingCount` | `skillArtifactSchema` group-by status | ✅ |
| `Meetings 3` | `meetings.todayCount` | `meetingSchema[]` filter today | ✅ |
| `Inbox 2` | `inbox.waitingCount` | `approvalSchema` where pending | ✅ |
| `Preview 2` | `preview.liveCount` | `❌ NEW previewBuildSchema` | ❌ NEW |
| `Logs 2,184` | `logs.todayCount` | `auditEventSchema` count | ✅ |
| CEO avatar + initials | `ceo.identity` | `agentIdentitySchema` (role=ceo) | ✅ |

**Gap:** no single `shellSchema` — add `packages/contracts/src/view-shell.ts` that aggregates these counts so the UI doesn't fan out.

---

### 2.1 Today — `GET /api/view/today`

| UI element | Field | Schema | Status |
|---|---|---|---|
| Date kicker `Thursday, Sprint 14, day 4` | `kicker: narrativeTextSchema` | NEW (derived from `sprintSchema`) | ⚠ |
| Sentence `"Quiet morning..."` | `headline: narrativeTextSchema` | ❌ NEW agent-authored | ❌ NEW |
| Subline `"4 working · 10 resting · ..."` | `subline: narrativeTextSchema` | derived from agents | ⚠ |
| `Needs you` rows (2) | `decisions: approvalSchema[]` + `narrativeTextSchema` per row | ✅ + narrative wrap | ⚠ |
| `Right now` rows (4) | `workingAgents: { agent, ask, why }[]` | `agentSchema` + `taskSchema.title` | ✅ |
| `Memory in flight` blockquote | `formingMemory: memoryUnitSchema (status=draft)` | ✅ | ✅ |
| `Open` link on decision | `POST /api/approvals/:id/open` → opens thread view | ❌ NEW thread route | ❌ NEW |
| `Approve` / `Hold` actions | reuse `POST /api/approvals/:id/resolve` | ✅ | ✅ |

**Gaps:**
1. Headline narrative — needs a "company-narrator" agent that writes the daily sentence. New skill: `compose-daily-headline`.
2. Decision thread route — currently `approvalSchema` has no thread; needs `threadSchema = { messages: chatMessageSchema[] }` linked by `approvalId`.

---

### 2.2 Sprint — `GET /api/view/sprint/:sprintId?` (default = active)

| UI element | Field | Schema | Status |
|---|---|---|---|
| `Sprint 14, day 4 of 7` | `sprint.{number, dayOfSprint, length}` | `sprintSchema` | ⚠ add `dayOfSprint` derived |
| Progress bar `78%` | `sprint.progressPct` | derived from `taskSchema[].status` | ⚠ derive |
| Sentence `"Engineering is shipping..."` | `headline: narrativeTextSchema` | ❌ NEW per-sprint narrative | ❌ NEW |
| Team sections (4) | `teams: { role, tasks: taskSchema[] }[]` | grouped by `task.assignedRole` | ✅ |
| `Done`/`Now`/`Next` row labels | enum from `taskSchema.status` | ✅ | ✅ |
| `shipped`/`reading`/`writing`/`queued` verbs | `taskSchema.executionStatus` → label map | ⚠ map |
| Strikethrough on done | client styling from status | ✅ | ✅ |

**Gap:** sprint headline narrative.

---

### 2.3 Team — `GET /api/view/team`

| UI element | Field | Schema | Status |
|---|---|---|---|
| `Working now` (4 .item rows) | `working: { agent, currentBeat, ask, why }[]` | `agentSchema` + `beatRecordSchema` (active) | ✅ |
| Pip color (green/amber) | derived from `beat.outcome` running, or `executionStatus` | `beatRecordSchema` | ✅ |
| `ask` line | `currentBeat.taskTitle` as narrative | `taskSchema.title` wrapped | ⚠ |
| `why` line | `currentBeat.reasoning` | `❌ NEW beat.reasoning` field | ❌ NEW |
| `Open thread` action | `GET /api/agents/:id/thread` | ❌ NEW | ❌ NEW |
| `Pause` action | `POST /api/agents/:id/pause` → `actionResult(agentSchema)` | ❌ NEW (use orchestrator stop?) | ❌ NEW |
| `Resting 10` rows | `resting: { agent, idleFor: durationMs }[]` | `agentSchema.lastActiveAt` | ✅ |

**Gaps:** per-agent thread, per-agent pause, beat reasoning narrative.

---

### 2.4 Memory — `GET /api/view/memory`

| UI element | Field | Schema | Status |
|---|---|---|---|
| Sentence + subline | `headline, subline: narrativeTextSchema` | ❌ NEW | ❌ NEW |
| `Forming now` (3 italic blockquotes) | `forming: memoryUnitSchema[] where status='draft'` | ✅ | ✅ |
| Memory cite line `OTTO · ...` | `memoryUnitSchema.{authorAgentId, sourceBeatId, createdAt}` | ✅ | ✅ |
| `Recent lessons` (5 rows) | `recent: memoryUnitSchema[] where status='active' order by createdAt desc limit 5` | ✅ | ✅ |
| Footer counts | derived | ✅ | ✅ |
| (No actions in v7) | — | — | — |

**Gap:** narrative headline only.

---

### 2.5 Skills — `GET /api/view/skills`

| UI element | Field | Schema | Status |
|---|---|---|---|
| Sentence + subline | narratives | ❌ NEW | ❌ NEW |
| `Forming now` (3 .item rows) | `forming: skillArtifactSchema[] where status='draft'` | ✅ | ✅ |
| `tried 4 times` | `skillArtifactSchema.usageCount` (or `.attempts`) | ⚠ rename/add `attempts` distinct from `usageCount` | ⚠ |
| `ask` line ("Probe a flow...") | `skillArtifactSchema.name` (already a sentence) | ✅ | ✅ |
| `why` line (rationale) | `skillMutationSchema.mutationReason` or new `skill.draftReason` | ⚠ |
| `Read draft` action | `GET /api/skills/:id` (existing detail view) | ✅ | ✅ |
| `See attempts` action | `GET /api/skills/:name/history` | ✅ | ✅ |
| `Promote` action | `POST /api/skills/:id/promote` → `actionResult(skillArtifactSchema)` | ❌ NEW (have mutations workflow but not direct promote) | ❌ NEW |
| `Send back` action | `POST /api/skills/:id/send-back` with `narrativeTextSchema` reason | ❌ NEW | ❌ NEW |
| `In the library` (9 rows) | `library: skillArtifactSchema[] where status='active' order by version desc` | ✅ | ✅ |
| Version badge `v3 · new` | `skillArtifactSchema.version` + freshness flag | ⚠ derive `isNew` |
| `used 14×` | `skillArtifactSchema.usageCount` | ✅ | ✅ |
| `How a skill evolves` (5 rows) | **static enum content** — `skillLifecycleStageSchema` | ❌ NEW const enum | ❌ NEW |
| Footer | derived counts + `promotedThisSprint`, `retiredThisSprint` | ⚠ derive |

**Gaps:** promote/send-back endpoints, lifecycle enum module, distinguish `attempts` from `usageCount`.

---

### 2.6 Meetings — `GET /api/view/meetings`

| UI element | Field | Schema | Status |
|---|---|---|---|
| Sentence + subline | narratives | ❌ NEW | ❌ NEW |
| Meeting rows (3 .item) | `recent: meetingSchema[]` | ✅ | ✅ |
| `who` (day · time · attendees) | `meetingSchema.{scheduledAt, contributions[].agentId}` | ✅ | ✅ |
| `ask` (the question) | `meetingSchema.synthesis.primaryQuestion` | ⚠ add field to `synthesisOutputSchema` |
| `why` (the decision) | `meetingSchema.resolution.decisions[0].summary` (narrative) | ✅ | ✅ |
| `Read transcript` action | `GET /api/meetings/:id/transcript` | ❌ NEW | ❌ NEW |

**Gaps:** transcript route, `synthesisOutputSchema.primaryQuestion`.

---

### 2.7 Inbox — `GET /api/view/inbox`

| UI element | Field | Schema | Status |
|---|---|---|---|
| Sentence + subline | narratives | ❌ NEW | ❌ NEW |
| `Waiting` rows (2 .item) | `waiting: approvalSchema[] where status='pending'` + agent + narrative `why` | ✅ + ⚠ |
| `Approve` / `Hold` | `POST /api/approvals/:id/resolve` (existing) | ✅ | ✅ |
| `Cleared today` (5 list rows) | `clearedToday: approvalSchema[] where resolvedAt today` | ⚠ filter | ⚠ |
| `Approved` / `Held` verb | `approvalSchema.status` → label | ✅ | ✅ |

---

### 2.8 Preview — `GET /api/view/preview`

| UI element | Field | Schema | Status |
|---|---|---|---|
| Sentence + subline | narratives | ❌ NEW | ❌ NEW |
| `Production build 482` row | `live.production: previewBuildSchema` | ❌ NEW | ❌ NEW |
| `Staging-PR build 483` row | `live.staging: previewBuildSchema` | ❌ NEW | ❌ NEW |
| `Open` action | external URL from `previewBuildSchema.publicUrl` | ❌ NEW field | ❌ NEW |
| `See diff` action | `GET /api/workspace/diff?from=&to=` (existing) | ✅ | ✅ |
| `Roll back` action | `POST /api/preview/rollback` | ❌ NEW | ❌ NEW |
| `Recent deploys` (4 list) | `recent: previewBuildSchema[]` | ❌ NEW | ❌ NEW |

**Gap:** entire `previewBuildSchema` and rollback route. Today's `/api/preview` returns workspace state only.

---

### 2.9 Logs — `GET /api/view/logs?cursor=&limit=50`

| UI element | Field | Schema | Status |
|---|---|---|---|
| Sentence + subline | narratives | ❌ NEW | ❌ NEW |
| 10 list rows (timestamp / event / `tool: ...`) | `beats: { ts, narrative, tool }[]` from `auditEventSchema` | ✅ | ✅ |
| Cursor / load more | `nextCursor: string \| null` | ⚠ add | ⚠ |
| Live tail | subscribe `/api/audit/stream` (existing) | ✅ | ✅ |

---

### 2.10 Settings — `GET /api/view/settings`

| UI element | Field | Schema | Status |
|---|---|---|---|
| `Company` group rows | `company: companySchema` | ✅ | ✅ |
| `Budget` group rows | `budget: ❌ NEW companyBudgetSchema` | governance has sprint-budget, not company-level | ❌ NEW |
| `Trust` group rows | `trust: trustScoreSchema[]` | ✅ | ✅ |
| `Edit` verbs → forms | `PATCH /api/company`, `PATCH /api/governance/budget`, `PATCH /api/governance/trust-scores/:id` | ⚠ partial — only adjust exists | ⚠ |

**Gap:** company-level budget settings, generic patch routes for company fields.

---

## 3. Net new contracts to add

```
packages/contracts/src/
  view.ts              ← envelope, narrativeText, actionResult, viewError, viewStreamEvent, viewIdSchema, tabIdSchema
  view-shell.ts        ← shellSchema (sidebar)
  view-today.ts        ← todayViewSchema
  view-sprint.ts       ← sprintViewSchema (extends sprintSchema with dayOfSprint, progressPct, teams)
  view-team.ts         ← teamViewSchema
  view-memory.ts       ← memoryViewSchema
  view-skills.ts       ← skillsViewSchema, skillLifecycleStageSchema (5-step enum)
  view-meetings.ts     ← meetingsViewSchema (+ extend synthesis with primaryQuestion)
  view-inbox.ts        ← inboxViewSchema
  view-preview.ts      ← previewBuildSchema, previewViewSchema
  view-logs.ts         ← logsViewSchema (cursor pagination)
  view-settings.ts     ← settingsViewSchema, companyBudgetSchema
  threads.ts           ← threadSchema (decision/agent threads)
```

Each `view-*.ts` exports `<name>ViewSchema` and a typed `<name>ViewEnvelope = viewEnvelopeSchema(<name>ViewSchema)` so client and server share the literal source of truth.

## 4. Net new routes

```
GET  /api/view/shell
GET  /api/view/today
GET  /api/view/sprint/:sprintId?
GET  /api/view/team
GET  /api/view/memory
GET  /api/view/skills
GET  /api/view/meetings
GET  /api/view/inbox
GET  /api/view/preview
GET  /api/view/logs
GET  /api/view/settings
GET  /api/view/stream                 (SSE, viewStreamEventSchema)

POST /api/approvals/:id/open          (returns threadSchema)
POST /api/agents/:id/pause            (returns agentSchema)
GET  /api/agents/:id/thread           (threadSchema)
POST /api/skills/:id/promote          (actionResult(skillArtifactSchema))
POST /api/skills/:id/send-back        (actionResult(skillArtifactSchema))
GET  /api/meetings/:id/transcript     (threadSchema with role=meeting)
POST /api/preview/rollback            (previewBuildSchema)
PATCH /api/company                    (companySchema patch)
PATCH /api/governance/budget          (companyBudgetSchema)
```

## 5. Narrative-author skill

The 30px serif sentence on each page is the highest-leverage narrative in the product. Implementation:

1. Add an active skill `compose-view-headline` (one per view kind: today, sprint, team, ...).
2. Each view endpoint, after computing structured `data`, calls the skill with `data` + `lastHeadline` and gets back `narrativeTextSchema`.
3. Cached per view per heartbeat — regenerated only when the underlying counts/state change. SSE `invalidate` event triggers refresh.
4. Headline is **deterministic-on-empty**: if the AI is unavailable, fall back to a templated string built from the same `data`. UI never blocks on an LLM call.

This is the single biggest "is it Apple-discipline" lever — keep the prompt one paragraph, forbid adjectives, and the page reads calm.

## 6. Build order (smallest viable slice first)

1. **`view.ts` envelope + error + stream union.** No behavior change, just the types. (1 PR)
2. **Shell endpoint + sidebar wiring.** Replace any current ad-hoc badge fetches with `/api/view/shell`. (1 PR)
3. **Today + Sprint + Team views** — three views, share the headline-narrator skill, prove the pattern end-to-end. (1 PR each)
4. **Memory + Skills views** — knowledge group; no new actions, just projections. (1 PR each)
5. **Inbox + Meetings + Logs** — wire existing approval/meeting/audit routes through the envelope. (1 PR)
6. **Skills lifecycle actions** — promote / send-back endpoints + lifecycle enum module. (1 PR)
7. **Preview + Settings** — build the missing `previewBuildSchema` and rollback route, then the views. (1 PR)
8. **SSE invalidation** — switch the breathing dot, working pips, and badge counts onto `/api/view/stream`. (1 PR)
9. **Headline narrator skill** — last, because every view falls back to template strings until this lands. (1 PR)

## 7. Things to raise (functionality that doesn't exist yet)

These are real product gaps, not just contract gaps:

- **Decision threads.** v7 promises `Open thread` on every needs-you item, but approvals today are just `pending → approved/rejected`. There's no conversation model attached. Decide: is a thread a `meetingSchema` of type `escalation`, or a new `threadSchema`?
- **Per-agent pause.** Orchestrator-level stop exists; pausing one agent mid-beat is not a current capability. Likely needs a beat-loop interrupt signal.
- **Skill "send back" with reason.** The mutation pipeline exists for AI-driven improvement, but a CEO-driven "this is close, fix X" loopback is new. Treat it as creating a new `skillMutationSchema` with `mutatedBy='ceo'` and the CEO's note as `mutationReason`.
- **Preview / build pipeline.** No real model of named builds (production vs staging vs PR), public URLs, or rollback. Today `/api/preview` exposes workspace state. This is the largest greenfield piece.
- **Company-level budget.** Governance tracks per-sprint budgets and per-agent trust; there's no monthly company budget the CEO can edit in Settings.
- **`narrativeTextSchema` on existing fields.** Many existing schemas (`taskSchema.title`, `meetingSchema.resolution`, `approvalSchema.summary`) are bare strings. The migration is non-trivial because these are AI-generated and we want lineage. Either widen to `string | narrativeText`, or add a sibling `*Narrative` field and deprecate over a sprint.
- **Headline narrator skill.** The product depends on calm, accurate one-sentence summaries. This is a real skill to design, not a stub.
- **`dayOfSprint`, `progressPct`, `clearedToday` derivations.** These are obvious but currently nowhere. Decide: derived in the view endpoint, or denormalized into the source schema?

## 8. Definition of done for the integration

- Every string the user reads in v7 traces to either a contract enum or a `narrativeTextSchema` field.
- Every action button has a `POST` returning `actionResultSchema(<resource>)`.
- Sidebar badges and live indicators react to `/api/view/stream` only — no polling.
- AI outage degrades to templated narratives; the UI never shows a spinner longer than the heartbeat.
- `pnpm typecheck` passes with the contracts shared between `apps/api` and `apps/web` (web imports `@arceus/contracts`, no duplication).
