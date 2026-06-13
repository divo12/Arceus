import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";
import { fileURLToPath } from "node:url";

/**
 * Vite config for an Arceus-scaffolded product workspace.
 *
 * Three settings are REQUIRED for Arceus's preview pipeline:
 *
 *   port:         must come from process.env.PORT. The API allocates a
 *                 per-tenant port (from `previewConfig.portMin..portMax`)
 *                 and passes it via the PORT env when spawning the dev
 *                 server. Vite does NOT honor PORT env by default — we
 *                 have to wire it explicitly. Without this, Vite binds
 *                 5173 and the API's probe of the assigned port (e.g.
 *                 4123) gets connection refused → preview "upstream"
 *                 failure.
 *
 *   host:         "0.0.0.0" (or env-supplied) so the API's loopback probe
 *                 AND the wildcard-subdomain proxy can both reach it.
 *
 *   allowedHosts: true — the preview is served behind a Railway public
 *                 subdomain that proxies to this local port. Without this,
 *                 Vite 5+ blocks the request as DNS-rebinding mitigation
 *                 and the user sees a blank page. In Vite 5 the value that
 *                 allows every host is the boolean `true`; the string
 *                 "all" is NOT a valid value (the type is `true |
 *                 string[]`) and fails the `tsc -b` step of `npm run
 *                 build`, breaking every scaffolded company's build.
 */
export default defineConfig({
  plugins: [
    react(),
    // Full-stack: mount the Hono server (server/index.ts) for `/api/*` on the
    // SAME dev-server port. The `exclude` regex sends everything that is NOT
    // `/api` back to Vite (the React SPA + HMR + assets), so one `npm run dev`
    // process serves both the frontend and the backend.
    devServer({ entry: "server/index.ts", exclude: [/^(?!\/api(\/|$)).*/] }),
  ],
  // `@` → ./src so shadcn-style imports (`@/lib/utils`, `@/components/ui/*`)
  // resolve at build/runtime. tsconfig declares the same alias for the
  // type-checker; Vite needs its own copy or `npm run build` fails to
  // resolve `@`.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT) || 5173,
    allowedHosts: true,
    strictPort: !!process.env.PORT,
  },
});
