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

function ocRequest(method: string, urlPath: string, body?: unknown, directory?: string): Promise<unknown> {
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
        "x-opencode-directory": encodeURIComponent(directory ?? OPENCODE_DIR),
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
    req.setTimeout(600_000, () => {
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
  targetDir?: string,
): Promise<void> {
  const wakeReason = asString(context.wakeReason as string, "");
  const isTaskExecution = wakeReason === "task_assigned" || wakeReason === "issue_assigned";
  const roleBlock = buildRoleContextBlock(context);

  let md: string;

  if (isTaskExecution) {
    // Slim AGENTS.md for task execution — agent doesn't need API docs or hiring instructions
    md = [
      `# ${agent.name} — Agent`,
      "",
      ...(roleBlock ? [roleBlock, ""] : []),
    ].join("\n");
  } else {
    // Full AGENTS.md for heartbeat / leadership / chat
    const envLines = Object.entries(env)
      .map(([k, v]) => `export ${k}="${v}"`)
      .join("\n");
    const handoff = asString(context.paperclipSessionHandoffMarkdown as string, "");
    const memCtx = asString(context.paperclipMemoryContext as string, "");
    const meetingCtx = asString(context.paperclipMeetingContext as string, "");

    md = [
      `# ${agent.name} — Paperclip Agent`,
      "",
      `You are **${agent.name}**, an AI agent in a Paperclip-managed company.`,
      "",
      "## Environment Variables (CRITICAL)",
      "",
      "You MUST run these exports at the start of every bash invocation:",
      "",
      "```bash",
      envLines,
      "```",
      "",
      "## Quick Reference",
      `- Agent ID: \`${env.PAPERCLIP_AGENT_ID}\``,
      `- Company ID: \`${env.PAPERCLIP_COMPANY_ID}\``,
      `- API URL: \`${env.PAPERCLIP_API_URL}\``,
      `- Run ID: \`${env.PAPERCLIP_RUN_ID}\``,
      "",
      ...(roleBlock ? [roleBlock, ""] : []),
      "## API Quick Reference",
      `All calls need: \`-H "Authorization: Bearer ${env.PAPERCLIP_API_KEY || ""}" -H "X-Paperclip-Run-Id: ${env.PAPERCLIP_RUN_ID || ""}"\``,
      `- Agent status: \`GET ${env.PAPERCLIP_API_URL}/api/agents/me\``,
      `- Inbox: \`GET ${env.PAPERCLIP_API_URL}/api/agents/me/inbox-lite\``,
      `- Update task: \`PATCH ${env.PAPERCLIP_API_URL}/api/companies/${env.PAPERCLIP_COMPANY_ID}/issues/{id}\` with \`{"status":"done"}\``,
      `- Create task: \`POST ${env.PAPERCLIP_API_URL}/api/companies/${env.PAPERCLIP_COMPANY_ID}/issues\``,
      `- Hire: \`POST ${env.PAPERCLIP_API_URL}/api/companies/${env.PAPERCLIP_COMPANY_ID}/agent-hires\``,
      "",
      ...(handoff ? ["## Session Handoff\n", handoff, ""] : []),
      ...(memCtx ? ["## Memory Context\n", memCtx, ""] : []),
      ...(meetingCtx ? ["## Meeting Context\n", meetingCtx, ""] : []),
    ].join("\n");
  }

  const dir = targetDir ?? OPENCODE_DIR;
  await fsP.mkdir(dir, { recursive: true });
  const agentsMdPath = path.join(dir, "AGENTS.md");
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

  // 0. Create per-run directory for AGENTS.md isolation
  const runDir = path.join(OPENCODE_DIR, ".runs", runId);
  await fsP.mkdir(runDir, { recursive: true });

  try {

  // 1. Inject role-specific skill (not the full paperclip skill)
  const agentRole = asString(context.paperclipAgentRole as string, "");
  const roleSkillMap: Record<string, string> = {
    ceo: "arceus-ceo",
    cto: "arceus-cto",
    pm: "arceus-pm",
    engineer: "arceus-engineer",
    designer: "arceus-designer",
  };
  const roleSkillName = roleSkillMap[agentRole];
  if (roleSkillName) {
    // Symlink only the role-specific skill into ~/.claude/skills/
    // Skills are at /app/skills/ in the container, or relative to repo root in dev
    const skillSource = path.resolve(__moduleDir, "..", "..", "..", "..", "skills", roleSkillName);
    const skillTarget = path.join(skillsHome(), roleSkillName);
    try {
      await fsP.mkdir(skillsHome(), { recursive: true });
      const stat = await fsP.lstat(skillTarget).catch(() => null);
      if (!stat) {
        await fsP.symlink(skillSource, skillTarget, "dir");
        await onLog("stdout", `[arceus] Injected role skill "${roleSkillName}"\n`);
      }
    } catch (err) {
      await onLog("stderr", `[arceus] Failed to inject role skill: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    // Fallback: inject generic paperclip skills
    await ensureSkillsInjected(onLog, config);
  }

  // 2. Write AGENTS.md to per-run directory (isolated from concurrent runs)
  try {
    await writeAgentsMd(agent, context, paperclipEnv, runDir);
    await onLog("stdout", `[arceus] Wrote AGENTS.md with agent context\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[arceus] Failed to write AGENTS.md: ${msg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to write AGENTS.md: ${msg}`,
      errorCode: "agents_md_write_failed",
    };
  }

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

  // 3. Create session (using per-run directory)
  let session: Record<string, unknown>;
  try {
    session = (await ocRequest("POST", "/session", {}, runDir)) as Record<
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

  // 4. Send prompt to OpenCode (using per-run directory)
  let result: Record<string, unknown>;
  try {
    result = (await ocRequest("POST", `/session/${sessionId}/message`, {
      parts: [{ type: "text", text: userPrompt }],
      model: { providerID, modelID },
    }, runDir)) as Record<string, unknown>;
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
    sessionParams: { sessionId },
    sessionDisplayId: sessionId,
    usage: {
      inputTokens: tokens.input || 0,
      outputTokens: tokens.output || 0,
    },
    resultJson: { response: finalContent, model: modelID, sessionId, toolCount },
    summary: finalContent.slice(0, 500),
  };

  } finally {
    // Cleanup per-run directory
    try {
      await fsP.rm(runDir, { recursive: true, force: true });
    } catch {
      // Non-fatal — stale dirs cleaned up on next run
    }
  }
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

function buildUserPrompt(context: Record<string, unknown>): string {
  const wakeReason = asString(context.wakeReason as string, "heartbeat");
  const source = asString(context.source as string, "");

  // Chat messages get a direct conversational prompt instead of heartbeat
  if (source === "chat" || wakeReason === "chat_message") {
    const handoff = asString(context.paperclipSessionHandoffMarkdown as string, "");
    return [
      "You are in a LIVE CHAT with the Board of Directors.",
      "Read the Session Handoff section in AGENTS.md for conversation history.",
      "Respond directly and naturally to the Board's latest message.",
      "Do NOT run a heartbeat procedure. Just respond to the conversation.",
      "",
      ...(handoff ? ["## Conversation Context", "", handoff] : []),
    ].join("\n");
  }

  const role = asString(context.paperclipAgentRole as string, "");
  const taskId = asString(context.taskId as string, "") || asString(context.issueId as string, "");
  const isLeadership = role === "ceo" || role === "cto";

  // Task-assigned wake: pre-digested task prompt (zero exploration needed)
  if (wakeReason === "task_assigned" || wakeReason === "issue_assigned") {
    const taskDetails = asRecord(context.paperclipTaskDetails);
    const taskTitle = asString(taskDetails?.title, "Assigned task");
    const taskDesc = asString(taskDetails?.description, "");
    const taskIdentifier = asString(taskDetails?.identifier, "");
    const taskPriority = asString(taskDetails?.priority, "medium");

    const roleApproach: Record<string, string[]> = {
      ceo: [
        "You are the CEO. Break this task into sub-tasks and delegate.",
        "Do NOT write code. Create sub-issues via the API for your reports.",
      ],
      cto: [
        "You are the CTO. Focus on ARCHITECTURE and TECHNICAL DESIGN.",
        "Write: architecture docs, API contracts, system diagrams (mermaid in markdown), tech decisions.",
        "Create real files in the workspace. Do NOT write implementation code — that's for Engineers.",
      ],
      pm: [
        "You are the PM. Focus on PRODUCT SPECIFICATIONS.",
        "Write: requirements docs, user stories with acceptance criteria, user flows, definition-of-done.",
        "Create real files in the workspace. Do NOT write code.",
      ],
      engineer: [
        "You are an Engineer. WRITE CODE.",
        "Create real source files using bash. Write production-quality code + tests. Run them to verify.",
        "Use: `mkdir -p dir && cat > file.ext << 'EOF'` to create files. Actually BUILD it, don't describe it.",
      ],
      designer: [
        "You are a Designer. Write UX/UI DESIGN SPECS.",
        "Create: wireframes (markdown), component hierarchy, style guide, interaction states, responsive layout.",
        "Output specs detailed enough for Engineers to implement.",
      ],
    };

    const approach = roleApproach[role] ?? ["Execute the task directly using your expertise."];

    return [
      `## YOUR TASK [${taskIdentifier}]`,
      `**${taskTitle}** (priority: ${taskPriority})`,
      ...(taskDesc ? ["", taskDesc] : []),
      "",
      ...approach,
      "",
      "START WORKING IMMEDIATELY. Do not check inbox or call any APIs.",
      "The system will automatically mark the task complete when you finish.",
      "Write a clear summary of what you did at the end.",
    ].join("\n");
  }

  // Leadership roles (CEO, CTO) get proactive instructions
  if (isLeadership) {
    const companyContext = asString(context.paperclipCompanyContext as string, "");
    const taskId = asString(context.taskId as string, "") || asString(context.issueId as string, "");
    return [
      `Wake reason: ${wakeReason}`,
      "",
      "Run the environment export block from AGENTS.md before any bash commands.",
      "",
      "## Your Responsibilities",
      "",
      role === "ceo"
        ? "As CEO, you are PROACTIVE. You do NOT wait for assignments. You:"
        : "As CTO, you are PROACTIVE on technical matters. You:",
      "1. Check company status and open tasks via the Paperclip API",
      "2. Identify what needs to be done next to advance the company",
      "3. Create new tasks, delegate work to other agents, or execute work yourself",
      "4. Hire new agents if the team needs more capacity",
      "5. Report progress back to the Board",
      "",
      "**CRITICAL**: Do NOT exit if you have no assigned tasks. You are a leader — find work, create work, delegate work.",
      "",
      ...(taskId ? [`Your current focus task: ${taskId}`, ""] : []),
      ...(companyContext ? ["## Company Context", "", companyContext, ""] : []),
      "## Procedure",
      "",
      "1. Export environment variables from AGENTS.md",
      "2. Call `GET /api/agents/me` to check your status",
      "3. Call `GET /api/agents/me/inbox-lite` to check assigned work",
      `4. Call \`GET /api/companies/\${PAPERCLIP_COMPANY_ID}/issues?status=todo\` to see all open tasks`,
      `5. Call \`GET /api/companies/\${PAPERCLIP_COMPANY_ID}/goals\` to see company goals`,
      "6. Decide what to work on — execute, delegate, or create new tasks",
      "7. Take action and report results",
      "",
      "## API Quick Reference",
      "All calls need: `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\" -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"`",
      "- List tasks: `GET $PAPERCLIP_API_URL/api/agents/me/inbox-lite`",
      "- Get task: `GET $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/{issueId}`",
      "- Update task: `PATCH $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/{issueId}` with `{\"status\":\"done\"}`",
      "- Add comment: `POST $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/{issueId}/comments` with `{\"body\":\"...\"}`",
      "- Create task: `POST $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues` with `{\"title\":\"...\",\"description\":\"...\",\"priority\":\"medium\"}`",
    ].join("\n");
  }

  // Role-specific heartbeat for non-leadership agents
  const roleHeartbeat: Record<string, string[]> = {
    pm: [
      "You are a Product Manager. Check your inbox for assigned tasks.",
      "For each task: write detailed product specs, user stories, and acceptance criteria.",
      "If no tasks are assigned, review existing tasks and add spec comments where needed.",
    ],
    engineer: [
      "You are a Software Engineer. Check your inbox for assigned tasks.",
      "For each task: write code, tests, and documentation in the workspace.",
      "Use bash to create real files and run real commands. Build things, don't just describe them.",
    ],
    designer: [
      "You are a Designer. Check your inbox for assigned tasks.",
      "For each task: write UI/UX design specs, component hierarchies, and style guides.",
      "Output detailed design documents that Engineers can implement from.",
    ],
  };

  const roleLines = roleHeartbeat[role] ?? [
    "Check your inbox for assigned tasks and execute them per your role.",
  ];

  return [
    `Wake reason: ${wakeReason}`,
    "",
    "Run the environment export block from AGENTS.md before any bash commands.",
    "",
    ...roleLines,
    "",
    "## Procedure",
    "1. Export env vars from AGENTS.md",
    "2. Check inbox: `curl -s -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" $PAPERCLIP_API_URL/api/agents/me/inbox-lite`",
    "3. Execute your assigned tasks per your role",
    "4. Mark completed tasks: `PATCH /api/companies/$PAPERCLIP_COMPANY_ID/issues/{id}` with `{\"status\":\"done\"}`",
  ].join("\n");
}
