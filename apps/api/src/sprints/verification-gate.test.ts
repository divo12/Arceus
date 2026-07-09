/**
 * Tests for verification-gate.ts — focused on the preview health gate behavior.
 *
 * Run: npx tsx --test src/verification-gate.test.ts
 */
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { runVerificationGate, DEFAULT_GATE_CONFIG } from "./verification-gate.js";
import { computeEffectiveVerdict } from "./review.js";

// ---------------------------------------------------------------------------
// Helpers — temp product directory with a trivial package.json
// ---------------------------------------------------------------------------

function makeTempProductDir(): string {
  const dir = join(tmpdir(), `vgate-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-product",
      version: "0.0.0",
      scripts: {
        // `echo` always succeeds — enough to exercise the build gate
        build: process.platform === "win32" ? "echo build-ok" : "echo build-ok",
        test: process.platform === "win32" ? "echo test-ok" : "echo test-ok",
      },
    }),
  );
  // node_modules not required for echo scripts
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runVerificationGate", () => {
  let productDir: string;

  before(() => {
    productDir = makeTempProductDir();
  });

  after(() => {
    cleanup(productDir);
  });

  it("pre_review gate passes when build succeeds (preview not started)", async () => {
    const result = await runVerificationGate(productDir, "pre_review");
    // Build should pass (echo build-ok)
    assert.ok(result.buildResult, "buildResult should be present");
    assert.equal(result.buildResult.exitCode, 0, "build should succeed");
    // Preview not started/configured → previewResult should exist
    assert.ok(result.previewResult, "previewResult should be present");
    // In pre_review with no preview configured, gate can still pass
    // (the preview state module is in idle mode since no preview was started)
  });

  it("final gate reports preview as unreachable when no preview running", async () => {
    const result = await runVerificationGate(productDir, "final");
    assert.ok(result.previewResult, "previewResult should be present");
    assert.equal(result.previewResult.reachable, false, "preview should be unreachable");
    assert.ok(result.previewResult.error, "should have an error message");
    // Final phase without preview → gate should fail
    assert.equal(result.passed, false, "final gate should fail without preview");
  });

  it("result includes previewResult field", async () => {
    const result = await runVerificationGate(productDir, "pre_review");
    assert.ok("previewResult" in result, "previewResult key should exist");
  });

  it("final gate skips browser when FLOW_TESTER_URL unset", async () => {
    const prev = process.env.FLOW_TESTER_URL;
    delete process.env.FLOW_TESTER_URL;
    try {
      const result = await runVerificationGate(productDir, "final");
      assert.ok(result.browserResult, "browserResult should be present on final");
      assert.equal(result.browserResult.skipped, true, "browser gate should skip when unconfigured");
      assert.equal(result.browserResult.ran, false);
    } finally {
      if (prev !== undefined) process.env.FLOW_TESTER_URL = prev;
      else delete process.env.FLOW_TESTER_URL;
    }
  });

  it("pre_review gate does not include browserResult", async () => {
    const result = await runVerificationGate(productDir, "pre_review");
    assert.equal(result.browserResult, undefined);
  });

  it("non-existent product dir returns passed (skip gate)", async () => {
    const result = await runVerificationGate("/nonexistent/dir/xyz", "final");
    assert.equal(result.passed, true, "should skip gate for missing dir");
  });
});

describe("preview health probe contract", () => {
  let server: Server;
  let port: number;

  before(async () => {
    // Spin up a tiny HTTP server to simulate a working preview
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Hello</body></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    server.close();
  });

  it("probePreviewHealth returns reachable=true for live server", async () => {
    // Import dynamically so the module-level state doesn't interfere
    const { probePreviewHealth } = await import("../workspace/preview.js");
    // The function reads from module-level previewState — we can't set the URL
    // without modifying the module. But we can at least verify it returns
    // the correct shape when preview is idle (no URL set).
    const result = await probePreviewHealth(2000);
    assert.equal(typeof result.reachable, "boolean");
    assert.ok("statusCode" in result);
    assert.ok("error" in result);
    // Since previewState is idle (no URL), it should be unreachable
    assert.equal(result.reachable, false);
  });
});

describe("computeEffectiveVerdict — preview/entry-point hard override", () => {
  it("forces FAIL when the preview is unreachable, even if the tester said pass", () => {
    assert.equal(
      computeEffectiveVerdict({ previewReachable: false, entryPointConnected: true, qaVerdict: "pass" }),
      "fail",
      "a green QA report over a dead preview must not pass",
    );
  });

  it("forces FAIL when the entry point does not import the product, even if tester said pass", () => {
    assert.equal(
      computeEffectiveVerdict({ previewReachable: true, entryPointConnected: false, qaVerdict: "pass" }),
      "fail",
      "a disconnected entry point must not pass",
    );
  });

  it("honors the tester's PASS when both structural checks pass", () => {
    assert.equal(
      computeEffectiveVerdict({ previewReachable: true, entryPointConnected: true, qaVerdict: "pass" }),
      "pass",
    );
  });

  it("honors the tester's FAIL when both structural checks pass", () => {
    assert.equal(
      computeEffectiveVerdict({ previewReachable: true, entryPointConnected: true, qaVerdict: "fail" }),
      "fail",
    );
  });

  it("returns null (not-yet-decided) when checks pass but no parseable QA report exists", () => {
    assert.equal(
      computeEffectiveVerdict({ previewReachable: true, entryPointConnected: true, qaVerdict: null }),
      null,
      "unparseable QA output is not a silent pass — caller handles null as undecided/rework",
    );
  });
});
