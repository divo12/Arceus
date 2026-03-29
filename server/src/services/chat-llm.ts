import { logger } from "../middleware/logger.js";
import type { ChatCardType, ChatCardData, StatusReportCardData, TaskProposalCardData, IssueCardData, BudgetRequestCardData, EscalationCardData, OrgPlanCardData } from "@paperclipai/shared";

const AZURE_ENDPOINT = process.env.ARCEUS_AZURE_OPENAI_ENDPOINT?.replace(/\/$/, "") ?? "";
const AZURE_API_KEY = process.env.ARCEUS_AZURE_OPENAI_API_KEY ?? "";
const AZURE_API_VERSION = process.env.ARCEUS_AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";
const CHAT_MODEL = process.env.ARCEUS_CHAT_MODEL ?? "gpt-4.1";

export function isChatLlmConfigured(): boolean {
  return Boolean(AZURE_ENDPOINT && AZURE_API_KEY);
}

// ---------------------------------------------------------------------------
// Tool definitions for function calling
// ---------------------------------------------------------------------------

const toolDefinitions = [
  {
    type: "function" as const,
    function: {
      name: "get_company_status",
      description: "Get current company status: agent counts, task counts, budget usage, pending escalations",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_agents",
      description: "List all agents with their names, roles, and current status",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_open_tasks",
      description: "List open/in-progress issues with title, priority, and assignee",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "propose_task",
      description: "Propose creating a new task/issue. Use this when the user asks to create a task, assign work, or you identify work that should be done.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          assigneeRole: { type: "string", description: "Role to assign to (e.g. engineer, designer)" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Task priority" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "propose_org_change",
      description: "Propose an organizational change such as restructuring reporting lines",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Brief summary of the change" },
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["add_edge", "remove_edge", "move_agent"] },
                parentRole: { type: "string" },
                childRole: { type: "string" },
                description: { type: "string" },
              },
              required: ["type", "description"],
            },
          },
        },
        required: ["summary", "changes"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Streaming chat completion
// ---------------------------------------------------------------------------

export interface ChatLlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface StreamChunk {
  type: "token" | "tool_call" | "done";
  token?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export async function* streamChatCompletion(
  messages: ChatLlmMessage[],
  options?: { tools?: boolean },
): AsyncGenerator<StreamChunk> {
  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    yield { type: "token", token: "Chat LLM is not configured. Set ARCEUS_AZURE_OPENAI_ENDPOINT and ARCEUS_AZURE_OPENAI_API_KEY." };
    yield { type: "done" };
    return;
  }

  const url = `${AZURE_ENDPOINT}/openai/deployments/${CHAT_MODEL}/chat/completions?api-version=${AZURE_API_VERSION}`;
  const body: Record<string, unknown> = {
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    max_tokens: 4096,
  };
  if (options?.tools !== false) {
    body.tools = toolDefinitions;
    body.tool_choice = "auto";
  }

  const startTime = Date.now();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": AZURE_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    logger.error({ status: response.status, body: errText }, "Azure OpenAI API error");
    yield { type: "token", token: `I'm having trouble connecting to my AI service (${response.status}). Please try again.` };
    yield { type: "done" };
    return;
  }

  if (!response.body) {
    yield { type: "token", token: "No response body from AI service." };
    yield { type: "done" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") {
          if (trimmed === "data: [DONE]") {
            // Yield any accumulated tool calls
            for (const [, tc] of toolCalls) {
              yield { type: "tool_call", toolCallId: tc.id, toolName: tc.name, toolArgs: tc.args };
            }
            yield { type: "done", usage };
            return;
          }
          continue;
        }
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.usage) {
            usage = {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            };
          }
          const choice = data.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: "token", token: delta.content };
          }

          // Tool calls (accumulated across chunks)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              }
              const entry = toolCalls.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }

          if (choice.finish_reason) {
            if (choice.finish_reason === "tool_calls") {
              for (const [, tc] of toolCalls) {
                yield { type: "tool_call", toolCallId: tc.id, toolName: tc.name, toolArgs: tc.args };
              }
            }
            yield { type: "done", finishReason: choice.finish_reason, usage };
            return;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done", usage };
}

// ---------------------------------------------------------------------------
// Card parsing from LLM text
// ---------------------------------------------------------------------------

const CARD_REGEX = /\[CARD:(\w+)\]\s*([\s\S]*?)\s*\[\/CARD\]/g;

export function parseCardsFromContent(content: string): Array<{ cardType: ChatCardType; cardData: ChatCardData; textBefore: string }> {
  const results: Array<{ cardType: ChatCardType; cardData: ChatCardData; textBefore: string }> = [];
  let lastIndex = 0;

  for (const match of content.matchAll(CARD_REGEX)) {
    const textBefore = content.slice(lastIndex, match.index);
    const rawType = match[1];
    const rawJson = match[2];
    lastIndex = (match.index ?? 0) + match[0].length;

    try {
      const cardData = JSON.parse(rawJson);
      results.push({ cardType: rawType as ChatCardType, cardData, textBefore });
    } catch {
      // If JSON parsing fails, treat as text
      logger.warn({ rawType, rawJson }, "Failed to parse card JSON from LLM output");
    }
  }

  return results;
}

export function buildCardFromToolCall(
  toolName: string,
  argsJson: string,
): { cardType: ChatCardType; cardData: ChatCardData } | null {
  try {
    const args = JSON.parse(argsJson);
    switch (toolName) {
      case "propose_task":
        return {
          cardType: "task_proposal",
          cardData: {
            title: args.title ?? "Untitled task",
            description: args.description,
            assigneeRole: args.assigneeRole,
            priority: args.priority ?? "medium",
          } satisfies TaskProposalCardData,
        };
      case "propose_org_change":
        return {
          cardType: "org_plan",
          cardData: {
            summary: args.summary,
            changes: args.changes ?? [],
          } satisfies OrgPlanCardData,
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
