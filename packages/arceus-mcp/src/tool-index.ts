import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ToolIndexEntry {
  id: string;
  description: string;
  sourceFile: string;
}

const DESCRIPTION_RE = /"([a-z_]+)"\s*,\s*\{\s*description:\s*"([^"]+)"/g;

export const buildToolIndex = (toolsDir: string): ToolIndexEntry[] => {
  const entries: ToolIndexEntry[] = [];
  for (const file of readdirSync(toolsDir)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(toolsDir, file), "utf8");
    for (const match of source.matchAll(DESCRIPTION_RE)) {
      entries.push({ id: match[1], description: match[2], sourceFile: file });
    }
  }
  return entries;
};
