import type { Metadata } from "next";
import { Inter, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { AuthProvider } from "../contexts/auth-context";
import { ChatProvider } from "../components/chat/chat-context";
import { ThemeProvider } from "../components/theme-provider";
import { ConditionalShell } from "../components/layout/conditional-shell";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-serif-stack",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-stack",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Arceus",
  description: "AI company operating system"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`} data-theme="light" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <ChatProvider>
              <ConditionalShell>
                {children}
              </ConditionalShell>
            </ChatProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
