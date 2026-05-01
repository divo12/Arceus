/**
 * Thin typed fetch + SSE client. Vite proxy forwards `/api` to the
 * Arceus API on :4000, so the browser sees same-origin and we don't
 * need CORS / admin tokens in dev.
 */

export interface ApiOpts {
  signal?: AbortSignal;
  body?: unknown;
}

const TOKEN = "arceus-dev-token"; // dev only; prod sets ARCEUS_REQUIRE_AUTH=1

async function request<T>(method: string, path: string, opts: ApiOpts = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    signal: opts.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  // Some routes return empty body
  const txt = await res.text();
  if (!txt) return undefined as T;
  return JSON.parse(txt) as T;
}

export const api = {
  get: <T>(path: string, opts?: ApiOpts) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: ApiOpts) =>
    request<T>("POST", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: ApiOpts) =>
    request<T>("PATCH", path, { ...opts, body }),
  delete: <T>(path: string, opts?: ApiOpts) => request<T>("DELETE", path, opts),
};

/**
 * Connect to a JSON SSE stream. Returns a close function.
 */
export function sse(path: string, onMessage: (data: unknown) => void): () => void {
  const es = new EventSource(path);
  es.onmessage = (m) => {
    if (!m.data || m.data.startsWith(":")) return;
    try {
      onMessage(JSON.parse(m.data));
    } catch {
      /* ignore non-JSON */
    }
  };
  es.onerror = () => {
    // Browser will auto-reconnect; nothing to do.
  };
  return () => { es.close(); };
}

// ── Raw API shapes (loose — derive.ts narrows them) ──────────────
export interface RawCompany {
  company?: {
    id: string;
    name: string;
    status?: string;
    goal?: string;
    boardOwner?: string;
  } | null;
  agents?: RawAgent[];
  memories?: RawMemory[];
  meetings?: unknown[];
}
export interface RawAgent {
  id: string;
  name: string;
  role: string;
  title?: string;
  status?: string;
  session?: {
    runtimeStatus?: string;
    lastEventAt?: string | null;
    activeTaskId?: string | null;
    awaiting?: string | null;
  } | null;
}
export interface RawMemory {
  id?: string;
  agentId?: string;
  role?: string;
  name?: string;
  memory?: {
    currentFocus?: string[];
    recentLearnings?: string[];
    activePatterns?: string[];
    openBlockers?: string[];
    importantDecisions?: string[];
    updatedAt?: string;
  } | null;
}
export interface RawSprint {
  id: string;
  number?: number;
  status?: string;
  startedAt?: string;
  endsAt?: string | null;
  goal?: string | null;
  taskIds?: string[];
}
export interface RawTask {
  id: string;
  title?: string;
  status?: string;
  assignedRole?: string;
  assignedAgentId?: string | null;
  sprintId?: string | null;
  executionStatus?: string;
}
export interface RawSkill {
  id: string;
  name: string;
  role: string;
  version: number;
  status: "draft" | "testing" | "active" | "deprecated";
  trigger?: string;
  successRate?: number;
  usageCount?: number;
  lastUsedAt?: string | null;
  createdAt?: string;
}
export interface RawMeeting {
  id: string;
  type?: string;
  status?: string;
  scheduledAt?: string;
  contributions?: { agentId: string }[];
  resolution?: { decisions?: { summary: string }[] } | null;
  synthesis?: { primaryQuestion?: string; topics?: { title: string }[] } | null;
}
export interface RawAuditEvent {
  id: string;
  occurredAt: string;
  category?: string;
  eventType: string;
  summary?: string;
  agentRole?: string | null;
  detail?: ({ tool?: string; toolName?: string } & Record<string, unknown>) | null;
}
export interface RawHeartbeat {
  running: boolean;
  beatCount: number;
  lastBeatAt?: string | null;
}
export interface RawWorkspace {
  files?: { path: string; bytes: number }[];
  snapshots?: { id: string; createdAt: string; label?: string }[];
}
