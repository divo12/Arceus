/**
 * Preview proxy — forwards requests for `<slug>.arceus.sh` to the local
 * preview server on `previewConfig.host:previewConfig.port`.
 *
 * Why this exists: the preview server runs on a private port inside
 * the Railway container (default 127.0.0.1:3210). The user's browser
 * cannot reach 127.0.0.1 on Railway, so the URL the backend reports
 * back to the chat is unreachable. Wildcard DNS (*.arceus.sh) plus
 * a Railway custom domain on this API service routes the public
 * subdomain to port 4000 (this Fastify instance); this hook then
 * proxies the request to the preview server's port internally.
 *
 * Reserved subdomains (app, api, www, admin) bypass the proxy and
 * fall through to normal API routing — `app.arceus.sh` keeps going
 * to Vercel via more-specific DNS, but if Railway ever sees a request
 * for one of those, we don't want to silently 502 because the
 * preview server didn't recognize the path.
 *
 * The hook fires on `onRequest` (before any body parsing or auth
 * preHandlers) and uses `reply.hijack()` to take ownership of the
 * raw response, piping the upstream HTTP response through directly.
 * This preserves streaming responses, content-types, headers, etc.
 */
import http from "node:http";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { previewConfig } from "../config/index.js";

const RESERVED_SUBDOMAINS = new Set(["app", "api", "www", "admin"]);

function previewSubdomainOf(host: string): string | null {
  const apex = previewConfig.publicDomain.toLowerCase();
  const lower = host.toLowerCase().split(":")[0] ?? "";
  const suffix = `.${apex}`;
  if (!lower.endsWith(suffix)) return null;
  const slug = lower.slice(0, lower.length - suffix.length);
  if (!slug || slug.includes(".")) return null;
  if (RESERVED_SUBDOMAINS.has(slug)) return null;
  return slug;
}

function proxyToPreview(req: FastifyRequest, reply: FastifyReply): void {
  const path = req.raw.url ?? "/";

  // Strip the inbound `host` and provide one that matches the upstream
  // target so the preview server (and its frameworks like Vite) doesn't
  // get confused by an unfamiliar Host header.
  const upstreamHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === "host") continue;
    upstreamHeaders[k] = v;
  }
  upstreamHeaders.host = `${previewConfig.host}:${previewConfig.port}`;

  const upstreamReq = http.request(
    {
      host: previewConfig.host,
      port: previewConfig.port,
      method: req.method,
      path,
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      // Mirror status, headers, and stream the body back unchanged.
      reply.raw.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
      upstreamRes.pipe(reply.raw);
    },
  );

  upstreamReq.on("error", (err) => {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { "content-type": "application/json" });
    }
    reply.raw.end(
      JSON.stringify({
        error: "Preview server not reachable",
        detail: err instanceof Error ? err.message : String(err),
        upstream: `http://${previewConfig.host}:${previewConfig.port}`,
      }),
    );
  });

  // Pipe the inbound request body through. At onRequest the body has
  // not been parsed yet, so req.raw is still a readable stream.
  req.raw.pipe(upstreamReq);
}

/**
 * Register the proxy as the very first onRequest hook so it fires
 * before CORS, auth, and route handlers. Non-preview hosts fall
 * through to normal Fastify routing.
 */
export function registerPreviewProxy(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    if (typeof host !== "string") return;
    const slug = previewSubdomainOf(host);
    if (slug === null) return;

    // Take ownership of the response — Fastify won't try to send anything else.
    reply.hijack();
    proxyToPreview(req, reply);
  });
}
