import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { ChatProvider } from "../components/chat/chat-context";
import { ThemeProvider } from "../components/theme-provider";
import { LayoutShell } from "../components/layout/layout-shell";
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

export const metadata: Metadata = {
  title: "Arceus",
  description: "AI company operating system"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${plusJakarta.variable} ${jetbrainsMono.variable}`} data-theme="dark" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <ChatProvider>
            <LayoutShell>
              {children}
            </LayoutShell>
          </ChatProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
