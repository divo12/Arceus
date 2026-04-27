import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { skillArtifacts } from "./skill_artifacts.js";

/**
 * Spec 31 Phase 7.B.7 (B1) — mutation history sidecar for
 * `skill_artifacts`.
 *
 * The legacy `skill_artifacts` row used to carry mutation provenance
 * inline (`mutated_from_id`, `mutated_by`, `mutation_reason`,
 * `test_cases`, `approved_at`). The canonical `skill_artifacts` row
 * dropped those columns to keep current state separate from history.
 *
 * This table is the canonical home for that history. Each mutation
 * (fork, revision, emergent skill) writes one row here pointing at
 * the resulting `skill_artifacts.id`. The legacy `SkillArtifact`
 * contract still carries those fields; `db-writethrough.ts` splits
 * them on insert (skill row + mutation row) and reassembles on read
 * (latest mutation row → contract fields).
 *
 * Distinct from `skill_revisions` (which tracks git-tag-driven
 * revision numbers and applied-by metadata for the workspace tag
 * lifecycle). `skill_mutations` is the registry-side audit log for
 * pattern-learner / skill-mutator outputs.
 */
export const skillMutations = pgTable(
  "skill_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Skill row this mutation produced. Cascades when the skill is dropped. */
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillArtifacts.id, { onDelete: "cascade" }),
    /** Company scope for partitioning + cascade. */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Skill this one was forked from, when applicable. */
    mutatedFromSkillId: uuid("mutated_from_skill_id").references(
      () => skillArtifacts.id,
      { onDelete: "set null" },
    ),
    /**
     * Agent that proposed the mutation. Nullable because some
     * mutations come from synthetic actors (`pattern_learner`,
     * `skill_mutator`) that don't have an agent row.
     */
    mutatedByAgentId: uuid("mutated_by_agent_id").references(
      () => agents.id,
      { onDelete: "set null" },
    ),
    /**
     * Free-text label for the mutator. Carries the legacy synthetic
     * actor names (`pattern_learner`, `skill_mutator`) when
     * `mutated_by_agent_id` is null. When both are populated the
     * agent uuid is the source of truth and this string is a hint.
     */
    mutatedByLabel: text("mutated_by_label"),
    /** Why the mutation happened (`Skill gap: foo`, `Pattern emerged ...`). */
    mutationReason: text("mutation_reason"),
    /** Optional test scenarios captured at proposal time. */
    testCases: jsonb("test_cases").$type<Array<Record<string, unknown>>>().notNull().default([]),
    /** Set when the mutation was approved into the active registry. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    skillCreatedIdx: index("skill_mutations_skill_created_idx").on(
      table.skillId,
      table.createdAt,
    ),
    companyCreatedIdx: index("skill_mutations_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    mutatedFromIdx: index("skill_mutations_mutated_from_idx").on(
      table.mutatedFromSkillId,
    ),
  }),
);
