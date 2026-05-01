#!/usr/bin/env node
// One-shot codemod: prefix `return ` to reply.send / cacheAndSend / sendNotFound
// /sendConflict / sendGone / sendValidation statements that begin a line.
// Fixes Fastify v5 "Reply was already sent" warnings caused by async handlers
// that call reply.send() then resolve undefined.

import { readFileSync, writeFileSync } from "node:fs";
import { glob } from "node:fs/promises";

const HELPERS = ["cacheAndSend", "sendNotFound", "sendConflict", "sendGone", "sendValidation"];
const HELPER_RE = new RegExp(`^(\\s+)(${HELPERS.join("|")})\\(`, "gm");
// reply.code(x).send( OR reply.send(  at start of indented line
const REPLY_RE = /^(\s+)(reply\.(?:code\([^)]*\)\.)?send)\(/gm;

const targets = [];
for await (const f of glob("apps/api/src/routes/internal-mcp/*.routes.ts")) targets.push(f);
targets.push("apps/api/src/routes/internal-telemetry.routes.ts");

let totalChanges = 0;
for (const file of targets) {
  let src = readFileSync(file, "utf8");
  const before = src;
  let count = 0;
  src = src.replace(HELPER_RE, (m, indent, name) => {
    count++;
    return `${indent}return ${name}(`;
  });
  src = src.replace(REPLY_RE, (m, indent, expr) => {
    count++;
    return `${indent}return ${expr}(`;
  });
  if (src !== before) {
    writeFileSync(file, src);
    console.log(`✏  ${file} (+${count})`);
    totalChanges += count;
  }
}
console.log(`\nDone. ${totalChanges} replacements across ${targets.length} files.`);
