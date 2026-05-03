"use client";

import { usePathname } from "next/navigation";
import { LayoutShell } from "./layout-shell";

export function ConditionalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/") return <>{children}</>;
  return <LayoutShell>{children}</LayoutShell>;
}
