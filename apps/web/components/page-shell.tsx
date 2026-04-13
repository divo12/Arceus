"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

export function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="shrink-0 border-b border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-6 py-4">
        <div className="mx-auto max-w-[1400px]">
          <Link
            href="/"
            className="mb-3 inline-flex items-center gap-1.5 text-[0.75rem] text-[var(--swiss-gray-400)] transition hover:text-[var(--swiss-black)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard
          </Link>
          <h1 className="text-[1.125rem] font-bold tracking-tight">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-[0.8125rem] leading-relaxed text-[var(--swiss-gray-400)]">{description}</p>
          ) : null}
        </div>
      </header>
      <main className="flex-1 px-6 py-6">
        <div className="mx-auto max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}
