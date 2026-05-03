/** Thin fetch wrapper for the Arceus API. */

let BASE_URL = "http://localhost:4000";

export function setBaseUrl(url: string) {
  BASE_URL = url.replace(/\/+$/, "");
}

export function getBaseUrl(): string {
  return BASE_URL;
}

/**
 * Audit C4: TUI is a Node process, so it reads the admin token from
 * the environment and attaches it on every call. The API gate is
 * no-op in dev unless `ARCEUS_REQUIRE_AUTH=1`, so forgetting to set
 * the env var locally still works.
 */
function getAdminToken(): string {
  return process.env.ARCEUS_ADMIN_TOKEN
    ?? process.env.ARCEUS_TOKEN
    ?? "arceus-dev-token";
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
      Authorization: `Bearer ${getAdminToken()}`,
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
