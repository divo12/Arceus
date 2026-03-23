import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HippocampusRuntimeManager,
  appendRuntimeStderrExcerpt,
  formatRuntimeFailureMessage,
} from "../services/hippocampus-runtime-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "hippocampus-runtime-fixture.cjs");

const managers = new Set<HippocampusRuntimeManager>();

function createManager(mode = "normal", overrides: ConstructorParameters<typeof HippocampusRuntimeManager>[0] = {}) {
  const manager = new HippocampusRuntimeManager({
    command: process.execPath,
    args: [fixturePath],
    env: {
      ...process.env,
      HIPPOCAMPUS_FIXTURE_MODE: mode,
    },
    startupTimeoutMs: 500,
    requestTimeoutMs: 200,
    shutdownDrainMs: 100,
    sigtermGraceMs: 100,
    minBackoffMs: 25,
    maxBackoffMs: 25,
    ...overrides,
  });
  managers.add(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(
    Array.from(managers).map(async (manager) => {
      await manager.stop().catch(() => {});
    }),
  );
  managers.clear();
});

describe("hippocampus-runtime-manager stderr failure context", () => {
  it("appends runtime stderr context to failure messages", () => {
    expect(
      formatRuntimeFailureMessage(
        "Runtime exited",
        "Traceback: boom",
      ),
    ).toBe("Runtime exited\n\nRuntime stderr:\nTraceback: boom");
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendRuntimeStderrExcerpt(excerpt, "first line");
    excerpt = appendRuntimeStderrExcerpt(excerpt, "second line");
    excerpt = appendRuntimeStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });
});

describe("HippocampusRuntimeManager", () => {
  it("starts the runtime and passes readiness handshake", async () => {
    const manager = createManager();

    await manager.start();
    const health = await manager.call("health", {});

    expect(health.status).toBe("ok");
    expect(manager.diagnostics().status).toBe("running");
    expect(manager.diagnostics().pid).not.toBeNull();
  });

  it("ignores malformed stdout lines and still handles health", async () => {
    const manager = createManager("malformed-on-start");

    await manager.start();
    const health = await manager.call("health", {});

    expect(health.status).toBe("ok");
  });

  it("times out hung requests", async () => {
    const manager = createManager("hang-on-recall");

    await manager.start();

    await expect(
      manager.call("recall", {
        agent_id: "agent-1",
        query: "why",
        container: "default",
        top_k: 10,
        include_graph: true,
      }),
    ).rejects.toThrow("timed out");
  });

  it("rejects pending requests on crash and restarts with backoff", async () => {
    const manager = createManager("crash-on-recall");

    await manager.start();

    await expect(
      manager.call("recall", {
        agent_id: "agent-1",
        query: "boom",
        container: "default",
        top_k: 10,
        include_graph: true,
      }),
    ).rejects.toThrow("fixture crash on recall");

    expect(manager.diagnostics().status).toBe("backoff");
    expect(manager.diagnostics().nextRestartAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 60));
    const health = await manager.call("health", {});

    expect(health.status).toBe("ok");
    expect(manager.diagnostics().totalCrashes).toBe(1);
  });

  it("falls back to SIGTERM when shutdown RPC hangs", async () => {
    const manager = createManager("ignore-shutdown");

    await manager.start();
    await manager.stop();

    expect(manager.diagnostics().status).toBe("stopped");
    expect(manager.diagnostics().pid).toBeNull();
  });
});
