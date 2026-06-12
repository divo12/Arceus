/**
 * Spec 21 – Verification Gate
 *
 * Runs `npm run build` and `npm run test` in the product workspace and returns
 * structured results.  Used in the pre-review gate (build only) and final gate
 * (build + test).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationGateResult } from "@arceus/contracts";
import { probePreviewHealth, getLocalPreviewState } from "../workspace/preview.js";

// ── Configuration ───────────────────────────────────────────

/** Configuration for the build/test verification gate. */
export interface VerificationGateConfig {
  gateTimeoutMs: number;      // per-command timeout (default 120 000)
  enableBuildGate: boolean;
  enableTestGate: boolean;
  autoSkipOnNoPackageJson: boolean;
}

/** Sensible defaults: 2-minute timeout, both gates enabled, skip if no package.json. */
export const DEFAULT_GATE_CONFIG: VerificationGateConfig = {
  gateTimeoutMs: 120_000,
  enableBuildGate: true,
  enableTestGate: true,
  autoSkipOnNoPackageJson: true,
};

// ── Helpers ─────────────────────────────────────────────────

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runShell(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, shell: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // execFile error has an optional `code` field — narrow to a typed view.
      const errCode = err ? (err as { code?: number | string }).code : undefined;
      const exitCode = typeof errCode === "number" ? errCode : (err ? 1 : 0);
      resolve({
        exitCode,
        stdout: (stdout ?? "").slice(0, 4096),
        stderr: (stderr ?? "").slice(0, 4096),
      });
    });
  });
}

function readPkgScripts(productDir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(productDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Run the verification gate for the given phase.
 *
 * - `pre_review`: build only
 * - `final`: build + test
 */
export async function runVerificationGate(
  productDir: string,
  phase: "pre_review" | "final",
  config: VerificationGateConfig = DEFAULT_GATE_CONFIG,
  // Scope the preview-health read to this sprint's company; without it
  // getLocalPreviewState falls back to the global active company (wrong
  // slot under multi-tenancy). Optional so existing tests still pass.
  companyId?: string | null,
): Promise<VerificationGateResult> {
  const result: VerificationGateResult = {
    passed: true,
    buildResult: null,
    testResult: null,
    phase,
    timestamp: new Date().toISOString(),
  };

  // No product workspace → skip gate
  if (!existsSync(productDir)) {
    return result;
  }

  const pkgPath = join(productDir, "package.json");
  if (!existsSync(pkgPath)) {
    if (config.autoSkipOnNoPackageJson) return result;
    // else fall through with no scripts
  }

  const scripts = readPkgScripts(productDir);

  // ── Install deps if node_modules missing ──────────────────
  if (!existsSync(join(productDir, "node_modules")) && Object.keys(scripts).length > 0) {
    await runShell("npm", ["install"], productDir, config.gateTimeoutMs);
  }

  // ── Build gate ────────────────────────────────────────────
  if (config.enableBuildGate && scripts.build) {
    const buildRes = await runShell("npm", ["run", "build"], productDir, config.gateTimeoutMs);
    result.buildResult = { exitCode: buildRes.exitCode, stdout: buildRes.stdout, stderr: buildRes.stderr };
    if (buildRes.exitCode !== 0) {
      result.passed = false;
      return result;
    }
  }

  // ── Test gate (final phase only, or if explicitly enabled) ─
  if (phase === "final" && config.enableTestGate && scripts.test) {
    const testRes = await runShell("npm", ["run", "test"], productDir, config.gateTimeoutMs);
    result.testResult = {
      exitCode: testRes.exitCode,
      stdout: testRes.stdout,
      stderr: testRes.stderr,
      summary: extractTestSummary(testRes.stdout, testRes.stderr),
    };
    if (testRes.exitCode !== 0) {
      result.passed = false;
    }
  }

  // ── Preview health gate (both phases) ─────────────────────
  const previewState = getLocalPreviewState(companyId);
  if (previewState.status === "ready" || previewState.url) {
    const probe = await probePreviewHealth(8000);
    result.previewResult = probe;
    if (!probe.reachable) {
      result.passed = false;
    }
  } else {
    // No preview configured — flag it but don't hard-fail pre_review
    result.previewResult = { reachable: false, statusCode: null, error: "Preview not started or not configured" };
    if (phase === "final") {
      result.passed = false;
    }
  }

  return result;
}

/** Pull a one-line test summary from stdout/stderr (best-effort). */
function extractTestSummary(stdout: string, stderr: string): string {
  const combined = stdout + "\n" + stderr;
  // Look for common test runner summary lines
  const patterns = [
    /Tests:\s+.+/i,          // Jest: "Tests: 5 passed, 5 total"
    /\d+ passing/i,           // Mocha: "5 passing"
    /✓.*\d+|✗.*\d+/,         // Vitest/tap
    /PASS|FAIL/,              // Jest single-word
  ];
  for (const pat of patterns) {
    const m = combined.match(pat);
    if (m) return m[0].trim();
  }
  return combined.split("\n").filter(Boolean).pop()?.trim().slice(0, 200) ?? "No summary";
}
