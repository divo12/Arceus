/**
 * Drift test — Spec 31 Phase 8.5.
 *
 * Round-trips a canonical fixture per hydrated entity through
 * `xToInsert` → simulated DB row → `rowToX` and asserts the output
 * matches the input. If a future PR adds a field to a Zod contract
 * schema but forgets to wire it through `xToInsert` or `rowToX`, this
 * test fails at CI before the change reaches review.
 *
 * Why fixture FKs use raw uuids (not friendly strings):
 *   The repo layer stores ENTITY ids via `friendly_id` so they
 *   round-trip losslessly, but FK columns (`companyId`,
 *   `requestedByAgentId`, …) hold only the uuid form. A friendly FK
 *   would land on disk as a hashed uuid and hydrate back as that uuid,
 *   not the original string. Using uuid-form FKs in the fixture sidesteps
 *   that asymmetry — the test is for "field map present", not "friendly
 *   FK aliasing".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  approvalSchema,
  artifactSchema,
  meetingSchema,
  sprintSchema,
  type Approval,
  type Artifact,
  type Meeting,
  type Sprint,
} from "@arceus/contracts";

import { rowToSprint, sprintToInsert } from "../src/repos/sprints.js";
import { rowToApproval, approvalToInsert } from "../src/repos/approvals.js";
import { rowToArtifact, artifactToInsert } from "../src/repos/artifacts.js";
import { rowToMeeting, meetingToInsert } from "../src/repos/meetings.js";

import type { Sprint as SprintRow } from "../src/repos/sprints.js";
import type { Approval as ApprovalRow } from "../src/repos/approvals.js";
import type { Artifact as ArtifactRow } from "../src/repos/artifacts.js";
import type { Meeting as MeetingRow } from "../src/repos/meetings.js";

// ── Fixtures ─────────────────────────────────────────────────────
//
// One fixture per entity. Every Zod-schema field must be set to a
// non-default value so the round-trip detects fields silently dropped
// by an incomplete `xToInsert`. FK columns use raw uuids per the file
// header note.

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const AGENT_UUID = "22222222-2222-2222-2222-222222222222";
const SPRINT_UUID = "33333333-3333-3333-3333-333333333333";
const TASK_UUID = "44444444-4444-4444-4444-444444444444";
const ARTIFACT_UUID = "55555555-5555-5555-5555-555555555555";
const MEETING_UUID = "66666666-6666-6666-6666-666666666666";
const STRATEGY_UUID = "77777777-7777-7777-7777-777777777777";

const NOW_ISO = "2026-01-01T00:00:00.000Z";
const NOW_DATE = new Date(NOW_ISO);

function sprintFixture(): Sprint {
  // reviewState left null — its inner schema is large and the round-trip
  // assertion is field-presence, not deep-shape. The non-null path is
  // exercised by the dedicated sprints.test.ts.
  return sprintSchema.parse({
    id: SPRINT_UUID,
    companyId: COMPANY_UUID,
    strategyId: STRATEGY_UUID,
    number: 3,
    title: "Sprint 3 — drift fixture",
    goal: "Round-trip every Zod field",
    status: "executing",
    plannedByAgentId: AGENT_UUID,
    summary: "fixture summary",
    reviewState: null,
    startedAt: NOW_ISO,
    completedAt: null,
    createdAt: NOW_ISO,
  });
}

function approvalFixture(): Approval {
  return approvalSchema.parse({
    id: "appr_drift",
    companyId: COMPANY_UUID,
    type: "strategy",
    status: "pending",
    title: "Drift approval",
    description: "Fixture desc",
    requestedByAgentId: AGENT_UUID,
    meetingId: MEETING_UUID,
    agendaItemId: "agenda_drift_1",
    resolutionSummary: null,
  });
}

function artifactFixture(): Artifact {
  return artifactSchema.parse({
    id: "art_drift",
    companyId: COMPANY_UUID,
    sprintId: SPRINT_UUID,
    taskId: TASK_UUID,
    agentId: AGENT_UUID,
    kind: "implementation",
    title: "Drift artifact",
    summary: "fixture summary",
    location: "src/feature.ts",
    contentType: "text/markdown",
    metadata: { reviewer: "tester", commit: "abc123" },
    createdAt: NOW_ISO,
  });
}

function meetingFixture(): Meeting {
  return meetingSchema.parse({
    id: "mtg_drift",
    companyId: COMPANY_UUID,
    scheduleId: null,
    facilitatorAgentId: AGENT_UUID,
    type: "daily_sync",
    status: "completed",
    title: "Drift sync",
    participantAgentIds: [AGENT_UUID],
    contributions: [],
    synthesis: null,
    resolutions: null,
    brief: null,
    healthSnapshot: null,
    createdAt: NOW_ISO,
    completedAt: null,
  });
}

// ── Round-trip helpers ──────────────────────────────────────────
//
// `xToInsert` returns NewX (insert payload, no DB-generated columns).
// To call `rowToX`, we synthesize a full Row by overlaying the insert
// fields onto stub timestamp + version columns the DB would fill in.
// Stubs need to round-trip back to the contract values, so e.g.
// `createdAt: NOW_DATE` is paired with `createdAt: NOW_ISO` in the
// fixture.

function asSprintRow(insert: ReturnType<typeof sprintToInsert>): SprintRow {
  return {
    ...insert,
    sprintNumber: insert.sprintNumber ?? null,
    title: insert.title ?? null,
    goal: insert.goal ?? null,
    status: insert.status ?? "planning",
    summary: insert.summary ?? null,
    strategyId: insert.strategyId ?? null,
    plannedByAgentId: insert.plannedByAgentId ?? null,
    reviewState: insert.reviewState ?? null,
    friendlyId: insert.friendlyId ?? null,
    startedAt: insert.startedAt ?? null,
    endedAt: insert.endedAt ?? null,
    createdAt: NOW_DATE,
    updatedAt: NOW_DATE,
  } as SprintRow;
}

function asApprovalRow(insert: ReturnType<typeof approvalToInsert>): ApprovalRow {
  return {
    ...insert,
    friendlyId: insert.friendlyId ?? null,
    description: insert.description ?? null,
    meetingId: insert.meetingId ?? null,
    agendaItemId: insert.agendaItemId ?? null,
    resolutionSummary: insert.resolutionSummary ?? null,
    requestedByAgentId: insert.requestedByAgentId ?? null,
    requestedByRole: null,
    severity: insert.severity ?? "medium",
    payload: insert.payload ?? {},
    decision: null,
    decisionNote: null,
    decidedAt: null,
    decidedByUserId: null,
    expiresAt: null,
    status: insert.status ?? "pending",
    kind: insert.kind ?? "strategy",
    createdAt: NOW_DATE,
    updatedAt: NOW_DATE,
  } as ApprovalRow;
}

function asArtifactRow(insert: ReturnType<typeof artifactToInsert>): ArtifactRow {
  return {
    ...insert,
    friendlyId: insert.friendlyId ?? null,
    sprintId: insert.sprintId ?? null,
    taskId: insert.taskId ?? null,
    agentId: insert.agentId ?? null,
    agentRole: insert.agentRole ?? null,
    contentType: insert.contentType ?? null,
    summary: insert.summary ?? null,
    location: insert.location ?? null,
    content: insert.content ?? null,
    metadata: insert.metadata ?? {},
    kind: insert.kind ?? "output",
    createdAt: NOW_DATE,
  } as ArtifactRow;
}

function asMeetingRow(insert: ReturnType<typeof meetingToInsert>): MeetingRow {
  return {
    ...insert,
    friendlyId: insert.friendlyId ?? null,
    scheduleId: insert.scheduleId ?? null,
    sprintId: insert.sprintId ?? null,
    facilitatorAgentId: insert.facilitatorAgentId ?? null,
    summary: insert.summary ?? null,
    title: insert.title ?? null,
    completedAt: insert.completedAt ?? null,
    body: insert.body ?? {},
    status: insert.status ?? "open",
    kind: insert.kind ?? "daily_sync",
    createdAt: NOW_DATE,
    updatedAt: NOW_DATE,
  } as MeetingRow;
}

// ── Tests ────────────────────────────────────────────────────────

describe("drift: every contract field round-trips through repo helpers", () => {
  it("Sprint", () => {
    const original = sprintFixture();
    const insert = sprintToInsert(original);
    const restored = rowToSprint(asSprintRow(insert));
    assert.deepEqual(restored, original);
  });

  it("Approval", () => {
    const original = approvalFixture();
    const insert = approvalToInsert(original);
    const restored = rowToApproval(asApprovalRow(insert));
    assert.deepEqual(restored, original);
  });

  it("Artifact", () => {
    const original = artifactFixture();
    const insert = artifactToInsert(original);
    const restored = rowToArtifact(asArtifactRow(insert));
    assert.deepEqual(restored, original);
  });

  it("Meeting", () => {
    const original = meetingFixture();
    const insert = meetingToInsert(original);
    const restored = rowToMeeting(asMeetingRow(insert));
    assert.deepEqual(restored, original);
  });
});
