/** Thin fetch wrapper for the Arceus API. */

let BASE_URL = "http://localhost:4000";

export function setBaseUrl(url: string) {
  BASE_URL = url.replace(/\/+$/, "");
}

export function getBaseUrl(): string {
  return BASE_URL;
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  return api<T>(path, {
    method: "POST",
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
