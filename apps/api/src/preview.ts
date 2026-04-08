import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, extname, join, normalize, relative } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { previewConfig } from "./config/index";

type PreviewStatus = "idle" | "starting" | "ready" | "error";
type PreviewTargetKind = "browser" | "service";
type PreviewRuntime = "node" | "python" | "static" | "unknown";
type ValidationStrategy = "entry-url" | "health-url" | "root-url";

type ReportedPreviewCandidate = {
  url: string;
  reportedAt: string;
};

export type LocalPreviewState = {
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
};

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

type LaunchCommand = {
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
};

type CandidatePreference = {
  preferredTargetPath?: string | null;
};

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

type CandidateWorkspace = {
  dir: string;
  modifiedAtMs: number;
  depth: number;
};

const ignoredDirectories = new Set(previewConfig.ignoredDirectories);

function detectNodePreviewProfile(parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) {
  const packages = new Set([
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
  ]);

  const browserFrameworks: Array<[string, string]> = [
    ["next", "Next.js"],
    ["vite", "Vite"],
    ["react", "React"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
    ["astro", "Astro"],
  ];
  const serviceFrameworks: Array<[string, string]> = [
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
        parsed = JSON.parse(raw);
      } catch {
        // Malformed package.json (e.g. developer wrote comments) — skip this candidate
        continue;
      }
      const scripts = parsed.scripts ?? {};
      const profile = detectNodePreviewProfile(parsed);

      const npmScriptArgs = ["--", "--port", String(previewState.port), "--host", previewConfig.host];
      const targetPath = relative(productDir, candidate.dir) || ".";

      if (scripts.dev) return { command: "npm", args: ["run", "dev", ...npmScriptArgs], kind: "npm-dev", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
      if (scripts.start) return { command: "npm", args: ["run", "start", ...npmScriptArgs], kind: "npm-start", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
      if (scripts.preview) return { command: "npm", args: ["run", "preview", ...npmScriptArgs], kind: "npm-preview", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
    }

    const indexHtmlPath = join(candidate.dir, "index.html");
    if (await exists(indexHtmlPath)) {
      return {
        command: "internal-static-server",
        args: [],
        kind: "static-http",
        cwd: candidate.dir,
        targetPath: relative(productDir, candidate.dir) || basename(candidate.dir),
        entryPath: "index.html",
        validationPath: "index.html",
        targetKind: "browser",
        runtime: "static",
        framework: "Static HTML",
      };
    }
  }

  return detectPythonLaunchCommand(productDir, preference);
}

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

export function hasReportedPreviewCandidate() {
  return reportedPreviewCandidate !== null;
}

export function clearReportedPreviewCandidate() {
  reportedPreviewCandidate = null;
}

export async function registerReportedPreviewUrl(url: string) {
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

  await stopLocalPreview();
  const applied = await applyReportedPreviewCandidate();
  return Boolean(applied);
}

export function getLocalPreviewState() {
  return previewState;
}

async function terminatePreviewProcessTree(childProcess: ChildProcess) {
  const processId = childProcess.pid;
  if (!processId) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
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

export async function stopLocalPreview() {
  if (previewProcess) {
    await terminatePreviewProcessTree(previewProcess);
    previewProcess = null;
  }

  if (previewStaticServer) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 3000);
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

async function startStaticPreviewServer(rootDir: string) {
  const server = createServer(async (request, response) => {
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
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(previewState.port, previewConfig.host, () => resolve());
  });

  previewStaticServer = server;
}

export async function startLocalPreview(productDir: string, preferredTargetPath?: string | null) {
  await stopLocalPreview();

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

  previewState.status = "starting";
  previewState.command = `${launch.command} ${launch.args.join(" ")} [cwd=${launch.targetPath}]`;
  previewState.targetPath = launch.targetPath;
  previewState.startedAt = new Date().toISOString();
  previewState.lastError = null;
  previewState.targetKind = launch.targetKind;
  previewState.runtime = launch.runtime;
  previewState.framework = launch.framework;
  previewState.url = `http://${previewConfig.publicHost}:${previewState.port}`;
  previewState.entryUrl = launch.targetKind === "browser"
    ? (launch.entryPath ? `${previewState.url}/${launch.entryPath}` : previewState.url)
    : null;
  previewState.validationUrl = launch.validationPath
    ? `${previewState.url}/${launch.validationPath}`
    : (previewState.entryUrl ?? previewState.url);
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

  if (launch.kind === "static-http") {
    await startStaticPreviewServer(launch.cwd);
  } else {
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
        previewState.lastError = `Preview process exited with code ${code}`;
      }
    });
  }

  const primaryUrl = previewState.validationUrl ?? previewState.entryUrl ?? previewState.url;
  let ready = await waitForUrl(primaryUrl, previewConfig.launchTimeoutMs);

  // Fallback: Vite may bind to "localhost" but not "127.0.0.1" (or vice versa)
  if (!ready && primaryUrl) {
    const fallbackUrl = primaryUrl.includes("127.0.0.1")
      ? primaryUrl.replace("127.0.0.1", "localhost")
      : primaryUrl.replace("localhost", "127.0.0.1");
    ready = await waitForUrl(fallbackUrl, 5000);
    if (ready) {
      previewState.url = previewState.url?.replace(
        primaryUrl.includes("127.0.0.1") ? "127.0.0.1" : "localhost",
        primaryUrl.includes("127.0.0.1") ? "localhost" : "127.0.0.1",
      );
      previewState.validationUrl = fallbackUrl;
    }
  }

  if (!ready) {
    previewState.status = "error";
    previewState.lastError = `Preview not reachable at ${primaryUrl} after ${previewConfig.launchTimeoutMs}ms. Launch: ${previewState.command}. Check if package.json exists at cwd and 'dev' script starts on port ${previewState.port}.`;
    return previewState;
  }

  previewState.status = "ready";
  return previewState;
}