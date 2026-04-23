import { z } from "zod";
import type { AgentIdentity, CompanySnapshot, Task } from "@arceus/contracts";
import { plannerConfig } from "../config/index.js";

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

/** Generate a structured workflow task plan via LLM, using the CTO session when available.
 * @deprecated Dead code — replaced by plan-task-graph SKILL.md (Spec 23/27).
 * CTO now builds the task DAG in-beat using task_create×N.
 * Delete this function once confidence is high the skill path covers all cases.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function generateWorkflowTaskPlan(_snapshot: CompanySnapshot): Promise<WorkflowTaskPlan> {
  throw new Error("generateWorkflowTaskPlan is retired — use plan-task-graph skill instead");
}

/** Identity mapping from plan priority to task priority. */
export function mapTaskPriority(priority: WorkflowTaskPlan["technical_plan"]["priority"]): Task["priority"] {
  return priority;
}