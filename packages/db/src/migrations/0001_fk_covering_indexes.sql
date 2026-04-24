CREATE INDEX "artifacts_agent_idx" ON "artifacts" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "meetings_sprint_idx" ON "meetings" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "priming_states_company_idx" ON "priming_states" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "session_bindings_company_idx" ON "session_bindings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "sprint_snapshots_sprint_idx" ON "sprint_snapshots" USING btree ("sprint_id");