---
name: frontend-web-app
description: Build frontend-only web apps with Vite that preview on port 3210. No backend, no Express, no database.
role: developer
---

# Frontend Web App

## FIRST STEP — Run this BEFORE writing any code
```bash
cd /path/to/workspace
npm create vite@latest . -- --template react-ts
```
This creates index.html, src/main.tsx, src/App.tsx, vite.config.ts, package.json, tsconfig.json.
You MUST run this command. Do NOT manually create package.json or index.html.
After running, edit vite.config.ts to set port 3210:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: { port: 3210, host: '127.0.0.1' }
})
```
Then run `npm install`.
Then edit src/App.tsx to build your UI. Add components under src/.

## Constraints (NON-NEGOTIABLE)
- **No backend.** NEVER create server.js, Express, Fastify, API routes, or any server-side code.
- **Port 3210.** Dev server MUST run on port 3210. NEVER 3000, 4000, 4096.
- **Data:** Hardcode in JS/JSON or use localStorage. No databases, no external API calls.
- **Styling:** Inline CSS or Tailwind via CDN. Follow the apple-design-system skill if loaded.
- **index.html MUST exist** at workspace root. Without it Vite returns 404 and preview fails.
- **package.json is JSON.** NEVER put comments (`//`) in package.json — it is not JavaScript, it is strict JSON. Comments will crash the build system.

## When done
- Run `npm run dev` and verify http://127.0.0.1:3210 loads
- Print exactly: `PREVIEW_URL: http://127.0.0.1:3210/`
