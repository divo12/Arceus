---
name: developer-workspace-layout
description: Complete map of the Arceus product workspace scaffold — directory tree, every config file's content verbatim, conventions for where new code goes. Load this ONCE at beat start instead of globbing/reading the scaffold files every time. The developer wastes 30-60s per beat re-discovering files it already knows about.
role: developer
trigger: beat start — load BEFORE any glob or read of /workspace/. You only need to read incoming artifacts (PM/CTO/UI Designer specs via artifact_get) and the UI Designer's /workspace/design/ folder. Everything else about the workspace is in this skill.
---

# Arceus Product Workspace — Complete Reference

The workspace at `/workspace/` is **pre-seeded** by the Arceus bootstrap. Every new company starts with the exact tree below. DO NOT glob it, DO NOT read the scaffold files — their contents are inlined here verbatim.

The plugin path-rewrite handles tenant scoping transparently: anything you reference as `/workspace/...` lands in your own tenant's directory. You never see, type, or care about the tenant id.

## Directory tree (frozen scaffold)

This is a **full-stack** scaffold: a React/Vite frontend (`src/`) AND a Hono server tier (`server/`) with SQLite persistence — one `npm run dev` runs both on one port (`/api/*` → Hono, everything else → the React app).

```
/workspace/
├── .gitignore
├── README.md
├── index.html
├── package.json
├── postcss.config.js
├── tailwind.config.js
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── server/                 # BACKEND (Node, server-only) — see developer-fullstack-data skill
│   ├── index.ts            # Hono app: /api/* routes
│   └── db.ts               # SQLite (node:sqlite) — data model + typed query helpers
├── data/                   # SQLite file (app.db) lives here at runtime — gitignored
└── src/                    # FRONTEND (browser)
    ├── App.tsx             # starter demo: notes (full-stack) + AI summary — replace it
    ├── index.css           # design-system tokens (light + dark) — see below
    ├── main.tsx
    ├── components/
    │   └── ui/              # prebuilt shadcn-style primitives (use these)
    │       ├── button.tsx
    │       ├── card.tsx
    │       ├── input.tsx
    │       ├── textarea.tsx
    │       ├── label.tsx
    │       └── badge.tsx
    └── lib/
        ├── utils.ts        # cn() helper
        ├── api.ts          # typed client for the product's own /api/* server
        └── aiComplete.ts   # Arceus AI gateway client (aiComplete/aiPrompt) — no key needed
```

Persistence + APIs + secrets → the `server/` tier (load `developer-fullstack-data`). LLM calls → `src/lib/aiComplete.ts` (load `developer-ai-gateway`).

There is also `/workspace/design/` (UI Designer's handoff folder, populated AT RUNTIME by the ui_designer agent — read it for tokens + layout prototypes when working on frontend) and `/workspace/specs/`, `/workspace/artifacts/`, `/workspace/docs/` (populated when other roles create artifacts that materialize to disk).

## File contents — verbatim

### package.json

```json
{
  "name": "arceus-product",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "NODE_OPTIONS=--experimental-sqlite vite",
    "build": "tsc -b && vite build",
    "preview": "NODE_OPTIONS=--experimental-sqlite vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "hono": "^4.6.14",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.4"
  },
  "devDependencies": {
    "@hono/vite-dev-server": "^0.18.0",
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.10"
  }
}
```

The `NODE_OPTIONS=--experimental-sqlite` prefix enables Node's built-in `node:sqlite` (used by `server/db.ts`). Keep it on `dev`/`preview`.

### vite.config.ts

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    // Mounts the Hono server (server/index.ts) for /api/*; everything else → Vite.
    devServer({ entry: "server/index.ts", exclude: [/^(?!\/api(\/|$)).*/] }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT) || 5173,
    allowedHosts: true,
    strictPort: !!process.env.PORT,
  },
});
```

**Do NOT change the `server` VALUES** (`port`/`host`/`allowedHosts: true`/`strictPort`) — they're required by Arceus's preview pipeline. `allowedHosts` must be the boolean `true` (NOT the string `"all"`, which fails `tsc`). You MAY edit the file to fix a genuine compile error as long as those settings keep their meaning.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Path alias: `@/foo` → `src/foo`. Use it. Strict mode is on; types you import must be exported or declared.

### tsconfig.node.json

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

### tailwind.config.js

```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))", input: "hsl(var(--input))", ring: "hsl(var(--ring))",
        background: "hsl(var(--background))", foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"] },
    },
  },
  plugins: [],
};
```

These tokens are already wired. **Use the semantic Tailwind classes** — `bg-background`, `text-foreground`, `bg-card`, `bg-primary`/`text-primary-foreground`, `bg-muted`/`text-muted-foreground`, `border`, `bg-destructive`, `rounded-lg/md/sm` — NOT raw `bg-gray-900`/hex. They give you light + dark mode + the brand palette for free. If the UI Designer dropped `/workspace/design/tokens.yaml`, map its values onto the **CSS variables in `src/index.css`** (the `--primary`, `--background`, `--radius` HSL channels), not into `theme.extend`.

### postcss.config.js

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

### index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Arceus Product</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### src/main.tsx

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

### src/App.tsx

```tsx
export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Arceus product workspace</h1>
        <p className="text-sm text-neutral-400">
          Scaffolded and ready. Edit <code className="text-neutral-200">src/App.tsx</code> to begin.
        </p>
      </div>
    </div>
  );
}
```

This is the placeholder. Replace it with your real App when you start implementing.

### src/index.css

`index.css` defines the full design-system token set as HSL channels under `:root` (light) and `.dark` (dark), e.g.:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%; --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%; --card-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%; --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%; --muted: 210 40% 96.1%; --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%; --destructive: 0 84.2% 60.2%; --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%; --input: 214.3 31.8% 91.4%; --ring: 222.2 84% 4.9%;
    --radius: 0.65rem;
  }
  .dark { /* same token names, dark values */ }
  body { background-color: hsl(var(--background)); color: hsl(var(--foreground)); }
}
```

**To re-theme a product (brand colors), change these `--*` HSL channels** — every component and Tailwind token updates automatically. Don't scatter hex values in components.

### src/components/ui/ — prebuilt primitives

The scaffold ships shadcn-style primitives (no extra deps needed). Import via `@/`:

```tsx
import { Button } from "@/components/ui/button";   // variant: default|secondary|destructive|outline|ghost|link; size: default|sm|lg|icon
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";      // variant: default|secondary|destructive|outline
```

Compose these instead of styling bare `<button>`/`<div>`. For primitives NOT in the list (Dialog, Dropdown, etc.), add them with `npx shadcn@latest add dialog` — the `cn()` helper + tokens are already set up so they drop in cleanly.

### src/lib/utils.ts

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**Every shadcn/ui component depends on this `cn()`.** DO NOT redefine it. DO NOT remove it. Use it for conditional class merging:

```tsx
<button className={cn("px-4 py-2 rounded", isActive && "bg-blue-500", className)}>...</button>
```

### .gitignore

```
node_modules
dist
dist-ssr
*.local
.vite
.DS_Store
*.log
```

## Where new code goes

| What you're adding | Where it goes |
|---|---|
| A React component | `src/components/<ComponentName>.tsx` (one file each) — bigger components can be folders: `src/components/<Name>/{index.tsx, ChildPiece.tsx}` |
| A page / screen | `src/pages/<PageName>.tsx` (router lives in `src/App.tsx` once you add `react-router-dom`) |
| A pure utility function | `src/lib/<utilName>.ts` (alongside the existing `utils.ts`) |
| A React hook | `src/hooks/use<Name>.ts` |
| API client code | `src/api/<service>.ts` |
| Shared types | Inline in the file that uses them. Only extract to `src/types/<Name>.ts` when ≥2 files share them. |
| Global styles / CSS vars | Append to `src/index.css` under a `:root { ... }` block |
| Static assets (images, fonts) | `src/assets/<file>` and import them; Vite will bundle them. |
| Tests | Co-located: `src/components/Button.tsx` + `src/components/Button.test.tsx` |

## Adding packages (npm via bash)

`bash({command: "npm install <pkg>"})` runs in your tenant's workspace dir (plugin handles the cd). Common adds:

```bash
# Routing
npm install react-router-dom

# shadcn/ui components — button/card/input/textarea/label/badge are ALREADY
# in src/components/ui/. Only add ones you don't have yet:
npx shadcn@latest add dialog dropdown-menu select tabs

# State management
npm install zustand
npm install @tanstack/react-query

# Form handling
npm install react-hook-form zod @hookform/resolvers

# Date / time
npm install date-fns
```

After any `npm install`, the lockfile (`package-lock.json`) changes — **log it via `task_append_command({command, exitCode})`** so the next beat knows.

## Verification — use workspace_* tools, NOT bash

| Want to check... | Use this | NOT this |
|---|---|---|
| TypeScript compiles | `workspace_run_typecheck` | `bash("npx tsc --noEmit")` (skips cache + parsed errors) |
| Workspace still builds | `workspace_verify_baseline` | `bash("npm run build")` |
| Preview is live | `workspace_probe_preview` | `bash("curl localhost:5173")` |
| Module exports an API | `workspace_check_exports` | grep through dist/ |
| Commit progress | `workspace_checkpoint` | `bash("git commit ...")` (skips audit) |

The `workspace_*` tools are cached, structured, and audited. The bash equivalents skip all of that and produce raw stderr you'd have to re-parse.

## What you DO need to read every beat

ONLY these:

1. **Incoming artifacts** — for every id in `task.incomingArtifactIds`, call `artifact_get`. These are PM specs, CTO architecture, UI Designer specs you depend on.
2. **`/workspace/design/`** (for frontend tasks only) — `glob({pattern: "/workspace/design/**/*"})` once, then `read` the relevant ones. This folder is the UI Designer's handoff; it's where `tokens.yaml` and layout prototypes live.
3. **Source files you plan to EDIT** — `read` the specific file before `edit`-ing it, so you have the current content. Don't pre-read the whole `src/` tree.

## What you DO NOT need to read

- Any of the scaffold files in this skill — their content IS this skill.
- `node_modules/` — never. Too big, useless to you.
- `.git/` — never.
- `dist/`, `.vite/` — build artifacts; not source.
- Other tenants' workspaces — impossible (the plugin rejects cross-tenant paths anyway).

## The mental model

```
                  Your task this beat
                          ↓
            Read incoming artifacts (PM/CTO/Designer specs)
                          ↓
            For UI tasks: read /workspace/design/ once
                          ↓
            Plan + skill(developer-tdd-loop)
                          ↓
   WRITE — edit/write/bash. THIS IS THE WORK.
                          ↓
            workspace_run_typecheck (0 errors)
                          ↓
            artifact_create + workspace_checkpoint + task_complete
```

If you find yourself globbing or reading the scaffold to "understand the workspace," you're wasting a beat. Stop. The workspace IS this skill.

## Anti-patterns

| ❌ Wasteful | ✅ Productive |
|---|---|
| `glob({pattern: "/workspace/**/*"})` | Read this skill |
| `read({path: "/workspace/package.json"})` | Read this skill |
| `read({path: "/workspace/vite.config.ts"})` | Read this skill |
| `read({path: "/workspace/src/App.tsx"})` to "see what's there" | Only read it if you're about to edit it |
| `bash("ls -la /workspace")` | Read this skill |
| `bash("cat /workspace/package.json")` | Read this skill |
| Pre-reading every file before deciding what to edit | Decide what to edit from the spec, then read only that |
