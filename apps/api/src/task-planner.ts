import { z } from "zod";
import type { CompanySnapshot, Task } from "@arceus/contracts";
import { structuredCompletion } from "./azure-openai";

const followUpAssignedRoleSchema = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
const graphNodeKindSchema = z.enum([
  "technical_plan",
  "acceptance_spec",
  "implementation",
  "local_preview",
  "design_direction",
  "qa_verification",
  "service_validation",
  "launch_content",
  "distribution_campaign",
  "skill_authoring",
  "board_handoff",
  "follow_up",
]);
const graphStageKeySchema = z.enum(["technical_plan", "acceptance_spec", "implementation", "local_preview", "board_handoff"]);
const deliveryProfileSchema = z.enum(["browser_app", "service_api"]);

function createTaskSpecSchema() {
  return z.object({
    title: z.string(),
    description: z.string(),
    problem_statement: z.string(),
    deliverable: z.string(),
    definition_of_done: z.array(z.string()).min(2).max(8),
    priority: z.enum(["critical", "high", "medium", "low"]),
  });
}

function createGraphNodeSchema() {
  return z.object({
    id: z.string().min(2).max(40).regex(/^[a-z0-9_-]+$/),
    stage_key: graphStageKeySchema.nullable(),
    kind: graphNodeKindSchema,
    assigned_role: followUpAssignedRoleSchema,
    title: z.string(),
    description: z.string(),
    depends_on: z.array(z.string().min(2).max(40)).max(6),
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
  task_graph: z.array(createGraphNodeSchema()).min(5).max(12),
  follow_up_tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      problem_statement: z.string(),
      deliverable: z.string(),
      definition_of_done: z.array(z.string()).min(1).max(6),
      priority: z.enum(["critical", "high", "medium", "low"]),
      assigned_role: followUpAssignedRoleSchema,
    })
  ).min(3).max(8),
});

export type WorkflowTaskPlan = z.infer<typeof workflowTaskPlanSchema>;

export async function generateWorkflowTaskPlan(snapshot: CompanySnapshot): Promise<WorkflowTaskPlan> {
  return structuredCompletion(
    "workerDeployment",
    [
      {
        role: "system",
        content: [
          "You are the workflow planner for Arceus.",
          "Generate task content for the current delivery pipeline plus a typed planning graph.",
          "The current execution engine still has fixed core stages: technical_plan, acceptance_spec, implementation, local_preview, board_handoff.",
          "You must also classify the work as either browser_app or service_api.",
          "Emit a task_graph that includes the five core stages and any justified specialist nodes for tester, ui_designer, marketing, or skills_lead.",
          "Use stage_key only for the five core stages. Specialist nodes must set stage_key to null.",
          "You must also propose 3 to 8 smaller follow-up tasks that break the work into narrow, visible chunks.",
          "Keep tasks narrow, spec-driven, and suitable for execution in a local workspace.",
          "Prefer smaller implementation slices over one large build task.",
          "At least one follow-up task should focus on getting a runnable app online quickly, and at least one should focus on preview validation or smoke testing.",
          "Follow-up tasks may be assigned to tester, ui_designer, marketing, or skills_lead when specialist work is justified.",
          "For browser_app, bias toward browser preview readiness, UX/design tasks, and QA verification.",
          "For service_api, bias toward request/health validation, service verification, and API-specific testing instead of a generic UI preview.",
          "execution_strategy should summarize the dependency order and where specialist roles add leverage.",
          "Each task_graph node should include a success_signal and, when relevant, a required_skill.",
        ].join("\n"),
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
          "Produce high-quality task descriptions.",
          "implementation must focus on building the actual local app in workspace/.",
          "local_preview must ensure the workspace app or service is actually launched locally and validated.",
          "The follow-up tasks should decompose implementation into the smallest meaningful slices that the board can inspect.",
          "Bias toward getting a minimal local preview working early, then iterating while keeping that preview runnable.",
          "board_handoff must describe the final review package that stops autonomous execution and returns control to the board.",
          "The task_graph should show dependency-aware sequencing and specialist involvement even if the current executor still uses the fixed core stage chain.",
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