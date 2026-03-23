import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedHippocampusBridge,
  createSidecarHippocampusBridge,
} from "../services/hippocampus-bridge.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createSidecarHippocampusBridge", () => {
  it("posts remember payloads to the sidecar", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "mem-1", content: "hello", memory_type: "dynamic", confidence: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const bridge = createSidecarHippocampusBridge("http://hippo.test");
    await bridge.remember("agent-1", "hello", "startup:paperclip", "dynamic");

    expect(fetchMock).toHaveBeenCalledWith("http://hippo.test/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-1",
        content: "hello",
        container: "startup:paperclip",
        memory_type: "dynamic",
      }),
    });
  });

  it("builds memory list query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const bridge = createSidecarHippocampusBridge("http://hippo.test");
    await bridge.listMemories("agent-1", "dynamic", "startup:paperclip", 12);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://hippo.test/agents/agent-1/memories?memory_type=dynamic&container=startup%3Apaperclip&limit=12",
    );
  });
});

describe("createEmbeddedHippocampusBridge", () => {
  it("delegates start, close, and RPC calls to the runtime manager", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const call = vi.fn()
      .mockResolvedValueOnce({ status: "ok", agents_loaded: 1, debug: false })
      .mockResolvedValueOnce({ prompt: "priming:agent-1" });
    const diagnostics = vi.fn().mockReturnValue({ status: "running" });

    const bridge = createEmbeddedHippocampusBridge({
      start,
      stop,
      call,
      diagnostics,
    } as never);

    await bridge.start();
    await bridge.health();
    await bridge.getPriming("agent-1");
    await bridge.close();

    expect(start).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenNthCalledWith(1, "health", {});
    expect(call).toHaveBeenNthCalledWith(2, "getPriming", { agent_id: "agent-1" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(bridge.diagnostics()).toEqual({ status: "running" });
  });
});
