import { useEffect } from "react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { ChatView } from "../components/chat/ChatView";
import { LayoutDashboard } from "lucide-react";

export function Dashboard() {
  const { selectedCompanyId, selectedCompany, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "CEO Chat" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Arceus. Set up your first startup and hire your AI employees."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a startup to access the command center." />
    );
  }

  return (
    <div className="-m-4 md:-m-6 h-[calc(100%+2rem)] md:h-[calc(100%+3rem)]">
      <ChatView />
    </div>
  );
}
