import type { DelegationStyle } from "@paperclipai/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const STYLE_CONFIG: Record<
  DelegationStyle,
  {
    short: string;
    label: string;
    className: string;
    hint: string;
  }
> = {
  directive: {
    short: "D",
    label: "directive",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    hint: "Full oversight with specific instructions and close control.",
  },
  collaborative: {
    short: "C",
    label: "collaborative",
    className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    hint: "Shared context and mutual input while keeping room for autonomy.",
  },
  autonomous: {
    short: "A",
    label: "autonomous",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    hint: "Goal-driven execution with minimal oversight from the delegator.",
  },
};

export function DelegationStyleBadge({
  style,
  size = "sm",
}: {
  style: DelegationStyle;
  size?: "sm" | "md";
}) {
  const config = STYLE_CONFIG[style];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center rounded-full font-medium uppercase tracking-wide whitespace-nowrap",
            size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs",
            config.className,
          )}
        >
          {size === "sm" ? config.short : config.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-56 text-xs">
        {config.hint}
      </TooltipContent>
    </Tooltip>
  );
}
