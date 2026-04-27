# Post-Soak Migrations

This directory holds destructive migrations that **must not run
automatically**. They're staged here intentionally — the regular
migration runner (`db:migrate`) walks
`packages/db/src/migrations/*.sql` only, so files under
`_post_soak/` are invisible to it.

## When to promote

A file leaves this directory when its preconditions are documented
in the file's header *and* satisfied by the running deployment. The
common pattern: a feature ships in PR N, soaks for ≥3 days, and the
destructive cleanup ships in PR N+1 by promoting the staged file.

## How to promote

1. Verify every precondition listed at the top of the SQL file.
2. `git mv packages/db/src/migrations/_post_soak/<file>.sql
   packages/db/src/migrations/<file>.sql`
3. Append the matching entry to
   `packages/db/src/migrations/meta/_journal.json`.
4. Run `bun run --cwd packages/db db:migrate` against staging first.
5. Soak the staging cutover before applying to production.

## Current contents

- `0015_pr13e_drop_legacy_hippocampus.sql` — drops `legacy_id`
  bridge columns and `DROP SCHEMA hippocampus CASCADE`. Spec 31.
