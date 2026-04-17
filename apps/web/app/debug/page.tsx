"use client";

import { DebugGraph } from "../../components/debug-graph";

export default function DebugPage() {
  return (
    <div className="flex flex-col h-screen">
      <header className="shrink-0 border-b border-gray-200 bg-gray-50 px-6 py-3">
        <h1 className="text-sm font-bold tracking-tight">Graph Execution Debug</h1>
        <p className="text-[0.75rem] text-gray-400">Operator-only — real-time execution graph inspector</p>
      </header>
      <div className="flex-1 min-h-0">
        <DebugGraph />
      </div>
    </div>
  );
}
