/**
 * Phase 6 end-to-end wire test:
 *
 *   seed (.arceus/skills-seed) → registry → materialize (writes filesystem)
 *     → recordSkillUsage (usage route simulated) → updateSuccessRate (EMA)
 *
 * Confirms all wiring of registry + resources + manifest + usage + EMA
 * without booting OpenCode. Phase 6.5 package L adds the end-to-end test
 * that drives OpenCode.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  seedExistingSkills,
  seedExistingSkillsDetailed,
  getAllSkills,
  getSkillById,
  getSkillsForRole,
  recordSkillUsage,
  updateSuccessRate,
  resetSkillRegistry,
} from "@arceus/company-runtime";
import {
  materializeBeatSkills,
  renderSkillMd,
  slugify,
} from "./materialize-beat-skills.js";
import {
  recordBeatSkillUsage,
  getBeatSkillUsage,
  clearBeatSkillUsage,
  __resetBeatSkillUsageForTest,
} from "../routes/internal-telemetry.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SEED_DIR = resolve(__dirname, "..", "..", "..", "..", ".arceus", "skills-seed");
const TEST_COMPANY = "company_phase6_materialize";

function setup(): void {
  resetSkillRegistry();
}

/** Count the skill directories (each with a SKILL.md) under the seed dir. */
function countSeedSkillDirs(seedDir: string): number {
  return readdirSync(seedDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(seedDir, e.name, "SKILL.md")))
    .length;
}

test("slugify normalizes names to kebab-case filesystem slugs", () => {
  assert.equal(slugify("task-completion-checklist"), "task-completion-checklist");
  assert.equal(slugify("Task Completion Checklist"), "task-completion-checklist");
  assert.equal(slugify("QA / Verification Loop!"), "qa-verification-loop");
  assert.equal(slugify(""), "skill");
});

test("renderSkillMd writes Arceus metadata + body", () => {
  const md = renderSkillMd({
    id: "skill-foo-v3",
    companyId: "c1",
    name: "Foo",
    role: "developer",
    version: 3,
    status: "active",
    trigger: "Whenever Foo is needed",
    content: "# Foo\n\nDo the thing.",
    testCases: [],
    resources: [],
    successRate: 0.8,
    usageCount: 12,
    lastUsedAt: null,
    mutatedFromId: null,
    mutatedBy: null,
    mutationReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    approvedAt: null,
  });
  assert.match(md, /^---\nname: Foo\n/);
  assert.match(md, /description: Whenever Foo is needed/);
  assert.match(md, /id: skill-foo-v3/);
  assert.match(md, /version: 3/);
  assert.match(md, /status: active/);
  assert.match(md, /# Foo/);
});

test("seedExistingSkills loads all baseline skills + their resources", () => {
  setup();
  const { seeded, updated, skipped } = seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);

  // Count is derived from the filesystem so adding new seed skills doesn't
  // break this test. The *correctness* assertion is the named-skill check
  // below — every skill in `expected` must still be present after seeding.
  const expectedSeedCount = countSeedSkillDirs(SEED_DIR);
  assert.equal(seeded, expectedSeedCount, `all ${expectedSeedCount} seed skills must be loaded from .arceus/skills-seed/`);
  assert.equal(updated, 0);
  assert.equal(skipped, 0);

  const all = getAllSkills(TEST_COMPANY);
  assert.equal(all.length, expectedSeedCount);

  const byName = new Map(all.map((s) => [s.name, s]));
  const expected = [
    "task-completion-checklist",
    "artifact-structure",
    "developer-tdd-loop",
    "design-to-dev-handoff",
    "qa-verification-loop",
    "ceo-sprint-proposal-prep",
    "external-approval-request",
    "workspace-probe-checklist",
  ];
  for (const name of expected) {
    assert.ok(byName.has(name), `expected seed skill "${name}" to be registered`);
  }

  const checklist = byName.get("task-completion-checklist")!;
  assert.ok(
    checklist.resources.length >= 2,
    "task-completion-checklist has 2 resources (evidence-templates + common-failures)",
  );
  const paths = checklist.resources.map((r) => r.path).sort();
  assert.ok(paths.includes("resources/evidence-templates.md"));
  assert.ok(paths.includes("resources/common-failures.md"));
  assert.equal(checklist.resources[0].kind, "reference");
  assert.equal(checklist.resources[0].contentType, "text/markdown");
  assert.equal(checklist.resources[0].encoding, "utf8");
  assert.ok(checklist.resources[0].content.length > 0);
});

test("seedExistingSkills is idempotent (preserve mode skips existing)", () => {
  setup();
  const expectedSeedCount = countSeedSkillDirs(SEED_DIR);
  const first = seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);
  assert.equal(first.seeded, expectedSeedCount);
  const second = seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);
  assert.equal(second.seeded, 0);
  assert.equal(second.skipped, expectedSeedCount);
  assert.equal(second.updated, 0);
});

test("seedExistingSkills overwrite-content updates existing without losing metrics", () => {
  setup();
  const expectedSeedCount = countSeedSkillDirs(SEED_DIR);
  seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);
  const before = getAllSkills(TEST_COMPANY).find((s) => s.name === "artifact-structure")!;
  recordSkillUsage(before.id);  // bump usageCount to prove it's preserved
  const withUsage = getSkillById(before.id)!;
  assert.equal(withUsage.usageCount, 1);

  const result = seedExistingSkillsDetailed(TEST_COMPANY, {
    skillsDir: SEED_DIR,
    mode: "overwrite-content",
  });
  assert.equal(result.seeded, 0);
  assert.equal(result.updated, expectedSeedCount);

  const after = getSkillById(before.id)!;
  assert.equal(after.usageCount, 1, "usageCount must survive overwrite-content");
  assert.equal(after.content, withUsage.content);  // body unchanged because file is unchanged
});

test("materializeBeatSkills writes SKILL.md, resources, and manifest for developer", async () => {
  setup();
  seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);

  const workDir = await mkdtemp(join(tmpdir(), "arceus-mat-"));
  try {
    const materialized = await materializeBeatSkills({
      beatId: "beat_test",
      companyId: TEST_COMPANY,
      role: "developer",
      trustBand: "standard",
      workDir,
    });

    const developerSkills = getSkillsForRole(TEST_COMPANY, "developer").filter(
      (s) => s.status === "active",
    );
    assert.equal(
      materialized.length,
      developerSkills.length,
      "materialized count matches active developer skills",
    );
    assert.ok(materialized.length > 0);

    for (const m of materialized) {
      const skillMdPath = join(workDir, ".opencode", "skills", m.slug, "SKILL.md");
      assert.ok(existsSync(skillMdPath), `SKILL.md must exist at ${skillMdPath}`);
      const content = await readFile(skillMdPath, "utf8");
      assert.match(content, /^---\nname: /);
      assert.match(content, new RegExp(`id: ${m.skillId}`));
      assert.match(content, new RegExp(`version: ${m.version}`));
    }

    const manifestPath = join(workDir, ".opencode", "arceus-skills.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as Record<string, { skillId: string; version: number }>;
    assert.equal(Object.keys(manifest).length, materialized.length);
    for (const m of materialized) {
      assert.deepEqual(manifest[m.slug], { skillId: m.skillId, version: m.version });
    }

    // Resources subdir populated for skills that declare them (checklist has 2).
    const checklistResources = join(workDir, ".opencode", "skills", "task-completion-checklist", "resources");
    if (existsSync(checklistResources)) {
      const evidence = await readFile(join(checklistResources, "evidence-templates.md"), "utf8");
      assert.match(evidence, /Evidence Templates/);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("materializeBeatSkills clears stale skills between beats", async () => {
  setup();
  seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);

  const workDir = await mkdtemp(join(tmpdir(), "arceus-mat-"));
  try {
    // First beat: developer
    await materializeBeatSkills({
      beatId: "beat_1",
      companyId: TEST_COMPANY,
      role: "developer",
      trustBand: "standard",
      workDir,
    });
    const devSkillDir = join(workDir, ".opencode", "skills", "developer-tdd-loop");
    assert.ok(existsSync(devSkillDir));

    // Second beat: tester — developer-tdd-loop must be gone
    await materializeBeatSkills({
      beatId: "beat_2",
      companyId: TEST_COMPANY,
      role: "tester",
      trustBand: "standard",
      workDir,
    });
    assert.ok(!existsSync(devSkillDir), "stale developer skill must not leak into tester beat");
    assert.ok(existsSync(join(workDir, ".opencode", "skills", "qa-verification-loop")));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("probation trust band filters out low-usage or low-success skills", async () => {
  setup();
  seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);

  const workDir = await mkdtemp(join(tmpdir(), "arceus-mat-"));
  try {
    const materialized = await materializeBeatSkills({
      beatId: "beat_probation",
      companyId: TEST_COMPANY,
      role: "developer",
      trustBand: "probation",
      workDir,
    });

    // Seed skills start with successRate=0.7 (< 0.75) and usageCount=0 (< 20),
    // so probation band must filter all of them out.
    assert.equal(materialized.length, 0, "probation must filter all fresh seed skills");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("recordSkillUsage + updateSuccessRate wire into registry correctly", () => {
  setup();
  seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);

  const skill = getAllSkills(TEST_COMPANY).find((s) => s.name === "task-completion-checklist")!;
  const initialCount = skill.usageCount;
  const initialRate = skill.successRate;

  recordSkillUsage(skill.id);
  recordSkillUsage(skill.id);
  const afterUsage = getSkillById(skill.id)!;
  assert.equal(afterUsage.usageCount, initialCount + 2);

  updateSuccessRate(skill.id, 1);  // outcome=pass
  const afterPass = getSkillById(skill.id)!;
  assert.ok(afterPass.successRate > initialRate, "success rate must rise on pass");

  updateSuccessRate(skill.id, 0);  // outcome=fail
  const afterFail = getSkillById(skill.id)!;
  assert.ok(afterFail.successRate < afterPass.successRate, "success rate must fall on fail");
});

// ── Per-beat tally + round-trip (Spec 23 Pass 1) ─────────

test("recordBeatSkillUsage tallies skills per beat and dedupes", () => {
  __resetBeatSkillUsageForTest();
  const beatId = "beat_pass1_a";
  recordBeatSkillUsage(beatId, "skill_x");
  recordBeatSkillUsage(beatId, "skill_y");
  recordBeatSkillUsage(beatId, "skill_x"); // duplicate

  const used = getBeatSkillUsage(beatId);
  assert.deepEqual(used.sort(), ["skill_x", "skill_y"]);
});

test("getBeatSkillUsage isolates beats from each other", () => {
  __resetBeatSkillUsageForTest();
  recordBeatSkillUsage("beat_a", "skill_1");
  recordBeatSkillUsage("beat_b", "skill_2");

  assert.deepEqual(getBeatSkillUsage("beat_a"), ["skill_1"]);
  assert.deepEqual(getBeatSkillUsage("beat_b"), ["skill_2"]);
  assert.deepEqual(getBeatSkillUsage("beat_unknown"), []);
});

test("clearBeatSkillUsage drops the per-beat entry", () => {
  __resetBeatSkillUsageForTest();
  recordBeatSkillUsage("beat_clear", "skill_z");
  assert.deepEqual(getBeatSkillUsage("beat_clear"), ["skill_z"]);

  clearBeatSkillUsage("beat_clear");
  assert.deepEqual(getBeatSkillUsage("beat_clear"), []);
});

test("beat-end round-trip: tally → updateSuccessRate(pass) raises EMA for every used skill", () => {
  setup();
  __resetBeatSkillUsageForTest();
  seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);

  const skills = getAllSkills(TEST_COMPANY).slice(0, 2);
  assert.ok(skills.length === 2, "need at least 2 seed skills");
  const beatId = "beat_roundtrip_pass";
  const baseline = skills.map((s) => ({ id: s.id, rate: s.successRate }));

  // Plugin records each skill the agent loaded during the beat.
  for (const s of skills) recordBeatSkillUsage(beatId, s.id);

  // Mirror runBeat finalisation: drain tally → updateSuccessRate(verdict).
  const used = getBeatSkillUsage(beatId);
  assert.equal(used.length, 2);
  for (const skillId of used) updateSuccessRate(skillId, 1);
  clearBeatSkillUsage(beatId);

  for (const { id, rate } of baseline) {
    const after = getSkillById(id)!;
    assert.ok(after.successRate > rate, `${after.name} EMA must rise on pass`);
  }
  assert.deepEqual(getBeatSkillUsage(beatId), [], "tally must be cleared");
});

test("beat-end round-trip: tally → updateSuccessRate(fail) lowers EMA for every used skill", () => {
  setup();
  __resetBeatSkillUsageForTest();
  seedExistingSkillsDetailed(TEST_COMPANY, SEED_DIR);

  const skill = getAllSkills(TEST_COMPANY)[0]!;
  // Push EMA up first so a fail has somewhere to drop from.
  updateSuccessRate(skill.id, 1);
  updateSuccessRate(skill.id, 1);
  const beforeRate = getSkillById(skill.id)!.successRate;

  const beatId = "beat_roundtrip_fail";
  recordBeatSkillUsage(beatId, skill.id);

  for (const skillId of getBeatSkillUsage(beatId)) updateSuccessRate(skillId, 0);
  clearBeatSkillUsage(beatId);

  const afterRate = getSkillById(skill.id)!.successRate;
  assert.ok(afterRate < beforeRate, `${skill.name} EMA must drop on fail`);
});
