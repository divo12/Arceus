import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "../types.js";
import http from "node:http";

function probeHttp(url: string, headers?: Record<string, string>, timeoutMs = 8000): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => resolve({ ok: res.statusCode! >= 200 && res.statusCode! < 400, status: res.statusCode, body: d.slice(0, 500) }));
      },
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  const openCodeUrl = process.env.OPENCODE_URL || "http://127.0.0.1:4098";
  const openCodeDir = process.env.OPENCODE_DIR || process.cwd();

  // 1. Check OpenCode server connectivity
  const ocProbe = await probeHttp(`${openCodeUrl}/config`, {
    "x-opencode-directory": encodeURIComponent(openCodeDir),
  });

  if (ocProbe.ok) {
    checks.push({
      code: "opencode_server_ok",
      level: "info",
      message: `OpenCode server reachable at ${openCodeUrl}`,
    });

    // Try to parse config to check provider
    try {
      const cfg = JSON.parse(ocProbe.body || "{}");
      const providerIds = Object.keys(cfg.provider || {});
      if (providerIds.length > 0) {
        checks.push({
          code: "opencode_providers",
          level: "info",
          message: `Providers configured: ${providerIds.join(", ")}`,
        });
      }
    } catch { /* ignore parse errors */ }
  } else {
    checks.push({
      code: "opencode_server_unreachable",
      level: "error",
      message: `OpenCode server not reachable at ${openCodeUrl}: ${ocProbe.error || `HTTP ${ocProbe.status}`}`,
      hint: "Start the OpenCode server: opencode server --port 4098",
    });
  }

  // 2. Check paperclip-cli.mjs exists
  const fs = await import("node:fs");
  const path = await import("node:path");
  const cliPath = path.resolve(process.cwd(), "scripts", "paperclip-cli.mjs");
  if (fs.existsSync(cliPath)) {
    checks.push({
      code: "paperclip_cli_ok",
      level: "info",
      message: "scripts/paperclip-cli.mjs found",
    });
  } else {
    checks.push({
      code: "paperclip_cli_missing",
      level: "warn",
      message: "scripts/paperclip-cli.mjs not found — agents won't be able to call Paperclip API",
      hint: "Ensure paperclip-cli.mjs exists in the scripts/ directory",
    });
  }

  const status = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: "arceus",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
