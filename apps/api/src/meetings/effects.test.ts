/**
 * Tests for meetings/effects.ts — Spec 31 Phase 7.B.2.
 *
 * Verifies the orchestration logic in `applyMeetingEffects` (pre-resolves
 * agents per `assignedRole`, dispatches each task modification with
 * the agent map) and `deriveMeetingMemoryModifications` (resolves
 * unblock-task lookups via tasksRepo).
 *
 * Run: `cd apps/api && bun test src/meetings/effects.test.ts`
 */
import { describe, it, mock, expect } from "bun:test";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const AGENT_DEV_UUID = "22222222-2222-2222-2222-222222222222";
const AGENT_TESTER_UUID = "33333333-3333-3333-3333-333333333333";
const TASK_UUID = "44444444-4444-4444-4444-444444444444";

function makeAgentRow(role: string, id: string) {
  return {
    id,
    companyId: COMPANY_UUID,
    role,
    displayName: `Agent-${role}`,
    friendlyId: `agent_${role}_${id}`,
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
}

describe("applyMeetingEffects (B.2 read migration)", () => {
  it("pre-resolves the distinct assigned-role set with one agentsRepo lookup per role", async () => {
    const findAgentSpy = mock(async (_db: unknown, _companyId: string, role: string) => {
      if (role === "developer") return makeAgentRow("developer", AGENT_DEV_UUID);
      if (role === "tester") return makeAgentRow("tester", AGENT_TESTER_UUID);
      return null;
    });
    mock.module("@arceus/db/src/repos/agents.js", () => ({ 
      findAgentByRole: findAgentSpy, listAgentsByCompany: async () => [], findAgentById: async () => null }));
    mock.module("@arceus/db/src/repos/tasks/index.js", () => ({
      findByIdHydrated: async () => null,
      listByCompanyHydrated: async () => [],
    }));
    mock.module("../memory/operations.js", () => ({
      enrichRoleMemory: async () => undefined,
      clearRoleBlockers: async () => undefined,
    }));
    mock.module("../persistence/store.js", () => ({
      updateTask: () => undefined,
    }));
    mock.module("../observability/audit-ledger.js", () => ({ audit: () => undefined }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: () => undefined }));
    mock.module("@arceus/db", () => ({ getDb: () => ({}) }));

    const { applyMeetingEffects } = await import(`./effects.js?t=${Date.now()}`);
    await applyMeetingEffects(
      COMPANY_UUID,
      [
        // Two mods both assigned to developer + one to tester + one with no
        // role (cancel) — distinct set is {developer, tester}, not 4 lookups.
        { taskId: "t1", modificationType: "assign", details: "x", assignedRole: "developer" },
        { taskId: "t2", modificationType: "reassign", details: "x", assignedRole: "developer" },
        { taskId: "t3", modificationType: "assign", details: "x", assignedRole: "tester" },
        { taskId: "t4", modificationType: "cancel", details: "x" },
      ],
      [],
    );

    expect(findAgentSpy).toHaveBeenCalledTimes(2);
    const calledRoles = findAgentSpy.mock.calls.map((c) => (c as unknown as [unknown, string, string])[2]).sort();
    expect(calledRoles).toEqual(["developer", "tester"]);
  });

  it("dispatches memory modifications fire-and-forget without awaiting per-mod persistence", async () => {
    mock.module("@arceus/db/src/repos/agents.js", () => ({ 
      findAgentByRole: async () => null, listAgentsByCompany: async () => [], findAgentById: async () => null }));
    mock.module("@arceus/db/src/repos/tasks/index.js", () => ({
      findByIdHydrated: async () => null,
      listByCompanyHydrated: async () => [],
    }));
    const enrichSpy = mock(async () => undefined);
    mock.module("../memory/operations.js", () => ({
      enrichRoleMemory: enrichSpy,
      clearRoleBlockers: async () => undefined,
    }));
    mock.module("../persistence/store.js", () => ({ updateTask: () => undefined }));
    mock.module("../observability/audit-ledger.js", () => ({ audit: () => undefined }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: () => undefined }));
    mock.module("@arceus/db", () => ({ getDb: () => ({}) }));

    const { applyMeetingEffects } = await import(`./effects.js?t=${Date.now()}`);
    const start = Date.now();
    await applyMeetingEffects(
      COMPANY_UUID,
      [],
      [
        { role: "developer", modificationType: "active_pattern", content: "Use repository pattern for data access" },
        { role: "developer", modificationType: "recent_learning", content: "Magic links need a 7-day token" },
        { role: "tester", modificationType: "important_decision", content: "Ship without email verification" },
      ],
    );
    const elapsed = Date.now() - start;

    /** Fire-and-forget means we returned immediately; per-mod persistence
     *  fires on the microtask queue. We've returned in <50ms even with 3 mods. */
    expect(elapsed).toBeLessThan(50);

    /** Wait one microtask flush to let the void-promise chain run. */
    await new Promise((r) => setTimeout(r, 0));
    expect(enrichSpy).toHaveBeenCalledTimes(3);
  });
});

describe("deriveMeetingMemoryModifications (B.2 read migration)", () => {
  it("resolves unblock-task assignedRole via tasksRepo and emits clear_blocker mods", async () => {
    const findByIdSpy = mock(async (_db: unknown, taskId: string) => {
      if (taskId === TASK_UUID) {
        return {
          id: taskId,
          companyId: COMPANY_UUID,
          assignedRole: "developer",
          assignedAgentId: AGENT_DEV_UUID,
          title: "fix bug",
          kind: "bug_fix",
          status: "blocked",
        } as unknown;
      }
      return null;
    });
    mock.module("@arceus/db/src/repos/tasks/index.js", () => ({
      findByIdHydrated: findByIdSpy,
      listByCompanyHydrated: async () => [],
    }));
    mock.module("@arceus/db/src/repos/agents.js", () => ({  findAgentByRole: async () => null, listAgentsByCompany: async () => [], findAgentById: async () => null }));
    mock.module("../memory/operations.js", () => ({
      enrichRoleMemory: async () => undefined,
      clearRoleBlockers: async () => undefined,
    }));
    mock.module("../persistence/store.js", () => ({ updateTask: () => undefined }));
    mock.module("../observability/audit-ledger.js", () => ({ audit: () => undefined }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: () => undefined }));
    mock.module("@arceus/db", () => ({ getDb: () => ({}) }));

    const { deriveMeetingMemoryModifications } = await import(`./effects.js?t=${Date.now()}`);
    const result = await deriveMeetingMemoryModifications({
      agenda: [],
      participantRoles: [],
      taskModifications: [
        { taskId: TASK_UUID, modificationType: "unblock", details: "fixed in PR #12" },
        /** A non-unblock mod — should not trigger a task lookup. */
        { taskId: "other", modificationType: "cancel", details: "no-op" },
      ],
    });

    /** One repo lookup, only for the unblock mod. */
    expect(findByIdSpy).toHaveBeenCalledTimes(1);
    expect(findByIdSpy.mock.calls[0]).toEqual([{}, TASK_UUID]);

    const clearBlockerMods = result.filter((m: { modificationType: string }) => m.modificationType === "clear_blocker");
    expect(clearBlockerMods).toHaveLength(1);
    expect(clearBlockerMods[0].role).toBe("developer");
    expect(clearBlockerMods[0].content).toBe("fixed in PR #12");
  });

  it("dedupes by (role, modificationType, content) tuple", async () => {
    mock.module("@arceus/db/src/repos/tasks/index.js", () => ({
      findByIdHydrated: async () => null,
      listByCompanyHydrated: async () => [],
    }));
    mock.module("@arceus/db/src/repos/agents.js", () => ({  findAgentByRole: async () => null, listAgentsByCompany: async () => [], findAgentById: async () => null }));
    mock.module("../memory/operations.js", () => ({
      enrichRoleMemory: async () => undefined,
      clearRoleBlockers: async () => undefined,
    }));
    mock.module("../persistence/store.js", () => ({ updateTask: () => undefined }));
    mock.module("../observability/audit-ledger.js", () => ({ audit: () => undefined }));
    mock.module("../orchestration/reactive.js", () => ({ emitReactive: () => undefined }));
    mock.module("@arceus/db", () => ({ getDb: () => ({}) }));

    const { deriveMeetingMemoryModifications } = await import(`./effects.js?t=${Date.now()}`);
    const result = await deriveMeetingMemoryModifications({
      agenda: [],
      participantRoles: [],
      memoryModifications: [
        { role: "developer", modificationType: "current_focus", content: "ship X" },
        /** Exact dup — should collapse. */
        { role: "developer", modificationType: "current_focus", content: "ship X" },
        /** Different content — kept. */
        { role: "developer", modificationType: "current_focus", content: "ship Y" },
      ],
    });

    const focusMods = result.filter((m: { modificationType: string }) => m.modificationType === "current_focus");
    expect(focusMods).toHaveLength(2);
  });
});
