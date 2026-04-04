import type { RequestHandler } from "express";

const DEFAULT_ALLOWED_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization";

function appendVary(existing: string | number | string[] | undefined, value: string) {
  const tokens = new Set(
    String(existing ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );
  tokens.add(value);
  return Array.from(tokens).join(", ");
}

export function apiCorsMiddleware(allowedOrigins: Iterable<string>): RequestHandler {
  const allowSet = new Set(Array.from(allowedOrigins, (origin) => origin.trim()).filter(Boolean));

  return (req, res, next) => {
    const origin = req.header("origin");

    if (origin && allowSet.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", appendVary(res.getHeader("Vary"), "Origin"));
    }

    if (req.method !== "OPTIONS") {
      next();
      return;
    }

    const requestedMethod = req.header("access-control-request-method");
    if (!origin || !requestedMethod) {
      next();
      return;
    }

    if (!allowSet.has(origin)) {
      res.status(403).json({ error: "CORS origin not allowed" });
      return;
    }

    const requestedHeaders = req.header("access-control-request-headers");
    res.setHeader("Access-Control-Allow-Methods", DEFAULT_ALLOWED_METHODS);
    res.setHeader(
      "Access-Control-Allow-Headers",
      requestedHeaders && requestedHeaders.trim().length > 0 ? requestedHeaders : DEFAULT_ALLOWED_HEADERS,
    );
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Vary", appendVary(res.getHeader("Vary"), "Access-Control-Request-Method"));
    res.setHeader("Vary", appendVary(res.getHeader("Vary"), "Access-Control-Request-Headers"));
    res.status(204).end();
  };
}
