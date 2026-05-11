import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The canonical `cn()` helper used by every shadcn/ui component.
 * Merges Tailwind classes intelligently — later classes override earlier
 * ones for the same property (e.g. `cn("p-2", "p-4")` → `"p-4"`).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
