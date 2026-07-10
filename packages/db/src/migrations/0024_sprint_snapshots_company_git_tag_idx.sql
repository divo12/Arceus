-- Multi-tenant fix: git tags like `sprint-1` are unique per workspace repo,
-- not globally. The old unique index on git_tag alone blocked the second
-- company from inserting its sprint-1 snapshot row.

DROP INDEX IF EXISTS "sprint_snapshots_git_tag_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "sprint_snapshots_company_git_tag_idx"
  ON "sprint_snapshots" USING btree ("company_id", "git_tag");
