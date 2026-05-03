/**
 * Postinstall: make ink's react-reconciler use the SAME React 18 instance
 * as the TUI app code.
 *
 * Problem: Root monorepo has React 19 (for Next.js). Ink 5's
 * react-reconciler@0.29.2 needs React 18. If we install React 18 in
 * apps/tui/node_modules/react, our code gets React 18 but react-reconciler
 * (under node_modules/ink/) still resolves to root's React 19 → crash.
 *
 * Fix: Create a directory junction from node_modules/ink/node_modules/react
 * → apps/tui/node_modules/react so both resolve to the same React 18.
 */
import { existsSync, mkdirSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Our React 18 (installed by TUI's package.json)
const tuiReact = resolve(__dirname, "..", "node_modules", "react");
if (!existsSync(resolve(tuiReact, "package.json"))) {
  console.log("[fix-ink-react] TUI react not found yet, skipping");
  process.exit(0);
}
const tuiReactVersion = JSON.parse(
  readFileSync(resolve(tuiReact, "package.json"), "utf8"),
).version;
if (!tuiReactVersion.startsWith("18.")) {
  console.warn(`[fix-ink-react] TUI react is ${tuiReactVersion}, expected 18.x`);
  process.exit(0);
}

// Find ink's install location — resolve from the monorepo root
// (ink doesn't export ./package.json so require.resolve won't work)
const monorepoRoot = resolve(__dirname, "..", "..", "..");
const inkDir = resolve(monorepoRoot, "node_modules", "ink");
if (!existsSync(resolve(inkDir, "package.json"))) {
  console.log("[fix-ink-react] ink not installed yet, skipping");
  process.exit(0);
}

const inkNodeModules = resolve(inkDir, "node_modules");
const target = resolve(inkNodeModules, "react");

// If junction already points to the right place, skip
if (existsSync(resolve(target, "package.json"))) {
  try {
    const v = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8")).version;
    if (v === tuiReactVersion) {
      console.log(`[fix-ink-react] Already linked react@${v}`);
      process.exit(0);
    }
  } catch { /* fall through */ }
  // Wrong version or broken — remove and recreate
  rmSync(target, { recursive: true, force: true });
}

// Create parent dir if needed
if (!existsSync(inkNodeModules)) {
  mkdirSync(inkNodeModules, { recursive: true });
}

// Create junction (works without admin on Windows, unlike symlinks)
try {
  symlinkSync(tuiReact, target, "junction");
  console.log(`[fix-ink-react] Linked ink/node_modules/react → TUI's react@${tuiReactVersion}`);
} catch (err) {
  console.error("[fix-ink-react] Failed to create junction:", err.message);
  process.exit(1);
}
