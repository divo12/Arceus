import { readFileSync, writeFileSync } from "node:fs";
const f = "apps/api/src/routes/internal-mcp/skills.routes.ts";
let s = readFileSync(f, "utf8");

// Re-apply sendValidation return fix
s = s.replace(
  /const sendValidation = \(reply: FastifyReply, err: ZodError\): FastifyReply => \{\s*\n\s+reply\s*\n\s+\.code\(422\)\s*\n\s+\.send\(failure\(/,
  `const sendValidation = (reply: FastifyReply, err: ZodError): FastifyReply => {
  return reply
    .code(422)
    .send(failure(`,
);

// enforceRole / requireDb early-return must surrender the reply, not undefined.
s = s.replace(/if \(!enforceRole\(([^)]+)\)\) return;/g, "if (!enforceRole($1)) return reply;");
s = s.replace(/if \(!requireDb\(reply\)\) return;/g, "if (!requireDb(reply)) return reply;");

writeFileSync(f, s);
console.log("ok");
