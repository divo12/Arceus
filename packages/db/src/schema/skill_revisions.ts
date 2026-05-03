import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { skillArtifacts } from "./skill_artifacts.js";

export const skillRevisions = pgTable(
  "skill_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id").notNull().references(() => skillArtifacts.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    gitTag: text("git_tag").notNull(),
    gitSha: text("git_sha"),
    appliedBy: text("applied_by").notNull(),
    proposalId: uuid("proposal_id"),
    rollbackFromTag: text("rollback_from_tag"),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_revisions_git_tag_idx").on(table.gitTag),
    uniqueIndex("skill_revisions_skill_revision_idx").on(
      table.skillId,
      table.revisionNumber,
    ),
    index("skill_revisions_skill_revision_desc_idx").on(
      table.skillId,
      table.revisionNumber,
    )
  ],
);
