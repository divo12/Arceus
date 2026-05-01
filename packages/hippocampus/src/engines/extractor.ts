/**
 * LLM-based fact extraction from task outputs.
 *
 * This module defines the extraction prompt and output schema.
 * The actual LLM call is injected via FactExtractor so the hippocampus
 * package stays decoupled from the API layer (Azure OpenAI, etc.).
 */

export { EXTRACTION_SYSTEM_PROMPT, MEETING_EXTRACTION_PROMPT } from "./prompts/loader.js";

/**
 * Build the user-side prompt for fact extraction, combining agent role, task title,
 * and the agent's output (capped at 6k chars to stay within token budget).
 */
export function buildExtractionUserPrompt(taskTitle: string, role: string, agentOutput: string): string {
  return [
    `Agent role: ${role}`,
    `Task: ${taskTitle}`,
    "",
    "Agent output:",
    agentOutput.slice(0, 6000), // Cap to stay within token budget
  ].join("\n");
}

// ── Meeting Memory Extraction (Spec 18 / 05a Flow C) ──────

/**
 * Build the user-side prompt for meeting-based fact extraction, scoped to a
 * specific participant's role/name. Uses a larger context window (8k chars)
 * since meeting transcripts tend to be longer.
 */
export function buildMeetingExtractionPrompt(
  participantRole: string,
  participantName: string,
  transcript: string,
): string {
  return [
    `Participant role: ${participantRole}`,
    `Participant name: ${participantName}`,
    "",
    "Meeting transcript:",
    transcript.slice(0, 8000), // Larger cap for meeting context
  ].join("\n");
}
