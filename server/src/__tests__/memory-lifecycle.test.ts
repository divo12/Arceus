import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE = process.env.PAPERCLIP_HIPPOCAMPUS_MODE;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE === undefined) delete process.env.PAPERCLIP_HIPPOCAMPUS_MODE;
  else process.env.PAPERCLIP_HIPPOCAMPUS_MODE = ORIGINAL_PAPERCLIP_HIPPOCAMPUS_MODE;
});

describe("memory lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns null when hippocampus mode is off", async () => {
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        mode: "off",
      }),
    }));

    const { buildMemoryContextForRun } = await import("../services/memory-lifecycle.js");

    const result = await buildMemoryContextForRun({
      agentId: "agent-1",
      issueTitle: "Fix recall",
      issueId: "ISSUE-1",
      wakeReason: "heartbeat",
    });

    expect(result).toBeNull();
  });

  it("returns null when bridge health fails", async () => {
    const warn = vi.fn();
    vi.doMock("../middleware/logger.js", () => ({
      logger: {
        warn,
        info: vi.fn(),
      },
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        mode: "embedded",
        health: vi.fn().mockRejectedValue(new Error("bridge down")),
      }),
    }));

    const { buildMemoryContextForRun } = await import("../services/memory-lifecycle.js");

    const result = await buildMemoryContextForRun({
      agentId: "agent-1",
      issueTitle: "Fix recall",
      issueId: "ISSUE-1",
      wakeReason: "heartbeat",
    });

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("uses delegation style to cap recall and appends delegator context when available", async () => {
    const recall = vi.fn().mockResolvedValue({
      items: Array.from({ length: 8 }, (_, index) => ({
        id: `memory-${index}`,
        kind: "dynamic",
        content: `memory ${index}`,
      })),
    });
    const getHabits = vi.fn().mockResolvedValue({
      habits: Array.from({ length: 5 }, (_, index) => ({
        trigger: `trigger ${index}`,
        action: `action ${index}`,
        confidence: 0.9,
      })),
    });
    const getDelegationContext = vi.fn().mockResolvedValue("Goal: ship this safely.");

    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        mode: "embedded",
        health: vi.fn().mockResolvedValue({ status: "ok" }),
        getPriming: vi.fn().mockResolvedValue({ prompt: "You care about quality." }),
        getHabits,
        recall,
        getDelegationContext,
      }),
    }));

    const { buildMemoryContextForRun } = await import("../services/memory-lifecycle.js");

    const result = await buildMemoryContextForRun({
      agentId: "agent-1",
      issueTitle: "Fix recall",
      issueId: "ISSUE-1",
      wakeReason: "issue_assigned",
      delegationStyle: "autonomous",
      delegatorAgentId: "agent-boss",
    });

    expect(recall).toHaveBeenCalledWith("agent-1", "Fix recall — issue_assigned — ISSUE-1", undefined, 3);
    expect(getDelegationContext).toHaveBeenCalledWith("agent-boss", "agent-1", "autonomous");
    expect(result).toContain("## Delegator Context");
    expect(result?.match(/^- \[dynamic\]/gm)?.length).toBe(3);
    expect(result?.match(/^- When:/gm)?.length).toBe(3);
  });

  it("records delegation events for both delegator and delegatee", async () => {
    const extract = vi.fn().mockResolvedValue({ added: 1, updated: 0, deleted: 0 });
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        mode: "embedded",
        health: vi.fn().mockResolvedValue({ status: "ok" }),
        extract,
      }),
    }));

    const { recordDelegationEvent } = await import("../services/memory-lifecycle.js");

    await expect(recordDelegationEvent({
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      taskDescription: "Review the migration plan",
      style: "directive",
      issueId: "ISSUE-9",
    })).resolves.toBeUndefined();

    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenNthCalledWith(
      1,
      "agent-a",
      [expect.objectContaining({ role: "system", content: expect.stringContaining("Delegated task to agent-b") })],
    );
    expect(extract).toHaveBeenNthCalledWith(
      2,
      "agent-b",
      [expect.objectContaining({ role: "system", content: expect.stringContaining("Received delegated task from agent-a") })],
    );
  });

  it("swallows extract and trajectory failures during post-run processing", async () => {
    vi.doMock("../middleware/logger.js", () => ({
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
      },
    }));
    const extract = vi.fn().mockRejectedValue(new Error("extract failed"));
    const processTrajectory = vi.fn().mockRejectedValue(new Error("trajectory failed"));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        mode: "embedded",
        health: vi.fn().mockResolvedValue({ status: "ok" }),
        extract,
        processTrajectory,
      }),
    }));

    const { extractMemoriesFromRun } = await import("../services/memory-lifecycle.js");

    await expect(
      extractMemoriesFromRun({
        agentId: "agent-1",
        runId: "run-1",
        issueId: "ISSUE-1",
        issueTitle: "Fix recall",
        outcome: "succeeded",
        stdoutExcerpt: "A sufficiently long output excerpt that should trigger extraction.",
        stderrExcerpt: "",
      }),
    ).resolves.toBeUndefined();

    expect(extract).toHaveBeenCalledOnce();
    expect(processTrajectory).toHaveBeenCalledOnce();
  });

  it("no-ops post-run extraction when hippocampus mode is off", async () => {
    const health = vi.fn();
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        mode: "off",
        health,
      }),
    }));

    const { extractMemoriesFromRun } = await import("../services/memory-lifecycle.js");

    await expect(
      extractMemoriesFromRun({
        agentId: "agent-1",
        runId: "run-1",
        issueId: "ISSUE-1",
        issueTitle: "Fix recall",
        outcome: "succeeded",
        stdoutExcerpt: "A sufficiently long output excerpt that should trigger extraction.",
        stderrExcerpt: "",
      }),
    ).resolves.toBeUndefined();

    expect(health).not.toHaveBeenCalled();
  });

  it("swallows health failures during post-run processing", async () => {
    const warn = vi.fn();
    vi.doMock("../middleware/logger.js", () => ({
      logger: {
        warn,
        info: vi.fn(),
      },
    }));
    const extract = vi.fn();
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        mode: "embedded",
        health: vi.fn().mockRejectedValue(new Error("bridge down")),
        extract,
      }),
    }));

    const { extractMemoriesFromRun } = await import("../services/memory-lifecycle.js");

    await expect(
      extractMemoriesFromRun({
        agentId: "agent-1",
        runId: "run-1",
        issueId: "ISSUE-1",
        issueTitle: "Fix recall",
        outcome: "succeeded",
        stdoutExcerpt: "A sufficiently long output excerpt that should trigger extraction.",
        stderrExcerpt: "",
      }),
    ).resolves.toBeUndefined();

    expect(extract).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
