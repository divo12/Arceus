ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_priority_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('created', 'planned', 'in_progress', 'verifying', 'blocked', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" IN ('critical', 'high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" IN ('technical_plan', 'acceptance_spec', 'implementation', 'local_preview', 'design_direction', 'qa_verification', 'service_validation', 'launch_content', 'distribution_campaign', 'skill_authoring', 'board_handoff', 'follow_up', 'bug_fix'));