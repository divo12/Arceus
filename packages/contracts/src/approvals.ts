import { z } from "zod";

export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "applied"]);

export const approvalSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  type: z.enum(["strategy", "hire", "meeting_blocker", "external_action", "tool_governance"]),
  status: approvalStatusSchema,
  title: z.string(),
  description: z.string(),
  requestedByAgentId: z.string(),
  meetingId: z.string().nullable(),
  agendaItemId: z.string().nullable(),
  resolutionSummary: z.string().nullable()
});

export type Approval = z.infer<typeof approvalSchema>;
