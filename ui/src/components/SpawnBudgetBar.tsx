import { cn } from "@/lib/utils";

export function SpawnBudgetBar({ active, max }: { active: number; max: number }) {
  if (max <= 0) {
    return <span className="text-xs italic text-muted-foreground">No spawn authority</span>;
  }

  const ratio = Math.min(active / max, 1);
  const percentage = ratio * 100;
  const toneClass =
    percentage > 85
      ? "bg-red-500"
      : percentage > 60
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all duration-300", toneClass)}
          style={{ width: `${Math.max(percentage, 6)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {active}/{max}
      </span>
    </div>
  );
}
