import type { RequestHandler, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE = process.env.PAPERCLIP_HIPPOCAMPUS_MODE;

type MockResponse = {
  body: unknown;
  status(code: number): MockResponse;
  statusCode: number;
  json(payload: unknown): MockResponse;
};

function findRouteLayer(router: Router, method: "get" | "post", path: string) {
  return (router as unknown as { stack: Array<{ route?: {
    methods?: Record<string, boolean>;
    path?: string;
    stack: Array<{ handle: RequestHandler }>;
  } }> }).stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method],
  );
}

function getRouteHandler(router: Router, method: "get" | "post", path: string): RequestHandler {
  const layer = findRouteLayer(router, method, path);

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
        health: vi.fn().mockResolvedValue({
          status: "ok",
          agents_loaded: 0,
          debug: false,
        }),
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/memory/health",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      agents_loaded: 0,
      debug: false,
    });
  });

  it("includes runtime diagnostics on health when the bridge exposes them", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        health: vi.fn().mockResolvedValue({
          status: "ok",
          agents_loaded: 1,
          debug: false,
        }),
        diagnostics: vi.fn().mockReturnValue({
          mode: "embedded",
          status: "running",
          pid: 4321,
          pendingRequests: 2,
          consecutiveCrashes: 1,
          totalCrashes: 3,
          lastCrashAt: 1711234567890,
          nextRestartAt: 1711234569999,
          stderrExcerpt: "recent stderr line",
        }),
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/memory/health",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      agents_loaded: 1,
      debug: false,
      diagnostics: {
        mode: "embedded",
        status: "running",
        pid: 4321,
        pendingRequests: 2,
        consecutiveCrashes: 1,
        totalCrashes: 3,
        lastCrashAt: 1711234567890,
        nextRestartAt: 1711234569999,
        stderrExcerpt: "recent stderr line",
      },
    });
  });

  it("supports Part 1 scoped recall once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const recall = vi.fn()
      .mockImplementation(async (_agentId: string, _query: string, container: string) => {
        if (container === "startup:startup-1") {
          return {
            items: [
              {
                id: "shared-1",
                content: "company launch checklist",
                memory_type: "static",
                confidence: 0.92,
                relevance_score: 0.8,
                kind: "vector",
              },
            ],
          };
        }
        if (container === "startup:startup-1:emp:emp-1") {
          return {
            items: [
              {
                id: "private-1",
                content: "my deployment ritual",
                memory_type: "dynamic",
                confidence: 0.74,
                relevance_score: 0.7,
                kind: "vector",
              },
            ],
          };
        }
        if (container === "startup:startup-1:task:task-1") {
          return {
            items: [
              {
                id: "task-1",
                content: "debug the rollout regression",
                memory_type: "working",
                confidence: 0.66,
                relevance_score: 0.89,
                kind: "vector",
              },
            ],
          };
        }
        return { items: [] };
      });

    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        recall,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/scoped-recall")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/scoped-recall",
      body: {
        query: "deployment",
        startupId: "startup-1",
        employeeId: "emp-1",
        taskId: "task-1",
        includeShared: true,
        topK: 5,
      },
    });

    expect(recall).toHaveBeenCalledWith("agent-1", "deployment", "startup:startup-1", 5);
    expect(recall).toHaveBeenCalledWith("agent-1", "deployment", "startup:startup-1:emp:emp-1", 5);
    expect(recall).toHaveBeenCalledWith("agent-1", "deployment", "startup:startup-1:task:task-1", 5);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({ id: "shared-1", content: "company launch checklist" }),
        expect.objectContaining({ id: "private-1", content: "my deployment ritual" }),
        expect.objectContaining({ id: "task-1", content: "debug the rollout regression" }),
      ]),
      total: 3,
    });
  });

  it("returns partial scoped recall results when one container fails", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const recall = vi.fn()
      .mockImplementation(async (_agentId: string, _query: string, container: string) => {
        if (container === "startup:startup-1") {
          throw new Error("startup recall unavailable");
        }
        if (container === "startup:startup-1:emp:emp-1") {
          return {
            items: [
              {
                id: "private-1",
                content: "my deployment ritual",
                memory_type: "dynamic",
                confidence: 0.74,
                relevance_score: 0.7,
                kind: "vector",
              },
            ],
          };
        }
        if (container === "startup:startup-1:task:task-1") {
          return {
            items: [
              {
                id: "task-1",
                content: "debug the rollout regression",
                memory_type: "working",
                confidence: 0.66,
                relevance_score: 0.89,
                kind: "vector",
              },
            ],
          };
        }
        return { items: [] };
      });

    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        recall,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/scoped-recall")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/scoped-recall",
      body: {
        query: "deployment",
        startupId: "startup-1",
        employeeId: "emp-1",
        taskId: "task-1",
        includeShared: true,
        topK: 5,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      items: [
        expect.objectContaining({ id: "private-1" }),
        expect.objectContaining({ id: "task-1" }),
      ],
      total: 2,
    });
  });

  it("validates scoped recall input once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        recall: vi.fn(),
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/scoped-recall")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/scoped-recall",
      body: {
        query: "",
        startupId: "startup-1",
        employeeId: "emp-1",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("supports Part 1 shareable memories once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const listMemories = vi.fn().mockResolvedValue({
      items: [
        {
          id: "shared-1",
          content: "share this launch playbook",
          memory_type: "static",
          confidence: 0.95,
          relevance_score: 0.7,
          container: "startup:startup-1",
          visibility: "shared",
          created_at: "2026-03-24T00:00:00Z",
          updated_at: "2026-03-24T00:00:00Z",
          access_count: 2,
        },
        {
          id: "board-1",
          content: "board escalation protocol",
          memory_type: "static",
          confidence: 0.88,
          relevance_score: 0.6,
          container: "startup:startup-1",
          visibility: "board",
          created_at: "2026-03-24T00:00:00Z",
          updated_at: "2026-03-24T00:00:00Z",
          access_count: 1,
        },
        {
          id: "private-1",
          content: "keep this private",
          memory_type: "dynamic",
          confidence: 0.51,
          relevance_score: 0.2,
          container: "startup:startup-1",
          visibility: "private",
          created_at: "2026-03-24T00:00:00Z",
          updated_at: "2026-03-24T00:00:00Z",
          access_count: 0,
        },
      ],
      total: 3,
    });

    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        listMemories,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/shareable")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/shareable",
      query: {
        startupId: "startup-1",
        visibility: "shared,board",
      },
    });

    expect(listMemories).toHaveBeenCalledWith("agent-1", undefined, "startup:startup-1");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      items: [
        expect.objectContaining({ id: "shared-1", visibility: "shared" }),
        expect.objectContaining({ id: "board-1", visibility: "board" }),
      ],
      total: 2,
    });
  });
});
