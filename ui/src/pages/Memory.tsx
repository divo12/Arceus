import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Brain,
  Database,
  Zap,
  BookOpen,
  Repeat,
  Eye,
  TrendingUp,
  Layers,
  Activity,
  Sparkles,
  ArrowUpRight,
  ChevronRight,
} from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";

/** Simulated memory tier data for showcase. */
function generateMemoryTiers(agents: Agent[]) {
  const tiers = [
    {
      id: "working",
      name: "Working Memory",
      icon: Zap,
      color: "text-amber-500",
      bgColor: "bg-amber-500/10",
      borderColor: "border-amber-500/20",
      description: "Active runtime context — ephemeral, per-task scratch space",
      count: agents.length * 3,
      capacity: "Context window",
      retention: "Per-task lifecycle",
    },
    {
      id: "static",
      name: "Static Memory",
      icon: Database,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
      borderColor: "border-blue-500/20",
      description: "Core knowledge — immutable facts, role definitions, company thesis",
      count: 12 + agents.length * 2,
      capacity: "Unlimited",
      retention: "Permanent",
    },
    {
      id: "dynamic",
      name: "Dynamic Memory",
      icon: TrendingUp,
      color: "text-emerald-500",
      bgColor: "bg-emerald-500/10",
      borderColor: "border-emerald-500/20",
      description: "Learned knowledge — evolving insights from task execution",
      count: agents.length * 8,
      capacity: "Vector-indexed",
      retention: "Confidence-decayed",
    },
    {
      id: "procedural",
      name: "Procedural Memory",
      icon: Repeat,
      color: "text-violet-500",
      bgColor: "bg-violet-500/10",
      borderColor: "border-violet-500/20",
      description: "Habits & skills — auto-triggered behavioral patterns",
      count: agents.length * 2,
      capacity: "Pattern-matched",
      retention: "Strength-based",
    },
    {
      id: "priming",
      name: "Priming Memory",
      icon: Eye,
      color: "text-rose-500",
      bgColor: "bg-rose-500/10",
      borderColor: "border-rose-500/20",
      description: "Response biases — when I see X, I tend to do Y",
      count: agents.length,
      capacity: "Active triggers",
      retention: "Usage-weighted",
    },
  ];
  return tiers;
}

function MemoryTierCard({
  tier,
}: {
  tier: ReturnType<typeof generateMemoryTiers>[number];
}) {
  const Icon = tier.icon;
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border p-5 transition-all duration-200 hover:shadow-md",
        tier.borderColor,
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-transparent to-transparent group-hover:from-primary/[0.02] group-hover:to-primary/[0.05] transition-all duration-300" />
      <div className="relative">
        <div className="flex items-start justify-between mb-3">
          <div className={cn("rounded-lg p-2.5", tier.bgColor)}>
            <Icon className={cn("h-5 w-5", tier.color)} />
          </div>
          <Badge variant="outline" className="text-[10px]">
            {tier.count} units
          </Badge>
        </div>
        <h3 className="font-semibold text-sm mb-1">{tier.name}</h3>
        <p className="text-xs text-muted-foreground leading-relaxed mb-3">
          {tier.description}
        </p>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
          <span className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            {tier.capacity}
          </span>
          <span className="flex items-center gap-1">
            <Activity className="h-3 w-3" />
            {tier.retention}
          </span>
        </div>
      </div>
    </div>
  );
}

function AgentMemoryRow({ agent }: { agent: Agent }) {
  const isActive =
    agent.status === "active" || agent.status === "running" || agent.status === "idle";
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
      <div className="relative">
        <div
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold",
            isActive
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {agent.name.charAt(0).toUpperCase()}
        </div>
        {isActive && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{agent.name}</span>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {agent.role ?? "employee"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {isActive ? "Memory active — consolidation running" : "Memory suspended"}
        </p>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right">
          <p className="text-xs font-medium tabular-nums">
            {Math.floor(Math.random() * 40 + 5)} units
          </p>
          <p className="text-[10px] text-muted-foreground">total memories</p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
      </div>
    </div>
  );
}

function MemoryFlowDiagram() {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Memory Lifecycle</CardTitle>
        <CardDescription>
          How memories flow from task execution through consolidation
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {[
            {
              step: "1",
              label: "Task Execution",
              desc: "Agent executes task, producing a trajectory of actions and results",
              color: "bg-amber-500",
            },
            {
              step: "2",
              label: "Trajectory Distillation",
              desc: "ReasoningBank extracts valuable insights from the execution trace",
              color: "bg-blue-500",
            },
            {
              step: "3",
              label: "Memory Storage",
              desc: "Distilled memories are classified and stored in appropriate tiers",
              color: "bg-emerald-500",
            },
            {
              step: "4",
              label: "Consolidation Cycle",
              desc: "Patterns emerge, merge, and prune — habits form from repetition",
              color: "bg-violet-500",
            },
            {
              step: "5",
              label: "Context Injection",
              desc: "Relevant memories are retrieved and delegated to spawned agents",
              color: "bg-rose-500",
            },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="flex flex-col items-center gap-1">
                <div
                  className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0",
                    item.color,
                  )}
                >
                  {item.step}
                </div>
                {i < 4 && (
                  <div className="w-px h-4 bg-border" />
                )}
              </div>
              <div className="pt-0.5">
                <p className="text-sm font-medium">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function Memory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Hippocampus" }]);
  }, [setBreadcrumbs]);

  const { data: agents, isLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const memoryTiers = useMemo(
    () => generateMemoryTiers(agents ?? []),
    [agents],
  );

  const activeAgents = useMemo(
    () =>
      (agents ?? []).filter(
        (a) => a.status !== "terminated" && a.status !== "paused",
      ),
    [agents],
  );

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={Brain}
        message="Select a startup to view its memory system."
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 p-2.5">
            <Brain className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Hippocampus</h1>
            <p className="text-sm text-muted-foreground">
              5-tier neuroscience-inspired memory system for persistent agent
              intelligence
            </p>
          </div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground font-medium">
              Total Memories
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {memoryTiers.reduce((s, t) => s + t.count, 0)}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Brain className="h-4 w-4 text-violet-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Active Agents
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {activeAgents.length}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Repeat className="h-4 w-4 text-emerald-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Habits Formed
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {memoryTiers.find((t) => t.id === "procedural")?.count ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-4 w-4 text-amber-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Patterns Detected
            </span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {Math.max(1, Math.floor(activeAgents.length * 1.5))}
          </p>
        </div>
      </div>

      {/* Memory Tiers */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Memory Tiers
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {memoryTiers.map((tier) => (
            <MemoryTierCard key={tier.id} tier={tier} />
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Agent Memory Panel */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Agent Memory Status</CardTitle>
            <CardDescription>
              Per-employee Hippocampus instances and their health
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {activeAgents.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No active agents with Hippocampus instances
              </div>
            ) : (
              <div>
                {activeAgents.map((agent) => (
                  <AgentMemoryRow key={agent.id} agent={agent} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Memory Flow */}
        <MemoryFlowDiagram />
      </div>
    </div>
  );
}
