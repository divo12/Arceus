const API_PORT = process.env.NEXT_PUBLIC_API_PORT || "4000";
const REMOTE_API_BASE = process.env.NEXT_PUBLIC_API_URL ? `${process.env.NEXT_PUBLIC_API_URL}/api` : null;
const PROXIED_API_BASE = "/backend/api";
const LOCAL_API_BASE = `http://localhost:${API_PORT}/api`;
export function getApiBase() {
    if (typeof window !== "undefined") {
        const hostname = window.location.hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1") {
            return LOCAL_API_BASE;
        }
        // Production: use Railway API directly from browser
        if (REMOTE_API_BASE) {
            return REMOTE_API_BASE;
        }
    }
    return PROXIED_API_BASE;
}
export function apiUrl(path) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${getApiBase()}${normalizedPath}`;
}
