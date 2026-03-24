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
    <div className={`h-full rounded-xl border border-border bg-card px-5 py-4 transition-all duration-200${isClickable ? " hover:shadow-md hover:border-primary/20 cursor-pointer" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-foreground">
          {label}
        </p>
        <div className="rounded-lg bg-primary/10 p-1.5">
          <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
        </div>
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
