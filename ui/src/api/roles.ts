import type { RoleDefinition } from "@paperclipai/shared";
import { api } from "./client";

export interface RoleAuthorityMatrix {
  canDelegateTo: RoleDefinition["canDelegateTo"];
  delegationStyle: RoleDefinition["delegationStyle"];
  spawnRules: RoleDefinition["spawnRules"];
}

export const rolesApi = {
  list: (companyId: string) =>
    api.get<RoleDefinition[]>(`/companies/${encodeURIComponent(companyId)}/roles`),
  getBySlug: (companyId: string, slug: string) =>
    api.get<RoleDefinition>(
      `/companies/${encodeURIComponent(companyId)}/roles/${encodeURIComponent(slug)}`,
    ),
  create: (companyId: string, data: Partial<RoleDefinition>) =>
    api.post<RoleDefinition>(`/companies/${encodeURIComponent(companyId)}/roles`, data),
  update: (id: string, data: Partial<RoleDefinition>) =>
    api.patch<RoleDefinition>(`/roles/${encodeURIComponent(id)}`, data),
  authorityMatrix: (id: string) =>
    api.get<RoleAuthorityMatrix>(`/roles/${encodeURIComponent(id)}/authority-matrix`),
};
