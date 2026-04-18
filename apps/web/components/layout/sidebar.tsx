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
} from "lucide-react";
import { useTheme } from "../theme-provider";
import { cn } from "../../lib/utils";

const NAV_ITEMS = [
  { href: "/", icon: MessageSquare, label: "Chat" },
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/tasks", icon: CheckSquare, label: "Tasks" },
  { href: "/agents", icon: Users, label: "Agents" },
  { href: "/meetings", icon: CalendarDays, label: "Meetings" },
  { href: "/inbox", icon: Inbox, label: "Inbox" },
  { href: "/preview", icon: Eye, label: "Preview" },
  { href: "/governance", icon: Shield, label: "Governance" },
  { href: "/settings", icon: Settings, label: "Settings" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="group/sidebar flex h-full w-14 hover:w-40 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] py-3 transition-all duration-200 overflow-hidden">
      {/* Logo */}
      <div className="mb-3 flex h-8 shrink-0 items-center gap-2 px-4">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg-tertiary)] text-[0.625rem] font-bold text-[var(--text-secondary)]">A</span>
        <span className="whitespace-nowrap text-[0.75rem] font-semibold text-[var(--text-primary)] opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">Arceus</span>
      </div>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-md px-3 transition-colors",
                isActive
                  ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap text-[0.75rem] opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Theme toggle */}
      <div className="px-2">
        <button
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          className="flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
        >
          {theme === "dark" ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
          <span className="whitespace-nowrap text-[0.75rem] opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>
      </div>
    </div>
  );
}
