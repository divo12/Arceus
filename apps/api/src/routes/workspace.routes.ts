/**
 * @module workspace.routes
 * Routes for workspace management — file listing, snapshots, diffs, sync, export, and persistence health.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { getLocalPreviewState, stopLocalPreview } from "../workspace/preview.js";
import { workspaceManager } from "../workspace/manager.js";
import { getDatabaseHealth } from "@arceus/db";
import { getSupabaseEndpointHealth } from "../persistence/supabase-storage.js";

export default async function workspaceRoutes(app: FastifyInstance) {
  app.get("/api/product/overview", async (request, reply) => {
    const companyId = request.companyId;
    if (!companyId) return reply.code(401).send({ error: "Missing company context" });
    const workspace = await workspaceManager.get(companyId);
    const files = (await workspaceManager.listFiles(companyId)).files;

    return {
      root: workspace?.localPath ?? workspaceManager.getLocalPath(companyId),
      workspace,
      preview: getLocalPreviewState(companyId),
      files,
    };
  });

  app.get("/api/workspace", async (request) => {
    const companyId = request.companyId ?? getActiveCompanyId();
    if (!companyId) {
      return {
        workspace: null,
        snapshots: [],
        preview: getLocalPreviewState(null),
      };
    }

    return {
      workspace: await workspaceManager.getWorkspaceInfo(companyId),
      snapshots: await workspaceManager.listSprintSnapshots(companyId),
      preview: getLocalPreviewState(companyId),
    };
  });

  app.get("/api/workspace/snapshots", async () => {
    const companyId = getActiveCompanyId();
    if (!companyId) return [];
    return workspaceManager.listSprintSnapshots(companyId);
  });

  app.get("/api/workspace/diff", async (request, reply) => {
    const companyId = getActiveCompanyId();
    if (!companyId) {
      reply.code(400);
      return { error: "No company bootstrapped yet." };
    }

    const query = z.object({
      from: z.coerce.number().int().positive(),
      to: z.coerce.number().int().positive(),
    }).parse(request.query);

    return {
      diff: await workspaceManager.getDiff(companyId, query.from, query.to),
    };
  });

  app.post("/api/workspace/sync", async (request, reply) => {
    const companyId = getActiveCompanyId();
    if (!companyId) {
      reply.code(400);
      return { error: "No company bootstrapped yet." };
    }

    // Audit C13 (F-443): `agentRole` is REQUIRED — defaulting to "system" silently
    // attributed every git commit from an automated caller (that forgot to pass role)
    // to a non-existent "system" actor, breaking the audit trail. Now: missing role → 422.
    // taskId/message keep defaults — they're convenience values for manual board sync,
    // not identity-attribution.
    const bodySchema = z.object({
      taskId: z.string().default("manual_sync"),
      agentRole: z.string().min(1, "agentRole is required (use a role name or 'board' / 'system' for manual)"),
      message: z.string().default("Manual workspace sync requested."),
    });
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(422);
      return {
        error: {
          code: "validation_error",
          message: "Invalid workspace sync payload.",
          details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        },
      };
    }
    const body = parsed.data;
    return workspaceManager.commitAndSync(companyId, body.taskId, body.agentRole, body.message);
  });

  app.get("/api/workspace/export", async (request, reply) => {
    const companyId = getActiveCompanyId();
    if (!companyId) {
      reply.code(400);
      return { error: "No company bootstrapped yet." };
    }
    return workspaceManager.exportTarball(companyId);
  });

  app.get("/api/persistence/health", async () => {
    return {
      database: await getDatabaseHealth(),
      supabase: await getSupabaseEndpointHealth(),
    };
  });
}
