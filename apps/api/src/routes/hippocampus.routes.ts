import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";
import { getArtifacts } from "../orchestration/state.js";
import { listPersistedArtifacts } from "../persistence/artifact-persistence.js";
import { hippocampus } from "../memory/index.js";

export default async function hippocampusRoutes(app: FastifyInstance) {
  app.post("/api/hippocampus/seed", async (request) => {
    const { taskId } = (request.body as { taskId?: string }) ?? {};
    const snapshot = getSnapshot();
    const tasks = taskId ? snapshot.tasks.filter((t) => t.id === taskId) : snapshot.tasks.filter((t) => t.status === "completed");

    let seeded = 0;
    for (const task of tasks) {
      const agent = snapshot.agents.find((a) => a.role === task.assignedRole);
      if (!agent) continue;
      const allArtifacts = getArtifacts().length > 0
        ? getArtifacts()
        : await listPersistedArtifacts(snapshot.company.id);
      const taskArtifacts = task.artifactIds
        .map((id: string) => allArtifacts.find((a: any) => a.id === id))
        .filter(Boolean);
      const outputParts = [
        `Task: ${task.title}`,
        `Role: ${task.assignedRole}`,
        `Kind: ${task.kind}`,
        task.verifierState?.feedback ? `Outcome: ${task.verifierState.feedback}` : null,
        task.executorState?.results?.filter((r: string) => r.startsWith("edited:")).length > 0
          ? `Files edited: ${task.executorState.results.filter((r: string) => r.replace("edited:", "")).join(", ")}`
          : null,
        ...taskArtifacts.map((a: any) => `\n--- Artifact: ${a.title} ---\n${a.content.slice(0, 2000)}`),
      ].filter(Boolean);

      await hippocampus.processTaskCompletion({
        agentId: agent.id,
        taskId: task.id,
        companyId: snapshot.company.id,
        output: outputParts.join("\n"),
        outcome: "success",
      });
      seeded++;
    }
    return { status: "success", seeded, message: `Seeded ${seeded} task completions into hippocampus` };
  });

  app.post("/api/hippocampus/test-extraction", async (request) => {
    const { role, taskTitle, output } = request.body as { role?: string; taskTitle?: string; output?: string };
    const snapshot = getSnapshot();
    const agent = snapshot.agents.find((a) => a.role === (role ?? "developer"));
    if (!agent) return { status: "error", message: `No agent with role ${role ?? "developer"}` };

    const testOutput = output ?? [
      `Task: ${taskTitle ?? "Build responsive landing page"}`,
      `Role: ${role ?? "developer"}`,
      `Kind: implementation`,
      `Status: completed`,
      `Outcome: Developer built responsive landing page with hero section, feature grid, and CTA`,
      `Files edited: src/App.tsx, src/components/Hero.tsx, src/components/Features.tsx, src/styles/landing.css`,
      `Preview: http://localhost:3210`,
      ``,
      `--- Artifact: Technical Plan ---`,
      `Using Vite + React with Tailwind CSS. Mobile-first approach with breakpoints at 640px, 768px, 1024px.`,
      `Component structure: App → Hero → Features → CTA → Footer.`,
      `State managed via React hooks, no external state library needed for this scope.`,
    ].join("\n");

    await hippocampus.processTaskCompletion({
      agentId: agent.id,
      taskId: `test_${crypto.randomUUID()}`,
      companyId: snapshot.company.id,
      output: testOutput,
      outcome: "success",
      taskTitle: taskTitle ?? "Build responsive landing page",
      role: role ?? "developer",
    });

    const ctx = await hippocampus.prepareAgentContext(agent.id, taskTitle ?? "landing page");
    return {
      status: "success",
      message: "Extraction complete",
      stored: {
        memories: ctx.memories.map((m) => ({ type: m.type, content: m.content, source: m.source, confidence: m.confidence })),
        habits: ctx.habits.map((h) => ({ name: h.name, trigger: h.trigger, action: h.action })),
        priming: ctx.priming,
      },
    };
  });

  app.get("/api/hippocampus/context", async (request) => {
    const { agentId, task, role } = request.query as { agentId?: string; task?: string; role?: string };

    let resolvedAgentId = agentId;
    if (!resolvedAgentId && role) {
      const snapshot = getSnapshot();
      const agent = snapshot.agents.find((a) => a.role === role);
      resolvedAgentId = agent?.id;
    }

    if (!resolvedAgentId) {
      return { error: "Provide ?agentId=X or ?role=developer", status: "error" };
    }

    const taskDescription = task ?? "general work";

    try {
      const ctx = await hippocampus.prepareAgentContext(resolvedAgentId, taskDescription);
      return {
        status: "success",
        agentId: resolvedAgentId,
        task: taskDescription,
        memories: ctx.memories.map((m) => ({ id: m.id, content: m.content, type: m.type, confidence: m.confidence })),
        habits: ctx.habits.map((h) => ({ id: h.id, trigger: h.trigger, action: h.action })),
        priming: ctx.priming,
        summary: `${ctx.memories.length} memories, ${ctx.habits.length} habits`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: msg, status: "error" };
    }
  });
}
