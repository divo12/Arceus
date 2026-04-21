import type { McpContext } from "./context.js";
import { resolveSessionContext } from "./context-resolver.js";

export interface ArceusRequestInit {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** When provided, resolves beat context from session-context API if env is empty. */
  sessionId?: string;
}

export interface ArceusResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export class ArceusHttpClient {
  constructor(private readonly ctx: McpContext) {}

  async request<T>(init: ArceusRequestInit): Promise<ArceusResponse<T>> {
    // Resolve per-beat context: prefer env-based ctx, fall back to session-context API
    let beatId = this.ctx.beatId;
    let companyId = this.ctx.companyId;
    let role = this.ctx.role;

    if ((!beatId || !companyId || !role) && init.sessionId) {
      const resolved = await resolveSessionContext(init.sessionId);
      if (resolved) {
        beatId = resolved.beatId;
        companyId = resolved.companyId;
        role = resolved.role;
      }
    }

    const url = `${this.ctx.arceusApiBase}${init.path}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.ctx.arceusToken}`,
    };
    if (beatId) headers["x-beat-id"] = beatId;
    if (companyId) headers["x-company-id"] = companyId;
    if (role) headers["x-role"] = role;
    if (init.idempotencyKey) {
      headers["idempotency-key"] = init.idempotencyKey;
    }

    const response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const text = await response.text();
    const data = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);

    return { status: response.status, data, headers: responseHeaders };
  }
}
