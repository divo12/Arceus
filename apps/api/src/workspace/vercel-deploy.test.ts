import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectAiRewrite, writeProductionVercelJson } from "./vercel-deploy.js";

describe("writeProductionVercelJson", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vercel-rewrite-"));
    writeFileSync(join(dir, "index.html"), "<html></html>");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes vercel.json that proxies /api/ai to Railway and mounts Hono + SPA", () => {
    writeProductionVercelJson(dir, "https://api.arceus.sh/");
    const raw = readFileSync(join(dir, "vercel.json"), "utf8");
    const cfg = JSON.parse(raw) as {
      framework: string;
      rewrites: { source: string; destination: string }[];
    };
    assert.equal(cfg.framework, "vite");
    assert.equal(cfg.rewrites.length, 3);
    assert.equal(cfg.rewrites[0]!.source, "/api/ai/:path*");
    assert.equal(cfg.rewrites[0]!.destination, "https://api.arceus.sh/api/ai/:path*");
    assert.equal(cfg.rewrites[1]!.source, "/api/(.*)");
    assert.equal(cfg.rewrites[1]!.destination, "/api");
    assert.equal(cfg.rewrites[2]!.destination, "/index.html");
  });

  it("injectAiRewrite remains a thin alias", () => {
    injectAiRewrite(dir, "https://api.example.com");
    const cfg = JSON.parse(readFileSync(join(dir, "vercel.json"), "utf8")) as {
      rewrites: { destination: string }[];
    };
    assert.ok(cfg.rewrites[0]!.destination.startsWith("https://api.example.com/"));
  });
});
