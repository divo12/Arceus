import type { Plugin } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, relative } from "node:path";

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

// ── Read-guard tuning ────────────────────────────────────────────────
//
// gpt-5.2 over-reads: 28–38 whole-file `read` calls per beat at OpenCode's
// default limit:2000 / 50 KB cap ≈ 300–500K tokens of file content in one
// beat. Context balloons, reasoning turns balloon, the beat dies at the
// hard cap. Reference points: Codex CLI truncates tool output at 256
// lines / 10 KiB; SWE-agent's 100-line file window OUTPERFORMED whole-file
// reads on SWE-bench. We clamp softer than both.
//
// READ_LIMIT_CLAMP — max lines a single read may request. Reads with no
//   limit (whole-file) or a larger one are clamped to this; the model can
//   continue with offset-paging when it genuinely needs more.
// READ_LINE_BUDGET — cumulative lines of `read` output per session
//   (= per beat; beat sessions are destroyed after each beat). Past it,
//   further reads are denied with a steer toward grep/action. grep stays
//   available — targeted lookups are the cheap path we want to force.
const READ_LIMIT_CLAMP = 400;
const READ_LINE_BUDGET = 8_000;

// Discovery tools (glob/grep/list) get their own dedupe + call budget.
// Observed in PROD: 36 glob + 12 grep calls in ONE developer beat —
// many byte-identical — re-discovering files the beat context already
// lists. The workspace manifest in the prompt is the answer to "what
// exists"; the budget forces the model to use it.
const DISCOVERY_TOOLS = new Set(["glob", "grep", "list", "ls"]);
const DISCOVERY_CALL_BUDGET = 25;

interface ReadGuardState {
  /** Dedupe keys already served this session (reads + discovery calls). */
  seen: Set<string>;
  /** Total lines granted to `read` calls this session. */
  linesGranted: number;
  /** Total glob/grep/list calls this session. */
  discoveryCalls: number;
}

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
    { tool: string; startedAt: number; args: unknown; sessionID: string }
  >();

  // ── In-flight tool keepalive ───────────────────────────
  //
  // Built-in tool telemetry posts only AFTER execution (the after-hook),
  // so a long-running tool — bash npm install, a test suite, a Vite cold
  // boot — looks like total silence to the API's stall watchdog. At the
  // 150s silence threshold the stall-nudge would abort a WORKING beat
  // mid-tool (the repo's history already records a beat killed "2s before
  // workspace_start_preview returned"). While ANY call is in flight, ping
  // the watchdog every 30s so legitimate long executions stay alive.
  // If the OpenCode process genuinely dies mid-tool, the pings stop and
  // the stall fires correctly — the ping IS proof of life.
  const KEEPALIVE_INTERVAL_MS = 30_000;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const ensureKeepalive = (): void => {
    if (keepaliveTimer) return;
    keepaliveTimer = setInterval(() => {
      if (pendingCalls.size === 0) {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = null;
        return;
      }
      const pinged = new Set<string>();
      for (const call of pendingCalls.values()) {
        // Sync cache lookup only — the before-hook already warmed
        // sessionCtxCache via ensureCtx before registering the call.
        const ctx = sessionCtxCache.get(call.sessionID);
        if (ctx?.beatId && !pinged.has(ctx.beatId)) {
          pinged.add(ctx.beatId);
          postWatchdogReset(ctx.beatId);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  // ── Session-context cache (Phase 6.5 package F) ────────
  const sessionCtxCache = new Map<string, BeatContext>();

  // ── Read-guard state, keyed by sessionID ───────────────
  // Evicted on session.idle (beat sessions are one-shot). The fallback
  // size cap guards the warm-up / non-beat sessions that never idle.
  const readGuards = new Map<string, ReadGuardState>();
  const ensureReadGuard = (sessionId: string): ReadGuardState => {
    let state = readGuards.get(sessionId);
    if (!state) {
      if (readGuards.size > 500) readGuards.clear();
      state = { seen: new Set(), linesGranted: 0, discoveryCalls: 0 };
      readGuards.set(sessionId, state);
    }
    return state;
  };

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

  /**
   * Wrap a path in POSIX-single-quotes so it can be embedded inside a bash
   * subshell prefix without word-splitting on spaces or interpolation on
   * $-sigils. Escapes any embedded single-quote via the standard
   * `'\''` trick. Used to build the per-tenant `( cd '<path>' && ... )`
   * wrapper for bash tool calls.
   */
  const shellQuoteSingle = (s: string): string =>
    `'${s.replace(/'/g, "'\\''")}'`;

  return {
    // Strip `_sessionId` from the parameter schema sent to the LLM.
    // The MCP server augments every arceus_* input schema with a
    // required `_sessionId` field so plugin-injected per-call session
    // ids survive Zod validation server-side. But exposing it to the
    // model causes two real problems:
    //   1) Azure strict tool-calling treats the verbose description as
    //      noise and sometimes drops the tool from its callable set.
    //   2) The model occasionally trades schema budget — packing
    //      _sessionId into args while omitting required fields like
    //      `payload`, producing 422 validation rejections.
    // tool.definition fires when OpenCode publishes the tool list to
    // the LLM, so this is the right place to hide _sessionId from the
    // model. The server-side Zod schema is untouched — plugin still
    // injects _sessionId in tool.execute.before, the MCP server still
    // validates it, the wrapper still strips it before the handler
    // runs. Only the LLM's view of the schema changes.
    "tool.definition": async (input, output) => {
      // Defensive wrapper: any throw from this hook propagates into
      // OpenCode's plugin runtime and (depending on OpenCode's handling)
      // can affect the tool registration for OTHER tools in the same
      // batch — `skill`, `read`, `bash`, etc. Hide every error inside
      // a try/catch so a breakage here can't poison the broader tool
      // list. The breadcrumb to stderr keeps the failure visible.
      try {
        // toolID type-guard. OpenCode types this as string, but a
        // runtime mismatch (SDK drift, internal rename) would make
        // `.startsWith()` throw before the early-return guard.
        const toolID =
          typeof input?.toolID === "string" ? input.toolID : "";
        if (!toolID.startsWith("arceus_")) return;

        const params = output?.parameters as
          | { properties?: Record<string, unknown>; required?: string[] }
          | undefined;
        if (!params || typeof params !== "object") return;

        // delete + property assignment can throw on a frozen/proxied
        // params object. Guard each mutation independently so a
        // failure on `required` doesn't skip the `properties` clean
        // (or vice versa).
        if (
          params.properties
          && Object.prototype.hasOwnProperty.call(params.properties, "_sessionId")
        ) {
          try {
            delete params.properties._sessionId;
          } catch (delErr) {
            process.stderr.write(
              `[arceus-plugin] tool.definition: failed to delete _sessionId from ${toolID}.properties: ${delErr instanceof Error ? delErr.message : String(delErr)}\n`,
            );
          }
        }

        if (Array.isArray(params.required)) {
          try {
            params.required = params.required.filter((k) => k !== "_sessionId");
          } catch (assignErr) {
            process.stderr.write(
              `[arceus-plugin] tool.definition: failed to filter _sessionId from ${toolID}.required: ${assignErr instanceof Error ? assignErr.message : String(assignErr)}\n`,
            );
          }
        }
      } catch (err) {
        // Catch-all: anything outside the inner try/catch ladder
        // (typeof checks, property access on a hostile proxy, etc.).
        // Hook returns successfully; tool definition is published as-is.
        process.stderr.write(
          `[arceus-plugin] tool.definition hook crashed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },

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

      // Per-call session id propagation. The MCP server's stdio transport
      // can't carry per-call OpenCode sessionID through a static
      // environment, so the only channel available is the tool args.
      // The MCP server's registerTool wrapper extends every arceus_*
      // schema with `_sessionId: z.string().optional()`, strips it
      // before the real handler, and stashes it in AsyncLocalStorage
      // so http-client.request() resolves the right beat/role/company
      // headers per call. Without this, concurrency>1 leaves the API
      // unable to disambiguate between simultaneously-active beats.
      if (input.tool.startsWith("arceus_")) {
        if (!output.args || typeof output.args !== "object") {
          output.args = {};
        }
        (output.args as Record<string, unknown>)._sessionId = input.sessionID;
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

      // ── Multi-tenant path rewrite (built-in tools) ─────────────────
      //
      // OpenCode runs as ONE process with cwd = productWorkspace (the
      // shared parent of every tenant's subdir). Built-in tool calls
      // (edit/write/read/bash/grep/glob) operate against that CWD. To
      // route each call to its session's tenant subdir, we rewrite the
      // path arguments here using the session-context lookup we already
      // did above.
      //
      // Fallback: when companyId can't be resolved (warm-up, pre-bootstrap,
      // or sessions registered without a tenant), we skip the rewrite.
      // Tool calls then operate against the parent CWD — which holds only
      // opencode.json + .opencode/* (no product data), so no cross-tenant
      // leak from the no-op path.
      const tenantId = ctx?.companyId;
      if (tenantId) {
        const workspaceRoot = process.cwd();
        const tenantRoot = resolve(workspaceRoot, tenantId);

        /**
         * Map a path arg from the model's view (where "/workspace" is
         * shorthand for the workspace root, per the developer soul) to
         * the actual filesystem path for this session's tenant.
         *
         *   "/workspace"          → "<tenantRoot>"
         *   "/workspace/foo"      → "<tenantRoot>/foo"
         *   "<tenantRoot>/foo"    → unchanged (already correct)
         *   "<workspaceRoot>/<OTHER>/foo" → REJECT (cross-tenant)
         *   "/etc/passwd"         → REJECT (outside workspace tree)
         *   "foo/bar" (relative)  → "<tenantRoot>/foo/bar"
         *
         * Wildcards (`*`, `**`, `?`) in `p` are preserved — node:path.join
         * is string-only and doesn't interpret them, so glob/grep patterns
         * survive intact through the rewrite.
         */
        const scopePath = (p: string): string => {
          // 1. Soul-prompt alias: "/workspace[/...]" → tenantRoot[/...].
          if (p === "/workspace") return tenantRoot;
          if (p.startsWith("/workspace/")) {
            return join(tenantRoot, p.slice("/workspace/".length));
          }

          // 2. Already a real absolute path under this tenant's root → keep.
          if (isAbsolute(p) && (p === tenantRoot || p.startsWith(tenantRoot + "/"))) {
            return p;
          }

          // 3. Absolute path inside the shared workspace tree but NOT this
          //    tenant → cross-tenant escape. Block hard.
          if (isAbsolute(p) && (p === workspaceRoot || p.startsWith(workspaceRoot + "/"))) {
            throw new Error(
              `[arceus-tenant-guard] Blocked '${input.tool}' — path "${p}" is inside another tenant's workspace.`,
            );
          }

          // 4. Absolute path entirely outside the workspace tree (e.g.
          //    "/etc/passwd", "/root/.ssh/..."). The model is almost
          //    certainly hallucinating; tenant isolation wins over
          //    convenience. Block.
          if (isAbsolute(p)) {
            throw new Error(
              `[arceus-tenant-guard] Blocked '${input.tool}' — absolute path "${p}" is outside the workspace tree.`,
            );
          }

          // 5. Relative path → resolve under tenantRoot. Verify the result
          //    doesn't escape via ".." traversal.
          const candidate = resolve(tenantRoot, p);
          const rel = relative(tenantRoot, candidate);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            throw new Error(
              `[arceus-tenant-guard] Blocked '${input.tool}' — relative path "${p}" escapes tenant ${tenantId}.`,
            );
          }
          return candidate;
        };

        const a = output.args as Record<string, unknown> | undefined;

        // File I/O tools — defensively rewrite EITHER `filePath` or `path`
        // (OpenCode's tool schemas have varied; both arg names show up in
        // the wild). At most one will actually be set.
        const FILE_PATH_TOOLS = new Set(["edit", "write", "create", "read", "multiedit"]);
        if (FILE_PATH_TOOLS.has(input.tool) && a) {
          if (typeof a.filePath === "string") a.filePath = scopePath(a.filePath);
          if (typeof a.path === "string") a.path = scopePath(a.path);
        }

        // Search tools — `path` (the base directory) always needs tenant
        // scoping. `pattern` means two DIFFERENT things by tool:
        //   - glob/list/ls: pattern is a PATH-LIKE file glob
        //     ("/workspace/design/**/*") — must be scoped, else it matches
        //     against literal /workspace which doesn't exist here.
        //   - grep: pattern is a REGEX. Scoping it corrupted every
        //     relative-looking pattern into an absolute path
        //     ("RollupPage" → "/app/workspace/<tenant>/RollupPage", zero
        //     matches) — observed live in beat_5_1781235679578's reasoning
        //     stream: the model spent ~10 thinking rounds trying to "fix"
        //     its regex and evade the dedupe guard, because the harness
        //     was silently mangling the pattern. grep's `include` is a
        //     relative filename glob ("*.tsx") and is likewise untouched.
        const PATH_PATTERN_SEARCH_TOOLS = new Set(["glob", "list", "ls"]);
        if (PATH_PATTERN_SEARCH_TOOLS.has(input.tool) && a) {
          if (typeof a.pattern === "string") a.pattern = scopePath(a.pattern);
          if (typeof a.path === "string") a.path = scopePath(a.path);
        }
        if (input.tool === "grep" && a && typeof a.path === "string") {
          a.path = scopePath(a.path);
        }

        // Custom workspace_* tools (live in .opencode/tool/*.ts) — they
        // `spawn()` child processes (`npx tsc`, `npx vitest`, `git diff`
        // …) with the caller-supplied `cwd` / `project` paths. Without
        // rewriting these, the model's `/workspace` alias lands verbatim
        // as a non-existent directory and the spawn fails almost instantly
        // with cause:"tooling" (observed: workspace_run_typecheck FAIL in
        // 19ms with args {cwd:"/workspace", project:"/workspace"}).
        //
        // Both `cwd` and `project` are filesystem path args; rewrite them
        // through the same scopePath the I/O tools use so they resolve to
        // /app/workspace/<friendly-companyId>/ and any tenant-escape
        // attempts are rejected at the same chokepoint.
        const WORKSPACE_PATH_ARG_TOOLS = new Set([
          "workspace_run_typecheck",
          "workspace_run_acceptance_suite",
          "workspace_diff_against_criteria",
          "workspace_collect_evidence",
          "workspace_capture_browser_probe",
        ]);
        if (WORKSPACE_PATH_ARG_TOOLS.has(input.tool) && a) {
          if (typeof a.cwd === "string") a.cwd = scopePath(a.cwd);
          if (typeof a.project === "string") a.project = scopePath(a.project);
        }

        // bash: wrap the command in a subshell that cd's into the tenant
        // root so chained commands (a && b) and pipes (a | b) all inherit
        // the tenant CWD without parsing shell syntax. Also rewrite the
        // "/workspace/..." alias INSIDE the command, and reject any
        // workspace-tree absolute paths that point outside the tenant.
        if (input.tool === "bash" && a && typeof a.command === "string") {
          let cmd = a.command;

          // 1. Rewrite the "/workspace[/...]" alias to the real tenant
          //    root anywhere it appears in the command. This is the same
          //    mapping scopePath does, applied as a literal string
          //    substitution so it survives quoting / piping / heredocs.
          //    Word-boundary the match so "/workspace-template" or
          //    "/workspaceaccountant" isn't rewritten by accident.
          cmd = cmd.replace(/\/workspace(\/[^\s'"`;|&)]*)?/g, (full, suffix) => {
            return suffix ? `${tenantRoot}${suffix}` : tenantRoot;
          });

          // 2. After rewriting, look for any REMAINING absolute path
           //    that points into the shared workspace tree but outside
          //    this tenant's root — those are cross-tenant escapes.
          //    Match every absolute-looking token; heuristic, not an
          //    adversarial parser.
          const ABS_PATH_RE = /(?:^|[\s'"=`])(\/[A-Za-z0-9_./-]+)/g;
          let m: RegExpExecArray | null;
          while ((m = ABS_PATH_RE.exec(cmd)) !== null) {
            const absPath = m[1].replace(/\/+$/, "");
            if (absPath === workspaceRoot || absPath.startsWith(workspaceRoot + "/")) {
              if (absPath !== tenantRoot && !absPath.startsWith(tenantRoot + "/")) {
                throw new Error(
                  `[arceus-tenant-guard] Blocked bash — references workspace path "${absPath}" outside tenant ${tenantId}: ${truncate(cmd, 100)}`,
                );
              }
            }
          }

          // 3. Wrap in a subshell so the cd applies to everything even
          //    with chaining / pipes / sequences. Also force
          //    NODE_ENV=development inside the subshell so `npm install`
          //    actually installs devDependencies. Railway's container
          //    runs with NODE_ENV=production by default, and the bash
          //    tool inherits that env — without this override, a
          //    developer's `bash(npm install)` silently strips vite/
          //    tsc/tailwind/postcss/@vitejs/plugin-react etc. as
          //    "dev-only", node_modules ends up incomplete, and
          //    workspace_start_preview later fails with ECONNREFUSED
          //    because there's no `./node_modules/.bin/vite` to spawn.
          //    `export` so chained commands (`npm install && npm run
          //    test`) all see the value. The developer can still
          //    override on a per-command basis (`NODE_ENV=production
          //    npm run build`) — inline assignment beats the exported
          //    default for that single command.
          a.command = `( cd ${shellQuoteSingle(tenantRoot)} && export NODE_ENV=development && ${cmd} )`;
        }
      }

      // ── Read guard: clamp + dedupe + per-beat volume budget ────────
      //
      // Runs AFTER the tenant path rewrite so dedupe keys use the final
      // resolved path. Throwing here surfaces the message as the tool's
      // error observation — the same steering channel the tenant-guard
      // and governance denials already use.
      {
        const a = output.args as Record<string, unknown> | undefined;
        const guard = ensureReadGuard(input.sessionID);

        if (input.tool === "read" && a) {
          // 1. Clamp: no-limit (whole-file) reads and oversized limits
          //    become READ_LIMIT_CLAMP-line windows. offset still works,
          //    so genuine long-file reads page instead of bulk-loading.
          const requested = typeof a.limit === "number" && Number.isFinite(a.limit) ? a.limit : undefined;
          if (requested === undefined || requested > READ_LIMIT_CLAMP) {
            a.limit = READ_LIMIT_CLAMP;
          }
          const limit = a.limit as number;
          const target =
            typeof a.filePath === "string" ? a.filePath
            : typeof a.path === "string" ? a.path
            : "";
          const offset = typeof a.offset === "number" ? a.offset : 0;

          // 2. Dedupe: an identical (path, offset, limit) read this beat
          //    is pure context bloat — the content is already in the
          //    model's window. Entries are invalidated below when the
          //    file is mutated, so edit-then-verify reads still work.
          const key = `${target}@${offset}+${limit}`;
          if (guard.seen.has(key)) {
            throw new Error(
              `[arceus-read-guard] Already read ${target} (offset ${offset}, limit ${limit}) this beat — that content is in your context. Act on what you have; use grep for targeted lookups or a different offset for new sections.`,
            );
          }

          // 3. Volume budget: cumulative granted lines per beat.
          if (guard.linesGranted + limit > READ_LINE_BUDGET) {
            throw new Error(
              `[arceus-read-guard] Read budget exhausted for this beat (~${guard.linesGranted} lines already read). You have enough context — make your edit or complete/block the task now. grep is still available for targeted lookups.`,
            );
          }

          guard.seen.add(key);
          guard.linesGranted += limit;
        } else if (DISCOVERY_TOOLS.has(input.tool) && a) {
          // Dedupe byte-identical searches + cap total discovery volume.
          const key = [
            input.tool,
            typeof a.pattern === "string" ? a.pattern : "",
            typeof a.path === "string" ? a.path : "",
          ].join("|");
          if (guard.seen.has(key)) {
            throw new Error(
              `[arceus-read-guard] You already ran this exact ${input.tool} this beat — its results are in your context. The "Workspace files" section of your briefing lists every file that exists; use those paths directly. If the earlier call FAILED, change the arguments meaningfully (different pattern or directory) — do NOT resend the same call with cosmetic tweaks.`,
            );
          }
          if (guard.discoveryCalls >= DISCOVERY_CALL_BUDGET) {
            throw new Error(
              `[arceus-read-guard] Discovery budget exhausted (${guard.discoveryCalls} glob/grep/list calls this beat). The "Workspace files" section of your briefing is the complete file listing — stop searching, start reading/editing those paths.`,
            );
          }
          guard.seen.add(key);
          guard.discoveryCalls += 1;
        } else if (FILE_TOOLS.has(input.tool) || input.tool === "multiedit") {
          // File mutated → its cached read keys are stale; allow re-reads
          // of that file (post-edit verification is legitimate). Discovery
          // keys (tool|pattern|path) are also invalidated — a re-grep
          // after changing content, or a re-glob after creating a file,
          // is legitimate; the dedupe targets pure re-search loops, not
          // post-edit verification. The discoveryCalls budget still
          // bounds total volume.
          const target =
            typeof a?.filePath === "string" ? a.filePath
            : typeof a?.path === "string" ? a.path
            : null;
          if (target) {
            for (const key of guard.seen) {
              if (key.startsWith(`${target}@`) || key.includes("|")) guard.seen.delete(key);
            }
          }
        } else if (input.tool === "bash") {
          // A shell command can mutate anything — drop all dedupe keys
          // (the volume budget intentionally survives; it bounds total
          // context, not freshness).
          guard.seen.clear();
        }
      }

      pendingCalls.set(input.callID, {
        tool: input.tool,
        startedAt: Date.now(),
        // Stash args from the BEFORE hook — they're not present on
        // `output` in the after hook, so we must capture them here for
        // the post-execute back-channel + postSkillUsage slug lookup.
        args: output.args,
        sessionID: input.sessionID,
      });
      // Keep the stall watchdog fed while this call executes — built-in
      // tool telemetry only posts after completion, and long tools
      // (npm install, test suites, preview boots) must not read as
      // silence. See ensureKeepalive above.
      ensureKeepalive();
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
      // Beat ended — drop per-beat state. The read guard resets so the
      // next beat gets a fresh budget, and the session-context cache is
      // invalidated because sessions now SURVIVE across beats (F7 session
      // resume): the same sessionID maps to a NEW beatId next beat, and a
      // stale cached context would post watchdog resets + telemetry to
      // the dead beat forever.
      readGuards.delete(input.sessionID);
      sessionCtxCache.delete(input.sessionID);
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

    // NOTE: the "message.part.updated" reasoning hook that used to live
    // here was removed — it silently broke on OpenCode 1.17.x's payload
    // shape change (reasoning streams via message.part.delta; sessionID
    // nested under part). agent.reasoning is now emitted by the API's
    // event-bridge (apps/api/src/heartbeats/event-bridge.ts), which
    // parses the same SSE stream the stall clock uses — no plugin-side
    // version coupling.
  };
};

export default ArceusPlugin;
