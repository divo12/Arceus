/**
 * Tests for the superpowers → Arceus seed transform.
 *
 * Integrates obra/superpowers process skills into Arceus's OpenCode agents by
 * vendoring each superpowers SKILL.md into `.arceus/skills-seed/sp-<name>/`
 * with Arceus frontmatter (role scoping + trigger), so it flows through the
 * existing seed → registry → materialize → `skill({name})` pipeline unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, transformSuperpowersSkill, SUPERPOWERS_SKILL_MAP } from "./sync-superpowers.ts";

const SAMPLE = `---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development (TDD)

Write the test first. Watch it fail.
`;

test("parseFrontmatter splits the YAML block from the body", () => {
  const { frontmatter, body } = parseFrontmatter(SAMPLE);
  assert.equal(frontmatter.name, "test-driven-development");
  assert.match(frontmatter.description, /before writing implementation code/);
  assert.match(body, /Write the test first/);
  assert.doesNotMatch(body, /^---/);
});

test("transform namespaces the slug and scopes it to the mapped roles", () => {
  const entry = SUPERPOWERS_SKILL_MAP["test-driven-development"];
  const { slug, content } = transformSuperpowersSkill("test-driven-development", SAMPLE, entry);
  assert.equal(slug, "sp-test-driven-development");
  assert.match(content, /^---\n/);
  assert.match(content, /name: sp-test-driven-development/);
  assert.match(content, /role: developer/);
  // The superpowers description becomes the Arceus `trigger` (when it fires).
  assert.match(content, /trigger: .*before writing implementation code/);
  // Provenance is recorded for attribution + re-sync.
  assert.match(content, /source: obra\/superpowers/);
  // The actual skill body is preserved verbatim.
  assert.match(content, /Write the test first\. Watch it fail\./);
});

test("the curated map covers process skills and EXCLUDES subagent/meta skills (Arceus roles are mode:primary)", () => {
  assert.ok(SUPERPOWERS_SKILL_MAP["test-driven-development"], "TDD must be mapped");
  assert.ok(SUPERPOWERS_SKILL_MAP["systematic-debugging"], "debugging must be mapped");
  assert.ok(SUPERPOWERS_SKILL_MAP["verification-before-completion"], "verification must be mapped");
  // These don't map onto Arceus's frontend-stitched, mode:primary roles.
  assert.equal(SUPERPOWERS_SKILL_MAP["dispatching-parallel-agents"], undefined);
  assert.equal(SUPERPOWERS_SKILL_MAP["subagent-driven-development"], undefined);
  assert.equal(SUPERPOWERS_SKILL_MAP["using-superpowers"], undefined, "meta-skill is replaced by the Arceus per-role preamble");
});

test("every mapped skill targets at least one valid Arceus role", () => {
  const VALID = new Set(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
  for (const [name, entry] of Object.entries(SUPERPOWERS_SKILL_MAP)) {
    assert.ok(entry.roles.length > 0, `${name} has no roles`);
    for (const r of entry.roles) assert.ok(VALID.has(r), `${name} → invalid role "${r}"`);
    assert.ok(entry.description.length > 10, `${name} needs a description`);
  }
});
