// Strip leading `return ` from `return sendValidation(reply, parsed.error);`
// inside the local `parseOrFail` helper, which is typed `T | null` and
// therefore cannot return a FastifyReply.
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "apps/api/src/routes/internal-mcp/approvals.routes.ts",
  "apps/api/src/routes/internal-mcp/artifacts.routes.ts",
  "apps/api/src/routes/internal-mcp/meetings.routes.ts",
  "apps/api/src/routes/internal-mcp/sprints.routes.ts",
  "apps/api/src/routes/internal-mcp/tasks.routes.ts",
  "apps/api/src/routes/internal-mcp/workspaces.routes.ts",
  "apps/api/src/routes/internal-telemetry.routes.ts",
];

for (const f of files) {
  let s = readFileSync(f, "utf8");
  const before = s;
  s = s.replace(
    /(if \(!parsed\.success\) \{\s*\n\s+)return (sendValidation\(reply, parsed\.error\);)/g,
    "$1$2",
  );
  if (s !== before) {
    writeFileSync(f, s);
    console.log("fixed", f);
  }
}
