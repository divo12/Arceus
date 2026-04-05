import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { getEvents, getSnapshot, bootstrapCompany, deriveCompanyNameFromIdea, resetCompany, applyStrategy } from "./store";
import { getRuntimeStatus } from "./runtime";
import { sendBoardMessageToCeo, streamBoardMessageToCeo } from "./chat";
import { approveBoardReview, beginExecution, getAgentSessions, getArtifacts, getExecutionStatus, resetOrchestratorState, stopExecution } from "./orchestrator";
import { getEmployeeActivityLog, resetEmployeeActivityLog, streamEmployeeActivity } from "./activity";
import { strategyOutputSchema, generateStrategy } from "./ceo";
import { getLocalPreviewState } from "./preview";

const app = Fastify({ logger: true });
const workspaceRoot = resolve(process.cwd(), "..", "..");
const productDir = resolve(workspaceRoot, "workspace");

const bootstrapSchema = z.object({
  companyName: z.string().min(2),
  boardOwner: z.string().min(2),
  idea: z.string().min(10),
  budgetCents: z.number().int().nonnegative()
});

const chatSchema = z.object({
  message: z.string().min(1)
});

async function resetProductWorkspace() {
  const warnings: string[] = [];
  await mkdir(productDir, { recursive: true });
  const entries = await readdir(productDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.name !== ".gitkeep")
      .map(async (entry) => {
        try {
          await rm(resolve(productDir, entry.name), { recursive: true, force: true });
        } catch (error) {
          warnings.push(
            `Could not remove workspace/${entry.name}: ${error instanceof Error ? error.message : "Unknown filesystem error"}`
          );
        }
      })
  );

  try {
    await writeFile(resolve(productDir, ".gitkeep"), "", { flag: "a" });
  } catch (error) {
    warnings.push(`Could not refresh workspace/.gitkeep: ${error instanceof Error ? error.message : "Unknown filesystem error"}`);
  }

  try {
    await rm(resolve(workspaceRoot, "apps", "api", "workspace"), { recursive: true, force: true });
  } catch (error) {
    warnings.push(`Could not remove apps/api/workspace: ${error instanceof Error ? error.message : "Unknown filesystem error"}`);
  }

  return warnings;
}

async function listProductFiles(dir = productDir, base = productDir): Promise<Array<{ path: string; modifiedAt: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ path: string; modifiedAt: string }> = [];

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listProductFiles(fullPath, base));
      continue;
    }

    const info = await stat(fullPath);
    if (entry.name === ".gitkeep") {
      continue;
    }
    results.push({
      path: fullPath.replace(`${base}\\`, "").replace(/\\/g, "/"),
      modifiedAt: info.mtime.toISOString(),
    });
  }

  return results.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function getEmployeeDirectory() {
  const snapshot = getSnapshot();
  return snapshot.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    profile: agent.profile,
    memory: snapshot.memories.find((memory) => memory.agentId === agent.id) ?? null,
    session: snapshot.sessions.find((session) => session.agentId === agent.id) ?? null,
  }));
}

await app.register(cors, {
  origin: true
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "arceus-api"
  };
});

app.get("/api/company", async () => {
  return getSnapshot();
});

app.get("/api/runtime", async () => {
  return getRuntimeStatus();
});

app.post("/api/company/bootstrap", async (request, reply) => {
  const body = bootstrapSchema.parse(request.body);
  const snapshot = bootstrapCompany(body);
  reply.code(201);
  return snapshot;
});

app.post("/api/company/strategy", async (request, reply) => {
  try {
    return await sendBoardMessageToCeo(getSnapshot().company.goal || "Refine the current idea into a demoable first release.");
  } catch (error) {
    request.log?.error?.(error);
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : "Unknown strategy generation failure"
    };
  }
});

app.post("/api/chat/ceo", async (request, reply) => {
  try {
    const body = chatSchema.parse(request.body);
    return await sendBoardMessageToCeo(body.message);
  } catch (error) {
    request.log?.error?.(error);
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : "Unknown CEO chat failure"
    };
  }
});

app.get("/api/chat/ceo/stream", async (request, reply) => {
  try {
    const query = z
      .object({
        message: z.string().min(1)
      })
      .parse(request.query);

    await streamBoardMessageToCeo(reply, query.message);
    return reply;
  } catch (error) {
    request.log?.error?.(error);
    if (!reply.raw.headersSent && !reply.sent) {
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Unknown CEO stream failure"
      };
    }
    // Headers already sent — SSE is in progress, so just end the stream
    try { reply.raw.end(); } catch { /* already ended */ }
    return reply;
  }
});

app.delete("/api/company", async (request, reply) => {
  try {
    const warnings = await resetProductWorkspace();
    if (warnings.length > 0) {
      request.log?.warn({ warnings }, "Reset completed with filesystem cleanup warnings");
    }

    resetEmployeeActivityLog();
    resetOrchestratorState();
    return resetCompany();
  } catch (error) {
    request.log?.error?.(error);
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : "Reset failed."
    };
  }
});

app.get("/api/events", async (_request, reply) => {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");

  for (const event of getEvents()) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  reply.raw.end();
});

// ── Orchestrator, meetings, and employee activity routes ──

app.post("/api/strategy/approve", async (request, reply) => {
  try {
    const body = strategyOutputSchema.parse(request.body);
    const snapshot = applyStrategy(body);
    return snapshot;
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Invalid strategy payload"
    };
  }
});

app.post("/api/strategy/execute", async (request, reply) => {
  try {
    const body = strategyOutputSchema.parse(request.body);
    const snapshot = applyStrategy(body);

    beginExecution(snapshot).catch((err) => {
      request.log?.error?.(err);
    });

    return { snapshot, status: "execution_started" };
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Invalid strategy payload"
    };
  }
});

app.get("/api/orchestrator/status", async () => {
  return {
    executionStatus: getExecutionStatus(),
    agentSessions: getAgentSessions(),
    localPreview: getLocalPreviewState(),
  };
});

app.get("/api/tasks", async () => {
  return getSnapshot().tasks;
});

app.get("/api/meetings", async () => {
  return getSnapshot().meetings;
});

app.get("/api/employees", async () => {
  return getEmployeeDirectory();
});

app.get("/api/employee-memories", async () => {
  return getEmployeeDirectory().map((employee) => ({
    id: employee.id,
    name: employee.name,
    role: employee.role,
    title: employee.title,
    memory: employee.memory,
  }));
});

app.get("/api/product/overview", async () => {
  return {
    root: productDir,
    preview: getLocalPreviewState(),
    files: await listProductFiles(),
  };
});

app.get("/api/artifacts", async () => {
  return getArtifacts();
});

app.get("/api/artifacts/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const artifact = getArtifacts().find((a) => a.id === id);
  if (!artifact) {
    reply.code(404);
    return { error: "Artifact not found" };
  }
  return artifact;
});

app.post("/api/orchestrator/execute", async (request, reply) => {
  const snapshot = getSnapshot();
  if (snapshot.company.id === "company_pending") {
    reply.code(400);
    return { error: "No company bootstrapped yet." };
  }
  if (snapshot.agents.length === 0) {
    reply.code(400);
    return { error: "No agents available. Generate a strategy first." };
  }

  // Fire and forget — execution runs in the background
  beginExecution(snapshot).catch((err) => {
    request.log?.error?.(err);
  });

  return { status: "execution_started" };
});

app.post("/api/orchestrator/stop", async (request, reply) => {
  try {
    return await stopExecution();
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Execution stop failed.",
    };
  }
});

app.post("/api/board-review/approve", async (request, reply) => {
  try {
    return approveBoardReview();
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Board review approval failed.",
    };
  }
});

app.get("/api/employee-activity", async () => {
  return getEmployeeActivityLog();
});

app.get("/api/employee-activity/stream", async (request, reply) => {
  streamEmployeeActivity(reply);
  return reply;
});

app.get("/api/activity", async () => {
  return getEmployeeActivityLog();
});

app.get("/api/activity/stream", async (request, reply) => {
  streamEmployeeActivity(reply);
  return reply;
});

// ── Quick execute: bootstrap → strategy → apply → execute ──

const quickExecuteSchema = z.object({
  idea: z.string().min(5),
});

app.post("/api/quick-execute", async (request, reply) => {
  try {
    const { idea } = quickExecuteSchema.parse(request.body);

    // 1. Bootstrap
    let snapshot = getSnapshot();
    if (snapshot.company.id === "company_pending") {
      snapshot = bootstrapCompany({
        companyName: deriveCompanyNameFromIdea(idea),
        boardOwner: "Board",
        idea,
        budgetCents: 0,
      });
    }

    // 2. Generate strategy (structured output — no CEO chat)
    const strategy = await generateStrategy(snapshot);

    // 3. Apply strategy → builds hierarchy + agents
    snapshot = applyStrategy(strategy);

    // 4. Fire execution (CTO plans → developer builds)
    beginExecution(snapshot).catch((err) => {
      request.log?.error?.(err);
    });

    return { snapshot, strategy, status: "execution_started" };
  } catch (error) {
    request.log?.error?.(error);
    reply.code(400);
    return {
      error: error instanceof Error ? error.message : "Quick execute failed.",
    };
  }
});

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
