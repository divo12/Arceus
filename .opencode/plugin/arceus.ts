import type { Plugin } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface BeatContext {
  beatId: string;
  sessionId: string;
  companyId: string;
  role: string;
  trustBand: string;
  allowedTools: string[];
  taskId?: string;
  startedAt: string;
}

interface GovernanceConfig {
  allowedTools: Set<string>;
  denyReason?: string;
}

interface CircuitKey {
  tool: string;
  cause: string;
}

type SkillManifestEntry = { skillId: string; version: number };
type SkillManifest = Record<string, SkillManifestEntry>;

const CIRCUIT_THRESHOLD = 3;
const MANIFEST_FILENAME = "arceus-skills.json";
const MANIFEST_REFRESH_MS = 10_000;

const loadAllowedTools = (): Set<string> => {
  const raw = process.env.ARCEUS_ALLOWED_TOOLS;
  if (!raw) return new Set();
  return new Set(raw.split(",").map((t) => t.trim()).filter(Boolean));
};

const parseEnvelope = (output: string): { cause?: string; status?: string } => {
  try {
    const parsed = JSON.parse(output) as { status?: string; error?: { cause?: string } };
    return { status: parsed.status, cause: parsed.error?.cause };
  } catch {
    return {};
  }
};

const keyOf = (k: CircuitKey): string => `${k.tool}::${k.cause}`;

/** Read the skill name argument from an OpenCode `skill` tool invocation. */
const resolveSkillSlug = (args: unknown): string | null => {
  if (!args || typeof args !== "object") return null;
  const maybe = (args as { name?: unknown }).name;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : null;
};

export const ArceusPlugin: Plugin = async () => {
  const governance: GovernanceConfig = {
    allowedTools: loadAllowedTools(),
    denyReason: "Tool not in this beat's allowlist.",
  };
  const circuitTally = new Map<string, number>();
  const pendingCalls = new Map<string, { tool: string; startedAt: number }>();

  // ── Session-context cache (Phase 6.5 package F) ────────
  const sessionCtxCache = new Map<string, BeatContext>();

  const ensureCtx = async (sessionId: string): Promise<BeatContext | null> => {
    if (sessionCtxCache.has(sessionId)) return sessionCtxCache.get(sessionId)!;
    const api = process.env.ARCEUS_API;
    const token = process.env.ARCEUS_TOKEN;
    if (!api || !token) return null;
    try {
      const res = await fetch(
        `${api}/api/internal/telemetry/session-context/${sessionId}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const ctx = await res.json() as BeatContext;
      sessionCtxCache.set(sessionId, ctx);
      return ctx;
    } catch {
      return null;
    }
  };

  const emitAudit = (payload: Record<string, unknown>): void => {
    process.stderr.write(`[arceus-audit] ${JSON.stringify(payload)}\n`);
  };

  // ── Skill-usage manifest cache ────────────────────────
  //
  // The manifest maps `slug → { skillId, version }`. Written by
  // materializeBeatSkills at beat start. Re-read at most every
  // MANIFEST_REFRESH_MS so edits between beats are picked up without thrashing
  // the filesystem on every tool call.
  let manifest: SkillManifest = {};
  let manifestLoadedAt = 0;

  const manifestPath = (): string =>
    join(process.cwd(), ".opencode", MANIFEST_FILENAME);

  const refreshManifest = async (): Promise<void> => {
    try {
      const raw = await readFile(manifestPath(), "utf8");
      manifest = JSON.parse(raw) as SkillManifest;
      manifestLoadedAt = Date.now();
    } catch {
      // Manifest missing or malformed — leave the previous one in place so a
      // transient write race doesn't lose prior state. Next refresh retries.
      manifestLoadedAt = Date.now();
    }
  };

  const ensureManifest = async (): Promise<void> => {
    if (Date.now() - manifestLoadedAt < MANIFEST_REFRESH_MS) return;
    await refreshManifest();
  };

  const lastWatchdogResetByBeat = new Map<string, number>();
  const WATCHDOG_DEBOUNCE_MS = 1000;

  const postWatchdogReset = (beatId: string): void => {
    const api = process.env.ARCEUS_API;
    const token = process.env.ARCEUS_TOKEN;
    if (!api || !token || !beatId) return;

    const last = lastWatchdogResetByBeat.get(beatId) ?? 0;
    const now = Date.now();
    if (now - last < WATCHDOG_DEBOUNCE_MS) return;
    lastWatchdogResetByBeat.set(beatId, now);

    // eslint-disable-next-line no-restricted-syntax -- intentional: opencode plugin runs in a separate process from the API so it can't import swallowAndAudit; watchdog reset failure must not affect the beat.
    void fetch(`${api}/api/internal/v1/beats/${beatId}/watchdog-reset`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    }).catch(() => {
      // Fire-and-forget — watchdog reset failure must not affect the beat.
    });
  };

  const postSkillUsage = (entry: SkillManifestEntry, beatId: string): void => {
    const api = process.env.ARCEUS_API;
    const token = process.env.ARCEUS_TOKEN;
    if (!api || !token) return;

    // eslint-disable-next-line no-restricted-syntax -- intentional: telemetry is best-effort; failure must not block the beat or leak into the agent's observation. Plugin runs in a separate process from the API.
    void fetch(`${api}/api/internal/telemetry/skills/${entry.skillId}/usage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ beatId, version: entry.version }),
    }).catch(() => {
      // Fire-and-forget — usage telemetry is best-effort; a failed POST must
      // never block the beat or leak into the agent's observation.
    });
  };

  // ── Spec 32 Phase 4 — ArceusEvent emit channel ───────────
  // The plugin runs in a separate process from the API, so it cannot share
  // observability.setSink. Each event POSTs to /api/internal/telemetry/events
  // where the API validates and re-emits via logEvent — same fan-out as
  // any in-process emit site.
  const postEvent = (event: Record<string, unknown>): void => {
    const api = process.env.ARCEUS_API;
    const token = process.env.ARCEUS_TOKEN;
    if (!api || !token) return;
    // eslint-disable-next-line no-restricted-syntax -- intentional: observability emits must never block the agent. Plugin runs in a separate process; can't recursively re-emit on failure.
    void fetch(`${api}/api/internal/telemetry/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    }).catch(() => {
      // Fire-and-forget — observability emits never block the agent.
    });
  };

  /** Truncate reasoning text to keep payloads + Langfuse storage manageable. */
  const truncate = (s: string, max = 4_000): string =>
    s.length > max ? `${s.slice(0, max)}…` : s;

  return {
    "tool.execute.before": async (input, output) => {
      // Resolve beat context from session; fall back to env-based governance
      const ctx = await ensureCtx(input.sessionID);
      const allowed = ctx?.allowedTools
        ?? (governance.allowedTools.size > 0 ? [...governance.allowedTools] : []);
      // Only gate Arceus MCP tools (prefixed "arceus_"). Built-in OpenCode tools
      // (read, grep, bash, edit, etc.) are governed by OpenCode's own permission
      // system via ROLE_CONFIGS.permission — the plugin must not double-gate them.
      if (input.tool.startsWith("arceus_") && allowed.length > 0) {
        const toolName = input.tool.slice("arceus_".length);
        if (!allowed.includes(toolName) && !allowed.includes(input.tool)) {
          throw new Error(`[arceus-governance] Tool '${input.tool}' not in this beat's allowlist.`);
        }
      }

      const causes = Array.from(circuitTally.entries())
        .filter(([k, count]) => k.startsWith(`${input.tool}::`) && count >= CIRCUIT_THRESHOLD)
        .map(([k]) => k.split("::")[1]);
      if (causes.length > 0) {
        throw new Error(`[arceus-circuit] tool=${input.tool} tripped on cause(s)=${causes.join(",")}`);
      }

      pendingCalls.set(input.callID, { tool: input.tool, startedAt: Date.now() });
      emitAudit({
        phase: "before",
        tool: input.tool,
        callID: input.callID,
        sessionID: input.sessionID,
        args: output.args,
        startedAt: Date.now(),
      });
    },

    "tool.execute.after": async (input, output) => {
      const pending = pendingCalls.get(input.callID);
      const latencyMs = pending ? Date.now() - pending.startedAt : null;
      pendingCalls.delete(input.callID);

      const envelope = parseEnvelope(output.output);

      emitAudit({
        phase: "after",
        tool: input.tool,
        callID: input.callID,
        sessionID: input.sessionID,
        status: envelope.status ?? "unknown",
        cause: envelope.cause ?? null,
        latencyMs,
      });

      if (envelope.status === "error" && envelope.cause) {
        const key = keyOf({ tool: input.tool, cause: envelope.cause });
        circuitTally.set(key, (circuitTally.get(key) ?? 0) + 1);
      }

      // Beat watchdog reset — bump lastActivityAt so multi-tool beats don't
      // false-fire the watchdog. Debounced to 1×/sec per beat in the plugin.
      const wctx = await ensureCtx(input.sessionID);
      if (wctx?.beatId) postWatchdogReset(wctx.beatId);

      // Skill-usage back-channel: when the agent invokes OpenCode's built-in
      // `skill` tool, record the hit against the SkillArtifact registry via
      // the internal HTTP route. Uses ctx.beatId from session context.
      if (input.tool === "skill") {
        await ensureManifest();
        const slug = resolveSkillSlug((output as { args?: unknown }).args);
        const entry = slug ? manifest[slug] : undefined;
        const ctx = await ensureCtx(input.sessionID);
        if (entry && ctx) postSkillUsage(entry, ctx.beatId);
      }
    },

    // ── Spec 32 Phase 4 — additional emit hooks ────────────

    "session.idle": async (input: { sessionID: string }) => {
      const ctx = await ensureCtx(input.sessionID);
      if (!ctx) return;
      postEvent({
        event: "beat.idle",
        beatId: ctx.beatId,
        stalledMs: 0,
        ts: Date.now(),
      });
    },

    "session.error": async (input: { sessionID: string }, output: unknown) => {
      const ctx = await ensureCtx(input.sessionID);
      const o = output as { error?: { message?: string }; message?: string } | undefined;
      const message = o?.error?.message ?? o?.message ?? "session error";
      postEvent({
        event: "error",
        where: "opencode_session",
        message,
        beatId: ctx?.beatId,
        ts: Date.now(),
      });
    },

    "permission.asked": async (input: { sessionID: string }, output: unknown) => {
      const ctx = await ensureCtx(input.sessionID);
      if (!ctx) return;
      const o = output as { tool?: string; toolName?: string } | undefined;
      const tool = o?.tool ?? o?.toolName ?? "unknown";
      postEvent({
        event: "permission.asked",
        beatId: ctx.beatId,
        tool,
        ts: Date.now(),
      });
    },

    "permission.replied": async (input: { sessionID: string }, output: unknown) => {
      const ctx = await ensureCtx(input.sessionID);
      if (!ctx) return;
      const o = output as { tool?: string; toolName?: string; granted?: boolean; allowed?: boolean } | undefined;
      const tool = o?.tool ?? o?.toolName ?? "unknown";
      const granted = o?.granted ?? o?.allowed ?? false;
      postEvent({
        event: "permission.replied",
        beatId: ctx.beatId,
        tool,
        granted,
        ts: Date.now(),
      });
    },

    "message.part.updated": async (input: { sessionID: string }, output: unknown) => {
      const fromOutput = (output as { part?: { type?: string; text?: string } } | undefined)?.part;
      const fromInput = (input as unknown as { part?: { type?: string; text?: string } }).part;
      const part = fromOutput ?? fromInput;
      if (!part || part.type !== "reasoning") return;
      const text = part.text ?? "";
      if (!text) return;
      const ctx = await ensureCtx(input.sessionID);
      if (!ctx) return;
      postEvent({
        event: "agent.reasoning",
        beatId: ctx.beatId,
        role: ctx.role,
        text: truncate(text),
        ts: Date.now(),
      });
    },
  };
};

export default ArceusPlugin;
