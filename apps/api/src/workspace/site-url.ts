/**
 * Public site URL helpers for company products on *.arceus.sh.
 *
 * Canonical form: `https://<name>.<company_hash>.arceus.sh`
 *   - name: short brand slug from company name (first 1–2 tokens)
 *   - company_hash: stable 8-char hex derived from company id
 */

import { createHash } from "node:crypto";

/** Stable 8-char hex fingerprint of a company id (friendly or uuid). */
export function companyHash(companyId: string): string {
  return createHash("sha256").update(companyId).digest("hex").slice(0, 8);
}

/**
 * Slugify a company name to the SHORT brand form for the vanity host.
 * First 1–2 alphanumeric tokens — brand, not the full pitch.
 */
export function slugifySiteName(name: string): string {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return "site";
  return tokens.slice(0, 2).join("-");
}

/** Host label: `<name>.<company_hash>` (no apex domain). */
export function siteHostLabel(companyName: string, companyId: string): string {
  return `${slugifySiteName(companyName)}.${companyHash(companyId)}`;
}

/** Full public URL when an apex domain is configured. */
export function buildSitePublicUrl(
  companyName: string,
  companyId: string,
  publicDomain: string,
): string {
  const apex = publicDomain.replace(/^\.+/, "").replace(/\/+$/, "");
  return `https://${siteHostLabel(companyName, companyId)}.${apex}`;
}

/**
 * Parse a Host header against the apex domain.
 * Accepts `<name>.<hash>.apex` (canonical) or legacy `<slug>.apex`.
 * Returns the full subdomain label used as the registry key, or null.
 */
export function siteSubdomainOf(host: string, publicDomain: string): string | null {
  const apex = publicDomain.toLowerCase().replace(/^\.+/, "");
  if (!apex) return null;
  const lower = host.toLowerCase().split(":")[0] ?? "";
  const suffix = `.${apex}`;
  if (!lower.endsWith(suffix)) return null;
  const rest = lower.slice(0, lower.length - suffix.length);
  if (!rest) return null;
  const parts = rest.split(".");
  // Reserved single labels (app/api/www/admin) — never product hosts.
  const RESERVED = new Set(["app", "api", "www", "admin", "preview"]);
  if (parts.length === 1) {
    if (RESERVED.has(parts[0])) return null;
    return parts[0];
  }
  if (parts.length === 2) {
    // Canonical: name.hash — hash is 8 hex chars.
    const [name, hash] = parts;
    if (!name || RESERVED.has(name)) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) return null;
    if (!/^[a-f0-9]{8}$/.test(hash)) return null;
    return rest;
  }
  return null;
}
