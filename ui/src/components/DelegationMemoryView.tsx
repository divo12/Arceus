import { AlertTriangle, ArrowRight, Brain, CheckCircle2, Clock3, Sparkles } from "lucide-react";
import type { MemoryListItem } from "../api/memory";
import { cn, formatDateTime } from "../lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { Identity } from "@/components/Identity";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export interface DelegationLearning {
  text: string;
}

export interface DelegationMemoryViewProps {
  fromAgentName: string;
  toAgentName: string;
  taskTitle: string;
  delegatedAt?: string;
  copiedCount: number;
  failedCount?: number;
  memories: MemoryListItem[];
  learnings?: DelegationLearning[];
  quality?: number;
  internalizedAs?: "static" | "dynamic" | null;
  loading?: boolean;
  className?: string;
}

function ConfidenceBar({ value }: { value: number }) {
  const width = Math.max(0, Math.min(100, Math.round(value * 100)));
  const tierColor = value >= 0.9
    ? "bg-[var(--memory-static)]"
    : value >= 0.6
      ? "bg-[var(--memory-dynamic)]"
      : "bg-muted-foreground";

  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", tierColor)} style={{ width: `${width}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{width}%</span>
    </div>
  );
}

function TierBadge({ tier }: { tier: string | null }) {
  const className = tier === "static"
    ? "border-[color:var(--memory-static)]/30 text-[color:var(--memory-static)]"
    : tier === "dynamic"
      ? "border-[color:var(--memory-dynamic)]/30 text-[color:var(--memory-dynamic)]"
      : "border-border text-muted-foreground";

  return (
    <Badge variant="outline" className={cn("capitalize", className)}>
      {tier?.replaceAll("_", " ") ?? "memory"}
    </Badge>
  );
}

function ViewSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden">
      <CardHeader className="border-b border-border">
        <Skeleton className="h-5 w-48 rounded" />
        <Skeleton className="h-4 w-72 rounded" />
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        <Skeleton className="h-20 rounded-lg" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-16 rounded-lg" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function DelegationMemoryView({
  fromAgentName,
  toAgentName,
  taskTitle,
  delegatedAt,
  copiedCount,
  failedCount = 0,
  memories,
  learnings = [],
  quality,
  internalizedAs = null,
  loading = false,
  className,
}: DelegationMemoryViewProps) {
  if (loading) {
    return <ViewSkeleton />;
  }

  if (!memories.length && !learnings.length) {
    return (
      <Card className={cn("gap-0 overflow-hidden", className)}>
        <CardHeader className="border-b border-border">
          <CardTitle className="text-base">Delegated Memory</CardTitle>
          <CardDescription>No delegation history is available for this task yet.</CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <EmptyState
            icon={ArrowRight}
            message="No delegation history for this task."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("gap-0 overflow-hidden", className)}>
      <CardHeader className="border-b border-border">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <CardTitle className="text-base">Delegated Memory</CardTitle>
            <CardDescription>
              Shared context passed between agents for a specific task.
            </CardDescription>
          </div>
          {delegatedAt ? (
            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              {formatDateTime(delegatedAt)}
            </div>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Identity name={fromAgentName} size="sm" />
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <Identity name={toAgentName} size="sm" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">{taskTitle}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{copiedCount} copied</Badge>
            {failedCount > 0 ? (
              <Badge variant="outline" className="border-amber-500/30 text-amber-600 dark:text-amber-400">
                {failedCount} failed
              </Badge>
            ) : (
              <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                complete
              </Badge>
            )}
          </div>
          {failedCount > 0 ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Some memories could not be copied to the delegate. The task still has partial context available.
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Shared Context
            </h4>
            <span className="text-xs text-muted-foreground">{copiedCount} memories</span>
          </div>
          <div className="space-y-2">
            {memories.map((memory) => (
              <div key={memory.id} className="rounded-lg border border-border px-3 py-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <TierBadge tier={memory.memory_type} />
                  <span>{Math.round(memory.confidence * 100)}%</span>
                  {memory.container ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      {memory.container}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-foreground">{memory.content}</p>
              </div>
            ))}
          </div>
        </div>

        {(typeof quality === "number" || learnings.length > 0) ? (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Post-Delegation Learnings
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  Knowledge captured after the delegated work finished.
                </p>
              </div>
              {internalizedAs ? (
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
                  internalized as {internalizedAs}
                </Badge>
              ) : null}
            </div>

            {typeof quality === "number" ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-foreground">Quality</span>
                <ConfidenceBar value={quality} />
                {quality >= 0.6 ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    eligible for internalization
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Brain className="h-3.5 w-3.5" />
                    below internalization threshold
                  </span>
                )}
              </div>
            ) : null}

            {learnings.length ? (
              <div className="mt-4 space-y-2">
                {learnings.map((learning, index) => (
                  <div key={`${learning.text}-${index}`} className="flex items-start gap-2 rounded-md border border-emerald-500/15 bg-background/70 px-3 py-2">
                    <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
                    <p className="text-sm text-foreground">{learning.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                No post-delegation learnings were captured for this task.
              </p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
