/**
 * Contract test for the hand-authored `epistemic-discipline` seed skill
 * (Component 7 of the memory/quality work).
 *
 * A seed only reaches agents if its frontmatter is well-formed: a resolvable
 * `role`, a `name`, a `trigger`, and the actual discipline in the body. The
 * skill-registry silently DROPS seeds whose role tokens don't resolve, so this
 * test guards the contract — without it a typo would make the skill vanish from
 * every agent with zero error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter } from "./sync-superpowers.ts";

const CANONICAL_ROLES = new Set([
  "ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead",
]);

const SEED_PATH = resolve(__dirname, "..", ".arceus", "skills-seed", "epistemic-discipline", "SKILL.md");

test("epistemic-discipline seed exists with valid Arceus frontmatter", () => {
  const raw = readFileSync(SEED_PATH, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);

  assert.equal(frontmatter.name, "epistemic-discipline");
  assert.ok((frontmatter.description ?? "").length > 10, "needs a description");
  assert.ok((frontmatter.trigger ?? "").length > 10, "needs a trigger (when to use)");

  const roles = (frontmatter.role ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  assert.ok(roles.length > 0, "must target at least one role");
  for (const r of roles) {
    assert.ok(CANONICAL_ROLES.has(r), `role "${r}" is not canonical — registry would drop the seed`);
  }

  // The discipline itself must be present in the body.
  assert.match(body, /KNOW/);
  assert.match(body, /INFER/);
  assert.match(body, /GUESS/);
  assert.match(body, /classify the problem/i);
});
