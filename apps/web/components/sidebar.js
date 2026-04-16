"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, LayoutDashboard, CheckSquare, Users, Inbox, Eye, Shield, Settings, Sun, Moon, } from "lucide-react";
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
];
export function Sidebar() {
    const pathname = usePathname();
    const { theme, toggleTheme } = useTheme();
    return (_jsxs("div", { className: "group/sidebar flex h-full w-14 hover:w-40 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] py-3 transition-all duration-200 overflow-hidden", children: [_jsxs("div", { className: "mb-3 flex h-8 shrink-0 items-center gap-2 px-4", children: [_jsx("span", { className: "flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg-tertiary)] text-[0.625rem] font-bold text-[var(--text-secondary)]", children: "A" }), _jsx("span", { className: "whitespace-nowrap text-[0.75rem] font-semibold text-[var(--text-primary)] opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200", children: "Arceus" })] }), _jsx("nav", { className: "flex flex-1 flex-col gap-0.5 px-2", children: NAV_ITEMS.map((item) => {
                    const isActive = item.href === "/"
                        ? pathname === "/"
                        : pathname.startsWith(item.href);
                    const Icon = item.icon;
                    return (_jsxs(Link, { href: item.href, title: item.label, className: cn("flex h-9 items-center gap-2.5 rounded-md px-3 transition-colors", isActive
                            ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                            : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"), children: [_jsx(Icon, { className: "h-4 w-4 shrink-0" }), _jsx("span", { className: "whitespace-nowrap text-[0.75rem] opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200", children: item.label })] }, item.href));
                }) }), _jsx("div", { className: "px-2", children: _jsxs("button", { onClick: toggleTheme, title: theme === "dark" ? "Switch to light" : "Switch to dark", className: "flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]", children: [theme === "dark" ? _jsx(Sun, { className: "h-4 w-4 shrink-0" }) : _jsx(Moon, { className: "h-4 w-4 shrink-0" }), _jsx("span", { className: "whitespace-nowrap text-[0.75rem] opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200", children: theme === "dark" ? "Light mode" : "Dark mode" })] }) })] }));
}
