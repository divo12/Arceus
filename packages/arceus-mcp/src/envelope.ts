import { createHash } from "node:crypto";
import type { ToolResult } from "@arceus/contracts";

/**
 * Derive a stable idempotency key from (beatId, op, body).
 * Same inputs → same key, so retries collapse server-side.
 * Spec 25 §3.4.
 */
export function deriveIdempotencyKey(beatId: string, op: string, body: unknown): string {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex")
    .slice(0, 16);
  return `${beatId || "shared"}:${op}:${bodyHash}`;
}

export interface McpToolContent {
  [key: string]: unknown;
  content: { [key: string]: unknown; type: "text"; text: string }[];
  isError?: boolean;
}

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
