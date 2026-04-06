"use client";

import { ExecutionFlow } from "../../components/execution-flow";

export default function ExecutionPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--swiss-gray-100)] px-8 py-5">
        <div className="swiss-caption">08 — Execution</div>
        <h1 className="swiss-h1 mt-1">Orchestration flow</h1>
      </header>

      <div className="px-8 py-6">
        <ExecutionFlow pollIntervalMs={2000} />
      </div>
    </div>
  );
}
