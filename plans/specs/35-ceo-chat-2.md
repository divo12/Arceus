# Spec 35 — CEO Chat 2.0

**Status:** Draft (in progress)
**Owner:** Board
**Date:** 2026-05-02
**Supersedes:** Quick Execute UI flow

---

## 1. North-star

The CEO chat **is** the company. Every action a user can take with the platform happens inside Avery's chat — bootstrap, hiring, approvals, asking questions, storing decisions. Quick Execute is removed.

Two outcomes:
1. **Bootstrap-via-conversation** — idea → name → strategy → hiring → sprint via interactive cards.
2. **Free-form mode** with three pillars: **Ask** (read-only Q&A), **Instruct** (spawn tasks/meetings/approvals), **Store** (write team-tier memory).

---

## 2. Card system

### 2.1 Wire format

A new `chat_messages.role = "card"` row with `card_id` foreign-key into `chat_cards.payload jsonb` holding `{ type, ...data }`. UI renders by `type`.

### 2.2 Card types (v1)

| Type | Trigger | Buttons | Edit fields |
|---|---|---|---|
| `idea_refine` | User sends raw idea | Accept reframing • Pick alt • Keep mine | Free-text edit |
| `name_suggest` | After idea locked | Pick name • Write-in | Name |
| `strategy_preview` | After name | Approve • Regenerate • Edit | Title, summary, scope[] |
| `hiring_slate` | After strategy approved | Approve all • Approve subset | Per-role: name, profile blurb |
| `sprint_plan` | After team hired | Kickoff • Edit • Regenerate | Goal, task titles |
| `approval` | Any agent calls `approval_request` | Approve • Reject (+ note) | Note text |
| `decision` | CEO calls `chat_emit_card(decision)` | One button per option | — |
| `meeting_summary` | Meeting Avery scheduled completes | Acknowledge • Drill into transcript | — |
| `memory_capture` | Store mode, or `chat_emit_card(memory_capture)` | Save • Edit • Discard | Content, tier, scope |

### 2.3 Lifecycle

- Cards persist in transcript forever — decisions are durable.
- UI shows them as **interactive until decided**, then **locked with the decision visible**.
- Decision capture: user click → **synthetic user message injected** (e.g. `[user picked: Notable]`) → CEO sees it in next turn → responds inline.
- Synthetic-message approach means we don't need a separate "wait for decision" state machine in the agent.

### 2.4 Emission mechanism

New MCP tool exposed to CEO only:

```
chat_emit_card(type, payload) → { cardId }
```

- Tool writes a `role:"card"` row into `chat_messages` plus the `chat_cards` row.
- SSE event `chat.card_added` pushes it to the open chat view.
- Emission is fire-and-forget for the agent; the user's reaction comes back as a future synthetic user message.

---

## 3. Modes (Ask / Instruct / Store)

### 3.1 UI

Segmented control **below the composer**, defaulting to **Ask** after bootstrap. Mode is a hint that travels with the message: `chat_messages.mode: "ask" | "instruct" | "store"`.

### 3.2 Semantics — enforced server-side at tool-allowlist level

| Mode | Allowed tools | Disabled tools |
|---|---|---|
| **Ask** | `task_list`, `sprint_get_*`, `memory_recall`, `meeting_list`, `agent_list`, `chat_emit_card(decision)` | All `*_create`, `*_update`, `memory_remember`, `approval_request` |
| **Instruct** | Everything in Ask + `task_create`, `meeting_request`, `approval_request`, `chat_emit_card(any)` | `memory_remember` |
| **Store** | `memory_recall`, `chat_emit_card(memory_capture)` only — `memory_remember` lands as **team-tier** unless CEO tags `private` in the card | All execution tools |

### 3.3 "CEO picks" tier/scope for Store

The Memory card always shows a tier (static / dynamic) + scope (team / private) dropdown, defaulting to dynamic / team. CEO's tool call sets the default; the user can override before clicking Save.

### 3.4 Why mode is a hard switch (not a hint)

Forcing the constraint in the allowlist prevents the LLM from "helpfully" creating tasks when you only wanted to ask a question — the #1 failure mode of free-form agentic chat.

---

## 4. Free-form context strategy

### 4.1 v1 (simple-and-expensive)

Inject full `CompanySnapshot` (already produced by `buildSnapshotView`, 12 parallel reads) into Avery's system prompt for every turn. Cost ≈ 3-5k tokens; acceptable for v1.

### 4.2 v2 (parked)

Lean snapshot summary + `task_list`/`sprint_get`/`memory_recall` tool calls when Avery needs detail. Decide after measuring v1 cost.

---

## 5. "Let me check with the team" — async meetings

When Avery decides she needs other agents' input, she calls a new MCP tool:

```
meeting_request(topic, attendees[], question) → { meetingId }
```

1. Schedules a real meeting via the existing meeting pipeline (status `scheduled`), tagged with `requested_by_chat_message_id`.
2. Returns immediately to Avery. Avery says in chat: *"I've asked Lin and Mina to weigh in — I'll come back when they do."*
3. Meeting runs async on next tick(s); `meeting_pipeline` emits `meeting.completed` event.
4. A small handler watches for completed meetings whose `requested_by_chat_message_id` is set, and emits a `meeting_summary` card via `chat_emit_card`.
5. SSE pushes the card to the live view.

This makes meetings first-class outputs of the chat, not just a separate tab.

---

## 6. Team-wide memory ("the sharepoint")

### 6.1 Audit (current state, verified)

- `memory_units.kind` column already stores `"team"` for non-private writes ([packages/hippocampus/src/backends/pgvector.ts](packages/hippocampus/src/backends/pgvector.ts#L150)).
- Service-layer writes default to `visibility: "team"` ([packages/hippocampus/src/service.ts](packages/hippocampus/src/service.ts#L27)).
- **But the read path filters strictly by `agent_id`** — Lin's "team" memory is invisible to Avery. Per-agent silos in practice.

### 6.2 Fix (smallest change)

Change `searchByEmbedding` and `list` in `pgvector.ts` to:

```sql
WHERE company_id = $1
  AND (agent_id = $2 OR kind = 'team')
  AND deleted_at IS NULL
```

A new `visibility: "private"` value (already in schema enum) opts a memory out of team view.

### 6.3 Write-side guard

In **Store mode**, default `kind="team"`. In all other modes (heartbeat-driven `memory_remember`), keep current default behavior (which is also `team`, but private is now a meaningful opt-out).

### 6.4 What stays per-agent

- **Static** (soul/role profile) — never written by chat.
- **Procedural** (skills) — skills-lead-only.
- **Priming** — automatic, per-agent.

---

## 7. Session isolation (heartbeat-vs-chat collision)

Two OpenCode sessions per company:

- `chat:<companyId>` — owned by chat surface, persistent across turns, used **only** for CEO chat.
- `heartbeat:<companyId>:<role>` — what every beat already uses (already isolated per beat via `createBeatSession`).

CEO heartbeat continues to use the heartbeat session. Chat opens the chat session on first message, holds it for the conversation. **No more `isCeoStreaming()` skip-logic** — they're physically separate.

Implementation: `getCeoSession()` becomes `getCeoChatSession()`. `resetCeoSession()` only kills the chat one. The CEO heartbeat path stops calling `isCeoStreaming()` checks.

---

## 8. Persistence

### 8.1 Reuse `board_messages` (do not create new tables)

The existing `board_messages` table already has `role`, `cardType`, `cardData`, cascades from `companies`, and has a contracts-driven check constraint on `cardType`. We extend in place rather than fork.

Migration `0021_chat2_board_messages_extension.sql` adds:

| Column | Type | Purpose |
|---|---|---|
| `mode` | `text` (nullable) | 'ask' \| 'instruct' \| 'store' for user messages |
| `parent_message_id` | `uuid` (fk, on delete set null) | Card → its decision message; threading |
| `card_decision` | `jsonb` | Captured decision payload |
| `card_decided_at` | `timestamptz` | When user clicked a button (null = pending) |
| `card_decided_by` | `text` | 'user' \| agentId |

Plus indexes:
- `board_messages_parent_idx (parent_message_id)`
- `board_messages_company_card_pending_idx (company_id, card_decided_at)` partial `WHERE card_type IS NOT NULL AND card_decided_at IS NULL`
- Check constraint: `mode IS NULL OR mode IN ('ask','instruct','store')`

### 8.2 Contracts enum extensions

Add to `chatMessageCardTypeSchema`:
- `idea_refine`, `name_suggest`, `hiring_slate`, `sprint_plan`, `decision`, `meeting_summary`, `memory_capture`

Existing types stay (`strategy_proposal`, `sprint_proposal`, `approval_request`, `welcome_brief`, `mission_brief`, `clarifying_question`, `status_update`, `review_summary`, `daily_sync_summary`, `info`).

Add corresponding `chatCardSchema` discriminated-union variants for each new type.

Extend `chatMessageSchema` with optional `mode`, `parentMessageId`, `cardDecision`, `cardDecidedAt`, `cardDecidedBy`.

### 8.3 Behavior

- Reload restores transcript (paginated, last 100 messages).
- Reset already cascades via `companies.id` FK; no additional cleanup needed.
- Switching companies swaps which transcript loads.

---

## 9. Cold-start happy path

```
1.  User: "lets build a sexy markdown notes app"
2.  Avery: "Got it. Here's how I'm reading this — pick one:"
    [card: idea_refine, 3 reframings + 'keep mine']
3.  User clicks → synthetic user message →
4.  Avery: "Names I like for this:"
    [card: name_suggest, 5 names]
5.  User picks "Velvet" →
6.  Avery: "Strategy draft:"
    [card: strategy_preview, editable summary]
7.  User approves →
8.  Avery: "I'll bring on this team:"
    [card: hiring_slate, 7 roles with 1-line rationale each]
9.  User approves all →
10. Avery: "First sprint plan:"
    [card: sprint_plan, goal + task list, editable]
11. User clicks Kickoff → company.status flips to 'active', beats start firing.
```

Each card transition is a CEO turn that emits exactly one card. No regex on Avery's text — emission is by tool call.

---

## 10. Where it lives

| Concern | Location |
|---|---|
| Card type definitions (Zod) | `packages/contracts/src/chat-cards.ts` |
| MCP tools (`chat_emit_card`, `meeting_request`) | `packages/arceus-mcp/src/tools/chat.ts` |
| DB tables + repos | `packages/db/src/repos/chat-messages.ts`, `chat-cards.ts` + migration `0007_chat_persistence.sql` |
| HTTP routes | `apps/api/src/routes/chat.routes.ts` (POST message, GET history, POST card decide, SSE stream) |
| Mode tool-allowlist gate | `apps/api/src/agents/chat.ts` (compute allowlist from mode before opencode call) |
| Team-memory query change | `packages/hippocampus/src/backends/pgvector.ts` |
| Async meeting → card bridge | `apps/api/src/meetings/chat-callback.ts` |
| UI chat surface | `apps/web/app/page.tsx` chat panel + `apps/web/components/chat/cards/*.tsx` |

---

## 11. Sequencing (smallest shippable steps)

### Step 1 — Foundation (no UX change)

- **Migration `0021`** — extend `board_messages` with `mode`, `parent_message_id`, `card_decision`, `card_decided_at`, `card_decided_by`.
- **Contracts** — extend `chatMessageCardTypeSchema` with new card types and add `chatCardSchema` variants. Extend `chatMessageSchema` with new optional fields.
- **DB schema** (`packages/db/src/schema/board_messages.ts`) — add new columns + index defs.
- **Repos** — extend `board_messages.ts` with `markCardDecided(cardMessageId, decision, decidedBy)` and `listPendingCards(companyId)`.
- **Team-memory query fix** in `pgvector.ts` (+ test).
- **Two OpenCode sessions** (chat vs heartbeat) — kill `isCeoStreaming()` skip.
- **`resetCompanyTx`** — already cascades via FK; no change.

### Step 2 — Backend chat surface

- `POST /api/chat/messages`, `GET /api/chat/history`, `POST /api/chat/cards/:id/decide`, `GET /api/chat/stream` (SSE).
- Mode-based tool allowlist computation.
- `chat_emit_card` MCP tool registered on CEO allowlist.
- Synthetic-user-message injection on `decide` POST.

### Step 3 — UI shell

- Replace current chat in `apps/web/app/page.tsx`.
- Mode segmented control below composer.
- Generic card renderer + 3 baseline card types: `decision`, `memory_capture`, `approval`.

### Step 4 — Bootstrap flow

- Add 5 bootstrap card types (idea_refine, name_suggest, strategy_preview, hiring_slate, sprint_plan).
- CEO soul prompt updated to drive the sequence.
- Remove Quick Execute button.

### Step 5 — Async meetings → cards

- `meeting_request` tool.
- `meeting.completed` → `meeting_summary` card bridge.

---

## 12. Open questions (parked, will revisit at relevant step)

- **Step 4**: should Avery propose the company name from your idea automatically, or wait for you to nudge ("what should we call it?")?
- **Step 4**: when you reject a hiring slate, does Avery regenerate the whole team, just the rejected role, or open a side-conversation to discuss?
- **Step 3**: do edits inside a card trigger a re-render through Avery (LLM validates), or are they final on Save?

---

## 13. Out of scope for this spec

- Memory browser UI ("M5") — separate chunk.
- Trust-band UX changes — separate chunk.
- Multi-tenant chat isolation — single-tenant assumption holds.
- Replacing TUI chat — TUI continues to use existing endpoints until it migrates.
