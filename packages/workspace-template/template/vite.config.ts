import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for an Arceus-scaffolded product workspace.
 *
 * `server.allowedHosts: "all"` is REQUIRED. The preview is served behind a
 * wildcard subdomain that proxies to the local Vite port; without this,
 * Vite 5+ blocks the request as DNS-rebinding mitigation and the user sees
 * a blank page. Developer soul prompts also enforce this rule.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: "all",
  },
});
