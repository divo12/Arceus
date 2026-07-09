/**
 * Company bootstrap helpers — create a company atomically and
 * provision its workspace.
 *
 * Spec 31 Phase 7.C.c-bis — the multi-row write moved to
 * `apps/api/src/companies/bootstrap.ts` (transactional). This module
 * stays as the orchestrator-facing entry point that bundles the
 * bootstrap with workspace provisioning, and assembles the snapshot
 * view consumers expect.
 */

import { bootstrapCompanyTx, deriveCompanyNameFromIdea, type BootstrapInput } from "../companies/bootstrap.js";
import { buildSnapshotView } from "./snapshot-view.js";
import { workspaceManager } from "../workspace/manager.js";
import { tursoConfigured } from "../config/turso.js";
import { ensureCompanyTursoDb } from "../workspace/turso-provision.js";

/** Bootstrap a company from explicit inputs and provision a workspace directory. */
export async function bootstrapCompanyWithWorkspace(input: BootstrapInput) {
  const { company } = await bootstrapCompanyTx(input);
  const { warnings } = await workspaceManager.provision(company.id);

  // Best-effort: create Turso DB early so production deploy already has creds.
  if (tursoConfigured()) {
    const productDir = workspaceManager.getLocalPath(company.id);
    const turso = await ensureCompanyTursoDb({ companyId: company.id, productDir });
    if (!turso.ok) {
      warnings.push(`Turso provision skipped: ${turso.error}`);
    }
  }

  // Snapshot view assembled fresh from canonical so downstream consumers
  // (CEO chat, strategy generation) see the just-committed rows.
  const snapshot = await buildSnapshotView(company.id);
  return { snapshot, warnings };
}

/** Derive a company name from a free-text idea and bootstrap it with default settings. */
export async function bootstrapIdeaWithWorkspace(idea: string) {
  return bootstrapCompanyWithWorkspace({
    companyName: await deriveCompanyNameFromIdea(idea),
    boardOwner: "Board",
    idea,
    budgetCents: 999_999_999,
  });
}
