import { Router } from "express";
import { ZodError } from "zod";
import { z } from "zod";
import { loadConfig, type HippocampusMode } from "../config.js";
import { HippocampusDisabledError, type HippocampusBridge } from "../services/hippocampus-contract.js";
import { getHippocampusBridge } from "../services/hippocampus-bridge.js";
import { MemoryServiceError } from "../services/hippocampus-errors.js";
import { getMemoryServices } from "../services/memory-services.js";
import { type MemoryVisibility, MemoryScopeService } from "../services/memory-scope.js";
import { ScopedRecallSchema } from "../services/memory-schemas.js";
import { assertBoard } from "./authz.js";

/**
 * Memory routes — proxied to the Hippocampus bridge.
 * Mounted under /api/agents/:agentId/memory/...
 */
type HippocampusBridgeSurface = Pick<
  HippocampusBridge,
  "getSummary" | "listMemories" | "getPriming" | "getHabits" | "remember" | "recall" | "runGC" | "runPromotions" | "health" | "diagnostics"
>;

function resolveHippocampusMode(modeOverride?: HippocampusMode): HippocampusMode {
  return modeOverride ?? loadConfig().hippocampusMode;
}

function sendBridgeError(
  res: {
    status(code: number): { json(body: unknown): unknown };
  },
  err: unknown,
): void {
  res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
}

export function handleMemoryError(
  res: {
    status(code: number): { json(body: unknown): unknown };
  },
  error: unknown,
): void {
  if (error instanceof MemoryServiceError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
    return;
  }
  if (error instanceof HippocampusDisabledError) {
    res.status(503).json({ error: "Memory system is disabled" });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: error.flatten().fieldErrors,
    });
    return;
  }
  console.error("[memory-route] unexpected error:", error);
  res.status(500).json({ error: "Internal server error" });
}

function resolveBridge(): HippocampusBridgeSurface {
  return getHippocampusBridge() as HippocampusBridgeSurface;
}

function resolveScopeService(): MemoryScopeService {
  const registered = getMemoryServices().scope;
  if (registered instanceof MemoryScopeService) {
    return registered;
  }
  return new MemoryScopeService(getHippocampusBridge() as HippocampusBridge);
}

export function memoryRoutes(options: { hippocampusMode?: HippocampusMode } = {}) {
  const router = Router();
  const hippocampusMode = resolveHippocampusMode(options.hippocampusMode);

  function ensureEnabled(res: {
    status(code: number): { json(body: unknown): unknown };
  }): boolean {
    if (hippocampusMode !== "off") return true;
    res.status(503).json({ error: "Hippocampus is disabled" });
    return false;
  }

  /** GET /api/agents/:agentId/memory/summary */
  router.get("/agents/:agentId/memory/summary", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const summary = await hippocampusBridge.getSummary(req.params.agentId);
      res.json(summary);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** GET /api/agents/:agentId/memory/list */
  router.get("/agents/:agentId/memory/list", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const { memory_type, container, limit } = req.query;
      const result = await hippocampusBridge.listMemories(
        req.params.agentId,
        memory_type as string | undefined,
        container as string | undefined,
        limit ? Number(limit) : 50,
      );
      res.json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** GET /api/agents/:agentId/memory/priming */
  router.get("/agents/:agentId/memory/priming", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const result = await hippocampusBridge.getPriming(req.params.agentId);
      res.json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** GET /api/agents/:agentId/memory/habits */
  router.get("/agents/:agentId/memory/habits", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const context = (req.query.context as string) ?? "";
      const result = await hippocampusBridge.getHabits(req.params.agentId, context);
      res.json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** POST /api/agents/:agentId/memory/remember */
  router.post("/agents/:agentId/memory/remember", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const { content, container, memory_type } = req.body;
      const result = await hippocampusBridge.remember(
        req.params.agentId,
        content,
        container ?? "default",
        memory_type ?? "dynamic",
      );
      res.json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** POST /api/agents/:agentId/memory/recall */
  router.post("/agents/:agentId/memory/recall", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const { query, container, top_k } = req.body;
      const result = await hippocampusBridge.recall(
        req.params.agentId,
        query,
        container ?? "default",
        top_k ?? 10,
      );
      res.json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** POST /api/agents/:agentId/memory/scoped-recall */
  router.post("/agents/:agentId/memory/scoped-recall", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const body = ScopedRecallSchema.parse(req.body);
      const items = await resolveScopeService().getMemoriesForAgent(
        req.params.agentId,
        body.query,
        body.startupId,
        body.employeeId,
        body.taskId,
        body.includeShared,
        body.topK,
      );
      res.json({ items, total: items.length });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/agents/:agentId/memory/shareable */
  router.get("/agents/:agentId/memory/shareable", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const params = z.object({
        startupId: z.string().min(1),
        visibility: z.string().optional(),
      }).parse(req.query);

      const visibility = params.visibility
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) as MemoryVisibility[] | undefined;
      const items = await resolveScopeService().getShareableMemories(
        req.params.agentId,
        params.startupId,
        visibility?.length ? visibility : undefined,
      );
      res.json({ items, total: items.length });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** POST /api/agents/:agentId/memory/gc */
  router.post("/agents/:agentId/memory/gc", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const result = await hippocampusBridge.runGC(req.params.agentId);
      res.json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** POST /api/agents/:agentId/memory/promotions */
  router.post("/agents/:agentId/memory/promotions", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const hippocampusBridge = resolveBridge();
      const result = await hippocampusBridge.runPromotions(req.params.agentId);
      res.json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  /** GET /api/memory/health */
  router.get("/memory/health", async (_req, res) => {
    try {
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = resolveBridge();
      const result = await hippocampusBridge.health();
      const diagnostics = hippocampusBridge.diagnostics?.() ?? null;
      res.json(diagnostics ? { ...result, diagnostics } : result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  return router;
}
