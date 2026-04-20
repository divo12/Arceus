import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROLE_CONFIGS, type Role, type RoleAgentConfig } from "./config.js";

const yamlScalar = (value: string): string => {
  if (/^[\w./-]+$/.test(value)) return value;
  return JSON.stringify(value);
};

const renderFrontmatter = (config: RoleAgentConfig): string => {
  const lines: string[] = ["---"];
  lines.push(`description: ${yamlScalar(config.description)}`);
  lines.push(`mode: ${config.mode}`);
  lines.push(`model: ${yamlScalar(config.model)}`);
  lines.push(`prompt: ${yamlScalar(`{file:${config.promptFile}}`)}`);

  lines.push("permission:");
  lines.push(`  edit: ${config.permission.edit}`);
  if (config.permission.write) lines.push(`  write: ${config.permission.write}`);
  lines.push("  bash:");
  lines.push(`    "*": ${config.permission.bash["*"]}`);
  lines.push(`  webfetch: ${config.permission.webfetch}`);

  lines.push("tools:");
  for (const [name, enabled] of Object.entries(config.tools)) {
    lines.push(`  ${name}: ${enabled}`);
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
};

export interface WriteBeatAgentResult {
  role: Role;
  path: string;
  bytes: number;
  estimatedTokens: number;
}

export const writeBeatAgent = async (
  role: Role,
  workDir: string,
): Promise<WriteBeatAgentResult> => {
  const config = ROLE_CONFIGS[role];
  if (!config) throw new Error(`Unknown role: ${role}`);

  const agentDir = join(workDir, ".opencode", "agent");
  await mkdir(agentDir, { recursive: true });
  const filePath = join(agentDir, `${role}.md`);
  const body = renderFrontmatter(config);
  await writeFile(filePath, body, "utf8");

  return {
    role,
    path: filePath,
    bytes: Buffer.byteLength(body, "utf8"),
    estimatedTokens: Math.ceil(Buffer.byteLength(body, "utf8") / 4),
  };
};

export const renderBeatAgent = (role: Role): string => {
  const config = ROLE_CONFIGS[role];
  if (!config) throw new Error(`Unknown role: ${role}`);
  return renderFrontmatter(config);
};
