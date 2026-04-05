const RAW_API_BASE =
  import.meta.env.VITE_API_BASE_URL?.trim() ||
  "/api";

function normalizedApiBase(): string {
  const trimmed = RAW_API_BASE.trim();
  if (!trimmed) return "/api";
  return trimmed.replace(/\/+$/, "");
}

export const API_BASE = normalizedApiBase();

export function buildApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (typeof window === "undefined") {
    return `${API_BASE}${normalizedPath}`;
  }
  return new URL(`${API_BASE}${normalizedPath}`, window.location.origin).toString();
}

export function buildWebSocketUrl(path: string): string {
  const url = new URL(buildApiUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
