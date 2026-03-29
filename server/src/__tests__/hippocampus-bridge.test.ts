import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedHippocampusBridge,
} from "../services/hippocampus-bridge.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createEmbeddedHippocampusBridge", () => {
  it("delegates start, close, and RPC calls to the runtime manager", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const call = vi.fn(async (method: string, payload: Record<string, unknown>) => {
      if (method === "health") {
        return { status: "ok", agents_loaded: 1, debug: false };
      }
      if (method === "getPriming" && payload.agent_id === "agent-1") {
        return { prompt: "priming:agent-1" };
      }
      if (method === "getPriming" && payload.agent_id === "agent-boss") {
        return { prompt: "Lead with context." };
      }
      if (method === "listMemories" && payload.agent_id === "agent-boss") {
        return {
          items: [
            { id: "mem-1", content: "Constraint A", memory_type: "static", confidence: 1, relevance_score: 0.9, container: "default", visibility: null, created_at: null, updated_at: null, access_count: 0 },
            { id: "mem-2", content: "Prior delegation with agent-1 on release prep", memory_type: "dynamic", confidence: 0.8, relevance_score: 0.7, container: "default", visibility: null, created_at: null, updated_at: null, access_count: 0 },
          ],
          total: 2,
        };
      }
      if (method === "remember" && payload.agent_id === "agent-1") {
        return { id: "mem-static", content: "identity prompt", memory_type: "static", confidence: 1 };
      }
      throw new Error(`Unexpected runtime call: ${method}`);
    });
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
    const delegationContext = await bridge.getDelegationContext("agent-boss", "agent-1", "collaborative");
    await bridge.storeStaticMemory("agent-1", {
      kind: "identity",
      content: "identity prompt",
      source: "role_definition_seed",
    });
    await bridge.close();

    expect(start).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenNthCalledWith(1, "health", {});
    expect(call).toHaveBeenNthCalledWith(2, "getPriming", { agent_id: "agent-1" });
    expect(call).toHaveBeenNthCalledWith(3, "getPriming", { agent_id: "agent-boss" });
    expect(call).toHaveBeenNthCalledWith(4, "listMemories", {
      agent_id: "agent-boss",
      memory_type: undefined,
      container: undefined,
      limit: 5,
    });
    expect(call).toHaveBeenNthCalledWith(5, "remember", {
      agent_id: "agent-1",
      content: "identity prompt",
      container: "default",
      memory_type: "static",
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(bridge.diagnostics()).toEqual({ status: "running" });
    expect(delegationContext).toContain("## Delegation Context For agent-1");
    expect(delegationContext).toContain("Lead with context.");
    expect(delegationContext).toContain("Prior delegation with agent-1 on release prep");
  });
});
