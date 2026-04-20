import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { arceusRequest, failure, loadContext, run, success, type ToolResult } from "./_lib/envelope.js";

export default tool({
  description: "Append a planning step to the current task's plan log. Use to narrate intent before executing commands.",
  args: {
    step: z.string().min(1).max(1000),
  },
  execute: async ({ step }) =>
    run(async () => {
      const ctx = loadContext();
      const res = await arceusRequest<ToolResult<unknown>>(ctx, {
        method: "POST",
        path: `/api/internal/v1/tasks/${ctx.taskId}/plan-steps`,
        body: { step },
        idempotent: true,
      });
      if (res.status >= 400) {
        return failure(`Append plan step failed (HTTP ${res.status}).`, "upstream", "safe", "task_exists", res.data);
      }
      return success(`Plan step appended to ${ctx.taskId}.`, { taskId: ctx.taskId });
    }),
});
