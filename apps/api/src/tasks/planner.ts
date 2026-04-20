import { z } from "zod";
import type { AgentIdentity, CompanySnapshot, Task } from "@arceus/contracts";
import { getRoleSoul } from "@arceus/company-runtime";
import { structuredCompletion } from "../infra/azure-openai.js";
import { plannerConfig } from "../config/index.js";
import { ensureAgentSession, runPromptText } from "../prompts/llm.js";
import { buildCtoPlanPrompt } from "../prompts/cto-plan.js";
import { agentSessions } from "../orchestration/state.js";

// Static "broad" enum — the full role vocabulary. Used for the exported type
// (type inference is static). At runtime we narrow this to the actual roster so
// the planner cannot schedule work for roles the company has not hired.
const broadAssignedRoleSchema = z.enum(plannerConfig.followUpAssignedRoles);
const graphNodeKindSchema = z.enum(plannerConfig.graphNodeKinds);
const graphStageKeySchema = z.enum(plannerConfig.graphStageKeys);
const deliveryProfileSchema = z.enum(plannerConfig.deliveryProfiles);

type PlannerRole = (typeof plannerConfig.followUpAssignedRoles)[number];

/**
 * Build the `assigned_role` validator from the currently-hired roster. Falls
 * back to the full enum if the roster is empty (defensive — should not happen
 * once a company is bootstrapped).
 */
function buildAssignedRoleSchema(roster: AgentIdentity["role"][]) {
  const allowed = roster.filter((role): role is PlannerRole =>
    (plannerConfig.followUpAssignedRoles as readonly string[]).includes(role)
  );
  if (allowed.length === 0) {
    return broadAssignedRoleSchema;
  }
  return z.enum(allowed as [PlannerRole, ...PlannerRole[]]);
}

function createTaskSpecSchema() {
  return z.object({
    title: z.string(),
    description: z.string(),
    problem_statement: z.string(),
    deliverable: z.string(),
    definition_of_done: z.array(z.string()).min(plannerConfig.limits.definitionOfDoneMin).max(plannerConfig.limits.definitionOfDoneMax),
    priority: z.enum(["critical", "high", "medium", "low"]),
  });
}

function createGraphNodeSchema(assignedRoleSchema: z.ZodEnum<[PlannerRole, ...PlannerRole[]]>) {
  return z.object({
    id: z.string().min(plannerConfig.limits.graphNodeIdMinLength).max(plannerConfig.limits.graphNodeIdMaxLength).regex(/^[a-z0-9_-]+$/),
    stage_key: graphStageKeySchema.nullable(),
    kind: graphNodeKindSchema,
    assigned_role: assignedRoleSchema,
    title: z.string(),
    description: z.string(),
    depends_on: z.array(z.string().min(plannerConfig.limits.graphNodeIdMinLength).max(plannerConfig.limits.graphNodeIdMaxLength)).max(plannerConfig.limits.graphNodeDependencyMax),
    success_signal: z.string(),
    required_skill: z.string().nullable(),
    target_surface: z.enum(["browser", "service", "launch", "operations", "strategy"]),
  });
}

function createWorkflowTaskPlanSchema(assignedRoleSchema: z.ZodEnum<[PlannerRole, ...PlannerRole[]]>) {
  return z.object({
    delivery_profile: deliveryProfileSchema,
    execution_strategy: z.string(),
    technical_plan: createTaskSpecSchema(),
    acceptance_spec: createTaskSpecSchema(),
    implementation: createTaskSpecSchema(),
    local_preview: createTaskSpecSchema(),
    board_handoff: createTaskSpecSchema(),
    task_graph: z.array(createGraphNodeSchema(assignedRoleSchema)).min(plannerConfig.limits.taskGraphMin).max(plannerConfig.limits.taskGraphMax),
    follow_up_tasks: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        problem_statement: z.string(),
        deliverable: z.string(),
        definition_of_done: z.array(z.string()).min(plannerConfig.limits.followUpDefinitionOfDoneMin).max(plannerConfig.limits.followUpDefinitionOfDoneMax),
        priority: z.enum(["critical", "high", "medium", "low"]),
        assigned_role: assignedRoleSchema,
      })
    ).min(plannerConfig.limits.followUpTaskMin).max(plannerConfig.limits.followUpTaskMax),
  });
}

/** Broad schema — used for type inference. Runtime validation uses the narrowed per-company schema. */
export const workflowTaskPlanSchema = createWorkflowTaskPlanSchema(broadAssignedRoleSchema);

export type WorkflowTaskPlan = z.infer<typeof workflowTaskPlanSchema>;

/** Generate a structured workflow task plan via LLM, using the CTO session when available. */
export async function generateWorkflowTaskPlan(snapshot: CompanySnapshot): Promise<WorkflowTaskPlan> {
  const roster = snapshot.agents.map((agent) => agent.role);
  const assignedRoleSchema = buildAssignedRoleSchema(roster);
  const rosterSchema = createWorkflowTaskPlanSchema(assignedRoleSchema);

  // Route through the CTO's existing session if available — Spec 24
  const ctoSession = agentSessions.get("cto");
  if (ctoSession) {
    const ctoSoul = getRoleSoul("cto");
    const prompt = buildCtoPlanPrompt(snapshot);
    const output = await runPromptText(
      "cto",
      ctoSession.sessionId,
      ctoSoul.systemPrompt,
      prompt,
    );

    // Parse structured JSON from the CTO's text response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = rosterSchema.safeParse(JSON.parse(jsonMatch[0]));
      if (parsed.success) return parsed.data as WorkflowTaskPlan;
    }
    // If CTO session output failed to parse, fall through to structuredCompletion
  }

  // Fallback: structuredCompletion when CTO session isn't available (e.g. startup)
  const availableRolesLine = roster.length > 0
    ? roster.join(", ")
    : (plannerConfig.followUpAssignedRoles as readonly string[]).join(", ");

  return structuredCompletion(
    "workerDeployment",
    [
      {
        role: "system",
        content: plannerConfig.prompts.system.join("\n"),
      },
      {
        role: "user",
        content: [
          `Company: ${snapshot.company.name}`,
          `Goal: ${snapshot.company.goal}`,
          `First release: ${snapshot.strategy.firstRelease}`,
          `Strategy summary: ${snapshot.strategy.summary}`,
          `Scope boundaries: ${snapshot.strategy.scopeBoundary.join("; ")}`,
          `Current workspace: ${snapshot.company.name ? "Available at repo-root /workspace" : "Not yet created"}`,
          `Available roles: ${availableRolesLine}`,
          `Hard constraint: every task's assigned_role MUST be one of the Available roles above. Tasks for roles not listed will be rejected by validation.`,
          "",
          ...plannerConfig.prompts.userInstructions,
        ].join("\n"),
      },
    ],
    rosterSchema as unknown as typeof workflowTaskPlanSchema,
    "workflow_task_plan",
    { temperature: 0.2 }
  );
}

/** Identity mapping from plan priority to task priority. */
export function mapTaskPriority(priority: WorkflowTaskPlan["technical_plan"]["priority"]): Task["priority"] {
  return priority;
}