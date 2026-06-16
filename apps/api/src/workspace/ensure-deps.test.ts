/**
 * The baseline typecheck (workspace_verify_baseline) ran `tsc` with no deps
 * installed, so an early CTO/architect beat hit "cannot find module 'hono'" +
 * cascading implicit-any — blocking the task and spawning a wasteful bug-fix
 * detour. Deps must be installed first. The install env is the bug-prone part:
 * Railway sets NODE_ENV=production container-wide, which makes `npm install`
 * silently strip devDependencies (typescript/tsc/vite) — so the install MUST
 * force NODE_ENV=development and --include=dev.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineInstallSpec } from "./ensure-deps.js";

test("install forces NODE_ENV=development so devDeps (tsc/typescript) aren't stripped", () => {
  const spec = baselineInstallSpec({ NODE_ENV: "production", PATH: "/usr/bin" });
  assert.equal(spec.env.NODE_ENV, "development");
  assert.equal(spec.env.PATH, "/usr/bin", "inherited env is preserved");
});

test("install includes dev dependencies", () => {
  const spec = baselineInstallSpec({});
  assert.equal(spec.command, "npm");
  assert.ok(spec.args.includes("install"));
  assert.ok(spec.args.includes("--include=dev"), "devDeps must be installed for typecheck");
});
