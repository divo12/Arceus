import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  arceusRequest,
  deriveIdempotencyKey,
  failure,
  loadContext,
  run,
  success,
  type ToolResult,
} from "./_lib/envelope.js";

const collectFiles = async (dir: string, maxBytes: number): Promise<string> => {
  const entries = await readdir(dir);
  const lines: string[] = [`# Evidence bundle from ${dir}`];
  let bytesUsed = 0;
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (!info.isFile()) continue;
    const remaining = maxBytes - bytesUsed;
    if (remaining <= 0) {
      lines.push(`\n## ${entry}\n[truncated — bundle limit reached]`);
      break;
    }
    if (info.size > remaining) {
      lines.push(`\n## ${entry} (${info.size} bytes, truncated)`);
      const buf = await readFile(full);
      lines.push("```");
      lines.push(buf.toString("base64").slice(0, remaining));
      lines.push("```");
      bytesUsed = maxBytes;
      break;
    }
    const buf = await readFile(full);
    const isText = /\.(json|txt|md|html|log|csv)$/i.test(entry);
    lines.push(`\n## ${entry} (${info.size} bytes)`);
    if (isText) {
      lines.push("```");
      lines.push(buf.toString("utf8"));
      lines.push("```");
    } else {
      lines.push("```");
      lines.push(`base64:${buf.toString("base64")}`);
      lines.push("```");
    }
    bytesUsed += info.size;
  }
  return lines.join("\n");
};

export default tool({
  description: "Bundle a probe directory into an evidence artifact attached to the current task. Returns the artifactId. QA-only.",
  args: {
    bundleDir: z.string(),
    title: z.string().optional(),
    maxBytes: z.number().int().positive().max(180_000).optional(),
  },
  execute: async ({ bundleDir, title, maxBytes }) =>
    run(async () => {
      const ctx = loadContext();
      let content: string;
      try {
        content = await collectFiles(bundleDir, maxBytes ?? 150_000);
      } catch (err) {
        return failure(
          `Could not read bundle dir ${bundleDir}: ${err instanceof Error ? err.message : String(err)}`,
          "validation",
          "never",
          "bundle_exists",
        );
      }

      const body = {
        agent: ctx.role,
        kind: "output" as const,
        title: title ?? `Evidence bundle for ${ctx.taskId} (${basename(bundleDir)})`,
        content,
        attachToTaskIds: [ctx.taskId],
      };

      const res = await arceusRequest<ToolResult<{ artifactId: string }>>(ctx, {
        method: "POST",
        path: "/api/internal/v1/artifacts",
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, `workspace_collect_evidence:${ctx.taskId}`, { bundleDir }),
      });

      if (res.status >= 400) {
        return failure(
          `Evidence upload failed (HTTP ${res.status}).`,
          "upstream",
          "safe",
          "api_reachable",
          res.data,
        );
      }

      const artifactId = res.data?.data?.artifactId ?? null;
      return success(`Evidence bundled for ${ctx.taskId}.`, {
        taskId: ctx.taskId,
        artifactId,
        bundleDir,
      });
    }),
});

export { collectFiles };
