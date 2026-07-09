/**
 * Resolve which company an AI-gateway request belongs to.
 *
 * Order:
 * 1. Authenticated JWT companyId (if present on the request)
 * 2. Preview-proxy host (`<name>.<hash>.arceus.sh` when traffic hits Railway directly)
 * 3. Origin / Referer host — required when Vercel rewrites `/api/ai/*` to Railway
 *    (Host becomes api.arceus.sh; the product host is only in Origin)
 * 4. DB slug lookup for the host label (survives process restarts; preview registry is in-memory)
 */

import { getDb } from "@arceus/db";
import { findCompanyBySlug, fromDbId } from "@arceus/db/src/repos/companies.js";
import { previewConfig } from "../config/index.js";
import { getPreviewTargetForSlug } from "../workspace/preview.js";
import { siteSubdomainOf } from "../workspace/site-url.js";

function hostFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    // bare host
    if (/^[a-z0-9.-]+$/i.test(value)) return value;
    return null;
  }
}

async function companyFromHost(host: string): Promise<string | null> {
  const label = siteSubdomainOf(host, previewConfig.publicDomain);
  if (!label) return null;

  // In-memory preview registry (fast path while process is warm)
  const fromPreview = getPreviewTargetForSlug(label)?.companyId ?? null;
  if (fromPreview) return fromPreview;

  // Durable: companies.slug stores `<name>.<hash>` after deploy
  try {
    const row = await findCompanyBySlug(getDb(), label);
    if (row) return fromDbId(row.id, row.friendlyId);
  } catch {
    // ignore
  }
  return null;
}

export async function resolveAiGatewayCompanyId(args: {
  jwtCompanyId?: string | null;
  hostHeader?: string | null;
  originHeader?: string | null;
  refererHeader?: string | null;
}): Promise<string | null> {
  if (args.jwtCompanyId) return args.jwtCompanyId;

  const candidates = [
    args.hostHeader ?? null,
    hostFromUrl(args.originHeader ?? undefined),
    hostFromUrl(args.refererHeader ?? undefined),
  ].filter((h): h is string => typeof h === "string" && h.length > 0);

  for (const host of candidates) {
    const id = await companyFromHost(host);
    if (id) return id;
  }
  return null;
}
