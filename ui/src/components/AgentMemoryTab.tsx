import { Suspense, lazy, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  Brain,
  ChevronDown,
  ChevronUp,
  Database,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { memoryApi, type MemoryListItem, type RecallItem } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "./PageTabBar";
import { ScopeFilterBar, type MemoryScopeOption, type MemoryTierOption, type MemoryVisibilityOption } from "./ScopeFilterBar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type MemoryTab = "overview" | "explorer" | "graph" | "profile" | "activity";

const MemoryGraphExplorer = lazy(async () => ({
  default: (await import("./MemoryGraphExplorer")).MemoryGraphExplorer,
}));

const MemoryVersionTimeline = lazy(async () => ({
  default: (await import("./MemoryVersionTimeline")).MemoryVersionTimeline,
}));

const PromotionFeed = lazy(async () => ({
  default: (await import("./PromotionFeed")).PromotionFeed,
}));

const TIER_META: Record<string, { label: string; icon: typeof Brain; color: string }> = {
  static: { label: "Static", icon: Shield, color: "text-[var(--memory-static)]" },
  dynamic: { label: "Dynamic", icon: Zap, color: "text-[var(--memory-dynamic)]" },
  procedural: { label: "Procedural", icon: Database, color: "text-[var(--memory-procedural)]" },
  working: { label: "Working", icon: RefreshCw, color: "text-[var(--memory-working)]" },
  priming: { label: "Priming", icon: Brain, color: "text-[var(--memory-priming)]" },
};

const memoryTabItems = [
  { value: "overview", label: "Overview" },
  { value: "explorer", label: "Explorer" },
  { value: "graph", label: "Graph" },
  { value: "profile", label: "Profile" },
  { value: "activity", label: "Activity" },
] as const;

function TierBadge({ tier }: { tier: string | null }) {
  const meta = TIER_META[tier ?? ""] ?? {
    label: tier ?? "unknown",
    icon: Database,
    color: "text-muted-foreground",
  };
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", meta.color)}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-red-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

function ScoreBar({ value }: { value: number | null }) {
  if (value == null) return null;
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-red-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">{pct}% match</span>
    </div>
  );
}

function EmptyPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center text-muted-foreground">
      <Sparkles className="mb-3 h-8 w-8" />
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="mt-2 max-w-md text-sm">{description}</p>
    </div>
  );
}

function PanelSkeleton({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4 shadow-sm", className)}>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-16 rounded-md" />
        ))}
      </div>
    </div>
  );
}

function QuickActionsRow({
  onRecall,
  onRemember,
  onRunGC,
  onRunPromotions,
  gcPending,
  promotionsPending,
}: {
  onRecall: () => void;
  onRemember: () => void;
  onRunGC: () => void;
  onRunPromotions: () => void;
  gcPending: boolean;
  promotionsPending: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <ArrowUpCircle className="h-4 w-4 text-[var(--memory-dynamic)]" />
        <h3 className="text-sm font-medium">Quick Actions</h3>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onRecall}>
          <Search className="mr-1.5 h-3.5 w-3.5" />
          Recall
        </Button>
        <Button size="sm" variant="outline" onClick={onRemember}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Remember
        </Button>
        <Button size="sm" variant="outline" onClick={onRunGC} disabled={gcPending}>
          {gcPending ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
          Run GC
        </Button>
        <Button size="sm" variant="outline" onClick={onRunPromotions} disabled={promotionsPending}>
          {promotionsPending ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />}
          Run Promotions
        </Button>
      </div>
    </div>
  );
}

function SummaryCards({ agentId }: { agentId: string }) {
  const { data: summary, isLoading } = useQuery({
    queryKey: queryKeys.agents.memory.summary(agentId),
    queryFn: () => memoryApi.summary(agentId),
    retry: 1,
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Hippocampus service unavailable.
      </div>
    );
  }

  const cards = [
    { label: "Static Memories", value: summary.total_static, icon: Shield, color: "text-[var(--memory-static)]" },
    { label: "Dynamic Memories", value: summary.total_dynamic, icon: Zap, color: "text-[var(--memory-dynamic)]" },
    { label: "Active Habits", value: summary.active_habits.length, icon: Database, color: "text-[var(--memory-procedural)]" },
    { label: "Graph Nodes", value: summary.graph_node_count, icon: Brain, color: "text-[var(--memory-priming)]" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.label} className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2">
              <Icon className={cn("h-4 w-4", card.color)} />
              <span className="text-xs text-muted-foreground">{card.label}</span>
            </div>
            <span className="text-2xl font-semibold tabular-nums">{card.value}</span>
          </div>
        );
      })}
    </div>
  );
}

function PrimingSection({ agentId }: { agentId: string }) {
  const [enabled, setEnabled] = useState(false);
  const { data, isFetching } = useQuery({
    queryKey: queryKeys.agents.memory.priming(agentId),
    queryFn: () => memoryApi.priming(agentId),
    enabled,
    retry: 1,
    staleTime: 30_000,
  });

  if (!enabled) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Brain className="h-4 w-4 text-[var(--memory-priming)]" />
          Priming Prompt
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Generate the current priming prompt on demand. This can take a moment because it uses the memory runtime.
        </p>
        <Button size="sm" variant="outline" onClick={() => setEnabled(true)}>
          <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
          Load Priming Prompt
        </Button>
      </div>
    );
  }

  if (isFetching && !data?.prompt) {
    return <Skeleton className="h-36 rounded-lg" />;
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Brain className="h-4 w-4 text-[var(--memory-priming)]" />
          Priming Prompt
        </h3>
        <Button size="sm" variant="ghost" onClick={() => setEnabled(false)}>
          Hide
        </Button>
      </div>
      {data?.prompt ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{data.prompt}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No priming prompt is available right now.</p>
      )}
    </div>
  );
}

function HabitsSection({ agentId }: { agentId: string }) {
  const [enabled, setEnabled] = useState(false);
  const { data, isFetching } = useQuery({
    queryKey: queryKeys.agents.memory.habits(agentId),
    queryFn: () => memoryApi.habits(agentId),
    enabled,
    retry: 1,
    staleTime: 30_000,
  });

  if (!enabled) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Database className="h-4 w-4 text-[var(--memory-procedural)]" />
          Active Habits
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Load habit suggestions on demand. This avoids blocking the memory tab on an extra runtime pass.
        </p>
        <Button size="sm" variant="outline" onClick={() => setEnabled(true)}>
          <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
          Load Habits
        </Button>
      </div>
    );
  }

  if (isFetching && !data) {
    return <Skeleton className="h-36 rounded-lg" />;
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Database className="h-4 w-4 text-[var(--memory-procedural)]" />
          Active Habits
        </h3>
        <Button size="sm" variant="ghost" onClick={() => setEnabled(false)}>
          Hide
        </Button>
      </div>
      {!data?.habits?.length ? (
        <p className="text-sm text-muted-foreground">No active habits matched right now.</p>
      ) : (
        <div className="space-y-2">
          {data.habits.map((habit, index) => (
            <div key={index} className="flex items-start gap-3 border-b border-border pb-2 text-sm last:border-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">When: {habit.trigger}</p>
                <p className="truncate text-muted-foreground">Do: {habit.action}</p>
              </div>
              <ConfidenceBar value={habit.confidence} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryRow({
  memory,
  agentId,
  showVersionHistory = false,
}: {
  memory: MemoryListItem;
  agentId?: string;
  showVersionHistory?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="px-4 py-3 transition-colors hover:bg-accent/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm leading-snug", expanded ? "whitespace-pre-wrap" : "line-clamp-2")}>
            {memory.content}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <TierBadge tier={memory.memory_type} />
            {memory.visibility && (
              <Badge variant="outline" className="text-[10px]">
                {memory.visibility}
              </Badge>
            )}
            {memory.container !== "default" && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {memory.container}
              </span>
            )}
            {memory.created_at && (
              <span className="text-[10px] text-muted-foreground">
                {new Date(memory.created_at).toLocaleDateString()}
              </span>
            )}
            {memory.access_count > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {memory.access_count} recalls
              </span>
            )}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <ConfidenceBar value={memory.confidence} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={expanded ? "Collapse memory details" : "Expand memory details"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      {expanded ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <span className="font-medium text-foreground">Memory ID:</span> {memory.id}
              </div>
              <div>
                <span className="font-medium text-foreground">Confidence:</span> {Math.round(memory.confidence * 100)}%
              </div>
              <div>
                <span className="font-medium text-foreground">Container:</span> {memory.container}
              </div>
              <div>
                <span className="font-medium text-foreground">Relevance:</span> {Math.round(memory.relevance_score * 100)}%
              </div>
              <div>
                <span className="font-medium text-foreground">Created:</span> {memory.created_at ? new Date(memory.created_at).toLocaleString() : "Unknown"}
              </div>
              <div>
                <span className="font-medium text-foreground">Updated:</span> {memory.updated_at ? new Date(memory.updated_at).toLocaleString() : "Unknown"}
              </div>
            </div>
          </div>
          {showVersionHistory && agentId ? (
            <Suspense fallback={<PanelSkeleton rows={3} className="border-dashed bg-muted/20" />}>
              <MemoryVersionTimeline agentId={agentId} memory={memory} open={expanded} />
            </Suspense>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RecallTest({
  agentId,
  startupId,
  employeeId,
}: {
  agentId: string;
  startupId: string;
  employeeId: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecallItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [useScoped, setUseScoped] = useState(true);
  const [taskId, setTaskId] = useState("");

  async function handleRecall() {
    if (!query.trim()) return;
    setLoading(true);
    try {
      if (useScoped && startupId && employeeId) {
        const res = await memoryApi.scopedRecall(agentId, {
          query,
          startupId,
          employeeId,
          taskId: taskId.trim() || undefined,
        });
        setResults(res.items);
      } else {
        const res = await memoryApi.recall(agentId, query);
        setResults(res.items);
      }
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Search className="h-4 w-4" />
          Test Recall
        </h3>
        <button
          type="button"
          className="rounded-full focus:outline-none focus:ring-2 focus:ring-ring/40"
          onClick={() => setUseScoped((value) => !value)}
        >
          <Badge variant={useScoped ? "default" : "outline"}>
            {useScoped ? "Scoped" : "Default"}
          </Badge>
        </button>
      </div>
      <div className="mb-2 flex gap-2">
        <Input
          placeholder="Query agent memory..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && handleRecall()}
          className="text-sm"
        />
        <Button size="sm" onClick={handleRecall} disabled={loading || !query.trim()}>
          {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : "Recall"}
        </Button>
      </div>
      {useScoped ? (
        <Input
          value={taskId}
          onChange={(event) => setTaskId(event.target.value)}
          placeholder="Optional task id for scoped recall"
          className="mb-3 h-8 text-xs"
        />
      ) : null}
      {results !== null && (
        <div className="space-y-2">
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching memories found.</p>
          ) : (
            results.map((result, index) => (
              <div key={result.id || index} className="rounded border border-border p-2.5 text-sm">
                <div className="mb-1 flex items-center gap-2">
                  <TierBadge tier={result.memory_type} />
                  <Badge variant="outline" className="text-[10px]">
                    {result.kind}
                  </Badge>
                  <ScoreBar value={result.relevance_score} />
                </div>
                <p className="text-muted-foreground">{result.content}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AddMemory({ agentId }: { agentId: string }) {
  const [content, setContent] = useState("");
  const [memoryType, setMemoryType] = useState("dynamic");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => memoryApi.remember(agentId, content, "default", memoryType),
    onSuccess: () => {
      setContent("");
      queryClient.invalidateQueries({ queryKey: ["agents", "memory"] });
    },
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Plus className="h-4 w-4" />
        Add Memory
      </h3>
      <Textarea
        placeholder="Enter a fact or piece of knowledge..."
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={2}
        className="mb-2 text-sm"
      />
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(["dynamic", "static"] as const).map((tier) => (
            <button
              key={tier}
              type="button"
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                memoryType === tier
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => setMemoryType(tier)}
            >
              {tier === "static" ? "Static (permanent)" : "Dynamic (decays)"}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending || !content.trim()}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function OverviewTab({
  agentId,
  startupId,
  employeeId,
}: {
  agentId: string;
  startupId: string;
  employeeId: string;
}) {
  const queryClient = useQueryClient();
  const recallRef = useRef<HTMLDivElement | null>(null);
  const rememberRef = useRef<HTMLDivElement | null>(null);
  const [promotionMessage, setPromotionMessage] = useState<string | null>(null);

  const { data: summary } = useQuery({
    queryKey: queryKeys.agents.memory.summary(agentId),
    queryFn: () => memoryApi.summary(agentId),
    retry: 1,
    staleTime: 10_000,
  });
  const { data: recentMemories } = useQuery({
    queryKey: queryKeys.agents.memory.recentList(agentId),
    queryFn: () => memoryApi.list(agentId, undefined, undefined, 5),
    retry: 1,
    staleTime: 10_000,
  });
  const gcMutation = useMutation({
    mutationFn: () => memoryApi.gc(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", "memory"] });
    },
  });
  const promotionsMutation = useMutation({
    mutationFn: () => memoryApi.runPromotions(agentId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["agents", "memory"] });
      setPromotionMessage(
        result.promotions.length > 0
          ? `${result.promotions.length} promotion${result.promotions.length === 1 ? "" : "s"} completed`
          : "No promotions were triggered this run",
      );
    },
  });

  function scrollToRef(ref: { current: HTMLDivElement | null }) {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="space-y-4">
      <SummaryCards agentId={agentId} />

      <QuickActionsRow
        onRecall={() => scrollToRef(recallRef)}
        onRemember={() => scrollToRef(rememberRef)}
        onRunGC={() => gcMutation.mutate()}
        onRunPromotions={() => promotionsMutation.mutate()}
        gcPending={gcMutation.isPending}
        promotionsPending={promotionsMutation.isPending}
      />

      {promotionMessage ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
          {promotionMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PrimingSection agentId={agentId} />
        <HabitsSection agentId={agentId} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Brain className="h-4 w-4 text-[var(--memory-priming)]" />
            <h3 className="text-sm font-medium">Recent Activity</h3>
          </div>
          <div className="space-y-3">
            {summary?.recent_promotions?.slice(0, 5).map((promotion, index) => (
              <div key={`${promotion}-${index}`} className="border-b border-border pb-3 text-sm last:border-0 last:pb-0">
                <p className="font-medium text-foreground">Promotion</p>
                <p className="text-muted-foreground">{promotion}</p>
              </div>
            ))}
            {recentMemories?.items?.slice(0, 5).map((memory) => (
              <div key={memory.id} className="border-b border-border pb-3 text-sm last:border-0 last:pb-0">
                <div className="mb-1 flex items-center gap-2">
                  <TierBadge tier={memory.memory_type} />
                  <span className="text-xs text-muted-foreground">
                    {memory.created_at ? new Date(memory.created_at).toLocaleDateString() : "Recent"}
                  </span>
                </div>
                <p className="line-clamp-2 text-muted-foreground">{memory.content}</p>
              </div>
            ))}
            {!summary?.recent_promotions?.length && !recentMemories?.items?.length ? (
              <p className="text-sm text-muted-foreground">No recent memory activity yet.</p>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div ref={recallRef}>
            <RecallTest agentId={agentId} startupId={startupId} employeeId={employeeId} />
          </div>
          <div ref={rememberRef}>
            <AddMemory agentId={agentId} />
          </div>
        </div>
      </div>

    </div>
  );
}

function ExplorerTab({
  agentId,
  startupId,
  employeeId,
}: {
  agentId: string;
  startupId: string;
  employeeId: string;
}) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<MemoryScopeOption>("all");
  const [tiers, setTiers] = useState<MemoryTierOption[]>([]);
  const [visibilities, setVisibilities] = useState<MemoryVisibilityOption[]>([]);
  const [containerInput, setContainerInput] = useState("");

  const containerSuggestions = useMemo(() => {
    if (!startupId) return [];
    const suggestions = [
      `startup:${startupId}`,
      `startup:${startupId}:emp:${employeeId}`,
    ];
    if (containerInput.trim() && !containerInput.includes(":")) {
      suggestions.push(`startup:${startupId}:task:${containerInput.trim()}`);
    }
    return suggestions;
  }, [containerInput, employeeId, startupId]);

  const container = useMemo(() => {
    if (!startupId) return undefined;
    if (containerInput.trim().startsWith("startup:")) return containerInput.trim();
    if (scope === "startup") return `startup:${startupId}`;
    if (scope === "employee") return `startup:${startupId}:emp:${employeeId}`;
    if (scope === "task" && containerInput.trim()) return `startup:${startupId}:task:${containerInput.trim()}`;
    if (scope === "all" && containerInput.trim()) return containerInput.trim();
    return undefined;
  }, [containerInput, employeeId, scope, startupId]);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agents.memory.list(
      agentId,
      tiers.length === 1 ? tiers[0] : undefined,
      container,
    ),
    queryFn: () =>
      container
        ? memoryApi.memoryExplorer(agentId, container, tiers.length === 1 ? tiers[0] : undefined, 50)
        : memoryApi.list(agentId, tiers.length === 1 ? tiers[0] : undefined, container, 50),
    retry: 1,
    staleTime: 10_000,
  });

  const gcMutation = useMutation({
    mutationFn: () => memoryApi.gc(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", "memory"] });
    },
  });

  const filteredItems = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter((item) => {
      const tierOk = tiers.length === 0 || (item.memory_type != null && tiers.includes(item.memory_type as MemoryTierOption));
      const visibilityOk = visibilities.length === 0 || (item.visibility != null && visibilities.includes(item.visibility as MemoryVisibilityOption));
      return tierOk && visibilityOk;
    });
  }, [data?.items, tiers, visibilities]);

  function toggleTier(value: MemoryTierOption) {
    setTiers((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  }

  function toggleVisibility(value: MemoryVisibilityOption) {
    setVisibilities((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  }

  return (
    <div className="space-y-4">
      <ScopeFilterBar
        scope={scope}
        onScopeChange={setScope}
        tiers={tiers}
        onTierToggle={toggleTier}
        visibilities={visibilities}
        onVisibilityToggle={toggleVisibility}
        containerValue={containerInput}
        onContainerValueChange={setContainerInput}
        containerSuggestions={containerSuggestions}
      />

      <div className="rounded-lg border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-medium">Memory Explorer</h3>
            <p className="text-xs text-muted-foreground">
              Filter by scope, tier, and visibility. You can enter a task id or a full container string.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => gcMutation.mutate()}
            disabled={gcMutation.isPending}
            title="Run garbage collection"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-14" />
            ))}
          </div>
        ) : !filteredItems.length ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No memories match the current explorer filters.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredItems.map((memory) => (
              <MemoryRow
                key={memory.id}
                memory={memory}
                agentId={agentId}
                showVersionHistory
              />
            ))}
            {data && data.total > filteredItems.length ? (
              <div className="px-4 py-2 text-xs text-muted-foreground">
                Showing {filteredItems.length} of {data.total} memories
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentMemoryTab({
  agentId,
  startupId,
  employeeId,
}: {
  agentId: string;
  startupId?: string;
  employeeId?: string;
}) {
  const [activeTab, setActiveTab] = useState<MemoryTab>("overview");
  const effectiveStartupId = startupId ?? "";
  const effectiveEmployeeId = employeeId ?? agentId;
  const handleTabChange = (value: string) => setActiveTab(value as MemoryTab);
  const defaultContainer = useMemo(() => {
    if (!effectiveStartupId) return undefined;
    return `startup:${effectiveStartupId}:emp:${effectiveEmployeeId}`;
  }, [effectiveEmployeeId, effectiveStartupId]);
  const { data: summary } = useQuery({
    queryKey: queryKeys.agents.memory.summary(agentId),
    queryFn: () => memoryApi.summary(agentId),
    retry: 1,
    staleTime: 10_000,
  });

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
      <PageTabBar
        items={[...memoryTabItems]}
        value={activeTab}
        onValueChange={handleTabChange}
        align="start"
      />

      <TabsContent value="overview" className="space-y-4">
        <OverviewTab
          agentId={agentId}
          startupId={effectiveStartupId}
          employeeId={effectiveEmployeeId}
        />
      </TabsContent>

      <TabsContent value="explorer" className="space-y-4">
        <ExplorerTab
          agentId={agentId}
          startupId={effectiveStartupId}
          employeeId={effectiveEmployeeId}
        />
      </TabsContent>

      <TabsContent value="graph">
        <Suspense fallback={<PanelSkeleton rows={1} className="min-h-[460px]" />}>
          <MemoryGraphExplorer
            agentId={agentId}
            container={defaultContainer}
          />
        </Suspense>
      </TabsContent>

      <TabsContent value="profile">
        <EmptyPlaceholder
          title="Profile view is coming next"
          description="Part 3 will synthesize static knowledge, current context, habits, and priming into an agent memory profile."
        />
      </TabsContent>

      <TabsContent value="activity" className="space-y-4">
        <Suspense fallback={<PanelSkeleton rows={4} />}>
          <PromotionFeed
            agentId={agentId}
            fallbackPromotions={summary?.recent_promotions ?? []}
          />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
