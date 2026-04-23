import type { AgentIdentity, Approval } from "@arceus/contracts";
import { getAgentByRole } from "@arceus/task-engine";
import { getSnapshot, upsertApproval, updateApproval } from "../persistence/store.js";
import { emitReactive } from "../orchestration/reactive.js";

// ─────────────────────────────────────────────────────────────────────────────
// Generic approval request
// ─────────────────────────────────────────────────────────────────────────────

/** Input for {@link requestApproval} — generalized board approval request, agnostic to role or task kind. */
export interface RequestApprovalInput {
  type: Approval["type"];
  requestedByRole: AgentIdentity["role"];
  title: string;
  description: string;
  meetingId?: string | null;
  agendaItemId?: string | null;
}

/**
 * Create a pending board approval on behalf of any role.
 *
 * Generalizes the former role-specific helpers (e.g. `createMarketingExternalApproval`) so
 * any agent can request approval via the `approval_request` MCP tool. Returns `null` if the
 * requesting role has no provisioned agent in the current snapshot.
 */
export function requestApproval(input: RequestApprovalInput): Approval | null {
  const snapshot = getSnapshot();
  const requestor = getAgentByRole(snapshot, input.requestedByRole);
  if (!requestor) {
    return null;
  }

  const approval: Approval = {
    id: `approval_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    type: input.type,
    status: "pending",
    title: input.title,
    description: input.description,
    requestedByAgentId: requestor.id,
    meetingId: input.meetingId ?? null,
    agendaItemId: input.agendaItemId ?? null,
    resolutionSummary: null,
  };

  upsertApproval(approval);
  return approval;
}

/** Approve all pending board approvals and emit reactive events to requestors. */
export function approvePendingBoardApprovals() {
  const pendingApprovals = getSnapshot().approvals.filter((approval) => approval.status === "pending");

  for (const approval of pendingApprovals) {
    updateApproval(approval.id, (current) => ({
      ...current,
      status: current.type === "external_action" ? "approved" : "applied",
      resolutionSummary: current.type === "external_action"
        ? "Board approved the recommended external action. No automated outbound action was executed by Arceus."
        : "Board approved the pending request during CTO handoff review.",
    }));

    const snap = getSnapshot();
    const requestor = snap.agents.find((a: { id: string; role: AgentIdentity["role"] }) => a.id === approval.requestedByAgentId);
    if (requestor) {
      emitReactive(requestor.role, "approval_granted");
    }
  }

  return pendingApprovals;
}
