import { Router } from "express";
import { ZodError } from "zod";
import { loadConfig, type HippocampusMode } from "../config.js";
import { HippocampusDisabledError, type HippocampusBridge } from "../services/hippocampus-contract.js";
import { getHippocampusBridge } from "../services/hippocampus-bridge.js";
import { MemoryServiceError } from "../services/hippocampus-errors.js";
import { assertBoard } from "./authz.js";

/**
 * Memory routes — proxied to the Hippocampus bridge.
 * Mounted under /api/agents/:agentId/memory/...
 */
type HippocampusBridgeSurface = Pick<
  HippocampusBridge,
  "getSummary" | "listMemories" | "getPriming" | "getHabits" | "remember" | "recall" | "runGC" | "health" | "diagnostics"
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
