import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, extname, join, normalize, relative } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { previewConfig } from "../config/index.js";
import { getDb } from "@arceus/db";
import { findCompanyById } from "@arceus/db/src/repos/companies.js";
import { withKeyedLock } from "./async-queue.js";

/**
 * Per-tenant preview engine.
 *
 * Each company owns its own preview slot: state object, child process,
 * static-server handle, agent-reported candidate, and an allocated port
 * from `previewConfig.portMin..portMax`. Two users running their
 * products no longer fight over a single host port — they sit on
 * different ports simultaneously, and the proxy in `preview-proxy.ts`
 * routes `<slug>.<publicDomain>` to the right slot via the slug→port
 * registry populated when each preview starts.
 *
 * Public API takes an optional `companyId`. Native multi-tenant: there is no
 * global active-company fallback — when omitted, the operation no-ops / returns
 * idle state. Every flow threads `companyId` explicitly from its own context.
 *
 * Locking is also per-company. Mutating operations on a slot
 * (`start`, `stop`, `registerReportedUrl`) serialise behind
 * `local-preview:${companyId}` so concurrent beats for the same
 * tenant can't race on the slot's process or state. Pure reads
 * (`getLocalPreviewState`, `hasReportedPreviewCandidate`,
 * `probePreviewHealth`) are NOT locked — they're allowed to observe
 * a brief inconsistency rather than queue behind a 30s start.
 */
const previewLockKey = (companyId: string): string => `local-preview:${companyId}`;

/**
 * Resolve the companyId from the explicit caller argument. Native multi-tenant:
 * there is no global active-company fallback — when no companyId is supplied the
 * caller treats null as idle/no-op (every call site already guards for it).
 */
function resolveCompanyId(explicit: string | null | undefined): string | null {
  return explicit ?? null;
}

/**
 * Build the public-facing base URL for the preview, in priority order:
 *   1. `ARCEUS_PREVIEW_PUBLIC_BASE_URL` if set — fixed URL like
 *      `https://preview.arceus.sh`. Useful when you don't want
 *      per-company subdomains.
 *   2. `<companySlug>.<ARCEUS_PREVIEW_PUBLIC_DOMAIN>` if `publicDomain`
 *      is set and the company exists in canonical. Each company gets
 *      its own vanity subdomain (e.g. `https://quill.arceus.sh`).
 *   3. Fallback: `http://<publicHost>:<port>` — legacy local URL,
 *      now using the company's allocated per-tenant port.
 */
async function buildPreviewPublicBaseUrl(companyId: string, slot: PreviewSlot): Promise<string> {
  if (previewConfig.publicBaseUrl) {
    return previewConfig.publicBaseUrl.replace(/\/$/, "");
  }
  if (previewConfig.publicDomain) {
    try {
      const row = await findCompanyById(getDb(), companyId);
      const name = row?.name?.trim();
      if (name) {
        const slug = slugifyCompanyName(name);
        // Cache slug → companyId so the proxy can resolve incoming
        // requests for `<slug>.<domain>` back to a port without a
        // round-trip to canonical on every request.
        slugToCompanyId.set(slug, companyId);
        return `https://${slug}.${previewConfig.publicDomain}`;
      }
    } catch {
      // best-effort: fall through to default subdomain on DB error
    }
    return `https://preview.${previewConfig.publicDomain}`;
  }
  return `http://${previewConfig.publicHost}:${slot.state.port}`;
}

/**
 * Slugify a company name to the SHORT brand form for the vanity
 * subdomain.
 *
 * CEO strategies are verbose descriptors — "AquaGrid B2B Marketplace
 * for Water Bottle Brands" is a legitimate strategy_title that we
 * adopt as `companies.name` for display (see applyStrategyTx). But
 * the slug only needs the brand, not the descriptor — visitors don't
 * want `aquagrid-b2b-marketplace-for-water-bottle-brands.arceus.sh`,
 * they want `aquagrid-b2b.arceus.sh`.
 *
 * Heuristic: lowercase, split on non-alphanumeric, take the first 2
 * tokens (covers common shapes like "AquaGrid B2B", "Acme Corp",
 * "Notion Clone", and degenerate single-word cases). Two tokens
 * preserves enough context to disambiguate sibling brands ("Acme
 * Marketplace" vs "Acme Studio") without leaking the whole pitch.
 */
function slugifyCompanyName(name: string): string {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return "preview";
  return tokens.slice(0, 2).join("-");
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

interface PreviewSlot {
  companyId: string;
  state: LocalPreviewState;
  process: ChildProcess | null;
  staticServer: Server | null;
  reportedCandidate: ReportedPreviewCandidate | null;
}

// ── Per-tenant registries ────────────────────────────────────

const slotsByCompany = new Map<string, PreviewSlot>();
const portsByCompany = new Map<string, number>();

/**
 * Slug → companyId index built up by `startLocalPreview` / public URL
 * construction. Exported for the preview proxy so it can resolve
 * `<slug>.<domain>` to a slot's port without re-doing the DB lookup
 * on every incoming request.
 */
const slugToCompanyId = new Map<string, string>();

/** Stable, non-cryptographic hash used to seed port allocation. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Allocate (or look up) the port assigned to this company. Stable for
 * the process lifetime — the same company always gets the same port
 * until restart. Uses hash-seeded linear probing so two companies
 * whose ids happen to collide on hash still find free slots.
 */
function allocatePort(companyId: string): number {
  const existing = portsByCompany.get(companyId);
  if (existing !== undefined) return existing;

  const min = previewConfig.portMin;
  const max = previewConfig.portMax;
  if (min > max) {
    throw new Error(`Invalid preview port range: ${min}..${max}`);
  }
  const range = max - min + 1;
  const taken = new Set(portsByCompany.values());
  let candidate = min + (hashString(companyId) % range);
  for (let i = 0; i < range; i++) {
    if (!taken.has(candidate)) {
      portsByCompany.set(companyId, candidate);
      return candidate;
    }
    candidate = min + ((candidate - min + 1) % range);
  }
  throw new Error(
    `Preview port pool exhausted: ${portsByCompany.size} companies, range ${min}..${max}. ` +
    `Widen ARCEUS_PREVIEW_PORT_MIN/MAX or release dead slots.`,
  );
}

function createIdleState(port: number): LocalPreviewState {
  return {
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
    port,
    lastError: null,
    startedAt: null,
  };
}

function resetSlotState(slot: PreviewSlot) {
  slot.state.status = "idle";
  slot.state.url = null;
  slot.state.entryUrl = null;
  slot.state.validationUrl = null;
  slot.state.validationStrategy = null;
  slot.state.targetKind = null;
  slot.state.runtime = null;
  slot.state.framework = null;
  slot.state.command = null;
  slot.state.targetPath = null;
  slot.state.lastError = null;
  slot.state.startedAt = null;
  // port stays — allocation is stable across stop/start
}

function getOrCreateSlot(companyId: string): PreviewSlot {
  let slot = slotsByCompany.get(companyId);
  if (!slot) {
    const port = allocatePort(companyId);
    slot = {
      companyId,
      state: createIdleState(port),
      process: null,
      staticServer: null,
      reportedCandidate: null,
    };
    slotsByCompany.set(companyId, slot);
  }
  return slot;
}

/**
 * Read-only synthetic idle state used when no companyId can be
 * resolved (e.g. unauthenticated read before any company exists).
 * Distinct object per call so callers can't accidentally mutate the
 * frozen baseline.
 */
function syntheticIdleState(): LocalPreviewState {
  return createIdleState(previewConfig.portMin);
}

// ── Helpers ──────────────────────────────────────────────────

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

async function detectPythonLaunchCommand(productDir: string, port: number, preference?: CandidatePreference): Promise<LaunchCommand | null> {
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
        args: ["-m", "uvicorn", `${moduleName}:app`, "--port", String(port), "--host", previewConfig.host],
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

async function detectLaunchCommand(productDir: string, port: number, preference?: CandidatePreference): Promise<LaunchCommand | null> {
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
      const npmScriptArgs = ["--", "--port", String(port), "--host", previewConfig.host];
      const targetPath = relative(productDir, candidate.dir) || ".";

      if (scripts.dev) return { command: runner, args: ["run", "dev", ...npmScriptArgs], kind: "npm-dev", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
      if (scripts.start) return { command: runner, args: ["run", "start", ...npmScriptArgs], kind: "npm-start", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
      if (scripts.preview) return { command: runner, args: ["run", "preview", ...npmScriptArgs], kind: "npm-preview", cwd: candidate.dir, targetPath, entryPath: profile.entryPath, validationPath: profile.validationPath, targetKind: profile.targetKind, runtime: profile.runtime, framework: profile.framework };
    }

    // Static index.html without a dev server is NOT a valid preview candidate.
    // Only real dev servers (npm dev/start/preview, python uvicorn) qualify.
  }

  return detectPythonLaunchCommand(productDir, port, preference);
}

/** Return true if any workspace directory has a detectable dev server command. */
export async function hasLocalPreviewCandidate(productDir: string, preferredTargetPath?: string | null) {
  // Detection is read-only and doesn't depend on the slot — use any
  // port (portMin) just to satisfy the command builder. The actual
  // port at launch time is the slot's allocated port.
  return (await detectLaunchCommand(productDir, previewConfig.portMin, { preferredTargetPath })) !== null;
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

async function applyReportedPreviewCandidate(slot: PreviewSlot, timeoutMs = previewConfig.reportedCandidateTimeoutMs) {
  if (!slot.reportedCandidate) {
    return null;
  }

  const normalizedUrl = normalizePreviewUrl(slot.reportedCandidate.url);
  if (!normalizedUrl) {
    return null;
  }

  const ready = await waitForUrl(normalizedUrl, timeoutMs);
  if (!ready) {
    return null;
  }

  const parsed = new URL(normalizedUrl);
  slot.state.status = "ready";
  slot.state.url = `${parsed.protocol}//${parsed.host}`;
  slot.state.entryUrl = normalizedUrl;
  slot.state.validationUrl = normalizedUrl;
  slot.state.validationStrategy = "entry-url";
  slot.state.targetKind = parsed.pathname && parsed.pathname !== "/" ? "browser" : "service";
  slot.state.runtime = "unknown";
  slot.state.framework = "Agent-reported preview";
  slot.state.command = "developer-reported-preview";
  slot.state.targetPath = "agent-reported";
  slot.state.lastError = null;
  slot.state.startedAt = slot.reportedCandidate.reportedAt;
  return slot.state;
}

/** Return true if an agent has reported a preview URL for this company that hasn't been cleared. */
export function hasReportedPreviewCandidate(companyId?: string | null): boolean {
  const id = resolveCompanyId(companyId);
  if (!id) return false;
  return slotsByCompany.get(id)?.reportedCandidate !== null && slotsByCompany.get(id)?.reportedCandidate !== undefined;
}

async function registerReportedPreviewUrlUnlocked(slot: PreviewSlot, url: string) {
  const normalizedUrl = normalizePreviewUrl(url);
  if (!normalizedUrl) {
    return false;
  }

  if (slot.reportedCandidate?.url === normalizedUrl && slot.state.validationUrl === normalizedUrl && slot.state.status === "ready") {
    return true;
  }

  slot.reportedCandidate = {
    url: normalizedUrl,
    reportedAt: new Date().toISOString(),
  };

  // Calling the unlocked version because we already hold the lock —
  // re-entering withKeyedLock under the same key would deadlock.
  await stopLocalPreviewUnlocked(slot);
  const applied = await applyReportedPreviewCandidate(slot);
  return Boolean(applied);
}

/** Register an agent-reported preview URL, stopping any existing preview first. */
export async function registerReportedPreviewUrl(url: string, companyId?: string | null) {
  const id = resolveCompanyId(companyId);
  if (!id) return false;
  const slot = getOrCreateSlot(id);
  return withKeyedLock(previewLockKey(id), () => registerReportedPreviewUrlUnlocked(slot, url));
}

/** Return the current preview state (status, URLs, runtime info) for a company. */
export function getLocalPreviewState(companyId?: string | null): LocalPreviewState {
  const id = resolveCompanyId(companyId);
  if (!id) return syntheticIdleState();
  return getOrCreateSlot(id).state;
}

/**
 * Probe the preview URL with a real HTTP request.
 * Returns { reachable, statusCode, error } — never throws.
 */
export async function probePreviewHealth(timeoutMsOrCompanyId?: number | string | null, maybeTimeoutMs?: number): Promise<{
  reachable: boolean;
  statusCode: number | null;
  error: string | null;
  contentLength: number | null;
  hasProductContent: boolean;
  bodySnippet: string | null;
}> {
  // Backward-compat signature: legacy callers pass `(timeoutMs?: number)`.
  // Multi-tenant callers pass `(companyId: string, timeoutMs?: number)`.
  // Disambiguate by argument types so we don't have to break the API.
  let companyId: string | null;
  let timeoutMs: number;
  if (typeof timeoutMsOrCompanyId === "string") {
    companyId = timeoutMsOrCompanyId;
    timeoutMs = maybeTimeoutMs ?? 5000;
  } else {
    companyId = null;
    timeoutMs = (typeof timeoutMsOrCompanyId === "number" ? timeoutMsOrCompanyId : null) ?? 5000;
  }
  const id = resolveCompanyId(companyId);
  const state = id ? getOrCreateSlot(id).state : syntheticIdleState();

  const url = state.validationUrl ?? state.entryUrl ?? state.url;
  if (!url || state.status !== "ready") {
    return {
      reachable: false,
      statusCode: null,
      error: state.status === "idle" ? "Preview not started" : (state.lastError ?? `Preview status: ${state.status}`),
      contentLength: null,
      hasProductContent: false,
      bodySnippet: null,
    };
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

async function stopLocalPreviewUnlocked(slot: PreviewSlot) {
  if (slot.process) {
    await terminatePreviewProcessTree(slot.process);
    slot.process = null;
  }

  if (slot.staticServer) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { resolve(); }, 3000);
      slot.staticServer?.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    slot.staticServer = null;
  }

  resetSlotState(slot);
}

/** Terminate the preview process/server and reset preview state to idle. */
export async function stopLocalPreview(companyId?: string | null) {
  const id = resolveCompanyId(companyId);
  if (!id) return;
  const slot = getOrCreateSlot(id);
  return withKeyedLock(previewLockKey(id), () => stopLocalPreviewUnlocked(slot));
}

async function startStaticPreviewServer(slot: PreviewSlot, rootDir: string) {
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
    server.listen(slot.state.port, previewConfig.host, () => { resolve(); });
  });

  slot.staticServer = server;
}

/**
 * Detect and launch a local preview server for the product workspace.
 * Tries agent-reported URLs first, then auto-detects Node/Python dev servers.
 *
 * Public entry: locked under per-company key so two concurrent beats
 * for the same tenant calling workspace_start_preview can't race on
 * the slot's state or leak ChildProcesses. The body lives in
 * `startLocalPreviewUnlocked` so the lock-held internal call to
 * `stopLocalPreviewUnlocked` doesn't deadlock.
 */
export async function startLocalPreview(productDir: string, preferredTargetPath?: string | null, companyId?: string | null) {
  const id = resolveCompanyId(companyId);
  if (!id) {
    return syntheticIdleState();
  }
  const slot = getOrCreateSlot(id);
  return withKeyedLock(previewLockKey(id), () => startLocalPreviewUnlocked(slot, productDir, preferredTargetPath));
}

/**
 * Env keys that must NEVER reach a product's server tier. The full-stack
 * scaffold runs agent-authored server code (server/*.ts) in this process'
 * child, with access to `process.env`. Arceus's OWN secrets (Azure key, DB
 * URL, admin token, etc.) live there — passing them through would let any
 * product read them directly, defeating the AI-gateway guarantee that "the
 * key never leaves the server". We default-keep the toolchain vars npm/vite
 * need (PATH, HOME, NODE_*, npm_*, …) and strip anything that looks secret.
 */
const SENSITIVE_ENV_KEY = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|POSTGRES|PGPASS|AZURE|OPENAI|ANTHROPIC|SUPABASE|RAILWAY)/i;

/**
 * Build the environment for a product's install / dev-server process:
 * process.env minus Arceus secrets, plus the explicit `extra` vars. This is
 * also the seam for per-company server-side secret injection — add allowed,
 * company-scoped vars to `extra`.
 */
function buildProductEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_KEY.test(key)) continue;
    safe[key] = value;
  }
  return { ...safe, ...extra };
}

async function startLocalPreviewUnlocked(slot: PreviewSlot, productDir: string, preferredTargetPath?: string | null) {
  await stopLocalPreviewUnlocked(slot);

  const reportedPreview = await applyReportedPreviewCandidate(slot);
  if (reportedPreview) {
    return reportedPreview;
  }

  const launch = await detectLaunchCommand(productDir, slot.state.port, { preferredTargetPath });
  if (!launch) {
    slot.state.status = "error";
    slot.state.lastError = "No preview command detected in workspace.";
    return slot.state;
  }

  // Install dependencies if node_modules is missing (Node projects only).
  //
  // CRITICAL: force NODE_ENV=development for the install. Railway sets
  // NODE_ENV=production container-wide, which causes `npm install` to
  // silently strip ALL devDependencies — including `vite`, `tsc`,
  // `tailwindcss`, `@vitejs/plugin-react`, `postcss`, `autoprefixer`.
  // node_modules ends up populated (130+ deps shaved off), the launch
  // step then can't find `./node_modules/.bin/vite`, and the preview
  // proxy returns ECONNREFUSED to the user because no Vite server
  // ever bound to the allocated port.
  //
  // This is a different code path from the developer's `bash(npm
  // install)` — that one goes through the OpenCode plugin's tenant
  // subshell wrapper (which forces NODE_ENV=development too). This
  // execSync runs in the API process, so the plugin's env override
  // doesn't apply here; we have to set it explicitly.
  //
  // Also pass `--include=dev` for npm so a future
  // ".npmrc production=true" anywhere up the tree can't re-strip them.
  // bun ignores NODE_ENV for install purposes by default; the env
  // still applies so devDeps land regardless of runner.
  if (launch.runtime === "node" && !existsSync(join(launch.cwd, "node_modules"))) {
    const runner = detectNodeRunner();
    const installArgs = runner === "npm" ? "install --include=dev" : "install";
    try {
      execSync(`${runner} ${installArgs}`, {
        cwd: launch.cwd,
        stdio: "pipe",
        timeout: previewConfig.installTimeoutMs,
        env: buildProductEnv({ NODE_ENV: "development" }),
      });
    } catch (err) {
      slot.state.status = "error";
      slot.state.lastError = `Dependency installation failed: ${err instanceof Error ? err.message : String(err)}`;
      return slot.state;
    }
  }

  // Pre-build Vite's dependency-optimize cache BEFORE serving. Vite normally
  // optimizes deps lazily on the first request, but under container load that
  // startup optimize can be interrupted/killed — leaving `node_modules/.vite`
  // absent. Then EVERY `/node_modules/.vite/deps/*` request returns Vite's
  // instant 504 ("deps not optimized") and the product renders a BLANK page
  // (observed live 2026-06-13). Running `vite optimize` to completion here
  // guarantees the cache exists, so dep requests serve 200 immediately. Only
  // when the cache is missing (cheap no-op otherwise); best-effort — the dev
  // server still lazily optimizes if this fails.
  if (
    launch.runtime === "node" &&
    launch.framework === "Vite" &&
    !existsSync(join(launch.cwd, "node_modules", ".vite", "deps"))
  ) {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    // node:sqlite needs --experimental-sqlite on Node <24 (the scaffold's
    // server entry imports it, and vite loads the config/entry graph).
    const optimizeEnv = buildProductEnv(
      nodeMajor < 24
        ? { NODE_ENV: "development", NODE_OPTIONS: "--experimental-sqlite" }
        : { NODE_ENV: "development" },
    );
    try {
      execSync("npx vite optimize", {
        cwd: launch.cwd,
        stdio: "pipe",
        timeout: previewConfig.installTimeoutMs,
        env: optimizeEnv,
      });
    } catch (err) {
      console.warn(
        `[preview] vite optimize pre-build failed for ${slot.companyId} (non-fatal, dev server will lazy-optimize): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  slot.state.status = "starting";
  slot.state.command = `${launch.command} ${launch.args.join(" ")} [cwd=${launch.targetPath}]`;
  slot.state.targetPath = launch.targetPath;
  slot.state.startedAt = new Date().toISOString();
  slot.state.lastError = null;
  slot.state.targetKind = launch.targetKind;
  slot.state.runtime = launch.runtime;
  slot.state.framework = launch.framework;
  // Public-facing URL (vanity subdomain or fixed override) when
  // configured; falls back to the legacy local URL otherwise. The
  // proxy hook in routes/preview-proxy.ts forwards public-subdomain
  // traffic to this same preview server's local port.
  const publicBaseUrl = await buildPreviewPublicBaseUrl(slot.companyId, slot);
  // Keep an internal local URL for backend health probes — going
  // through the public URL would round-trip via Railway's edge and
  // depends on external DNS/cert state we don't always control here.
  const localProbeBaseUrl = `http://${previewConfig.host}:${slot.state.port}`;
  const localProbePath = launch.validationPath
    ? `/${launch.validationPath}`
    : launch.entryPath
      ? `/${launch.entryPath}`
      : "";
  const localProbeUrl = `${localProbeBaseUrl}${localProbePath}`;

  slot.state.url = publicBaseUrl;
  slot.state.entryUrl = launch.targetKind === "browser"
    ? (launch.entryPath ? `${publicBaseUrl}/${launch.entryPath}` : publicBaseUrl)
    : null;
  slot.state.validationUrl = launch.validationPath
    ? `${publicBaseUrl}/${launch.validationPath}`
    : (slot.state.entryUrl ?? publicBaseUrl);
  slot.state.validationStrategy = launch.validationPath === "health"
    ? "health-url"
    : launch.entryPath
      ? "entry-url"
      : "root-url";

  // Kill any stale process occupying this slot's port before launching.
  // Scoped to slot.state.port (per-company allocation), so it can no
  // longer kill another tenant's preview by accident.
  try {
    const pids = execSync(`lsof -ti:${slot.state.port}`, { encoding: "utf8" }).trim();
    if (pids) {
      for (const pid of pids.split("\n")) {
        try { process.kill(Number(pid), "SIGTERM"); } catch { /* already dead */ }
      }
    }
  } catch { /* no process on port — good */ }

  slot.process = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    shell: true,
    // Scoped env: Arceus secrets stripped (the product's server tier can read
    // process.env), plus the company id so server code can scope its data.
    env: buildProductEnv({
      PORT: String(slot.state.port),
      HOST: previewConfig.host,
      BROWSER: "none",
      ARCEUS_COMPANY_ID: slot.companyId,
    }),
  });

  slot.process.on("exit", (code) => {
    if (slot.state.status !== "ready") {
      slot.state.status = "error";
      slot.state.lastError = `Preview process exited with code ${code ?? "null"}`;
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
    slot.state.status = "error";
    slot.state.lastError = `Preview not reachable at ${localProbeUrl} after ${previewConfig.launchTimeoutMs}ms. Launch: ${slot.state.command}. Check if package.json exists at cwd and 'dev' script starts on port ${slot.state.port}.`;
    return slot.state;
  }

  slot.state.status = "ready";
  return slot.state;
}

// ── Proxy support ────────────────────────────────────────────

/**
 * Resolve a public-subdomain slug to the local port serving that
 * company's preview. Used by `routes/preview-proxy.ts`. Returns null
 * when the slug isn't recognised (no preview ever started under that
 * name) — caller should return 404.
 *
 * The mapping is populated by `buildPreviewPublicBaseUrl` during
 * `startLocalPreview`, so it's available before any traffic arrives
 * at the vanity URL.
 */
export function getPreviewTargetForSlug(slug: string): { companyId: string; port: number } | null {
  const companyId = slugToCompanyId.get(slug);
  if (!companyId) return null;
  const port = portsByCompany.get(companyId);
  if (port === undefined) return null;
  return { companyId, port };
}
