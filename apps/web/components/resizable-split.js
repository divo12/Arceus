"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
const SPLIT_KEY = "arceus-split-ratio";
const MIN_LEFT = 320;
const MIN_RIGHT = 400;
const DEFAULT_RATIO = 0.42;
function getSavedRatio() {
    if (typeof window === "undefined")
        return DEFAULT_RATIO;
    try {
        const v = window.localStorage.getItem(SPLIT_KEY);
        if (v) {
            const n = parseFloat(v);
            if (n >= 0.15 && n <= 0.85)
                return n;
        }
    }
    catch { /* ignore */ }
    return DEFAULT_RATIO;
}
export function ResizableSplit({ left, right }) {
    const containerRef = useRef(null);
    const [ratio, setRatio] = useState(DEFAULT_RATIO);
    const dragging = useRef(false);
    useEffect(() => {
        setRatio(getSavedRatio());
    }, []);
    const onMouseDown = useCallback((e) => {
        e.preventDefault();
        dragging.current = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const onMove = (ev) => {
            if (!dragging.current || !containerRef.current)
                return;
            const rect = containerRef.current.getBoundingClientRect();
            const totalWidth = rect.width;
            const x = ev.clientX - rect.left;
            const newRatio = Math.max(MIN_LEFT / totalWidth, Math.min(x / totalWidth, 1 - MIN_RIGHT / totalWidth));
            setRatio(newRatio);
        };
        const onUp = () => {
            dragging.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            // persist
            try {
                const container = containerRef.current;
                if (container) {
                    const rect = container.getBoundingClientRect();
                    // recalculate from current state
                }
                window.localStorage.setItem(SPLIT_KEY, String(ratio));
            }
            catch { /* ignore */ }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }, [ratio]);
    // Persist on ratio change (debounced by nature of mouseup)
    useEffect(() => {
        try {
            window.localStorage.setItem(SPLIT_KEY, String(ratio));
        }
        catch { /* ignore */ }
    }, [ratio]);
    const onDoubleClick = useCallback(() => {
        setRatio(DEFAULT_RATIO);
    }, []);
    return (_jsxs("div", { ref: containerRef, className: "flex h-full min-h-0 flex-1", children: [_jsx("div", { className: "flex h-full min-w-0 flex-col overflow-hidden", style: { width: `${ratio * 100}%` }, children: left }), _jsx("div", { onMouseDown: onMouseDown, onDoubleClick: onDoubleClick, className: "group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-[var(--border)]", children: _jsx("div", { className: "absolute inset-y-0 -left-1 -right-1" }) }), _jsx("div", { className: "flex h-full min-w-0 flex-1 flex-col overflow-hidden", children: right })] }));
}
