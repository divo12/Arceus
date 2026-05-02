import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = process.env.ARCEUS_API_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": { target: API, changeOrigin: true, ws: false },
      "/health": { target: API, changeOrigin: true },
    },
  },
});
