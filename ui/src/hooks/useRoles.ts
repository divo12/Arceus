import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleDefinition } from "@paperclipai/shared";
import { rolesApi } from "../api/roles";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

function requireCompanyId(companyId: string | null): string {
  if (!companyId) {
    throw new Error("No company selected");
  }
  return companyId;
}

export function useRoles() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.roles.list(selectedCompanyId ?? ""),
    queryFn: () => rolesApi.list(requireCompanyId(selectedCompanyId)),
    enabled: !!selectedCompanyId,
  });
}

export function useRoleBySlug(slug: string | undefined) {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.roles.bySlug(selectedCompanyId ?? "", slug ?? ""),
    queryFn: () => rolesApi.getBySlug(requireCompanyId(selectedCompanyId), slug ?? ""),
    enabled: !!selectedCompanyId && !!slug,
  });
}

export function useRoleAuthorityMatrix(roleId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.roles.authorityMatrix(roleId ?? ""),
    queryFn: () => rolesApi.authorityMatrix(roleId ?? ""),
    enabled: !!roleId,
  });
}

export function useUpdateRole() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<RoleDefinition> }) =>
      rolesApi.update(id, data),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.roles.detail(updated.id), updated);
      queryClient.setQueryData(queryKeys.roles.bySlug(updated.companyId, updated.slug), updated);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.roles.list(selectedCompanyId ?? updated.companyId),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.roles.authorityMatrix(updated.id),
      });
      pushToast({ title: `${updated.label} role saved`, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save role",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}

export function useCreateRole() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (data: Partial<RoleDefinition>) =>
      rolesApi.create(requireCompanyId(selectedCompanyId), data),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.roles.list(selectedCompanyId ?? created.companyId),
      });
      queryClient.setQueryData(queryKeys.roles.detail(created.id), created);
      queryClient.setQueryData(queryKeys.roles.bySlug(created.companyId, created.slug), created);
      pushToast({ title: "Role created", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create role",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });
}
