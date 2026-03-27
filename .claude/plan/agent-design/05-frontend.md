# Layer 1: Organization — Phase 5: Frontend

> **Parent**: See `00-overview.md` for gap analysis, execution order, risks, success criteria, and file reference.
> **Branch**: `dev/agent-framework`
> **Package names**: `@paperclipai/db`, `@paperclipai/shared`
> **Codebase patterns**: Factory functions taking `Db`, Express Router factories, Zod validation via `validate()` middleware, `throw HttpError` caught by centralized `errorHandler`, flat JSON responses.

---

## Phase 5: Frontend — Data Layer

> Follows existing codebase patterns: `api` client wrapper, React Query v5, centralized `queryKeys`, `useMutation`, `useToast`.

### 5.1 Query keys

**File**: `ui/src/lib/queryKeys.ts` (modify) — add new entries:

```typescript
export const queryKeys = {
  // ... existing keys ...

  roles: {
    list: (companyId: string) => ["roles", companyId] as const,
    detail: (id: string) => ["roles", "detail", id] as const,
    bySlug: (companyId: string, slug: string) => ["roles", companyId, slug] as const,
    authorityMatrix: (id: string) => ["roles", "authority-matrix", id] as const,
  },

  hierarchy: {
    active: (companyId: string) => ["hierarchy", companyId, "active"] as const,
    proposals: (companyId: string) => ["hierarchy", companyId, "proposals"] as const,
    snapshot: (id: string) => ["hierarchy", "snapshot", id] as const,
    diff: (id: string) => ["hierarchy", "diff", id] as const,
    pendingCount: (companyId: string) => ["hierarchy", companyId, "pending-count"] as const,
  },

  delegation: {
    authority: (agentId: string) => ["delegation", agentId, "authority"] as const,
    canDelegateTo: (fromId: string, toId: string) =>
      ["delegation", fromId, "can-delegate", toId] as const,
  },
};
```

### 5.2 API clients

**File**: `ui/src/api/roles.ts` (new) — follows `agentsApi` pattern:

```typescript
import { api } from "./client";
import type { RoleDefinition } from "@paperclip/shared";

export const rolesApi = {
  list: (companyId: string) =>
    api.get<RoleDefinition[]>(`/companies/${companyId}/roles`),

  get: (id: string) =>
    api.get<RoleDefinition>(`/roles/${id}`),

  getBySlug: (companyId: string, slug: string) =>
    api.get<RoleDefinition>(`/companies/${companyId}/roles/${encodeURIComponent(slug)}`),

  create: (companyId: string, data: Partial<RoleDefinition>) =>
    api.post<RoleDefinition>(`/companies/${companyId}/roles`, data),

  update: (id: string, data: Partial<RoleDefinition>) =>
    api.put<RoleDefinition>(`/roles/${id}`, data),

  authorityMatrix: (id: string) =>
    api.get<{ fromSlug: string; toSlug: string; allowed: boolean }[]>(
      `/roles/${id}/authority-matrix`
    ),
};
```

**File**: `ui/src/api/hierarchy.ts` (new):

```typescript
import { api } from "./client";
import type { HierarchySnapshot, HierarchyEdge } from "@paperclip/shared";

interface HierarchyDiff {
  added: HierarchyEdge[];
  removed: HierarchyEdge[];
  modified: HierarchyEdge[];
}

interface ProposalInput {
  edges: { sourceAgentId: string; targetAgentId: string; edgeType: string }[];
  description: string;
}

export const hierarchyApi = {
  getActive: (companyId: string) =>
    api.get<HierarchySnapshot>(`/companies/${companyId}/hierarchy`),

  listProposals: (companyId: string) =>
    api.get<HierarchySnapshot[]>(`/companies/${companyId}/hierarchy/proposals`),

  createProposal: (companyId: string, data: ProposalInput) =>
    api.post<HierarchySnapshot>(`/companies/${companyId}/hierarchy/proposals`, data),

  getSnapshot: (id: string) =>
    api.get<HierarchySnapshot & { edges: HierarchyEdge[] }>(`/hierarchy/${id}`),

  approve: (id: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${id}/approve`, {}),

  activate: (id: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${id}/activate`, {}),

  reject: (id: string, reason: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${id}/reject`, { reason }),

  diff: (id: string) =>
    api.get<HierarchyDiff>(`/hierarchy/${id}/diff`),
};
```

**File**: `ui/src/api/agents.ts` (modify) — add to existing `agentsApi`:

```typescript
// Add to agentsApi object:
delegationAuthority: (id: string, companyId?: string) =>
  api.get<{
    canDelegateTo: AgentRole[];
    delegationStyle: DelegationStyle;
    spawnBudget: { active: number; max: number; remaining: number };
    allowedSpawnTypes: AgentRole[];
  }>(agentPath(id, companyId) + "/delegation-authority"),

canDelegateTo: (fromId: string, toId: string, companyId?: string) =>
  api.get<{ allowed: boolean; reason: string }>(
    agentPath(fromId, companyId) + `/can-delegate-to/${toId}`
  ),
```

### 5.3 Custom hooks

**File**: `ui/src/hooks/useRoles.ts` (new)

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { rolesApi } from "@/api/roles";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";

export function useRoles() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.roles.list(selectedCompanyId!),
    queryFn: () => rolesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
}

export function useUpdateRole() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<RoleDefinition> }) =>
      rolesApi.update(id, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.roles.list(selectedCompanyId!),
      });
      queryClient.setQueryData(queryKeys.roles.detail(updated.id), updated);
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
      rolesApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.roles.list(selectedCompanyId!),
      });
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
```

**File**: `ui/src/hooks/useHierarchy.ts` (new)

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { hierarchyApi } from "@/api/hierarchy";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";

export function useActiveHierarchy() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.hierarchy.active(selectedCompanyId!),
    queryFn: () => hierarchyApi.getActive(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
}

export function useHierarchyProposals() {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
    queryFn: () => hierarchyApi.listProposals(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
}

export function usePendingProposalCount() {
  const { data: proposals } = useHierarchyProposals();
  return useMemo(
    () => (proposals ?? []).filter((p) => p.status === "proposed").length,
    [proposals],
  );
}

export function useApproveProposal() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  return useMutation({
    mutationFn: (id: string) => hierarchyApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
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
    onSuccess: () => {
      // Invalidate hierarchy + agents (reportsTo changed) + org tree
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.active(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.org(selectedCompanyId!),
      });
      pushToast({ title: "Hierarchy activated — org chart updated", tone: "success" });
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
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
      });
      pushToast({ title: "Proposal rejected", tone: "info" });
    },
  });
}
```

**File**: `ui/src/hooks/useDelegationAuthority.ts` (new)

```typescript
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";

export function useDelegationAuthority(agentId: string | undefined) {
  const { selectedCompanyId } = useCompany();

  return useQuery({
    queryKey: queryKeys.delegation.authority(agentId!),
    queryFn: () => agentsApi.delegationAuthority(agentId!, selectedCompanyId ?? undefined),
    enabled: !!agentId && !!selectedCompanyId,
  });
}
```

**File**: `ui/src/hooks/useSpawnGovernance.ts` (new)

```typescript
import { useMemo } from "react";
import { useDelegationAuthority } from "./useDelegationAuthority";
import { useRoles } from "./useRoles";

/** Pre-computes which roles the parent can spawn + remaining budget */
export function useSpawnGovernance(parentAgentId: string | undefined) {
  const { data: authority } = useDelegationAuthority(parentAgentId);
  const { data: roles } = useRoles();

  return useMemo(() => {
    if (!authority || !roles) return null;
    return {
      allowedRoles: roles.filter((r) =>
        authority.allowedSpawnTypes.includes(r.slug),
      ),
      disabledRoles: roles.filter(
        (r) => !authority.allowedSpawnTypes.includes(r.slug),
      ),
      budget: authority.spawnBudget,
      isFull: authority.spawnBudget.remaining <= 0,
    };
  }, [authority, roles]);
}
```

---

## Phase 5: Frontend — Components

### 5.4 DelegationStyleBadge

**File**: `ui/src/components/DelegationStyleBadge.tsx` (new)

```tsx
import { type DelegationStyle } from "@paperclip/shared";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const config: Record<DelegationStyle, {
  sm: string; md: string; className: string; tip: string;
}> = {
  directive: {
    sm: "D", md: "directive",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tip: "Full oversight — specific instructions, delegator retains control",
  },
  collaborative: {
    sm: "C", md: "collaborative",
    className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    tip: "Shared context — mutual input, delegatee has autonomy on approach",
  },
  autonomous: {
    sm: "A", md: "autonomous",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    tip: "Goal-driven — minimal oversight, delegatee owns execution",
  },
};

interface DelegationStyleBadgeProps {
  style: DelegationStyle;
  size?: "sm" | "md";
}

export function DelegationStyleBadge({ style, size = "sm" }: DelegationStyleBadgeProps) {
  const c = config[style];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center rounded-full font-medium uppercase tracking-wide whitespace-nowrap",
            size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5",
            c.className,
          )}
        >
          {size === "sm" ? c.sm : c.md}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs max-w-48">
        {c.tip}
      </TooltipContent>
    </Tooltip>
  );
}
```

### 5.5 RoleTagChip

**File**: `ui/src/components/RoleTagChip.tsx` (new)

```tsx
import { type AgentRole, AGENT_ROLE_LABELS } from "@paperclip/shared";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const variantClasses = {
  delegation: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  spawn: "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300",
} as const;

interface RoleTagChipProps {
  role: AgentRole;
  removable?: boolean;
  onRemove?: () => void;
  variant?: "delegation" | "spawn";
  onClick?: () => void;
}

export function RoleTagChip({
  role, removable, onRemove, variant = "delegation", onClick,
}: RoleTagChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        variantClasses[variant],
        onClick && "cursor-pointer hover:opacity-80",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {AGENT_ROLE_LABELS[role] ?? role}
      {removable && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          className="ml-0.5 h-3 w-3 text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${role}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
```

### 5.6 HierarchyEdgeLegend

**File**: `ui/src/components/HierarchyEdgeLegend.tsx` (new)

```tsx
export function HierarchyEdgeLegend() {
  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-4 bg-background/80 backdrop-blur rounded-md border border-border px-2.5 py-1.5 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="currentColor" strokeWidth="2" /></svg>
        Reports to
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="20" height="2"><line x1="0" y1="1" x2="20" y2="1" stroke="var(--chart-1)" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.6" /></svg>
        Delegates to
      </span>
    </div>
  );
}
```

### 5.7 AuthorityMatrix

**File**: `ui/src/components/AuthorityMatrix.tsx` (new)

```tsx
import { type RoleDefinition } from "@paperclip/shared";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface AuthorityMatrixProps {
  roles: RoleDefinition[];
}

export function AuthorityMatrix({ roles }: AuthorityMatrixProps) {
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  return (
    <table className="text-xs border border-border rounded-lg overflow-hidden">
      <thead>
        <tr className="bg-muted/50">
          <th className="text-right pr-2 text-muted-foreground font-medium py-1.5 px-2">
            From \ To
          </th>
          {roles.map((r, ci) => (
            <th
              key={r.slug}
              className={cn(
                "w-12 h-8 text-center text-muted-foreground font-medium",
                hoveredCol === ci && "bg-accent/30",
              )}
            >
              {r.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {roles.map((from, ri) => (
          <tr
            key={from.slug}
            onMouseEnter={() => setHoveredRow(ri)}
            onMouseLeave={() => setHoveredRow(null)}
            className={cn(hoveredRow === ri && "bg-accent/20")}
          >
            <td className="bg-muted/50 text-muted-foreground font-medium text-right pr-2 py-1.5 px-2">
              {from.label}
            </td>
            {roles.map((to, ci) => {
              const isSelf = from.slug === to.slug;
              const allowed = from.canDelegateTo.includes(to.slug);
              return (
                <td
                  key={to.slug}
                  className={cn(
                    "w-12 h-8 text-center",
                    hoveredCol === ci && "bg-accent/20",
                  )}
                  onMouseEnter={() => setHoveredCol(ci)}
                  onMouseLeave={() => setHoveredCol(null)}
                >
                  {isSelf ? (
                    <span className="text-muted-foreground">·</span>
                  ) : allowed ? (
                    <span className="text-emerald-500">✓</span>
                  ) : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### 5.8 SpawnBudgetBar

**File**: `ui/src/components/SpawnBudgetBar.tsx` (new)

```tsx
import { cn } from "@/lib/utils";

interface SpawnBudgetBarProps {
  active: number;
  max: number;
}

export function SpawnBudgetBar({ active, max }: SpawnBudgetBarProps) {
  if (max === 0) {
    return <span className="text-xs text-muted-foreground italic">No spawn authority</span>;
  }
  const pct = (active / max) * 100;
  const barColor = pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-300", barColor)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {active}/{max}
      </span>
    </div>
  );
}
```

---

## Phase 5: Frontend — Pages & Wireframes

### 5.9 Role Editor (`/roles`)

**File**: `ui/src/pages/RoleEditor.tsx` (new)
**Purpose**: Board configures role definitions — system prompts, delegation authority, spawn rules

#### Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  Roles                                               [+ New Role]  │
│  Configure agent role definitions for this company                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ CEO ──────────────────────────────────────────────────────┐    │
│  │  [Crown icon]  CEO  [directive]  [built-in]  [lock icon]   │    │
│  │                                                             │    │
│  │  System Prompt ──────────────────────────────────────────── │    │
│  │  │ You are the Chief Executive Officer. You set vision,   │ │    │
│  │  │ coordinate the team, and report to the Board...        │ │    │
│  │  └─────────────────────────────────────────────────────── │    │
│  │                                                             │    │
│  │  Delegation Authority ──────────────────────────────────── │    │
│  │  Can delegate to: [CTO] [PM] [Engineer] [Designer]         │    │
│  │  Style: [directive ▼]                                       │    │
│  │                                                             │    │
│  │  Spawn Rules ───────────────────────────────────────────── │    │
│  │  Can create:  [Researcher] [QA] [DevOps] [General]             │  │
│  │  Max concurrent: [10]     Spawn depth: 1 (fixed)           │    │
│  │                                                             │    │
│  │  Tools: [web-search] [market-analysis] [meeting] [+]       │    │
│  │  Skills: [strategy] [leadership] [research] [+]            │    │
│  │                                                             │    │
│  │                             [Reset to Default]  [Save]      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ CTO ──────────────────────────────────────────────────────┐    │
│  │  ...collapsed by default...                     [Expand ▼]  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

#### Page skeleton (data loading & state management)

```tsx
import { useRoles, useUpdateRole, useCreateRole } from "@/hooks/useRoles";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { PageSkeleton } from "@/components/PageSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { Shield, Plus } from "lucide-react";

export function RoleEditor() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { data: roles, isLoading, error } = useRoles();
  const updateRole = useUpdateRole();
  const createRole = useCreateRole();

  useEffect(() => {
    setBreadcrumbs([{ label: "Roles" }]);
  }, [setBreadcrumbs]);

  // Guard: no company
  if (!selectedCompanyId) {
    return <EmptyState icon={Shield} message="Select a company to manage roles." />;
  }

  // Loading
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Error
  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  // Empty (should not happen with seed data, but defensive)
  if (!roles?.length) {
    return <EmptyState icon={Shield} message="No roles configured." action="Initialize Roles" onAction={() => {}} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Roles</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure agent role definitions for this company
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => createRole.mutate({...})}>
          <Plus className="h-4 w-4 mr-1" /> New Role
        </Button>
      </div>

      {roles.map((role) => (
        <RoleCard
          key={role.id}
          role={role}
          allRoles={roles}
          onSave={(data) => updateRole.mutate({ id: role.id, data })}
          isSaving={updateRole.isPending}
        />
      ))}
    </div>
  );
}
```

#### RoleCard sub-component (local dirty state pattern)

Each role card manages its own form state locally, only calling the mutation on Save:

```tsx
interface RoleCardProps {
  role: RoleDefinition;
  allRoles: RoleDefinition[];
  onSave: (data: Partial<RoleDefinition>) => void;
  isSaving: boolean;
}

function RoleCard({ role, allRoles, onSave, isSaving }: RoleCardProps) {
  // Local state — initialized from server data, tracks dirty edits
  const [systemPrompt, setSystemPrompt] = useState(role.systemPrompt);
  const [canDelegateTo, setCanDelegateTo] = useState(role.canDelegateTo);
  const [delegationStyle, setDelegationStyle] = useState(role.delegationStyle);
  const [tools, setTools] = useState(role.tools);
  const [skillsSeed, setSkillsSeed] = useState(role.skillsSeed);
  const [spawnRules, setSpawnRules] = useState(role.spawnRules);

  // Reset local state when server data changes (e.g., after save or reset)
  useEffect(() => {
    setSystemPrompt(role.systemPrompt);
    setCanDelegateTo(role.canDelegateTo);
    setDelegationStyle(role.delegationStyle);
    setTools(role.tools);
    setSkillsSeed(role.skillsSeed);
    setSpawnRules(role.spawnRules);
  }, [role]);

  // Dirty detection
  const isDirty = useMemo(() =>
    systemPrompt !== role.systemPrompt ||
    JSON.stringify(canDelegateTo) !== JSON.stringify(role.canDelegateTo) ||
    delegationStyle !== role.delegationStyle ||
    JSON.stringify(tools) !== JSON.stringify(role.tools) ||
    JSON.stringify(skillsSeed) !== JSON.stringify(role.skillsSeed) ||
    JSON.stringify(spawnRules) !== JSON.stringify(role.spawnRules),
    [systemPrompt, canDelegateTo, delegationStyle, tools, skillsSeed, spawnRules, role],
  );

  // Debounced prompt value for auto-preview (not auto-save)
  const debouncedPrompt = useDebounce(systemPrompt, 500);

  function handleSave() {
    onSave({
      systemPrompt,
      canDelegateTo,
      delegationStyle,
      tools,
      skillsSeed,
      spawnRules,
    });
  }

  return (
    <Collapsible>
      {/* Header: icon, label, DelegationStyleBadge, built-in badge, expand trigger */}
      <CollapsibleTrigger asChild>
        <div className="px-4 py-3 flex items-center gap-3 border border-border rounded-lg bg-card cursor-pointer hover:bg-accent/50">
          {/* ... header content ... */}
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent className="px-4 pb-4 space-y-4 border-x border-b border-border rounded-b-lg">
        {/* System Prompt textarea */}
        {/* Delegation chips + style select */}
        {/* Spawn rules chips + max concurrent input */}
        {/* Tools / Skills tag inputs */}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
          {role.isBuiltIn && (
            <Button variant="ghost" size="sm" onClick={handleReset}>
              Reset to Default
            </Button>
          )}
          <Button size="sm" disabled={!isDirty || isSaving} onClick={handleSave}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
```

#### CSS specifications

**Role card** (uses `Collapsible` from shadcn):
```
Container:     border border-border rounded-lg bg-card
Header row:    px-4 py-3 flex items-center gap-3
               ├── AgentIcon (role-appropriate icon, w-8 h-8 in bg-muted rounded-lg)
               ├── Role label: text-sm font-semibold
               ├── DelegationStyleBadge (see 5.4)
               ├── if isBuiltIn: Badge variant="outline" → "built-in"
               ├── if isBuiltIn: Lock icon (h-3.5 w-3.5 text-muted-foreground)
               └── Collapsible trigger (ChevronDown, right-aligned)
Expanded body: px-4 pb-4 space-y-4 border-t border-border
```

**System prompt editor**:
```
Label:    text-xs text-muted-foreground font-medium uppercase tracking-wide
Textarea: min-h-[120px] text-sm font-mono bg-muted/30 border border-border rounded-md px-3 py-2
          resize-y, placeholder="Enter the role's behavioral instructions..."
```

**Delegation authority section**:
```
Label:           text-xs text-muted-foreground font-medium uppercase tracking-wide
"Can delegate to": flex flex-wrap gap-1.5 → RoleTagChip per allowed role
                   [+] button opens Popover with checkboxes for remaining roles
"Style":          Select dropdown → directive | collaborative | autonomous
                  Each option: label + text-xs text-muted-foreground description
```

**Spawn rules section**:
```
"Can create":       flex flex-wrap gap-1.5 → RoleTagChip variant="spawn"
"Max concurrent":   Input type="number" className="w-20" min={0} max={20}
"Spawn depth":      text-xs text-muted-foreground → "1 (fixed)"
```

**Tools / Skills**: flex flex-wrap gap-1.5 of removable tags. `[+]` button opens text input Popover — type name, press Enter to add.

---

### 5.10 Hierarchy Proposals (`/hierarchy/proposals`)

**File**: `ui/src/pages/HierarchyProposals.tsx` (new)
**Purpose**: Board reviews, approves, and activates org chart changes proposed by agents

#### Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  Hierarchy Proposals                                                │
│  Review and approve organizational changes                         │
├────────────────────────────────────────────────────────────────────┤
│  [Pending (2)]  [All]                           ← PageTabBar       │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ Proposal #1 ─────────────────────────────────────────────┐     │
│  │  ┌──────────────────┐                                      │     │
│  │  │  [Network icon]  │  "Add Designer role under CTO"       │     │
│  │  │  proposed         │  Proposed by: CEO (Atlas) · 2h ago  │     │
│  │  └──────────────────┘                                      │     │
│  │                                                             │     │
│  │  Rationale:                                                 │     │
│  │  "The product needs dedicated design work. Adding a        │     │
│  │   Designer reporting to CTO for UI/UX execution."          │     │
│  │                                                             │     │
│  │  Changes:                                                   │     │
│  │  + Designer → reports_to → CTO                              │     │
│  │  + CTO → delegates_to → Designer                           │     │
│  │                                                             │     │
│  │  ┌─ Current ──────────┐  ┌─ Proposed ─────────────┐       │     │
│  │  │    ┌─────┐         │  │    ┌─────┐              │       │     │
│  │  │    │ CEO │         │  │    │ CEO │              │       │     │
│  │  │    └──┬──┘         │  │    └──┬──┘              │       │     │
│  │  │    ┌──┴──┐         │  │  ┌───┼───┐             │       │     │
│  │  │  ┌─┴─┐┌─┴─┐       │  │┌─┴─┐┌┴──┐┌───┐        │       │     │
│  │  │  │CTO││ PM│       │  ││CTO││PM ││Des│        │       │     │
│  │  │  └───┘└───┘       │  │└───┘└───┘└───┘        │       │     │
│  │  └────────────────────┘  └────────────────────────┘       │     │
│  │                                                             │     │
│  │              [Reject]  [Approve]  [Approve & Activate]      │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                     │
│  ┌─ Proposal #2 ─────────────────────────────────────────────┐     │
│  │  ...                                                        │     │
│  └─────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Page skeleton (data loading, mutations, tab state)

```tsx
import {
  useHierarchyProposals, useApproveProposal,
  useActivateProposal, useRejectProposal,
} from "@/hooks/useHierarchy";
import { useActiveHierarchy } from "@/hooks/useHierarchy";
import { PageSkeleton } from "@/components/PageSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { PageTabBar } from "@/components/PageTabBar";
import { Network } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function HierarchyProposals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [rejectDialogId, setRejectDialogId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data: proposals, isLoading } = useHierarchyProposals();
  const { data: activeSnapshot } = useActiveHierarchy();
  const approve = useApproveProposal();
  const activate = useActivateProposal();
  const reject = useRejectProposal();

  useEffect(() => {
    setBreadcrumbs([{ label: "Hierarchy" }, { label: "Proposals" }]);
  }, [setBreadcrumbs]);

  const pendingCount = useMemo(
    () => (proposals ?? []).filter((p) => p.status === "proposed").length,
    [proposals],
  );

  const filtered = useMemo(
    () => tab === "pending"
      ? (proposals ?? []).filter((p) => p.status === "proposed")
      : (proposals ?? []),
    [proposals, tab],
  );

  async function handleApproveAndActivate(id: string) {
    await approve.mutateAsync(id);
    await activate.mutateAsync(id);
    navigate("/org");
  }

  function handleReject() {
    if (!rejectDialogId || !rejectReason.trim()) return;
    reject.mutate(
      { id: rejectDialogId, reason: rejectReason.trim() },
      { onSuccess: () => { setRejectDialogId(null); setRejectReason(""); } },
    );
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company." />;
  }
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Hierarchy Proposals</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and approve organizational changes
        </p>
      </div>

      <PageTabBar
        items={[
          { id: "pending", label: "Pending", count: pendingCount },
          { id: "all", label: "All" },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as "pending" | "all")}
      />

      {filtered.length === 0 ? (
        <EmptyState icon={Network} message="No hierarchy proposals pending." />
      ) : (
        <div className="space-y-4">
          {filtered.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              activeSnapshot={activeSnapshot}
              onApprove={() => approve.mutate(proposal.id)}
              onApproveAndActivate={() => handleApproveAndActivate(proposal.id)}
              onReject={() => setRejectDialogId(proposal.id)}
              isActioning={approve.isPending || activate.isPending}
            />
          ))}
        </div>
      )}

      {/* Reject reason dialog */}
      <Dialog open={!!rejectDialogId} onOpenChange={() => setRejectDialogId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Proposal</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="Reason for rejection (required)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="min-h-[80px]"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectDialogId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!rejectReason.trim() || reject.isPending}
              onClick={handleReject}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

#### ProposalCard sub-component

```tsx
interface ProposalCardProps {
  proposal: HierarchySnapshot;
  activeSnapshot: HierarchySnapshot | undefined;
  onApprove: () => void;
  onApproveAndActivate: () => void;
  onReject: () => void;
  isActioning: boolean;
}
```

Fetches diff on mount (lazy — only when card renders):

```tsx
function ProposalCard({ proposal, activeSnapshot, ... }: ProposalCardProps) {
  const { data: diff } = useQuery({
    queryKey: queryKeys.hierarchy.diff(proposal.id),
    queryFn: () => hierarchyApi.diff(proposal.id),
    enabled: !!proposal.id,
  });

  // ... renders header, rationale, diff list, mini org charts, action buttons
}
```

#### CSS specifications

**Proposal card**:
```
Container:    border border-border rounded-lg bg-card
Header:       px-4 py-3 flex items-center gap-3
              ├── Icon container: rounded-lg bg-primary/10 p-2
              │   └── Network icon (h-4 w-4 text-primary)
              ├── Title: text-sm font-semibold
              ├── StatusBadge (proposed | approved | active | rejected)
              └── Metadata: text-xs text-muted-foreground → "Proposed by: {name} · {timeAgo}"
Body:         px-4 pb-4 space-y-4
```

**Rationale block**:
```
Label:   text-xs text-muted-foreground font-medium uppercase tracking-wide
Content: text-sm text-foreground bg-muted/30 rounded-md px-3 py-2 border border-border
```

**Changes diff list**:
```
Container: space-y-1
Added:     text-xs font-mono → "+" prefix in text-emerald-500
Removed:   text-xs font-mono → "−" prefix in text-red-500
Modified:  text-xs font-mono → "~" prefix in text-amber-500
```

**Side-by-side mini org charts**:
```
Container: grid grid-cols-1 md:grid-cols-2 gap-4
Each side: border border-border rounded-lg p-4 bg-muted/20
Label:     text-xs text-muted-foreground font-medium mb-2 → "Current" / "Proposed"
Chart:     Reuse OrgChart's layoutTree() at smaller scale:
           CARD_W = 80, CARD_H = 36, GAP_X = 12, GAP_Y = 32
           Node: rounded-md bg-card border px-2 py-1 text-[10px] font-medium
           New nodes: border-emerald-500 border-dashed
           Removed nodes: border-red-500 border-dashed opacity-50
```

**Action buttons**:
```
Container: flex items-center justify-end gap-2 pt-3 border-t border-border
[Reject]:              Button variant="ghost" size="sm" className="text-destructive"
[Approve]:             Button variant="outline" size="sm" disabled={isActioning}
[Approve & Activate]:  Button variant="default" size="sm" disabled={isActioning}
```

---

### 5.11 OrgChart Enhancements (`/org`)

**File**: `ui/src/pages/OrgChart.tsx` (modify)

#### New data queries

Add alongside existing `orgTree` query:

```tsx
// Existing
const { data: orgTree } = useQuery({
  queryKey: queryKeys.org(selectedCompanyId!),
  queryFn: () => agentsApi.org(selectedCompanyId!),
  enabled: !!selectedCompanyId,
});

// New: delegation edges from active hierarchy snapshot
const { data: activeHierarchy } = useQuery({
  queryKey: queryKeys.hierarchy.active(selectedCompanyId!),
  queryFn: () => hierarchyApi.getActive(selectedCompanyId!),
  enabled: !!selectedCompanyId,
});

// New: pending proposal count for banner
const { data: proposals } = useQuery({
  queryKey: queryKeys.hierarchy.proposals(selectedCompanyId!),
  queryFn: () => hierarchyApi.listProposals(selectedCompanyId!),
  enabled: !!selectedCompanyId,
});

const pendingCount = useMemo(
  () => (proposals ?? []).filter((p) => p.status === "proposed").length,
  [proposals],
);

// Local toggle state
const [showDelegation, setShowDelegation] = useState(true);

// Derive delegation edges from active snapshot
const delegationEdges = useMemo(
  () => (activeHierarchy?.edges ?? []).filter((e) => e.edgeType === "delegates_to"),
  [activeHierarchy],
);
```

#### SVG rendering additions

**Delegation edges** (second pass after `reports_to` edges):

```tsx
{showDelegation && delegationEdges.map((edge) => {
  const source = nodePositions.get(edge.sourceAgentId);
  const target = nodePositions.get(edge.targetAgentId);
  if (!source || !target) return null;
  return (
    <path
      key={edge.id}
      d={computeCurvedPath(source, target)}
      stroke="var(--chart-1)"
      strokeWidth={1.5}
      strokeDasharray="6,4"
      opacity={0.6}
      fill="none"
      markerEnd="url(#delegation-arrow)"
    />
  );
})}
```

**Delegation toggle** (top-right toolbar):

```tsx
<div className="flex items-center gap-1.5 bg-background border border-border rounded-md px-2 py-1">
  <span className="text-[10px] text-muted-foreground">Delegation</span>
  <Switch checked={showDelegation} onCheckedChange={setShowDelegation} />
</div>
```

**Agent card additions**: `DelegationStyleBadge` below adapter type.

**Hierarchy status banner** (when pending > 0):
```
Container:  flex items-center gap-2 px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 mb-4
Icon:       AlertTriangle (h-4 w-4 text-yellow-500)
Text:       text-sm text-yellow-700 dark:text-yellow-400
Link:       → /hierarchy/proposals
```

**Active snapshot indicator** (top-left overlay):
```
Container: flex items-center gap-1.5 px-2 py-1 bg-background/80 backdrop-blur rounded-md border border-border
Dot:       w-2 h-2 rounded-full bg-emerald-500
Text:      text-[10px] text-muted-foreground → "Active snapshot · {date}"
```

---

### 5.12 Agent Detail Authority Section

**File**: `ui/src/pages/AgentDetail.tsx` (modify)

Add a new "Authority" tab that lazy-loads delegation data:

```tsx
// In the existing tab definitions array, add:
{ id: "authority", label: "Authority" }

// Conditional query — only fetch when tab is active
const { data: authority, isLoading: authorityLoading } = useQuery({
  queryKey: queryKeys.delegation.authority(agentId),
  queryFn: () => agentsApi.delegationAuthority(agentId, selectedCompanyId ?? undefined),
  enabled: !!agentId && tab === "authority",
});

const { data: roleDefinition } = useQuery({
  queryKey: queryKeys.roles.bySlug(selectedCompanyId!, agent?.role ?? ""),
  queryFn: () => rolesApi.getBySlug(selectedCompanyId!, agent!.role),
  enabled: !!selectedCompanyId && !!agent?.role && tab === "authority",
});
```

#### AuthorityTab sub-component

```tsx
interface AuthorityTabProps {
  agent: AgentDetail;
  authority: DelegationAuthorityResponse | undefined;
  roleDefinition: RoleDefinition | undefined;
  isLoading: boolean;
}

function AuthorityTab({ agent, authority, roleDefinition, isLoading }: AuthorityTabProps) {
  const navigate = useNavigate();

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!authority || !roleDefinition) return null;

  return (
    <div className="space-y-5">
      {/* Role Definition Card */}
      <div>
        <h3 className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
          Role Definition
        </h3>
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <AgentIcon role={agent.role} className="w-6 h-6" />
            <span className="text-sm font-semibold">{roleDefinition.label}</span>
            <DelegationStyleBadge style={authority.delegationStyle} />
            <button
              className="text-xs text-primary hover:underline ml-auto"
              onClick={() => navigate("/roles")}
            >
              Edit Role
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {roleDefinition.systemPrompt || "No system prompt configured"}
          </p>
        </div>
      </div>

      {/* Delegation Authority */}
      <div>
        <h3 className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
          Delegation Authority
        </h3>
        {authority.canDelegateTo.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {authority.canDelegateTo.map((r) => (
              <RoleTagChip key={r} role={r} variant="delegation" />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No delegation authority</p>
        )}
      </div>

      {/* Spawn Authority */}
      <div>
        <h3 className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-2">
          Spawn Authority
        </h3>
        {authority.allowedSpawnTypes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {authority.allowedSpawnTypes.map((r) => (
              <RoleTagChip key={r} role={r} variant="spawn" />
            ))}
          </div>
        )}
        <SpawnBudgetBar active={authority.spawnBudget.active} max={authority.spawnBudget.max} />
        <p className="text-xs text-muted-foreground mt-1">
          {authority.spawnBudget.active}/{authority.spawnBudget.max} active
          ({authority.spawnBudget.remaining} remaining)
        </p>
      </div>
    </div>
  );
}
```

---

### 5.13 NewAgent Form Governance

**File**: `ui/src/pages/NewAgent.tsx` (modify)

#### New data dependencies

Add queries for spawn governance alongside existing form state:

```tsx
// Existing: reportsTo state
const [reportsTo, setReportsTo] = useState("");

// New: fetch governance data for the selected parent
const governance = useSpawnGovernance(reportsTo || undefined);

// New: role definitions for rich role picker
const { data: roles } = useRoles();

// New: delegation style state
const [delegationStyle, setDelegationStyle] = useState<DelegationStyle>("collaborative");
```

#### Role picker enhancement

Replace the current flat `AGENT_ROLES.map(...)` in the Popover:

```tsx
<PopoverContent className="w-72 p-0">
  <div className="max-h-64 overflow-y-auto">
    {(roles ?? []).map((roleDef) => {
      const isDisabled = governance?.disabledRoles.some((r) => r.slug === roleDef.slug);
      return (
        <button
          key={roleDef.slug}
          disabled={isDisabled}
          onClick={() => { setRole(roleDef.slug); setRoleOpen(false); }}
          className={cn(
            "flex items-start gap-3 w-full px-3 py-2 text-left hover:bg-accent/50",
            isDisabled && "opacity-50 pointer-events-none",
            role === roleDef.slug && "bg-accent/30",
          )}
        >
          <AgentIcon role={roleDef.slug} className="w-6 h-6 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{roleDef.label}</div>
            <div className="text-xs text-muted-foreground line-clamp-2">
              {roleDef.systemPrompt?.slice(0, 80) || "No description"}
            </div>
          </div>
          {isDisabled && (
            <Tooltip>
              <TooltipTrigger>
                <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />
              </TooltipTrigger>
              <TooltipContent>
                Not allowed by {agents?.find((a) => a.id === reportsTo)?.name}'s spawn rules
              </TooltipContent>
            </Tooltip>
          )}
        </button>
      );
    })}
  </div>
</PopoverContent>
```

#### Delegation style chip

Add to the existing chips row (next to Role and Reports To buttons):

```tsx
<Popover>
  <PopoverTrigger asChild>
    <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50">
      <GitBranch className="h-3 w-3" />
      {delegationStyle}
    </button>
  </PopoverTrigger>
  <PopoverContent className="w-64 p-1">
    {DELEGATION_STYLES.map((ds) => (
      <button
        key={ds}
        onClick={() => setDelegationStyle(ds)}
        className={cn(
          "w-full text-left px-3 py-2 rounded-md hover:bg-accent/50",
          delegationStyle === ds && "bg-accent/30",
        )}
      >
        <div className="text-sm font-medium">{ds}</div>
        <div className="text-xs text-muted-foreground">
          {ds === "directive" && "Full oversight, specific instructions"}
          {ds === "collaborative" && "Shared context, mutual input"}
          {ds === "autonomous" && "Minimal oversight, goal-driven"}
        </div>
      </button>
    ))}
  </PopoverContent>
</Popover>
```

#### Spawn budget warning

Below the form, conditionally rendered:

```tsx
{governance?.isFull && (
  <div className="flex items-center gap-2 px-4 py-2 rounded-md bg-amber-500/10 border border-amber-500/20">
    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
    <p className="text-xs text-amber-700 dark:text-amber-400">
      {agents?.find((a) => a.id === reportsTo)?.name} has reached the maximum
      number of reports ({governance.budget.max})
    </p>
  </div>
)}
```

#### Mutation update

Add `delegationStyle` to the existing `createAgent.mutate()` call:

```tsx
createAgent.mutate({
  name: name.trim(),
  role: effectiveRole,
  delegationStyle,    // ← new
  // ... existing fields
});
```

---

## Phase 5: Frontend — Navigation, Interaction & Responsive

### 5.14 Navigation changes

#### Sidebar

**File**: `ui/src/components/Sidebar.tsx` (or `SidebarSections.tsx`)

Add a new section group "Organization" with items. The pending count dot uses the `usePendingProposalCount()` hook:

```tsx
const pendingCount = usePendingProposalCount();

// In the sidebar section items array:
{
  title: "Organization",
  items: [
    { label: "Org Chart", icon: Network, to: "/org" },
    { label: "Roles", icon: Shield, to: "/roles" },
    {
      label: "Proposals",
      icon: GitPullRequest,
      to: "/hierarchy/proposals",
      badge: pendingCount > 0 ? pendingCount : undefined,
    },
  ],
}
```

Badge rendering for pending count:
```
If pendingCount > 0: absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500
```

#### Breadcrumbs

```
/roles                    → Company > Roles
/hierarchy/proposals      → Company > Hierarchy > Proposals
/hierarchy/proposals/:id  → Company > Hierarchy > Proposals > Proposal #{shortId}
```

Set via `setBreadcrumbs()` in each page's `useEffect`, following existing pattern.

#### Routes

**File**: `ui/src/App.tsx`

```tsx
<Route path="roles" element={<RoleEditor />} />
<Route path="hierarchy/proposals" element={<HierarchyProposals />} />
```

### 5.15 Interaction patterns

#### Role Editor

| Action | Trigger | Behavior |
|--------|---------|----------|
| Expand/collapse role | Click header or chevron | `Collapsible` from shadcn — animated open/close |
| Edit system prompt | Type in textarea | Local `useState`, card marked dirty via `useMemo` comparison |
| Add delegation target | Click `[+]` next to chips | `Popover` with checkbox list of available roles |
| Remove delegation target | Click `×` on `RoleTagChip` | `setCanDelegateTo(prev => prev.filter(...))` |
| Change delegation style | `Select` dropdown | `setDelegationStyle(...)`, marks dirty |
| Save | Click `[Save]` | `updateRole.mutate({ id, data })` → invalidates `queryKeys.roles.list` → toast "saved" |
| Reset to default | Click `[Reset]` | `Dialog` confirmation → PUT with seed values → refetch |
| Add tool/skill | Click `[+]` after tags | `Popover` with `Input` — Enter key calls `setTools(prev => [...prev, value])` |

#### Hierarchy Proposals

| Action | Trigger | Behavior |
|--------|---------|----------|
| Switch tab | Click Pending/All | `setTab(...)` → `useMemo` re-filters list |
| Approve | `[Approve]` | `approve.mutate(id)` → invalidates proposals → toast |
| Approve & Activate | `[Approve & Activate]` | `approve.mutateAsync(id)` → `activate.mutateAsync(id)` → invalidates hierarchy + agents + org → `navigate("/org")` |
| Reject | `[Reject]` | Opens `Dialog` for reason → `reject.mutate({ id, reason })` → toast |
| View diff | On card mount | `useQuery` with `queryKeys.hierarchy.diff(id)` — shows diff inline |

#### OrgChart Delegation Toggle

| Action | Trigger | Behavior |
|--------|---------|----------|
| Toggle delegation edges | `Switch` | `setShowDelegation(...)` → conditional SVG rendering with CSS opacity transition |
| Hover delegation edge | Mouse over dashed path | Set `hoveredEdge` state → source+target cards get `ring-2 ring-primary/30` |

#### Agent Detail Authority

| Action | Trigger | Behavior |
|--------|---------|----------|
| Navigate to role editor | Click "Edit Role" | `navigate("/roles")` |
| Click delegation target | Click `RoleTagChip` | Navigate to that agent's detail page via existing `agentUrl()` helper |

### 5.16 Responsive behavior

#### Mobile (< md breakpoint)

**Role Editor**:
- Cards stack full-width
- System prompt textarea: `min-h-[80px]` (reduced from 120px)
- Chips wrap naturally via `flex-wrap`

**Hierarchy Proposals**:
- Side-by-side org charts stack: `grid grid-cols-1 md:grid-cols-2`
- Action buttons: `flex flex-col gap-2 md:flex-row`

**OrgChart delegation toggle**:
- Move to bottom of chart area (above `HierarchyEdgeLegend`)
- `showDelegation` defaults to `false` on mobile via `useMediaQuery`

**Agent Detail authority section**:
- Full-width, no changes needed (already vertical layout)

**NewAgent governance**:
- Role picker `PopoverContent`: `w-full md:w-72`
- Spawn warning: full-width

#### Keyboard shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `r` | Org chart focused | Toggle `showDelegation` |
| `Enter` | Proposal card focused | Expand card details |
| `a` | Proposal card focused | `approve.mutate(id)` |
| `Shift+a` | Proposal card focused | `handleApproveAndActivate(id)` |
| `Escape` | Role editor textarea focused | Revert local state to server value |

Register via existing `useKeyboardShortcuts` hook pattern.

### 5.17 Design Guide page additions

**File**: `ui/src/pages/DesignGuide.tsx` (modify)

Add a new `<Section title="Organization">` after existing sections:

```tsx
<Section title="Organization">
  <SubSection title="DelegationStyleBadge">
    <div className="flex items-center gap-3">
      <DelegationStyleBadge style="directive" size="sm" />
      <DelegationStyleBadge style="collaborative" size="sm" />
      <DelegationStyleBadge style="autonomous" size="sm" />
    </div>
    <div className="flex items-center gap-3 mt-3">
      <DelegationStyleBadge style="directive" size="md" />
      <DelegationStyleBadge style="collaborative" size="md" />
      <DelegationStyleBadge style="autonomous" size="md" />
    </div>
  </SubSection>

  <SubSection title="RoleTagChip">
    <div className="flex items-center gap-2 flex-wrap">
      <RoleTagChip role="ceo" variant="delegation" />
      <RoleTagChip role="cto" variant="delegation" />
      <RoleTagChip role="researcher" variant="spawn" />
      <RoleTagChip role="qa" variant="spawn" removable onRemove={() => {}} />
    </div>
  </SubSection>

  <SubSection title="AuthorityMatrix">
    <AuthorityMatrix roles={demoRoles} />
  </SubSection>

  <SubSection title="SpawnBudgetBar">
    <div className="space-y-3">
      <SpawnBudgetBar active={2} max={10} />   {/* green */}
      <SpawnBudgetBar active={7} max={10} />   {/* amber */}
      <SpawnBudgetBar active={9} max={10} />   {/* red */}
      <SpawnBudgetBar active={0} max={0} />    {/* no authority */}
    </div>
  </SubSection>

  <SubSection title="HierarchyEdgeLegend">
    <div className="relative h-12">
      <HierarchyEdgeLegend />
    </div>
  </SubSection>

  <SubSection title="Org Chart Edge Types">
    <div className="flex items-center gap-8">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <svg width="40" height="2"><line x1="0" y1="1" x2="40" y2="1" stroke="currentColor" strokeWidth="2" /></svg>
        reports_to
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <svg width="40" height="2"><line x1="0" y1="1" x2="40" y2="1" stroke="var(--chart-1)" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.6" /></svg>
        delegates_to
      </span>
    </div>
  </SubSection>
</Section>
```

---

