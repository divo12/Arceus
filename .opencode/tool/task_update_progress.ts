import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { arceusRequest, failure, loadContext, run, success, type ToolResult } from "./_lib/envelope.js";

export default tool({
  description: "Report incremental progress on the current task (percent, note, files). Replaces prior progress snapshot.",
  args: {
    percent: z.number().min(0).max(100).optional(),
    note: z.string().max(2000).optional(),
    completedSteps: z.number().int().nonnegative().optional(),
    totalSteps: z.number().int().positive().nullable().optional(),
    filesModified: z.array(z.string()).optional(),
  },
  execute: async (args) =>
    run(async () => {
      const ctx = loadContext();
      const res = await arceusRequest<ToolResult>(ctx, {
        method: "PATCH",
        path: `/api/internal/v1/tasks/${ctx.taskId}/progress`,
        body: args,
      });
      if (res.status >= 400) {
        return failure(`Progress update failed (HTTP ${res.status}).`, "upstream", "safe", "task_exists", res.data);
      }
      return success(`Progress updated on ${ctx.taskId}.`, { taskId: ctx.taskId, percent: args.percent ?? null });
    }),
});
