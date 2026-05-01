#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const f = "apps/api/src/routes/internal-mcp/memory.routes.ts";
let s = readFileSync(f, "utf8");
s = s.replace(
  /(\.safeParse\(req\.body\);)\s*\n\s*\n(\s+)return;\s*\n(\s+)\}/g,
  "$1\n$3if (!parsed.success) {\n$2sendValidation(reply, parsed.error);\n$2return reply;\n$3}",
);
writeFileSync(f, s);
console.log("repaired", f);
