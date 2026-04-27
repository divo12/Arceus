/**
 * Tests for memory/handoffs.ts — Spec 31 Phase 7.B.1.
 *
 * Strategy: Bun's `mock.module()` replaces the agentsRepo +
 * approvalsRepo + reactive modules so the migrated functions
 * exercise their orchestration logic without a real DB. The repos'
 * own row-roundtrip is covered by the drift test.
 *
 * Run: `cd apps/api && bun test src/memory/handoffs.test.ts`
 */
import { describe, it, mock, expect } from "bun:test";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const AGENT_UUID = "22222222-2222-2222-2222-222222222222";
const FAKE_DB = {} as never;

const FAKE_AGENT_ROW = {
  id: AGENT_UUID,
  companyId: COMPANY_UUID,
  role: "marketing",
  displayName: "Parker",
  friendlyId: `agent_marketing_${AGENT_UUID}`,
  title: "",
  profile: "",
  capabilities: [],
  soulPromptRef: null,
  soul: {},
  managerAgentId: null,
  reportAgentIds: [],
  status: "idle",
  lastHeartbeatAt: null,
  isInternal: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makePendingApprovalRow(overrides: Partial<{ type: string; requestedByAgentId: string | null }> = {}) {
  return {
    id: AGENT_UUID,
    companyId: COMPANY_UUID,
    kind: overrides.type ?? "external_action",
    friendlyId: "appr_drift",
    type: overrides.type ?? "external_action",
    status: "pending",
    title: "fixture",
    description: "",
    severity: "medium",
    requestedByAgentId: overrides.requestedByAgentId ?? AGENT_UUID,
    requestedByRole: null,
    meetingId: null,
    agendaItemId: null,
    resolutionSummary: null,
    payload: {},
    decision: null,
    decisionNote: null,
    decidedAt: null,
    decidedByUserId: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("requestApproval", () => {
  it("returns null when no agent matches the requesting role", async () => {
    const upsertSpy = mock(async (_db: unknown, a: unknown) => a);
    mock.module("@arceus/db/src/repos/agents.js", () => ({
      findAgentByRole: async () => null,
      findAgentById: async () => null,
    }));
    mock.module("@arceus/db/src/repos/approvals.js", () => ({
      upsertApproval: upsertSpy,
      listApprovalsByCompany: async () => [],
      rowToApproval: (row: unknown) => row,
    }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: () => {} }));

    const { requestApproval } = await import(`./handoffs.js?t=${Date.now()}`);
    const result = await requestApproval(
      COMPANY_UUID,
      {
        type: "strategy",
        requestedByRole: "marketing",
        title: "Approve campaign",
        description: "External campaign launch",
      },
      FAKE_DB,
    );

    expect(result).toBeNull();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("creates a pending approval with the resolved requestor when the agent exists", async () => {
    const upsertSpy = mock(async (_db: unknown, a: unknown) => a);
    mock.module("@arceus/db/src/repos/agents.js", () => ({
      findAgentByRole: async (_db: unknown, companyId: string, role: string) => {
        expect(companyId).toBe(COMPANY_UUID);
        expect(role).toBe("marketing");
        return FAKE_AGENT_ROW;
      },
      findAgentById: async () => null,
    }));
    mock.module("@arceus/db/src/repos/approvals.js", () => ({
      upsertApproval: upsertSpy,
      listApprovalsByCompany: async () => [],
      rowToApproval: (row: unknown) => row,
    }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: () => {} }));

    const { requestApproval } = await import(`./handoffs.js?t=${Date.now()}`);
    const result = await requestApproval(
      COMPANY_UUID,
      {
        type: "external_action",
        requestedByRole: "marketing",
        title: "Email blast",
        description: "Promote launch",
        meetingId: "mtg_abc",
        agendaItemId: "agenda_1",
      },
      FAKE_DB,
    );

    expect(result).not.toBeNull();
    expect(result?.type).toBe("external_action");
    expect(result?.status).toBe("pending");
    expect(result?.companyId).toBe(COMPANY_UUID);
    expect(result?.requestedByAgentId).toBe(AGENT_UUID);
    expect(result?.meetingId).toBe("mtg_abc");
    expect(result?.agendaItemId).toBe("agenda_1");
    expect(result?.resolutionSummary).toBeNull();

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const persistedApproval = upsertSpy.mock.calls[0][1] as { id: string; status: string };
    expect(persistedApproval.id).toBe(result!.id);
    expect(persistedApproval.status).toBe("pending");
  });
});

describe("approvePendingBoardApprovals", () => {
  it("transitions external_action approvals to 'approved' with the matching summary and emits reactive", async () => {
    const upsertSpy = mock(async (_db: unknown, a: unknown) => a);
    const reactiveSpy = mock((_role: string, _event: string) => {});
    mock.module("@arceus/db/src/repos/agents.js", () => ({
      findAgentByRole: async () => null,
      findAgentById: async () => FAKE_AGENT_ROW,
    }));
    mock.module("@arceus/db/src/repos/approvals.js", () => ({
      upsertApproval: upsertSpy,
      listApprovalsByCompany: async () => [makePendingApprovalRow({ type: "external_action" })],
      rowToApproval: (row: ReturnType<typeof makePendingApprovalRow>) => ({
        id: row.friendlyId,
        companyId: row.companyId,
        type: row.type as "external_action",
        status: row.status as "pending",
        title: row.title,
        description: row.description,
        requestedByAgentId: row.requestedByAgentId,
        meetingId: row.meetingId,
        agendaItemId: row.agendaItemId,
        resolutionSummary: row.resolutionSummary,
      }),
    }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: reactiveSpy }));

    const { approvePendingBoardApprovals } = await import(`./handoffs.js?t=${Date.now()}`);
    const transitioned = await approvePendingBoardApprovals(COMPANY_UUID, FAKE_DB);

    expect(transitioned).toHaveLength(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const written = upsertSpy.mock.calls[0][1] as { status: string; resolutionSummary: string | null };
    expect(written.status).toBe("approved");
    expect(written.resolutionSummary).toMatch(/external action/i);

    expect(reactiveSpy).toHaveBeenCalledTimes(1);
    expect(reactiveSpy.mock.calls[0]).toEqual(["marketing", "approval_granted"]);
  });

  it("transitions non-external approvals to 'applied' and skips reactive when requestedByAgentId is null", async () => {
    const upsertSpy = mock(async (_db: unknown, a: unknown) => a);
    const reactiveSpy = mock((_role: string, _event: string) => {});
    mock.module("@arceus/db/src/repos/agents.js", () => ({
      findAgentByRole: async () => null,
      findAgentById: async () => null,
    }));
    mock.module("@arceus/db/src/repos/approvals.js", () => ({
      upsertApproval: upsertSpy,
      listApprovalsByCompany: async () => [makePendingApprovalRow({ type: "strategy", requestedByAgentId: null })],
      rowToApproval: (row: ReturnType<typeof makePendingApprovalRow>) => ({
        id: row.friendlyId,
        companyId: row.companyId,
        type: row.type as "strategy",
        status: row.status as "pending",
        title: row.title,
        description: row.description,
        requestedByAgentId: row.requestedByAgentId,
        meetingId: null,
        agendaItemId: null,
        resolutionSummary: null,
      }),
    }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: reactiveSpy }));

    const { approvePendingBoardApprovals } = await import(`./handoffs.js?t=${Date.now()}`);
    const transitioned = await approvePendingBoardApprovals(COMPANY_UUID, FAKE_DB);

    expect(transitioned).toHaveLength(1);
    const written = upsertSpy.mock.calls[0][1] as { status: string; resolutionSummary: string | null };
    expect(written.status).toBe("applied");
    expect(written.resolutionSummary).toMatch(/CTO handoff/i);
    expect(reactiveSpy).not.toHaveBeenCalled();
  });

  it("returns an empty array and writes nothing when no approvals are pending", async () => {
    const upsertSpy = mock(async (_db: unknown, a: unknown) => a);
    mock.module("@arceus/db/src/repos/agents.js", () => ({
      findAgentByRole: async () => null,
      findAgentById: async () => null,
    }));
    mock.module("@arceus/db/src/repos/approvals.js", () => ({
      upsertApproval: upsertSpy,
      listApprovalsByCompany: async () => [],
      rowToApproval: (row: unknown) => row,
    }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: () => {} }));

    const { approvePendingBoardApprovals } = await import(`./handoffs.js?t=${Date.now()}`);
    const transitioned = await approvePendingBoardApprovals(COMPANY_UUID, FAKE_DB);

    expect(transitioned).toHaveLength(0);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
