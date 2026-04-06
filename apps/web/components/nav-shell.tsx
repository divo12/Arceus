"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Board", idx: "01" },
  { href: "/tasks", label: "Tasks", idx: "02" },
  { href: "/employees", label: "Employees", idx: "03" },
  { href: "/meetings", label: "Meetings", idx: "04" },
  { href: "/activity", label: "Activity", idx: "05" },
  { href: "/workspace", label: "Workspace", idx: "06" },
  { href: "/preview", label: "Preview", idx: "07" },
  { href: "/execution", label: "Execution", idx: "08" },
] as const;

export function NavShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      {/* ── Sidebar ──────────────────────────────────── */}
      <aside className="sticky top-0 flex h-screen w-[200px] shrink-0 flex-col border-r border-[var(--swiss-gray-100)] bg-[var(--swiss-white)]">
        {/* Brand */}
        <div className="px-5 pt-6 pb-4">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-[var(--swiss-black)]">
            Arceus
          </span>
        </div>

        <hr className="swiss-rule" />

        {/* Nav links */}
        <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-4">
          {NAV_ITEMS.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 px-2 py-2 text-[0.8125rem] transition-colors ${
                  active
                    ? "font-semibold text-[var(--swiss-black)]"
                    : "text-[var(--swiss-gray-400)] hover:text-[var(--swiss-black)]"
                }`}
              >
                <span className="w-5 text-right text-[0.625rem] tabular-nums text-[var(--swiss-gray-300)]">
                  {item.idx}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-5 pb-5">
          <hr className="swiss-rule mb-3" />
          <span className="text-[0.625rem] text-[var(--swiss-gray-300)]">
            AI Operating System
          </span>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────── */}
      <main className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}
