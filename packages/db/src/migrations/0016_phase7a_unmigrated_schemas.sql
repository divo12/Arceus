CREATE TABLE "hierarchy_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"friendly_id" text,
	"role" text NOT NULL,
	"title" text NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"parent_node_id" uuid,
	"agent_id" uuid,
	"direct_report_node_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"open_for_hiring" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"friendly_id" text,
	"core_idea" text NOT NULL,
	"current_direction" text DEFAULT '' NOT NULL,
	"refined_with_board" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"friendly_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"interval_ms" bigint NOT NULL,
	"participant_agent_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"facilitator_agent_id" uuid,
	"conditional_check_enabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_meeting_id" uuid,
	"next_check_at" timestamp with time zone,
	"skip_count" integer DEFAULT 0 NOT NULL,
	"total_runs" integer DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_summaries" (
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"current_focus" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"recent_learnings" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"active_patterns" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"open_blockers" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"important_decisions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_summaries_agent_id_pk" PRIMARY KEY("agent_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"friendly_id" text,
	"title" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"first_release" text DEFAULT '' NOT NULL,
	"scope_boundary" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"role_rationale" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_briefs_status_check" CHECK ("strategy_briefs"."status" IN ('draft','pending_board_approval','approved','rejected','superseded'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "profile" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "capabilities" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "soul" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "manager_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "report_agent_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hierarchy_nodes" ADD CONSTRAINT "hierarchy_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hierarchy_nodes" ADD CONSTRAINT "hierarchy_nodes_parent_node_id_hierarchy_nodes_id_fk" FOREIGN KEY ("parent_node_id") REFERENCES "public"."hierarchy_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hierarchy_nodes" ADD CONSTRAINT "hierarchy_nodes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_schedules" ADD CONSTRAINT "meeting_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_schedules" ADD CONSTRAINT "meeting_schedules_facilitator_agent_id_agents_id_fk" FOREIGN KEY ("facilitator_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_schedules" ADD CONSTRAINT "meeting_schedules_last_meeting_id_meetings_id_fk" FOREIGN KEY ("last_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_summaries" ADD CONSTRAINT "memory_summaries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_summaries" ADD CONSTRAINT "memory_summaries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_briefs" ADD CONSTRAINT "strategy_briefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_briefs" ADD CONSTRAINT "strategy_briefs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manager_agent_id_agents_id_fk" FOREIGN KEY ("manager_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hierarchy_nodes_company_parent_idx" ON "hierarchy_nodes" USING btree ("company_id","parent_node_id");--> statement-breakpoint
CREATE INDEX "hierarchy_nodes_company_role_idx" ON "hierarchy_nodes" USING btree ("company_id","role");--> statement-breakpoint
CREATE INDEX "hierarchy_nodes_agent_idx" ON "hierarchy_nodes" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ideas_company_unique_idx" ON "ideas" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "meeting_schedules_company_enabled_next_idx" ON "meeting_schedules" USING btree ("company_id","enabled","next_check_at") WHERE "meeting_schedules"."enabled" = true;--> statement-breakpoint
CREATE INDEX "meeting_schedules_company_type_idx" ON "meeting_schedules" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX "memory_summaries_company_idx" ON "memory_summaries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "strategy_briefs_company_status_idx" ON "strategy_briefs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "strategy_briefs_company_created_idx" ON "strategy_briefs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "agents_company_status_idx" ON "agents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "agents_manager_agent_idx" ON "agents" USING btree ("manager_agent_id");
