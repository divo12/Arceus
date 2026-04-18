import { bootstrapCompany, deriveCompanyNameFromIdea } from "../persistence/store.js";
import { workspaceManager } from "../workspace/manager.js";

type BootstrapInput = {
  companyName: string;
  boardOwner: string;
  idea: string;
  budgetCents: number;
};

export async function bootstrapCompanyWithWorkspace(input: BootstrapInput) {
  const snapshot = bootstrapCompany(input);
  const { warnings } = await workspaceManager.provision(snapshot.company.id);
  return {
    snapshot,
    warnings,
  };
}

export async function bootstrapIdeaWithWorkspace(idea: string) {
  return bootstrapCompanyWithWorkspace({
    companyName: deriveCompanyNameFromIdea(idea),
    boardOwner: "Board",
    idea,
    budgetCents: 999_999_999,
  });
}