/**
 * Company bootstrap helpers — create a company snapshot and provision its workspace.
 */

import { bootstrapCompany, deriveCompanyNameFromIdea } from "../persistence/store.js";
import { workspaceManager } from "../workspace/manager.js";

type BootstrapInput = {
  companyName: string;
  boardOwner: string;
  idea: string;
  budgetCents: number;
};

/** Bootstrap a company from explicit inputs and provision a workspace directory. */
export async function bootstrapCompanyWithWorkspace(input: BootstrapInput) {
  const snapshot = bootstrapCompany(input);
  const { warnings } = await workspaceManager.provision(snapshot.company.id);
  return {
    snapshot,
    warnings,
  };
}

/** Derive a company name from a free-text idea and bootstrap it with default settings. */
export async function bootstrapIdeaWithWorkspace(idea: string) {
  return bootstrapCompanyWithWorkspace({
    companyName: deriveCompanyNameFromIdea(idea),
    boardOwner: "Board",
    idea,
    budgetCents: 999_999_999,
  });
}