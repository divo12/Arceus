import { z } from "zod";

export const toolResultStatusSchema = z.enum(["success", "warning", "error"]);
export type ToolResultStatus = z.infer<typeof toolResultStatusSchema>;

export const toolResultArtifactSchema = z.object({
  id: z.string(),
  path: z.string().optional(),
  kind: z.string()
});
export type ToolResultArtifact = z.infer<typeof toolResultArtifactSchema>;

export const toolResultErrorSchema = z.object({
  cause: z.string(),
  retry: z.enum(["safe", "unsafe", "never"]),
  stopWhen: z.string()
});
export type ToolResultError = z.infer<typeof toolResultErrorSchema>;

export const toolResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    status: toolResultStatusSchema,
    summary: z.string().max(500),
    data: dataSchema.optional(),
    nextActions: z.array(z.string()).optional(),
    artifacts: z.array(toolResultArtifactSchema).optional(),
    error: toolResultErrorSchema.optional()
  });

export interface ToolResult<T = unknown> {
  status: ToolResultStatus;
  summary: string;
  data?: T;
  nextActions?: string[];
  artifacts?: ToolResultArtifact[];
  error?: ToolResultError;
}

export const toolResultUnknownSchema = toolResultSchema(z.unknown());
