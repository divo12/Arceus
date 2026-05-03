ALTER TABLE "agents" ALTER COLUMN "soul_prompt_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_violations" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "friendly_id" text;--> statement-breakpoint
ALTER TABLE "policy_violations" ADD COLUMN "agent_role" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_friendly_id_idx" ON "agents" USING btree ("friendly_id") WHERE "agents"."friendly_id" IS NOT NULL;