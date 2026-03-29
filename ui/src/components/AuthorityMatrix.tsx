import type { RoleDefinition } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { useState } from "react";

export function AuthorityMatrix({ roles }: { roles: RoleDefinition[] }) {
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="bg-muted/50">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">
              From \ To
            </th>
            {roles.map((role, columnIndex) => (
              <th
                key={role.slug}
                className={cn(
                  "min-w-20 px-2 py-2 text-center font-medium text-muted-foreground",
                  hoveredCol === columnIndex && "bg-accent/20",
                )}
              >
                {role.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.map((fromRole, rowIndex) => (
            <tr
              key={fromRole.slug}
              className={cn(hoveredRow === rowIndex && "bg-accent/10")}
              onMouseEnter={() => setHoveredRow(rowIndex)}
              onMouseLeave={() => setHoveredRow(null)}
            >
              <td className="bg-muted/30 px-3 py-2 font-medium text-foreground">
                {fromRole.label}
              </td>
              {roles.map((toRole, columnIndex) => {
                const isSelf = fromRole.slug === toRole.slug;
                const allowed = fromRole.canDelegateTo.includes(
                  toRole.slug as (typeof fromRole.canDelegateTo)[number],
                );
                return (
                  <td
                    key={toRole.slug}
                    className={cn(
                      "px-2 py-2 text-center",
                      hoveredCol === columnIndex && "bg-accent/10",
                    )}
                    onMouseEnter={() => setHoveredCol(columnIndex)}
                    onMouseLeave={() => setHoveredCol(null)}
                  >
                    {isSelf ? (
                      <span className="text-muted-foreground">-</span>
                    ) : allowed ? (
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">Yes</span>
                    ) : (
                      <span className="text-muted-foreground/50">No</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
