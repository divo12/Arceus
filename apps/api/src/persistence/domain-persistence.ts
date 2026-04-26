/**
 * Domain dual-write helpers — Phase 4B/C/D.
 *
 * Same shape as `task-persistence.ts` and `company-persistence.ts`, but
 * one module per remaining domain would be three near-identical files.
 * Consolidated here so the next dual-write addition (approvals, board
 * messages…) is one more function in this file rather than a fresh
 * module.
 *
 * Each `persistX(id)` follows the rule:
 *   1. Look up the entity in the in-memory store (snapshot)
 *   2. Call the matching `upsertX` repo function
 *   3. Log + swallow any postgres error code so the route response
 *      is never blocked. Store remains authoritative; the DB row
 *      converges on the next mutation if a write transiently fails.
 */
import { getDb } from "@arceus/db";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as artifactsRepo from "@arceus/db/src/repos/artifacts.js";
import * as meetingsRepo from "@arceus/db/src/repos/meetings.js";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import postgres from "postgres";
import { getSnapshot } from "./store.js";
import type { Artifact as ContractArtifact } from "@arceus/contracts";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

// ── Sprints (Phase 4B) ────────────────────────────────────────

export async function persistSprint(sprintId: string): Promise<void> {
  const sprint = getSnapshot().sprints.find((s) => s.id === sprintId);
  if (!sprint) return;
  try {
    await sprintsRepo.upsertSprint(getDb(), sprint);
  } catch (err) {
    console.warn(`[sprints] DB sync skipped for ${sprintId} (pg=${pgErrorCode(err)})`);
  }
}

// ── Artifacts (Phase 4C) ──────────────────────────────────────

/**
 * Artifacts live in the runtime artifact array (`orchestration/state.ts`),
 * not the snapshot, so the helper accepts the artifact directly rather
 * than looking it up. Callers pass the same shape they'd add to the store.
 */
export async function persistArtifact(artifact: ContractArtifact): Promise<void> {
  try {
    await artifactsRepo.upsertArtifact(getDb(), artifact);
  } catch (err) {
    console.warn(`[artifacts] DB sync skipped for ${artifact.id} (pg=${pgErrorCode(err)})`);
  }
}

// ── Meetings (Phase 4D) ───────────────────────────────────────

export async function persistMeeting(meetingId: string): Promise<void> {
  const meeting = getSnapshot().meetings.find((m) => m.id === meetingId);
  if (!meeting) return;
  try {
    await meetingsRepo.upsertMeeting(getDb(), meeting);
  } catch (err) {
    console.warn(`[meetings] DB sync skipped for ${meetingId} (pg=${pgErrorCode(err)})`);
  }
}

// ── Approvals (Phase 4E) ──────────────────────────────────────

export async function persistApproval(approvalId: string): Promise<void> {
  const approval = getSnapshot().approvals.find((a) => a.id === approvalId);
  if (!approval) return;
  try {
    await approvalsRepo.upsertApproval(getDb(), approval);
  } catch (err) {
    console.warn(`[approvals] DB sync skipped for ${approvalId} (pg=${pgErrorCode(err)})`);
  }
}

// ── Agents (Phase 5) ──────────────────────────────────────────

/**
 * Dual-writes every agent in the snapshot. Called from `applyStrategy`
 * once the org hierarchy is known. Idempotent — uses the unique
 * (company_id, role) index for the upsert target.
 */
export async function persistAgents(): Promise<void> {
  const snapshot = getSnapshot();
  if (snapshot.agents.length === 0) return;
  const db = getDb();
  for (const agent of snapshot.agents) {
    try {
      await agentsRepo.upsertAgent(db, agent);
    } catch (err) {
      console.warn(`[agents] DB sync skipped for ${agent.id} (pg=${pgErrorCode(err)})`);
    }
  }
}

// ── Board messages / chat (Phase 4E) ──────────────────────────

export async function persistChatMessage(messageId: string): Promise<void> {
  const message = getSnapshot().chatMessages.find((m) => m.id === messageId);
  if (!message) return;
  try {
    await boardMessagesRepo.upsertChatMessage(getDb(), message);
  } catch (err) {
    console.warn(`[chat] DB sync skipped for ${messageId} (pg=${pgErrorCode(err)})`);
  }
}
