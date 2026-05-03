"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  LayoutDashboard,
  CheckSquare,
  Users,
  Inbox,
  Eye,
  Shield,
  Settings,
  Sun,
  Moon,
  CalendarDays,
  Activity,
} from "lucide-react";
import { useTheme } from "../theme-provider";
import { cn } from "../../lib/utils";

const NAV_GROUPS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; icon: React.ComponentType<{ className?: string }>; label: string }>;
}> = [
  {
    label: "company",
    items: [
      { href: "/home", icon: MessageSquare, label: "chat" },
      { href: "/dashboard", icon: LayoutDashboard, label: "dashboard" },
      { href: "/tasks", icon: CheckSquare, label: "tasks" },
      { href: "/agents", icon: Users, label: "agents" },
    ],
  },
  {
    label: "rhythm",
    items: [
      { href: "/meetings", icon: CalendarDays, label: "meetings" },
      { href: "/inbox", icon: Inbox, label: "inbox" },
      { href: "/preview", icon: Eye, label: "preview" },
    ],
  },
  {
    label: "system",
    items: [
      { href: "/inspector", icon: Activity, label: "inspector" },
      { href: "/governance", icon: Shield, label: "governance" },
      { href: "/settings", icon: Settings, label: "settings" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

  return (
    <aside className="flex h-full w-44 shrink-0 flex-col border-r border-[var(--rule)] bg-[var(--rail)]">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-[var(--rule)]">
        <span className="grid h-5 w-5 place-items-center rounded-[4px] bg-[var(--ink)] font-mono text-[10px] font-semibold text-[var(--paper)]">A</span>
        <span className="text-[12.5px] font-semibold tracking-tight text-[var(--ink)]">arceus <span className="font-normal text-[var(--ink-3)]">/ co</span></span>
      </div>

      {/* Nav groups */}
      <nav className="flex flex-1 flex-col overflow-y-auto px-2 pt-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="mono px-2 pt-3 pb-1 text-[9.5px] uppercase tracking-[0.1em] text-[var(--ink-3)]">{group.label}</div>
            {group.items.map((item) => {
              const isActive = pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex h-7 items-center gap-2 rounded-[4px] px-2 my-[1px] text-[12.5px] transition-colors",
                    isActive
                      ? "bg-[var(--paper)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)]"
                      : "text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-black/[0.03]"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="mono border-t border-[var(--rule)] px-3 py-2.5 text-[10px] text-[var(--ink-3)]">
        <button
          onClick={toggleTheme}
          className="flex w-full items-center justify-between gap-2 rounded-[4px] px-1 py-1 hover:text-[var(--ink-2)]"
        >
          <span className="flex items-center gap-1.5">
            {theme === "light" ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
            {theme === "light" ? "light" : "dark"}
          </span>
          <span className="text-[var(--ink-4)]">v0.1</span>
        </button>
      </div>
    </aside>
  );
}
