ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "task_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "identifier" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "problem_statement" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deliverable" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "definition_of_done" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "local_preview_url" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cost_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "iteration_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "max_iterations" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "body" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('created','planned','ready','claimed','in_progress','blocked','completed','verified','cancelled'));