import { beforeEach, describe, expect, it, vi } from "vitest";

describe("hippocampus runtime lifecycle helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("initializes the bridge for each configured mode", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      initializeHippocampusBridge: initialize,
      shutdownHippocampusBridge: vi.fn(),
    }));

    const { startHippocampusRuntimeForConfig } = await import("../index.js");

    await startHippocampusRuntimeForConfig({
      hippocampusMode: "off",
      hippocampusApiUrl: undefined,
      hippocampusPythonBin: "python3",
      hippocampusStartupTimeoutMs: 1000,
      hippocampusRequestTimeoutMs: 1000,
    });
    await startHippocampusRuntimeForConfig({
      hippocampusMode: "sidecar",
      hippocampusApiUrl: "http://localhost:8100",
      hippocampusPythonBin: "python3",
      hippocampusStartupTimeoutMs: 1000,
      hippocampusRequestTimeoutMs: 1000,
    });
    await startHippocampusRuntimeForConfig({
      hippocampusMode: "embedded",
      hippocampusApiUrl: undefined,
      hippocampusPythonBin: "python3",
      hippocampusStartupTimeoutMs: 1000,
      hippocampusRequestTimeoutMs: 1000,
    });

    expect(initialize).toHaveBeenCalledTimes(3);
  });

  it("stops the runtime for every enabled mode", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../services/hippocampus-bridge.js", () => ({
      initializeHippocampusBridge: vi.fn(),
      shutdownHippocampusBridge: shutdown,
    }));

    const { stopHippocampusRuntimeForConfig } = await import("../index.js");

    await stopHippocampusRuntimeForConfig({ hippocampusMode: "off" });
    await stopHippocampusRuntimeForConfig({ hippocampusMode: "sidecar" });
    await stopHippocampusRuntimeForConfig({ hippocampusMode: "embedded" });

    expect(shutdown).toHaveBeenCalledTimes(2);
  });
});
