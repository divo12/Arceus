import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { spawn } from "node:child_process";
import {
  arceusRequest,
  failure,
  loadContext,
  run,
  success,
  type ToolResult,
} from "./_lib/envelope.js";

const runCommand = (cmd: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr, timedOut }); });
  });

interface TaskShape {
  id: string;
  definitionOfDone?: string[];
  acceptanceSuite?: string;
}

export default tool({
  description: "Run the configured acceptance suite for the current task and report pass/fail. QA-only.",
  args: {
    suiteCommand: z.string().optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  },
  execute: async ({ suiteCommand, cwd, timeoutMs }) =>
    run(async () => {
      const ctx = loadContext();
      const workdir = cwd ?? process.env.TASK_WORKSPACE ?? process.cwd();

      let command = suiteCommand;
      if (!command) {
        const res = await arceusRequest<ToolResult<{ task: TaskShape }>>(ctx, {
          method: "GET",
          path: `/api/internal/v1/tasks/${ctx.taskId}`,
        });
        if (res.status >= 400) {
          return failure(
            `Could not load task ${ctx.taskId} (HTTP ${res.status}).`,
            "upstream",
            "safe",
            "task_exists",
          );
        }
        command = res.data?.data?.task?.acceptanceSuite ?? "npm test";
      }

      try {
        const result = await runCommand(command, workdir, timeoutMs ?? 300_000);
        const passed = !result.timedOut && result.exitCode === 0;
        const tail = (result.stdout + result.stderr).split("\n").slice(-30).join("\n");
        return success(`Acceptance suite ${passed ? "passed" : "failed"}.`, {
          taskId: ctx.taskId,
          command,
          passed,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          outputTail: tail,
        });
      } catch (err) {
        return failure(
          `Acceptance suite failed to run: ${err instanceof Error ? err.message : String(err)}`,
          "tooling",
          "safe",
          "command_runnable",
        );
      }
    }),
});
