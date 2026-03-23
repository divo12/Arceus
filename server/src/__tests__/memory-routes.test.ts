import type { RequestHandler, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE = process.env.PAPERCLIP_HIPPOCAMPUS_MODE;

type MockResponse = {
  body: unknown;
  status(code: number): MockResponse;
  statusCode: number;
  json(payload: unknown): MockResponse;
};

function getRouteHandler(router: Router, method: "get" | "post", path: string): RequestHandler {
  const layer = (router as unknown as { stack: Array<{ route?: {
    methods?: Record<string, boolean>;
    path?: string;
    stack: Array<{ handle: RequestHandler }>;
  } }> }).stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method],
  );

  if (!layer?.route) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeRoute(options: {
  actor?: { type: string; userId?: string; source?: string };
  body?: Record<string, unknown>;
  hippocampusMode: "off" | "embedded" | "sidecar";
  method: "get" | "post";
  path: string;
  query?: Record<string, unknown>;
}) {
  const { memoryRoutes } = await import("../routes/memory.js");
  const router = memoryRoutes({ hippocampusMode: options.hippocampusMode });
  const handler = getRouteHandler(router, options.method, options.path);

  const req = {
    actor: options.actor ?? { type: "board", userId: "board-user", source: "local_implicit" },
    body: options.body ?? {},
    params: { agentId: "agent-1" },
    query: options.query ?? {},
  } as any;

  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  await handler(req, res as any, vi.fn());
  return res;
}

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE === undefined) delete process.env.PAPERCLIP_HIPPOCAMPUS_MODE;
  else process.env.PAPERCLIP_HIPPOCAMPUS_MODE = ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE;
});

describe("memory routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns 503 when hippocampus mode is off", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "off";

    const res = await invokeRoute({
      hippocampusMode: "off",
      method: "get",
      path: "/agents/:agentId/memory/summary",
    });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "Hippocampus is disabled" });
  });

  it("returns 502 when the bridge throws", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        getSummary: vi.fn().mockRejectedValue(new Error("bridge unavailable")),
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/summary",
    });

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "bridge unavailable" });
  });

  it("preserves bridge summary response shapes", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        getSummary: vi.fn().mockResolvedValue({
          total_static: 2,
          total_dynamic: 3,
          active_habits: [{ trigger: "deploy", action: "review", confidence: 0.8 }],
          priming_prompt: "remember the roadmap",
          graph_node_count: 5,
          top_patterns: [{ description: "launch review" }],
          recent_learnings: ["security review"],
          recent_promotions: ["dynamic→static: repeated success"],
          generated_at: "2026-03-24T00:00:00Z",
        }),
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/summary",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      total_static: 2,
      total_dynamic: 3,
      active_habits: [{ trigger: "deploy", action: "review", confidence: 0.8 }],
      priming_prompt: "remember the roadmap",
      graph_node_count: 5,
      top_patterns: [{ description: "launch review" }],
      recent_learnings: ["security review"],
      recent_promotions: ["dynamic→static: repeated success"],
      generated_at: "2026-03-24T00:00:00Z",
    });
  });

  it("returns 502 when the bridge is unavailable in enabled mode", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        getSummary: vi.fn().mockRejectedValue(new Error("Hippocampus is disabled")),
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/summary",
    });

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "Hippocampus is disabled" });
  });

  it("preserves list response shapes", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        listMemories: vi.fn().mockResolvedValue({
          items: [
            {
              id: "mem-1",
              content: "remember launch review",
              memory_type: "dynamic",
              confidence: 0.9,
              relevance_score: 0.7,
              container: "default",
              visibility: "shared",
              created_at: "2026-03-24T00:00:00Z",
              updated_at: "2026-03-24T00:00:00Z",
              access_count: 2,
            },
          ],
          total: 1,
        }),
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/list",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: "mem-1",
          content: "remember launch review",
          memory_type: "dynamic",
          confidence: 0.9,
          relevance_score: 0.7,
          container: "default",
          visibility: "shared",
          created_at: "2026-03-24T00:00:00Z",
          updated_at: "2026-03-24T00:00:00Z",
          access_count: 2,
        },
      ],
      total: 1,
    });
  });

  it("preserves recall response shapes", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        recall: vi.fn().mockResolvedValue({
          items: [
            {
              id: "mem-1",
              content: "security review required",
              memory_type: "dynamic",
              confidence: 0.85,
              relevance_score: 0.91,
              kind: "vector",
            },
          ],
        }),
      }),
    }));

    const res = await invokeRoute({
      body: { query: "security review" },
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/recall",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: "mem-1",
          content: "security review required",
          memory_type: "dynamic",
          confidence: 0.85,
          relevance_score: 0.91,
          kind: "vector",
        },
      ],
    });
  });

  it("does not misclassify board auth failures as bridge failures", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";

    await expect(
      invokeRoute({
        actor: { type: "agent" },
        hippocampusMode: "embedded",
        method: "get",
        path: "/agents/:agentId/memory/summary",
      }),
    ).rejects.toMatchObject({
      message: "Board access required",
      status: 403,
    });
  });

  it("returns bridge-backed health when enabled", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        health: vi.fn().mockResolvedValue({ status: "ok", mode: "embedded" }),
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/memory/health",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "ok", mode: "embedded" });
  });
});
