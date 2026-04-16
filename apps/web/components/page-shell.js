"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
export function PageShell({ title, description, children, }) {
    return (_jsxs("div", { className: "flex min-h-screen flex-col", children: [_jsx("header", { className: "shrink-0 border-b border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] px-6 py-4", children: _jsxs("div", { className: "mx-auto max-w-[1400px]", children: [_jsxs(Link, { href: "/", className: "mb-3 inline-flex items-center gap-1.5 text-[0.75rem] text-[var(--swiss-gray-400)] transition hover:text-[var(--swiss-black)]", children: [_jsx(ArrowLeft, { className: "h-3.5 w-3.5" }), "Dashboard"] }), _jsx("h1", { className: "text-[1.125rem] font-bold tracking-tight", children: title }), description ? (_jsx("p", { className: "mt-1 max-w-2xl text-[0.8125rem] leading-relaxed text-[var(--swiss-gray-400)]", children: description })) : null] }) }), _jsx("main", { className: "flex-1 px-6 py-6", children: _jsx("div", { className: "mx-auto max-w-[1400px]", children: children }) })] }));
}
