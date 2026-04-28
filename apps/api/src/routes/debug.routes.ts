/**
 * @module debug.routes
 * Routes for debugging — execution flow, sprint graph inspection, and graph SSE stream.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { getExecutionStatus, getTransitions, getFeedbackRounds } from "../orchestration/state.js";
import { graphStore } from "../observability/graph-store.js";

export default async function debugRoutes(app: FastifyInstance) {
  app.get("/api/execution-flow", async () => {
    const companyId = getActiveCompanyId();
    const tasks = companyId ? await tasksRepo.listByCompanyHydrated(getDb(), companyId) : [];
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        status: t.status,
        assignedRole: t.assignedRole,
        priority: t.priority,
        iterationCount: t.iterationCount ?? 0,
        maxIterations: t.maxIterations ?? 3,
        dependsOnTaskIds: t.dependsOnTaskIds,
        childTaskIds: t.childTaskIds,
      })),
      transitions: getTransitions().slice(-50),
      feedbackRounds: getFeedbackRounds(),
      executionStatus: getExecutionStatus(),
    };
  });

  app.get("/api/debug/graph", async () => {
    return { sprints: graphStore.listSprints() };
  });

  app.get("/api/debug/graph/:sprintId", async (request, reply) => {
    const { sprintId } = request.params as { sprintId: string };
    const graph = graphStore.getGraph(sprintId);
    if (!graph) {
      reply.code(404);
      return { error: "Sprint graph not found" };
    }
    return graph;
  });

  app.get("/api/debug/graph/:sprintId/node/:nodeId", async (request, reply) => {
    const { sprintId, nodeId } = request.params as { sprintId: string; nodeId: string };
    const node = graphStore.getNode(sprintId, nodeId);
    if (!node) {
      reply.code(404);
      return { error: "Node not found" };
    }
    return node;
  });

  app.get("/api/debug/graph/stream", async (request, reply) => {
    const sprintIdFilter = (request.query as Record<string, string>).sprintId ?? null;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*");
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    reply.raw.flushHeaders?.();

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`event: ping\ndata: {}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 10000);

    const unsubscribe = graphStore.subscribe((event) => {
      if (sprintIdFilter && "sprintId" in event && event.sprintId !== sprintIdFilter) {
        return;
      }
      try {
        reply.raw.write(`event: graph\ndata: ${JSON.stringify(event)}\n\n`);
      // eslint-disable-next-line no-restricted-syntax -- intentional: optional debug-route probe; missing context is the expected case.
      } catch {
        /* stream broken */
      }
    });

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
