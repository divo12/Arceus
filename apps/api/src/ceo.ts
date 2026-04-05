import { z } from "zod";
import type { CompanySnapshot } from "@arceus/contracts";
import { getRoleSoul } from "@arceus/company-runtime";
import { structuredCompletion } from "./azure-openai";

const strategyRoleSchema = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
const coreStrategyRoles = ["ceo", "cto", "pm", "developer"] as const;
const ceoMeetingTypeSchema = z.enum(["ad_hoc", "sync", "escalation"]);
const ceoTaskDeltaSchema = z.object({
  action: z.enum(["create", "reprioritize", "reassign", "cancel"]),
  title: z.string(),
  details: z.string(),
  assigned_role: strategyRoleSchema,
  priority: z.enum(["critical", "high", "medium", "low"]),
  target_task_hint: z.string().nullable(),
});
const ceoMeetingIntentSchema = z.object({
  create: z.boolean(),
  type: ceoMeetingTypeSchema.nullable(),
  summary: z.string(),
  rationale: z.string(),
  task_deltas: z.array(ceoTaskDeltaSchema).max(4),
}).superRefine((value, ctx) => {
  if (value.create && value.type === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Meeting type is required when create is true.",
    });
  }

  if (!value.create && value.task_deltas.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_deltas"],
      message: "Task deltas must be empty when create is false.",
    });
  }
});

function validateStrategyRoles(
  roles: Array<{ role: string; parent_role: string | null }>,
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();

  roles.forEach((entry, index) => {
    if (seen.has(entry.role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "role"],
        message: `Duplicate role is not allowed: ${entry.role}`,
      });
      return;
    }
    seen.add(entry.role);

    if (entry.role === "ceo" && entry.parent_role !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "parent_role"],
        message: "CEO must have a null parent_role.",
      });
    }

    if (entry.role !== "ceo" && entry.parent_role === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "parent_role"],
        message: `${entry.role} must report to a manager.`,
      });
    }
  });

  coreStrategyRoles.forEach((role) => {
    if (!seen.has(role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Strategy output must include the core role: ${role}`,
      });
    }
  });
}

// ── Zod schema (single source of truth) ──────────────────
// The JSON Schema sent to Azure OpenAI is derived from this
// automatically by structuredCompletion via zod-to-json-schema.
// No hand-written JSON schema. No "return JSON" prompt hacking.

export const strategyOutputSchema = z.object({
  strategy_title: z.string(),
  summary: z.string(),
  first_release: z.string(),
  scope_boundary: z.array(z.string()),
  role_rationale: z.array(z.string()),
  roles: z.array(
    z.object({
      role: strategyRoleSchema,
      title: z.string(),
      parent_role: strategyRoleSchema.nullable(),
      capabilities: z.array(z.string())
    })
  ).min(4).max(8).superRefine(validateStrategyRoles)
});

export type StrategyOutput = z.infer<typeof strategyOutputSchema>;

// ── LLM-driven card classification schema ────────────────
// The CEO's free-text response gets classified into a card
// type by a second structured output call. The LLM picks the
// card type and fills the relevant structured fields.
//
// With strict: true all fields must be present. Fields that
// don't apply to the selected card_type will be empty/default.

const roleSchema = z.object({
  role: strategyRoleSchema,
  title: z.string(),
  parent_role: strategyRoleSchema.nullable(),
  capabilities: z.array(z.string()),
});

export const ceoCardSchema = z.object({
  card_type: z.enum(["strategy_proposal", "clarifying_question", "status_update"]),
  title: z.string(),
  summary: z.string(),
  strategy: z
    .object({
      first_release: z.string(),
      scope_boundary: z.array(z.string()),
      role_rationale: z.array(z.string()),
      roles: z.array(roleSchema).min(4).max(8).superRefine(validateStrategyRoles),
    })
    .nullable(),
  question: z
    .object({
      prompt: z.string(),
      options: z.array(z.string()),
    })
    .nullable(),
  meeting: ceoMeetingIntentSchema,
});

export type CeoCard = z.infer<typeof ceoCardSchema>;

// ── Classify a CEO free-text response into a card ────────

export async function classifyCeoResponse(
  ceoText: string,
  snapshot: CompanySnapshot,
): Promise<CeoCard> {
  const systemPrompt = [
    "You are the CEO's structured output classifier.",
    "Given the CEO's free-text message and the company state, classify the response into one card type and fill its structured data.",
    "",
    "Card types:",
    "- strategy_proposal: The CEO is proposing a strategy, scope, team, or first release. Fill the strategy block with concrete data.",
    "- clarifying_question: The CEO is asking the board a question to narrow scope. Fill the question block.",
    "- status_update: The CEO is giving an update or acknowledgment. Only title + summary matter.",
    "",
    "Rules:",
    "- Pick exactly ONE card_type.",
    "- Return a top-level object with title, summary, strategy, question, and meeting.",
    "- If strategy does not apply, set strategy to null.",
    "- If question does not apply, set question to null.",
    "- The meeting block determines whether this CEO response should create a durable meeting and typed task deltas.",
    "- For strategy_proposal: roles must contain the four core entries ceo, cto, pm, and developer exactly once.",
    "- You may also add tester, ui_designer, marketing, and skills_lead when they materially improve delivery quality, launch readiness, or reusable operational leverage.",
    "- No duplicate roles. ceo has parent_role null. Every other role must have a valid parent_role.",
    "- Prefer this reporting shape unless there is a strong reason not to: ceo manages cto and marketing; cto manages pm, developer, tester, ui_designer, and skills_lead; pm may manage developer, tester, or ui_designer when product coordination is the point.",
    "- For strategy_proposal: set meeting.create to true, use type ad_hoc, and propose up to 4 typed task_deltas when the strategy clearly implies backlog changes. Prefer action=create unless an existing task is obviously being changed.",
    "- For clarifying_question: create a meeting when the question changes strategy, scope, ownership, or highlights a blocker. Use ad_hoc for planning questions and escalation for blockers.",
    "- For status_update: only create a meeting when the update carries a blocker, material decision, or reprioritization. Routine updates should keep meeting.create false.",
    "- task_deltas must be concrete, action-oriented, and assigned to a real role. Use target_task_hint only when referring to an existing task by title, kind, or purpose.",
    "- For clarifying_question: options should have 2-5 concrete choices.",
    "- For status_update: summary should capture the key info.",
  ].join("\n");

  const userPrompt = [
    "## Company state",
    `Name: ${snapshot.company.name}`,
    `Goal: ${snapshot.company.goal}`,
    `Idea: ${snapshot.idea.coreIdea}`,
    `Direction: ${snapshot.idea.currentDirection || "Not refined yet"}`,
    `Status: ${snapshot.company.status}`,
    `Has agents: ${snapshot.agents.length > 0 ? "yes" : "no"}`,
    "",
    "## CEO's message to classify",
    ceoText,
  ].join("\n");

  return structuredCompletion(
    "ceoDeployment",
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    ceoCardSchema,
    "ceo_card",
    { temperature: 0.3 },
  );
}

// ── Strategy generation via structured output ────────────

export async function generateStrategy(snapshot: CompanySnapshot): Promise<StrategyOutput> {
  const ceoSoul = getRoleSoul("ceo");

  const userPrompt = [
    `Company name: ${snapshot.company.name}`,
    `Board goal: ${snapshot.company.goal}`,
    `Core idea: ${snapshot.idea.coreIdea}`,
    `Current direction: ${snapshot.idea.currentDirection || "Not yet refined"}`,
    `Budget cents: ${snapshot.company.budgetCents}`,
    "",
    "Produce a narrow strategy for a demoable first release.",
    "Propose a hierarchy with the four core roles: one ceo, one cto, one pm, and one developer.",
    "You may add any of these specialist roles if they are justified for the first release: tester, ui_designer, marketing, skills_lead.",
    "Use the smallest org that can still ship the first release with quality, launch readiness, and reusable operating leverage.",
    "No duplicate roles.",
    "Each role must have a parent_role except the ceo (which must be null).",
    "Preferred hierarchy: ceo manages cto and marketing. cto manages pm, developer, tester, ui_designer, and skills_lead. pm may manage developer, tester, or ui_designer when useful for delivery control.",
  ].join("\n");

  return structuredCompletion(
    "ceoDeployment",
    [
      { role: "system", content: ceoSoul.systemPrompt },
      { role: "user", content: userPrompt },
    ],
    strategyOutputSchema,
    "strategy_output",
  );
}
