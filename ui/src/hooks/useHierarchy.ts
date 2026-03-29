import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hierarchyApi, type HierarchyProposalInput } from "../api/hierarchy";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

function requireCompanyId(companyId: string | null): string {
  if (!companyId) {
    throw new Error("No company selected");
  }
  return companyId;
}

export function useActiveHierarchy() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.hierarchy.active(selectedCompanyId ?? ""),
    queryFn: () => hierarchyApi.getActive(requireCompanyId(selectedCompanyId)),
    enabled: !!selectedCompanyId,
  });
}

export function useHierarchyProposals() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.hierarchy.proposals(selectedCompanyId ?? ""),
    queryFn: () => hierarchyApi.listProposals(requireCompanyId(selectedCompanyId)),
    enabled: !!selectedCompanyId,
  });
}

export function useHierarchySnapshot(snapshotId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.hierarchy.snapshot(snapshotId ?? ""),
    queryFn: () => hierarchyApi.getSnapshot(snapshotId ?? ""),
    enabled: !!snapshotId,
  });
}

export function useHierarchyDiff(snapshotId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.hierarchy.diff(snapshotId ?? ""),
    queryFn: () => hierarchyApi.diff(snapshotId ?? ""),
    enabled: !!snapshotId,
  });
}

export function usePendingProposalCount() {
  const { data: proposals } = useHierarchyProposals();

  return useMemo(
    () => (proposals ?? []).filter((proposal) => proposal.status === "proposed").length,
    [proposals],
  );
}

export function useCreateHierarchyProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (data: HierarchyProposalInput) =>
      hierarchyApi.createProposal(requireCompanyId(selectedCompanyId), data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(requireCompanyId(selectedCompanyId)),
      });
      pushToast({ title: "Hierarchy proposal created", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create proposal",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}

export function useApproveProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (id: string) => hierarchyApi.approve(id),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.hierarchy.snapshot(updated.id), updated);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId ?? updated.companyId),
      });
      pushToast({ title: "Proposal approved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Approval failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}

export function useActivateProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (id: string) => hierarchyApi.activate(id),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.hierarchy.snapshot(updated.id), updated);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.hierarchy.active(selectedCompanyId ?? updated.companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.hierarchy.proposals(selectedCompanyId ?? updated.companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(selectedCompanyId ?? updated.companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.org(selectedCompanyId ?? updated.companyId),
        }),
      ]);
      pushToast({ title: "Hierarchy activated - org chart updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Activation failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}

export function useRejectProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      hierarchyApi.reject(id, reason),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.hierarchy.snapshot(updated.id), updated);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId ?? updated.companyId),
      });
      pushToast({ title: "Proposal rejected", tone: "info" });
    },
    onError: (error) => {
      pushToast({
        title: "Rejection failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}
