/**
 * Spec 29 §B.4 — pure SKILL.md parser + validator.
 *
 * No fs, no DB, no LLM. Used by `skill_validate_definition` and as a
 * pre-flight inside `skill_register`/`skill_update`.
 */

const REQUIRED_FRONTMATTER_FIELDS = ["name", "role", "trigger"] as const;
const VALID_ROLES = new Set([
  "ceo",
  "cto",
  "developer",
  "designer",
  "qa",
  "product",
  "skills_lead",
]);
const MAX_NAME_LEN = 80;
const MAX_TRIGGER_LEN = 200;
const MAX_BODY_BYTES = 64 * 1024; // 64 KB

export interface ParsedSkill {
  frontmatter: Record<string, string>;
  body: string;
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  parsed: ParsedSkill | null;
}

/** Lift the parser used by the seed-loader so we own a single source of truth. */
export function parseSkillFrontmatter(content: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const lines = match[1].split("\n");
  const frontmatter: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2].trim() };
}

export function validateSkillDefinition(content: string): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof content !== "string" || content.length === 0) {
    return { valid: false, errors: ["content is empty"], warnings, parsed: null };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) {
    errors.push(`SKILL.md exceeds ${MAX_BODY_BYTES} byte cap`);
  }

  const parsed = parseSkillFrontmatter(content);

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!parsed.frontmatter[field]) {
      errors.push(`missing required frontmatter field "${field}"`);
    }
  }

  if (parsed.frontmatter.name && parsed.frontmatter.name.length > MAX_NAME_LEN) {
    errors.push(`name exceeds ${MAX_NAME_LEN} chars`);
  }
  if (parsed.frontmatter.role && !VALID_ROLES.has(parsed.frontmatter.role)) {
    warnings.push(`role "${parsed.frontmatter.role}" is not a known agent role`);
  }
  if (parsed.frontmatter.trigger && parsed.frontmatter.trigger.length > MAX_TRIGGER_LEN) {
    errors.push(`trigger exceeds ${MAX_TRIGGER_LEN} chars`);
  }

  if (parsed.body.length < 30) {
    warnings.push("body is suspiciously short (<30 chars)");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsed,
  };
}
