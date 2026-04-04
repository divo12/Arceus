import { describe, expect, it, vi } from "vitest";
import { apiCorsMiddleware } from "../middleware/api-cors.js";

function createMockRes() {
  const headers = new Map<string, string>();
  return {
    headers,
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

function createMockReq(
  method: string,
  headers: Record<string, string | undefined> = {},
) {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method,
    header(name: string) {
      return normalized.get(name.toLowerCase());
    },
  };
}

describe("apiCorsMiddleware", () => {
  it("adds credentialed CORS headers for allowed origins", () => {
    const middleware = apiCorsMiddleware(["https://frontend.example.com"]);
    const req = createMockReq("GET", {
      origin: "https://frontend.example.com",
    }) as any;
    const res = createMockRes() as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.getHeader("access-control-allow-origin")).toBe("https://frontend.example.com");
    expect(res.getHeader("access-control-allow-credentials")).toBe("true");
    expect(res.getHeader("vary")).toContain("Origin");
  });

  it("does not emit CORS headers for disallowed origins", () => {
    const middleware = apiCorsMiddleware(["https://frontend.example.com"]);
    const req = createMockReq("GET", {
      origin: "https://preview.example.pages.dev",
    }) as any;
    const res = createMockRes() as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
    expect(res.getHeader("access-control-allow-credentials")).toBeUndefined();
  });

  it("answers allowed preflight requests", () => {
    const middleware = apiCorsMiddleware(["https://frontend.example.com"]);
    const req = createMockReq("OPTIONS", {
      origin: "https://frontend.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    }) as any;
    const res = createMockRes() as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
    expect(res.getHeader("access-control-allow-origin")).toBe("https://frontend.example.com");
    expect(res.getHeader("access-control-allow-credentials")).toBe("true");
    expect(res.getHeader("access-control-allow-methods")).toContain("POST");
    expect(res.getHeader("access-control-allow-headers")).toBe("content-type");
  });

  it("rejects preflight requests from untrusted origins", () => {
    const middleware = apiCorsMiddleware(["https://frontend.example.com"]);
    const req = createMockReq("OPTIONS", {
      origin: "https://preview.example.pages.dev",
      "access-control-request-method": "POST",
    }) as any;
    const res = createMockRes() as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "CORS origin not allowed" });
  });
});
