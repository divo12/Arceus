import { resolve, dirname } from "node:path";
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { createServer } from "node:net";
import { Agent as UndiciAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk";

// Beat prompts can run for the full HARD_CAP_MS (15 min) — e.g. a dev beat
// scaffolding a Vite app and running `npm install`. Node's global fetch is
// backed by undici whose default headers/body idle timeout is 5 min, which
// produces a `TypeError: fetch failed` mid-beat and orphans the claim.
// Replace the global dispatcher once with timeouts well above HARD_CAP_MS.
const OPENCODE_FETCH_TIMEOUT_MS = 30 * 60_000; // 30 min
let __opencodeDispatcherInstalled = false;
function ensureLongFetchTimeouts() {
  if (__opencodeDispatcherInstalled) return;
  __opencodeDispatcherInstalled = true;
  const existing = getGlobalDispatcher();
  setGlobalDispatcher(
    new UndiciAgent({
      headersTimeout: OPENCODE_FETCH_TIMEOUT_MS,
      bodyTimeout: OPENCODE_FETCH_TIMEOUT_MS,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 10 * 60_000,
    }),
  );
  // Best effort cleanup on shutdown. The existing dispatcher is typed as
  // `unknown` from undici's symbol indexing — narrow to a `close`-having
  // object before calling.
  process.once("beforeExit", () => {
    try {
      const closeable = existing as { close?: () => void };
      closeable.close?.();
    } catch {
      // silent: process is exiting, no observer left to log to.
    }
  });
}
import { ensureDeployment, runtimeConfig } from "../config/index.js";
import { serverConfig } from "../config/index.js";
import { resilientCall, breakers, isRetryableError } from "./resilience.js";
import { ROLES, ROLE_CONFIGS, getAllowedArceusTools, type Role } from "../../../../.opencode/agent/config.js";
import { writeBeatAgent } from "../../../../.opencode/agent/write-beat-agent.js";
import { getRoleSoul } from "@arceus/company-runtime";

interface OpencodeInstance {
  // close() is async because resetOpencodeConnection MUST wait for the
  // spawned subprocess to actually exit before allowing a fresh
  // getOpencode() to spawn a new one. Without the wait, SIGTERM is in
  // flight, port 4096 stays bound, and the next launch falls back to a
  // random port — producing the dual-boot cascade we kept seeing in logs.
  server: { url: string; close(): Promise<void> | void };
  client: ReturnType<typeof createOpencodeClient>;
}

let opencodePromise: Promise<OpencodeInstance> | null = null;
/** Per-user CEO chat sessions: Map<userId, Promise<Session>> */
const ceoChatSessionMap = new Map<string, Promise<Session>>();

/**
 * Resolve the monorepo root.  process.cwd() varies by runner:
 *   • `npm run dev` inside apps/api → cwd = apps/api
 *   • Docker                        → cwd = /app (monorepo root)
 *   • repo-level scripts            → cwd = monorepo root
 *
 * We walk up from __dirname (apps/api/src/infra) until we find the root
 * opencode.json, which only exists at the monorepo root.
 */
function findMonorepoRoot(): string {
  // __dirname equivalent for ESM: resolve from the import.meta-derived path,
  // or fall back to a known relative path from this file's location.
  let dir = resolve(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname));
  // On Windows, URL pathname may start with /C:/… — strip leading slash
  if (process.platform === "win32" && dir.startsWith("/")) dir = dir.slice(1);
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "opencode.json")) && existsSync(resolve(dir, "packages"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume process.cwd() is the monorepo root (Docker case)
  return process.cwd();
}

const projectRoot = findMonorepoRoot();
console.log(`[OpenCode] Monorepo root resolved: ${projectRoot} (cwd=${process.cwd()})`);
// Product workspace root — base directory; per-company subdirs live under here.
export const productWorkspace = resolve(projectRoot, "workspace");

/**
 * Return the OpenCode server's CWD — the SHARED parent of every tenant's
 * subdir, NOT a single tenant's directory.
 *
 * Multi-tenancy: OpenCode runs as one process with one CWD; that CWD used
 * to be `productWorkspace/<singleton-companyId>` which made tenant B's
 * built-in tool calls (edit/write/bash/read) land in tenant A's files
 * whenever the singleton happened to point at A. With CWD = parent, the
 * arceus plugin's `tool.execute.before` hook rewrites every file-path /
 * bash command per-session to point at `<parent>/<session.companyId>/`,
 * so each tool call lands in the correct tenant's subdir regardless of
 * which tenant the singleton thinks is "active".
 *
 * Files OpenCode reads from its CWD (opencode.json, .opencode/plugin/*,
 * .opencode/agent/*) live at the parent now — they're tenant-agnostic
 * anyway (same agent defs, same plugin, same MCP wiring per role).
 */
function getProductWorkspaceDir(): string {
  return productWorkspace;
}

/**
 * Load the opencode.json agent definitions from project root and merge
 * with runtime overrides. This is passed via OPENCODE_CONFIG_CONTENT so
 * OpenCode can run with cwd = productWorkspace while keeping agent defs.
 */
function loadOpencodeConfig(overrides: Record<string, unknown>): Record<string, unknown> {
  const configPath = resolve(projectRoot, "opencode.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const base = JSON.parse(raw) as Record<string, unknown>;
    return { ...base, ...overrides };
  } catch {
    // If opencode.json is missing, pass overrides only (OpenCode falls back to defaults)
    return overrides;
  }
}

/**
 * Sync opencode.json and .opencode/prompts/ into the product workspace so
 * the OpenCode server (which runs with cwd = productWorkspace) can discover
 * the custom agent definitions. OPENCODE_CONFIG_CONTENT is not supported by
 * the CLI, so the config must live at its cwd.
 *
 * Always injects the MCP wiring + plugin reference so agents can reach the
 * Arceus control-plane tools regardless of which call site triggers the sync.
 */
function syncOpencodeConfigToWorkspace(mergedConfig: Record<string, unknown>) {
  // Ensure MCP wiring is always present
  const arceusApi = `http://127.0.0.1:${serverConfig.port}`;
  const arceusToken = process.env.ARCEUS_INTERNAL_TOKEN ?? process.env.ARCEUS_TOKEN ?? "arceus-dev-token";
  // Use absolute path because OpenCode runs with cwd=productWorkspace which
  // differs from the repo root where node_modules lives.
  const mcpTransport = resolve(projectRoot, "node_modules", "@arceus", "mcp", "src", "transport-stdio.ts");
  // Use "node --import tsx" instead of "npx tsx" because OpenCode spawns MCP
  // servers via child_process.spawn() without shell:true — on Windows, npx is
  // a .cmd shim that spawn() cannot resolve without a shell.
  mergedConfig.mcp = {
    arceus: {
      type: "local",
      command: ["node", "--import", "tsx", mcpTransport],
      environment: { ARCEUS_API: arceusApi, ARCEUS_TOKEN: arceusToken },
      enabled: true,
    },
  };
  mergedConfig.plugin = ["./.opencode/plugin/arceus.ts"];

  // Permission floor: NEVER let OpenCode block a beat on an interactive
  // permission prompt. Every permission key defaults to "ask"; an "ask"
  // pauses the tool for human approval, but this is a HEADLESS server
  // with no responder (the plugin's permission.asked hook only logs), so
  // any triggered "ask" hangs the tool in `running` until HARD_CAP. This
  // is a GENERAL stall class, not apply_patch-specific:
  //   - external_directory → fired on the "/workspace/..." soul alias a
  //     tool path resolved outside the project root (the 15-min
  //     "apply_patch hang"; opencode.log: `asking … external_directory`).
  //   - doom_loop → OpenCode's "you appear stuck in a loop, continue?"
  //     prompt, which fires when the model repeats similar actions
  //     (re-reading files, retrying a patch) — so a read/edit can
  //     "stall" with no error at all. Our own watchdog handles real
  //     stalls; we never want OpenCode's interactive loop guard blocking.
  //   - edit/bash/webfetch → controlled per-agent below; this only sets
  //     the GLOBAL floor so an agent with no explicit setting defaults to
  //     allow, not ask. Explicit per-agent denies (e.g. CEO edit:deny)
  //     still win on merge, so isolation/scope is unchanged.
  // The arceus plugin already enforces tenant isolation (path rewrite +
  // hard throw on real escapes before the tool runs), so OpenCode's
  // prompts are redundant here — "allow" removes the deadlock class
  // without weakening any guarantee.
  // Spread base config FIRST, then force these to allow — the headless
  // deadlock must not be re-introducible by a stray base-config "ask".
  // Per-agent permission lives on mergedConfig.agent[role].permission and
  // still overrides this global floor on merge inside OpenCode.
  mergedConfig.permission = {
    ...((mergedConfig.permission) ?? {}),
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    doom_loop: "allow",
    external_directory: "allow",
  };

  // Per-agent MCP tool scoping (OpenCode docs pattern):
  // Globally deny arceus MCP tools, then re-enable per agent based on ROLE_CONFIGS.
  // OpenCode names MCP tools as "<server>_<toolname>", so arceus tools become "arceus_*".
  mergedConfig.tools = { "arceus_*": false };

  // Inject per-agent tools scoping into agent definitions
  const agentConfig = (mergedConfig.agent ?? {}) as Record<string, Record<string, unknown>>;
  for (const role of ROLES) {
    if (agentConfig[role]) {
      const allowedMcp = getAllowedArceusTools(role);
      if (allowedMcp.length > 0) {
        // Enable all arceus MCP tools for this role (plugin governs per-tool)
        agentConfig[role].tools = { "arceus_*": true };
      }
    }
  }
  mergedConfig.agent = agentConfig;

  // Write resolved config
  const wsDir = getProductWorkspaceDir();
  writeFileSync(
    resolve(wsDir, "opencode.json"),
    JSON.stringify(mergedConfig, null, 2),
    "utf8"
  );

  // Seed root ignore files so OpenCode's ripgrep-based file scanning,
  // indexing, and change-watching skip dependency/build trees. RCA
  // (2026-06-12): OpenCode runs as ONE shared server rooted at this
  // dir, the parent of every tenant subdir. With tenants accumulating
  // (17 live, 38,689 files — 97% of them node_modules across 11 trees),
  // per-edit project-wide work grew until an apply_patch to a 1-line CSS
  // file hung in `running` for the full 15-min HARD_CAP.
  //
  // CRITICAL: ripgrep honors `.gitignore` ONLY inside a git repository,
  // and this tree has NO `.git` at any ancestor — so `.gitignore` alone
  // is a no-op here. `.ignore` is honored UNCONDITIONALLY. Verified live:
  // the bundled rg dropped from 38,689 files to 458 (84x) once `.ignore`
  // was present; `.gitignore` had no effect. We write both — `.ignore`
  // does the work today, `.gitignore` future-proofs if a repo ever wraps
  // this dir. node_modules is never read or edited by the model, so
  // excluding it is purely beneficial. Written every boot to survive
  // image rebuilds.
  const ignoreBody = [
    "# Seeded by Arceus (infra/opencode.ts) — keep OpenCode's file",
    "# scanning off dependency/build trees in the shared workspace root.",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    ".turbo/",
    "coverage/",
    "*.log",
    "",
  ].join("\n");
  // BEST-EFFORT: seeding these ignore files is a perf optimization, NOT a
  // correctness requirement, so a write failure must NEVER abort OpenCode
  // startup. A pre-existing file owned by another user (e.g. one created
  // out-of-band by a root shell) makes writeFileSync throw EACCES; left
  // unguarded that aborted syncOpencodeConfigToWorkspace and the whole
  // server failed to boot (observed live 2026-06-12). Swallow + log; if
  // the file already exists with good content the optimization still
  // holds, and if not we simply run without the ignore (slower, not
  // broken).
  for (const name of [".ignore", ".gitignore"]) {
    try {
      writeFileSync(resolve(wsDir, name), ignoreBody, "utf8");
    } catch (err) {
      console.warn(
        `[OpenCode] could not seed ${name} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Write per-role prompt .txt files from the TS source-of-truth
  // (packages/company-runtime/src/employee-prompts/<role>.ts → DEVELOPER_PROMPT
  // etc, exposed via getRoleSoul()). These files are referenced from each
  // agent's .md frontmatter (prompt: "{file:./.opencode/prompts/<role>-soul.txt}")
  // and OpenCode reads them when assembling the agent's persona prompt.
  //
  // Critical: this REPLACES the prior "copy from <projectRoot>/.opencode/prompts/"
  // logic. Those static files were stale (last edited Apr 27) and ignored every
  // TypeScript soul refactor we did. The fix makes the TS constants the single
  // source of truth — every redeploy overwrites the .txt files with the latest
  // soul, so prompt edits propagate end-to-end without a separate file sync step.
  const dstPrompts = resolve(wsDir, ".opencode", "prompts");
  mkdirSync(dstPrompts, { recursive: true });
  for (const role of ROLES) {
    const promptFile = ROLE_CONFIGS[role].promptFile;
    // promptFile is like "./.opencode/prompts/developer-soul.txt"; we only want
    // the basename so we can join against the workspace's prompts dir.
    const basename = promptFile.split("/").pop();
    if (!basename) continue;
    const soul = getRoleSoul(role);
    if (!soul?.systemPrompt) continue;
    writeFileSync(resolve(dstPrompts, basename), soul.systemPrompt, "utf8");
  }
}

/** Populate process.env with Azure OpenAI credentials from runtime config. */
function ensureAzureRuntimeEnvironment() {
  process.env.AZURE_RESOURCE_NAME = runtimeConfig.azureResourceName;
  process.env.AZURE_OPENAI_ENDPOINT = runtimeConfig.azureEndpoint;
  process.env.AZURE_OPENAI_API_KEY = runtimeConfig.azureApiKey;
  process.env.AZURE_OPENAI_API_VERSION = runtimeConfig.azureApiVersion;
  // OpenCode's azure provider reads AZURE_API_KEY (not AZURE_OPENAI_API_KEY)
  process.env.AZURE_API_KEY = runtimeConfig.azureApiKey;
}

/** Probe whether an OpenCode server is already listening at the given URL. */
async function detectExistingOpencodeServer(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, 2000);

  try {
    const response = await fetch(`${url}/event`, {
      signal: controller.signal,
      headers: {
        Accept: "text/event-stream"
      }
    });

    if (!response.ok) {
      return false;
    }

    await response.body?.cancel();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Create an authenticated OpenCode SDK client connected to the given URL. */
async function connectOpencodeClient(url: string, close: () => Promise<void> | void): Promise<OpencodeInstance> {
  const client = createOpencodeClient({ baseUrl: url });

  await client.auth.set({
    path: { id: "azure" },
    body: { type: "api", key: runtimeConfig.azureApiKey }
  });

  return {
    server: { url, close },
    client
  };
}

/** Temporarily bind a port to confirm availability, then release it. */
function reservePort(hostname: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      reject(error);
    });

    server.listen({ host: hostname, port }, () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Unable to determine a port for the OpenCode server."));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

/** Pick an available port, falling back to an OS-assigned port on conflict. */
async function pickLaunchPort(hostname: string, preferredPort: number) {
  try {
    return await reservePort(hostname, preferredPort);
  } catch (error) {
    const knownError = error as NodeJS.ErrnoException;
    if (preferredPort !== 0 && knownError.code === "EADDRINUSE") {
      return reservePort(hostname, 0);
    }
    throw error;
  }
}

/** Check whether an error indicates an EADDRINUSE port conflict. */
function isPortConflictError(error: unknown, port: number) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Failed to start server on port ${port}`) || message.includes("EADDRINUSE");
}

/** Launch an OpenCode server, retrying with alternate ports on conflict. */
async function launchOpencodeServer(hostname: string, preferredPort: number, config: Record<string, unknown>) {
  const attemptedPorts = new Set<number>();
  let launchPort = await pickLaunchPort(hostname, preferredPort);
  let lastError: unknown = null;

  while (!attemptedPorts.has(launchPort)) {
    attemptedPorts.add(launchPort);

    try {
      if (launchPort !== preferredPort) {
        console.warn(`OpenCode port ${preferredPort} is unavailable; using port ${launchPort} instead.`);
      }

      return await spawnOpencodeServer(hostname, launchPort, config);
    } catch (error) {
      lastError = error;
      if (!isPortConflictError(error, launchPort)) {
        throw error;
      }
      launchPort = await pickLaunchPort(hostname, 0);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to start OpenCode after trying ports ${Array.from(attemptedPorts).join(", ")}.`);
}

/** Spawn the OpenCode CLI `serve` process and wait for the "listening" log line. */
function spawnOpencodeServer(hostname: string, port: number, config: Record<string, unknown>): Promise<{ url: string; proc: ChildProcess }> {
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
  const mergedConfig = loadOpencodeConfig(config);

  // Sync config + prompt files into workspace so OpenCode picks them up
  syncOpencodeConfigToWorkspace(mergedConfig);

  // Audit C5 (F-063): default to shell:false so node spawns the binary
  // directly without /bin/sh -c interpolation. Args are already in argv
  // form so no shell parsing is needed. This is defense in depth — today
  // hostname/port are admin-controlled (env), not user-controlled, but the
  // shell:true flag is a footgun for any future change that adds a flag
  // from a user-facing input. Argv mode makes the spawn injection-proof.
  //
  // Windows still needs `shell: true` because `opencode` (and `npm`/`npx`)
  // arrive as `.cmd` shims that node's spawn() can't resolve without a
  // shell. Arceus is developed and deployed on POSIX; if Windows becomes
  // a target, switch to cross-spawn or pre-resolve via `which`.
  const useShell = platform() === "win32";
  const proc = spawn("opencode", args, {
    shell: useShell,
    cwd: getProductWorkspaceDir(),
    env: {
      ...process.env,
      // Custom tools + plugin read these from the OpenCode process env
      ARCEUS_API: `http://127.0.0.1:${serverConfig.port}`,
      ARCEUS_TOKEN: process.env.ARCEUS_INTERNAL_TOKEN ?? process.env.ARCEUS_TOKEN ?? "arceus-dev-token",
    }
  });

  return new Promise((resolve, reject) => {
    // Audit C7 (F-066): SIGTERM the child on timeout so we don't leak an
    // orphan `opencode serve` process that holds the port. Without this,
    // a slow boot leaves a zombie that the next getOpencode() call
    // detects via detectExistingOpencodeServer and reuses indefinitely.
    const timeout = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGTERM");
          // Escalate to SIGKILL after 5s grace period if SIGTERM was ignored.
          setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill("SIGKILL");
            }
          }, 5000).unref();
        }
      } catch {
        // silent: process may have died between exitCode check and kill;
        // either way it's gone — fall through to reject.
      }
      reject(new Error("Timeout waiting for OpenCode server to start after 45000ms"));
    }, 45000);

    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const match = /on\s+(https?:\/\/[^\s]+)/.exec(line);
          if (match) {
            clearTimeout(timeout);
            resolve({ url: match[1], proc });
            return;
          }
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`OpenCode server exited with code ${code ?? "null"}\n${output}`));
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      // SIGTERM the child on spawn error too — same orphan-prevention.
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGTERM");
        }
      } catch {
        // silent: see above.
      }
      reject(error);
    });
  });
}

/** Get (or lazily create) the singleton OpenCode server instance. */
export async function getOpencode() {
  ensureAzureRuntimeEnvironment();
  ensureLongFetchTimeouts();

  if (!opencodePromise) {
    const attempt = (async () => {
      // Always write full config (plugin, agent defs, opencode.json) so
      // a freshly-spawned server picks up the latest plugin and agent files.
      await writeSharedOpencodeConfig();

      const existingUrl = `http://${runtimeConfig.opencodeHost}:${runtimeConfig.opencodePort}`;

      if (await detectExistingOpencodeServer(existingUrl)) {
        return connectOpencodeClient(existingUrl, () => {});
      }

      const { url, proc } = await launchOpencodeServer(
        runtimeConfig.opencodeHost,
        runtimeConfig.opencodePort,
        { share: "disabled" }
      );

      return connectOpencodeClient(url, () => waitForProcExit(proc));
    })();

    opencodePromise = attempt;

    attempt.catch(() => {
      // Clear cached promise so next call retries
      if (opencodePromise === attempt) {
        opencodePromise = null;
      }
    });
  }

  return opencodePromise;
}

/**
 * Invalidate the cached OpenCode instance so the next `getOpencode()` call
 * will reconnect to an existing server or launch a new one.  Also kills
 * the spawned server process so it picks up fresh plugin + agent files.
 */
export async function resetOpencodeConnection() {
  if (opencodePromise) {
    try {
      const instance = await opencodePromise;
      // AWAIT close() so the spawned subprocess fully exits and releases
      // the port before the next getOpencode() can spawn a replacement.
      // Fire-and-forget kill produced the dual-boot port cascade.
      await instance.server.close();
    } catch {
      // Instance never resolved — nothing to kill
    }
  }
  opencodePromise = null;
}

/**
 * SIGTERM the OpenCode subprocess and wait for it to actually exit so the
 * port it held is fully released. Falls back to SIGKILL after 5s grace if
 * the process ignores SIGTERM. Resolves once the process is gone (or the
 * SIGKILL grace window elapses); never rejects.
 */
function waitForProcExit(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once("exit", onExit);

    try {
      proc.kill("SIGTERM");
    } catch {
      // Process already dead between the check above and the kill.
      proc.off("exit", onExit);
      resolve();
      return;
    }

    const killTimer = setTimeout(() => {
      // SIGTERM ignored — escalate. The "exit" listener is still attached;
      // it'll fire (and clear the no-op fallback timer below) once the
      // process actually terminates.
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      // Final safety: if even SIGKILL doesn't yield an exit event within
      // another 2s (e.g. process is uninterruptible), give up and resolve
      // so resetOpencodeConnection can't deadlock the rest of the system.
      setTimeout(() => {
        proc.off("exit", onExit);
        resolve();
      }, 2000).unref();
    }, 5000);
    killTimer.unref();
  });
}

/**
 * Clear the cached CEO chat session(s).
 * If userId is provided, only that user's session is cleared.
 * If omitted, all sessions are cleared (e.g. on full server reset).
 */
export function resetCeoChatSession(userId?: string) {
  if (userId) {
    ceoChatSessionMap.delete(userId);
  } else {
    ceoChatSessionMap.clear();
  }
}

/**
 * Write all boot-time OpenCode configuration into the product workspace.
 * Idempotent — safe to call on every startup. Must complete BEFORE the
 * OpenCode server is spawned so it picks up plugin, agent defs, and MCP wiring.
 *
 * Phase 6.5 — Package E.
 */
async function writeSharedOpencodeConfig(): Promise<void> {
  // 1. Copy plugin into workspace dir (create per-company dir if needed)
  const wsDir = getProductWorkspaceDir();
  await fsPromises.mkdir(wsDir, { recursive: true });
  const pluginSrc = resolve(projectRoot, ".opencode", "plugin", "arceus.ts");
  const pluginDst = resolve(wsDir, ".opencode", "plugin", "arceus.ts");
  await fsPromises.mkdir(dirname(pluginDst), { recursive: true });
  if (existsSync(pluginSrc)) {
    await fsPromises.copyFile(pluginSrc, pluginDst);
  }

  // 2. Write all agent files
  for (const role of ROLES) {
    await writeBeatAgent(role, wsDir);
  }

  // 3. Sync merged config (agents + MCP wiring + plugin) into workspace.
  //    syncOpencodeConfigToWorkspace injects MCP + plugin automatically.
  syncOpencodeConfigToWorkspace(loadOpencodeConfig({ share: "disabled" }));
}

/**
 * Pre-warm OpenCode server at startup so agent execution doesn't
 * hit the cold-start SQLite migration + spawn delay. Call once after
 * the Fastify server is listening. Failures are non-fatal.
 */
export async function warmUpOpencode(): Promise<boolean> {
  try {
    console.log("[OpenCode] Writing shared config (plugin, agents, opencode.json)…");
    await writeSharedOpencodeConfig();
    console.log("[OpenCode] Pre-warming server (this may take 30-45s on first run)…");
    const instance = await getOpencode();
    console.log(`[OpenCode] Warm — server ready at ${instance.server.url}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[OpenCode] Warm-up failed (non-fatal, will retry on first use): ${msg}`);
    opencodePromise = null; // clear so next call retries
    return false;
  }
}

/** POST JSON to the OpenCode server with circuit-breaker resilience. */
export async function postOpencodeJson<T>(path: string, body: unknown): Promise<T> {
  return resilientCall(
    async () => {
      const opencode = await getOpencode();
      const response = await fetch(`${opencode.server.url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`OpenCode request failed for ${path}: ${response.status} ${response.statusText}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    },
    { breaker: breakers.opencode, shouldRetry: isRetryableError },
  );
}

/** Open the SSE event stream from the OpenCode server. */
export async function openOpencodeEventStream() {
  return resilientCall(
    async () => {
      const opencode = await getOpencode();
      const response = await fetch(`${opencode.server.url}/event`);

      if (!response.ok || !response.body) {
        throw new Error(`Unable to open OpenCode event stream: ${response.status} ${response.statusText}`);
      }

      return response.body.getReader();
    },
    { breaker: breakers.opencode, shouldRetry: isRetryableError },
  );
}

/**
 * Get (or lazily create) the CEO **chat** session for a specific user.
 *
 * Spec 35 — this session is owned exclusively by the user-facing chat
 * surface (`apps/api/src/agents/chat.ts`). Each user gets their own
 * isolated session so their chat history never bleeds across accounts.
 * The CEO heartbeat path uses `ensureAgentSession("ceo")` (per-role
 * persistent session in `agentSessions`) which is physically separate.
 */
export async function getCeoChatSession(userId: string): Promise<Session> {
  const existing = ceoChatSessionMap.get(userId);
  if (existing) return existing;

  const attempt = (async (): Promise<Session> => {
    const opencode = await getOpencode();
    ensureDeployment("ceoDeployment");

    const sessionResponse = await opencode.client.session.create({
      body: { title: `Arceus CEO chat – ${userId}` }
    });

    if (!sessionResponse.data) {
      throw new Error("OpenCode did not return a CEO chat session.");
    }

    return sessionResponse.data;
  })();

  ceoChatSessionMap.set(userId, attempt);

  attempt.catch(() => {
    if (ceoChatSessionMap.get(userId) === attempt) {
      ceoChatSessionMap.delete(userId);
    }
  });

  return attempt;
}

/**
 * Create an ephemeral session for a single beat execution.
 * Unlike getCeoChatSession(), this creates a fresh session each time
 * to avoid context bleed across beats (Spec 12 Phase 4).
 */
export async function createBeatSession(role: string, beatId: string): Promise<Session> {
  const opencode = await getOpencode();
  const sessionResponse = await opencode.client.session.create({
    body: { title: `Beat ${beatId} — ${role}` },
  });
  if (!sessionResponse.data) {
    throw new Error(`OpenCode did not return a beat session for ${role} beat ${beatId}`);
  }
  return sessionResponse.data;
}

/**
 * Destroy a beat session after execution completes.
 * Best-effort — failure to destroy should not fail the beat.
 */
export async function destroyBeatSession(sessionId: string): Promise<void> {
  try {
    const opencode = await getOpencode();
    await fetch(`${opencode.server.url}/session/${sessionId}`, { method: "DELETE" });
  } catch {
    // Silently swallow — session cleanup is best-effort
  }
}
