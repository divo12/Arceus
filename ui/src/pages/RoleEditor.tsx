import { useEffect, useMemo, useState } from "react";
import type { AgentRole, RoleDefinition } from "@paperclipai/shared";
import { AGENT_ROLES, AGENT_ROLE_LABELS, DELEGATION_STYLES, EMPLOYEE_ROLES } from "@paperclipai/shared";
import { Shield, Plus, Lock, ChevronDown, X } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCreateRole, useRoles, useUpdateRole } from "@/hooks/useRoles";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cn } from "@/lib/utils";
import { DelegationStyleBadge } from "@/components/DelegationStyleBadge";
import { RoleTagChip } from "@/components/RoleTagChip";
import { AuthorityMatrix } from "@/components/AuthorityMatrix";

function createDefaultRolePayload(slug: AgentRole, label: string) {
  return {
    slug: slug as RoleDefinition["slug"],
    label,
    systemPrompt: "",
    tools: [],
    skillsSeed: [],
    canDelegateTo: [],
    delegationStyle: "collaborative" as RoleDefinition["delegationStyle"],
    spawnRules: {
      allowedAgentTypes: [],
      maxConcurrentSpawns: 0,
      spawnDepth: 1 as const,
    },
  };
}

function normalizeStringList(values: string[]) {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function StringListEditor({
  values,
  draftValue,
  onDraftChange,
  onAdd,
  onRemove,
  placeholder,
  emptyMessage,
}: {
  values: string[];
  draftValue: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (value: string) => void;
  placeholder: string;
  emptyMessage: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {values.length > 0 ? (
          values.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-xs"
            >
              {value}
              <button
                type="button"
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => onRemove(value)}
                aria-label={`Remove ${value}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        ) : (
          <span className="text-xs italic text-muted-foreground">{emptyMessage}</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={draftValue}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
          className="h-8"
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          Add
        </Button>
      </div>
    </div>
  );
}

function RoleCard({
  role,
  allRoles,
  onSave,
  isSaving,
}: {
  role: RoleDefinition;
  allRoles: RoleDefinition[];
  onSave: (data: Partial<RoleDefinition>) => void;
  isSaving: boolean;
}) {
  const [open, setOpen] = useState(role.slug === "ceo");
  const [systemPrompt, setSystemPrompt] = useState(role.systemPrompt);
  const [delegationStyle, setDelegationStyle] = useState(role.delegationStyle);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>(role.canDelegateTo);
  const [allowedAgentTypes, setAllowedAgentTypes] = useState<string[]>(role.spawnRules.allowedAgentTypes);
  const [maxConcurrentSpawns, setMaxConcurrentSpawns] = useState(role.spawnRules.maxConcurrentSpawns);
  const [tools, setTools] = useState<string[]>(role.tools);
  const [skillsSeed, setSkillsSeed] = useState<string[]>(role.skillsSeed);
  const [toolDraft, setToolDraft] = useState("");
  const [skillDraft, setSkillDraft] = useState("");

  useEffect(() => {
    setSystemPrompt(role.systemPrompt);
    setDelegationStyle(role.delegationStyle);
    setCanDelegateTo(role.canDelegateTo);
    setAllowedAgentTypes(role.spawnRules.allowedAgentTypes);
    setMaxConcurrentSpawns(role.spawnRules.maxConcurrentSpawns);
    setTools(role.tools);
    setSkillsSeed(role.skillsSeed);
    setToolDraft("");
    setSkillDraft("");
  }, [role]);

  const isDirty = useMemo(
    () =>
      systemPrompt !== role.systemPrompt
      || delegationStyle !== role.delegationStyle
      || JSON.stringify([...canDelegateTo].sort()) !== JSON.stringify([...role.canDelegateTo].sort())
      || JSON.stringify([...allowedAgentTypes].sort()) !== JSON.stringify([...role.spawnRules.allowedAgentTypes].sort())
      || maxConcurrentSpawns !== role.spawnRules.maxConcurrentSpawns
      || JSON.stringify([...tools].sort()) !== JSON.stringify([...role.tools].sort())
      || JSON.stringify([...skillsSeed].sort()) !== JSON.stringify([...role.skillsSeed].sort()),
    [
      allowedAgentTypes,
      canDelegateTo,
      delegationStyle,
      maxConcurrentSpawns,
      role,
      skillsSeed,
      systemPrompt,
      tools,
    ],
  );

  function toggleFromList(current: string[], value: string) {
    return current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
  }

  function addTool() {
    const next = normalizeStringList([...tools, toolDraft]);
    setTools(next);
    setToolDraft("");
  }

  function addSkillSeed() {
    const next = normalizeStringList([...skillsSeed, skillDraft]);
    setSkillsSeed(next);
    setSkillDraft("");
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border bg-card">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <Shield className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{role.label}</span>
                <DelegationStyleBadge style={delegationStyle} />
                {role.isBuiltIn ? <Badge variant="outline">built-in</Badge> : null}
                {role.isBuiltIn ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : null}
              </div>
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                {systemPrompt || "No system prompt configured yet."}
              </p>
            </div>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border px-4 pb-4 pt-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                System Prompt
              </div>
              <Textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="min-h-[120px] font-mono text-sm"
                placeholder="Enter the role's behavioral instructions..."
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Delegation Authority
              </div>
              <div className="flex flex-wrap gap-2">
                {allRoles
                  .filter((candidate) => candidate.slug !== role.slug)
                  .map((candidate) => {
                    const selected = canDelegateTo.includes(candidate.slug);
                    return (
                      <button
                        key={candidate.slug}
                        type="button"
                        onClick={() => setCanDelegateTo((current) => toggleFromList(current, candidate.slug))}
                        className={cn(
                          "rounded-md border px-2 py-1 text-left transition-colors",
                          selected ? "border-blue-500/30 bg-blue-500/10" : "border-border hover:bg-accent/40",
                        )}
                      >
                        <RoleTagChip role={candidate.slug} variant="delegation" />
                      </button>
                    );
                  })}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Style</span>
                <Select
                  value={delegationStyle}
                  onValueChange={(value) => setDelegationStyle(value as RoleDefinition["delegationStyle"])}
                >
                  <SelectTrigger className="w-44" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DELEGATION_STYLES.map((style) => (
                      <SelectItem key={style} value={style}>
                        {style}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Spawn Rules
              </div>
              <div className="flex flex-wrap gap-2">
                {AGENT_ROLES.filter(
                  (candidateRole) =>
                    !(EMPLOYEE_ROLES as readonly string[]).includes(candidateRole),
                ).map((candidateRole) => {
                  const selected = allowedAgentTypes.includes(candidateRole);
                  return (
                    <button
                      key={candidateRole}
                      type="button"
                      onClick={() => setAllowedAgentTypes((current) => toggleFromList(current, candidateRole))}
                      className={cn(
                        "rounded-md border px-2 py-1 text-left transition-colors",
                        selected ? "border-violet-500/30 bg-violet-500/10" : "border-border hover:bg-accent/40",
                      )}
                    >
                      <RoleTagChip role={candidateRole} variant="spawn" />
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Max concurrent</span>
                <Input
                  type="number"
                  min={0}
                  max={20}
                  value={maxConcurrentSpawns}
                  onChange={(event) => setMaxConcurrentSpawns(Number(event.target.value || 0))}
                  className="h-8 w-24"
                />
                <span className="text-xs text-muted-foreground">Spawn depth: 1 (fixed)</span>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tools
                </div>
                <StringListEditor
                  values={tools}
                  draftValue={toolDraft}
                  onDraftChange={setToolDraft}
                  onAdd={addTool}
                  onRemove={(value) =>
                    setTools((current) => current.filter((entry) => entry !== value))
                  }
                  placeholder="web-search"
                  emptyMessage="No default tools configured."
                />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Skills Seed
                </div>
                <StringListEditor
                  values={skillsSeed}
                  draftValue={skillDraft}
                  onDraftChange={setSkillDraft}
                  onAdd={addSkillSeed}
                  onRemove={(value) =>
                    setSkillsSeed((current) => current.filter((entry) => entry !== value))
                  }
                  placeholder="system-design"
                  emptyMessage="No seeded skills configured."
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <Button
                size="sm"
                disabled={!isDirty || isSaving}
                onClick={() =>
                  onSave({
                    systemPrompt,
                    canDelegateTo: canDelegateTo as RoleDefinition["canDelegateTo"],
                    delegationStyle,
                    spawnRules: {
                      allowedAgentTypes: allowedAgentTypes as RoleDefinition["spawnRules"]["allowedAgentTypes"],
                      maxConcurrentSpawns,
                      spawnDepth: 1,
                    },
                    tools,
                    skillsSeed,
                  })
                }
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function RoleEditor() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { data: roles, isLoading, error } = useRoles();
  const updateRole = useUpdateRole();
  const createRole = useCreateRole();
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [newRoleSlug, setNewRoleSlug] = useState<AgentRole | "">("");
  const [newRoleLabel, setNewRoleLabel] = useState("");

  const availableRoleSlugs = useMemo(
    () => AGENT_ROLES.filter((role) => !(roles ?? []).some((existing) => existing.slug === role)),
    [roles],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Roles" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Shield} message="Select a company to manage roles." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  if (!roles?.length) {
    return <EmptyState icon={Shield} message="No roles configured." />;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Roles</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure system prompts, delegation rules, and spawn budgets for each company role.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setNewRoleOpen(true)}
          disabled={availableRoleSlugs.length === 0}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New Role
        </Button>
      </div>

      <AuthorityMatrix roles={roles} />

      <div className="space-y-3">
        {roles.map((role) => (
          <RoleCard
            key={role.id}
            role={role}
            allRoles={roles.filter(
              (candidate) => (EMPLOYEE_ROLES as readonly string[]).includes(candidate.slug),
            )}
            onSave={(data) => updateRole.mutate({ id: role.id, data })}
            isSaving={updateRole.isPending}
          />
        ))}
      </div>

      <Dialog open={newRoleOpen} onOpenChange={setNewRoleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Role</DialogTitle>
            <DialogDescription>
              Add a new company-specific role definition.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Role label</div>
              <Input
                value={newRoleLabel}
                onChange={(event) => setNewRoleLabel(event.target.value)}
                placeholder="Growth strategist"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Role slug</div>
              <Select
                value={newRoleSlug}
                onValueChange={(value) => {
                  const nextRole = value as AgentRole;
                  setNewRoleSlug(nextRole);
                  if (!newRoleLabel.trim()) {
                    setNewRoleLabel(AGENT_ROLE_LABELS[nextRole]);
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an unused role" />
                </SelectTrigger>
                <SelectContent>
                  {availableRoleSlugs.map((role) => (
                    <SelectItem key={role} value={role}>
                      {AGENT_ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewRoleOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const slug = newRoleSlug;
                const label = newRoleLabel.trim();
                if (!slug || !label) return;
                await createRole.mutateAsync(createDefaultRolePayload(slug, label));
                setNewRoleOpen(false);
                setNewRoleSlug("");
                setNewRoleLabel("");
              }}
              disabled={!newRoleSlug || !newRoleLabel.trim() || createRole.isPending}
            >
              {createRole.isPending ? "Creating..." : "Create role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
