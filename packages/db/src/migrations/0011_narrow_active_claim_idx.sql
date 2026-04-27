-- Migration 0011: narrow tasks_active_claim_idx to status='in_progress' only.
-- After 0010 tightened tasks_status_check to taskStatusSchema.options,
-- 'claimed' is no longer a reachable status. The partial index's WHERE
-- clause kept it alive as dead code; this drop+recreate matches reality.
DROP INDEX "tasks_active_claim_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_active_claim_idx"
  ON "tasks" USING btree ("id")
  WHERE checkout_run_id IS NOT NULL AND status = 'in_progress';
