import { useMemo } from "react";
import { useDelegationAuthority } from "./useDelegationAuthority";
import { useRoles } from "./useRoles";

export function useSpawnGovernance(parentAgentId: string | undefined) {
  const { data: authority } = useDelegationAuthority(parentAgentId);
  const { data: roles } = useRoles();

  return useMemo(() => {
    if (!authority || !roles) return null;

    const allowed = new Set(authority.allowedSpawnTypes);
    return {
      allowedRoles: roles.filter((role) => allowed.has(role.slug)),
      disabledRoles: roles.filter((role) => !allowed.has(role.slug)),
      budget: authority.spawnBudget,
      isFull: authority.spawnBudget.remaining <= 0,
    };
  }, [authority, roles]);
}
