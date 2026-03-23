import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div className={`h-full rounded-lg border border-border bg-card px-5 py-4 transition-colors${isClickable ? " hover:bg-accent/30 cursor-pointer" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-foreground">
          {label}
        </p>
        <Icon className="h-4 w-4 text-muted-foreground/40 shrink-0" />
      </div>
      <p className="text-3xl font-bold tracking-tight tabular-nums">
        {value}
      </p>
      {description && (
        <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-1.5">{description}</div>
      )}
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
