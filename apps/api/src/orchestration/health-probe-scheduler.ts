/**
 * Recurring health-probe scheduler.
 *
 * Periodically drives each company's LIVE product in a real browser (reusing the
 * flow-tester) so regressions BETWEEN sprints get caught and routed to the CEO as
 * next-sprint suggestions — not only at sprint finalize. Selection cadence is the
 * pure `selectCompaniesDueForProbe` policy; this module resolves preview state +
 * fires the probe.
 *
 * OPT-IN: dormant unless `HEALTH_PROBE_ENABLED=true` AND the flow-tester is
 * configured. Off by default so it adds zero cost/behavior until explicitly
 * enabled. Conservative interval (default 6h) bounds Azure/browser cost.
 */
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { buildSnapshotView } from "./snapshot-view.js";
import { runFlowTestAndReport, flowTesterConfigured } from "./flow-test.js";
import { selectCompaniesDueForProbe, type ProbeCandidate } from "./health-probe-policy.js";
import { swallowAndAudit } from "../observability/swallow.js";

const PROBE_INTERVAL_MS = Number(process.env.HEALTH_PROBE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
const TICK_INTERVAL_MS = 30 * 60 * 1000; // re-evaluate due companies every 30 min

const lastProbedAt = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

function enabled(): boolean {
  return (process.env.HEALTH_PROBE_ENABLED ?? "").trim().toLowerCase() === "true" && flowTesterConfigured();
}

/** Start the periodic probe. No-op unless opted-in. Idempotent. */
export function startHealthProbeScheduler(): void {
  if (timer || !enabled()) return;
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  timer.unref();
  console.log(`[health-probe] started — every ${TICK_INTERVAL_MS / 60000}min, probe interval ${PROBE_INTERVAL_MS / 3_600_000}h`);
}

export function stopHealthProbeScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  await swallowAndAudit("health_probe.tick", async () => {
    const now = Date.now();
    const companies = await companiesRepo.listCompanies(getDb());

    const candidates: ProbeCandidate[] = [];
    const previewUrlById = new Map<string, string>();
    for (const row of companies) {
      const companyId = companiesRepo.fromDbId(row.id, row.friendlyId);
      const preview = getLocalPreviewState(companyId);
      const ready = preview.status === "ready";
      candidates.push({ companyId, hasReadyPreview: ready, lastProbedAt: lastProbedAt.get(companyId) ?? null });
      if (ready) {
        const url = preview.url ?? preview.entryUrl ?? preview.validationUrl ?? null;
        if (url) previewUrlById.set(companyId, url);
      }
    }

    const due = selectCompaniesDueForProbe(candidates, now, PROBE_INTERVAL_MS);
    for (const companyId of due) {
      const previewUrl = previewUrlById.get(companyId);
      if (!previewUrl) continue;
      lastProbedAt.set(companyId, now); // record before firing so a slow probe isn't re-queued
      swallowAndAudit("health_probe.run", async () => {
        const snap = await buildSnapshotView(companyId);
        const sprint = snap.sprints.find((s) => s.id === snap.company.currentSprintId);
        await runFlowTestAndReport({
          companyId,
          sprintId: sprint?.id ?? "health-probe",
          sprintNumber: sprint?.number ?? snap.company.currentSprintNumber ?? 0,
          previewUrl,
        });
      }, { companyId });
    }
  });
}
