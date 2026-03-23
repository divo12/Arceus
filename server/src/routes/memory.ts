import { Router } from "express";
import { loadConfig, type HippocampusMode } from "../config.js";
import type { HippocampusBridge } from "../services/hippocampus-contract.js";
import { assertBoard } from "./authz.js";

/**
 * Memory routes — proxied to the Hippocampus bridge.
 * Mounted under /api/agents/:agentId/memory/...
 */
type HippocampusBridgeSurface = Pick<
  HippocampusBridge,
  "getSummary" | "listMemories" | "getPriming" | "getHabits" | "remember" | "recall" | "runGC" | "health"
>;

async function getHippocampusBridge(): Promise<HippocampusBridgeSurface> {
  const mod = await import("../services/hippocampus-bridge.js");
  return mod.hippocampusBridge as HippocampusBridgeSurface;
}

function resolveHippocampusMode(modeOverride?: HippocampusMode): HippocampusMode {
  return modeOverride ?? loadConfig().hippocampusMode;
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
    try {
      assertBoard(req);
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const summary = await hippocampusBridge.getSummary(req.params.agentId);
      res.json(summary);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** GET /api/agents/:agentId/memory/list */
  router.get("/agents/:agentId/memory/list", async (req, res) => {
    try {
      assertBoard(req);
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const { memory_type, container, limit } = req.query;
      const result = await hippocampusBridge.listMemories(
        req.params.agentId,
        memory_type as string | undefined,
        container as string | undefined,
        limit ? Number(limit) : 50,
      );
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** GET /api/agents/:agentId/memory/priming */
  router.get("/agents/:agentId/memory/priming", async (req, res) => {
    try {
      assertBoard(req);
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const result = await hippocampusBridge.getPriming(req.params.agentId);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** GET /api/agents/:agentId/memory/habits */
  router.get("/agents/:agentId/memory/habits", async (req, res) => {
    try {
      assertBoard(req);
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const context = (req.query.context as string) ?? "";
      const result = await hippocampusBridge.getHabits(req.params.agentId, context);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** POST /api/agents/:agentId/memory/remember */
  router.post("/agents/:agentId/memory/remember", async (req, res) => {
    try {
      assertBoard(req);
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const { content, container, memory_type } = req.body;
      const result = await hippocampusBridge.remember(
        req.params.agentId,
        content,
        container ?? "default",
        memory_type ?? "dynamic",
      );
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** POST /api/agents/:agentId/memory/recall */
  router.post("/agents/:agentId/memory/recall", async (req, res) => {
    try {
      assertBoard(req);
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const { query, container, top_k } = req.body;
      const result = await hippocampusBridge.recall(
        req.params.agentId,
        query,
        container ?? "default",
        top_k ?? 10,
      );
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** POST /api/agents/:agentId/memory/gc */
  router.post("/agents/:agentId/memory/gc", async (req, res) => {
    try {
      assertBoard(req);
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const result = await hippocampusBridge.runGC(req.params.agentId);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** GET /api/memory/health */
  router.get("/memory/health", async (_req, res) => {
    try {
      if (!ensureEnabled(res)) return;
      const hippocampusBridge = await getHippocampusBridge();
      const result = await hippocampusBridge.health();
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  return router;
}
