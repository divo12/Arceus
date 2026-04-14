#!/usr/bin/env node
/**
 * start-preview.mjs — Smart preview launcher for the workspace product.
 *
 * Agents can invoke this via bash:  node scripts/start-preview.mjs
 *
 * What it does:
 *   1. Calls POST /api/preview/start on the ARCEUS API
 *   2. The API auto-detects the project (Vite, Next.js, Express, FastAPI, etc.)
 *   3. Installs dependencies if node_modules is missing
 *   4. Starts the dev server on the configured preview port (default 3210)
 *   5. Reports the preview URL or error
 *
 * Options:
 *   --stop    Stop a running preview instead of starting one
 *   --status  Check current preview status
 */

const API_BASE = process.env.ARCEUS_API_URL ?? "http://127.0.0.1:4000";

const arg = process.argv[2];

async function main() {
  if (arg === "--stop") {
    const res = await fetch(`${API_BASE}/api/preview/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await res.json();
    console.log(`Preview stopped: ${JSON.stringify(data)}`);
    return;
  }

  if (arg === "--status") {
    const res = await fetch(`${API_BASE}/api/preview`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log("Starting preview…");
  const res = await fetch(`${API_BASE}/api/preview/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();

  if (data.status === "ready") {
    console.log(`Preview ready → ${data.entryUrl ?? data.url}`);
  } else {
    console.error(`Preview failed: ${data.error ?? "unknown error"}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Failed to reach ARCEUS API at ${API_BASE}: ${err.message}`);
  process.exitCode = 1;
});
