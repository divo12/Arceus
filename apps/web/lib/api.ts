const API_PORT = process.env.NEXT_PUBLIC_API_PORT || "4000";
const PROXIED_API_BASE = "/backend/api";
const LOCAL_API_BASE = `http://localhost:${API_PORT}/api`;

export function getApiBase() {
  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return LOCAL_API_BASE;
    }
  }

  return PROXIED_API_BASE;
}

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBase()}${normalizedPath}`;
}