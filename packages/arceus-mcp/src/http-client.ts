import type { McpContext } from "./context.js";

export interface ArceusRequestInit {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

export interface ArceusResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export class ArceusHttpClient {
  constructor(private readonly ctx: McpContext) {}

  async request<T>(init: ArceusRequestInit): Promise<ArceusResponse<T>> {
    const url = `${this.ctx.arceusApiBase}${init.path}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.ctx.arceusToken}`,
      "x-beat-id": this.ctx.beatId,
      "x-company-id": this.ctx.companyId,
      "x-role": this.ctx.role
    };
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
