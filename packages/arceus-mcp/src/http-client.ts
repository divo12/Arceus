import type { McpContext } from "./context.js";
import { resolveSessionContext } from "./context-resolver.js";
import { sessionAls } from "./session-als.js";

interface ArceusRequestInit {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** When provided, resolves beat context from session-context API if env is empty.
   *  When omitted, the AsyncLocalStorage store populated by the registerTool
   *  wrapper supplies the per-call OpenCode sessionID injected by the plugin. */
  sessionId?: string;
}

interface ArceusResponse<T> {
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

    const sessionId = init.sessionId ?? sessionAls.getStore()?.sessionId;
    if ((!beatId || !companyId || !role) && sessionId) {
      const resolved = await resolveSessionContext(sessionId);
      if (resolved) {
        beatId = resolved.beatId;
        companyId = resolved.companyId;
        role = resolved.role;
      }
    }

    const url = `${this.ctx.arceusApiBase}${init.path}`;
    const hasBody = init.body !== undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.ctx.arceusToken}`,
    };
    if (hasBody) headers["content-type"] = "application/json";
    // Header strategy:
    //   - When we have a sessionId, send ONLY x-session-id. The
    //     middleware's tier-1 lookup (getSessionContext) returns the
    //     authoritative beat context; sending stale x-beat-id /
    //     x-company-id / x-role from our resolveSessionContext cache
    //     creates an identity-mismatch failure surface (the cache
    //     keys by sessionId but a single OpenCode session — e.g. the
    //     persistent CEO chat session — gets re-registered with a
    //     fresh beatId every turn, so cached values go stale while
    //     the server's session-context map updates).
    //   - When we don't have a sessionId (env-based heartbeat path),
    //     fall back to sending the legacy headers as before.
    if (sessionId) {
      headers["x-session-id"] = sessionId;
    } else {
      if (beatId) headers["x-beat-id"] = beatId;
      if (companyId) headers["x-company-id"] = companyId;
      if (role) headers["x-role"] = role;
    }
    if (init.idempotencyKey) {
      headers["idempotency-key"] = init.idempotencyKey;
    }

    const response = await fetch(url, {
      method: init.method,
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined
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
