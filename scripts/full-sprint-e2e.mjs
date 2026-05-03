/**
 * Full sprint E2E driver.
 *
 * 1. Reset company
 * 2. /api/quick-execute → bootstrap + CEO strategy + apply + start heartbeat
 * 3. Poll snapshot, watch tasks/sprints/heartbeats
 * 4. Stop after first sprint reaches "completed" (or hard timeout)
 *
 * Usage: node scripts/full-sprint-e2e.mjs
 */

const API = process.env.ARCEUS_API ?? "http://127.0.0.1:4000";
const HARD_DEADLINE_MS = 60 * 60_000; // 1h
const POLL_MS = 8_000;

const IDEA =
  "Build a tiny single-page web app called 'TickTock' that displays the current time, " +
  "with a button to toggle between 12-hour and 24-hour display. Plain Vite + React + TS. " +
  "Ship one sprint with a minimal but real implementation, tests, and a README.";

async function http(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

const fmtTime = () => new Date().toLocaleTimeString();

function summarize(snap) {
  const sprint = snap.sprints?.[snap.sprints.length - 1];
  const tasks = snap.tasks ?? [];
  const counts = tasks.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1; return acc;
  }, {});
  return {
    company: snap.company?.id,
    agents: snap.agents?.length ?? 0,
    sprintNumber: sprint?.number,
    sprintStatus: sprint?.status,
    sprintTitle: sprint?.title,
    tasks: tasks.length,
    byStatus: counts,
  };
}

async function main() {
  const t0 = Date.now();
  console.log(`[${fmtTime()}] Resetting company…`);
  try { await http("DELETE", "/api/company"); } catch (e) { console.warn("reset:", e.message); }

  console.log(`[${fmtTime()}] Quick-execute…`);
  const qe = await http("POST", "/api/quick-execute", { idea: IDEA });
  console.log(`  → company=${qe.snapshot.company.id} agents=${qe.snapshot.agents.length} tasks=${qe.snapshot.tasks.length} strategy="${qe.strategy.strategy_title}"`);

  let lastSummary = "";
  while (Date.now() - t0 < HARD_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let snap;
    try { snap = await http("GET", "/api/company"); } catch (e) { console.error("snap:", e.message); continue; }
    const s = summarize(snap);
    const line = JSON.stringify(s);
    if (line !== lastSummary) {
      console.log(`[${fmtTime()}] ${line}`);
      lastSummary = line;
    }
    const sprintDone = snap.sprints?.some((sp) => sp.status === "completed");
    const allTerminal = (snap.tasks ?? []).length > 0 &&
      (snap.tasks ?? []).every((t) => ["completed", "verified", "failed", "cancelled", "blocked"].includes(t.status));
    if (sprintDone) {
      console.log(`[${fmtTime()}] ✅ Sprint completed.`);
      break;
    }
    if (allTerminal) {
      console.log(`[${fmtTime()}] ⚠ All tasks terminal but no sprint completed — stopping.`);
      break;
    }
  }

  // Final snapshot dump
  const final = await http("GET", "/api/company");
  console.log("\n=== FINAL ===");
  console.log("Summary:", summarize(final));
  console.log("Tasks:");
  for (const t of final.tasks ?? []) {
    console.log(`  [${t.status}] ${t.id} (${t.assignedRole}) — ${t.title}`);
  }
  console.log("Sprints:");
  for (const sp of final.sprints ?? []) {
    console.log(`  [${sp.status}] sprint ${sp.number} — ${sp.title}`);
  }
  console.log("Artifacts:", (final.artifacts ?? []).length);

  // Heartbeat history
  try {
    const hb = await http("GET", "/api/heartbeat/history");
    const recent = (hb.records ?? hb).slice(-15);
    console.log(`\nLast ${recent.length} beats:`);
    for (const r of recent) {
      console.log(`  ${r.role.padEnd(12)} ${r.outcome ?? r.verdict ?? "?"} cause=${r.cause ?? "-"} dur=${r.durationMs ?? "?"}ms`);
    }
  } catch (e) {
    console.warn("heartbeat history:", e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
