"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { ExecutionFlow } from "../../components/execution-flow";
import { PageShell } from "../../components/layout/page-shell";
export default function ExecutionPage() {
    return (_jsx(PageShell, { title: "Execution Flow", description: "Orchestration flow and agent pipeline.", children: _jsx(ExecutionFlow, { pollIntervalMs: 2000 }) }));
}
