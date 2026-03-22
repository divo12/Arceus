import { Router } from "express";
import { hippocampusClient } from "../services/hippocampus-client.js";
import { assertBoard } from "./authz.js";

/**
 * Memory routes — proxied to the Hippocampus Python sidecar.
 * Mounted under /api/agents/:agentId/memory/...
 */
export function memoryRoutes() {
  const router = Router();

  /** GET /api/agents/:agentId/memory/summary */
  router.get("/agents/:agentId/memory/summary", async (req, res) => {
    try {
      assertBoard(req);
      const summary = await hippocampusClient.getSummary(req.params.agentId);
      res.json(summary);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** GET /api/agents/:agentId/memory/list */
  router.get("/agents/:agentId/memory/list", async (req, res) => {
    try {
      assertBoard(req);
      const { memory_type, container, limit } = req.query;
      const result = await hippocampusClient.listMemories(
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
      const result = await hippocampusClient.getPriming(req.params.agentId);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** GET /api/agents/:agentId/memory/habits */
  router.get("/agents/:agentId/memory/habits", async (req, res) => {
    try {
      assertBoard(req);
      const context = (req.query.context as string) ?? "";
      const result = await hippocampusClient.getHabits(req.params.agentId, context);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** POST /api/agents/:agentId/memory/remember */
  router.post("/agents/:agentId/memory/remember", async (req, res) => {
    try {
      assertBoard(req);
      const { content, container, memory_type } = req.body;
      const result = await hippocampusClient.remember(
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
      const { query, container, top_k } = req.body;
      const result = await hippocampusClient.recall(
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
      const result = await hippocampusClient.runGC(req.params.agentId);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  /** GET /api/memory/health */
  router.get("/memory/health", async (_req, res) => {
    try {
      const result = await hippocampusClient.health();
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Hippocampus unavailable" });
    }
  });

  return router;
}
