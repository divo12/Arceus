import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { productDir } from "../orchestration/state.js";

export interface EntryPointCheckResult {
  pass: boolean;
  entryFile: string | null;
  reason: string;
  orphanedModules: string[];
}

function isExcludedFromEntryCheck(rel: string): boolean {
  const name = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;

  if (name.startsWith(".")) return true;
  if (name.endsWith(".d.ts")) return true;
  if (/\.(test|spec|stories)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) return true;
  if (/\.config\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) return true;

  const configNames = new Set([
    "vite.config.ts", "vite.config.js", "vite.config.mjs",
    "vitest.config.ts", "vitest.config.js",
    "tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs",
    "postcss.config.js", "postcss.config.mjs", "postcss.config.cjs", "postcss.config.ts",
    "next.config.ts", "next.config.js", "next.config.mjs",
    "webpack.config.js", "rollup.config.js", "esbuild.config.js",
    "tsconfig.json", "package.json", "jest.config.ts", "jest.config.js",
    "babel.config.js", ".eslintrc.js", ".prettierrc.js",
    "vite-env.d.ts", "next-env.d.ts",
    "setupTests.ts", "setup-tests.ts",
  ]);
  if (configNames.has(name)) return true;

  if (name === "main.tsx" || name === "main.ts" || name === "main.jsx" || name === "main.js") return true;
  if (name === "index.tsx" || name === "index.ts" || name === "index.jsx" || name === "index.js") {
    if (rel === name || rel === `src/${name}`) return true;
  }

  return false;
}

/**
 * Walk the product workspace's import graph starting from the entry file
 * and report whether all source modules are transitively reachable.
 */
export function checkEntryPointImports(): EntryPointCheckResult {
  const entryFileCandidates = [
    "src/App.tsx", "src/App.jsx", "src/App.vue", "src/App.svelte",
    "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
    "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
    "app.py", "main.py", "index.html",
    "pages/index.tsx", "pages/index.jsx", "app/page.tsx", "app/page.jsx",
  ];

  let entryFile: string | null = null;
  let entryContent = "";
  for (const candidate of entryFileCandidates) {
    const fullPath = join(productDir, candidate);
    try {
      entryContent = readFileSync(fullPath, "utf-8");
      entryFile = candidate;
      break;
    } catch { /* try next */ }
  }

  if (!entryFile) {
    return { pass: true, entryFile: null, reason: "No recognizable entry file found — skipping import check.", orphanedModules: [] };
  }

  const productModules: string[] = [];
  const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"]);
  const ignoreNames = new Set(["node_modules", ".git", "dist", "build", ".next", ".vite", "coverage", "__tests__", "__mocks__", "tests"]);

  function walkProduct(dir: string, depth = 0) {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch { return; }
    for (const entry of entries) {
      if (ignoreNames.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) { walkProduct(fullPath, depth + 1); continue; }
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!codeExtensions.has(ext)) continue;
      const rel = relative(productDir, fullPath).replace(/\\/g, "/");
      if (rel === entryFile) continue;
      if (isExcludedFromEntryCheck(rel)) continue;
      productModules.push(rel);
    }
  }
  walkProduct(productDir);

  if (productModules.length === 0) {
    return { pass: true, entryFile, reason: "No product modules found beyond entry file.", orphanedModules: [] };
  }

  function extractImportedPaths(content: string, fileDir: string): string[] {
    const importPaths: string[] = [];
    const importRegex = /(?:import|require|from)\s*\(?['"]([^'"]+)['"]\)?/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith(".")) {
        const resolved = join(fileDir, importPath).replace(/\\/g, "/");
        importPaths.push(resolved);
      }
    }
    return importPaths;
  }

  function resolveToModule(importRef: string): string | null {
    for (const mod of productModules) {
      const modNoExt = mod.replace(/\.[^.]+$/, "");
      if (importRef === mod || importRef === modNoExt || importRef + "/index" === modNoExt) {
        return mod;
      }
    }
    return null;
  }

  const referencedFiles = new Set<string>();
  const queue: Array<{ path: string; content: string }> = [{ path: entryFile, content: entryContent }];
  const visited = new Set<string>([entryFile]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const fileDir = current.path.includes("/") ? current.path.substring(0, current.path.lastIndexOf("/")) : ".";
    const imports = extractImportedPaths(current.content, fileDir);
    for (const imp of imports) {
      const mod = resolveToModule(imp);
      if (!mod) continue;
      if (visited.has(mod)) continue;
      visited.add(mod);
      referencedFiles.add(mod);
      try {
        const modContent = readFileSync(join(productDir, mod), "utf-8");
        queue.push({ path: mod, content: modContent });
      } catch { /* skip unreadable */ }
    }
  }

  const orphaned = productModules.filter((mod) => !referencedFiles.has(mod));

  if (orphaned.length > 0 && referencedFiles.size === 0) {
    return {
      pass: false, entryFile,
      reason: `Entry file ${entryFile} does not import ANY product modules. ${orphaned.length} module(s) exist on disk but are completely disconnected: ${orphaned.join(", ")}`,
      orphanedModules: orphaned,
    };
  }

  if (orphaned.length > 0 && orphaned.length >= productModules.length * 0.5) {
    return {
      pass: false, entryFile,
      reason: `Entry file ${entryFile} only reaches ${referencedFiles.size}/${productModules.length} modules transitively. ${orphaned.length} orphaned module(s): ${orphaned.join(", ")}`,
      orphanedModules: orphaned,
    };
  }

  return { pass: true, entryFile, reason: `Entry file ${entryFile} reaches ${referencedFiles.size}/${productModules.length} product modules transitively.`, orphanedModules: orphaned };
}

/** Generate human-readable import statements for orphaned modules to wire them into the entry file. */
export function generateOrphanWiringPrescription(orphans: string[], entryFile: string | null): string {
  if (orphans.length === 0 || !entryFile) return "";
  const entryDir = entryFile.includes("/") ? entryFile.slice(0, entryFile.lastIndexOf("/")) : "";

  const lines: string[] = [];
  for (const orphan of orphans.slice(0, 20)) {
    let content = "";
    try {
      content = readFileSync(join(productDir, orphan), "utf-8");
    } catch { continue; }

    const defaultExportMatch =
      content.match(/export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/) ||
      content.match(/export\s+default\s+class\s+([A-Z][A-Za-z0-9_]*)/) ||
      content.match(/export\s+default\s+([A-Z][A-Za-z0-9_]*)\s*;?/);
    const hasUnnamedDefault = /export\s+default\s+(\(|function\s*\(|{|\[)/.test(content);

    const namedExports = new Set<string>();
    const namedFnRe = /export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g;
    const namedConstRe = /export\s+(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/g;
    let m: RegExpExecArray | null;
    while ((m = namedFnRe.exec(content)) !== null) namedExports.add(m[1]);
    while ((m = namedConstRe.exec(content)) !== null) namedExports.add(m[1]);

    const orphanNoExt = orphan.replace(/\.[^.]+$/, "");
    let importPath: string;
    if (entryDir && orphanNoExt.startsWith(entryDir + "/")) {
      importPath = "./" + orphanNoExt.slice(entryDir.length + 1);
    } else if (entryDir) {
      const ups = entryDir.split("/").length;
      importPath = "../".repeat(ups) + orphanNoExt;
    } else {
      importPath = "./" + orphanNoExt;
    }

    const defaultName = defaultExportMatch?.[1];
    const firstNamed = namedExports.size > 0 ? Array.from(namedExports)[0] : null;

    if (defaultName) {
      lines.push(`- ${orphan} → import ${defaultName} from "${importPath}";  // render as <${defaultName} />`);
    } else if (hasUnnamedDefault) {
      const basename = (orphan.split("/").pop() ?? "Component").replace(/\.[^.]+$/, "");
      const alias = basename.replace(/[^A-Za-z0-9]/g, "");
      const pascalAlias = alias.charAt(0).toUpperCase() + alias.slice(1);
      lines.push(`- ${orphan} → import ${pascalAlias} from "${importPath}";  // render as <${pascalAlias} />`);
    } else if (firstNamed) {
      const rest = Array.from(namedExports).slice(1);
      const more = rest.length > 0 ? ` (also exports: ${rest.join(", ")})` : "";
      lines.push(`- ${orphan} → import { ${firstNamed} } from "${importPath}";  // render as <${firstNamed} />${more}`);
    } else {
      lines.push(`- ${orphan} → inspect this file, then import its primary export into ${entryFile}.`);
    }
  }

  const suffix = orphans.length > 20 ? `\n…and ${orphans.length - 20} more orphan(s) — apply the same pattern.` : "";
  return lines.join("\n") + suffix;
}
