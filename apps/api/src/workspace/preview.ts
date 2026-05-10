import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, extname, join, normalize, relative } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { previewConfig } from "../config/index.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { getDb } from "@arceus/db";
import { findCompanyById } from "@arceus/db/src/repos/companies.js";
import { withKeyedLock } from "./async-queue.js";

/**
 * Lock key for the singleton preview lifecycle. The system has ONE
 * preview slot (one port, one ChildProcess, one previewState). Every
 * mutating operation — start, stop, register-reported-url — runs under
 * this single key so two concurrent beats can't race on `previewState`,
 * leak ChildProcesses, or hand the agent a stale URL.
 *
 * Pure reads (`getLocalPreviewState`, `hasReportedPreviewCandidate`,
 * `probePreviewHealth`) are NOT locked — they're allowed to observe
 * a brief inconsistency rather than queue behind a 30-second
 * `startLocalPreview`. The inspector and the live-status endpoint
 * depend on these reads being fast.
 */
const PREVIEW_LOCK_KEY = "local-preview";

/**
 * Build the public-facing base URL for the preview, in priority order:
 *   1. `ARCEUS_PREVIEW_PUBLIC_BASE_URL` if set — fixed URL like
 *      `https://preview.arceus.sh`. Useful when you don't want
 *      per-company subdomains.
 *   2. `<companySlug>.<ARCEUS_PREVIEW_PUBLIC_DOMAIN>` if `publicDomain`
 *      is set and an active company exists. Each company gets its own
 *      vanity subdomain (e.g. `https://quill.arceus.sh`).
 *   3. Fallback: `http://<publicHost>:<port>` — legacy local URL.
 *
 * Async because (2) reads the active company from canonical to derive
 * the slug. The caller must `await` before using the URL.
 */
async function buildPreviewPublicBaseUrl(): Promise<string> {
  if (previewConfig.publicBaseUrl) {
    return previewConfig.publicBaseUrl.replace(/\/$/, "");
  }
  if (previewConfig.publicDomain) {
    const companyId = getActiveCompanyId();
    if (companyId) {
      try {
        const row = await findCompanyById(getDb(), companyId);
        const name = row?.name?.trim();
        if (name) {
          const slug = slugifyCompanyName(name);
          return `https://${slug}.${previewConfig.publicDomain}`;
        }
      } catch {
        // best-effort: fall through to default subdomain on DB error
      }
    }
    return `https://preview.${previewConfig.publicDomain}`;
  }
  return `http://${previewConfig.publicHost}:${previewConfig.port}`;
}

function slugifyCompanyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "preview";
}

type PreviewStatus = "idle" | "starting" | "ready" | "error";
type PreviewTargetKind = "browser" | "service";
type PreviewRuntime = "node" | "python" | "static" | "unknown";
type ValidationStrategy = "entry-url" | "health-url" | "root-url";

interface ReportedPreviewCandidate {
  url: string;
  reportedAt: string;
}

interface LocalPreviewState {
  status: PreviewStatus;
  url: string | null;
  entryUrl: string | null;
  validationUrl: string | null;
  validationStrategy: ValidationStrategy | null;
  targetKind: PreviewTargetKind | null;
  runtime: PreviewRuntime | null;
  framework: string | null;
  command: string | null;
  targetPath: string | null;
  port: number;
  lastError: string | null;
  startedAt: string | null;
}

let previewProcess: ChildProcess | null = null;
let previewStaticServer: Server | null = null;
let reportedPreviewCandidate: ReportedPreviewCandidate | null = null;
const previewState: LocalPreviewState = {
  status: "idle",
  url: null,
  entryUrl: null,
  validationUrl: null,
  validationStrategy: null,
  targetKind: null,
  runtime: null,
  framework: null,
  command: null,
  targetPath: null,
  port: previewConfig.port,
  lastError: null,
  startedAt: null,
};

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface LaunchCommand {
  command: string;
  args: string[];
  kind: "npm-preview" | "npm-start" | "npm-dev" | "static-http" | "python-uvicorn";
  cwd: string;
  targetPath: string;
  entryPath: string | null;
  validationPath: string | null;
  targetKind: PreviewTargetKind;
  runtime: PreviewRuntime;
  framework: string | null;
}

interface CandidatePreference {
  preferredTargetPath?: string | null;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

interface CandidateWorkspace {
  dir: string;
  modifiedAtMs: number;
  depth: number;
}

const ignoredDirectories = new Set(previewConfig.ignoredDirectories);

function detectNodePreviewProfile(parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) {
  const packages = new Set([
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
  ]);

  const browserFrameworks: [string, string][] = [
    ["next", "Next.js"],
    ["vite", "Vite"],
    ["react", "React"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
    ["astro", "Astro"],
  ];
  const serviceFrameworks: [string, string][] = [
    ["fastify", "Fastify"],
    ["express", "Express"],
    ["koa", "Koa"],
    ["@nestjs/core", "NestJS"],
    ["hono", "Hono"],
  ];

  const browser = browserFrameworks.find(([pkg]) => packages.has(pkg));
  const service = serviceFrameworks.find(([pkg]) => packages.has(pkg));

  if (service && !browser) {
    return {
      targetKind: "service" as const,
      runtime: "node" as const,
      framework: service[1],
      entryPath: null,
      validationPath: null,
    };
  }

  return {
    targetKind: "browser" as const,
    runtime: "node" as const,
    framework: browser?.[1] ?? (service?.[1] ? `${service[1]} app` : "Node app"),
    entryPath: null,
    validationPath: null,
  };
}

function scoreCandidatePreference(targetPath: string, preference?: CandidatePreference) {
  const preferred = preference?.preferredTargetPath?.trim().replace(/\\/g, "/").replace(/^\.\//, "") ?? null;
  if (!preferred) {
    return 0;
  }

  if (targetPath === preferred) {
    return previewConfig.exactPathPreferenceScore;
  }

  if (targetPath.startsWith(`${preferred}/`) || preferred.startsWith(`${targetPath}/`)) {
    return previewConfig.relatedPathPreferenceScore;
  }

  return 0;
}

function sortCandidates(candidates: CandidateWorkspace[], rootDir: string, preference?: CandidatePreference) {
  candidates.sort((left, right) => {
    const leftTargetPath = relative(rootDir, left.dir).replace(/\\/g, "/") || ".";
    const rightTargetPath = relative(rootDir, right.dir).replace(/\\/g, "/") || ".";
    const preferenceDelta = scoreCandidatePreference(rightTargetPath, preference) - scoreCandidatePreference(leftTargetPath, preference);

    if (preferenceDelta !== 0) {
      return preferenceDelta;
    }

    if (right.modifiedAtMs !== left.modifiedAtMs) {
      return right.modifiedAtMs - left.modifiedAtMs;
    }

    return left.depth - right.depth;
  });
}

async function detectPythonLaunchCommand(productDir: string, preference?: CandidatePreference): Promise<LaunchCommand | null> {
  const candidates = await collectCandidateWorkspaces(productDir);
  sortCandidates(candidates, productDir, preference);

  for (const candidate of candidates) {
    const requirementsPath = join(candidate.dir, "requirements.txt");
    const pyprojectPath = join(candidate.dir, "pyproject.toml");
    const hasPythonProject = (await exists(requirementsPath)) || (await exists(pyprojectPath));
    if (!hasPythonProject) {
      continue;
    }

    const descriptorPath = (await exists(requirementsPath)) ? requirementsPath : pyprojectPath;
    const descriptor = await readFile(descriptorPath, "utf8").catch(() => "");
    if (!/fastapi|uvicorn/i.test(descriptor)) {
      continue;
    }

    for (const moduleName of ["main", "app"]) {
      if (!(await exists(join(candidate.dir, `${moduleName}.py`)))) {
        continue;
      }

      return {
        command: "python",
        args: ["-m", "uvicorn", `${moduleName}:app`, "--port", String(previewState.port), "--host", previewConfig.host],
        kind: "python-uvicorn",
        cwd: candidate.dir,
        targetPath: relative(productDir, candidate.dir) || ".",
        entryPath: null,
        validationPath: null,
        targetKind: "service",
        runtime: "python",
        framework: "FastAPI",
      };
    }
  }

  return null;
}

async function collectCandidateWorkspaces(rootDir: string, currentDir = rootDir, depth = 0): Promise<CandidateWorkspace[]> {
  if (depth > previewConfig.maxWorkspaceDepth) {
    return [];
  }

  const results: CandidateWorkspace[] = [];
  const packageJsonPath = join(currentDir, "package.json");
  const indexHtmlPath = join(currentDir, "index.html");
  const requirementsPath = join(currentDir, "requirements.txt");
  const pyprojectPath = join(currentDir, "pyproject.toml");

  if (await exists(packageJsonPath) || await exists(indexHtmlPath) || await exists(requirementsPath) || await exists(pyprojectPath)) {
    const info = await stat(currentDir);
    results.push({
      dir: currentDir,
      modifiedAtMs: info.mtimeMs,
      depth,
    });
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }

    results.push(...await collectCandidateWorkspaces(rootDir, join(currentDir, entry.name), depth + 1));
  }

  return results;
}

/** Use bun if available, fall back to npm */
function detectNodeRunner(): string {
  try {
    execSync("bun --version", { stdio: "ignore" });
    return "bun";
  } catch {
    return "npm";
  }
}

async function detectLaunchCommand(productDir: string, preference?: CandidatePreference): Promise<LaunchCommand | null> {
  const candidates = await collectCandidateWorkspaces(productDir);
  sortCandidates(candidates, productDir, preference);

  for (const candidate of candidates) {
    const packageJsonPath = join(candidate.dir, "package.json");
    if (await exists(packageJsonPath)) {
      const raw = await readFile(packageJsonPath, "utf8");
      let parsed: {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        // Malformed package.json (e.g. developer wrote comments) — skip this candidate
        continue;
      }
      const scripts = parsed.scripts ?? {};
      const profile = detectNodePreviewProfile(parsed);

      const runner = detectNodeRunner();
      const npmScriptArgs = ["--", "--port", String(previewState.port), "--host", previewConfig.host];
      const targetPath = relative(productDir, candidate.dir) || ".";

      if (scripts.dev) return { command: runner, args: ["run", "dev", ...npmScriptArgs], kind: "npm-dev", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
      if (scripts.start) return { command: runner, args: ["run", "start", ...npmScriptArgs], kind: "npm-start", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
      if (scripts.preview) return { command: runner, args: ["run", "preview", ...npmScriptArgs], kind: "npm-preview", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
    }

    // Static index.html without a dev server is NOT a valid preview candidate.
    // Only real dev servers (npm dev/start/preview, python uvicorn) qualify.
  }

  return detectPythonLaunchCommand(productDir, preference);
}

/** Return true if any workspace directory has a detectable dev server command. */
export async function hasLocalPreviewCandidate(productDir: string, preferredTargetPath?: string | null) {
  return (await detectLaunchCommand(productDir, { preferredTargetPath })) !== null;
}

async function waitForUrl(url: string, timeoutMs: number) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      /* retry */
    }

    await new Promise((resolve) => setTimeout(resolve, previewConfig.probeIntervalMs));
  }

  return false;
}

function normalizePreviewUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    if (parsed.hostname === "0.0.0.0") {
      parsed.hostname = previewConfig.publicHost;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

async function applyReportedPreviewCandidate(timeoutMs = previewConfig.reportedCandidateTimeoutMs) {
  if (!reportedPreviewCandidate) {
    return null;
  }

  const normalizedUrl = normalizePreviewUrl(reportedPreviewCandidate.url);
  if (!normalizedUrl) {
    return null;
  }

  const ready = await waitForUrl(normalizedUrl, timeoutMs);
  if (!ready) {
    return null;
  }

  const parsed = new URL(normalizedUrl);
  previewState.status = "ready";
  previewState.url = `${parsed.protocol}//${parsed.host}`;
  previewState.entryUrl = normalizedUrl;
  previewState.validationUrl = normalizedUrl;
  previewState.validationStrategy = "entry-url";
  previewState.targetKind = parsed.pathname && parsed.pathname !== "/" ? "browser" : "service";
  previewState.runtime = "unknown";
  previewState.framework = "Agent-reported preview";
  previewState.command = "developer-reported-preview";
  previewState.targetPath = "agent-reported";
  previewState.lastError = null;
  previewState.startedAt = reportedPreviewCandidate.reportedAt;
  return previewState;
}

/** Return true if an agent has reported a preview URL that hasn't been cleared. */
export function hasReportedPreviewCandidate() {
  return reportedPreviewCandidate !== null;
}


async function registerReportedPreviewUrlUnlocked(url: string) {
  const normalizedUrl = normalizePreviewUrl(url);
  if (!normalizedUrl) {
    return false;
  }

  if (reportedPreviewCandidate?.url === normalizedUrl && previewState.validationUrl === normalizedUrl && previewState.status === "ready") {
    return true;
  }

  reportedPreviewCandidate = {
    url: normalizedUrl,
    reportedAt: new Date().toISOString(),
  };

  // Calling the unlocked version because we already hold the lock —
  // re-entering withKeyedLock under the same key would deadlock.
  await stopLocalPreviewUnlocked();
  const applied = await applyReportedPreviewCandidate();
  return Boolean(applied);
}

/** Register an agent-reported preview URL, stopping any existing preview first. */
export async function registerReportedPreviewUrl(url: string) {
  return withKeyedLock(PREVIEW_LOCK_KEY, () => registerReportedPreviewUrlUnlocked(url));
}

/** Return the current preview state (status, URLs, runtime info). */
export function getLocalPreviewState() {
  return previewState;
}

/**
 * Probe the preview URL with a real HTTP request.
 * Returns { reachable, statusCode, error } — never throws.
 */
export async function probePreviewHealth(timeoutMs = 5000): Promise<{
  reachable: boolean;
  statusCode: number | null;
  error: string | null;
  contentLength: number | null;
  hasProductContent: boolean;
  bodySnippet: string | null;
}> {
  const url = previewState.validationUrl ?? previewState.entryUrl ?? previewState.url;
  if (!url || previewState.status !== "ready") {
    return { reachable: false, statusCode: null, error: previewState.status === "idle" ? "Preview not started" : (previewState.lastError ?? `Preview status: ${previewState.status}`), contentLength: null, hasProductContent: false, bodySnippet: null };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    const res = await fetch(url, { method: "GET", signal: controller.signal, headers: { "Accept": "text/html,*/*" } });
    clearTimeout(timer);

    if (!res.ok) {
      return { reachable: false, statusCode: res.status, error: `HTTP ${res.status}`, contentLength: null, hasProductContent: false, bodySnippet: null };
    }

    // Read the response body and check for actual content
    const body = await res.text();
    const contentLength = body.length;

    // Check if the page has any meaningful product-specific content
    // beyond bare scaffold markers. A Vite scaffold has a generic <div id="root"></div>
    // and default content like "Vite + React" or just "App".
    const scaffoldPatterns = [
      /^\s*<div id="(root|app)"><\/div>\s*$/m,       // empty root div
      /Vite \+ React/i,                                // default Vite scaffold
      /Hello Vite/i,                                   // another scaffold default
    ];
    const bodyText = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const isBareBones = bodyText.length < 50 || scaffoldPatterns.some((p) => p.test(body));
    // SPAs render via JS, so check if the HTML at least loads JS bundles that reference product modules
    const hasJsBundles = /src=["'][^"']*\.(js|ts|jsx|tsx)/i.test(body);
    // For SPAs, having JS bundles is acceptable even if the HTML body is empty
    const hasProductContent = !isBareBones || hasJsBundles;

    return {
      reachable: true,
      statusCode: res.status,
      error: null,
      contentLength,
      hasProductContent,
      bodySnippet: bodyText.slice(0, 500) || null,
    };
  } catch (err) {
    return { reachable: false, statusCode: null, error: err instanceof Error ? err.message : String(err), contentLength: null, hasProductContent: false, bodySnippet: null };
  }
}

async function terminatePreviewProcessTree(childProcess: ChildProcess) {
  const processId = childProcess.pid;
  if (!processId) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { resolve(); }, 5000);
      const killer = spawn("taskkill", ["/PID", String(processId), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });

      killer.once("exit", () => { clearTimeout(timeout); resolve(); });
      killer.once("error", () => { clearTimeout(timeout); resolve(); });
    });
    return;
  }

  childProcess.kill("SIGTERM");
}

async function stopLocalPreviewUnlocked() {
  if (previewProcess) {
    await terminatePreviewProcessTree(previewProcess);
    previewProcess = null;
  }

  if (previewStaticServer) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { resolve(); }, 3000);
      previewStaticServer?.close((error) => {
        clearTimeout(timeout);
        resolve();
      });
    });
    previewStaticServer = null;
  }

  previewState.status = "idle";
  previewState.url = null;
  previewState.entryUrl = null;
  previewState.validationUrl = null;
  previewState.validationStrategy = null;
  previewState.targetKind = null;
  previewState.runtime = null;
  previewState.framework = null;
  previewState.command = null;
  previewState.targetPath = null;
  previewState.lastError = null;
  previewState.startedAt = null;
}

/** Terminate the preview process/server and reset all preview state to idle. */
export async function stopLocalPreview() {
  return withKeyedLock(PREVIEW_LOCK_KEY, () => stopLocalPreviewUnlocked());
}

async function startStaticPreviewServer(rootDir: string) {
  // Node's createServer expects a sync handler; wrap the async body so
  // floating-promise lint stays satisfied. Errors land in the inner catch.
  const server = createServer((request, response) => { void (async () => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? previewConfig.publicHost}`);
      const requestPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const relativePath = normalize(requestPath).replace(/^([\\/])+/, "");
      const filePath = join(rootDir, relativePath);

      if (!filePath.startsWith(rootDir)) {
        response.statusCode = 403;
        response.end("Forbidden");
        return;
      }

      const file = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream");
      response.end(file);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  })(); });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(previewState.port, previewConfig.host, () => { resolve(); });
  });

  previewStaticServer = server;
}

/**
 * Detect and launch a local preview server for the product workspace.
 * Tries agent-reported URLs first, then auto-detects Node/Python dev servers.
 *
 * Public entry: locked under PREVIEW_LOCK_KEY so two concurrent beats
 * calling workspace_start_preview can't race on previewState or leak
 * ChildProcesses. The body lives in `startLocalPreviewUnlocked` so the
 * lock-held internal call to `stopLocalPreviewUnlocked` doesn't deadlock.
 */
export async function startLocalPreview(productDir: string, preferredTargetPath?: string | null) {
  return withKeyedLock(PREVIEW_LOCK_KEY, () => startLocalPreviewUnlocked(productDir, preferredTargetPath));
}

async function startLocalPreviewUnlocked(productDir: string, preferredTargetPath?: string | null) {
  await stopLocalPreviewUnlocked();

  const reportedPreview = await applyReportedPreviewCandidate();
  if (reportedPreview) {
    return reportedPreview;
  }

  const launch = await detectLaunchCommand(productDir, { preferredTargetPath });
  if (!launch) {
    previewState.status = "error";
    previewState.lastError = "No preview command detected in workspace.";
    return previewState;
  }

  // Install dependencies if node_modules is missing (Node projects only)
  if (launch.runtime === "node" && !existsSync(join(launch.cwd, "node_modules"))) {
    const runner = detectNodeRunner();
    try {
      execSync(`${runner} install`, { cwd: launch.cwd, stdio: "pipe", timeout: previewConfig.installTimeoutMs });
    } catch (err) {
      previewState.status = "error";
      previewState.lastError = `Dependency installation failed: ${err instanceof Error ? err.message : String(err)}`;
      return previewState;
    }
  }

  previewState.status = "starting";
  previewState.command = `${launch.command} ${launch.args.join(" ")} [cwd=${launch.targetPath}]`;
  previewState.targetPath = launch.targetPath;
  previewState.startedAt = new Date().toISOString();
  previewState.lastError = null;
  previewState.targetKind = launch.targetKind;
  previewState.runtime = launch.runtime;
  previewState.framework = launch.framework;
  // Public-facing URL (vanity subdomain or fixed override) when
  // configured; falls back to the legacy local URL otherwise. The
  // proxy hook in routes/preview-proxy.ts forwards public-subdomain
  // traffic to this same preview server's local port.
  const publicBaseUrl = await buildPreviewPublicBaseUrl();
  // Keep an internal local URL for backend health probes — going
  // through the public URL would round-trip via Railway's edge and
  // depends on external DNS/cert state we don't always control here.
  const localProbeBaseUrl = `http://${previewConfig.host}:${previewState.port}`;
  const localProbePath = launch.validationPath
    ? `/${launch.validationPath}`
    : launch.entryPath
      ? `/${launch.entryPath}`
      : "";
  const localProbeUrl = `${localProbeBaseUrl}${localProbePath}`;

  previewState.url = publicBaseUrl;
  previewState.entryUrl = launch.targetKind === "browser"
    ? (launch.entryPath ? `${publicBaseUrl}/${launch.entryPath}` : publicBaseUrl)
    : null;
  previewState.validationUrl = launch.validationPath
    ? `${publicBaseUrl}/${launch.validationPath}`
    : (previewState.entryUrl ?? publicBaseUrl);
  previewState.validationStrategy = launch.validationPath === "health"
    ? "health-url"
    : launch.entryPath
      ? "entry-url"
      : "root-url";

  // Kill any stale process occupying the preview port before launching
  try {
    const pids = execSync(`lsof -ti:${previewState.port}`, { encoding: "utf8" }).trim();
    if (pids) {
      for (const pid of pids.split("\n")) {
        try { process.kill(Number(pid), "SIGTERM"); } catch { /* already dead */ }
      }
    }
  } catch { /* no process on port — good */ }

  previewProcess = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    shell: true,
    env: {
      ...process.env,
      PORT: String(previewState.port),
      HOST: previewConfig.host,
      BROWSER: "none",
    },
  });

  previewProcess.on("exit", (code) => {
    if (previewState.status !== "ready") {
      previewState.status = "error";
      previewState.lastError = `Preview process exited with code ${code ?? "null"}`;
    }
  });

  // Probe LOCAL URL for readiness (not public) — public URL depends on
  // an external proxy/cert chain that may not be ready yet, but the
  // local preview server is always direct-addressable.
  let ready = await waitForUrl(localProbeUrl, previewConfig.launchTimeoutMs);

  // Fallback: Vite may bind to "localhost" but not "127.0.0.1" (or vice versa)
  if (!ready) {
    const fallbackProbe = localProbeUrl.includes("127.0.0.1")
      ? localProbeUrl.replace("127.0.0.1", "localhost")
      : localProbeUrl.replace("localhost", "127.0.0.1");
    ready = await waitForUrl(fallbackProbe, 5000);
  }

  if (!ready) {
    previewState.status = "error";
    previewState.lastError = `Preview not reachable at ${localProbeUrl} after ${previewConfig.launchTimeoutMs}ms. Launch: ${previewState.command}. Check if package.json exists at cwd and 'dev' script starts on port ${previewState.port}.`;
    return previewState;
  }

  previewState.status = "ready";
  return previewState;
}