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
} from "lucide-react";
import { useTheme } from "./theme-provider";
import { cn } from "../lib/utils";

const NAV_ITEMS = [
  { href: "/", icon: MessageSquare, label: "Chat" },
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/tasks", icon: CheckSquare, label: "Tasks" },
  { href: "/agents", icon: Users, label: "Agents" },
  { href: "/inbox", icon: Inbox, label: "Inbox" },
  { href: "/preview", icon: Eye, label: "Preview" },
  { href: "/governance", icon: Shield, label: "Governance" },
  { href: "/settings", icon: Settings, label: "Settings" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex h-full w-12 flex-col items-center border-r border-[var(--border)] bg-[var(--bg-secondary)] py-2">
      {/* Logo */}
      <div className="mb-2 flex h-8 w-8 items-center justify-center text-[0.625rem] font-bold text-[var(--text-muted)]">
        A
      </div>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col items-center gap-1">
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
                "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                isActive
                  ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Icon className="h-4 w-4" />
            </Link>
          );
        })}
      </nav>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
      >
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </div>
  );
}
