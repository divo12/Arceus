"use client";

import { ExecutionFlow } from "../../components/execution-flow";
import { PageShell } from "../../components/layout/page-shell";

export default function ExecutionPage() {
  return (
    <PageShell title="Execution Flow" description="Orchestration flow and agent pipeline.">
      <ExecutionFlow pollIntervalMs={2000} />
    </PageShell>
  );
}
