import type { ToolResult } from "@arceus/contracts";

export type McpToolContent = {
  [key: string]: unknown;
  content: Array<{ [key: string]: unknown; type: "text"; text: string }>;
  isError?: boolean;
};

export const toMcpContent = <T>(result: ToolResult<T>): McpToolContent => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  isError: result.status === "error"
});

export const success = <T>(
  summary: string,
  data?: T,
  extras?: Pick<ToolResult<T>, "nextActions" | "artifacts">
): ToolResult<T> => ({
  status: "success",
  summary,
  ...(data !== undefined ? { data } : {}),
  ...(extras?.nextActions ? { nextActions: extras.nextActions } : {}),
  ...(extras?.artifacts ? { artifacts: extras.artifacts } : {})
});

export const failure = <T = unknown>(
  summary: string,
  cause: string,
  retry: "safe" | "unsafe" | "never",
  stopWhen: string
): ToolResult<T> => ({
  status: "error",
  summary,
  error: { cause, retry, stopWhen }
});
