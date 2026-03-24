import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Workflow,
  GitBranch,
  Play,
  Pause,
  CheckCircle2,
  AlertTriangle,
  Layers,
  Zap,
  Users,
  ArrowDown,
  Sparkles,
  Activity,
  Timer,
} from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent, Issue } from "@paperclipai/shared";

function getAgentTypeLabel(agent: Agent): string {
  return agent.role ?? "employee";
}

function getStatusColor(status: string) {
  switch (status) {
    case "active":
    case "running":
      return "bg-emerald-500";
    case "paused":
      return "bg-amber-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-muted-foreground";
  }
}

function OrchestrationFlowcard() {
  const phases = [
    {
      phase: "Decomposition",
      icon: GitBranch,
      color: "text-violet-500",
      bgColor: "bg-violet-500/10",
      desc: "CEO decomposes FundamentalIdea into top-level tasks. Tasks flow DOWN the hierarchy through CTO → PM → Developer.",
    },
    {
      phase: "Task Routing",
      icon: ArrowDown,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
      desc: "Each employee receives a task, reasons about complexity: simple → self-execute, complex → decompose & spawn sub-agents.",
    },
    {
      phase: "Agent Spawning",
      icon: Sparkles,
      color: "text-emerald-500",
      bgColor: "bg-emerald-500/10",
      desc: "Employees spawn ephemeral agents (Generic, Specialized, Exploratory) governed by SpawnRules. Parallel execution enabled.",
    },
    {
      phase: "Verification",
      icon: CheckCircle2,
      color: "text-amber-500",
      bgColor: "bg-amber-500/10",
      desc: "Parent agent verifies spawned agent's work. On failure → escalation meeting with manager, chaining up to the Board.",
    },
    {
      phase: "Consolidation",
      icon: Activity,
      color: "text-rose-500",
      bgColor: "bg-rose-500/10",
      desc: "Trajectory distilled to parent's Hippocampus. Light consolidation after tasks, deep consolidation during standups.",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Orchestration Flow</CardTitle>
        <CardDescription>
          The recursive task execution loop that powers every startup
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {phases.map((p, i) => {
            const Icon = p.icon;
            return (
              <div key={i} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className={cn("rounded-lg p-2", p.bgColor)}>
                    <Icon className={cn("h-4 w-4", p.color)} />
                  </div>
                  {i < phases.length - 1 && (
                    <div className="w-px h-6 bg-border my-1" />
                  )}
                </div>
                <div className="pt-1 pb-2">
                  <h4 className="text-sm font-semibold">{p.phase}</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {p.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function AgentSpawnCard({ agent }: { agent: Agent }) {
  const isActive =
    agent.status === "active" || agent.status === "running" || agent.status === "idle";

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
      <div className="relative">
        <div
          className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold",
            isActive
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {agent.name.charAt(0).toUpperCase()}
        </div>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background",
            getStatusColor(agent.status),
          )}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{agent.name}</span>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {getAgentTypeLabel(agent)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {isActive
            ? `Level ${agent.role === "ceo" ? 0 : agent.role === "cto" ? 1 : 2} — executing tasks`
            : `Status: ${agent.status}`}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {isActive ? (
          <Play className="h-3.5 w-3.5 text-emerald-500" />
        ) : agent.status === "paused" ? (
          <Pause className="h-3.5 w-3.5 text-amber-500" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
        )}
      </div>
    </div>
  );
}

function SpawnRulesReference() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Spawn Rules</CardTitle>
        <CardDescription>
          Who can spawn what — hierarchy-enforced governance
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {[
            {
              role: "CEO",
              level: 0,
              can: ["Delegate to CTO", "Spawn Exploratory for research"],
              color: "border-violet-500/20",
            },
            {
              role: "CTO",
              level: 1,
              can: ["Delegate to PM/Dev", "Spawn Generic agents", "Spawn Specialized agents"],
              color: "border-blue-500/20",
            },
            {
              role: "Developer",
              level: 2,
              can: [
                "Spawn Generic (coding tasks)",
                "Spawn Specialized (browser, code exec)",
                "Spawn Exploratory (fallback reasoning)",
              ],
              color: "border-emerald-500/20",
            },
          ].map((rule) => (
            <div
              key={rule.role}
              className={cn(
                "rounded-lg border p-3",
                rule.color,
              )}
            >
              <div className="flex items-center justify-between mb-1.5">
                <h4 className="text-sm font-semibold">{rule.role}</h4>
                <Badge variant="outline" className="text-[10px]">
                  Level {rule.level}
                </Badge>
              </div>
              <ul className="text-xs text-muted-foreground space-y-0.5">
                {rule.can.map((c, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <Zap className="h-3 w-3 text-primary shrink-0" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function Orchestration() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Orchestration" }]);
  }, [setBreadcrumbs]);

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeAgents = useMemo(
    () =>
      (agents ?? []).filter(
        (a) => a.status !== "terminated" && a.status !== "paused",
      ),
    [agents],
  );

  const taskStats = useMemo(() => {
    const all = issues ?? [];
    return {
      total: all.length,
      inProgress: all.filter(
        (i) => i.status === "in_progress" || i.status === "in_review",
      ).length,
      blocked: all.filter((i) => i.status === "blocked").length,
      completed: all.filter((i) => i.status === "done").length,
    };
  }, [issues]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={Workflow}
        message="Select a startup to view its orchestration engine."
      />
    );
  }

  if (agentsLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 p-2.5">
            <Workflow className="h-6 w-6 text-emerald-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Orchestration Engine</h1>
            <p className="text-sm text-muted-foreground">
              Recursive task decomposition, agent spawning &amp; governed
              execution
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground font-medium">
              Active Employees
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {activeAgents.length}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Layers className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Tasks In Progress
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {taskStats.inProgress}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Blocked
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {taskStats.blocked}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Completed
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {taskStats.completed}
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {/* Flow diagram */}
        <div className="md:col-span-1">
          <OrchestrationFlowcard />
        </div>

        {/* Active agents */}
        <Card className="md:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Employee Agents</CardTitle>
            <CardDescription>
              Persistent agents executing the startup&apos;s mission
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {activeAgents.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No active agents in the orchestration engine
              </div>
            ) : (
              <div>
                {activeAgents.map((agent) => (
                  <AgentSpawnCard key={agent.id} agent={agent} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Spawn rules */}
        <div className="md:col-span-1">
          <SpawnRulesReference />
        </div>
      </div>

      {/* Agent Types */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Agent Types
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              type: "Employee",
              icon: Users,
              color: "text-violet-500",
              bgColor: "bg-violet-500/10",
              borderColor: "border-violet-500/20",
              desc: "Persistent with Hippocampus. Lives for startup lifetime. Attends meetings, runs consolidation.",
              lifecycle: "Permanent",
            },
            {
              type: "Generic",
              icon: Zap,
              color: "text-blue-500",
              bgColor: "bg-blue-500/10",
              borderColor: "border-blue-500/20",
              desc: "Ephemeral. LLM + tools + delegated memory context. Spawned for specific tasks.",
              lifecycle: "Task-scoped",
            },
            {
              type: "Specialized",
              icon: Timer,
              color: "text-emerald-500",
              bgColor: "bg-emerald-500/10",
              borderColor: "border-emerald-500/20",
              desc: "Ephemeral. Fixed capability: browser_use, code_execution, design, research.",
              lifecycle: "Task-scoped",
            },
            {
              type: "Exploratory",
              icon: Sparkles,
              color: "text-rose-500",
              bgColor: "bg-rose-500/10",
              borderColor: "border-rose-500/20",
              desc: "Ephemeral. First-principles reasoning when others fail. Research & fallback.",
              lifecycle: "Task-scoped",
            },
          ].map((at) => {
            const Icon = at.icon;
            return (
              <div
                key={at.type}
                className={cn(
                  "rounded-xl border p-4 transition-all duration-200 hover:shadow-md",
                  at.borderColor,
                )}
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <div className={cn("rounded-lg p-2", at.bgColor)}>
                    <Icon className={cn("h-4 w-4", at.color)} />
                  </div>
                  <h3 className="text-sm font-semibold">{at.type} Agent</h3>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed mb-2">
                  {at.desc}
                </p>
                <Badge variant="outline" className="text-[10px]">
                  {at.lifecycle}
                </Badge>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
