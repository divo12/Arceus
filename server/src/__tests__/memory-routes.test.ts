import type { RequestHandler, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryServiceError } from "../services/hippocampus-errors.js";

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
  hippocampusMode: "setup" | "active" | "embedded";
  method: "get" | "post";
  params?: Record<string, unknown>;
  path: string;
  query?: Record<string, unknown>;
  resolveAgentCompanyId?: (agentId: string) => Promise<string | undefined>;
}) {
  const { memoryRoutes } = await import("../routes/memory.js");
  const router = memoryRoutes({
    hippocampusMode: options.hippocampusMode,
    resolveAgentCompanyId: options.resolveAgentCompanyId,
  });
  const handler = getRouteHandler(router, options.method, options.path);

  const req = {
    actor: options.actor ?? { type: "board", userId: "board-user", source: "local_implicit" },
    body: options.body ?? {},
    params: { agentId: "agent-1", ...(options.params ?? {}) },
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

  it("returns 503 when hippocampus mode is in setup", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "setup";

    const res = await invokeRoute({
      hippocampusMode: "setup",
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

  it("extracts meeting memories for each participant", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const extract = vi.fn()
      .mockImplementation(async (agentId: string) => ({
        added: agentId === "agent-2" ? 2 : 1,
        updated: 0,
        deleted: 0,
      }));

    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        extract,
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/extract-meeting",
      body: {
        meetingId: "meeting-42",
        transcript: "We decided to ship the auth fix this week.",
        participants: ["agent-2", "agent-3"],
      },
    });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledWith(
      "agent-2",
      [{ role: "user", content: "We decided to ship the auth fix this week." }],
      "meeting:meeting-42",
    );
    expect(extract).toHaveBeenCalledWith(
      "agent-3",
      [{ role: "user", content: "We decided to ship the auth fix this week." }],
      "meeting:meeting-42",
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      meetingId: "meeting-42",
      participants: [
        { participantId: "agent-2", added: 2, updated: 0, deleted: 0 },
        { participantId: "agent-3", added: 1, updated: 0, deleted: 0 },
      ],
      failedCount: 0,
    });
  });

  it("returns partial meeting extraction results when one participant fails", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const extract = vi.fn()
      .mockImplementation(async (agentId: string) => {
        if (agentId === "agent-2") {
          throw new Error("participant extraction failed");
        }
        return {
          added: 1,
          updated: 1,
          deleted: 0,
        };
      });

    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        extract,
      }),
    }));

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/extract-meeting",
      body: {
        meetingId: "meeting-42",
        transcript: "We decided to ship the auth fix this week.",
        participants: ["agent-2", "agent-3"],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      meetingId: "meeting-42",
      participants: [
        { participantId: "agent-3", added: 1, updated: 1, deleted: 0 },
      ],
      failedCount: 1,
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

  // --- Part 2: Graph & Projection tests ---

  function fullProjectionsMock(overrides: Record<string, unknown> = {}) {
    return {
      getGraphView: vi.fn(),
      getVersionHistory: vi.fn(),
      getPromotionLog: vi.fn(),
      getMemoryExplorer: vi.fn(),
      ...overrides,
    };
  }

  function fullProfileMock(overrides: Record<string, unknown> = {}) {
    return {
      generateProfile: vi.fn(),
      ...overrides,
    };
  }

  function fullDelegationMock(overrides: Record<string, unknown> = {}) {
    return {
      prepareDelegationContext: vi.fn(),
      internalizeDelegationResult: vi.fn(),
      ...overrides,
    };
  }

  it("supports Part 2 graph view once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const getGraphView = vi.fn().mockResolvedValue({
      center_node: {
        id: "node-center",
        name: "Authentication",
        entity_type: "concept",
        mention_count: 14,
        created_at: "2026-03-24T00:00:00Z",
      },
      nodes: [
        {
          id: "node-center",
          name: "Authentication",
          entity_type: "concept",
          mention_count: 14,
          created_at: "2026-03-24T00:00:00Z",
        },
        {
          id: "node-related",
          name: "JWT",
          entity_type: "dynamic",
          mention_count: 8,
          created_at: "2026-03-24T00:00:00Z",
        },
      ],
      edges: [
        {
          source_id: "node-center",
          target_id: "node-related",
          relation_type: "related_to",
          weight: 0.9,
        },
      ],
      depth: 2,
    });

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock({ getGraphView }),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/graph")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/graph",
      query: {
        query: "auth",
        container: "startup:startup-1",
        depth: "2",
      },
    });

    expect(getGraphView).toHaveBeenCalledWith("agent-1", "auth", "startup:startup-1", 2);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      center_node: expect.objectContaining({ id: "node-center", name: "Authentication" }),
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "node-center" }),
        expect.objectContaining({ id: "node-related" }),
      ]),
      edges: [
        expect.objectContaining({
          source_id: "node-center",
          target_id: "node-related",
          relation_type: "related_to",
          weight: 0.9,
        }),
      ],
      depth: 2,
    });
  });

  it("validates Part 2 graph input once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock(),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/graph")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/graph",
      query: {
        query: "",
        container: "startup:startup-1",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("returns an empty Part 2 graph view during graceful degradation", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock({
          getGraphView: vi.fn().mockResolvedValue({
            center_node: null,
            nodes: [],
            edges: [],
            depth: 2,
          }),
        }),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/graph")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/graph",
      query: {
        query: "missing",
        container: "startup:startup-1",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      center_node: null,
      nodes: [],
      edges: [],
      depth: 2,
    });
  });

  it("supports Part 2 version history once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const getVersionHistory = vi.fn().mockResolvedValue([
      {
        id: "mem-v2",
        name: "Updated insight",
        entity_type: "dynamic",
        mention_count: 3,
        created_at: "2026-03-24T12:00:00Z",
      },
      {
        id: "mem-v1",
        name: "Original insight",
        entity_type: "dynamic",
        mention_count: 1,
        created_at: "2026-03-23T12:00:00Z",
      },
    ]);

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock({ getVersionHistory }),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/:memoryId/history")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/:memoryId/history",
      params: { memoryId: "mem-v2" },
    });

    expect(getVersionHistory).toHaveBeenCalledWith("agent-1", "mem-v2");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: "mem-v2", name: "Updated insight" }),
      expect.objectContaining({ id: "mem-v1", name: "Original insight" }),
    ]);
  });

  it("supports Part 2 promotion log once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const getPromotionLog = vi.fn().mockResolvedValue([
      {
        agent_id: "agent-1",
        memory_id: "mem-promoted",
        from_type: "working",
        to_type: "dynamic",
        reason: "confidence threshold",
        status: "completed",
        timestamp: "2026-03-25T08:00:00Z",
      },
    ]);

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock({ getPromotionLog }),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/promotions")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/promotions",
      query: { limit: "10" },
    });

    expect(getPromotionLog).toHaveBeenCalledWith("agent-1", 10);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        memory_id: "mem-promoted",
        from_type: "working",
        to_type: "dynamic",
      }),
    ]);
  });

  it("emits live events for promotion runs when company scope is provided", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const publishLiveEvent = vi.fn();

    vi.doMock("../services/live-events.js", () => ({
      publishLiveEvent,
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        runPromotions: vi.fn().mockResolvedValue({
          promotions: [
            {
              memory_id: "mem-1",
              from_tier: "dynamic",
              to_tier: "static",
              reason: "repeated success",
            },
            {
              memory_id: "mem-2",
              from_tier: "working",
              to_tier: "dynamic",
              reason: "recent extraction",
            },
          ],
        }),
      }),
    }));

    const res = await invokeRoute({
      body: { companyId: "company-1" },
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/promotions",
    });

    expect(res.statusCode).toBe(200);
    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
    expect(publishLiveEvent).toHaveBeenNthCalledWith(1, {
      companyId: "company-1",
      type: "memory:promotion",
      payload: {
        agentId: "agent-1",
        memoryId: "mem-1",
        fromTier: "dynamic",
        toTier: "static",
        reason: "repeated success",
      },
    });
    expect(publishLiveEvent).toHaveBeenNthCalledWith(2, {
      companyId: "company-1",
      type: "memory:promotion",
      payload: {
        agentId: "agent-1",
        memoryId: "mem-2",
        fromTier: "working",
        toTier: "dynamic",
        reason: "recent extraction",
      },
    });
  });

  it("emits a live event for GC runs when company scope is provided", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const publishLiveEvent = vi.fn();

    vi.doMock("../services/live-events.js", () => ({
      publishLiveEvent,
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        runGC: vi.fn().mockResolvedValue({
          expired: 3,
          decayed: 7,
          demoted: 1,
        }),
      }),
    }));

    const res = await invokeRoute({
      actor: {
        type: "board",
        userId: "board-user",
        source: "session",
        companyIds: ["company-1"],
      },
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/gc",
    });

    expect(res.statusCode).toBe(200);
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "memory:gc",
      payload: {
        agentId: "agent-1",
        expired: 3,
        decayed: 7,
        demoted: 1,
      },
    });
  });

  it("resolves company scope from agent lookup for promotions in local trusted mode", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const publishLiveEvent = vi.fn();

    vi.doMock("../services/live-events.js", () => ({
      publishLiveEvent,
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        runPromotions: vi.fn().mockResolvedValue({
          promotions: [
            {
              memory_id: "mem-1",
              from_tier: "dynamic",
              to_tier: "static",
              reason: "repeated success",
            },
          ],
        }),
      }),
    }));

    const res = await invokeRoute({
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
      },
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/promotions",
      resolveAgentCompanyId: async () => "company-1",
    });

    expect(res.statusCode).toBe(200);
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "memory:promotion",
      payload: {
        agentId: "agent-1",
        memoryId: "mem-1",
        fromTier: "dynamic",
        toTier: "static",
        reason: "repeated success",
      },
    });
  });

  it("supports Part 2 memory explorer once the route lands", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const getMemoryExplorer = vi.fn().mockResolvedValue({
      items: [
        {
          id: "mem-1",
          content: "First memory",
          memory_type: "static",
          confidence: 0.95,
          created_at: "2026-03-24T00:00:00Z",
          access_count: 5,
        },
      ],
      total: 1,
    });

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock({ getMemoryExplorer }),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/explorer")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/explorer",
      query: {
        container: "startup:startup-1",
        limit: "25",
      },
    });

    expect(getMemoryExplorer).toHaveBeenCalledWith("agent-1", "startup:startup-1", undefined, 25);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      items: [expect.objectContaining({ id: "mem-1", content: "First memory" })],
      total: 1,
    });
  });

  it("validates Part 2 explorer input requires container", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock(),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/explorer")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/explorer",
      query: { limit: "25" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("surfaces Part 2 projection service errors with handleMemoryError", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const { MemoryServiceError: MSE } = await import("../services/hippocampus-errors.js");
    const serviceError = new MSE(
      "Graph store is not available",
      503,
      "GRAPH_UNAVAILABLE",
      { backend: "neo4j" },
    );
    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: fullProjectionsMock({
          getVersionHistory: vi.fn().mockRejectedValue(serviceError),
        }),
        profile: null,
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/:memoryId/history")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/:memoryId/history",
      params: { memoryId: "mem-404" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "Graph store is not available",
      code: "GRAPH_UNAVAILABLE",
      details: { backend: "neo4j" },
    });
  });

  it("supports Part 3 profile route", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const generateProfile = vi.fn().mockResolvedValue({
      role: "CTO",
      core_knowledge: ["JWT auth with PKCE"],
      current_context: ["Reviewing token refresh"],
      habits: [{ trigger: "code review", action: "check errors", confidence: 0.82 }],
      state: {
        priming_prompt: "Focus on reliability",
        partial: false,
      },
    });

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: null,
        profile: fullProfileMock({ generateProfile }),
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/profile")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/profile",
      query: {
        startupId: "startup-1",
        role: "CTO",
      },
    });

    expect(generateProfile).toHaveBeenCalledWith("agent-1", "startup-1", "CTO");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      role: "CTO",
      core_knowledge: ["JWT auth with PKCE"],
      current_context: ["Reviewing token refresh"],
      habits: [{ trigger: "code review", action: "check errors", confidence: 0.82 }],
      state: {
        priming_prompt: "Focus on reliability",
        partial: false,
      },
    });
  });

  it("validates Part 3 profile query", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: null,
        profile: fullProfileMock(),
        delegation: null,
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "get", "/agents/:agentId/memory/profile")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "get",
      path: "/agents/:agentId/memory/profile",
      query: {
        startupId: "",
        role: "CTO",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("supports Part 3 delegation route", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const prepareDelegationContext = vi.fn().mockResolvedValue({
      copiedCount: 2,
      failedCount: 0,
      memories: [
        {
          id: "delegated-1",
          content: "[delegated:agent-1] JWT auth with PKCE",
          memory_type: "dynamic",
          confidence: 0.93,
          relevance_score: 0.88,
          container: "startup:startup-1:task:task-7",
          visibility: null,
          created_at: null,
          updated_at: null,
          access_count: 0,
        },
      ],
    });

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: null,
        profile: null,
        delegation: fullDelegationMock({ prepareDelegationContext }),
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/delegate")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/delegate",
      body: {
        toAgentId: "agent-2",
        startupId: "startup-1",
        taskId: "task-7",
        taskDescription: "Implement token refresh endpoint",
        topK: 5,
      },
    });

    expect(prepareDelegationContext).toHaveBeenCalledWith(
      "agent-1",
      "agent-2",
      "startup-1",
      "task-7",
      "Implement token refresh endpoint",
      5,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      copiedCount: 2,
      failedCount: 0,
      memories: expect.arrayContaining([
        expect.objectContaining({ id: "delegated-1" }),
      ]),
    }));
  });

  it("returns 207 for partial Part 3 delegation copy", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const prepareDelegationContext = vi.fn().mockResolvedValue({
      copiedCount: 1,
      failedCount: 1,
      memories: [
        {
          id: "delegated-1",
          content: "[delegated:agent-1] OAuth2 flow uses PKCE",
          memory_type: "dynamic",
          confidence: 0.88,
          relevance_score: 0.79,
          container: "startup:startup-1:task:task-7",
          visibility: null,
          created_at: null,
          updated_at: null,
          access_count: 0,
        },
      ],
    });

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: null,
        profile: null,
        delegation: fullDelegationMock({ prepareDelegationContext }),
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/delegate")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/delegate",
      body: {
        toAgentId: "agent-2",
        startupId: "startup-1",
        taskId: "task-7",
        taskDescription: "Implement token refresh endpoint",
        topK: 5,
      },
    });

    expect(res.statusCode).toBe(207);
    expect(res.body).toEqual(expect.objectContaining({
      copiedCount: 1,
      failedCount: 1,
    }));
  });

  it("validates Part 3 delegation input", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: null,
        profile: null,
        delegation: fullDelegationMock(),
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/delegate")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/delegate",
      body: {
        toAgentId: "",
        startupId: "startup-1",
        taskId: "task-7",
        taskDescription: "Implement token refresh endpoint",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("supports Part 3 internalize-delegation route", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const internalizeDelegationResult = vi.fn().mockResolvedValue({ internalized: 2 });

    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: null,
        profile: null,
        delegation: fullDelegationMock({ internalizeDelegationResult }),
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/internalize-delegation")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/internalize-delegation",
      body: {
        startupId: "startup-1",
        learnings: ["Refresh tokens should use jti", "PKCE verifier length matters"],
        quality: 0.92,
      },
    });

    expect(internalizeDelegationResult).toHaveBeenCalledWith(
      "agent-1",
      "startup-1",
      ["Refresh tokens should use jti", "PKCE verifier length matters"],
      0.92,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ internalized: 2 });
  });

  it("validates Part 3 internalize-delegation input", async (context) => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/memory-services.js", () => ({
      getMemoryServices: () => ({
        scope: null,
        projections: null,
        profile: null,
        delegation: fullDelegationMock(),
      }),
    }));

    const { memoryRoutes } = await import("../routes/memory.js");
    const router = memoryRoutes({ hippocampusMode: "embedded" });
    if (!findRouteLayer(router, "post", "/agents/:agentId/memory/internalize-delegation")) {
      context.skip();
      return;
    }

    const res = await invokeRoute({
      hippocampusMode: "embedded",
      method: "post",
      path: "/agents/:agentId/memory/internalize-delegation",
      body: {
        startupId: "startup-1",
        learnings: [],
        quality: 0.92,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("ProfileService returns a partial profile when some bridge calls fail", async () => {
    const { ProfileService } = await import("../services/profile-service.js");
    const bridge = {
      listMemories: vi.fn()
        .mockResolvedValueOnce({
          items: [{ content: "JWT auth with PKCE" }],
          total: 1,
        })
        .mockRejectedValueOnce(new Error("dynamic down")),
      getHabits: vi.fn().mockResolvedValue({
        habits: [{ trigger: "code review", action: "check errors", confidence: 0.82 }],
      }),
      getPriming: vi.fn().mockResolvedValue({ prompt: "Focus on reliability" }),
    } as unknown as import("../services/hippocampus-contract.js").HippocampusBridge;

    const service = new ProfileService(bridge);
    const result = await service.generateProfile("agent-1", "startup-1", "CTO");

    expect(result).toEqual({
      role: "CTO",
      core_knowledge: ["JWT auth with PKCE"],
      current_context: [],
      habits: [{ trigger: "code review", action: "check errors", confidence: 0.82 }],
      state: {
        priming_prompt: "Focus on reliability",
        partial: true,
      },
    });
  });

  it("DelegationMemoryService handles partial copies and internalization thresholds", async () => {
    const { DelegationMemoryService } = await import("../services/delegation-memory.js");
    const remember = vi.fn()
      .mockResolvedValueOnce({
        id: "delegated-1",
        content: "[delegated:agent-1] JWT auth with PKCE",
        memory_type: "dynamic",
        confidence: 0.91,
      })
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({
        id: "mem-static",
        content: "Use jti for refresh token revocation",
        memory_type: "static",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        id: "mem-dynamic",
        content: "Remember to validate PKCE verifier length",
        memory_type: "dynamic",
        confidence: 0.9,
      });
    const bridge = {
      recall: vi.fn().mockResolvedValue({
        items: [
          {
            id: "src-1",
            content: "JWT auth with PKCE",
            memory_type: "static",
            confidence: 0.94,
            relevance_score: 0.82,
            kind: "vector",
          },
          {
            id: "src-2",
            content: "OAuth2 flow uses PKCE",
            memory_type: "static",
            confidence: 0.89,
            relevance_score: 0.76,
            kind: "vector",
          },
        ],
      }),
      remember,
    } as unknown as import("../services/hippocampus-contract.js").HippocampusBridge;

    const service = new DelegationMemoryService(bridge);
    const delegated = await service.prepareDelegationContext(
      "agent-1",
      "agent-2",
      "startup-1",
      "task-7",
      "Implement token refresh endpoint",
      5,
    );

    expect(delegated.copiedCount).toBe(1);
    expect(delegated.failedCount).toBe(1);
    expect(remember).toHaveBeenNthCalledWith(
      1,
      "agent-2",
      "[delegated:agent-1] JWT auth with PKCE",
      "startup:startup-1:task:task-7",
      "dynamic",
    );
    expect(remember).toHaveBeenNthCalledWith(
      2,
      "agent-2",
      "[delegated:agent-1] OAuth2 flow uses PKCE",
      "startup:startup-1:task:task-7",
      "dynamic",
    );

    const skipped = await service.internalizeDelegationResult(
      "agent-2",
      "startup-1",
      ["Low quality learning"],
      0.59,
    );
    expect(skipped).toEqual({ internalized: 0 });

    const staticInternalized = await service.internalizeDelegationResult(
      "agent-2",
      "startup-1",
      ["Use jti for refresh token revocation"],
      0.95,
    );
    expect(staticInternalized).toEqual({ internalized: 1 });
    expect(remember).toHaveBeenNthCalledWith(
      3,
      "agent-2",
      "Use jti for refresh token revocation",
      "startup:startup-1:emp:agent-2",
      "static",
    );

    const dynamicInternalized = await service.internalizeDelegationResult(
      "agent-2",
      "startup-1",
      ["Remember to validate PKCE verifier length"],
      0.75,
    );
    expect(dynamicInternalized).toEqual({ internalized: 1 });
    expect(remember).toHaveBeenNthCalledWith(
      4,
      "agent-2",
      "Remember to validate PKCE verifier length",
      "startup:startup-1:emp:agent-2",
      "dynamic",
    );
  });
});
