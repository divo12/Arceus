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
  "internal"
] as const;

export type ErrorCause = (typeof ERROR_CAUSES)[number];

export const causeToStatus: Record<ErrorCause, number> = {
  validation: 422,
  governance: 403,
  not_found: 404,
  conflict: 409,
  upstream: 503,
  internal: 500
};
