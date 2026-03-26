import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock3, GitBranch, History } from "lucide-react";
import { type GraphNode, type MemoryListItem, memoryApi } from "../api/memory";
import { cn, formatDateTime } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface MemoryVersionTimelineProps {
  agentId: string;
  memory: MemoryListItem;
  open: boolean;
  className?: string;
}

function toSnapshot(node: GraphNode, fallbackType: string | null) {
  return {
    id: node.id,
    label: node.content ?? node.name ?? node.id,
    createdAt: node.created_at,
    entityType: node.entity_type || fallbackType || "memory",
    confidence: node.confidence ?? null,
  };
}

export function MemoryVersionTimeline({
  agentId,
  memory,
  open,
  className,
}: MemoryVersionTimelineProps) {
  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["agents", "memory", "history", agentId, memory.id],
    queryFn: () => memoryApi.versionHistory(agentId, memory.id),
    enabled: open,
    retry: 1,
    staleTime: 30_000,
  });

  const snapshots = useMemo(() => {
    const current = {
      id: memory.id,
      label: memory.content,
      createdAt: memory.created_at,
      entityType: memory.memory_type || "memory",
      confidence: memory.confidence,
    };
    const history = (data ?? []).map((node) => toSnapshot(node, memory.memory_type));
    if (!history.length) return [current];
    if (history[0]?.id === current.id) {
      history[0] = {
        ...history[0],
        label: current.label,
        createdAt: current.createdAt ?? history[0].createdAt,
        confidence: current.confidence,
      };
      return history;
    }
    return [current, ...history];
  }, [data, memory.confidence, memory.content, memory.created_at, memory.id, memory.memory_type]);

  return (
    <div className={cn("rounded-md border border-border bg-muted/20 p-3", className)}>
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-[var(--memory-priming)]" />
        <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Version History
        </h4>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-16 rounded-md" />
          ))}
        </div>
      ) : (
        <div className="relative space-y-3 pl-5">
          <div className="absolute bottom-1 left-[5px] top-1 border-l-2 border-border" />
          {snapshots.map((snapshot, index) => {
            const isCurrent = index === 0;
            return (
              <div key={`${snapshot.id}-${index}`} className="relative">
                <span
                  className={cn(
                    "absolute -left-[17px] top-2 h-3 w-3 rounded-full border-2 border-background",
                    isCurrent ? "bg-primary" : "bg-muted-foreground",
                  )}
                />
                <div className="rounded-md border border-border bg-background/70 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={isCurrent ? "default" : "outline"}>
                      {isCurrent ? "Current" : `v${snapshots.length - index}`}
                    </Badge>
                    <Badge variant="outline">{snapshot.entityType}</Badge>
                    {snapshot.createdAt ? (
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="h-3 w-3" />
                        {formatDateTime(snapshot.createdAt)}
                      </span>
                    ) : null}
                    {typeof snapshot.confidence === "number" ? (
                      <span>{Math.round(snapshot.confidence * 100)}% confidence</span>
                    ) : null}
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 text-primary">
                        <GitBranch className="h-3 w-3" />
                        active
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm leading-snug text-foreground">
                    {snapshot.label}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error ? (
        <div className="mt-3 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          Detailed version chains are not available from the memory runtime yet.
        </div>
      ) : null}
    </div>
  );
}
