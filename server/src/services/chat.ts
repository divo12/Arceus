import { and, count, desc, eq, lt, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, chatMessages, companies, issues, goals } from "@paperclipai/db";
import type {
  ChatMessage,
  ChatCardType,
  ChatCardData,
  ChatCardState,
  ChatMessageMetadata,
  ChatCardActionInput,
  LiveEvent,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "./heartbeat.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { isChatLlmConfigured, streamChatCompletion, buildCardFromToolCall, type ChatLlmMessage } from "./chat-llm.js";

// ---------------------------------------------------------------------------
// Startup stage detection
// ---------------------------------------------------------------------------

type StartupStage = "welcome" | "idea_refinement" | "team_building" | "task_planning" | "kickoff" | "execution";

async function getStartupStage(db: Db, companyId: string): Promise<{
  stage: StartupStage;
  companyName: string;
  description: string | null;
  activeAgents: Array<{ id: string; name: string; role: string; status: string }>;
  openTasks: Array<{ identifier: string | null; title: string; priority: string; status: string; assigneeAgentId: string | null }>;
  companyGoals: Array<{ title: string }>;
  msgCount: number;
}> {
  const [companyRow, agentList, taskList, goalList, [msgCountRow]] = await Promise.all([
    db.select({ name: companies.name, description: companies.description })
      .from(companies).where(eq(companies.id, companyId)).then(r => r[0] ?? null),
    db.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
      .from(agents).where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
    db.select({ identifier: issues.identifier, title: issues.title, priority: issues.priority, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues).where(eq(issues.companyId, companyId)).limit(20),
    db.select({ title: goals.title }).from(goals).where(eq(goals.companyId, companyId)).limit(5),
    db.select({ c: count() }).from(chatMessages).where(eq(chatMessages.companyId, companyId)),
  ]);

  const activeAgents = agentList.filter(a => a.status !== "terminated");
  const hasCto = activeAgents.some(a => a.role === "cto");
  const hasNonCeoAgents = activeAgents.some(a => a.role !== "ceo");
  const hasDescription = Boolean(companyRow?.description?.trim());
  const openTasks = taskList.filter(t => t.status !== "done" && t.status !== "cancelled");
  const inProgressTasks = taskList.filter(t => t.status === "in_progress");
  const msgCount = Number(msgCountRow?.c ?? 0);

  let stage: StartupStage;
  if (!hasDescription && msgCount < 3) {
    stage = "welcome";
  } else if (!hasDescription) {
    stage = "idea_refinement";
  } else if (!hasCto) {
    stage = "team_building";
  } else if (openTasks.length === 0) {
    stage = "task_planning";
  } else if (inProgressTasks.length === 0) {
    stage = "kickoff";
  } else {
    stage = "execution";
  }

  return {
    stage,
    companyName: companyRow?.name ?? "this company",
    description: companyRow?.description ?? null,
    activeAgents,
    openTasks,
    companyGoals: goalList,
    msgCount,
  };
}

function buildStagePrompt(ctx: Awaited<ReturnType<typeof getStartupStage>>): string {
  const { stage, companyName, description, activeAgents, openTasks, companyGoals } = ctx;
  const existingRoles = new Set(activeAgents.map(a => a.role));

  const base = [
    `You are the CEO of **${companyName}**, speaking directly with the Board of Directors.`,
    "You are strategic, proactive, and action-oriented. Respond naturally and concisely.",
    "",
    "## CRITICAL RULES (NEVER BREAK THESE)",
    "- You ARE the CEO. NEVER propose hiring a CEO.",
    `- These roles already exist: ${[...existingRoles].join(", ")}. NEVER propose hiring a role that already exists.`,
    "- Hiring order: CTO first, then PM or Engineer, then Designer. Never skip ahead.",
    "",
  ];

  if (description) {
    base.push(`**Company mission**: ${description}`, "");
  }
  if (companyGoals.length > 0) {
    base.push("**Goals**:", ...companyGoals.map(g => `- ${g.title}`), "");
  }

  base.push("**Current team**:");
  if (activeAgents.length > 1 || (activeAgents.length === 1 && activeAgents[0].role !== "ceo")) {
    base.push(...activeAgents.map(a => `- ${a.name} (${a.role}) — ${a.status}`));
  } else {
    base.push("- Only you (CEO). No other team members yet.");
  }
  base.push("");

  if (openTasks.length > 0) {
    base.push("**Open tasks**:", ...openTasks.map(t => `- [${t.identifier}] ${t.title} (${t.priority}, ${t.status})`), "");
  }

  // Stage-specific instructions
  const stageInstructions: Record<StartupStage, string[]> = {
    welcome: [
      "## Current Phase: WELCOME",
      "The startup just launched. Your job right now:",
      "1. Welcome the Board warmly",
      "2. Ask what problem they want to solve — be genuinely curious",
      "3. Ask 1-2 follow-up questions to understand the vision",
      "4. Do NOT propose hiring anyone yet — first understand the idea",
    ],
    idea_refinement: [
      "## Current Phase: IDEA REFINEMENT",
      "You're still understanding the startup idea. Your job right now:",
      "1. Ask 2-3 clarifying questions about the problem, target users, and approach",
      "2. Help the Board articulate a clear mission statement",
      "3. Once the idea is clear, use the `set_company_description` tool to save it",
      "4. After saving, naturally transition to suggesting team building",
      "5. Do NOT propose hiring yet — get the idea clear first",
    ],
    team_building: [
      "## Current Phase: TEAM BUILDING",
      `The idea is clear: "${description}"`,
      "Your job right now:",
      !existingRoles.has("cto")
        ? "1. Propose hiring a **CTO** first — they'll lead technical execution. Use the `hire_agent` tool."
        : !existingRoles.has("engineer")
          ? "1. CTO is hired! Now propose hiring an **Engineer** to start building. Use the `hire_agent` tool."
          : "1. Core team is forming. Consider if PM or Designer is needed next.",
      "2. Explain WHY each hire is needed in the justification",
      "3. After each approval, acknowledge the hire and suggest the next one",
    ],
    task_planning: [
      "## Current Phase: TASK PLANNING",
      "The team is built. Your job right now:",
      "1. Use the `decompose_and_assign` tool to break the vision into 4-6 concrete tasks",
      "2. Assign each task to the right role (cto for architecture, engineer for implementation, etc.)",
      "3. Set appropriate priorities (critical for blockers, high for core features, medium for supporting work)",
      "4. Present the plan to the Board for approval",
    ],
    kickoff: [
      "## Current Phase: KICKOFF",
      "Tasks are created but not started. Your job right now:",
      "1. Summarize the plan — what each team member will work on",
      "2. Tell the Board you're ready to kick off execution",
      "3. Explain what to expect next (agents will start working on assigned tasks)",
    ],
    execution: [
      "## Current Phase: EXECUTION",
      "Work is in progress. Your job right now:",
      "1. Report on progress — which tasks are done, in progress, or blocked",
      "2. Highlight any blockers or issues that need Board attention",
      "3. Suggest next actions based on progress",
      "4. If all tasks are done, propose the next sprint or milestone",
    ],
  };

  base.push(...stageInstructions[stage], "");

  base.push(
    "## Available Tools",
    "- `hire_agent` — Propose hiring a new team member (generates approval card)",
    "- `propose_task` — Propose a single task (generates approval card)",
    "- `decompose_and_assign` — Break vision into multiple tasks at once (generates single batch card)",
    "- `set_company_description` — Save the refined company mission (executes immediately, no card)",
    "- `get_company_status` / `list_agents` / `list_open_tasks` — Query current state",
  );

  return base.join("\n");
}

// ---------------------------------------------------------------------------
// Row → API type
// ---------------------------------------------------------------------------

function toMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role as ChatMessage["role"],
    content: row.content,
    cardType: (row.cardType as ChatCardType) ?? null,
    cardData: (row.cardData as ChatCardData) ?? null,
    cardState: (row.cardState as ChatCardState) ?? null,
    agentId: row.agentId,
    metadata: (row.metadata as ChatMessageMetadata) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// OpenCode output parser
// ---------------------------------------------------------------------------

/**
 * Extract human-readable text from OpenCode JSON-format stdout chunks.
 * OpenCode outputs JSON lines like: {"type":"text","part":{"text":"..."}}
 * We extract just the text content and ignore step_start/step_finish/system messages.
 */
function extractOpenCodeText(chunk: string): string {
  const texts: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip [paperclip] and [arceus] system messages
    if (trimmed.startsWith("[paperclip]")) continue;
    if (trimmed.startsWith("[arceus]")) continue;

    // Try parsing as OpenCode JSON
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "text" && parsed.part?.text) {
        texts.push(parsed.part.text);
      }
      // Ignore step_start, step_finish, and other non-text types
    } catch {
      // Not JSON — might be plain text output, include if not a system prefix
      if (!trimmed.startsWith("{")) {
        texts.push(trimmed);
      }
    }
  }
  return texts.join("");
}

// ---------------------------------------------------------------------------
// Chat service
// ---------------------------------------------------------------------------

export function chatService(db: Db) {
  const heartbeat = heartbeatService(db);

  return {
    // ---- Message history (paginated) ----

    async getHistory(companyId: string, limit = 50, before?: string): Promise<ChatMessage[]> {
      const conditions = [eq(chatMessages.companyId, companyId)];
      if (before) {
        const cursor = await db.select({ createdAt: chatMessages.createdAt }).from(chatMessages).where(eq(chatMessages.id, before)).then(r => r[0]);
        if (cursor) conditions.push(lt(chatMessages.createdAt, cursor.createdAt));
      }
      const rows = await db
        .select()
        .from(chatMessages)
        .where(and(...conditions))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
      return rows.reverse().map(toMessage);
    },

    // ---- Store a user message ----

    async storeUserMessage(companyId: string, content: string): Promise<ChatMessage> {
      const [row] = await db.insert(chatMessages).values({
        companyId,
        role: "user",
        content,
      }).returning();
      return toMessage(row);
    },

    // ---- Store an assistant message ----

    async storeAssistantMessage(
      companyId: string,
      content: string,
      agentId: string | null,
      opts?: {
        cardType?: ChatCardType;
        cardData?: ChatCardData;
        metadata?: ChatMessageMetadata;
      },
    ): Promise<ChatMessage> {
      const [row] = await db.insert(chatMessages).values({
        companyId,
        role: "assistant",
        content,
        agentId,
        cardType: opts?.cardType ?? null,
        cardData: opts?.cardData ?? null,
        metadata: opts?.metadata ?? null,
      }).returning();
      return toMessage(row);
    },

    // ---- Card action (approve/reject/edit) ----

    async updateCardState(messageId: string, action: ChatCardActionInput): Promise<ChatMessage> {
      const [row] = await db
        .update(chatMessages)
        .set({
          cardState: {
            action: action.action,
            actedAt: new Date().toISOString(),
            ...(action.editedData ? { editedData: action.editedData } : {}),
          },
        })
        .where(eq(chatMessages.id, messageId))
        .returning();
      if (!row) throw notFound("Chat message not found");
      return toMessage(row);
    },

    // ---- Build chat context markdown for agent prompt ----

    buildChatContextMarkdown(history: ChatMessage[], newMessage: string): string {
      const lines: string[] = [
        "# Board Chat — Direct Conversation",
        "",
        "You are in a LIVE CHAT with the Board of Directors (human operator) via the Paperclip control panel.",
        "IMPORTANT: Respond directly and naturally to what the Board says. Answer questions, provide information, and have a normal conversation.",
        "Do NOT output templates or placeholders. Do NOT ask the Board to paste items. Just respond to their message.",
        "",
      ];

      if (history.length > 0) {
        lines.push("## Recent conversation");
        lines.push("");
        for (const msg of history.slice(-20)) {
          const role = msg.role === "user" ? "Board" : "CEO";
          lines.push(`**${role}**: ${msg.content}`);
          lines.push("");
        }
      }

      lines.push("## New message from the Board");
      lines.push("");
      lines.push(newMessage);
      lines.push("");
      lines.push("Respond to this message now.");

      return lines.join("\n");
    },

    // ---- Stream a CEO response via heartbeat agent execution ----

    async *streamResponse(
      companyId: string,
    ): AsyncGenerator<{
      type: "token" | "done" | "error";
      token?: string;
      fullContent?: string;
      runId?: string;
    }> {
      const ceoAgentId = await this.getCeoAgentId(companyId);
      if (!ceoAgentId) {
        yield { type: "token", token: "No CEO agent found for this company. Please create an agent with the CEO role first." };
        yield { type: "done", fullContent: "No CEO agent found for this company." };
        return;
      }

      // Build chat context from history
      const history = await this.getHistory(companyId, 20);
      const lastUserMessage = history.filter(m => m.role === "user").pop();
      const chatMarkdown = this.buildChatContextMarkdown(
        history.slice(0, -1), // exclude the just-stored user message from history
        lastUserMessage?.content ?? "",
      );

      // Subscribe to live events BEFORE invoking so we don't miss any
      let fullContent = "";
      let resolveStream: (() => void) | null = null;
      let rejectStream: ((err: Error) => void) | null = null;
      const tokenQueue: Array<{ type: "token" | "done" | "error"; token?: string; fullContent?: string; runId?: string }> = [];
      let streamDone = false;
      let runId: string | null = null;

      const streamPromise = new Promise<void>((resolve, reject) => {
        resolveStream = resolve;
        rejectStream = reject;
      });

      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event: LiveEvent) => {
        if (!runId) return;
        const payload = event.payload as Record<string, unknown>;
        if (payload.runId !== runId) return;

        if (event.type === "heartbeat.run.log") {
          const chunk = String(payload.chunk ?? "");
          const stream = String(payload.stream ?? "stdout");
          if (stream === "stdout" && chunk) {
            // Parse OpenCode JSON output format — extract text content only
            const extractedText = extractOpenCodeText(chunk);
            if (extractedText) {
              fullContent += extractedText;
              tokenQueue.push({ type: "token", token: extractedText });
            }
          }
        } else if (event.type === "heartbeat.run.status") {
          const status = String(payload.status ?? "");
          if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
            if (status === "failed") {
              const error = payload.error ? String(payload.error) : "Agent execution failed";
              tokenQueue.push({ type: "error", token: error });
            }
            streamDone = true;
            tokenQueue.push({ type: "done", fullContent, runId: runId ?? undefined });
            resolveStream?.();
          }
        }
      });

      try {
        // Invoke the CEO agent via heartbeat
        const run = await heartbeat.invoke(
          ceoAgentId,
          "on_demand",
          {
            source: "chat",
            wakeReason: "chat_message",
            paperclipSessionHandoffMarkdown: chatMarkdown,
          },
          "manual",
          { actorType: "user" },
        );

        if (!run) {
          unsubscribe();
          yield { type: "token", token: "CEO agent could not be invoked. It may be paused, at capacity, or over budget." };
          yield { type: "done", fullContent: "CEO agent could not be invoked." };
          return;
        }

        runId = run.id;

        // Yield tokens as they arrive, with a timeout
        const TIMEOUT_MS = 120_000; // 2 minutes
        const startTime = Date.now();

        while (!streamDone) {
          // Flush any queued tokens
          while (tokenQueue.length > 0) {
            const item = tokenQueue.shift()!;
            yield item;
            if (item.type === "done") {
              unsubscribe();
              return;
            }
          }

          // Check timeout
          if (Date.now() - startTime > TIMEOUT_MS) {
            unsubscribe();
            yield { type: "token", token: "\n\n(Response timed out after 2 minutes)" };
            yield { type: "done", fullContent: fullContent + "\n\n(Response timed out)" };
            return;
          }

          // Wait briefly for more events
          await new Promise((r) => setTimeout(r, 50));
        }

        // Flush remaining tokens
        while (tokenQueue.length > 0) {
          yield tokenQueue.shift()!;
        }
      } catch (err) {
        logger.error({ err }, "Chat agent invocation error");
        yield { type: "error", token: "Failed to invoke CEO agent" };
        yield { type: "done", fullContent: fullContent || "Failed to invoke CEO agent" };
      } finally {
        unsubscribe();
      }
    },

    // ---- Direct LLM chat (with tool calling) ----

    async *streamDirectResponse(
      companyId: string,
    ): AsyncGenerator<{
      type: "token" | "card" | "done" | "error";
      token?: string;
      cardType?: ChatCardType;
      cardData?: ChatCardData;
      fullContent?: string;
    }> {
      if (!isChatLlmConfigured()) {
        for await (const chunk of this.streamResponse(companyId)) {
          yield chunk;
        }
        return;
      }

      const stageCtx = await getStartupStage(db, companyId);
      const systemPrompt = buildStagePrompt(stageCtx);
      logger.info({ companyId, stage: stageCtx.stage, agents: stageCtx.activeAgents.length, tasks: stageCtx.openTasks.length }, "CEO chat stage");

      const history = await this.getHistory(companyId, 20);
      const recentHistory = history.slice(-10);
      const messages: ChatLlmMessage[] = [
        { role: "system", content: systemPrompt },
        ...recentHistory.map(m => ({
          role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
          content: m.content.slice(0, 2000),
        })),
      ];

      let fullContent = "";
      const cards: Array<{ cardType: ChatCardType; cardData: ChatCardData }> = [];

      // Collect tool calls that need follow-up (inline-executed tools like set_company_description)
      const pendingToolResults: Array<{ toolCallId: string; toolName: string; result: string }> = [];

      for await (const chunk of streamChatCompletion(messages, { tools: true })) {
        if (chunk.type === "token" && chunk.token) {
          fullContent += chunk.token;
          yield { type: "token", token: chunk.token };
        } else if (chunk.type === "tool_call" && chunk.toolName && chunk.toolArgs) {
          // Handle set_company_description inline (no card)
          if (chunk.toolName === "set_company_description") {
            let resultMsg = "Description saved.";
            try {
              const args = JSON.parse(chunk.toolArgs);
              if (args.description) {
                await db.update(companies).set({ description: args.description }).where(eq(companies.id, companyId));
                logger.info({ companyId, description: args.description.slice(0, 100) }, "Company description updated via CEO chat");
                resultMsg = `Company mission saved: "${args.description.slice(0, 100)}..."`;
              }
            } catch (err) {
              logger.error({ err }, "Failed to set company description");
              resultMsg = "Failed to save description.";
            }
            pendingToolResults.push({ toolCallId: chunk.toolCallId ?? "tc_desc", toolName: chunk.toolName, result: resultMsg });
            continue;
          }

          // Handle query tools inline (get_company_status, list_agents, list_open_tasks)
          if (chunk.toolName === "get_company_status" || chunk.toolName === "list_agents" || chunk.toolName === "list_open_tasks") {
            // Data is already in the system prompt — return a pointer
            const resultMsg = chunk.toolName === "list_agents"
              ? `Team: ${stageCtx.activeAgents.map(a => `${a.name} (${a.role})`).join(", ") || "Only CEO"}`
              : chunk.toolName === "list_open_tasks"
                ? `Tasks: ${stageCtx.openTasks.map(t => `[${t.identifier}] ${t.title}`).join(", ") || "None"}`
                : `Stage: ${stageCtx.stage}, Agents: ${stageCtx.activeAgents.length}, Tasks: ${stageCtx.openTasks.length}`;
            pendingToolResults.push({ toolCallId: chunk.toolCallId ?? "tc_query", toolName: chunk.toolName, result: resultMsg });
            continue;
          }

          const card = buildCardFromToolCall(chunk.toolName, chunk.toolArgs);
          if (card) {
            cards.push(card);
            yield { type: "card", cardType: card.cardType, cardData: card.cardData };
          }
        } else if (chunk.type === "done") {
          break;
        }
      }

      // If inline tools executed without text output, generate a contextual follow-up
      if (!fullContent && pendingToolResults.length > 0 && cards.length === 0) {
        const descSaved = pendingToolResults.find(t => t.toolName === "set_company_description");
        if (descSaved) {
          fullContent = "Mission saved! What would you like to focus on next?";
        } else {
          fullContent = pendingToolResults.map(t => t.result).join("\n");
        }
        yield { type: "token", token: fullContent };
      }

      // After description save, auto-propose CTO hire if entering team_building stage
      if (pendingToolResults.some(t => t.toolName === "set_company_description") && cards.length === 0) {
        const nextStage = await getStartupStage(db, companyId);
        if (nextStage.stage === "team_building") {
          const hireCard = {
            cardType: "hire_proposal" as ChatCardType,
            cardData: {
              name: "CTO",
              role: "cto",
              title: "Chief Technology Officer",
              adapterType: "arceus",
              delegationStyle: "collaborative",
              justification: `Lead technical execution for: ${nextStage.description?.slice(0, 100) ?? "the company vision"}`,
            } as ChatCardData,
          };
          cards.push(hireCard);
          yield { type: "card", cardType: hireCard.cardType, cardData: hireCard.cardData };
          const addendum = "\n\nTo start building, we need technical leadership. I've prepared a **CTO** hire proposal — please review and approve above.";
          fullContent += addendum;
          yield { type: "token", token: addendum };
        }
      }

      // If LLM only used tools without text, generate a summary
      if (!fullContent && cards.length > 0) {
        const summaries = cards.map(c => {
          if (c.cardType === "hire_proposal") {
            const d = c.cardData as { name: string; role: string; title?: string };
            return `I've prepared a hire proposal for **${d.name}** as ${d.title || d.role}. Please review and approve the card above.`;
          }
          if (c.cardType === "task_proposal") {
            const d = c.cardData as { title: string };
            return `I've proposed a new task: **${d.title}**. Please review and approve.`;
          }
          if (c.cardType === "decomposition_plan") {
            const d = c.cardData as { tasks: Array<{ title: string }> };
            return `I've broken down the work into **${d.tasks.length} tasks**. Please review and approve the plan above.`;
          }
          return `I've prepared a ${c.cardType.replace("_", " ")} for your review.`;
        });
        fullContent = summaries.join("\n\n");
        yield { type: "token", token: fullContent };
      }

      yield { type: "done", fullContent };
    },

    // ---- CEO agent ID resolver ----

    async getCeoAgentId(companyId: string): Promise<string | null> {
      const ceo = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
        .then((r) => r[0] ?? null);
      return ceo?.id ?? null;
    },
  };
}
