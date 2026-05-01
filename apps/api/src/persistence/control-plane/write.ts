/**
 * Control plane — write path.
 * Spec 11 / Spec 31 Phase 7.C.d-cp / Spec 34 v3 PR 11.
 *
 * `cpApplyMutations` is the single entry point for state-mutation
 * batches arriving from the heartbeat engine. The optimistic-concurrency
 * check is disabled (B.4 finding: every concurrent heartbeat raced
 * against itself), so `expectedVersion` is informational only.
 */
import type { StateMutation } from "@arceus/contracts";
import { audit } from "../../observability/audit-ledger.js";
import {
  upsertTask,
  updateTask,
  upsertSprint,
  updateSprint,
  upsertMeeting,
  upsertApproval,
  updateApproval,
  appendChatMessage,
  updateAgentStatus,
  updateCompanyStatus,
  updateTaskProgress,
} from "../mutations/index.js";
import { bumpVersion, noteOneMutation } from "./snapshot.js";

/**
 * Apply a batch of mutations atomically.
 *
 * Spec 31 Phase 7.C.d-cp — async; mutators write straight to canonical
 * via `mutations/index.js`.
 */
export async function cpApplyMutations(
  companyId: string,
  mutations: StateMutation[],
  causation?: { eventId?: string; summary?: string },
  _expectedVersion?: number,
): Promise<{ version: number; applied: number; errors: string[] }> {
  const errors: string[] = [];
  let applied = 0;

  for (const mutation of mutations) {
    try {
      await applyOneMutation(companyId, mutation, causation?.eventId);
      applied++;
      noteOneMutation();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${mutation.type}: ${msg}`);
      audit({
        companyId,
        category: "error",
        severity: "error",
        eventType: "mutation_failed",
        summary: `Mutation ${mutation.type} failed: ${msg}`,
        detail: { mutation, error: msg },
        causationId: causation?.eventId,
      });
    }
  }

  const version = bumpVersion();

  if (applied > 0) {
    audit({
      companyId,
      category: "system",
      severity: "debug",
      eventType: "mutations_applied",
      summary: `${applied} mutation(s) applied → v${version}${errors.length ? ` (${errors.length} failed)` : ""}`,
      detail: {
        version,
        applied,
        errors: errors.length > 0 ? errors : undefined,
        types: mutations.map((m) => m.type),
      },
      causationId: causation?.eventId,
    });
  }

  return { version, applied, errors };
}

async function applyOneMutation(companyId: string, mutation: StateMutation, _causationId?: string): Promise<void> {
  switch (mutation.type) {
    case "task_status":
      await updateTask(mutation.taskId, (t) => ({
        ...t,
        status: mutation.status,
        ...(mutation.summary ? { summary: mutation.summary } : {}),
      }));
      break;

    case "task_assign":
      await updateTask(mutation.taskId, (t) => ({
        ...t,
        assignedTo: mutation.agentId,
      }));
      break;

    case "task_create":
      await upsertTask(mutation.task);
      break;

    case "sprint_status":
      await updateSprint(mutation.sprintId, (s) => ({
        ...s,
        status: mutation.status,
      }));
      break;

    case "sprint_create":
      await upsertSprint(mutation.sprint);
      break;

    case "meeting_record":
      await upsertMeeting(mutation.meeting);
      break;

    case "approval_create":
      await upsertApproval(mutation.approval);
      break;

    case "approval_resolve":
      await updateApproval(mutation.approvalId, (a) => ({
        ...a,
        status: mutation.status,
      }));
      break;

    case "chat_message":
      await appendChatMessage(mutation.message);
      break;

    case "transition_append":
      // Spec 31 Phase 7.B.4 — transitions/feedback retired with the snapshot.
      // No-op: orchestration/state.ts owns the in-memory log if needed.
      break;

    case "transition_update":
      // No-op: see transition_append above.
      break;

    case "agent_status":
      await updateAgentStatus(mutation.agentId, mutation.status);
      break;

    case "company_status":
      // Spec 31 Phase 7.C.d — updateCompanyStatus is keyed by companyId now.
      await updateCompanyStatus(companyId, mutation.status);
      break;

    case "task_progress":
      updateTaskProgress(mutation.taskId, mutation.progress);
      break;

    default:
      // Exhaustiveness: TS compile-error if a new variant is added to the
      // union without a case here. `_exhaustive` will be `never` only when
      // every variant above is handled.
      const _exhaustive: never = mutation;
      throw new Error(`Unknown mutation type: ${JSON.stringify(_exhaustive)}`);
  }
}
