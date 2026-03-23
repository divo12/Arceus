import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  Database,
  Zap,
  Shield,
  Trash2,
  ArrowUpCircle,
  Search,
  Plus,
  RefreshCw,
  PlayCircle,
} from "lucide-react";
import { memoryApi, type MemoryListItem, type RecallItem } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../lib/utils";

const TIER_META: Record<string, { label: string; icon: typeof Brain; color: string }> = {
  static: { label: "Static", icon: Shield, color: "text-blue-500" },
  dynamic: { label: "Dynamic", icon: Zap, color: "text-amber-500" },
  procedural: { label: "Procedural", icon: Database, color: "text-purple-500" },
  working: { label: "Working", icon: RefreshCw, color: "text-green-500" },
  priming: { label: "Priming", icon: Brain, color: "text-rose-500" },
};

function TierBadge({ tier }: { tier: string | null }) {
  const meta = TIER_META[tier ?? ""] ?? { label: tier ?? "unknown", icon: Database, color: "text-muted-foreground" };
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
      <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

function ScoreBar({ value }: { value: number | null }) {
  if (value == null) return null;
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">{pct}% match</span>
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Hippocampus service unavailable. Start the sidecar with{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">uvicorn main:app --port 8100</code>
      </div>
    );
  }

  const cards = [
    { label: "Static Memories", value: summary.total_static, icon: Shield, color: "text-blue-500" },
    { label: "Dynamic Memories", value: summary.total_dynamic, icon: Zap, color: "text-amber-500" },
    { label: "Active Habits", value: summary.active_habits.length, icon: Database, color: "text-purple-500" },
    { label: "Graph Nodes", value: summary.graph_node_count, icon: Brain, color: "text-rose-500" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div key={c.label} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <Icon className={cn("h-4 w-4", c.color)} />
              <span className="text-xs text-muted-foreground">{c.label}</span>
            </div>
            <span className="text-2xl font-semibold tabular-nums">{c.value}</span>
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
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Brain className="h-4 w-4 text-rose-500" />
          Priming Prompt
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Generate the current priming prompt on demand. This can take a moment because it uses the memory runtime.
        </p>
        <Button size="sm" variant="outline" onClick={() => setEnabled(true)}>
          <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
          Load Priming Prompt
        </Button>
      </div>
    );
  }

  if (isFetching && !data?.prompt) {
    return <Skeleton className="h-36 rounded-lg" />;
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Brain className="h-4 w-4 text-rose-500" />
          Priming Prompt
        </h3>
        <Button size="sm" variant="ghost" onClick={() => setEnabled(false)}>
          Hide
        </Button>
      </div>
      {data?.prompt ? (
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{data.prompt}</p>
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
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Database className="h-4 w-4 text-purple-500" />
          Active Habits
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Load habit suggestions on demand. This avoids blocking the memory tab on an extra runtime pass.
        </p>
        <Button size="sm" variant="outline" onClick={() => setEnabled(true)}>
          <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
          Load Habits
        </Button>
      </div>
    );
  }

  if (isFetching && !data) {
    return <Skeleton className="h-36 rounded-lg" />;
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Database className="h-4 w-4 text-purple-500" />
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
          {data.habits.map((h, i) => (
            <div key={i} className="flex items-start gap-3 text-sm border-b border-border pb-2 last:border-0 last:pb-0">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">When: {h.trigger}</p>
                <p className="text-muted-foreground truncate">Do: {h.action}</p>
              </div>
              <ConfidenceBar value={h.confidence} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryList({ agentId }: { agentId: string }) {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agents.memory.list(agentId, filter),
    queryFn: () => memoryApi.list(agentId, filter, undefined, 50),
    retry: 1,
    staleTime: 10_000,
  });

  const gcMutation = useMutation({
    mutationFn: () => memoryApi.gc(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", "memory"] });
    },
  });

  const filters = [
    { label: "All", value: undefined },
    { label: "Static", value: "static" },
    { label: "Dynamic", value: "dynamic" },
  ];

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium">Memories</h3>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {filters.map((f) => (
              <button
                key={f.label}
                className={cn(
                  "px-2 py-1 rounded text-xs font-medium transition-colors",
                  filter === f.value
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
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
      </div>

      {isLoading ? (
        <div className="p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : !data?.items?.length ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No memories stored yet. Memories are created when agents process conversations and tasks.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {data.items.map((m) => (
            <MemoryRow key={m.id} memory={m} />
          ))}
          {data.total > data.items.length && (
            <div className="px-4 py-2 text-xs text-muted-foreground">
              Showing {data.items.length} of {data.total} memories
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MemoryRow({ memory }: { memory: MemoryListItem }) {
  return (
    <div className="px-4 py-3 hover:bg-accent/30 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-snug line-clamp-2">{memory.content}</p>
          <div className="flex items-center gap-3 mt-1.5">
            <TierBadge tier={memory.memory_type} />
            {memory.container !== "default" && (
              <span className="text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">
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
        <ConfidenceBar value={memory.confidence} />
      </div>
    </div>
  );
}

function RecallTest({ agentId }: { agentId: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecallItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRecall() {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await memoryApi.recall(agentId, query);
      setResults(res.items);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
        <Search className="h-4 w-4" />
        Test Recall
      </h3>
      <div className="flex gap-2 mb-3">
        <Input
          placeholder="Query agent memory..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleRecall()}
          className="text-sm"
        />
        <Button size="sm" onClick={handleRecall} disabled={loading || !query.trim()}>
          {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : "Recall"}
        </Button>
      </div>
      {results !== null && (
        <div className="space-y-2">
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching memories found.</p>
          ) : (
            results.map((r, i) => (
              <div key={r.id || i} className="rounded border border-border p-2.5 text-sm">
                <div className="flex items-center gap-2 mb-1">
                  <TierBadge tier={r.memory_type} />
                  <Badge variant="outline" className="text-[10px]">
                    {r.kind}
                  </Badge>
                  <ScoreBar value={r.relevance_score} />
                </div>
                <p className="text-muted-foreground">{r.content}</p>
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
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
        <Plus className="h-4 w-4" />
        Add Memory
      </h3>
      <Textarea
        placeholder="Enter a fact or piece of knowledge..."
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        className="text-sm mb-2"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {(["dynamic", "static"] as const).map((t) => (
            <button
              key={t}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium transition-colors",
                memoryType === t
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={() => setMemoryType(t)}
            >
              {t === "static" ? "Static (permanent)" : "Dynamic (decays)"}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !content.trim()}
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function AgentMemoryTab({ agentId }: { agentId: string }) {
  return (
    <div className="space-y-4 max-w-4xl">
      <SummaryCards agentId={agentId} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PrimingSection agentId={agentId} />
        <HabitsSection agentId={agentId} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RecallTest agentId={agentId} />
        <AddMemory agentId={agentId} />
      </div>

      <MemoryList agentId={agentId} />
    </div>
  );
}
