-- Spec 31 Phase 7.B.7 (B1) — `skill_mutations` mutation-history sidecar
-- for `skill_artifacts`.
--
-- Background: the legacy `skill_artifacts` row carried mutation
-- provenance inline (`mutated_from_id`, `mutated_by`,
-- `mutation_reason`, `test_cases`, `approved_at`). The canonical
-- `skill_artifacts` row from `0000_initial_normalized_schema.sql`
-- dropped those columns to keep current state separate from history.
--
-- This migration creates the canonical home for that history. The
-- `SkillArtifact` contract still carries the inline fields (49+
-- consumer sites across `packages/company-runtime/src/skill-*.ts` and
-- `apps/api/src/skills/*.ts`); `apps/api/src/skills/db-writethrough.ts`
-- splits them on insert (one row in `skill_artifacts` + one row here)
-- and reassembles them on read by joining the latest mutation row.
--
-- Distinct from `skill_revisions` (which tracks git-tag-driven
-- workspace revision lifecycle). `skill_mutations` is the registry-side
-- audit log for `pattern-learner` / `skill-mutator` outputs.

CREATE TABLE IF NOT EXISTS "skill_mutations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "mutated_from_skill_id" uuid,
  "mutated_by_agent_id" uuid,
  "mutated_by_label" text,
  "mutation_reason" text,
  "test_cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "skill_mutations"
  ADD CONSTRAINT "skill_mutations_skill_id_skill_artifacts_id_fk"
  FOREIGN KEY ("skill_id") REFERENCES "public"."skill_artifacts"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "skill_mutations"
  ADD CONSTRAINT "skill_mutations_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "skill_mutations"
  ADD CONSTRAINT "skill_mutations_mutated_from_skill_id_skill_artifacts_id_fk"
  FOREIGN KEY ("mutated_from_skill_id") REFERENCES "public"."skill_artifacts"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "skill_mutations"
  ADD CONSTRAINT "skill_mutations_mutated_by_agent_id_agents_id_fk"
  FOREIGN KEY ("mutated_by_agent_id") REFERENCES "public"."agents"("id")
  ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "skill_mutations_skill_created_idx"
  ON "skill_mutations" USING btree ("skill_id", "created_at");

CREATE INDEX IF NOT EXISTS "skill_mutations_company_created_idx"
  ON "skill_mutations" USING btree ("company_id", "created_at");

CREATE INDEX IF NOT EXISTS "skill_mutations_mutated_from_idx"
  ON "skill_mutations" USING btree ("mutated_from_skill_id");
