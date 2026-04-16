"use client";
import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
/**
 * NavShell — transparent wrapper.
 * The living dashboard (page.tsx) handles its own chrome.
 * Kept as a pass-through so other routes still render.
 */
export function NavShell({ children }) {
    return _jsx(_Fragment, { children: children });
}
