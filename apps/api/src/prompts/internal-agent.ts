/**
 * Internal Agent Prompt Execution — Spec 24
 *
 * A simplified prompt runner for internal system agents.
 * Unlike runPromptText() which looks up role souls and injects skills/memory,
 * internal agents use their own system prompts and don't need hippocampus context.
 *
 * Supports multi-turn by passing `systemPrompt: null` to continue an existing session.
 */

import { getInternalAgent, internalAgentRole } from "@arceus/company-runtime";
import { nowIso } from "@arceus/task-engine";
import type { Message, Part, SessionPromptData } from "@opencode-ai/sdk";
import { getOpencode } from "../infra/opencode.js";
import { ensureDeployment } from "../config/index.js";
import { agentSessions, pendingPromptCompletions } from "../orchestration/state.js";
import { updateAgentSessionState } from "../agents/sessions.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { withRetry, isRetryableError } from "../infra/resilience.js";
import { truncateTelemetry } from "../infra/utils.js";
import { ensureInternalAgentSession } from "../agents/internal-sessions.js";
import { registerPromptCompletion } from "./llm.js";

/** Element shape of `client.session.messages({...}).data` per OpenCode SDK. */
interface SessionMessage { info: Message; parts: Part[] }

/** The `body` we send to `client.session.prompt()`. */
type SessionPromptBody = NonNullable<SessionPromptData["body"]>;

/**
 * Send a prompt to an internal agent's OpenCode session.
 *
 * @param agentKey - Internal agent key (e.g. "memory_agent")
 * @param systemPrompt - System prompt for the first turn, or null to continue session
 * @param userMessage - The user message to send
 * @returns The assistant's text response
 */
export async function runInternalAgentPrompt(
  agentKey: string,
  systemPrompt: string | null,
  userMessage: string,
): Promise<string> {
  const def = getInternalAgent(agentKey);
  const role = internalAgentRole(agentKey);
  const deployment = ensureDeployment(def.deployment);

  const session = await ensureInternalAgentSession(agentKey);

  // Use the agent's system prompt on first turn, or the provided override
  const effectiveSystemPrompt = systemPrompt ?? def.systemPrompt;

  emitEmployeeActivity(role, "context", `Internal agent prompt: system=${effectiveSystemPrompt.length}ch user=${userMessage.length}ch model=${deployment}`);

  updateAgentSessionState(role, {
    promptStartedAt: nowIso(),
    promptCompletedAt: null,
    awaiting: "waiting for Opencode response",
    lastEventSummary: truncateTelemetry(userMessage, 140),
    stallReason: null,
  });

  let currentSessionId = session.sessionId;
  const output = await withRetry(
    async () => {
      const opencode = await getOpencode();
      const promptBody: SessionPromptBody = {
        model: { providerID: "azure", modelID: deployment },
        system: effectiveSystemPrompt,
        parts: [{ type: "text", text: userMessage }],
      };

      const completionPromise = registerPromptCompletion(currentSessionId);

      await opencode.client.session.prompt({
        path: { id: currentSessionId },
        body: promptBody,
      });
      await completionPromise;

      const messagesResult = await opencode.client.session.messages({
        path: { id: currentSessionId },
      });

      const messages = messagesResult.data;
      if (!messages || messages.length === 0) return "";

      const assistantMessages = messages.filter(
        (m): m is { info: Extract<Message, { role: "assistant" }>; parts: Part[] } =>
          m.info?.role === "assistant",
      );
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      if (!lastAssistant) return "";

      const infoError = lastAssistant.info.error;
      if (infoError) {
        const errorMsg =
          ("data" in infoError && typeof infoError.data === "object" && infoError.data !== null && "message" in infoError.data
            ? String((infoError.data as { message?: unknown }).message)
            : undefined) ??
          infoError.name ??
          "Unknown OpenCode session error";
        throw new Error(`OpenCode internal agent ${agentKey} error: ${errorMsg}`);
      }

      return (
        lastAssistant.parts
          ?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
          .join("\n")
          .trim() || ""
      );
    },
    {
      maxRetries: 3,
      delay: 2000,
      backoff: 2,
      shouldRetry: isRetryableError,
      onRetry: async (attempt, _error) => {
        const { resetOpencodeConnection } = await import("../infra/opencode.js");
        await resetOpencodeConnection();
        agentSessions.delete(role);
        emitEmployeeActivity(role, "info", `Internal agent ${agentKey} connection lost — reconnecting (attempt ${attempt})…`);
        const freshSession = await ensureInternalAgentSession(agentKey);
        currentSessionId = freshSession.sessionId;
      },
    },
  );

  updateAgentSessionState(role, {
    promptCompletedAt: nowIso(),
    lastProgressAt: nowIso(),
    lastEventSummary: truncateTelemetry(output || "Prompt completed with no text output."),
    awaiting: "idle",
  });

  return output;
}
