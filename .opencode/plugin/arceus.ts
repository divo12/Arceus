import type { Plugin } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

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

interface SkillManifestEntry { skillId: string; version: number }
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
  // Per-call scratch keyed by callID so the after-hook can read what
  // was passed in. Crucially `args` is stashed here at BEFORE-hook time
  // because `output` in the after-hook carries the tool RESULT
  // (`output.output`), not the call arguments — `output.args` is
  // undefined post-execute. Without this, the back-channel POST and
  // postSkillUsage's slug lookup both lose the args silently.
  const pendingCalls = new Map<
    string,
    { tool: string; startedAt: number; args: unknown }
  >();

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

  /**
   * Built-in tool event back-channel. Posts every non-arceus tool call to
   * the watchdog-reset endpoint with a body so the API can:
   *   - bump heartbeat_runs.tool_call_count via the per-beat accumulator
   *   - bump pending.toolCallCount so the no_tool_invoked deadline correctly
   *     sees built-in activity (read/edit/bash/skill/…)
   *   - emit tool.invoked / tool.result events into activity_log so the
   *     inspector and DB queries see the same shape they already see for
   *     arceus_* tools (no source-special-casing downstream)
   *
   * NOT debounced — every built-in tool call must be observed individually
   * to keep the deadline counter and DB row count accurate. The arceus_*
   * path keeps the debounced bodyless POST since MCP middleware already
   * logs those tools and bumps the accumulator on its own.
   */
  const postBuiltinToolEvent = (
    beatId: string,
    body: {
      tool: string;
      status: "ok" | "error";
      cause?: string;
      latencyMs?: number | null;
      role?: string;
      sessionId: string;
      args?: unknown;
    },
  ): void => {
    const api = process.env.ARCEUS_API;
    const token = process.env.ARCEUS_TOKEN;
    if (!api || !token || !beatId) return;

    void fetch(`${api}/api/internal/v1/beats/${beatId}/watchdog-reset`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).catch(() => {
      // Fire-and-forget — telemetry must never affect the beat.
    });
  };

  const postSkillUsage = (entry: SkillManifestEntry, beatId: string): void => {
    const api = process.env.ARCEUS_API;
    const token = process.env.ARCEUS_TOKEN;
    if (!api || !token) return;

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

      // ── Path guard: reject file operations that escape the workspace ──
      const WORKSPACE_ROOT = process.cwd();
      const FILE_TOOLS = new Set(["edit", "write", "create"]);
      if (FILE_TOOLS.has(input.tool) && output.args?.filePath) {
        const target = resolve(WORKSPACE_ROOT, output.args.filePath);
        const rel = relative(WORKSPACE_ROOT, target);
        // Escapes: relative path starts with ".." or is absolute (different drive on Windows)
        if (rel.startsWith("..") || resolve(rel) === rel) {
          throw new Error(
            `[arceus-path-guard] Blocked '${input.tool}' — path "${output.args.filePath}" resolves outside workspace.`
          );
        }
      }
      if (input.tool === "bash" && output.args?.command) {
        const cmd: string = output.args.command;
        // Block obvious path escapes in shell commands targeting parent dirs
        if (/(?:^|\s)(?:cd|cat|rm|mv|cp|mkdir|touch|tee|>|>>)\s+[^\s]*\.\.\//.test(cmd)) {
          throw new Error(
            `[arceus-path-guard] Blocked bash — command references parent directory ("../"): ${truncate(cmd, 80)}`
          );
        }
      }

      pendingCalls.set(input.callID, {
        tool: input.tool,
        startedAt: Date.now(),
        // Stash args from the BEFORE hook — they're not present on
        // `output` in the after hook, so we must capture them here for
        // the post-execute back-channel + postSkillUsage slug lookup.
        args: output.args,
      });
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
      // false-fire the watchdog. arceus_* tools go through the debounced
      // bodyless watchdog reset (MCP middleware already logs them + bumps
      // the per-beat counter). Built-in tools (read/grep/edit/write/bash/
      // skill/webfetch/tool_help) go through the non-debounced tool-event
      // POST so each invocation lands in activity_log, the per-beat counter
      // increments accurately, and the no_tool_invoked deadline counter
      // resets — without those, developer beats reading 5 files via `read`
      // get reaped at 90s as "thinking but not acting."
      const wctx = await ensureCtx(input.sessionID);
      if (wctx?.beatId) {
        if (input.tool.startsWith("arceus_")) {
          postWatchdogReset(wctx.beatId);
        } else {
          const status: "ok" | "error" = envelope.status === "error" ? "error" : "ok";
          postBuiltinToolEvent(wctx.beatId, {
            tool: input.tool,
            status,
            cause: envelope.cause ?? undefined,
            latencyMs,
            role: wctx.role,
            sessionId: input.sessionID,
            // Args were stashed from the BEFORE hook because they live
            // on `output` only pre-execute. Reading `output.args` here
            // returns undefined and silently strips the args from
            // `activity_log` (read-tool path, skill name, edit
            // filePath, …) so we can't tell which file was read or
            // which skill slug was loaded.
            args: pending?.args,
          });
        }
      }

      // Skill-usage back-channel: when the agent invokes OpenCode's built-in
      // `skill` tool, record the hit against the SkillArtifact registry via
      // the internal HTTP route. Uses ctx.beatId from session context.
      // Args read from the BEFORE-hook stash — `output.args` is undefined
      // post-execute and reading it returned `slug = null` for every
      // invocation, leaving skill_usage_events empty even though the
      // agent was calling `skill` (confirmed via activity_log tool='skill'
      // rows once the back-channel landed).
      if (input.tool === "skill") {
        await ensureManifest();
        const slug = resolveSkillSlug(pending?.args);
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
      if (part?.type !== "reasoning") return;
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
