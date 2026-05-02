/**
 * Spec 35 §3 — chat mode → tool allowlist gate.
 *
 * Modes constrain *what kind of work* a chat turn can do, enforced
 * server-side at the OpenCode `tools` filter level so the model can't
 * pick a forbidden tool no matter how persuasive the user message.
 *
 *   ask       — read-only Q&A; only `chat_emit_card(decision)` for follow-ups
 *   instruct  — full agent toolkit (everything CEO already has)
 *   store     — memory-write only; nothing else
 *
 * The CEO's static allowlist (from `.opencode/agent/config.ts`) is the
 * upper bound; mode rules narrow it. We *never* widen.
 */

export type ChatMode = "ask" | "instruct" | "store";

/** Tools allowed in Ask mode — strict read + decision cards only. */
const ASK_TOOLS = new Set<string>([
  // Reads
  "task_get",
  "task_list_progress",
  "sprint_get_active",
  "sprint_check_completion",
  "memory_search",
  "meeting_get",
  "agents_list_sessions",
  "company_get_summary",
  "execution_get_status",
  "approval_get",
  "approval_list",
  "board_get_messages",
  "skill_health_report",
  "skill_audit_unused",
  "skill_inspect_history",
  // Meta (always safe)
  "tool_help",
  "arceus_tool_search",
  // Decision cards only — no side-effect emissions
  "chat_emit_card",
]);

/** Tools forbidden in Instruct mode — memory writes are Store-only. */
const INSTRUCT_DENY = new Set<string>([
  "memory_add_learning",
  "memory_handoff",
]);

/** Tools allowed in Store mode — memory recall + memory_capture cards only. */
const STORE_TOOLS = new Set<string>([
  "memory_search",
  "chat_emit_card", // CEO drafts the memory_capture card; user confirms tier/scope
  "tool_help",
  "arceus_tool_search",
]);

/**
 * Narrow `baseAllowed` (CEO's static allowlist) by mode. Returns the
 * subset of tool names actually permitted for this turn.
 */
export function chatModeAllowedTools(mode: ChatMode, baseAllowed: readonly string[]): string[] {
  switch (mode) {
    case "ask":
      return baseAllowed.filter((t) => ASK_TOOLS.has(t));
    case "instruct":
      return baseAllowed.filter((t) => !INSTRUCT_DENY.has(t));
    case "store":
      return baseAllowed.filter((t) => STORE_TOOLS.has(t));
  }
}

/**
 * Build the OpenCode `tools` filter for a chat turn. Mirrors
 * `apps/api/src/orchestration/run-beat.ts` — deny `arceus_*` by
 * default, then re-enable only the mode-permitted ones.
 */
export function chatModeToolFilter(
  mode: ChatMode,
  baseAllowed: readonly string[],
): Record<string, boolean> {
  const filter: Record<string, boolean> = { "arceus_*": false };
  for (const name of chatModeAllowedTools(mode, baseAllowed)) {
    filter[`arceus_${name}`] = true;
  }
  return filter;
}
