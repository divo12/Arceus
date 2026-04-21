import { createHash } from "node:crypto";

type Retry = "safe" | "unsafe" | "never";

/**
 * Derive a stable idempotency key from the logical operation. Same inputs
 * produce the same key, so retries within a beat deduplicate server-side.
 */
export const deriveIdempotencyKey = (beatId: string, op: string, body: unknown): string => {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex")
    .slice(0, 16);
  return `${beatId}:${op}:${bodyHash}`;
};

interface ToolError {
  cause: string;
  retry: Retry;
  stopWhen: string;
  details?: unknown;
}

export interface ToolResult<T = unknown> {
  status: "success" | "error";
  summary: string;
  data?: T;
  error?: ToolError;
  nextActions?: string[];
  artifacts?: Array<{ id: string; kind: string; uri?: string }>;
}

export const success = <T>(summary: string, data?: T, nextActions?: string[]): ToolResult<T> => ({
  status: "success",
  summary,
  ...(data !== undefined ? { data } : {}),
  ...(nextActions ? { nextActions } : {}),
});

export const failure = <T = unknown>(
  summary: string,
  cause: string,
  retry: Retry,
  stopWhen: string,
  details?: unknown,
): ToolResult<T> => ({
  status: "error",
  summary,
  error: { cause, retry, stopWhen, ...(details !== undefined ? { details } : {}) },
});

export const stringify = <T>(result: ToolResult<T>): string => JSON.stringify(result);

export interface ArceusContext {
  arceusApiBase: string;
  arceusToken: string;
  beatId: string;
  companyId: string;
  role: string;
  taskId: string;
}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

export const loadContext = (): ArceusContext => ({
  arceusApiBase: requireEnv("ARCEUS_API"),
  arceusToken: requireEnv("ARCEUS_TOKEN"),
  beatId: requireEnv("BEAT_ID"),
  companyId: requireEnv("COMPANY_ID"),
  role: requireEnv("ROLE"),
  taskId: requireEnv("TASK_ID"),
});

export interface ArceusRequestInit {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /**
   * Stable key identifying the logical operation. When present, the server
   * uses it for idempotent replay — same key + same body returns the cached
   * response. Callers MUST derive it deterministically from the operation
   * (e.g. `${beatId}:task_claim:${taskId}`); never use a fresh UUID per
   * request or retries will not deduplicate.
   */
  idempotencyKey?: string;
}

export const arceusRequest = async <T>(
  ctx: ArceusContext,
  init: ArceusRequestInit,
): Promise<{ status: number; data: T }> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${ctx.arceusToken}`,
    "x-beat-id": ctx.beatId,
    "x-company-id": ctx.companyId,
    "x-role": ctx.role,
  };
  if (init.idempotencyKey && init.idempotencyKey.length > 0) {
    headers["idempotency-key"] = init.idempotencyKey;
  }

  const response = await fetch(`${ctx.arceusApiBase}${init.path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const text = await response.text();
  const data = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  return { status: response.status, data };
};

export const run = async <T>(fn: () => Promise<ToolResult<T>>): Promise<string> => {
  try {
    return stringify(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return stringify(failure("Tool execution failed.", "upstream", "safe", "api_reachable", message));
  }
};
