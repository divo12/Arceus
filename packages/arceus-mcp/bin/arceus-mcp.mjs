#!/usr/bin/env node
// Shim entry-point for the `arceus-mcp` bin. We can't point `bin` at a .ts file
// directly (Node won't execute TypeScript), so this shim spawns tsx against the
// transport-stdio module. Runtime dependency on `tsx` is acceptable because the
// MCP server is only invoked from within the Arceus monorepo where tsx is
// already a devDependency.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "src", "transport-stdio.ts");
const tsxBin = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

const child = spawn(tsxBin, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
