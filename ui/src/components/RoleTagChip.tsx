import { X } from "lucide-react";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

const variantClasses = {
  delegation: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  spawn: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
} as const;

export function RoleTagChip({
  role,
  removable = false,
  onRemove,
  variant = "delegation",
  onClick,
}: {
  role: string;
  removable?: boolean;
  onRemove?: () => void;
  variant?: "delegation" | "spawn";
  onClick?: () => void;
}) {
  const label = AGENT_ROLE_LABELS[role as keyof typeof AGENT_ROLE_LABELS] ?? role;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        variantClasses[variant],
        onClick && "cursor-pointer hover:opacity-80",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {label}
      {removable ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove?.();
          }}
          className="ml-0.5 rounded-sm text-current/70 transition-colors hover:text-current"
          aria-label={`Remove ${label}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}
