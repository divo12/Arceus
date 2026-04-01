import type {
  ExtractResult,
  HabitItem,
  MemoryItem,
  MemoryListItem,
  MemorySummary,
} from "./hippocampus-contract.js";

export const HIPPOCAMPUS_JSONRPC_VERSION = "2.0" as const;

export const HIPPOCAMPUS_JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const HIPPOCAMPUS_RPC_ERROR_CODES = {
  RUNTIME_UNAVAILABLE: -32000,
  TIMEOUT: -32003,
  UNKNOWN: -32099,
} as const;

export type HippocampusJsonRpcId = string | number;

export interface TrajectoryStepInput {
  action: string;
  result: string;
  reasoning?: string;
}

export interface HippocampusRpcMethodMap {
  health: {
    params: Record<string, never>;
    result: { status: string; agents_loaded: number; debug: boolean };
  };
  remember: {
    params: { agent_id: string; content: string; container: string; memory_type: string };
    result: { id: string; content: string; memory_type: string; confidence: number };
  };
  recall: {
    params: {
      agent_id: string;
      query: string;
      container: string;
      top_k: number;
    };
    result: { items: MemoryItem[] };
  };
  extract: {
    params: {
      agent_id: string;
      messages: Array<{ role: string; content: string }>;
      container: string;
      mode: string;
    };
    result: ExtractResult;
  };
  processTrajectory: {
    params: {
      agent_id: string;
      task_id: string;
      outcome: string;
      quality: number;
      steps: TrajectoryStepInput[];
      container: string;
    };
    result: {
      verdict: Record<string, unknown> | null;
      distilled: Record<string, unknown> | null;
      pattern: Record<string, unknown> | null;
      habit: Record<string, unknown> | null;
    };
  };
  getPriming: {
    params: { agent_id: string };
    result: { prompt: string };
  };
  getHabits: {
    params: { agent_id: string; context: string };
    result: { habits: HabitItem[] };
  };
  getSummary: {
    params: { agent_id: string };
    result: MemorySummary;
  };
  listMemories: {
    params: {
      agent_id: string;
      memory_type?: string;
      container?: string;
      limit: number;
    };
    result: { items: MemoryListItem[]; total: number };
  };
  runGC: {
    params: { agent_id: string };
    result: { expired: number; decayed: number; demoted: number };
  };
  runPromotions: {
    params: { agent_id: string };
    result: {
      promotions: Array<{ memory_id: string; from_tier: string; to_tier: string; reason: string }>;
    };
  };
  shutdown: {
    params: Record<string, never>;
    result: { status: string };
  };
}

export type HippocampusRpcMethodName = keyof HippocampusRpcMethodMap;

export interface HippocampusJsonRpcRequest<
  TMethod extends HippocampusRpcMethodName = HippocampusRpcMethodName,
> {
  jsonrpc: typeof HIPPOCAMPUS_JSONRPC_VERSION;
  id: HippocampusJsonRpcId;
  method: TMethod;
  params: HippocampusRpcMethodMap[TMethod]["params"];
}

export interface HippocampusJsonRpcError<TData = unknown> {
  code: number;
  message: string;
  data?: TData;
}

export interface HippocampusJsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: typeof HIPPOCAMPUS_JSONRPC_VERSION;
  id: HippocampusJsonRpcId;
  result: TResult;
  error?: never;
}

export interface HippocampusJsonRpcErrorResponse<TData = unknown> {
  jsonrpc: typeof HIPPOCAMPUS_JSONRPC_VERSION;
  id: HippocampusJsonRpcId | null;
  error: HippocampusJsonRpcError<TData>;
  result?: never;
}

export type HippocampusJsonRpcResponse<TResult = unknown, TData = unknown> =
  | HippocampusJsonRpcSuccessResponse<TResult>
  | HippocampusJsonRpcErrorResponse<TData>;

export class HippocampusRpcCallError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "HippocampusRpcCallError";
    this.code = code;
    this.data = data;
  }
}

export function createHippocampusRpcRequest<TMethod extends HippocampusRpcMethodName>(
  id: HippocampusJsonRpcId,
  method: TMethod,
  params: HippocampusRpcMethodMap[TMethod]["params"],
): HippocampusJsonRpcRequest<TMethod> {
  return {
    jsonrpc: HIPPOCAMPUS_JSONRPC_VERSION,
    id,
    method,
    params,
  };
}

export function serializeHippocampusRpcMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseHippocampusRpcMessage(message: string): unknown {
  return JSON.parse(message);
}

export function isHippocampusRpcResponse(
  value: unknown,
): value is HippocampusJsonRpcResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === HIPPOCAMPUS_JSONRPC_VERSION && "id" in candidate && (
    "result" in candidate || "error" in candidate
  );
}

export function isHippocampusRpcSuccessResponse<TResult = unknown>(
  value: HippocampusJsonRpcResponse<TResult>,
): value is HippocampusJsonRpcSuccessResponse<TResult> {
  return "result" in value;
}
