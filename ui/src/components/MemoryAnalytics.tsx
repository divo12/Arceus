import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  Brain,
  Database,
  Shield,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { getLast14Days } from "./ActivityCharts";
import { MetricCard } from "./MetricCard";
import { Skeleton } from "@/components/ui/skeleton";
import { memoryApi, type MemoryListItem, type MemorySummary, type PromotionEvent } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";

const TIER_COLORS: Record<string, string> = {
  working: "var(--memory-working)",
  dynamic: "var(--memory-dynamic)",
  static: "var(--memory-static)",
  procedural: "var(--memory-procedural)",
  priming: "var(--memory-priming)",
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "also",
  "been",
  "being",
  "below",
  "build",
  "from",
  "have",
  "into",
  "just",
  "memory",
  "more",
  "than",
  "that",
  "their",
  "them",
  "then",
  "they",
  "this",
  "those",
  "used",
  "using",
  "with",
  "your",
]);

type TierDatum = {
  key: string;
  label: string;
  count: number;
  color: string;
};

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function PropertyRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 px-4 text-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}

function deriveTierDistribution(summary: MemorySummary | undefined, items: MemoryListItem[]): TierDatum[] {
  const observed = items.reduce<Record<string, number>>((acc, item) => {
    if (item.memory_type) {
      acc[item.memory_type] = (acc[item.memory_type] ?? 0) + 1;
    }
    return acc;
  }, {});

  return [
    {
      key: "static",
      label: "Static",
      count: summary?.total_static ?? observed.static ?? 0,
      color: TIER_COLORS.static,
    },
    {
      key: "dynamic",
      label: "Dynamic",
      count: summary?.total_dynamic ?? observed.dynamic ?? 0,
      color: TIER_COLORS.dynamic,
    },
    {
      key: "working",
      label: "Working",
      count: observed.working ?? 0,
      color: TIER_COLORS.working,
    },
    {
      key: "procedural",
      label: "Procedural",
      count: Math.max(summary?.active_habits.length ?? 0, observed.procedural ?? 0),
      color: TIER_COLORS.procedural,
    },
    {
      key: "priming",
      label: "Priming",
      count: Math.max(summary?.priming_prompt ? 1 : 0, observed.priming ?? 0),
      color: TIER_COLORS.priming,
    },
  ];
}

function deriveTopEntities(items: MemoryListItem[]) {
  const frequencies = new Map<string, number>();

  for (const item of items) {
    const words = item.content
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g);
    if (!words) continue;
    for (const raw of words) {
      const word = raw.replace(/^[_-]+|[_-]+$/g, "");
      if (word.length < 4 || STOP_WORDS.has(word)) continue;
      frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
  }

  return Array.from(frequencies.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([term, count]) => ({
      term,
      count,
    }));
}

function derivePromotionSeries(events: PromotionEvent[]) {
  const days = getLast14Days();
  const pairTotals = new Map<string, number>();
  const perDay = new Map<string, Record<string, number>>();

  for (const day of days) perDay.set(day, {});

  for (const event of events) {
    const day = new Date(event.timestamp).toISOString().slice(0, 10);
    if (!perDay.has(day)) continue;
    const pair = `${event.from_type}->${event.to_type}`;
    pairTotals.set(pair, (pairTotals.get(pair) ?? 0) + 1);
    const bucket = perDay.get(day)!;
    bucket[pair] = (bucket[pair] ?? 0) + 1;
  }

  const pairs = Array.from(pairTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([pair]) => pair);

  const maxValue = Math.max(
    ...days.map((day) => pairs.reduce((sum, pair) => sum + (perDay.get(day)?.[pair] ?? 0), 0)),
    1,
  );

  return { days, pairs, perDay, maxValue };
}

function tierColorForPair(pair: string): string {
  const destination = pair.split("->")[1] ?? "dynamic";
  return TIER_COLORS[destination] ?? "var(--primary)";
}

function PromotionActivity({ events }: { events: PromotionEvent[] }) {
  const { days, pairs, perDay, maxValue } = useMemo(() => derivePromotionSeries(events), [events]);
  const hasData = pairs.length > 0;

  if (!hasData) {
    return <EmptyChart message="No promotion activity in the current 14-day window." />;
  }

  return (
    <div className="space-y-2">
      <div className="flex h-24 items-end gap-[3px]">
        {days.map((day) => {
          const total = pairs.reduce((sum, pair) => sum + (perDay.get(day)?.[pair] ?? 0), 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex h-full flex-1 flex-col justify-end" title={`${day}: ${total} promotions`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {pairs.map((pair) =>
                    (perDay.get(day)?.[pair] ?? 0) > 0 ? (
                      <div
                        key={pair}
                        style={{
                          flex: perDay.get(day)?.[pair] ?? 0,
                          backgroundColor: tierColorForPair(pair),
                        }}
                      />
                    ) : null,
                  )}
                </div>
              ) : (
                <div className="rounded-sm bg-muted/30" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-[3px]">
        {days.map((day, index) => (
          <div key={day} className="flex-1 text-center">
            {index === 0 || index === 6 || index === 13 ? (
              <span className="text-[9px] tabular-nums text-muted-foreground">
                {new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {pairs.map((pair) => (
          <span key={pair} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tierColorForPair(pair) }} />
            {pair}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MemoryAnalytics({
  agentId,
  summary,
}: {
  agentId: string;
  summary?: MemorySummary;
}) {
  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: queryKeys.agents.memory.list(agentId, undefined, "__analytics__"),
    queryFn: () => memoryApi.list(agentId, undefined, undefined, 200),
    retry: 1,
    staleTime: 15_000,
  });
  const { data: promotions, isLoading: promotionsLoading } = useQuery({
    queryKey: queryKeys.agents.memory.promotions(agentId, 50),
    queryFn: () => memoryApi.promotionLog(agentId, 50),
    retry: 1,
    staleTime: 15_000,
  });
  const { data: health } = useQuery({
    queryKey: ["memory", "health"],
    queryFn: () => memoryApi.health(),
    retry: 1,
    staleTime: 10_000,
  });

  const items = listData?.items ?? [];
  const promotionItems = promotions ?? [];
  const tierDistribution = useMemo(() => deriveTierDistribution(summary, items), [summary, items]);
  const totalTierCount = tierDistribution.reduce((sum, tier) => sum + tier.count, 0);
  const topEntities = useMemo(() => deriveTopEntities(items), [items]);

  const cards = [
    {
      icon: Shield,
      value: summary?.total_static ?? 0,
      label: "Static",
      description: `${summary?.recent_promotions?.length ?? 0} recent promotions`,
    },
    {
      icon: Zap,
      value: summary?.total_dynamic ?? 0,
      label: "Dynamic",
      description: `${items.length} recent units sampled`,
    },
    {
      icon: Database,
      value: summary?.active_habits.length ?? 0,
      label: "Habits",
      description: `${summary?.recent_learnings?.length ?? 0} recent learnings`,
    },
    {
      icon: Brain,
      value: summary?.graph_node_count ?? 0,
      label: "Nodes",
      description: health?.status === "ok" ? "runtime healthy" : "runtime unavailable",
    },
  ];

  if (!summary && listLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((card) => (
          <MetricCard
            key={card.label}
            icon={card.icon}
            value={formatCompact(Number(card.value))}
            label={card.label}
            description={card.description}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--memory-static)]" />
            <div>
              <h3 className="text-sm font-medium">Tier Distribution</h3>
              <p className="text-xs text-muted-foreground">
                Exact static and dynamic totals, plus visible procedural and priming signals.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {tierDistribution.map((tier) => {
              const pct = totalTierCount > 0 ? Math.round((tier.count / totalTierCount) * 100) : 0;
              return (
                <div key={tier.key} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium text-foreground">{tier.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {tier.count} · {pct}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: tier.color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <ArrowUpCircle className="h-4 w-4 text-[var(--memory-dynamic)]" />
            <div>
              <h3 className="text-sm font-medium">Promotion Activity</h3>
              <p className="text-xs text-muted-foreground">14-day window across recent promotion events.</p>
            </div>
          </div>
          {promotionsLoading ? <Skeleton className="h-32 rounded-lg" /> : <PromotionActivity events={promotionItems} />}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Brain className="h-4 w-4 text-[var(--memory-priming)]" />
            <div>
              <h3 className="text-sm font-medium">Top Entities</h3>
              <p className="text-xs text-muted-foreground">
                Lightweight keyword extraction from recent memory content until graph-native entity ranks land.
              </p>
            </div>
          </div>
          {!topEntities.length ? (
            <EmptyChart message="Not enough memory content yet to surface recurring entities." />
          ) : (
            <div className="space-y-3">
              {topEntities.map((entity) => {
                const maxCount = topEntities[0]?.count ?? 1;
                const pct = Math.round((entity.count / maxCount) * 100);
                return (
                  <div key={entity.term} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium capitalize text-foreground">{entity.term}</span>
                      <span className="text-xs text-muted-foreground">{entity.count} mentions</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/80 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-[var(--memory-working)]" />
            <div>
              <h3 className="text-sm font-medium">GC Summary</h3>
              <p className="text-xs text-muted-foreground">
                Runtime maintenance signals available through the current bridge surface.
              </p>
            </div>
          </div>
          <div className="divide-y divide-border">
            <PropertyRow
              label="Last run"
              value="Telemetry not yet exposed"
            />
            <PropertyRow
              label="Runtime"
              value={health?.status === "ok" ? "Healthy" : "Unavailable"}
            />
            <PropertyRow
              label="Agents loaded"
              value={String(health?.agents_loaded ?? 0)}
            />
            <PropertyRow
              label="Recent learnings"
              value={String(summary?.recent_learnings?.length ?? 0)}
            />
            <PropertyRow
              label="Promotions (14d)"
              value={String(promotionItems.length)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
