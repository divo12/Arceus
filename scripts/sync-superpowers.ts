/**
 * sync-superpowers — vendor obra/superpowers process skills into Arceus's
 * OpenCode agent skill library.
 *
 * WHY: Arceus's seeds (`.arceus/skills-seed/*`) are domain reference. superpowers
 * supplies the missing PROCESS discipline (TDD, systematic-debugging,
 * verification-before-completion, …). The mechanics already line up 1:1 — a
 * superpowers `SKILL.md` (name + description + body) maps onto an Arceus seed
 * (name + description + role + trigger + body), which flows through the existing
 * seed → registry → materializeStaticSkillsForCompany → `.opencode/skills/<slug>/`
 * pipeline, so every agent with `skill: true` can call `skill({name:'sp-…'})`.
 *
 * This script reads each curated superpowers skill, rewrites its frontmatter for
 * Arceus (namespaced `sp-` slug + role scoping + trigger + provenance), and
 * writes it to `.arceus/skills-seed/`. Re-runnable to track upstream.
 *
 * Usage:
 *   npx tsx scripts/sync-superpowers.ts [--source <superpowers/skills dir>] [--dry]
 * Source defaults to the local superpowers plugin cache.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface SkillMapEntry {
  /** Canonical Arceus roles this process skill applies to. */
  roles: string[];
  /** Arceus `description` — a one-line summary shown in the skill index. */
  description: string;
}

/**
 * Curated map: superpowers process skills → the Arceus role(s) that should own
 * them. Deliberately EXCLUDES `using-superpowers` (meta — replaced by the
 * per-role preamble injected into agent prompts), `dispatching-parallel-agents`
 * and `subagent-driven-development` (Arceus roles are `mode: primary`,
 * frontend-stitched — not subagent-delegated).
 */
export const SUPERPOWERS_SKILL_MAP: Record<string, SkillMapEntry> = {
  "test-driven-development": {
    roles: ["developer"],
    description: "Write the failing test first, watch it fail, then minimal code to pass. Use before writing any feature or bugfix code.",
  },
  "systematic-debugging": {
    roles: ["developer", "tester"],
    description: "Reproduce → isolate → hypothesize → verify. A repeatable method instead of flailing at a bug.",
  },
  "verification-before-completion": {
    roles: ["developer", "tester"],
    description: "Prove the work actually works (run it, show evidence) before marking a task complete — never claim done on inspection alone.",
  },
  "brainstorming": {
    roles: ["ceo", "pm"],
    description: "Turn a rough idea into a concrete design by exploring intent, constraints, and options before committing.",
  },
  "writing-plans": {
    roles: ["pm", "cto"],
    description: "Turn a spec into a clear, ordered implementation plan before any code is written.",
  },
};

/** Parse a `---` YAML-ish frontmatter block + body. Values are single-line strings. */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: match[2] };
}

/**
 * Transform a superpowers SKILL.md into an Arceus seed SKILL.md.
 * Pure: returns the target slug + the full seed file content.
 */
export function transformSuperpowersSkill(
  name: string,
  raw: string,
  entry: SkillMapEntry,
): { slug: string; content: string } {
  const { frontmatter, body } = parseFrontmatter(raw);
  const slug = `sp-${name}`;
  // The superpowers `description` is phrased as WHEN to use the skill — exactly
  // Arceus's `trigger` semantics. Keep it; supply a fresh one-line description.
  const trigger = frontmatter.description || entry.description;
  const header = [
    "---",
    `name: ${slug}`,
    `description: ${entry.description}`,
    `role: ${entry.roles.join(", ")}`,
    `trigger: ${trigger}`,
    "source: obra/superpowers",
    "---",
    "",
    "",
  ].join("\n");
  return { slug, content: header + body.replace(/^\n+/, "") };
}

// ── Runnable sync (IO) ──────────────────────────────────────────────────────

function defaultSourceDir(): string {
  const base = resolve(
    process.env.HOME ?? "",
    ".claude/plugins/cache/claude-plugins-official/superpowers",
  );
  if (!existsSync(base)) return "";
  // Pick the highest installed version dir.
  const versions = readdirSync(base)
    .filter((d) => statSync(join(base, d)).isDirectory())
    .sort();
  const latest = versions[versions.length - 1];
  return latest ? join(base, latest, "skills") : "";
}

function main(): void {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const srcFlag = args.indexOf("--source");
  const sourceDir = srcFlag !== -1 ? args[srcFlag + 1] : defaultSourceDir();

  if (!sourceDir || !existsSync(sourceDir)) {
    console.error(`[sync-superpowers] source skills dir not found: ${sourceDir || "(unset)"}\n  Pass --source <path-to-superpowers/skills>.`);
    process.exit(1);
  }

  const seedRoot = resolve(__dirname, "..", ".arceus", "skills-seed");
  let written = 0;
  for (const [name, entry] of Object.entries(SUPERPOWERS_SKILL_MAP)) {
    const src = join(sourceDir, name, "SKILL.md");
    if (!existsSync(src)) {
      console.warn(`[sync-superpowers] missing upstream skill: ${name} (${src}) — skipping`);
      continue;
    }
    const { slug, content } = transformSuperpowersSkill(name, readFileSync(src, "utf8"), entry);
    const outDir = join(seedRoot, slug);
    if (dry) {
      console.log(`[sync-superpowers] would write ${slug} → roles [${entry.roles.join(", ")}]`);
    } else {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "SKILL.md"), content, "utf8");
      console.log(`[sync-superpowers] wrote ${slug} → roles [${entry.roles.join(", ")}]`);
    }
    written++;
  }
  console.log(`[sync-superpowers] ${dry ? "would sync" : "synced"} ${written} skill(s) into .arceus/skills-seed/`);
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith("sync-superpowers.ts")) {
  main();
}
