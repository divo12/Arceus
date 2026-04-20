import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { arceusRequest, failure, loadContext, run, success, type ToolResult } from "./_lib/envelope.js";

export default tool({
  description: "Append a shell command (and optional exit code) to the current task's running log. Content-hash idempotent.",
  args: {
    command: z.string().min(1).max(2000),
    exitCode: z.number().int().optional(),
  },
  execute: async ({ command, exitCode }) =>
    run(async () => {
      const ctx = loadContext();
      const res = await arceusRequest<ToolResult<unknown>>(ctx, {
        method: "POST",
        path: `/api/internal/v1/tasks/${ctx.taskId}/commands`,
        body: { command, exitCode },
        idempotent: true,
      });
      if (res.status >= 400) {
        return failure(`Append command failed (HTTP ${res.status}).`, "upstream", "safe", "task_exists", res.data);
      }
      return success(`Command appended to ${ctx.taskId}.`, { taskId: ctx.taskId });
    }),
});
