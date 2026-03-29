import { useEffect, useMemo, useState } from "react";
import { Network } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import type { HierarchyEdge, HierarchySnapshot } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import {
  useActiveHierarchy,
  useActivateProposal,
  useApproveProposal,
  useHierarchyProposals,
  useRejectProposal,
} from "@/hooks/useHierarchy";
import { hierarchyApi } from "@/api/hierarchy";
import { queryKeys } from "@/lib/queryKeys";
import { EmptyState } from "@/components/EmptyState";
import { HierarchyEdgeLegend } from "@/components/HierarchyEdgeLegend";
import { PageSkeleton } from "@/components/PageSkeleton";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn, relativeTime } from "@/lib/utils";
import type { HierarchySnapshotWithEdges } from "@/api/hierarchy";

function buildHierarchyRows(
  snapshot: HierarchySnapshotWithEdges | HierarchySnapshot | null | undefined,
): string[][] {
  const reportsToEdges = (snapshot?.edges ?? []).filter((edge) => edge.edgeType === "reports_to");
  if (reportsToEdges.length === 0) {
    return [];
  }

  const nodes = new Set<string>();
  const childIds = new Set<string>();
  const childrenByManager = new Map<string, string[]>();

  for (const edge of reportsToEdges) {
    nodes.add(edge.sourceAgentId);
    nodes.add(edge.targetAgentId);
    childIds.add(edge.sourceAgentId);
    const children = childrenByManager.get(edge.targetAgentId) ?? [];
    children.push(edge.sourceAgentId);
    childrenByManager.set(edge.targetAgentId, children);
  }

  const roots = [...nodes].filter((nodeId) => !childIds.has(nodeId));
  const visited = new Set<string>();
  const rows: string[][] = [];
  let currentLevel = roots.length > 0 ? roots : [...nodes];

  while (currentLevel.length > 0) {
    const uniqueLevel = currentLevel.filter((nodeId, index, all) => all.indexOf(nodeId) === index);
    rows.push(uniqueLevel);
    uniqueLevel.forEach((nodeId) => visited.add(nodeId));
    currentLevel = uniqueLevel.flatMap((nodeId) => childrenByManager.get(nodeId) ?? []);
  }

  const remaining = [...nodes].filter((nodeId) => !visited.has(nodeId));
  if (remaining.length > 0) {
    rows.push(remaining);
  }

  return rows;
}

function edgeSummary(edge: HierarchyEdge) {
  return `${edge.sourceAgentId.slice(0, 6)} -> ${edge.edgeType} -> ${edge.targetAgentId.slice(0, 6)}`;
}

function MiniHierarchyPreview({
  title,
  snapshot,
  resolveAgentLabel,
}: {
  title: string;
  snapshot: HierarchySnapshotWithEdges | HierarchySnapshot | null | undefined;
  resolveAgentLabel: (agentId: string) => string;
}) {
  const rows = useMemo(() => buildHierarchyRows(snapshot), [snapshot]);

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs italic text-muted-foreground">No report structure captured.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((row, rowIndex) => (
            <div key={`${title}-${rowIndex}`} className="flex flex-wrap gap-2">
              {row.map((agentId) => (
                <div
                  key={agentId}
                  className="rounded-md border border-border bg-card px-2 py-1 text-[10px] font-medium"
                >
                  {resolveAgentLabel(agentId)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  activeSnapshot,
  onApprove,
  onApproveAndActivate,
  onReject,
  isActioning,
  proposedByLabel,
  resolveAgentLabel,
}: {
  proposal: HierarchySnapshot;
  activeSnapshot: HierarchySnapshotWithEdges | null | undefined;
  onApprove: () => void;
  onApproveAndActivate: () => void;
  onReject: () => void;
  isActioning: boolean;
  proposedByLabel: string;
  resolveAgentLabel: (agentId: string) => string;
}) {
  const { data: diff } = useQuery({
    queryKey: queryKeys.hierarchy.diff(proposal.id),
    queryFn: () => hierarchyApi.diff(proposal.id),
  });
  const { data: proposalSnapshot } = useQuery({
    queryKey: queryKeys.hierarchy.snapshot(proposal.id),
    queryFn: () => hierarchyApi.getSnapshot(proposal.id),
  });

  const statusTone =
    proposal.status === "proposed"
      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
      : proposal.status === "approved"
        ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
        : proposal.status === "active"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-border bg-muted/50 text-muted-foreground";

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <Network className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">
              {proposal.description || `Proposal ${proposal.id.slice(0, 8)}`}
            </h3>
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase", statusTone)}>
              {proposal.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Proposed by {proposedByLabel} - {relativeTime(proposal.createdAt)}
          </p>
        </div>
      </div>

      <div className="space-y-4 border-t border-border px-4 py-4">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Rationale
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
            {proposal.description || "No rationale supplied."}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Changes
          </div>
          <div className="space-y-1 rounded-md border border-border bg-background/60 px-3 py-2 font-mono text-xs">
            {(diff?.added ?? []).map((edge) => (
              <div key={`added-${edge.id}`} className="text-emerald-600 dark:text-emerald-400">
                + {edgeSummary(edge)}
              </div>
            ))}
            {(diff?.removed ?? []).map((edge) => (
              <div key={`removed-${edge.id}`} className="text-red-600 dark:text-red-400">
                - {edgeSummary(edge)}
              </div>
            ))}
            {(!diff || ((diff.added?.length ?? 0) === 0 && (diff.removed?.length ?? 0) === 0)) ? (
              <div className="text-muted-foreground">No structural diff available yet.</div>
            ) : null}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <MiniHierarchyPreview
            title="Current"
            snapshot={activeSnapshot}
            resolveAgentLabel={resolveAgentLabel}
          />
          <MiniHierarchyPreview
            title="Proposed"
            snapshot={proposalSnapshot ?? proposal}
            resolveAgentLabel={resolveAgentLabel}
          />
        </div>

        <HierarchyEdgeLegend />

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" className="text-destructive" onClick={onReject}>
            Reject
          </Button>
          <Button variant="outline" size="sm" onClick={onApprove} disabled={isActioning}>
            Approve
          </Button>
          <Button size="sm" onClick={onApproveAndActivate} disabled={isActioning}>
            Approve & Activate
          </Button>
        </div>
      </div>
    </div>
  );
}

export function HierarchyProposals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [rejectDialogId, setRejectDialogId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data: proposals, isLoading, error } = useHierarchyProposals();
  const { data: activeHierarchy } = useActiveHierarchy();
  const approve = useApproveProposal();
  const activate = useActivateProposal();
  const reject = useRejectProposal();

  const { data: agents } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Hierarchy" }, { label: "Proposals" }]);
  }, [setBreadcrumbs]);

  const pendingCount = useMemo(
    () => (proposals ?? []).filter((proposal) => proposal.status === "proposed").length,
    [proposals],
  );

  const filtered = useMemo(
    () =>
      tab === "pending"
        ? (proposals ?? []).filter((proposal) => proposal.status === "proposed")
        : (proposals ?? []),
    [proposals, tab],
  );

  function proposerLabel(proposal: HierarchySnapshot) {
    if (proposal.proposedByAgentId) {
      return agents?.find((agent) => agent.id === proposal.proposedByAgentId)?.name ?? proposal.proposedByAgentId.slice(0, 8);
    }
    if (proposal.proposedByUserId) {
      return proposal.proposedByUserId;
    }
    return "Unknown";
  }

  function resolveAgentLabel(agentId: string) {
    return agents?.find((agent) => agent.id === agentId)?.name ?? agentId.slice(0, 8);
  }

  async function handleApproveAndActivate(id: string) {
    await approve.mutateAsync(id);
    await activate.mutateAsync(id);
    navigate("/org");
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to review hierarchy proposals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Hierarchy Proposals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review and approve organizational changes proposed by the company.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as "pending" | "all")}>
        <PageTabBar
          items={[
            { value: "pending", label: `Pending (${pendingCount})` },
            { value: "all", label: "All" },
          ]}
          value={tab}
          onValueChange={(value) => setTab(value as "pending" | "all")}
          align="start"
        />
      </Tabs>

      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

      {filtered.length === 0 ? (
        <EmptyState icon={Network} message="No hierarchy proposals in this view." />
      ) : (
        <div className="space-y-4">
          {filtered.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              activeSnapshot={activeHierarchy}
              onApprove={() => approve.mutate(proposal.id)}
              onApproveAndActivate={() => void handleApproveAndActivate(proposal.id)}
              onReject={() => setRejectDialogId(proposal.id)}
              isActioning={approve.isPending || activate.isPending || reject.isPending}
              proposedByLabel={proposerLabel(proposal)}
              resolveAgentLabel={resolveAgentLabel}
            />
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(rejectDialogId)}
        onOpenChange={(open) => {
          if (!open) {
            setRejectDialogId(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Proposal</DialogTitle>
            <DialogDescription>
              Add a short reason so the proposer understands what needs to change.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            className="min-h-[96px]"
            placeholder="Reason for rejection"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectDialogId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!rejectDialogId || !rejectReason.trim() || reject.isPending}
              onClick={async () => {
                if (!rejectDialogId) return;
                await reject.mutateAsync({ id: rejectDialogId, reason: rejectReason.trim() });
                setRejectDialogId(null);
                setRejectReason("");
              }}
            >
              {reject.isPending ? "Rejecting..." : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
