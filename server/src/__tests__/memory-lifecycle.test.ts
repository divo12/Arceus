import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("memory lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("always returns priming context and falls back to recent memories when embeddings fail", async () => {
    const getActiveHabits = vi.fn().mockResolvedValue([]);
    const getPrimingState = vi.fn().mockResolvedValue(null);
    const recall = vi.fn();
    const recallByDate = vi.fn().mockResolvedValue([
      {
        id: "memory-1",
        content: "I am the deployment engineer for this company.",
        memoryType: "static",
      },
    ]);

    vi.doMock("../services/memory-store.js", () => ({
      memoryStoreService: () => ({
        getActiveHabits,
        getPrimingState,
        recall,
        recallByDate,
      }),
    }));
    vi.doMock("../services/working-memory.js", () => ({
      workingMemoryService: () => ({
        getCachedEmbedding: vi.fn().mockResolvedValue(null),
        cacheEmbedding: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        getEmbedding: vi.fn().mockRejectedValue(new Error("embedding unavailable")),
      }),
    }));

    const { buildMemoryContextForRun } = await import("../services/memory-lifecycle.js");

    const result = await buildMemoryContextForRun({
      db: {} as never,
      companyId: "company-1",
      agentId: "agent-1",
      issueTitle: "Fix recall",
      issueId: "ISSUE-1",
      wakeReason: "heartbeat",
    });

    expect(result).toContain("## Agent Memory — Priming");
    expect(result).toContain("Confidence: 50%");
    expect(result).toContain("I am the deployment engineer for this company.");
    expect(recall).not.toHaveBeenCalled();
    expect(recallByDate).toHaveBeenCalledWith({ agentId: "agent-1", topK: 5 });
  });

  it("uses delegation style to cap recall and appends delegator context when available", async () => {
    const recall = vi.fn().mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `memory-${index}`,
        memoryType: "dynamic",
        content: `memory ${index}`,
      })),
    );
    const getActiveHabits = vi.fn().mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        triggerCondition: `trigger ${index}`,
        action: `action ${index}`,
        confidence: 0.9,
      })),
    );
    const getDelegationContext = vi.fn().mockResolvedValue("Goal: ship this safely.");

    vi.doMock("../services/memory-store.js", () => ({
      memoryStoreService: () => ({
        getPrimingState: vi.fn().mockResolvedValue({
          confidence: 0.8,
          caution: 0.4,
          morale: 0.9,
          recentEvents: ["Stayed calm during rollout."],
        }),
        getActiveHabits,
        recall,
        recallByDate: vi.fn(),
      }),
    }));
    vi.doMock("../services/working-memory.js", () => ({
      workingMemoryService: () => ({
        getCachedEmbedding: vi.fn().mockResolvedValue(null),
        cacheEmbedding: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        getEmbedding: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
        getDelegationContext,
      }),
    }));

    const { buildMemoryContextForRun } = await import("../services/memory-lifecycle.js");

    const result = await buildMemoryContextForRun({
      db: {} as never,
      companyId: "company-1",
      agentId: "agent-1",
      issueTitle: "Fix recall",
      issueId: "ISSUE-1",
      wakeReason: "issue_assigned",
      delegationStyle: "autonomous",
      delegatorAgentId: "agent-boss",
    });

    expect(recall).toHaveBeenCalledWith({
      agentId: "agent-1",
      embedding: [0.1, 0.2, 0.3],
      topK: 3,
    });
    expect(getDelegationContext).toHaveBeenCalledWith("agent-boss", "agent-1", "autonomous");
    expect(result).toContain("## Delegator Context");
    expect(result?.match(/^- \[dynamic\]/gm)?.length).toBe(3);
    expect(result?.match(/^- When:/gm)?.length).toBe(3);
  });

  it("records delegation events for both delegator and delegatee", async () => {
    const extract = vi.fn().mockResolvedValue({ added: 1, updated: 0, deleted: 0 });
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
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

  it("persists distilled learning artifacts and logs success after post-run extraction", async () => {
    const writeMemory = vi.fn().mockResolvedValue({});
    const upsertPattern = vi.fn().mockResolvedValue({});
    const upsertHabit = vi.fn().mockResolvedValue({});
    const updatePrimingState = vi.fn().mockResolvedValue({});
    const logOperation = vi.fn().mockResolvedValue({});

    vi.doMock("../services/memory-store.js", () => ({
      memoryStoreService: () => ({
        writeMemory,
        upsertPattern,
        upsertHabit,
        getPrimingState: vi.fn().mockResolvedValue({
          confidence: 0.4,
          caution: 0.6,
          morale: 0.5,
          recentEvents: ["Older event"],
        }),
        updatePrimingState,
        logOperation,
      }),
    }));
    vi.doMock("../services/live-events.js", () => ({
      publishLiveEvent: vi.fn(),
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        extract: vi.fn().mockResolvedValue({ added: 2, updated: 1, deleted: 0 }),
        processTrajectory: vi.fn().mockResolvedValue({
          verdict: null,
          distilled: {
            trajectory_id: "ISSUE-1",
            strategy: "Always summarize the migration risk before applying schema changes.",
            container: "issue:ISSUE-1",
            embedding: [0.4, 0.5],
            quality: 0.8,
            learnings: ["Summaries reduce migration mistakes."],
          },
          pattern: {
            id: "pattern-1",
            description: "Schema-change safety pattern",
            strategy: "Summarize risk before migration",
            usage_count: 4,
            success_rate: 0.85,
            status: "active",
            domain: "database",
          },
          habit: {
            id: "habit-1",
            trigger_condition: "When preparing a migration",
            action: "Write a short risk summary first",
            confidence: 0.88,
            usage_count: 4,
            formed_from_id: "pattern-1",
            is_active: true,
          },
        }),
      }),
    }));
    vi.doMock("../middleware/logger.js", () => ({
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
    }));

    const { extractMemoriesFromRun } = await import("../services/memory-lifecycle.js");

    await expect(
      extractMemoriesFromRun({
        db: {} as never,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "ISSUE-1",
        issueTitle: "Fix recall",
        outcome: "succeeded",
        stdoutExcerpt: "A sufficiently long output excerpt that should trigger extraction.",
        stderrExcerpt: "",
      }),
    ).resolves.toBeUndefined();

    expect(writeMemory).toHaveBeenCalledOnce();
    expect(upsertPattern).toHaveBeenCalledOnce();
    expect(upsertHabit).toHaveBeenCalledOnce();
    expect(updatePrimingState).toHaveBeenCalledOnce();
    expect(logOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-1",
        operationType: "post_run_extraction",
        success: true,
      }),
    );
  });

  it("retries extraction failures, logs them, emits a live event, and rejects", async () => {
    vi.useFakeTimers();

    const logOperation = vi.fn().mockResolvedValue({});
    const publishLiveEvent = vi.fn();
    const extract = vi.fn().mockRejectedValue(new Error("extract failed"));

    vi.doMock("../services/memory-store.js", () => ({
      memoryStoreService: () => ({
        logOperation,
      }),
    }));
    vi.doMock("../services/live-events.js", () => ({
      publishLiveEvent,
    }));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      getHippocampusBridge: () => ({
        extract,
        processTrajectory: vi.fn(),
      }),
    }));
    vi.doMock("../middleware/logger.js", () => ({
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
    }));

    const { extractMemoriesFromRun } = await import("../services/memory-lifecycle.js");

    const promise = extractMemoriesFromRun({
      db: {} as never,
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "ISSUE-1",
      issueTitle: "Fix recall",
      outcome: "succeeded",
      stdoutExcerpt: "A sufficiently long output excerpt that should trigger extraction.",
      stderrExcerpt: "",
    });
    const settled = promise.catch((error) => error);

    await vi.runAllTimersAsync();

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("extract failed");
    expect(extract).toHaveBeenCalledTimes(3);
    expect(logOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-1",
        operationType: "post_run_extraction",
        success: false,
        error: "extract failed",
      }),
    );
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "memory:extraction_failed",
      }),
    );
  });
});
