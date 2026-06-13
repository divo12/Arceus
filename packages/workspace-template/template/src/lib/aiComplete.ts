/**
 * aiComplete — call an LLM from your product with ZERO setup.
 *
 * No API key, no backend, no SDK. Arceus runs the AI Gateway on the same
 * origin your product is served from (`/api/ai/complete`): it holds the
 * provider key server-side, meters usage against your company budget, and
 * returns the model's reply. Just import and call:
 *
 *   import { aiPrompt } from "@/lib/aiComplete";
 *   const summary = await aiPrompt("Summarise this note in one line:\n" + note);
 *
 *   // or full chat control:
 *   import { aiComplete } from "@/lib/aiComplete";
 *   const { text } = await aiComplete([
 *     { role: "system", content: "You are a concise assistant." },
 *     { role: "user", content: userInput },
 *   ], { maxTokens: 300 });
 *
 * The key never reaches the browser. Budget/rate limits are enforced
 * server-side; handle AiCompleteError (e.g. code "budget_exceeded" or
 * "rate_limited") to show a friendly message.
 */

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompleteOptions {
  /** Cap the response length (server clamps to a safe maximum). */
  maxTokens?: number;
  /** 0 = deterministic, higher = more creative. Default ~0.7. */
  temperature?: number;
  /** Abort the request (e.g. on unmount or a newer query). */
  signal?: AbortSignal;
}

export interface AiCompleteResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number; costCents: number };
}

export class AiCompleteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "AiCompleteError";
    this.code = code;
    this.status = status;
  }
}

/** The gateway endpoint — same-origin, so it works in preview and production. */
const ENDPOINT = "/api/ai/complete";

/**
 * Send a chat completion through the Arceus AI Gateway.
 * @throws {AiCompleteError} on validation, budget, rate-limit, or upstream failures.
 */
export async function aiComplete(
  messages: AiMessage[],
  options: AiCompleteOptions = {},
): Promise<AiCompleteResult> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
      }),
      signal: options.signal,
    });
  } catch (err) {
    throw new AiCompleteError(
      err instanceof Error ? err.message : "Network error calling the AI gateway.",
      "network_error",
      0,
    );
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON body — handled below */
  }

  if (!response.ok) {
    const body = (data ?? {}) as { error?: string; message?: string };
    throw new AiCompleteError(
      body.message ?? `AI request failed (${response.status}).`,
      body.error ?? "error",
      response.status,
    );
  }

  return data as AiCompleteResult;
}

/** Convenience: send a single user prompt, get the reply text. */
export async function aiPrompt(prompt: string, options?: AiCompleteOptions): Promise<string> {
  const { text } = await aiComplete([{ role: "user", content: prompt }], options);
  return text;
}
