/**
 * Meeting Memory Extraction — Spec 18 Phase 6 / Spec 05a Flow C
 *
 * Extracts factual memories from completed meetings and routes them to
 * relevant participants. Shared decisions get visibility: "shared".
 *
 * Container pattern: meeting:{meetingId}
 */

import type {
  Meeting,
  CompanySnapshot,
  MemoryUnit,
} from "@arceus/contracts";

// ── Transcript Assembly ────────────────────────────────────

/**
 * Build a compact textual transcript from a meeting's contributions,
 * synthesis, and resolution decisions. Used as input for the LLM
 * fact extractor.
 */
export function assembleMeetingTranscript(meeting: Meeting): string {
  const sections: string[] = [];

  sections.push(`# Meeting: ${meeting.title} (${meeting.type.replace(/_/g, " ")})`);
  sections.push(`Date: ${meeting.createdAt}`);
  sections.push("");

  // Contributions
  if (meeting.contributions.length > 0) {
    sections.push("## Contributions");
    for (const c of meeting.contributions) {
      sections.push(`### ${c.agentName} (${c.agentRole})`);
      if (c.contribution.whatIDid) sections.push(`Done: ${c.contribution.whatIDid}`);
      if (c.contribution.whatImDoing) sections.push(`Doing: ${c.contribution.whatImDoing}`);
      if (c.contribution.blockers) sections.push(`Blockers: ${c.contribution.blockers}`);
      if (c.contribution.learnings) sections.push(`Learnings: ${c.contribution.learnings}`);
      if (c.contribution.questionsForTeam) sections.push(`Questions: ${c.contribution.questionsForTeam}`);
      sections.push("");
    }
  }

  // Synthesis highlights
  if (meeting.synthesis) {
    const s = meeting.synthesis;
    if (s.conflicts.length > 0) {
      sections.push("## Conflicts Identified");
      for (const c of s.conflicts) {
        sections.push(`- [${c.severity}] ${c.description} (suggested: ${c.suggestedResolution})`);
      }
      sections.push("");
    }
    if (s.blockers.length > 0) {
      sections.push("## Blockers");
      for (const b of s.blockers) {
        sections.push(`- ${b.description} (suggested: ${b.suggestedAction})`);
      }
      sections.push("");
    }
    if (s.highlights.length > 0) {
      sections.push("## Highlights");
      for (const h of s.highlights) {
        sections.push(`- [${h.type}] ${h.description}`);
      }
      sections.push("");
    }
  }

  // Resolution decisions
  if (meeting.resolutions && meeting.resolutions.decisions.length > 0) {
    sections.push("## Decisions");
    for (const d of meeting.resolutions.decisions) {
      sections.push(`- [${d.action}] ${d.decision}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ── Extracted fact type (mirrors hippocampus ExtractedFact) ─

export interface MeetingExtractedFact {
  content: string;
  type: "static" | "dynamic" | "procedural";
  confidence: number;
  is_temporal: boolean;
  expiry_days: number | null;
  trigger?: string;
  action?: string;
}

/** LLM-powered meeting fact extractor — injected from API layer */
export type MeetingFactExtractor = (
  transcript: string,
  participantRole: string,
  participantName: string,
) => Promise<MeetingExtractedFact[]>;

// ── Per-Participant Extraction ─────────────────────────────

export interface MeetingMemoryResult {
  agentId: string;
  memories: MemoryUnit[];
}

/**
 * Extract memories from a completed meeting for each participant.
 *
 * - Runs LLM extraction per participant with role-scoped context
 * - Shared decisions get visibility: "team"
 * - Container: meeting:{meetingId}
 * - Source: "meeting"
 */
/**
 * Extract memories from a completed meeting for each participant.
 *
 * Runs LLM extraction per participant with role-scoped context.
 * Shared decisions get visibility "team", container: "meeting:{meetingId}".
 */
export async function extractMeetingMemories(
  meeting: Meeting,
  snap: CompanySnapshot,
  extractFacts: MeetingFactExtractor,
): Promise<MeetingMemoryResult[]> {
  const transcript = assembleMeetingTranscript(meeting);
  if (transcript.length < 50) return []; // Nothing meaningful to extract

  const results: MeetingMemoryResult[] = [];
  const now = new Date().toISOString();

  // Extract per participant
  for (const agentId of meeting.participantAgentIds) {
    const agent = snap.agents.find((a) => a.id === agentId);
    if (!agent) continue;

    let facts: MeetingExtractedFact[];
    try {
      facts = await extractFacts(transcript, agent.role, agent.name);
    } catch (err) {
      console.warn(`[MEETING-MEMORY] Extraction failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (facts.length === 0) continue;

    const memories: MemoryUnit[] = facts.map((fact) => ({
      id: `memory_${crypto.randomUUID()}`,
      companyId: snap.company.id,
      agentId,
      sourceTaskId: null,
      sourceArtifactId: null,
      type: fact.type === "procedural" ? "dynamic" : fact.type,
      visibility: isSharedDecision(fact) ? "team" : "private",
      source: "meeting",
      content: fact.content,
      summary: fact.content.slice(0, 200),
      confidence: fact.confidence,
      tags: ["meeting", `meeting:${meeting.id}`, meeting.type],
      createdAt: now,
      expiresAt: fact.is_temporal && fact.expiry_days
        ? new Date(Date.now() + fact.expiry_days * 24 * 60 * 60 * 1000).toISOString()
        : null,
    }));

    results.push({ agentId, memories });
  }

  return results;
}

/**
 * Determine if a fact represents a shared team decision.
 * Static facts with high confidence are typically team-wide decisions.
 */
function isSharedDecision(fact: MeetingExtractedFact): boolean {
  return fact.type === "static" && fact.confidence >= 0.8;
}
