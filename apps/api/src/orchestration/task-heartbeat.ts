/**
 * Per-task heartbeat checklist (pure core).
 *
 * A living Done/Doing/Next/Blocked the agent rewrites at beat end and reads on
 * claim, so a multi-beat or blocked task resumes instead of restarting from
 * scratch. Replaces the append-only planSteps trail. `done` accumulates (a
 * capped, deduped log of what's finished); `doing`/`next`/`blocked` are the
 * current snapshot and are replaced on each update.
 *
 * Pure (no DB/LLM) so the merge + render rules are deterministic and testable.
 */

import type { HeartbeatChecklist } from "@arceus/contracts";
import { defaultHeartbeat } from "@arceus/contracts";

export type { HeartbeatChecklist };

/** Partial update an agent submits at beat end — omitted fields are preserved. */
export interface HeartbeatUpdate {
  done?: string[];
  doing?: string | null;
  next?: string[];
  blocked?: string | null;
}

const DONE_LIMIT = 10;
const NEXT_LIMIT = 8;

/** Canonical empty checklist (re-exported from contracts so there's one source). */
export const emptyHeartbeat = defaultHeartbeat;

function cleanList(items: readonly string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

function cleanScalar(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Dedupe preserving order (exact match after trim). */
function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Apply an agent's beat-end update. `done` accumulates onto the prior log
 * (deduped, newest kept, capped); `doing`/`next`/`blocked` replace the prior
 * snapshot when provided and are preserved when omitted.
 */
export function applyHeartbeatUpdate(
  prev: HeartbeatChecklist,
  update: HeartbeatUpdate,
  now: string,
): HeartbeatChecklist {
  const done = update.done !== undefined
    ? dedupe([...prev.done, ...cleanList(update.done)]).slice(-DONE_LIMIT)
    : prev.done;

  const doing = update.doing !== undefined ? cleanScalar(update.doing) : prev.doing;
  const next = update.next !== undefined ? cleanList(update.next).slice(0, NEXT_LIMIT) : prev.next;
  const blocked = update.blocked !== undefined ? cleanScalar(update.blocked) : prev.blocked;

  return { done, doing, next, blocked, updatedAt: now };
}

/** Inputs the lifecycle needs to phrase a transition's heartbeat update. */
export interface HeartbeatTransitionContext {
  title: string;
  objective?: string;
  feedback?: string | null;
}

/**
 * Auto-maintain the heartbeat from a task status transition, so the checklist
 * reflects reality without the agent calling task_set_heartbeat:
 *  - in_progress (claim/resume): set `doing` if empty; clear any stale blocker.
 *  - blocked: record the blocker reason (the key continuity case).
 *  - completed / verifying: append a ✓ done line; clear doing + blocked.
 *  - failed: append a ✗ done line (with reason); clear doing.
 * Other statuses (created/planned/cancelled) leave the heartbeat untouched.
 */
export function heartbeatForTransition(
  hb: HeartbeatChecklist,
  status: string,
  ctx: HeartbeatTransitionContext,
  now: string,
): HeartbeatChecklist {
  switch (status) {
    case "in_progress":
      return applyHeartbeatUpdate(hb, { doing: hb.doing ?? (ctx.objective || ctx.title), blocked: null }, now);
    case "blocked":
      return applyHeartbeatUpdate(hb, { blocked: ctx.feedback || "Blocked (no reason given)" }, now);
    case "verifying":
    case "completed":
      return applyHeartbeatUpdate(hb, { done: [`✓ ${ctx.title}`], doing: null, blocked: null }, now);
    case "failed":
      return applyHeartbeatUpdate(hb, { done: [`✗ ${ctx.title}${ctx.feedback ? `: ${ctx.feedback}` : ""}`], doing: null }, now);
    default:
      return hb;
  }
}

/** True when the checklist carries no content worth rendering. */
export function isHeartbeatEmpty(hb: HeartbeatChecklist): boolean {
  return hb.done.length === 0 && hb.next.length === 0 && !hb.doing && !hb.blocked;
}

/**
 * Render the checklist as compact markdown. Returns "" when blank so callers can
 * omit the section entirely. Only non-empty sections are emitted.
 */
export function renderHeartbeat(hb: HeartbeatChecklist): string {
  if (isHeartbeatEmpty(hb)) return "";
  const lines: string[] = [];
  if (hb.done.length > 0) {
    lines.push(`✅ Done: ${hb.done.join("; ")}`);
  }
  if (hb.doing) {
    lines.push(`🔨 Doing: ${hb.doing}`);
  }
  if (hb.next.length > 0) {
    lines.push(`⏭️ Next: ${hb.next.join("; ")}`);
  }
  if (hb.blocked) {
    lines.push(`🚫 Blocked: ${hb.blocked}`);
  }
  return lines.join("\n");
}
