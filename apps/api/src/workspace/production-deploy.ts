/**
 * Production deploy — publish the product workspace to Vercel
 * at `https://<name>-<company_hash>.arceus.sh`.
 *
 * Full stack on Vercel:
 *   - Vite SPA (static)
 *   - Hono `/api/*` (serverless via api/index.ts)
 *   - Turso for durable SQLite (provisioned per company)
 *
 * Arceus AI gateway stays on Railway: `/api/ai/*` rewrites to
 * `ARCEUS_API_PUBLIC_ORIGIN`.
 *
 * Fallback (no Vercel token): serve static from the API process (legacy
 * Railway preview path) so local/dev still works.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@arceus/db";
import { findCompanyById, updateCompany } from "@arceus/db/src/repos/companies.js";
import { previewConfig } from "../config/index.js";
import { vercelConfigured } from "../config/vercel.js";
import { tursoConfigured } from "../config/turso.js";
import { workspaceManager } from "./manager.js";
import { ensureDepsInstalled } from "./ensure-deps.js";
import {
  getLocalPreviewState,
  startLocalPreview,
  publishStaticSite,
} from "./preview.js";
import { deployProductToVercel } from "./vercel-deploy.js";
import { ensureCompanyTursoDb, type TursoCredentials } from "./turso-provision.js";
import { buildSitePublicUrl, companyHash, siteHostLabel, slugifySiteName } from "./site-url.js";
import { appendChatMessage } from "../persistence/mutations/index.js";
import { emitEmployeeActivity } from "../observability/activity.js";

export interface ProductionDeployResult {
  ok: boolean;
  url: string | null;
  hostLabel: string | null;
  mode: "vercel" | "static" | "preview" | null;
  error: string | null;
  buildLog: string | null;
  deploymentUrl: string | null;
}

function runShell(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, shell: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const errCode = err ? (err as { code?: number | string }).code : undefined;
      const exitCode = typeof errCode === "number" ? errCode : err ? 1 : 0;
      resolve({
        exitCode,
        stdout: (stdout ?? "").slice(0, 8000),
        stderr: (stderr ?? "").slice(0, 8000),
      });
    });
  });
}

function detectDistDir(productDir: string): string | null {
  const candidates = ["dist", "build", "out", "public"];
  for (const c of candidates) {
    const p = join(productDir, c);
    if (existsSync(join(p, "index.html"))) return p;
  }
  return null;
}

function readPkgScripts(productDir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(productDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function persistProductionUrl(
  companyId: string,
  hostLabel: string,
  url: string,
): Promise<void> {
  try {
    await updateCompany(getDb(), companyId, {
      slug: hostLabel,
      description: `productionUrl=${url}`,
    });
  } catch {
    // best-effort
  }
}

async function announceBoardUrl(
  companyId: string,
  url: string,
  sprintNumber: number | null,
): Promise<void> {
  await appendChatMessage({
    id: `chat_${crypto.randomUUID()}`,
    companyId,
    sprintId: null,
    agentId: null,
    role: "system",
    content: `🌐 Live site ready: ${url}`,
    cardType: "status_update",
    cardData: {
      productionUrl: url,
      previewUrl: url,
      phase: "production_deployed",
      sprintNumber,
    },
    createdAt: new Date().toISOString(),
  });
}

function stageDist(productDir: string, distDir: string): string {
  const stageRoot = join(productDir, ".arceus", "production");
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  cpSync(distDir, stageRoot, { recursive: true });
  if (!existsSync(join(stageRoot, "index.html"))) {
    writeFileSync(join(stageRoot, "index.html"), "<!doctype html><title>Deployed</title>");
  }
  return stageRoot;
}

/**
 * Build + publish the company product.
 * Prefer Vercel when configured; otherwise Railway static fallback.
 */
export async function deployProduction(args: {
  companyId: string;
  sprintNumber?: number | null;
  announce?: boolean;
}): Promise<ProductionDeployResult> {
  const { companyId, sprintNumber = null, announce = true } = args;

  if (!previewConfig.publicDomain && !previewConfig.publicBaseUrl && !vercelConfigured()) {
    return {
      ok: false,
      url: null,
      hostLabel: null,
      mode: null,
      error:
        "Set ARCEUS_VERCEL_TOKEN + ARCEUS_API_PUBLIC_ORIGIN + ARCEUS_TURSO_TOKEN + ARCEUS_TURSO_ORG (and ARCEUS_PREVIEW_PUBLIC_DOMAIN for custom host).",
      buildLog: null,
      deploymentUrl: null,
    };
  }

  const row = await findCompanyById(getDb(), companyId);
  if (!row) {
    return {
      ok: false,
      url: null,
      hostLabel: null,
      mode: null,
      error: `Company ${companyId} not found.`,
      buildLog: null,
      deploymentUrl: null,
    };
  }

  const name = row.name?.trim() || "site";
  const hostLabel = siteHostLabel(name, companyId);
  const customDomain = previewConfig.publicDomain
    ? `${hostLabel}.${previewConfig.publicDomain.replace(/^\.+/, "")}`
    : null;
  const boardUrl = customDomain
    ? `https://${customDomain}`
    : previewConfig.publicBaseUrl
      ? previewConfig.publicBaseUrl.replace(/\/$/, "")
      : buildSitePublicUrl(name, companyId, "arceus.sh");

  const productDir = workspaceManager.getLocalPath(companyId);
  if (!existsSync(productDir)) {
    return {
      ok: false,
      url: null,
      hostLabel,
      mode: null,
      error: "Product workspace missing.",
      buildLog: null,
      deploymentUrl: null,
    };
  }

  emitEmployeeActivity("system", "transition", `Deploying production site → ${boardUrl}`, {
    detail: { companyId, hostLabel, phase: "production_deploy", target: vercelConfigured() ? "vercel" : "railway" },
  });

  const deps = await ensureDepsInstalled(productDir, 180_000);
  if (deps.error) {
    return {
      ok: false,
      url: null,
      hostLabel,
      mode: null,
      error: `Dependency install failed: ${deps.error}`,
      buildLog: null,
      deploymentUrl: null,
    };
  }

  const scripts = readPkgScripts(productDir);
  let buildLog: string | null = null;
  if (scripts.build) {
    const build = await runShell("npm", ["run", "build"], productDir, 180_000);
    buildLog = (build.stdout + "\n" + build.stderr).slice(0, 4000);
    if (build.exitCode !== 0) {
      return {
        ok: false,
        url: null,
        hostLabel,
        mode: null,
        error: `Build failed (exit ${build.exitCode}). Fix build before deploying.`,
        buildLog,
        deploymentUrl: null,
      };
    }
  }

  // ── Primary path: Vercel (full stack: SPA + Hono + Turso) ─
  if (vercelConfigured() && customDomain) {
    if (!tursoConfigured()) {
      return {
        ok: false,
        url: null,
        hostLabel,
        mode: "vercel",
        error:
          "Set ARCEUS_TURSO_TOKEN + ARCEUS_TURSO_ORG so product persistence can be provisioned on Turso (required for Vercel full-stack deploy).",
        buildLog,
        deploymentUrl: null,
      };
    }

    const turso = await ensureCompanyTursoDb({ companyId, productDir });
    if (!turso.ok) {
      return {
        ok: false,
        url: null,
        hostLabel,
        mode: "vercel",
        error: `Turso provision failed: ${turso.error}`,
        buildLog,
        deploymentUrl: null,
      };
    }
    const tursoCreds: TursoCredentials = turso.creds;

    const projectName = `arceus-${slugifySiteName(name)}-${companyHash(companyId)}`.slice(0, 52);
    const vercel = await deployProductToVercel({
      productDir,
      projectName,
      customDomain,
      companyId,
      turso: tursoCreds,
    });
    if (!vercel.ok) {
      return {
        ok: false,
        url: null,
        hostLabel,
        mode: "vercel",
        error: vercel.error ?? "Vercel deploy failed",
        buildLog,
        deploymentUrl: vercel.deploymentUrl,
      };
    }

    const publicUrl = vercel.url ?? boardUrl;
    await persistProductionUrl(companyId, hostLabel, publicUrl);
    if (announce) await announceBoardUrl(companyId, publicUrl, sprintNumber);

    emitEmployeeActivity("system", "transition", `Production site live on Vercel at ${publicUrl}`, {
      detail: {
        companyId,
        hostLabel,
        mode: "vercel",
        phase: "production_live",
        deploymentUrl: vercel.deploymentUrl,
        projectId: vercel.projectId,
        turso: Boolean(tursoCreds),
      },
    });

    return {
      ok: true,
      url: publicUrl,
      hostLabel,
      mode: "vercel",
      error: null,
      buildLog,
      deploymentUrl: vercel.deploymentUrl,
    };
  }

  // ── Fallback: Railway static (dev / missing Vercel creds) ─
  const distDir = detectDistDir(productDir);
  if (!distDir) {
    const current = getLocalPreviewState(companyId);
    let started = current;
    if (current.status !== "ready") {
      started = await startLocalPreview(productDir, null, companyId);
    }
    const publicUrl = started.url ?? boardUrl;
    if (started.status !== "ready") {
      return {
        ok: false,
        url: publicUrl,
        hostLabel,
        mode: "preview",
        error: started.lastError ?? `No dist/ and preview status: ${started.status}`,
        buildLog,
        deploymentUrl: null,
      };
    }
    await persistProductionUrl(companyId, hostLabel, publicUrl);
    if (announce) await announceBoardUrl(companyId, publicUrl, sprintNumber);
    return {
      ok: true,
      url: publicUrl,
      hostLabel,
      mode: "preview",
      error: null,
      buildLog,
      deploymentUrl: null,
    };
  }

  let stageRoot: string;
  try {
    stageRoot = stageDist(productDir, distDir);
  } catch (err) {
    return {
      ok: false,
      url: null,
      hostLabel,
      mode: null,
      error: `Failed to stage production build: ${err instanceof Error ? err.message : String(err)}`,
      buildLog,
      deploymentUrl: null,
    };
  }

  const started = await publishStaticSite(companyId, stageRoot);
  const publicUrl = started.url ?? boardUrl;
  if (started.status !== "ready") {
    return {
      ok: false,
      url: publicUrl,
      hostLabel,
      mode: "static",
      error: started.lastError ?? `Static server status: ${started.status}`,
      buildLog,
      deploymentUrl: null,
    };
  }

  await persistProductionUrl(companyId, hostLabel, publicUrl);
  if (announce) await announceBoardUrl(companyId, publicUrl, sprintNumber);

  emitEmployeeActivity("system", "transition", `Production site live (Railway static fallback) at ${publicUrl}`, {
    detail: { companyId, hostLabel, mode: "static", phase: "production_live" },
  });

  return {
    ok: true,
    url: publicUrl,
    hostLabel,
    mode: "static",
    error: null,
    buildLog,
    deploymentUrl: null,
  };
}

/** Read the last-known production URL for a company. */
export async function getProductionUrl(companyId: string): Promise<string | null> {
  if (previewConfig.publicBaseUrl) return previewConfig.publicBaseUrl.replace(/\/$/, "");
  if (!previewConfig.publicDomain) return null;
  const row = await findCompanyById(getDb(), companyId);
  if (!row) return null;
  const name = row.name?.trim() || slugifySiteName(row.slug ?? "site");
  return buildSitePublicUrl(name, companyId, previewConfig.publicDomain);
}
