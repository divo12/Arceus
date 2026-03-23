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
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "off";

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
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      hippocampusBridge: {
        health: vi.fn().mockRejectedValue(new Error("bridge down")),
      },
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

  it("swallows extract and trajectory failures during post-run processing", async () => {
    process.env.PAPERCLIP_HIPPOCAMPUS_MODE = "embedded";
    const extract = vi.fn().mockRejectedValue(new Error("extract failed"));
    const processTrajectory = vi.fn().mockRejectedValue(new Error("trajectory failed"));
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      hippocampusBridge: {
        health: vi.fn().mockResolvedValue({ status: "ok" }),
        extract,
        processTrajectory,
      },
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
});
