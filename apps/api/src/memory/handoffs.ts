import type { AgentIdentity, Approval } from "@arceus/contracts";
import { parseRoleStrict } from "@arceus/contracts";
import { getDb, type DbClient } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";
import { emitReactive } from "../orchestration/reactive.js";

// ─────────────────────────────────────────────────────────────────────────────
// Generic approval request — Spec 31 Phase 7.B.1: DB-direct, no snapshot.
// ─────────────────────────────────────────────────────────────────────────────

/** Input for {@link requestApproval} — generalised board approval request. */
export interface RequestApprovalInput {
  type: Approval["type"];
  requestedByRole: AgentIdentity["role"];
  title: string;
  description: string;
  meetingId?: string | null;
  agendaItemId?: string | null;
}

/**
 * Create a pending board approval on behalf of any role. Looks up the
 * requesting agent by `(companyId, role)` and persists the approval
 * via `approvalsRepo.upsertApproval`. Returns `null` if the role has
 * no provisioned agent for the company.
 *
 * `db` is optional — defaults to `getDb()` for the common case;
 * override only when you need a transaction-scoped client.
 */
export async function requestApproval(
  companyId: string,
  input: RequestApprovalInput,
  db: DbClient = getDb(),
): Promise<Approval | null> {
  const requestor = await agentsRepo.findAgentByRole(db, companyId, input.requestedByRole);
  if (!requestor) return null;

  const approval: Approval = {
    id: `approval_${crypto.randomUUID()}`,
    companyId,
    type: input.type,
    status: "pending",
    title: input.title,
    description: input.description,
    requestedByAgentId: requestor.id,
    meetingId: input.meetingId ?? null,
    agendaItemId: input.agendaItemId ?? null,
    resolutionSummary: null,
  };

  await approvalsRepo.upsertApproval(db, approval);
  return approval;
}

/**
 * Approve all pending board approvals for a company and emit
 * reactive events to the requestors. Returns the list of approvals
 * that were transitioned (status was `pending` at the start).
 */
export async function approvePendingBoardApprovals(
  companyId: string,
  db: DbClient = getDb(),
): Promise<Approval[]> {
  const pendingRows = await approvalsRepo.listApprovalsByCompany(db, companyId, "pending");
  const pending = pendingRows.map(approvalsRepo.rowToApproval);

  for (const approval of pending) {
    const nextStatus: Approval["status"] = approval.type === "external_action" ? "approved" : "applied";
    const resolutionSummary = approval.type === "external_action"
      ? "Board approved the recommended external action. No automated outbound action was executed by Arceus."
      : "Board approved the pending request during CTO handoff review.";

    await approvalsRepo.upsertApproval(db, {
      ...approval,
      status: nextStatus,
      resolutionSummary,
    });

    if (approval.requestedByAgentId) {
      const requestor = await agentsRepo.findAgentById(db, approval.requestedByAgentId);
      if (requestor) {
        // Use the approval row's companyId (also matches `companyId` param
        // of approvePendingBoardApprovals) — fires the event on the right
        // tenant rather than whoever the singleton points at.
        emitReactive(approval.companyId, parseRoleStrict(requestor.role), "approval_granted");
      }
    }
  }

  return pending;
}
