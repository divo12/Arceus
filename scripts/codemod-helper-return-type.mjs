#!/usr/bin/env node
// Second codemod: change `): void => {` to `): FastifyReply => {` for local
// helper functions that now return reply.send(...) (post-codemod-1).
// Also fixes respondError in middleware.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { glob } from "node:fs/promises";

const HELPERS = [
  "cacheAndSend",
  "sendNotFound",
  "sendConflict",
  "sendGone",
  "sendValidation",
  "respondError",
];

const targets = [];
for await (const f of glob("apps/api/src/routes/internal-mcp/*.ts")) targets.push(f);
targets.push("apps/api/src/routes/internal-telemetry.routes.ts");

let totalChanges = 0;
for (const file of targets) {
  let src = readFileSync(file, "utf8");
  const before = src;
  let count = 0;

  for (const name of HELPERS) {
    // Match: const NAME = (
    //   ...args...
    // ): void => {
    // Switch the `: void => {` to `: FastifyReply => {`.
    const re = new RegExp(
      `(const ${name} = \\([\\s\\S]*?\\)):\\s*void(\\s*=>\\s*\\{)`,
      "g",
    );
    src = src.replace(re, (m, head, tail) => {
      count++;
      return `${head}: FastifyReply${tail}`;
    });
  }

  if (src !== before) {
    writeFileSync(file, src);
    console.log(`✏  ${file} (+${count})`);
    totalChanges += count;
  }
}
console.log(`\nDone. ${totalChanges} signatures updated.`);
