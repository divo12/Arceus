/**
 * Programmatic workspace scaffold — writes a working Vite + React + TypeScript +
 * Tailwind CSS + shadcn/ui project skeleton so LLM agents only have to write
 * application code instead of setting up toolchains.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { previewConfig } from "../config/index.js";

// ---------------------------------------------------------------------------
// Design tokens — clean minimal Apple Notes aesthetic
// ---------------------------------------------------------------------------

const DESIGN_TOKENS_CSS = `/* ── Design Tokens: Clean Minimal (Apple Notes) ── */
:root {
  /* Surface */
  --color-bg:           #ffffff;
  --color-bg-secondary: #f5f5f7;
  --color-bg-tertiary:  #e8e8ed;
  --color-surface:      #ffffff;
  --color-surface-hover:#f5f5f7;

  /* Text */
  --color-text:         #1d1d1f;
  --color-text-secondary:#6e6e73;
  --color-text-tertiary: #aeaeb2;
  --color-text-inverse: #ffffff;

  /* Brand / Accent */
  --color-accent:       #007aff;
  --color-accent-hover: #0056b3;
  --color-accent-light: #e5f1ff;

  /* Borders */
  --color-border:       #d2d2d7;
  --color-border-light: #e5e5ea;

  /* Status */
  --color-success:      #34c759;
  --color-warning:      #ff9f0a;
  --color-error:        #ff3b30;

  /* Shadows */
  --shadow-sm:  0 1px 2px rgba(0,0,0,0.04);
  --shadow-md:  0 4px 12px rgba(0,0,0,0.08);
  --shadow-lg:  0 8px 24px rgba(0,0,0,0.12);

  /* Spacing (8px grid) */
  --space-1: 0.25rem;   /* 4px */
  --space-2: 0.5rem;    /* 8px */
  --space-3: 0.75rem;   /* 12px */
  --space-4: 1rem;      /* 16px */
  --space-5: 1.25rem;   /* 20px */
  --space-6: 1.5rem;    /* 24px */
  --space-8: 2rem;      /* 32px */
  --space-10: 2.5rem;   /* 40px */
  --space-12: 3rem;     /* 48px */

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;

  --text-xs:   0.75rem;     /* 12px */
  --text-sm:   0.875rem;    /* 14px */
  --text-base: 1rem;        /* 16px */
  --text-lg:   1.125rem;    /* 18px */
  --text-xl:   1.25rem;     /* 20px */
  --text-2xl:  1.5rem;      /* 24px */
  --text-3xl:  1.875rem;    /* 30px */

  /* Radius */
  --radius-sm:  6px;
  --radius-md:  10px;
  --radius-lg:  14px;
  --radius-xl:  20px;
  --radius-full: 9999px;

  /* Transitions */
  --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-normal: 250ms cubic-bezier(0.4, 0, 0.2, 1);
}
`;

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function packageJson(projectName: string): string {
  return JSON.stringify({
    name: projectName,
    private: true,
    version: "0.0.1",
    type: "module",
    scripts: {
      dev: "vite",
      build: "tsc -b && vite build",
      preview: "vite preview",
    },
    dependencies: {
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "class-variance-authority": "^0.7.1",
      clsx: "^2.1.1",
      "tailwind-merge": "^2.6.0",
      "lucide-react": "^0.468.0",
    },
    devDependencies: {
      "@types/react": "^18.3.18",
      "@types/react-dom": "^18.3.5",
      "@vitejs/plugin-react": "^4.3.4",
      autoprefixer: "^10.4.20",
      postcss: "^8.4.49",
      tailwindcss: "^3.4.17",
      "tailwindcss-animate": "^1.0.7",
      typescript: "~5.6.2",
      vite: "^6.0.5",
    },
  }, null, 2) + "\n";
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: ${previewConfig.port},
  },
  preview: {
    host: "127.0.0.1",
    port: ${previewConfig.port},
  },
});
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    useDefineForClassFields: true,
    lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext",
    skipLibCheck: true,
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    isolatedModules: true,
    moduleDetection: "force",
    noEmit: true,
    jsx: "react-jsx",
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
  },
  include: ["src"],
}, null, 2) + "\n";

const TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg:        "var(--color-bg)",
        surface:   "var(--color-surface)",
        accent:    "var(--color-accent)",
        border:    "var(--color-border)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const INDEX_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

${DESIGN_TOKENS_CSS}

/* ── Global resets ── */
body {
  margin: 0;
  font-family: var(--font-sans);
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

/* Smooth focus rings */
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
`;

const MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const APP_TSX = `export default function App() {
  return (
    <div className="min-h-screen bg-bg p-6">
      <h1 className="text-2xl font-semibold text-[--color-text]">
        App
      </h1>
    </div>
  );
}
`;

const CN_UTIL = `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

const VITE_ENV_DTS = `/// <reference types="vite/client" />
`;

// ---------------------------------------------------------------------------
// Style guide (embedded as markdown for agents to read)
// ---------------------------------------------------------------------------

export const STYLE_GUIDE_MD = `# Style Guide — Clean Minimal (Apple Notes)

## Design Principles
- **White space is a feature** — generous padding and margins
- **Subtle depth** — light shadows instead of heavy borders
- **Muted palette** — grays and one accent blue, no harsh colors
- **System typography** — native system font stack for crisp text
- **Micro-interactions** — gentle transitions on hover/focus (150-250ms)

## Color Usage
| Token                  | Value     | Use for                        |
|------------------------|-----------|--------------------------------|
| \`--color-bg\`           | #ffffff   | Page background                |
| \`--color-bg-secondary\` | #f5f5f7   | Card/panel backgrounds         |
| \`--color-text\`         | #1d1d1f   | Primary text                   |
| \`--color-text-secondary\`| #6e6e73  | Labels, timestamps, metadata   |
| \`--color-accent\`       | #007aff   | Buttons, links, active states  |
| \`--color-border\`       | #d2d2d7   | Dividers, input borders        |

## Component Patterns
- **Cards**: \`bg-white rounded-xl shadow-sm p-6 border border-[--color-border-light]\`
- **Inputs**: \`w-full px-4 py-2.5 rounded-lg border border-[--color-border] focus:ring-2 focus:ring-[--color-accent] focus:border-transparent transition-all\`
- **Buttons (primary)**: \`px-5 py-2.5 bg-[--color-accent] text-white rounded-lg hover:bg-[--color-accent-hover] active:scale-[0.98] transition-all\`
- **Buttons (secondary)**: \`px-5 py-2.5 bg-[--color-bg-secondary] text-[--color-text] rounded-lg hover:bg-[--color-bg-tertiary] transition-all\`
- **Sidebar**: \`w-64 bg-white border-r border-[--color-border-light] p-4\`

## Layout Rules
- Page max-width: \`max-w-5xl mx-auto\`
- Section spacing: \`space-y-6\` or \`gap-6\`
- Card padding: \`p-6\`
- Input vertical rhythm: \`space-y-4\`
- Responsive: mobile-first, stack on small screens, side-by-side on \`md:\`

## Typography Scale
- Page title: \`text-2xl font-semibold\`
- Section heading: \`text-lg font-medium\`
- Body: \`text-base\`
- Caption/meta: \`text-sm text-[--color-text-secondary]\`

## Utility: cn()
Import \`cn\` from \`@/lib/utils\` (alias: \`./src/lib/utils\`) for conditional class merging:
\`\`\`tsx
import { cn } from "../lib/utils";
<div className={cn("base-classes", isActive && "active-classes")} />
\`\`\`
`;

// ---------------------------------------------------------------------------
// Scaffold function
// ---------------------------------------------------------------------------

/**
 * Writes a fully-configured Vite + React + TypeScript + Tailwind project
 * to the given directory, then runs npm install. Skips if the project
 * already has a package.json with the expected dependencies.
 *
 * Returns true if scaffold was performed, false if skipped.
 */
export async function scaffoldProductWorkspace(
  workspaceDir: string,
  projectName: string = "product-app",
): Promise<{ scaffolded: boolean; error?: string }> {
  try {
    // Skip if workspace already has a functioning project
    const pkgPath = resolve(workspaceDir, "package.json");
    if (existsSync(pkgPath)) {
      const existing = JSON.parse(await readFile(pkgPath, "utf-8"));
      const hasTailwind = existing.devDependencies?.tailwindcss;
      const hasReact = existing.dependencies?.react;
      const hasTailwindConfig = existsSync(resolve(workspaceDir, "tailwind.config.js"))
        || existsSync(resolve(workspaceDir, "tailwind.config.ts"))
        || existsSync(resolve(workspaceDir, "tailwind.config.mjs"));
      if (hasReact && hasTailwind && hasTailwindConfig) {
        return { scaffolded: false };
      }
    }

    // Ensure directories exist
    await mkdir(resolve(workspaceDir, "src", "lib"), { recursive: true });
    await mkdir(resolve(workspaceDir, "src", "components"), { recursive: true });

    // Write project files
    const files: Record<string, string> = {
      "package.json": packageJson(projectName),
      "vite.config.ts": VITE_CONFIG,
      "tsconfig.json": TSCONFIG,
      "tailwind.config.js": TAILWIND_CONFIG,
      "postcss.config.js": POSTCSS_CONFIG,
      "index.html": INDEX_HTML,
      "src/index.css": INDEX_CSS,
      "src/main.tsx": MAIN_TSX,
      "src/App.tsx": APP_TSX,
      "src/lib/utils.ts": CN_UTIL,
      "src/vite-env.d.ts": VITE_ENV_DTS,
    };

    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = resolve(workspaceDir, relativePath);
      // Don't overwrite source files the developer already created
      if (existsSync(fullPath) && relativePath.startsWith("src/")) continue;
      await writeFile(fullPath, content, "utf-8");
    }

    // Write style guide to design/ directory for agents to reference
    await mkdir(resolve(workspaceDir, "design"), { recursive: true });
    await writeFile(
      resolve(workspaceDir, "design", "style-guide.md"),
      STYLE_GUIDE_MD,
      "utf-8",
    );

    // Install dependencies — shared timeout with the lazy install in preview.ts
    execSync("npm install", {
      cwd: workspaceDir,
      timeout: previewConfig.installTimeoutMs,
      stdio: "pipe",
      encoding: "utf-8",
    });

    return { scaffolded: true };
  } catch (err) {
    return {
      scaffolded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
