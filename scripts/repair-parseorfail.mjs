#!/usr/bin/env node
// Repair: previous shell-quoting bug stripped both the `if (!parsed.success) {`
// line and the inner `sendValidation` call. Restore them.

import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "apps/api/src/routes/internal-mcp/approvals.routes.ts",
  "apps/api/src/routes/internal-mcp/artifacts.routes.ts",
  "apps/api/src/routes/internal-mcp/meetings.routes.ts",
  "apps/api/src/routes/internal-mcp/sprints.routes.ts",
  "apps/api/src/routes/internal-mcp/tasks.routes.ts",
  "apps/api/src/routes/internal-mcp/workspaces.routes.ts",
  "apps/api/src/routes/internal-mcp/memory.routes.ts",
  "apps/api/src/routes/internal-telemetry.routes.ts",
];

for (const f of files) {
  let s = readFileSync(f, "utf8");
  const before = s;
  // Match the broken block: blank line + indent + `return null;` + `}`
  // immediately following `const parsed = schema.safeParse(body);`
  s = s.replace(
    /(const parsed = schema\.safeParse\(body\);)\s*\n\s*\n(\s+)return null;\s*\n\s+\}/g,
    "$1\n  if (!parsed.success) {\n    sendValidation(reply, parsed.error);\n$2return null;\n  }",
  );
  if (s !== before) {
    writeFileSync(f, s);
    console.log("repaired", f);
  } else {
    console.log("no-op", f);
  }
}
