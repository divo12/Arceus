/**
 * LLM-based fact extraction from task outputs.
 *
 * This module defines the extraction prompt and output schema.
 * The actual LLM call is injected via FactExtractor so the hippocampus
 * package stays decoupled from the API layer (Azure OpenAI, etc.).
 */

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system for an AI software company.

Analyze the agent's task output and extract facts worth remembering for future work.

For each fact, classify:
- type: "static" (permanent architectural/tooling decisions), "dynamic" (temporary context that may change), or "procedural" (behavioral pattern / habit the agent should repeat)
- confidence: 0.0 to 1.0 — how certain this fact is
- is_temporal: true if the fact has a natural expiry (e.g., "deploy by Friday")
- expiry_days: if is_temporal, how many days until it expires; null otherwise

Rules:
- Extract 3-8 facts per task. Quality over quantity.
- Static facts: framework choices, architecture decisions, API patterns, database schema, key file paths
- Dynamic facts: current implementation state, workarounds, temporary configs, sprint-specific context
- Procedural facts: patterns the agent discovered that should become habits. For procedural facts you MUST provide separate "trigger" and "action" fields:
  - trigger: the condition or situation (e.g. "Setting up OAuth callback endpoints")
  - action: what to do (e.g. "Configure CORS middleware before registering routes to avoid 403 errors")
- DO NOT extract trivial facts like "task completed" or "code was written"
- DO NOT extract the task title itself as a fact
- Each fact should be a self-contained sentence useful without additional context
- Prefer specific facts ("Uses Vite on port 3210") over vague ones ("Project is set up")`;

export function buildExtractionUserPrompt(taskTitle: string, role: string, agentOutput: string): string {
  return [
    `Agent role: ${role}`,
    `Task: ${taskTitle}`,
    "",
    "Agent output:",
    agentOutput.slice(0, 6000), // Cap to stay within token budget
  ].join("\n");
}
