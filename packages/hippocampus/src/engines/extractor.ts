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

export const MEETING_EXTRACTION_PROMPT = `You are a memory extraction system for an AI software company.

Analyze the meeting transcript and extract facts worth remembering for a specific participant's future work.

For each fact, classify:
- type: "static" (permanent architectural/tooling decisions), "dynamic" (temporary context that may change), or "procedural" (behavioral pattern / process the team agreed on)
- confidence: 0.0 to 1.0 — how certain/agreed-upon this fact is
- is_temporal: true if the fact has a natural expiry
- expiry_days: if is_temporal, how many days until it expires; null otherwise

Rules:
- Extract 2-6 facts per participant. Quality over quantity.
- Focus on facts RELEVANT TO THIS SPECIFIC PARTICIPANT based on their role.
- Static facts: technology decisions ("Use Redis for caching"), architecture choices, API contracts agreed upon
- Dynamic facts: sprint-specific assignments, temporary workarounds, deadline commitments
- Procedural facts: process agreements, workflow changes. MUST include separate "trigger" and "action" fields.
- DO NOT extract the meeting title or generic meeting metadata
- Each fact should be self-contained and actionable without additional context
- Decisions that affect the whole team should still be extracted, but scoped to this participant's perspective`;

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
