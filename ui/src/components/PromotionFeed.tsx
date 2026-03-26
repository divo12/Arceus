import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpCircle, Clock3 } from "lucide-react";
import { memoryApi } from "../api/memory";
import { relativeTime } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface PromotionFeedProps {
  agentId: string;
  fallbackPromotions?: string[];
  limit?: number;
}

function TierPill({ tier }: { tier: string }) {
  return (
    <Badge variant="outline" className="capitalize">
      {tier.replaceAll("_", " ")}
    </Badge>
  );
}

export function PromotionFeed({
  agentId,
  fallbackPromotions = [],
  limit = 20,
}: PromotionFeedProps) {
  const {
    data,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["agents", "memory", "promotions", agentId, limit],
    queryFn: () => memoryApi.promotionLog(agentId, limit),
    retry: 1,
    staleTime: 15_000,
  });

  const items = useMemo(() => {
    return [...(data ?? [])].sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }, [data]);

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">Promotion Feed</h3>
          <p className="text-xs text-muted-foreground">
            Recent memory promotions across tiers, surfaced from Hippocampus projections.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20 rounded-md" />
          ))}
        </div>
      ) : items.length > 0 ? (
        <div className="divide-y divide-border">
          {items.map((item, index) => (
            <div key={`${item.memory_id}-${item.timestamp}-${index}`} className="px-4 py-4">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                <span>{relativeTime(item.timestamp)}</span>
                <Badge variant="secondary" className="capitalize">
                  {item.status}
                </Badge>
              </div>
              <p className="line-clamp-2 text-sm font-medium text-foreground">
                {item.content || item.reason}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <TierPill tier={item.from_type} />
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <TierPill tier={item.to_type} />
                <span className="text-muted-foreground">{item.reason}</span>
              </div>
            </div>
          ))}
        </div>
      ) : fallbackPromotions.length > 0 ? (
        <div className="divide-y divide-border">
          {fallbackPromotions.map((promotion, index) => (
            <div key={`${promotion}-${index}`} className="px-4 py-4">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                <span>Recent summary event</span>
              </div>
              <p className="text-sm text-foreground">{promotion}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 px-6 py-10 text-center text-muted-foreground">
          <ArrowUpCircle className="h-8 w-8" />
          <div>
            <h4 className="text-sm font-medium text-foreground">No promotions yet</h4>
            <p className="mt-1 text-sm">
              Memories promote as confidence grows and reinforcement accumulates.
            </p>
          </div>
          {error ? (
            <p className="text-xs">
              Projection endpoint is not available yet, so activity is currently empty.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
