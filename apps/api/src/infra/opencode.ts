import { resolve, dirname } from "node:path";
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk";
import { ensureDeployment, runtimeConfig } from "../config/index.js";
import { serverConfig } from "../config/index.js";
import { resilientCall, breakers, isRetryableError } from "./resilience.js";
import { ROLES, ROLE_CONFIGS, getAllowedArceusTools, type Role } from "../../../../.opencode/agent/config.js";
import { writeBeatAgent } from "../../../../.opencode/agent/write-beat-agent.js";

type OpencodeInstance = {
  server: { url: string; close(): void };
  client: ReturnType<typeof createOpencodeClient>;
};

let opencodePromise: Promise<OpencodeInstance> | null = null;
let ceoSessionPromise: Promise<Session> | null = null;

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
// Product workspace — where agents write code. OpenCode spawns with this as cwd
// so that all file tools (write, edit, bash) resolve relative to it.
export const productWorkspace = resolve(projectRoot, "workspace");

/**
 * Load the opencode.json agent definitions from project root and merge
 * with runtime overrides. This is passed via OPENCODE_CONFIG_CONTENT so
 * OpenCode can run with cwd = productWorkspace while keeping agent defs.
 */
function loadOpencodeConfig(overrides: Record<string, unknown>): Record<string, unknown> {
  const configPath = resolve(projectRoot, "opencode.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const base = JSON.parse(raw);
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
  writeFileSync(
    resolve(productWorkspace, "opencode.json"),
    JSON.stringify(mergedConfig, null, 2),
    "utf8"
  );

  // Copy .opencode/prompts/ so {file:...} references resolve
  const srcPrompts = resolve(projectRoot, ".opencode", "prompts");
  const dstPrompts = resolve(productWorkspace, ".opencode", "prompts");
  if (existsSync(srcPrompts)) {
    mkdirSync(dstPrompts, { recursive: true });
    for (const file of readdirSync(srcPrompts)) {
      copyFileSync(resolve(srcPrompts, file), resolve(dstPrompts, file));
    }
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
  const timeout = setTimeout(() => controller.abort(), 2000);

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
async function connectOpencodeClient(url: string, close: () => void): Promise<OpencodeInstance> {
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

  const proc = spawn("opencode", args, {
    shell: true,
    cwd: productWorkspace,
    env: {
      ...process.env,
      // Custom tools + plugin read these from the OpenCode process env
      ARCEUS_API: `http://127.0.0.1:${serverConfig.port}`,
      ARCEUS_TOKEN: process.env.ARCEUS_INTERNAL_TOKEN ?? process.env.ARCEUS_TOKEN ?? "arceus-dev-token",
    }
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for OpenCode server to start after 45000ms"));
    }, 45000);

    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
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
      reject(new Error(`OpenCode server exited with code ${code}\n${output}`));
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/** Get (or lazily create) the singleton OpenCode server instance. */
export async function getOpencode() {
  ensureAzureRuntimeEnvironment();

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

      return connectOpencodeClient(url, () => {
        proc.kill();
      });
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
      instance.server.close();
    } catch {
      // Instance never resolved — nothing to kill
    }
  }
  opencodePromise = null;
}

/** Clear the cached CEO session so the next bootstrap creates a fresh one. */
export function resetCeoSession() {
  ceoSessionPromise = null;
}

/**
 * Write all boot-time OpenCode configuration into the product workspace.
 * Idempotent — safe to call on every startup. Must complete BEFORE the
 * OpenCode server is spawned so it picks up plugin, agent defs, and MCP wiring.
 *
 * Phase 6.5 — Package E.
 */
export async function writeSharedOpencodeConfig(): Promise<void> {
  // 1. Copy plugin into productWorkspace
  const pluginSrc = resolve(projectRoot, ".opencode", "plugin", "arceus.ts");
  const pluginDst = resolve(productWorkspace, ".opencode", "plugin", "arceus.ts");
  await fsPromises.mkdir(dirname(pluginDst), { recursive: true });
  if (existsSync(pluginSrc)) {
    await fsPromises.copyFile(pluginSrc, pluginDst);
  }

  // 2. Write all agent files
  for (const role of ROLES) {
    await writeBeatAgent(role, productWorkspace);
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

/** Get (or lazily create) the singleton CEO session on OpenCode. */
export async function getCeoSession() {
  if (!ceoSessionPromise) {
    const attempt = (async () => {
      const opencode = await getOpencode();
      ensureDeployment("ceoDeployment");

      const sessionResponse = await opencode.client.session.create({
        body: { title: "Arceus CEO" }
      });

      if (!sessionResponse.data) {
        throw new Error("OpenCode did not return a CEO session.");
      }

      return sessionResponse.data;
    })();

    ceoSessionPromise = attempt;

    attempt.catch(() => {
      if (ceoSessionPromise === attempt) {
        ceoSessionPromise = null;
      }
    });
  }

  return ceoSessionPromise;
}

/**
 * Create an ephemeral session for a single beat execution.
 * Unlike getCeoSession(), this creates a fresh session each time
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
