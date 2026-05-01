#!/usr/bin/env node
// Third codemod: cleanup after codemod 1.
// 1. Remove unreachable `return;` lines that follow `return X;`.
// 2. Convert `if (!body) return;` (etc.) after parseOrFail into `return reply;`.
// 3. For bare `return;` inside async route handlers where the prior statement
//    sent reply, change to `return reply;`. We only target route files.

import { readFileSync, writeFileSync } from "node:fs";
import { glob } from "node:fs/promises";

const targets = [];
for await (const f of glob("apps/api/src/routes/internal-mcp/*.routes.ts")) targets.push(f);
targets.push("apps/api/src/routes/internal-telemetry.routes.ts");

let totalChanges = 0;
for (const file of targets) {
  let src = readFileSync(file, "utf8");
  const before = src;

  // 1. Drop unreachable `return;` immediately after `return X;` (same indentation).
  //    e.g. `      return cacheAndSend(...);\n      return;\n`
  src = src.replace(
    /(^\s+return [^\n]+;\n)(\s+return;\s*\n)/gm,
    (_m, keep) => keep,
  );

  // 2. `if (!X) return;` patterns following parseOrFail or any reply-sending
  //    helper need to become `return reply;` because reply is already sent.
  //    Common shape: `const body = parseOrFail(...);\n    if (!body) return;`
  src = src.replace(
    /(parseOrFail\([^\n]+\);\s*\n\s+if \(!\w+\)) return;/g,
    "$1 return reply;",
  );

  // 3. `if (!something) { sendXxx(reply, ...); return; }` style. After
  //    codemod 1 the inner becomes `return sendXxx(...)` already, then
  //    `return;` follows — handled by step 1. Nothing extra to do.

  if (src !== before) {
    writeFileSync(file, src);
    const diff = before.split("\n").length - src.split("\n").length;
    console.log(`✏  ${file} (-${diff} lines)`);
    totalChanges++;
  }
}
console.log(`\nDone. ${totalChanges} files cleaned up.`);
