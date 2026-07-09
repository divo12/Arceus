/**
 * Deploy a company product (Vite + Hono) to Vercel and attach
 * `<name>-<company_hash>.arceus.sh` as the production domain.
 *
 * Uploads the full project source (not only dist) so Vercel builds the
 * SPA and runs `api/index.ts` as the Hono serverless function.
 *
 * `vercel.json` rewrites:
 *   - `/api/ai/*` → Railway (`ARCEUS_API_PUBLIC_ORIGIN`)
 *   - `/api/*` → Hono function
 *   - SPA fallback → index.html
 *
 * Turso credentials are injected as project env vars when provided.
 */

import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { vercelConfig } from "../config/vercel.js";
import type { TursoCredentials } from "./turso-provision.js";

const VERCEL_API = "https://api.vercel.com";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".vite",
  "data",
  "dist",
  "dist-ssr",
  ".vercel",
]);

export interface VercelDeployResult {
  ok: boolean;
  url: string | null;
  deploymentUrl: string | null;
  projectId: string | null;
  error: string | null;
}

interface UploadedFile {
  file: string;
  sha: string;
  size: number;
}

function withTeam(path: string): string {
  if (!vercelConfig.teamId) return path;
  const sepChar = path.includes("?") ? "&" : "?";
  return `${path}${sepChar}teamId=${encodeURIComponent(vercelConfig.teamId)}`;
}

async function vercelFetch(
  path: string,
  init: RequestInit & { rawBody?: Buffer } = {},
): Promise<{ status: number; json: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${vercelConfig.token}`);
  if (!headers.has("Content-Type") && !init.rawBody) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${VERCEL_API}${withTeam(path)}`, {
    method: init.method,
    headers,
    body: init.rawBody ? new Uint8Array(init.rawBody) : init.body,
  });

  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 500) };
    }
  }
  return { status: res.status, json };
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

async function uploadFile(absPath: string, relPath: string): Promise<UploadedFile> {
  const buf = readFileSync(absPath);
  const sha = createHash("sha1").update(buf).digest("hex");
  const { status, json } = await vercelFetch("/v2/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buf.length),
      "x-vercel-digest": sha,
    },
    rawBody: buf,
  });
  if (status !== 200 && status !== 201) {
    const msg =
      typeof json === "object" && json && "error" in json
        ? JSON.stringify((json).error)
        : `upload failed HTTP ${status}`;
    throw new Error(`Vercel file upload (${relPath}): ${msg}`);
  }
  return { file: relPath, sha, size: buf.length };
}

/**
 * Write vercel.json with AI rewrite + Hono API + SPA fallback.
 * Exported for unit tests.
 */
export function writeProductionVercelJson(targetDir: string, apiOrigin: string): void {
  const origin = apiOrigin.replace(/\/+$/, "");
  const config = {
    framework: "vite",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    installCommand: "npm install",
    rewrites: [
      {
        source: "/api/ai/:path*",
        destination: `${origin}/api/ai/:path*`,
      },
      {
        source: "/api/(.*)",
        destination: "/api",
      },
      {
        source: "/((?!api/).*)",
        destination: "/index.html",
      },
    ],
  };
  writeFileSync(join(targetDir, "vercel.json"), JSON.stringify(config, null, 2), "utf8");
}

/** @deprecated use writeProductionVercelJson — kept for older tests */
export function injectAiRewrite(distDir: string, apiOrigin: string): void {
  writeProductionVercelJson(distDir, apiOrigin);
}

async function ensureProject(projectName: string): Promise<string> {
  const created = await vercelFetch("/v10/projects", {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      framework: "vite",
      buildCommand: "npm run build",
      outputDirectory: "dist",
      installCommand: "npm install",
    }),
  });
  if (created.status === 200 || created.status === 201) {
    const id = (created.json as { id?: string })?.id;
    if (id) return id;
  }
  const existing = await vercelFetch(`/v9/projects/${encodeURIComponent(projectName)}`);
  if (existing.status === 200) {
    const id = (existing.json as { id?: string })?.id;
    if (id) return id;
  }
  throw new Error(
    `Could not create/find Vercel project ${projectName}: HTTP ${created.status}`,
  );
}

async function upsertEnv(
  projectId: string,
  key: string,
  value: string,
  target: ("production" | "preview" | "development")[] = ["production", "preview"],
): Promise<void> {
  const create = await vercelFetch(`/v10/projects/${encodeURIComponent(projectId)}/env`, {
    method: "POST",
    body: JSON.stringify({
      key,
      value,
      type: "encrypted",
      target,
    }),
  });
  if (create.status === 200 || create.status === 201) return;

  // Already exists — patch via list + edit.
  const list = await vercelFetch(`/v9/projects/${encodeURIComponent(projectId)}/env`);
  const envs = (list.json as { envs?: { id: string; key: string }[] })?.envs ?? [];
  const found = envs.find((e) => e.key === key);
  if (!found) {
    console.warn(
      `[vercel-deploy] env upsert ${key} failed HTTP ${create.status}: ${JSON.stringify(create.json).slice(0, 200)}`,
    );
    return;
  }
  await vercelFetch(`/v9/projects/${encodeURIComponent(projectId)}/env/${found.id}`, {
    method: "PATCH",
    body: JSON.stringify({ value, type: "encrypted", target }),
  });
}

async function ensureDomain(projectId: string, domain: string): Promise<void> {
  const res = await vercelFetch(`/v10/projects/${encodeURIComponent(projectId)}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });
  if (res.status === 200 || res.status === 201) return;
  const errObj = res.json as { error?: { code?: string; message?: string } };
  const code = errObj?.error?.code ?? "";
  if (code === "domain_already_in_use" || code === "domain_already_exists" || res.status === 409) {
    return;
  }
  console.warn(
    `[vercel-deploy] domain attach ${domain} → HTTP ${res.status}: ${errObj?.error?.message ?? ""}`,
  );
}

async function waitReady(deploymentId: string, timeoutMs = 300_000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await vercelFetch(`/v13/deployments/${encodeURIComponent(deploymentId)}`);
    const body = res.json as { readyState?: string; url?: string; errorMessage?: string };
    if (body.readyState === "READY" && body.url) return body.url;
    if (body.readyState === "ERROR" || body.readyState === "CANCELED") {
      throw new Error(body.errorMessage ?? `Deployment ${body.readyState}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for Vercel deployment READY");
}

function stageProjectForDeploy(productDir: string): string {
  const stageRoot = join(productDir, ".arceus", "vercel-stage");
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });

  for (const entry of readdirSync(productDir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    if (entry === ".arceus") continue; // don't upload staging/creds
    const src = join(productDir, entry);
    const dest = join(stageRoot, entry);
    cpSync(src, dest, { recursive: true });
  }

  // Ensure api entry exists even if an older workspace was provisioned
  // before the template gained api/index.ts.
  const apiEntry = join(stageRoot, "api", "index.ts");
  if (!existsSync(apiEntry)) {
    mkdirSync(join(stageRoot, "api"), { recursive: true });
    writeFileSync(
      apiEntry,
      `import { handle } from "hono/vercel";\nimport app from "../server/index";\nexport const config = { runtime: "nodejs" };\nexport default handle(app);\n`,
      "utf8",
    );
  }

  return stageRoot;
}

/**
 * Deploy the full product workspace to Vercel (Vite SPA + Hono API).
 */
export async function deployProductToVercel(args: {
  productDir: string;
  projectName: string;
  customDomain: string;
  companyId: string;
  turso?: TursoCredentials | null;
}): Promise<VercelDeployResult> {
  if (!vercelConfig.token) {
    return { ok: false, url: null, deploymentUrl: null, projectId: null, error: "ARCEUS_VERCEL_TOKEN not set" };
  }
  if (!vercelConfig.apiPublicOrigin) {
    return {
      ok: false,
      url: null,
      deploymentUrl: null,
      projectId: null,
      error: "ARCEUS_API_PUBLIC_ORIGIN not set — needed so /api/ai rewrites to Railway",
    };
  }
  if (!existsSync(join(args.productDir, "package.json"))) {
    return {
      ok: false,
      url: null,
      deploymentUrl: null,
      projectId: null,
      error: `product package.json missing at ${args.productDir}`,
    };
  }

  try {
    const stageRoot = stageProjectForDeploy(args.productDir);
    writeProductionVercelJson(stageRoot, vercelConfig.apiPublicOrigin);

    const projectId = await ensureProject(args.projectName);

    await upsertEnv(projectId, "ARCEUS_COMPANY_ID", args.companyId);
    await upsertEnv(projectId, "NODEJS_HELPERS", "0");
    if (args.turso) {
      await upsertEnv(projectId, "TURSO_DATABASE_URL", args.turso.databaseUrl);
      await upsertEnv(projectId, "TURSO_AUTH_TOKEN", args.turso.authToken);
    }

    const absFiles = walkFiles(stageRoot);
    const uploaded: UploadedFile[] = [];
    for (const abs of absFiles) {
      const rel = toPosixRel(stageRoot, abs);
      uploaded.push(await uploadFile(abs, rel));
    }

    const create = await vercelFetch("/v13/deployments", {
      method: "POST",
      body: JSON.stringify({
        name: args.projectName,
        project: projectId,
        files: uploaded,
        projectSettings: {
          framework: "vite",
          buildCommand: "npm run build",
          outputDirectory: "dist",
          installCommand: "npm install",
        },
        target: "production",
        meta: {
          arceusCompanyId: args.companyId,
          arceusDomain: args.customDomain,
        },
      }),
    });

    if (create.status !== 200 && create.status !== 201) {
      return {
        ok: false,
        url: null,
        deploymentUrl: null,
        projectId,
        error: `Create deployment HTTP ${create.status}: ${JSON.stringify(create.json).slice(0, 400)}`,
      };
    }

    const dep = create.json as { id?: string; url?: string };
    if (!dep.id) {
      return { ok: false, url: null, deploymentUrl: null, projectId, error: "No deployment id returned" };
    }

    const deploymentHost = await waitReady(dep.id);
    await ensureDomain(projectId, args.customDomain);

    return {
      ok: true,
      url: `https://${args.customDomain}`,
      deploymentUrl: deploymentHost ? `https://${deploymentHost}` : null,
      projectId,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      url: null,
      deploymentUrl: null,
      projectId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** @deprecated use deployProductToVercel */
export async function deployDistToVercel(args: {
  distDir: string;
  projectName: string;
  customDomain: string;
  companyId: string;
}): Promise<VercelDeployResult> {
  // Legacy static-only path — still used if callers pass a staged dist.
  return deployProductToVercel({
    productDir: args.distDir,
    projectName: args.projectName,
    customDomain: args.customDomain,
    companyId: args.companyId,
    turso: null,
  });
}
