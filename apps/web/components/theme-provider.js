"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useState, useEffect, useCallback } from "react";
const ThemeContext = createContext(undefined);
const THEME_KEY = "arceus-theme";
function getInitialTheme() {
    if (typeof window === "undefined")
        return "dark";
    try {
        const stored = window.localStorage.getItem(THEME_KEY);
        if (stored === "light" || stored === "dark")
            return stored;
    }
    catch { /* ignore */ }
    return "dark";
}
export function ThemeProvider({ children }) {
    const [theme, setTheme] = useState("dark");
    useEffect(() => {
        const initial = getInitialTheme();
        setTheme(initial);
        document.documentElement.setAttribute("data-theme", initial);
    }, []);
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        try {
            window.localStorage.setItem(THEME_KEY, theme);
        }
        catch { /* ignore */ }
    }, [theme]);
    const toggleTheme = useCallback(() => {
        setTheme((prev) => (prev === "dark" ? "light" : "dark"));
    }, []);
    return (_jsx(ThemeContext.Provider, { value: { theme, toggleTheme }, children: children }));
}
export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx)
        throw new Error("useTheme must be used within ThemeProvider");
    return ctx;
}
