"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { DebugGraph } from "../../components/debug/debug-graph";
export default function DebugPage() {
    return (_jsxs("div", { className: "flex flex-col h-screen", children: [_jsxs("header", { className: "shrink-0 border-b border-gray-200 bg-gray-50 px-6 py-3", children: [_jsx("h1", { className: "text-sm font-bold tracking-tight", children: "Graph Execution Debug" }), _jsx("p", { className: "text-[0.75rem] text-gray-400", children: "Operator-only \u2014 real-time execution graph inspector" })] }), _jsx("div", { className: "flex-1 min-h-0", children: _jsx(DebugGraph, {}) })] }));
}
