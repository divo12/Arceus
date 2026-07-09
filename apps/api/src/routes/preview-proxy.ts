/**
 * Preview / production-site proxy — forwards requests for
 * `<name>-<company_hash>.arceus.sh` (and legacy forms) to the local
 * preview/static server on the company's allocated port.
 *
 * Why this exists: the product server runs on a private port inside
 * the Railway container. The user's browser cannot reach 127.0.0.1 on
 * Railway, so the URL the backend reports back to the board is
 * unreachable without this hop. Wildcard DNS (*.arceus.sh) plus a
 * Railway custom domain on this API service routes the public host to
 * port 4000; this hook then proxies to the tenant port internally.
 *
 * Reserved subdomains (app, api, www, admin) bypass the proxy.
 */
import http from "node:http";
import { Socket } from "node:net";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { IncomingMessage } from "node:http";
import { previewConfig } from "../config/index.js";
import { getPreviewTargetForSlug } from "../workspace/preview.js";
import { siteSubdomainOf } from "../workspace/site-url.js";

export function previewSubdomainOf(host: string): string | null {
  return siteSubdomainOf(host, previewConfig.publicDomain);
}

/**
 * Resolve the upstream port for a vanity-subdomain slug. Returns the
 * slot-allocated port for the company that owns this slug. Falls
 * back to `previewConfig.port` when:
 *   - The slug hasn't been registered yet (no preview has started for
 *     that company since process boot), AND
 *   - There is exactly one active company on the singleton seam — the
 *     legacy single-tenant path where the slot registry is empty.
 *
 * Returns null when neither the per-slug lookup nor the fallback
 * resolves. The caller should 404 in that case rather than blindly
 * proxying to a port that may be serving someone else's product.
 */
function resolveUpstreamPort(slug: string): number | null {
  const target = getPreviewTargetForSlug(slug);
  if (target) return target.port;
  return null;
}

function proxyToPreview(req: FastifyRequest, reply: FastifyReply, port: number): void {
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
  upstreamHeaders.host = `${previewConfig.host}:${port}`;

  const upstreamReq = http.request(
    {
      host: previewConfig.host,
      port,
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
        upstream: `http://${previewConfig.host}:${port}`,
      }),
    );
  });

  // Pipe the inbound request body through. At onRequest the body has
  // not been parsed yet, so req.raw is still a readable stream.
  req.raw.pipe(upstreamReq);
}

/**
 * Forward a WebSocket upgrade request to the preview server. Vite's
 * dev-mode HMR client opens `wss://<slug>.<apex>/` which arrives here
 * as an HTTP upgrade. We open a TCP connection to the local Vite
 * server, replay the upgrade request line + headers (with Host
 * rewritten so Vite's allowedHosts check sees a familiar value), and
 * pipe the two sockets together.
 *
 * Without this, the only fix-up path was disabling HMR — which broke
 * dev-mode style injection in some component trees and produced the
 * "blank page through the public preview URL" symptom.
 */
function proxyUpgradeToPreview(req: IncomingMessage, clientSocket: Socket, head: Buffer, port: number): void {
  // Defensive — Node sets pause/resume timing here; if the client
  // already half-closed the upgrade, just drop the connection.
  if (clientSocket.destroyed) return;

  const upstream = new Socket();
  upstream.connect(port, previewConfig.host, () => {
    const path = req.url ?? "/";
    const lines: string[] = [];
    lines.push(`${req.method ?? "GET"} ${path} HTTP/1.1`);
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (name.toLowerCase() === "host") continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) lines.push(`${name}: ${v}`);
    }
    lines.push(`host: ${previewConfig.host}:${port}`);
    lines.push("", "");
    upstream.write(lines.join("\r\n"));
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const closeBoth = () => {
    try { upstream.destroy(); } catch { /* already closed */ }
    try { clientSocket.destroy(); } catch { /* already closed */ }
  };
  upstream.on("error", closeBoth);
  upstream.on("close", closeBoth);
  clientSocket.on("error", closeBoth);
  clientSocket.on("close", closeBoth);
}

/**
 * Register the proxy as the very first onRequest hook so it fires
 * before CORS, auth, and route handlers. Non-preview hosts fall
 * through to normal Fastify routing.
 *
 * Also hooks the underlying Node HTTP server's `upgrade` event to
 * forward WebSocket connections (Vite HMR uses these). Fastify
 * doesn't model WS upgrades at the route layer, so we attach to
 * `app.server` directly.
 */
export function registerPreviewProxy(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    if (typeof host !== "string") return;
    const slug = previewSubdomainOf(host);
    if (slug === null) return;

    // AI gateway — `<slug>.arceus.sh/api/ai/*` is NOT part of the product's
    // own SPA; let it fall through to the Fastify route (ai.routes.ts),
    // which resolves the company from this same subdomain server-side and
    // runs the metered LLM call. Everything else for this host proxies to
    // the tenant preview server below.
    const path = (req.raw.url ?? "/").split("?")[0] ?? "/";
    if (path.startsWith("/api/ai/")) return;

    // Per-tenant routing: each company's preview lives on its own
    // port (allocated by workspace/preview.ts). Resolve the upstream
    // port from the slug registry; if unknown, return 404 instead of
    // blindly proxying to a stale port.
    const port = resolveUpstreamPort(slug);
    if (port === null) {
      reply.hijack();
      reply.raw.writeHead(404, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: "No preview registered for this subdomain", slug }));
      return;
    }

    // Take ownership of the response — Fastify won't try to send anything else.
    reply.hijack();
    proxyToPreview(req, reply, port);
  });

  // WebSocket upgrade path. Fastify's onRequest hook does NOT fire for
  // upgrade requests — those go straight to `server.on("upgrade", ...)`
  // and bypass the HTTP request lifecycle.
  //
  // Register directly on app.server (the raw Node HTTP server) which
  // exists at Fastify instantiation time. Do NOT use app.ready(cb) here
  // — that triggers Fastify's ready lifecycle, which finalises the
  // plugin tree and puts the instance into "started" state before
  // subsequent addHook / register calls in the boot sequence run.
  app.server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host;
    if (typeof host !== "string") return;
    const slug = previewSubdomainOf(host);
    if (slug === null) return;
    const port = resolveUpstreamPort(slug);
    if (port === null) {
      try { socket.destroy(); } catch { /* already closed */ }
      return;
    }
    // Cast: socket is a Duplex but in HTTP-server upgrade events
    // it is always a net.Socket — typings are loose because the
    // contract predates the unified Duplex type.
    proxyUpgradeToPreview(req, socket as Socket, head, port);
  });
}
