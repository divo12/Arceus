import { jsx as _jsx } from "react/jsx-runtime";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { ChatProvider } from "../components/chat-context";
import { ThemeProvider } from "../components/theme-provider";
import { LayoutShell } from "../components/layout-shell";
import "./globals.css";
const plusJakarta = Plus_Jakarta_Sans({
    subsets: ["latin"],
    variable: "--font-body",
    display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
    subsets: ["latin"],
    variable: "--font-mono",
    display: "swap",
});
export const metadata = {
    title: "Arceus",
    description: "AI company operating system"
};
export default function RootLayout({ children }) {
    return (_jsx("html", { lang: "en", className: `${plusJakarta.variable} ${jetbrainsMono.variable}`, "data-theme": "dark", suppressHydrationWarning: true, children: _jsx("body", { children: _jsx(ThemeProvider, { children: _jsx(ChatProvider, { children: _jsx(LayoutShell, { children: children }) }) }) }) }));
}
