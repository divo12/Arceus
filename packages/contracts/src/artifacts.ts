import { z } from "zod";

export const artifactKindSchema = z.enum([
  "architecture",
  "specification",
  "implementation",
  "preview",
  "qa_report",
  "launch_asset",
  "meeting_note",
  "chat_card",
  "memory_seed",
  "plan",
  "output",
  "other"
]);

export const artifactSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintId: z.string().nullable(),
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
  kind: artifactKindSchema,
  title: z.string(),
  summary: z.string(),
  location: z.string().nullable(),
  contentType: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

export type Artifact = z.infer<typeof artifactSchema>;
