import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../types.js";
import http from "node:http";
import fsP from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  ensurePaperclipSkillSymlink,
  buildPaperclipEnv,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// OpenCode HTTP client
// ---------------------------------------------------------------------------

const OPENCODE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4098";
const OPENCODE_DIR = process.env.OPENCODE_DIR || process.cwd();

function ocRequest(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const parsed = new URL(urlPath, OPENCODE_URL);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(OPENCODE_DIR),
      },
    };
    if (data) {
      (opts.headers as Record<string, string | number>)["Content-Length"] =
        Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c: Buffer) => (d += c.toString()));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(d);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(300_000, () => {
      req.destroy();
      reject(new Error("OpenCode request timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Skill injection — symlink SKILL.md dirs into ~/.claude/skills/
// OpenCode reads skills from there automatically.
// ---------------------------------------------------------------------------

function skillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

async function ensureSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  config: Record<string, unknown>,
): Promise<void> {
  const entries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = resolvePaperclipDesiredSkillNames(config, entries);
  const desiredSet = new Set(desiredNames);
  const selected = entries.filter((e) => desiredSet.has(e.key));

  const home = skillsHome();
  await fsP.mkdir(home, { recursive: true });

  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    home,
    selected.map((e) => e.runtimeName),
  );
  for (const s of removedSkills) {
    await onLog("stderr", `[arceus] Removed maintainer-only skill "${s}"\n`);
  }

  for (const entry of selected) {
    const target = path.join(home, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stdout",
        `[arceus] ${result === "repaired" ? "Repaired" : "Injected"} skill "${entry.key}" into ${home}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[arceus] Failed to inject skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnvOrConfig(
  config: Record<string, unknown>,
  envKey: string,
  configKey: string,
  fallback: string,
): string {
  const fromConfig =
    typeof config[configKey] === "string" ? (config[configKey] as string).trim() : "";
  if (fromConfig) return fromConfig;
  return process.env[envKey]?.trim() || fallback;
}

function asString(val: unknown, fallback: string): string {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : fallback;
}

type DelegationStyleValue = "directive" | "collaborative" | "autonomous";

const DELEGATION_STYLE_HINTS: Record<DelegationStyleValue, string> = {
  directive: "provide specific instructions, retain control of decisions",
  collaborative: "share context and goals, let delegatees own approach",
  autonomous: "state the goal and definition of done, then step back",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .map((entry) => asString(entry, ""))
      .filter((entry) => entry.length > 0)
    : [];
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function truncateForAgentsMd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function asDelegationStyle(value: unknown): DelegationStyleValue | null {
  return value === "directive" || value === "collaborative" || value === "autonomous"
    ? value
    : null;
}

function buildRoleContextBlock(context: Record<string, unknown>): string {
  const roleDef = asRecord(context.paperclipRoleDefinition);
  if (!roleDef) return "";

  const label = asString(roleDef.label, "");
  if (!label) return "";

  const prompt = truncateForAgentsMd(asString(roleDef.systemPrompt, ""), 1600);
  const canDelegateTo = asStringArray(roleDef.canDelegateTo);
  const delegationStyle = asDelegationStyle(roleDef.delegationStyle);
  const spawnRules = asRecord(roleDef.spawnRules);
  const canSpawn = asStringArray(spawnRules?.allowedAgentTypes);

  const spawnBudget = asRecord(context.paperclipSpawnBudget);
  const active = asNumber(spawnBudget?.active, 0);
  const max = asNumber(spawnBudget?.max, 0);
  const remaining = asNumber(spawnBudget?.remaining, Math.max(0, max - active));
  const delegationDepth = Math.max(0, asNumber(context.paperclipDelegationDepth, 0));

  const orgPosition = asRecord(context.paperclipOrgPosition);
  const reportsTo = asString(orgPosition?.reportsTo, "");
  const directReports = asStringArray(orgPosition?.directReports);

  const lines: string[] = [`## Your Role: ${label}`];
  if (prompt) {
    lines.push(prompt, "");
  } else {
    lines.push("");
  }

  lines.push("## Action Space");
  if (canDelegateTo.length > 0) {
    lines.push(`Delegation authority: ${canDelegateTo.join(", ")}`);
    if (delegationStyle) {
      lines.push(`  Style: ${delegationStyle} — ${DELEGATION_STYLE_HINTS[delegationStyle]}`);
    }
    lines.push(`  Chain depth limit: 3 (you are at depth ${delegationDepth})`);
  } else {
    lines.push("Delegation authority: none — you execute tasks directly");
  }

  if (canSpawn.length > 0) {
    lines.push(`Spawn authority: ${canSpawn.join(", ")} (ephemeral only — employee roles are never spawned)`);
    lines.push(`  Budget: ${active}/${max} active (${remaining} remaining)`);
  } else {
    lines.push("Spawn authority: none");
  }

  lines.push("", "## Org Position");
  lines.push(`Reports to: ${reportsTo || "Board (no manager)"}`);
  if (directReports.length > 0) {
    lines.push(`Direct reports: ${directReports.join(", ")}`);
  } else {
    lines.push("Direct reports: none");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AGENTS.md writer — OpenCode picks this up as its instruction file.
// We write per-run context here so the agent knows who it is and has env vars.
// ---------------------------------------------------------------------------

async function writeAgentsMd(
  agent: AdapterExecutionContext["agent"],
  context: Record<string, unknown>,
  env: Record<string, string>,
): Promise<void> {
  const envLines = Object.entries(env)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n");

  const handoff = asString(context.paperclipSessionHandoffMarkdown as string, "");
  const memCtx = asString(context.paperclipMemoryContext as string, "");
  const roleBlock = buildRoleContextBlock(context);
  const meetingCtx = asString(context.paperclipMeetingContext as string, "");

  const md = [
    `# ${agent.name} — Paperclip Agent`,
    "",
    `You are **${agent.name}**, an AI agent in a Paperclip-managed company.`,
    "",
    "## Environment Variables (CRITICAL)",
    "",
    "Your bash environment does NOT have Paperclip variables pre-set.",
    "You MUST run these exports at the start of every bash invocation:",
    "",
    "```bash",
    envLines,
    "```",
    "",
    "**Example API call:**",
    "```bash",
    `curl -s -H "Authorization: Bearer ${env.PAPERCLIP_API_KEY || ""}" \\`,
    `  -H "X-Paperclip-Run-Id: ${env.PAPERCLIP_RUN_ID || ""}" \\`,
    `  "${env.PAPERCLIP_API_URL}/api/agents/me"`,
    "```",
    "",
    "## Quick Reference",
    `- Agent ID: \`${env.PAPERCLIP_AGENT_ID}\``,
    `- Company ID: \`${env.PAPERCLIP_COMPANY_ID}\``,
    `- API URL: \`${env.PAPERCLIP_API_URL}\``,
    `- Run ID: \`${env.PAPERCLIP_RUN_ID}\``,
    "",
    ...(roleBlock ? [roleBlock, ""] : []),
    "## Hiring Agents",
    "",
    "To hire a new agent, use the Paperclip API — **never** the OpenClaw invite flow:",
    "",
    "```bash",
    `curl -s -X POST -H "Authorization: Bearer ${env.PAPERCLIP_API_KEY || ""}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Paperclip-Run-Id: ${env.PAPERCLIP_RUN_ID || ""}" \\`,
    `  "${env.PAPERCLIP_API_URL}/api/companies/${env.PAPERCLIP_COMPANY_ID}/agent-hires" \\`,
    `  -d '{"name":"<name>","role":"<ceo|cto|pm|engineer|designer|general>","title":"<title>","adapterType":"opencode_local","adapterConfig":{"model":"azure/gpt-4.1"},"delegationStyle":"collaborative","runtimeConfig":{"heartbeat":{"enabled":true,"intervalSec":300,"wakeOnDemand":true,"cooldownSec":10,"maxConcurrentRuns":1}}}'`,
    "```",
    "",
    "Onboarding assets (SOUL.md, HEARTBEAT.md, AGENTS.md) are auto-materialized based on the role.",
    "Do **not** use `/openclaw/invite-prompt` — that is for external gateway agents only.",
    "",
    "## Instructions",
    "",
    "Use the **paperclip** skill (load it via the skill tool) for the full heartbeat procedure,",
    "API reference, and all critical rules. Always load the paperclip skill before taking any action.",
    "",
    ...(handoff ? ["## Session Handoff\n", handoff, ""] : []),
    ...(memCtx ? ["## Memory Context\n", memCtx, ""] : []),
    ...(meetingCtx ? ["## Meeting Context\n", meetingCtx, ""] : []),
  ].join("\n");

  const agentsMdPath = path.join(OPENCODE_DIR, "AGENTS.md");
  await fsP.writeFile(agentsMdPath, md, "utf8");
}

// ---------------------------------------------------------------------------
// Main execute — delegates to OpenCode with skills injected
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;

  const providerID = getEnvOrConfig(
    config,
    "ARCEUS_OPENCODE_PROVIDER",
    "openCodeProvider",
    "azure-cognitive-services",
  );
  const modelID = getEnvOrConfig(
    config,
    "ARCEUS_OPENCODE_MODEL",
    "openCodeModel",
    "gpt-5.1-chat",
  );

  // Build canonical Paperclip env vars
  const paperclipEnv = buildPaperclipEnv(agent);
  paperclipEnv.PAPERCLIP_RUN_ID = runId;
  if (authToken) paperclipEnv.PAPERCLIP_API_KEY = authToken;

  // Add wake-context env vars
  const wakeTaskId =
    asString(context.taskId as string, "") ||
    asString(context.issueId as string, "");
  if (wakeTaskId) paperclipEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  const wakeReason = asString(context.wakeReason as string, "");
  if (wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakeReason;
  const wakeCommentId =
    asString(context.wakeCommentId as string, "") ||
    asString(context.commentId as string, "");
  if (wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const approvalId = asString(context.approvalId as string, "");
  if (approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = approvalId;
  const approvalStatus = asString(context.approvalStatus as string, "");
  if (approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  const linkedIssueIds = asString(context.linkedIssueIds as string, "");
  if (linkedIssueIds) paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds;
  const meetingId = asString(context.meetingId as string, "");
  if (meetingId) paperclipEnv.PAPERCLIP_MEETING_ID = meetingId;
  const meetingType = asString(context.meetingType as string, "");
  if (meetingType) paperclipEnv.PAPERCLIP_MEETING_TYPE = meetingType;

  // 1. Inject Paperclip skills into ~/.claude/skills/ (OpenCode reads them)
  await ensureSkillsInjected(onLog, config);

  // 2. Write AGENTS.md with per-run context
  await writeAgentsMd(agent, context, paperclipEnv);
  await onLog("stdout", `[arceus] Wrote AGENTS.md with agent context\n`);

  // Build user prompt
  const userPrompt = buildUserPrompt(context);

  if (onMeta) {
    await onMeta({
      adapterType: "arceus",
      command: `OpenCode \u2192 ${providerID}/${modelID}`,
      env: { OPENCODE_URL, provider: providerID, model: modelID },
      prompt: userPrompt,
      promptMetrics: { systemChars: 0, userChars: userPrompt.length },
    });
  }

  await onLog(
    "stdout",
    `[arceus] Creating OpenCode session (${providerID}/${modelID})...\n`,
  );

  // 3. Create session
  let session: Record<string, unknown>;
  try {
    session = (await ocRequest("POST", "/session", {})) as Record<
      string,
      unknown
    >;
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to create OpenCode session: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "opencode_session_failed",
    };
  }

  const sessionId = session?.id as string | undefined;
  if (!sessionId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `OpenCode returned no session ID: ${JSON.stringify(session)}`,
      errorCode: "opencode_session_failed",
    };
  }

  await onLog("stdout", `[arceus] Session: ${sessionId}\n`);
  await onLog("stdout", `[arceus] Sending prompt...\n`);

  // 4. Send prompt to OpenCode
  let result: Record<string, unknown>;
  try {
    result = (await ocRequest("POST", `/session/${sessionId}/message`, {
      parts: [{ type: "text", text: userPrompt }],
      model: { providerID, modelID },
    })) as Record<string, unknown>;
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `OpenCode prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "opencode_prompt_failed",
    };
  }

  // 5. Check for errors
  const info = (result?.info ?? {}) as Record<string, unknown>;
  const errorInfo = info.error as Record<string, unknown> | undefined;
  if (errorInfo) {
    const errData = (errorInfo.data ?? {}) as Record<string, unknown>;
    const errMsg = (errData.message as string) || JSON.stringify(errorInfo);
    await onLog(
      "stderr",
      `[arceus] OpenCode error: ${errorInfo.name} \u2014 ${errMsg}\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `${errorInfo.name}: ${errMsg}`,
      errorCode: "opencode_model_error",
    };
  }

  // 6. Extract response
  const parts = (result?.parts ?? []) as Array<Record<string, unknown>>;
  const textParts: string[] = [];
  let toolCount = 0;

  for (const p of parts) {
    if (p.type === "text") {
      textParts.push(p.text as string);
      await onLog("stdout", (p.text as string) + "\n");
    }
    if (p.type === "tool-invocation") {
      toolCount++;
      await onLog(
        "stdout",
        `[arceus] Tool: ${p.toolName} | ${(p.title as string) || ""}\n`,
      );
    }
  }

  const finalContent = textParts.join("\n").trim();
  const tokens = (info.tokens ?? {}) as Record<string, number>;

  await onLog(
    "stdout",
    `[arceus] Done | Tools: ${toolCount} | Tokens: ${tokens.input || 0} in / ${tokens.output || 0} out\n`,
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    model: `${providerID}/${modelID}`,
    provider: "opencode",
    billingType: "api",
    usage: {
      inputTokens: tokens.input || 0,
      outputTokens: tokens.output || 0,
    },
    resultJson: { response: finalContent, model: modelID, sessionId, toolCount },
    summary: finalContent.slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

function buildUserPrompt(context: Record<string, unknown>): string {
  const wakeReason = asString(context.wakeReason as string, "heartbeat");
  return [
    `Wake reason: ${wakeReason}`,
    "",
    "Begin your heartbeat. First load the **paperclip** skill, then follow the heartbeat procedure.",
    "Run the environment export block from AGENTS.md before any bash commands.",
  ].join("\n");
}
