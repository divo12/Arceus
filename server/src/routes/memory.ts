import { DelegationMemoryService } from "../services/delegation-memory.js";
import { Router, type Request } from "express";
import { ZodError } from "zod";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { INITIAL_PRIMING_STATE } from "@paperclipai/shared";
import { loadConfig, type HippocampusMode } from "../config.js";
import { HippocampusDisabledError, type HippocampusBridge } from "../services/hippocampus-contract.js";
import { getHippocampusBridge } from "../services/hippocampus-bridge.js";
import { MemoryServiceError } from "../services/hippocampus-errors.js";
import { publishLiveEvent } from "../services/live-events.js";
import { logger } from "../middleware/logger.js";
import { memoryReadinessService } from "../services/memory-readiness.js";
import { getMemoryServices } from "../services/memory-services.js";
import { memoryStoreService } from "../services/memory-store.js";
import { MemoryProjectionService } from "../services/memory-projections.js";
import { type MemoryVisibility, MemoryScopeService } from "../services/memory-scope.js";
import { ProfileService } from "../services/profile-service.js";
import { workingMemoryService } from "../services/working-memory.js";
import {
  DelegateSchema,
  InternalizeDelegationSchema,
  MemoryExplorerQuerySchema,
  MeetingExtractSchema,
  ProfileQuerySchema,
  PromotionLogQuerySchema,
  ScopedRecallSchema,
} from "../services/memory-schemas.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Memory routes — proxied to the Hippocampus bridge.
 * Mounted under /api/agents/:agentId/memory/...
 */
type HippocampusBridgeSurface = Pick<
  HippocampusBridge,
  "getEmbedding" | "getSummary" | "listMemories" | "getPriming" | "getHabits" | "remember" | "recall" | "extract" | "runGC" | "runPromotions" | "health" | "diagnostics"
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
  logger.error({ err: error }, "[memory-route] unexpected error");
  res.status(500).json({ error: "Internal server error" });
}

function resolveBridge(): HippocampusBridgeSurface {
  return getHippocampusBridge() as HippocampusBridgeSurface;
}

function buildPrimingPrompt(state: unknown): string {
  const current = state && typeof state === "object"
    ? state as Record<string, unknown>
    : {};
  const confidence = typeof current.confidence === "number" ? current.confidence : INITIAL_PRIMING_STATE.confidence;
  const caution = typeof current.caution === "number" ? current.caution : INITIAL_PRIMING_STATE.caution;
  const morale = typeof current.morale === "number" ? current.morale : INITIAL_PRIMING_STATE.morale;
  const recentEvents = Array.isArray(current.recentEvents)
    ? current.recentEvents.filter((value): value is string => typeof value === "string")
    : [];

  const lines = [
    `Confidence: ${(confidence * 100).toFixed(0)}%`,
    `Caution: ${(caution * 100).toFixed(0)}%`,
    `Morale: ${(morale * 100).toFixed(0)}%`,
  ];
  if (recentEvents.length > 0) {
    lines.push("Recent signals:");
    for (const event of recentEvents.slice(0, 5)) {
      lines.push(`- ${event}`);
    }
  }
  return lines.join("\n");
}

function toListItem(memory: Record<string, unknown>) {
  return {
    id: String(memory.id ?? ""),
    content: String(memory.content ?? ""),
    memory_type: typeof memory.memoryType === "string" ? memory.memoryType : null,
    confidence: typeof memory.confidence === "number" ? memory.confidence : 0,
    relevance_score: typeof memory.relevanceScore === "number" ? memory.relevanceScore : 0,
    container: typeof memory.container === "string" ? memory.container : "default",
    visibility: typeof memory.visibility === "string" ? memory.visibility : null,
    created_at:
      memory.createdAt instanceof Date
        ? memory.createdAt.toISOString()
        : typeof memory.createdAt === "string"
          ? memory.createdAt
          : null,
    updated_at:
      memory.updatedAt instanceof Date
        ? memory.updatedAt.toISOString()
        : typeof memory.updatedAt === "string"
          ? memory.updatedAt
          : null,
    access_count: 0,
  };
}

function toRecallItem(memory: Record<string, unknown>) {
  return {
    id: String(memory.id ?? ""),
    content: String(memory.content ?? ""),
    memory_type: typeof memory.memoryType === "string" ? memory.memoryType : null,
    confidence: typeof memory.confidence === "number" ? memory.confidence : null,
    relevance_score: typeof memory.relevanceScore === "number" ? memory.relevanceScore : null,
    kind: typeof memory.memoryType === "string" ? memory.memoryType : "memory",
  };
}

function readCompanyId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveScopeService(): MemoryScopeService {
  const registered = getMemoryServices().scope;
  if (
    registered &&
    typeof registered === "object" &&
    "getMemoriesForAgent" in registered &&
    "getShareableMemories" in registered
  ) {
    return registered as MemoryScopeService;
  }
  return new MemoryScopeService(getHippocampusBridge() as HippocampusBridge);
}

function resolveProjectionService(): MemoryProjectionService {
  const registered = getMemoryServices().projections;
  if (
    registered &&
    typeof registered === "object" &&
    "getPromotionLog" in registered &&
    "getMemoryExplorer" in registered
  ) {
    return registered as MemoryProjectionService;
  }
  return new MemoryProjectionService(getHippocampusBridge() as HippocampusBridge);
}

function resolveProfileService(): ProfileService {
  const registered = getMemoryServices().profile;
  if (
    registered &&
    typeof registered === "object" &&
    "generateProfile" in registered
  ) {
    return registered as ProfileService;
  }
  return new ProfileService(getHippocampusBridge() as HippocampusBridge);
}

function resolveDelegationService(): DelegationMemoryService {
  const registered = getMemoryServices().delegation;
  if (
    registered &&
    typeof registered === "object" &&
    "prepareDelegationContext" in registered &&
    "internalizeDelegationResult" in registered
  ) {
    return registered as DelegationMemoryService;
  }
  return new DelegationMemoryService(getHippocampusBridge() as HippocampusBridge);
}

export function memoryRoutes(options: {
  db?: Db;
  hippocampusMode?: HippocampusMode;
  resolveAgentCompanyId?: (agentId: string) => Promise<string | undefined>;
} = {}) {
  const router = Router();
  const hippocampusMode = resolveHippocampusMode(options.hippocampusMode);
  const bridge = resolveBridge();
  const memoryStore = options.db ? memoryStoreService(options.db) : null;
  const memoryReadiness = options.db ? memoryReadinessService(options.db) : null;
  const workingMemory = options.db ? workingMemoryService() : null;

  function ensureEnabled(res: {
    status(code: number): { json(body: unknown): unknown };
  }): boolean {
    if (hippocampusMode !== "setup") return true;
    res.status(503).json({ error: "Hippocampus is disabled" });
    return false;
  }

  async function resolveEventCompanyId(req: Request, agentId: string): Promise<string | undefined> {
    const explicitCompanyId = readCompanyId(req.body?.companyId) ?? readCompanyId(req.query.companyId);
    if (explicitCompanyId) {
      assertCompanyAccess(req, explicitCompanyId);
      return explicitCompanyId;
    }

    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }

    if (req.actor.type === "board" && req.actor.companyIds?.length === 1) {
      return req.actor.companyIds[0];
    }

    if (!options.resolveAgentCompanyId) return undefined;

    const resolvedCompanyId = await options.resolveAgentCompanyId(agentId);
    if (!resolvedCompanyId) return undefined;
    assertCompanyAccess(req, resolvedCompanyId);
    return resolvedCompanyId;
  }

  async function resolveEmbeddingForQuery(agentId: string, query: string): Promise<number[] | null> {
    if (!memoryStore || !workingMemory || !query.trim()) return null;
    try {
      if (!bridge.getEmbedding) {
        return await workingMemory.getCachedEmbedding(agentId);
      }
      const result = await bridge.getEmbedding(query);
      await workingMemory.cacheEmbedding(agentId, result.embedding);
      return result.embedding;
    } catch {
      return await workingMemory.getCachedEmbedding(agentId);
    }
  }

  /** GET /api/agents/:agentId/memory/summary */
  router.get("/agents/:agentId/memory/summary", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (memoryStore) {
        const [totalStatic, totalDynamic, habits, primingState] = await Promise.all([
          memoryStore.countMemories({ agentId: req.params.agentId, memoryType: "static" }),
          memoryStore.countMemories({ agentId: req.params.agentId, memoryType: "dynamic" }),
          memoryStore.getActiveHabits(req.params.agentId),
          memoryStore.getPrimingState(req.params.agentId),
        ]);
        res.json({
          total_static: totalStatic,
          total_dynamic: totalDynamic,
          active_habits: habits.slice(0, 10).map((habit) => ({
            trigger: habit.triggerCondition,
            action: habit.action,
            confidence: habit.confidence,
          })),
          priming_prompt: buildPrimingPrompt(primingState),
          current_state: primingState ?? { ...INITIAL_PRIMING_STATE },
          recent_learnings: Array.isArray((primingState as Record<string, unknown> | null)?.recentEvents)
            ? ((primingState as Record<string, unknown>).recentEvents as string[]).slice(0, 5)
            : [],
          recent_promotions: [],
          generated_at: new Date().toISOString(),
        });
        return;
      }
      const summary = bridge.getSummary
        ? await bridge.getSummary(req.params.agentId)
        : await resolveBridge().getSummary(req.params.agentId);
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
      const { memory_type, container, limit: rawLimit } = req.query;
      const limit = Math.min(Math.max(1, Number(rawLimit) || 50), 100);
      if (memoryStore) {
        const items = await memoryStore.listMemories({
          agentId: req.params.agentId,
          memoryType: typeof memory_type === "string" ? memory_type as "static" | "dynamic" | "working" : undefined,
          container: typeof container === "string" ? container : undefined,
          limit,
        });
        res.json({ items: items.map((item) => toListItem(item as unknown as Record<string, unknown>)), total: items.length });
        return;
      }
      const result = await resolveBridge().listMemories(
        req.params.agentId,
        memory_type as string | undefined,
        container as string | undefined,
        limit,
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
      if (memoryStore) {
        const state = await memoryStore.getPrimingState(req.params.agentId);
        res.json({
          prompt: buildPrimingPrompt(state),
          state: state ?? { ...INITIAL_PRIMING_STATE },
        });
        return;
      }
      const result = await resolveBridge().getPriming(req.params.agentId);
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
      if (memoryStore) {
        const habits = await memoryStore.getActiveHabits(req.params.agentId);
        res.json({
          habits: habits.map((habit) => ({
            trigger: habit.triggerCondition,
            action: habit.action,
            confidence: habit.confidence,
          })),
        });
        return;
      }
      const context = (req.query.context as string) ?? "";
      const result = await resolveBridge().getHabits(req.params.agentId, context);
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
      const { content, container, memory_type } = req.body;
      if (memoryStore) {
        const companyId = await resolveEventCompanyId(req, req.params.agentId);
        if (!companyId) {
          throw new MemoryServiceError("Could not resolve company for memory write", 400, "MEMORY_COMPANY_REQUIRED");
        }
        const embedding = typeof content === "string"
          ? await resolveEmbeddingForQuery(req.params.agentId, content)
          : null;
        const result = await memoryStore.writeMemory({
          companyId,
          agentId: req.params.agentId,
          content: String(content ?? ""),
          embedding,
          memoryType: (memory_type ?? "dynamic") as "static" | "dynamic" | "working",
          container: typeof container === "string" ? container : "default",
          confidence: 0.8,
          visibility: "private",
          sourceType: "manual",
          sourceId: "api_remember",
        });
        res.json({
          id: result.id,
          content: result.content,
          memory_type: result.memoryType,
          confidence: result.confidence,
        });
        return;
      }
      const result = await resolveBridge().remember(
        req.params.agentId,
        content,
        container ?? "default",
        memory_type ?? "dynamic",
      );
      res.json(result);
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** POST /api/agents/:agentId/memory/recall */
  router.post("/agents/:agentId/memory/recall", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const { query, container, top_k } = req.body;
      const topK = Math.min(Math.max(1, Number(top_k) || 10), 100);
      if (memoryStore) {
        const embedding = await resolveEmbeddingForQuery(req.params.agentId, String(query ?? ""));
        const items = embedding
          ? await memoryStore.recall({
            agentId: req.params.agentId,
            embedding,
            topK,
            container: typeof container === "string" ? container : undefined,
          })
          : await memoryStore.recallByDate({
            agentId: req.params.agentId,
            topK,
          });
        res.json({ items: items.map((item) => toRecallItem(item as unknown as Record<string, unknown>)) });
        return;
      }
      const result = await resolveBridge().recall(
        req.params.agentId,
        query,
        container ?? "default",
        topK,
      );
      res.json(result);
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** POST /api/agents/:agentId/memory/extract-meeting */
  router.post("/agents/:agentId/memory/extract-meeting", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const body = MeetingExtractSchema.parse(req.body);
      const hippocampusBridge = resolveBridge();
      const messages = [{ role: "user", content: body.transcript }];
      const container = `meeting:${body.meetingId}`;

      const settled = await Promise.allSettled(
        body.participants.map((participantId) =>
          hippocampusBridge.extract(participantId, messages, container).then((result) => ({
            participantId,
            ...result,
          }))
        ),
      );

      const participants = settled
        .filter((result): result is PromiseFulfilledResult<{
          participantId: string;
          added: number;
          updated: number;
          deleted: number;
        }> => result.status === "fulfilled")
        .map((result) => result.value);

      res.json({
        meetingId: body.meetingId,
        participants,
        failedCount: settled.filter((result) => result.status === "rejected").length,
      });
    } catch (error) {
      handleMemoryError(res, error);
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

  /** GET /api/agents/:agentId/memory/profile */
  router.get("/agents/:agentId/memory/profile", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const params = ProfileQuerySchema.parse(req.query);
      const profile = await resolveProfileService().generateProfile(
        req.params.agentId,
        params.startupId,
        params.role,
      );
      res.json(profile);
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** POST /api/agents/:agentId/memory/delegate */
  router.post("/agents/:agentId/memory/delegate", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const body = DelegateSchema.parse(req.body);
      const result = await resolveDelegationService().prepareDelegationContext(
        req.params.agentId,
        body.toAgentId,
        body.startupId,
        body.taskId,
        body.taskDescription,
        body.topK,
      );
      res.status(result.failedCount > 0 ? 207 : 200).json(result);
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** POST /api/agents/:agentId/memory/internalize-delegation */
  router.post("/agents/:agentId/memory/internalize-delegation", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const body = InternalizeDelegationSchema.parse(req.body);
      const result = await resolveDelegationService().internalizeDelegationResult(
        req.params.agentId,
        body.startupId,
        body.learnings,
        body.quality,
      );
      res.json(result);
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/agents/:agentId/memory/explorer */
  router.get("/agents/:agentId/memory/explorer", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const params = MemoryExplorerQuerySchema.parse(req.query);
      if (memoryStore) {
        const items = await memoryStore.listMemories({
          agentId: req.params.agentId,
          memoryType: params.memory_type as "static" | "dynamic" | "working" | undefined,
          container: params.container,
          limit: params.limit,
        });
        res.json({ items: items.map((item) => toListItem(item as unknown as Record<string, unknown>)), total: items.length });
        return;
      }
      const result = await resolveProjectionService().getMemoryExplorer(
        req.params.agentId,
        params.container,
        params.memory_type,
        params.limit,
      );
      res.json(result);
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/agents/:agentId/memory/promotions */
  router.get("/agents/:agentId/memory/promotions", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      const params = PromotionLogQuerySchema.parse(req.query);
      const events = await resolveProjectionService().getPromotionLog(
        req.params.agentId,
        params.limit,
      );
      res.json(events);
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/companies/:companyId/agents/:agentId/memory */
  router.get("/companies/:companyId/agents/:agentId/memory", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const params = z.object({
        memory_type: z.enum(["static", "dynamic", "working"]).optional(),
        container: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(req.query);
      const items = await memoryStore.listMemories({
        agentId: req.params.agentId,
        memoryType: params.memory_type,
        container: params.container,
        limit: params.limit,
        offset: params.offset,
      });
      res.json({ data: items.map((item) => toListItem(item as unknown as Record<string, unknown>)), total: items.length });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/companies/:companyId/agents/:agentId/memory/recall */
  router.get("/companies/:companyId/agents/:agentId/memory/recall", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const params = z.object({
        query: z.string().min(1),
        topK: z.coerce.number().int().min(1).max(100).default(10),
        container: z.string().optional(),
      }).parse(req.query);
      const embedding = await resolveEmbeddingForQuery(req.params.agentId, params.query);
      const items = embedding
        ? await memoryStore.recall({
          agentId: req.params.agentId,
          embedding,
          topK: params.topK,
          container: params.container,
        })
        : await memoryStore.recallByDate({
          agentId: req.params.agentId,
          topK: params.topK,
        });
      res.json({ data: items.map((item) => toRecallItem(item as unknown as Record<string, unknown>)) });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/companies/:companyId/agents/:agentId/memory/habits */
  router.get("/companies/:companyId/agents/:agentId/memory/habits", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const habits = await memoryStore.getActiveHabits(req.params.agentId);
      res.json({
        data: habits.map((habit) => ({
          id: habit.id,
          triggerCondition: habit.triggerCondition,
          action: habit.action,
          confidence: habit.confidence,
          usageCount: habit.usageCount,
          isActive: habit.isActive,
        })),
      });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/companies/:companyId/agents/:agentId/memory/priming */
  router.get("/companies/:companyId/agents/:agentId/memory/priming", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const state = await memoryStore.getPrimingState(req.params.agentId);
      res.json({ data: state ?? { ...INITIAL_PRIMING_STATE } });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/companies/:companyId/agents/:agentId/memory/versions/:memoryId */
  router.get("/companies/:companyId/agents/:agentId/memory/versions/:memoryId", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const versions = await memoryStore.getVersionHistory(req.params.memoryId);
      res.json({ data: versions.map((item) => toListItem(item as unknown as Record<string, unknown>)) });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** POST /api/companies/:companyId/agents/:agentId/memory */
  router.post("/companies/:companyId/agents/:agentId/memory", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const body = z.object({
        content: z.string().min(1),
        container: z.string().default("default"),
        memoryType: z.enum(["static", "dynamic", "working"]).default("dynamic"),
        visibility: z.enum(["private", "task_scoped", "startup_shared", "board_visible"]).default("private"),
        confidence: z.number().min(0).max(1).optional(),
      }).parse(req.body);
      const embedding = await resolveEmbeddingForQuery(req.params.agentId, body.content);
      const memory = await memoryStore.writeMemory({
        companyId: req.params.companyId,
        agentId: req.params.agentId,
        content: body.content,
        embedding,
        memoryType: body.memoryType,
        container: body.container,
        visibility: body.visibility,
        confidence: body.confidence,
        sourceType: "manual",
        sourceId: "company_memory_route",
      });
      res.status(201).json({ data: toListItem(memory as unknown as Record<string, unknown>) });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** DELETE /api/companies/:companyId/agents/:agentId/memory/:memoryId */
  router.delete("/companies/:companyId/agents/:agentId/memory/:memoryId", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const deleted = await memoryStore.softDelete(req.params.memoryId, "manual");
      res.json({ data: deleted ? toListItem(deleted as unknown as Record<string, unknown>) : null });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/companies/:companyId/memory/operations */
  router.get("/companies/:companyId/memory/operations", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryStore) {
        throw new MemoryServiceError("Memory store unavailable", 503, "MEMORY_STORE_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      const params = z.object({
        agentId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(req.query);
      const operations = await memoryStore.listOperations({
        companyId: req.params.companyId,
        agentId: params.agentId,
        limit: params.limit,
        offset: params.offset,
      });
      res.json({ data: operations, total: operations.length });
    } catch (error) {
      handleMemoryError(res, error);
    }
  });

  /** GET /api/companies/:companyId/memory/health */
  router.get("/companies/:companyId/memory/health", async (req, res) => {
    assertBoard(req);
    if (!ensureEnabled(res)) return;
    try {
      if (!memoryReadiness) {
        throw new MemoryServiceError("Memory readiness unavailable", 503, "MEMORY_READINESS_UNAVAILABLE");
      }
      assertCompanyAccess(req, req.params.companyId);
      res.json({ data: await memoryReadiness.getMemoryHealth() });
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
      const companyId = await resolveEventCompanyId(req, req.params.agentId);
      if (companyId) {
        publishLiveEvent({
          companyId,
          type: "memory:gc",
          payload: {
            agentId: req.params.agentId,
            expired: result.expired,
            decayed: result.decayed,
            demoted: result.demoted,
          },
        });
      }
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
      const companyId = await resolveEventCompanyId(req, req.params.agentId);
      if (companyId) {
        for (const promotion of result.promotions) {
          publishLiveEvent({
            companyId,
            type: "memory:promotion",
            payload: {
              agentId: req.params.agentId,
              memoryId: promotion.memory_id,
              fromTier: promotion.from_tier,
              toTier: promotion.to_tier,
              reason: promotion.reason,
            },
          });
        }
      }
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
