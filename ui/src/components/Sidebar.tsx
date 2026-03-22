import {
  Inbox,
  Target,
  LayoutDashboard,
  DollarSign,
  Search,
  Settings,
  Users,
  ListTodo,
  Activity,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";

export function Sidebar() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Company header */}
      <div className="flex items-center gap-2 px-4 h-12 shrink-0">
        {selectedCompany?.brandColor && (
          <div
            className="w-5 h-5 rounded shrink-0"
            style={{ backgroundColor: selectedCompany.brandColor }}
          />
        )}
        <div className="flex-1 min-w-0">
          <span className="block text-sm font-bold text-foreground truncate">
            {selectedCompany?.name ?? "Select company"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={openSearch}
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      {/* Company description */}
      {selectedCompany?.description && (
        <div className="px-4 pb-2 -mt-1">
          <span className="text-[11px] text-muted-foreground/70 line-clamp-1">
            {selectedCompany.description}
          </span>
        </div>
      )}

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-0.5 px-3 py-2">
        <SidebarNavItem to="/dashboard" label="Overview" icon={LayoutDashboard} liveCount={liveRunCount} />
        <SidebarNavItem
          to="/inbox"
          label="Inbox"
          icon={Inbox}
          badge={inboxBadge.inbox}
          badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
          alert={inboxBadge.failedRuns > 0}
        />
        <PluginSlotOutlet
          slotTypes={["sidebar"]}
          context={pluginContext}
          className="flex flex-col gap-0.5"
          itemClassName="text-[13px] font-medium"
          missingBehavior="placeholder"
        />
        <SidebarNavItem to="/agents" label="Employees" icon={Users} />
        <SidebarNavItem to="/issues" label="Tasks" icon={ListTodo} />
        <SidebarNavItem to="/goals" label="Goals" icon={Target} />
        <SidebarNavItem to="/activity" label="Activity Log" icon={Activity} />
        <SidebarNavItem to="/costs" label="Budget" icon={DollarSign} />
        <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />

        <div className="mt-3">
          <SidebarProjects />
        </div>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3 mt-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
