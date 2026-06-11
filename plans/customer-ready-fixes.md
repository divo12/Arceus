# Customer-Ready Fixes — Beat Stalling on gpt-5.2

**Goal:** stop developer beats from dying (2-min silence reap / 15-min hard-cap with work discarded) so the system demos reliably. Ranked by leverage ÷ effort. Sources: this repo's code, `plans/paperclip/02-heartbeat-and-agent-runtime.md`, and how Claude Code / Codex CLI / SWE-agent / Aider / OpenHands handle the same failure modes (links inline).

---

## 1. Failure model (what the code actually does today)

Two exit doors, one root cause:

| Exit door | Mechanism | Where |
|---|---|---|
| **Silent stall (2 min)** | No SSE event for `BEAT_STALL_TIMEOUT_MS=120s` → reject | `apps/api/src/prompts/llm.ts:136,306` |
| **Hard cap (15 min)** | Model streams reasoning (each delta **bumps `lastActivityAt`** via `event-bridge.ts:200`) but emits no tool calls → no guard fires → `HARD_CAP_MS` kills the beat, claims released, session destroyed | `run-beat.ts:39,213`; `event-bridge.ts:196-201` |

**Root cause chain:** every beat cold-starts a fresh session (`run-beat.ts:85` → `destroyBeatSession` in `finally`) → model re-derives all context → 28–38 whole-file reads at OpenCode's default `limit:2000` / 50 KB cap (~12–15k tokens *each*) → 300–500k tokens of file content per beat → reasoning balloons → progress stops. Codex CLI, OpenAI's own harness for this model family, caps tool output at **256 lines / 10 KiB** ([codex#7906](https://github.com/openai/codex/issues/7906)) — we feed gpt-5.2 observations ~5× larger than what it was tuned on.

**Compounding:** Hippocampus memory pipeline (`apps/api/src/memory/extractors.ts` — fact extraction, action decisions, habit matching) is hardcoded to `"workerDeployment"` = gpt-5.2, stealing TPM from beats and flooding the inspector with `companyId:"_system"` audits.

**Existing guards and their blind spots:**

| Guard | Value | Status | Blind spot |
|---|---|---|---|
| `BEAT_STALL_TIMEOUT_MS` | 2 min | active | reasoning deltas reset it — never fires on "thinking forever" |
| `NO_TOOL_INVOKED_DEADLINE_MS` | 45 s | active | only checks `toolCallCount === 0` — useless after the *first* tool call |
| `NO_PRODUCTIVE_ACTION_DEADLINE_MS` | 3 min | **disabled** (`llm.ts:331-357`) | false-fired on legit work |
| `READ_LOOP_THRESHOLD` | 200 | effectively disabled | counts calls, not volume |
| `beatTokenBudget` / `beatCostCeilingCents` | 50k / 50¢ | **dead config — enforced nowhere** | `heartbeat.json` says "Beat must stop if exceeded"; nothing checks it |
| `HARD_CAP_MS` 15 min vs `beatTimeoutMs` 10 min | — | **contradictory** | two different "hard caps"; `llm.ts:351` comment claims 10 min |

---

## 2. P0 — do before the demo (hours, surgical)

### F1. Route the memory pipeline to gpt-5-nano
*Highest leverage per line changed. Cuts `_system` spam AND TPM contention in one move.*

- Add `memoryDeployment` to `apps/api/src/config/runtime.ts:12-18` (env `ARCEUS_AZURE_OPENAI_MEMORY_DEPLOYMENT`, **fallback to workerDeployment** when unset so PROD without the env var is unchanged).
- Widen the `deploymentKey` union in `runtime.ts:24` and `apps/api/src/infra/azure-openai.ts:164,248,372`.
- Swap `"workerDeployment"` → `"memoryDeployment"` at the 4 call sites in `apps/api/src/memory/extractors.ts:89,134,182,201`.
- Railway: set the env var to `gpt-5-nano` (already deployed on ripple-gpt-instance-2-resource).

**Effort:** ~30 min. **Risk:** low — nano with `json_schema` structured outputs on api-version 2025-04-01-preview; memory extraction quality matters far less than beat survival.

### F2. Read clamp + dedupe + per-beat volume budget at the plugin chokepoint
*Attacks the root cause. `tool.execute.before` in `.opencode/plugin/arceus.ts:322` already intercepts and rewrites `read` args per session — extend it.*

Per-session (= per-beat) state in the plugin:

1. **Clamp:** if `read` has no `limit` or `limit > 400`, set `limit = 400`. (SWE-agent's evidence: a ~100-line window *outperformed* whole-file reads on SWE-bench — [ACI docs](https://swe-agent.com/0.7/background/aci/); Codex truncates at 256 lines. 400 is conservative.)
2. **Dedupe:** track `(filePath, offset, limit)` per session; on exact repeat, throw `"[arceus-read-guard] Already read <path> (lines X–Y) this beat — the content is in your context. Act on it; use grep for lookups."` Throwing in `before` is the established pattern (tenant-guard does it) and the message becomes the model's observation.
3. **Cumulative budget:** sum granted lines; past ~8,000 lines, deny further `read`s with `"Read budget exhausted for this beat. You have enough context — make your edit / complete the task. Use grep -n for targeted lookups."` Grep stays allowed (cheap, targeted).

**Effort:** ~1–2 h + a dry run watching one developer beat. **Risk:** medium-low — the deny strings steer the model; READ_LOOP history says count-based guards false-fire, but this bounds *volume*, not count, and grep remains an escape hatch. Tune 400/8,000 from inspector data.

### F3. Reasoning-stall watchdog: `lastToolAt`
*Converts the 15-min discard into a 3-min fail. The missing primitive — nothing today measures time since the LAST tool call.*

- Add `lastToolAt: number` to `PendingPromptCompletion` (`apps/api/src/orchestration/company-runtime.ts:78-125`), default `startedAt`.
- Bump it where `toolCallCount` is already bumped: MCP middleware + watchdog-reset route (`apps/api/src/routes/internal-mcp/beats.routes.ts:171-173`).
- New poller guard in `pollPendingPromptCompletions` (`llm.ts:293`): `toolCallCount > 0 && now - lastToolAt > 3min` → reject with cause `reasoning_stall`. Unlike the disabled NO_PRODUCTIVE_ACTION guard this can't false-fire on a slow tool — `lastToolAt` is bumped on *completion* of every tool, productive or not; only "zero tool calls for 3 straight minutes while streaming prose" dies.
- While in there: align the caps. `HARD_CAP_MS` 15 min (`run-beat.ts:39`) vs `beatTimeoutMs` 10 min (`heartbeat.json`) — pick 10 min for both; fix the stale `llm.ts:351` comment.

**Effort:** ~45 min. **Risk:** low. Watch for legit >3-min single Azure round-trips (the iteration log in `llm.ts:105-122` saw >4-min round-trips once on the *old* resource) — if observed, bump to 4 min rather than reverting.

### F4. Set `reasoning_effort` + output cap on the worker model (config-only)
*Neither `opencode.json` nor `workspace/opencode.json` has a `provider` block — gpt-5.2 runs at default (high-ish) reasoning effort with no output ceiling.*

```jsonc
// workspace/opencode.json
"provider": {
  "azure": {
    "models": {
      "gpt-5.2": {
        "options": { "reasoningEffort": "low", "textVerbosity": "low" }
      }
    }
  }
}
```

- OpenAI's GPT-5 guide: lowering `reasoning_effort` specifically reduces tangential tool-calling and latency ([GPT-5 prompting guide](https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide)). Start at `low` for the worker; `medium` if quality drops. (Don't use `minimal` — parallel tool calls unsupported there per [Azure docs](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning).)
- Verify the option actually lands: one beat, then check the Azure request in the inspector ring. OpenCode versions differ in option pass-through — if it doesn't land, the fallback is `max_completion_tokens` via the same options block.
- Prompt hygiene in `developer.ts` soul (one-line edits, per [o-series function-calling guide](https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide)): remove any "plan thoroughly before acting" phrasing; add *"Do NOT promise to call a tool later — if a call is needed, emit it now"* and ask for a one-sentence preamble before each tool call (preambles keep the SSE stream visibly alive AND give the watchdog signal).

**Effort:** ~30 min + one verification beat. **Risk:** low, instantly revertible.

---

## 3. P1 — structural (days, after the demo is safe)

### F5. Verify reasoning persistence across tool calls (likely the real cause of the reasoning balloon)
gpt-5.x is trained with reasoning items *persisted* between tool calls within a turn. If OpenCode's Azure path uses Chat Completions (or Responses without `previous_response_id` / `reasoning.encrypted_content`), the model **re-reasons from scratch after every tool result** — precisely the "10 minutes of reasoning after a tool result" signature. OpenAI measured +4.3pp on Tau-bench from `previous_response_id` alone ([o-series guide](https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide)). **Action:** inspect the opencode binary / `@ai-sdk/azure` version for which API it hits and whether reasoning content round-trips; if not, upgrading OpenCode or switching the provider mode may fix the balloon outright. Investigate before building anything heavier.

### F6. Harvest, don't discard, on reap (paperclip + SWE-agent pattern)
- **T-minus nudge:** at hard-cap − 2 min, inject a user-role message into the session: *"2 minutes left in this beat. Stop exploring. Checkpoint now: commit work, `task_block` or `task_complete` with a handoff note."* (SWE-agent's budget-death "autosubmit" — harvest the current state as the answer, [model config](https://swe-agent.com/latest/reference/model_config/).)
- **On kill:** before `destroyBeatSession`, harvest `git diff --stat` of the tenant workspace + last assistant text → store on the beat record / next beat's context. Workspace file edits already survive (real files); what's lost today is the *narrative*, so the next beat re-explores.
- **Retry cap + escalation (paperclip's stranded-recovery discipline):** add a per-task beat-failure counter; `releaseClaimsForBeat` (`run-beat.ts:336`) currently resets to `planned` with no memory → the same task kills beats forever. After 3 failures mark the task `blocked` with a visible reason. Paperclip caps at 40 then blocks with a board comment (`plans/paperclip/02-…md` Part F); 3 is right for demo safety.

### F7. Session resume per (agent, task) — paperclip Part E
Paperclip keys sessions on `(companyId, agentId, adapterType, taskKey)` and resumes them, so an agent continuing a task *already has its context* — no re-reads. Arceus creates + destroys a session every beat. Reusing the OpenCode session while the same task is claimed (destroy on task completion/block instead of beat end) directly removes the cold-start that causes the 28–38 reads. **Biggest single design fix; touches session lifecycle, watchdogs, and the stranded-run sweeper — spec it before building.**

### F8. Threshold-gate `llmHabitMatcher`
With 4 habits, an LLM call per `prepareAgentContext` is pure waste. Gate: `habits.length > 15 ? llmHabitMatcher : naive findMatching` (fallback already exists in hippocampus). After F1 this traffic is nano anyway, but the latency on every beat-context build still goes away. **Effort:** ~15 min.

---

## 4. P2 — hardening (post-demo)

- **F9. Enforce `beatTokenBudget`:** the per-beat accumulator exists (`azure-openai.ts:43-52`); add a poller check → reject with cause `token_budget`. Also add a reasoning-token-per-step budget once token usage from OpenCode SSE is wired in (10–20k reasoning tokens with no tool call → abort; this is the API-level version of F3).
- **F10. Fix token attribution:** `distributeTokens` (`azure-openai.ts:100-102`) adds *every* API-side LLM call's usage to **all** active beat accumulators — memory-pipeline tokens pollute beat token counts (and would corrupt F9). Attribute by companyId/beatId, or at minimum exclude `_system` calls.
- **F11. Observation masking:** ["The Complexity Trap"](https://arxiv.org/abs/2508.21433) — replacing tool observations older than ~3–5 steps with `[output omitted — re-run if needed]` halves cost and **matches or beats LLM summarization** on SWE-bench. Natural fit at the session-message layer if/when F7 lands (long-lived sessions need it).
- **F12. Stuck detector:** OpenHands flags 4 identical action-observation pairs or a 6-cycle two-action ping-pong ([stuck.py](https://github.com/OpenHands/OpenHands/blob/main/openhands/controller/stuck.py)). The plugin's `pendingCalls`/`circuitTally` infra is most of the plumbing. Whitelist polling-shaped bash (their known false positive).

---

## 5. Rollout order & verification

| Step | Fix | Verify by |
|---|---|---|
| 1 | F1 memory→nano | inspector: `llm_call_completed` `_system` events show nano deployment; gpt-5.2 TPM headroom up |
| 2 | F4 reasoning_effort | one beat; confirm option in the Azure request; beat duration + reasoning-turn length drop |
| 3 | F3 lastToolAt guard | a stalled beat dies at ~3 min with cause `reasoning_stall`, not 15 min `beat_hard_cap` |
| 4 | F2 read guard | developer beat: distinct-file reads land, dupes denied, cumulative lines ≤ budget; beat passes |
| 5 | F8 habit gate | no `habit_matching` LLM calls while habits ≤ 15 |
| 6+ | F5 → F6 → F7 | spec'd individually |

Success metric for the demo: **developer beat pass-rate** (currently ~0 on gpt-5.2) and **p95 beat duration < 5 min**. Both readable from `heartbeat_runs` on Railway Postgres.

---

*Sources beyond this repo: [Codex output caps](https://github.com/openai/codex/issues/7906) · [SWE-agent ACI](https://swe-agent.com/0.7/background/aci/) · [Aider repo-map](https://aider.chat/docs/repomap.html) · [GPT-5 prompting guide](https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide) · [o3/o4 function-calling guide](https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide) · [Azure reasoning models](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning) · [Complexity Trap (obs. masking)](https://arxiv.org/abs/2508.21433) · [OpenHands StuckDetector](https://github.com/OpenHands/OpenHands/blob/main/openhands/controller/stuck.py) · [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) · [opencode gpt-5.x idle-after-tool-call bugs: #17516 / #24899](https://github.com/anomalyco/opencode/issues/17516) · `plans/paperclip/02-heartbeat-and-agent-runtime.md`*
