import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { spawn } from "node:child_process";
import { failure, run, success } from "./_lib/envelope.js";

interface TscError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

const parseTscOutput = (stdout: string): TscError[] => {
  const errors: TscError[] = [];
  // Pattern: path/to/file.ts(LINE,COL): error TSxxxx: message
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stdout)) !== null) {
    errors.push({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5].trim(),
    });
  }
  return errors;
};

const runTsc = (cwd: string, project: string | undefined): Promise<{ exitCode: number; stdout: string }> =>
  new Promise((resolve, reject) => {
    const args = ["tsc", "--noEmit"];
    if (project) args.push("-p", project);
    const child = spawn("npx", args, { cwd, shell: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { resolve({ exitCode: code ?? 1, stdout }); });
  });

export default tool({
  description: "Run a TypeScript typecheck (tsc --noEmit) in the workspace and return parsed errors. Developer-only, high-frequency.",
  args: {
    project: z.string().optional(),
    cwd: z.string().optional(),
    maxErrors: z.number().int().positive().max(500).optional(),
  },
  execute: async ({ project, cwd, maxErrors }) =>
    run(async () => {
      const workdir = cwd ?? process.env.TASK_WORKSPACE ?? process.cwd();
      const limit = maxErrors ?? 50;
      try {
        const { exitCode, stdout } = await runTsc(workdir, project);
        const errors = parseTscOutput(stdout).slice(0, limit);
        if (exitCode === 0 && errors.length === 0) {
          return success("Typecheck passed.", { ok: true, errorCount: 0, errors: [] });
        }
        return success(`Typecheck found ${errors.length} error(s).`, {
          ok: false,
          errorCount: errors.length,
          errors,
          exitCode,
        });
      } catch (err) {
        return failure(
          `Typecheck failed to run: ${err instanceof Error ? err.message : String(err)}`,
          "tooling",
          "safe",
          "tsc_available",
        );
      }
    }),
});

export { parseTscOutput };
