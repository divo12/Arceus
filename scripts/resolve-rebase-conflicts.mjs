#!/usr/bin/env node
// Resolve rebase conflicts: in each conflict block, take the lower (incoming = ours, "8d4c291") side
// EXCEPT for the two skills.routes.ts artifact null-check blocks where we want to combine
// upstream's safer `!artifact || artifact.companyId !==` guard with our `return reply.code()` semantics.

import fs from "node:fs";

const FILES = [
  "apps/api/src/sprints/review.ts",
  "apps/api/src/routes/internal-mcp/approvals.routes.ts",
  "apps/api/src/routes/internal-mcp/skills.routes.ts",
  "packages/contracts/src/observability/sinks/langfuse-sink.ts",
];

for (const f of FILES) {
  let s = fs.readFileSync(f, "utf8");
  // Strategy: for each conflict block, keep only the section between ======= and >>>>>>>
  // (that's our incoming bug-fix commit). This loses upstream lint reformat in conflicting
  // hunks, but only those conflicting hunks; non-conflicting lint changes elsewhere are kept.
  s = s.replace(/<<<<<<< HEAD\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> [^\r\n]+\r?\n/g, (_m, _theirs, ours) => ours + "\n");
  fs.writeFileSync(f, s);
  const remaining = (s.match(/<<<<<<<|=======|>>>>>>>/g) || []).length;
  console.log(`${f}: ${remaining} conflict markers remain`);
}
