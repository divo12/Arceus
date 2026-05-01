/**
 * Spec 22 / Spec 34 v3 PR 9 — Meeting graph events.
 */
import { graphStore, type GraphEdge, type GraphNode, type MeetingEntry } from "../graph-store.js";

/** Key ceremony types — these get their own graph nodes. */
const KEY_CEREMONY_TRIGGERS = new Map<string, string>([
  ["Sprint kickoff", "kickoff"],
  ["Engineering kickoff", "kickoff"],
  ["CTO Technical Plan Handoff", "handoff"],
  ["PM Acceptance Spec Handoff", "handoff"],
  ["CTO Implementation Approval", "cto_approval"],
  ["Board Handoff Approval", "board_approval"],
  ["Sprint Retrospective", "retrospective"],
]);

function detectCeremonyKind(summary: string): string | null {
  for (const [keyword, kind] of KEY_CEREMONY_TRIGGERS) {
    if (summary.includes(keyword)) return kind;
  }
  return null;
}

/** Record a meeting as its own graph node, linking it to the source task node if provided. */
export function emitGraphMeeting(
  sprintId: string,
  nodeId: string | null,
  meetingId: string,
  type: string,
  facilitatorRole: string,
  participantRoles: string[],
  summary: string,
  trigger: string,
  decisions: string[],
  memoryMods: string[],
  dynamic: boolean,
): void {
  const ceremonyKind = detectCeremonyKind(summary);
  const entry: MeetingEntry = {
    id: meetingId,
    type,
    title: summary.slice(0, 100),
    facilitatorRole,
    participantRoles,
    summary,
    trigger,
    isKeyCeremony: ceremonyKind !== null,
    ceremonyKind,
    decisions,
    memoryWrites: memoryMods,
    timestamp: new Date().toISOString(),
    dynamic,
  };

  // Every meeting gets its own graph node for visibility
  const meetingNode: GraphNode = {
    id: meetingId,
    taskId: meetingId,
    kind: "meeting",
    title: entry.title,
    assignedRole: facilitatorRole,
    status: "completed",
    statusHistory: [],
    inputArtifactIds: [],
    outputArtifactIds: [],
    inputContext: summary.slice(0, 200),
    stateDiff: null,
    fileChanges: [],
    decisions: [],
    beats: [],
    meetings: [entry],
    memoryWrites: [],
    reworkGroup: null,
    startedAt: entry.timestamp,
    completedAt: entry.timestamp,
  };
  const edges: GraphEdge[] = [];
  if (nodeId) {
    edges.push({
      id: `edge_meeting_${nodeId}_${meetingId}`,
      sourceNodeId: nodeId,
      targetNodeId: meetingId,
      type: "artifact_flow",
      label: ceremonyKind ?? type.replace(/_/g, " "),
      artifactId: null,
    });
  }
  graphStore.addNode(sprintId, meetingNode, edges);

  // Also record on the source node (for the Meetings tab)
  if (nodeId) {
    graphStore.addMeeting(sprintId, nodeId, entry);
  }
}
