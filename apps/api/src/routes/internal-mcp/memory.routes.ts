/**
 * §6 Memory tool routes — spec 27 §6.
 *
 * Three LLM-facing tools, all on the `all` role allowlist:
 *   - POST /api/internal/v1/memory/search       → memory_search
 *   - POST /api/internal/v1/memory/learnings    → memory_add_learning
 *   - POST /api/internal/v1/memory/handoff      → memory_handoff
 *
 * Backed by @arceus/hippocampus. No LLM in retrieval hot path.
 *
 * Retry policy for transient errors (embed_failed / store_unavailable):
 *   Server-side, 2 retries with exponential backoff (250ms, 750ms). Agents
 *   see only a final terminal outcome — no user-space retry loops.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  memorySearchInputSchema,
  memoryAddLearningInputSchema,
  memoryHandoffInputSchema,
  type MemorySearchData,
  type MemorySearchHit,
  type MemoryAddLearningData,
  type MemoryHandoffData,
  type MemoryUnit,
} from "@arceus/contracts";
import type { AgentIdentity } from "@arceus/contracts";
import { hippocampus } from "../../memory/index.js";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { addArtifact } from "../../tasks/index.js";
import { emitEmployeeActivity } from "../../observability/activity.js";
import { success, failure, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

type Role = AgentIdentity["role"];

const MEMORY_BASE = "/api/internal/v1/memory";

const MAX_HANDOFF_BYTES = 10_240; // 10 KB serialized payload cap

const sendValidation = (reply: FastifyReply, _err: ZodError): void => {
  reply.code(422).send(
    failure("Request validation failed.", "validation", "never", "payload_fixed"),
  );
};

/**
 * Retry a transient operation up to 2 times with 250ms / 750ms backoff.
 * Only retries if `isTransient(err)` returns true. Third failure surfaces.
 */
async function withTransientRetry<T>(
  fn: () => Promise<T>,
  isTransient: (err: unknown) => boolean,
): Promise<T> {
  const delays = [0, 250, 750];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
    }
  }
  throw lastErr;
}

function isEmbedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /embed|huggingface|transformers|onnx/i.test(msg);
}

function isStoreError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /pgvector|econn|etimedout|connection|database/i.test(msg);
}

export default async function internalMcpMemoryRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /memory/search — semantic query over role memory ───────────
  app.post(`${MEMORY_BASE}/search`, async (req, reply) => {
    const parsed = memorySearchInputSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidation(reply, parsed.error);
      return;
    }

    const mcp = req.mcp!;
    // Spec 31 Phase 7.B.5 — read agent from canonical via repo, not snapshot.
    const agent = await agentsRepo.findAgentByRole(getDb(), mcp.companyId, mcp.role as Role);
    if (!agent) {
      reply.code(404).send(
        failure(
          `No agent provisioned for role '${mcp.role}'.`,
          "not_found",
          "never",
          "agent_provisioned",
        ),
      );
      return;
    }

    const input = parsed.data;
    let result: Awaited<ReturnType<typeof hippocampus.search>>;
    try {
      result = await withTransientRetry(
        () => hippocampus.search(agent.id, input.query, {
          scope: input.scope,
          kind: input.kind,
          limit: input.limit,
          since: input.since,
        }),
        (err) => isEmbedError(err) || isStoreError(err),
      );
    } catch (err) {
      const cause: ErrorCause = isEmbedError(err)
        ? "embed_failed"
        : isStoreError(err)
          ? "store_unavailable"
          : "internal";
      reply.code(cause === "embed_failed" || cause === "store_unavailable" ? 503 : 500).send(
        failure(
          `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
          cause,
          "safe",
          "retry_succeeded",
        ),
      );
      return;
    }

    // Spec 31 Phase 7.C.a — pre-fetch the company's agents once so the
    // sourceAgentRole lookup in the map is O(1) instead of N+1 repo hits.
    const allAgents = await agentsRepo.listAgentsByCompany(getDb(), mcp.companyId);
    const agentRoleById = new Map(allAgents.map((a) => [a.id, a.role]));

    const memories: MemorySearchHit[] = result.memories.map((m) => ({
      id: m.id,
      content: m.content,
      kind: m.type === "static" ? "static" : "dynamic",
      confidence: m.finalScore,
      recordedAt: m.createdAt,
      sourceTaskId: m.sourceTaskId,
      sourceAgentRole: (agentRoleById.get(m.agentId) ?? mcp.role) as Role,
    }));

    const data: MemorySearchData = {
      memories,
      queryEmbeddingMs: result.queryEmbeddingMs,
      totalSearched: result.totalSearched,
    };

    const body = success(`Found ${memories.length} memories.`, data);
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    reply.code(200).send(body);
  });

  // ─── POST /memory/learnings — explicit write of a fact/pattern ───────
  app.post(`${MEMORY_BASE}/learnings`, async (req, reply) => {
    const parsed = memoryAddLearningInputSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidation(reply, parsed.error);
      return;
    }

    const mcp = req.mcp!;
    const agent = await agentsRepo.findAgentByRole(getDb(), mcp.companyId, mcp.role as Role);
    if (!agent) {
      reply.code(404).send(
        failure(
          `No agent provisioned for role '${mcp.role}'.`,
          "not_found",
          "never",
          "agent_provisioned",
        ),
      );
      return;
    }

    const input = parsed.data;
    const now = new Date().toISOString();
    const expiresAt = input.kind === "dynamic" && input.expiryDays
      ? new Date(Date.now() + input.expiryDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // procedural facts share the dynamic store + a tag so the retrieval path
    // still finds them when the agent searches; habits are a separate tier
    // (procedural store) and not written via this tool.
    const unit: MemoryUnit = {
      id: `memory_${crypto.randomUUID()}`,
      companyId: mcp.companyId,
      agentId: agent.id,
      sourceTaskId: input.sourceTaskId ?? null,
      sourceArtifactId: null,
      type: input.kind === "procedural" ? "dynamic" : input.kind,
      visibility: "team",
      source: "system",
      content: input.content,
      summary: input.content.slice(0, 200),
      confidence: input.confidence,
      tags: ["explicit", ...input.tags, ...(input.kind === "procedural" ? ["procedural"] : [])],
      createdAt: now,
      expiresAt,
    };

    let result: Awaited<ReturnType<typeof hippocampus.addMemory>>;
    try {
      result = await withTransientRetry(
        () => hippocampus.addMemory(unit),
        (err) => isEmbedError(err) || isStoreError(err),
      );
    } catch (err) {
      const cause: ErrorCause = isEmbedError(err)
        ? "embed_failed"
        : isStoreError(err)
          ? "store_unavailable"
          : "internal";
      reply.code(cause === "embed_failed" || cause === "store_unavailable" ? 503 : 500).send(
        failure(
          `Memory add failed: ${err instanceof Error ? err.message : String(err)}`,
          cause,
          "safe",
          "retry_succeeded",
        ),
      );
      return;
    }

    emitEmployeeActivity(
      mcp.role as Role,
      "info",
      `Added learning (${result.action}): ${input.content.slice(0, 120)}${input.content.length > 120 ? "…" : ""}`,
    );

    const data: MemoryAddLearningData = {
      memoryId: result.memoryId,
      action: result.action,
      reason: result.reason,
      targetId: result.targetId,
    };

    const body = success(`Learning recorded (${result.action}).`, data);
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    reply.code(200).send(body);
  });

  // ─── POST /memory/handoff — route typed facts to other roles ─────────
  app.post(`${MEMORY_BASE}/handoff`, async (req, reply) => {
    // Size guard before Zod — prevent DoS on huge bodies
    const bodyBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
    if (bodyBytes > MAX_HANDOFF_BYTES) {
      reply.code(413).send(
        failure(
          `Handoff payload exceeds ${MAX_HANDOFF_BYTES} bytes.`,
          "handoff_too_large",
          "never",
          "payload_shrunk",
        ),
      );
      return;
    }

    const parsed = memoryHandoffInputSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidation(reply, parsed.error);
      return;
    }

    const mcp = req.mcp!;
    const callerRole = mcp.role as Role;
    const input = parsed.data;

    // Self-handoff rejection (targets is validated as Role[] already)
    if (input.targets.includes(callerRole)) {
      reply.code(422).send(
        failure(
          "Cannot hand off to yourself.",
          "self_target_not_allowed",
          "never",
          "targets_excludes_caller",
        ),
      );
      return;
    }

    // Spec 31 Phase 7.B.5 — agents from canonical. Run target lookups in
    // parallel; ids are independent and the list is small (≤8 in practice).
    const db = getDb();
    const targetAgents = await Promise.all(
      input.targets.map(async (role) => ({
        role,
        agent: await agentsRepo.findAgentByRole(db, mcp.companyId, role),
      })),
    );
    const missing = targetAgents.filter((t) => !t.agent);
    if (missing.length > 0) {
      reply.code(422).send(
        failure(
          `No agent provisioned for role(s): ${missing.map((m) => m.role).join(", ")}.`,
          "target_role_unknown",
          "never",
          "targets_all_provisioned",
        ),
      );
      return;
    }

    // Audit artifact (created first so memory units can reference it)
    const callerAgent = await agentsRepo.findAgentByRole(db, mcp.companyId, callerRole);
    const artifact = addArtifact(
      callerAgent?.id ?? `agent_${callerRole}`,
      "handoff",
      `Handoff from ${callerRole} to ${input.targets.join(", ")} (${input.kind})`,
      JSON.stringify(
        {
          fromRole: callerRole,
          targets: input.targets,
          kind: input.kind,
          urgency: input.urgency,
          content: input.content,
          relatedArtifactIds: input.relatedArtifactIds,
        },
        null,
        2,
      ),
    );

    // Write one memory unit per target. Skip dedup — handoffs are explicit
    // deliveries, not drift candidates.
    const now = new Date().toISOString();
    const handoffId = `handoff_${crypto.randomUUID()}`;
    const memoryIds: string[] = [];

    for (const { role: targetRole, agent: targetAgent } of targetAgents) {
      if (!targetAgent) continue;
      const unit: MemoryUnit = {
        id: `memory_${crypto.randomUUID()}`,
        companyId: mcp.companyId,
        agentId: targetAgent.id,
        sourceTaskId: null,
        sourceArtifactId: artifact.id,
        type: "delegation",
        visibility: "team",
        source: "delegation",
        content: input.content,
        summary: input.content.slice(0, 200),
        confidence: 0.9,
        tags: [
          "handoff",
          `from:${callerRole}`,
          `kind:${input.kind}`,
          `urgency:${input.urgency}`,
          `handoffId:${handoffId}`,
          ...input.relatedArtifactIds.map((id) => `artifact:${id}`),
        ],
        createdAt: now,
        expiresAt: null,
      };
      try {
        await withTransientRetry(
          () => hippocampus.addMemory(unit, { skipDedup: true }),
          (err) => isStoreError(err),
        );
        memoryIds.push(unit.id);
      } catch (err) {
        const cause: ErrorCause = isStoreError(err) ? "store_unavailable" : "internal";
        reply.code(cause === "store_unavailable" ? 503 : 500).send(
          failure(
            `Handoff write to '${targetRole}' failed: ${err instanceof Error ? err.message : String(err)}`,
            cause,
            "safe",
            "retry_succeeded",
          ),
        );
        return;
      }
      emitEmployeeActivity(
        targetRole,
        "info",
        `Incoming handoff from ${callerRole} (${input.kind}, ${input.urgency}): ${input.content.slice(0, 120)}${input.content.length > 120 ? "…" : ""}`,
      );
    }

    const data: MemoryHandoffData = {
      handoffId,
      handoffArtifactId: artifact.id,
      targetsNotified: input.targets,
      memoryIdsWritten: memoryIds,
    };

    const body = success(`Handoff delivered to ${input.targets.length} role(s).`, data);
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    reply.code(200).send(body);
  });
}
