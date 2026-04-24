import type { ToolResult } from "@arceus/contracts";

const MAX_SUMMARY_CHARS = 500;

const clampSummary = (summary: string): string =>
  summary.length <= MAX_SUMMARY_CHARS ? summary : `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;

export const success = <T>(
  summary: string,
  data?: T,
  extras?: Pick<ToolResult<T>, "nextActions" | "artifacts">
): ToolResult<T> => ({
  status: "success",
  summary: clampSummary(summary),
  ...(data !== undefined ? { data } : {}),
  ...(extras?.nextActions ? { nextActions: extras.nextActions } : {}),
  ...(extras?.artifacts ? { artifacts: extras.artifacts } : {})
});

export const failure = <T = unknown>(
  summary: string,
  cause: ErrorCause,
  retry: "safe" | "unsafe" | "never",
  stopWhen: string,
  extras?: Pick<ToolResult<T>, "nextActions">
): ToolResult<T> => ({
  status: "error",
  summary: clampSummary(summary),
  error: { cause, retry, stopWhen },
  ...(extras?.nextActions ? { nextActions: extras.nextActions } : {})
});

export const ERROR_CAUSES = [
  "validation",
  "governance",
  "not_found",
  "conflict",
  "upstream",
  "internal",
  "session_required",
  "session_not_found",
  "identity_mismatch",
  // Spec 26 — task/sprint/approval/meeting state causes
  "deps_unmet",
  "task_not_claimable",
  "task_not_claimed",
  "approval_not_pending",
  "sprint_not_executing",
  "meeting_not_open",
  "persistence_failed",
  // Spec 27 — workspace/execution causes
  "preview_unavailable",
  "baseline_failed",
  "execution_locked",
  "invalid_next_action",
  "tool_retired",
  // Approval type-gating
  "type_not_allowed",
  // Spec 27 §6 — Memory tools
  "query_too_short",
  "embed_failed",
  "store_unavailable",
  "self_target_not_allowed",
  "target_role_unknown",
  "handoff_too_large",
] as const;

export type ErrorCause = (typeof ERROR_CAUSES)[number];

export const causeToStatus: Record<ErrorCause, number> = {
  validation: 422,
  governance: 403,
  not_found: 404,
  conflict: 409,
  upstream: 503,
  internal: 500,
  session_required: 401,
  session_not_found: 404,
  identity_mismatch: 403,
  deps_unmet: 409,
  task_not_claimable: 409,
  task_not_claimed: 409,
  approval_not_pending: 409,
  sprint_not_executing: 409,
  meeting_not_open: 409,
  persistence_failed: 500,
  preview_unavailable: 503,
  baseline_failed: 200,
  execution_locked: 409,
  invalid_next_action: 400,
  tool_retired: 410,
  type_not_allowed: 403,
  // Memory causes
  query_too_short: 422,
  embed_failed: 503,
  store_unavailable: 503,
  self_target_not_allowed: 422,
  target_role_unknown: 422,
  handoff_too_large: 413,
};
