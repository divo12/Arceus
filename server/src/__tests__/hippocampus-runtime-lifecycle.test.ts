import { beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("hippocampus runtime lifecycle helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("initializes the bridge for each configured mode", async () => {
    vi.resetModules();
    const initialize = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      initializeHippocampusBridge: initialize,
      shutdownHippocampusBridge: vi.fn(),
    }));

    const { startHippocampusRuntimeForConfig } = await import("../index.js");

    await startHippocampusRuntimeForConfig({
      hippocampusMode: "setup",
      hippocampusPythonBin: "python3",
      hippocampusStartupTimeoutMs: 1000,
      hippocampusRequestTimeoutMs: 1000,
    });
    await startHippocampusRuntimeForConfig({
      hippocampusMode: "active",
      hippocampusPythonBin: "python3",
      hippocampusStartupTimeoutMs: 1000,
      hippocampusRequestTimeoutMs: 1000,
    });

    expect(initialize).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("stops the runtime for every enabled mode", async () => {
    vi.resetModules();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      initializeHippocampusBridge: vi.fn(),
      shutdownHippocampusBridge: shutdown,
    }));

    const { stopHippocampusRuntimeForConfig } = await import("../index.js");

    await stopHippocampusRuntimeForConfig({ hippocampusMode: "setup" });
    await stopHippocampusRuntimeForConfig({ hippocampusMode: "active" });

    expect(shutdown).toHaveBeenCalledTimes(1);
  }, 10_000);
});
