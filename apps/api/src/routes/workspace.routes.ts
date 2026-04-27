/**
 * @module workspace.routes
 * Routes for workspace management — file listing, snapshots, diffs, sync, export, and persistence health.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { getLocalPreviewState, startLocalPreview, stopLocalPreview } from "../workspace/preview.js";
import { workspaceManager } from "../workspace/manager.js";
import { getDatabaseHealth } from "@arceus/db";
import { getSupabaseEndpointHealth } from "../persistence/supabase-storage.js";

export default async function workspaceRoutes(app: FastifyInstance) {
  const productDir = workspaceManager.getLegacyProductDir();

  app.get("/api/product/overview", async () => {
    const companyId = getActiveCompanyId();
    const workspace = companyId ? await workspaceManager.get(companyId) : null;
    const files = companyId ? (await workspaceManager.listFiles(companyId)).files : [];

    return {
      root: workspace?.localPath ?? productDir,
      workspace,
      preview: getLocalPreviewState(),
      files,
    };
  });

  app.get("/api/workspace", async () => {
    const companyId = getActiveCompanyId();
    if (!companyId) {
      return {
        workspace: null,
        snapshots: [],
        preview: getLocalPreviewState(),
      };
    }

    return {
      workspace: await workspaceManager.getWorkspaceInfo(companyId),
      snapshots: await workspaceManager.listSprintSnapshots(companyId),
      preview: getLocalPreviewState(),
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

    const body = z.object({
      taskId: z.string().default("manual_sync"),
      agentRole: z.string().default("system"),
      message: z.string().default("Manual workspace sync requested."),
    }).parse(request.body ?? {});

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
