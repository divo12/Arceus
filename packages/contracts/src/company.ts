/**
 * @module company
 * Company, strategy, and fundamental-idea schemas.
 *
 * A Company is the top-level entity — created when the board owner starts
 * a new autonomous venture. It has a budget, a status lifecycle
 * (ideation → active → paused → archived), and references the current
 * strategy and sprint.
 *
 * Key types:
 * - Company — top-level entity with budget tracking
 * - FundamentalIdea — the board's original product vision
 * - StrategyBrief — CEO-generated plan approved by the board
 */
import { z } from "zod";

export const companyStatusSchema = z.enum(["ideation", "active", "paused", "archived"]);
export const strategyStatusSchema = z.enum(["draft", "pending_board_approval", "approved", "rejected"]);

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  boardOwner: z.string(),
  goal: z.string(),
  budgetCents: z.number().int().nonnegative(),
  spentCents: z.number().int().nonnegative(),
  status: companyStatusSchema,
  currentStrategyId: z.string(),
  currentSprintId: z.string().nullable(),
  currentSprintNumber: z.number().int().positive().nullable(),
  createdAt: z.string()
});

export const fundamentalIdeaSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  coreIdea: z.string(),
  currentDirection: z.string(),
  refinedWithBoard: z.boolean()
});

export const strategyBriefSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  title: z.string(),
  summary: z.string(),
  firstRelease: z.string(),
  scopeBoundary: z.array(z.string()),
  roleRationale: z.array(z.string()),
  status: strategyStatusSchema,
  createdByAgentId: z.string(),
  createdAt: z.string()
});

export type Company = z.infer<typeof companySchema>;
export type FundamentalIdea = z.infer<typeof fundamentalIdeaSchema>;
export type StrategyBrief = z.infer<typeof strategyBriefSchema>;
