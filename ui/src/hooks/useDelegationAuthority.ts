import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

export function useDelegationAuthority(agentId: string | undefined) {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.delegation.authority(agentId ?? ""),
    queryFn: () => agentsApi.delegationAuthority(agentId ?? "", selectedCompanyId ?? undefined),
    enabled: !!agentId && !!selectedCompanyId,
  });
}

export function useCanDelegateTo(fromId: string | undefined, toId: string | undefined) {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.delegation.canDelegateTo(fromId ?? "", toId ?? ""),
    queryFn: () => agentsApi.canDelegateTo(fromId ?? "", toId ?? "", selectedCompanyId ?? undefined),
    enabled: !!fromId && !!toId && !!selectedCompanyId,
  });
}
