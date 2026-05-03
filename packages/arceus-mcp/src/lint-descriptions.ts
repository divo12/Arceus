import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolIndex } from "./tool-index.js";

const MAX_DESCRIPTION_CHARS = 160;

const here = dirname(fileURLToPath(import.meta.url));
const entries = buildToolIndex(join(here, "tools"));

const violations = entries.filter((e) => e.description.length > MAX_DESCRIPTION_CHARS);

if (violations.length > 0) {
  process.stderr.write(
    `Description lint failed — ${violations.length} tool(s) exceed ${MAX_DESCRIPTION_CHARS} chars:\n`
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.id} (${v.sourceFile}): ${v.description.length} chars\n`);
  }
  process.exit(1);
}

process.stdout.write(`Description lint passed — ${entries.length} tool(s), all ≤ ${MAX_DESCRIPTION_CHARS} chars.\n`);
