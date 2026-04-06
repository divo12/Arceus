import { z } from "zod";
import type { CompanySnapshot, Task } from "@arceus/contracts";
import { structuredCompletion } from "./azure-openai";
import { plannerConfig } from "./config/index";

const followUpAssignedRoleSchema = z.enum(plannerConfig.followUpAssignedRoles);
const graphNodeKindSchema = z.enum(plannerConfig.graphNodeKinds);
const graphStageKeySchema = z.enum(plannerConfig.graphStageKeys);
const deliveryProfileSchema = z.enum(plannerConfig.deliveryProfiles);

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

function createGraphNodeSchema() {
  return z.object({
    id: z.string().min(plannerConfig.limits.graphNodeIdMinLength).max(plannerConfig.limits.graphNodeIdMaxLength).regex(/^[a-z0-9_-]+$/),
    stage_key: graphStageKeySchema.nullable(),
    kind: graphNodeKindSchema,
    assigned_role: followUpAssignedRoleSchema,
    title: z.string(),
    description: z.string(),
    depends_on: z.array(z.string().min(plannerConfig.limits.graphNodeIdMinLength).max(plannerConfig.limits.graphNodeIdMaxLength)).max(plannerConfig.limits.graphNodeDependencyMax),
    success_signal: z.string(),
    required_skill: z.string().nullable(),
    target_surface: z.enum(["browser", "service", "launch", "operations", "strategy"]),
  });
}

export const workflowTaskPlanSchema = z.object({
  delivery_profile: deliveryProfileSchema,
  execution_strategy: z.string(),
  technical_plan: createTaskSpecSchema(),
  acceptance_spec: createTaskSpecSchema(),
  implementation: createTaskSpecSchema(),
  local_preview: createTaskSpecSchema(),
  board_handoff: createTaskSpecSchema(),
  task_graph: z.array(createGraphNodeSchema()).min(plannerConfig.limits.taskGraphMin).max(plannerConfig.limits.taskGraphMax),
  follow_up_tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      problem_statement: z.string(),
      deliverable: z.string(),
      definition_of_done: z.array(z.string()).min(plannerConfig.limits.followUpDefinitionOfDoneMin).max(plannerConfig.limits.followUpDefinitionOfDoneMax),
      priority: z.enum(["critical", "high", "medium", "low"]),
      assigned_role: followUpAssignedRoleSchema,
    })
  ).min(plannerConfig.limits.followUpTaskMin).max(plannerConfig.limits.followUpTaskMax),
});

export type WorkflowTaskPlan = z.infer<typeof workflowTaskPlanSchema>;

export async function generateWorkflowTaskPlan(snapshot: CompanySnapshot): Promise<WorkflowTaskPlan> {
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
          `Available roles: ${snapshot.agents.map((agent) => agent.role).join(", ") || "ceo, cto, pm, developer, tester, ui_designer, marketing, skills_lead"}`,
          "",
          ...plannerConfig.prompts.userInstructions,
        ].join("\n"),
      },
    ],
    workflowTaskPlanSchema,
    "workflow_task_plan",
    { temperature: 0.2 }
  );
}

export function mapTaskPriority(priority: WorkflowTaskPlan["technical_plan"]["priority"]): Task["priority"] {
  return priority;
}