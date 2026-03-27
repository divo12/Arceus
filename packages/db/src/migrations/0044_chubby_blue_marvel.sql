CREATE TABLE "hierarchy_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"edge_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hierarchy_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by_agent_id" uuid,
	"proposed_by_user_id" text,
	"approved_by_user_id" text,
	"description" text,
	"approved_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills_seed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"can_delegate_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delegation_style" text DEFAULT 'collaborative' NOT NULL,
	"spawn_rules" jsonb DEFAULT '{"allowedAgentTypes":[],"maxConcurrentSpawns":0,"spawnDepth":1}'::jsonb NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "delegation_style" text DEFAULT 'collaborative' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "kind" text DEFAULT 'employee' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "spawned_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "hierarchy_edges" ADD CONSTRAINT "hierarchy_edges_snapshot_id_hierarchy_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."hierarchy_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hierarchy_edges" ADD CONSTRAINT "hierarchy_edges_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hierarchy_edges" ADD CONSTRAINT "hierarchy_edges_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hierarchy_snapshots" ADD CONSTRAINT "hierarchy_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hierarchy_snapshots" ADD CONSTRAINT "hierarchy_snapshots_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hierarchy_snapshots" ADD CONSTRAINT "hierarchy_snapshots_superseded_by_id_hierarchy_snapshots_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."hierarchy_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD CONSTRAINT "role_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hierarchy_edges_snapshot_source_target_type_idx" ON "hierarchy_edges" USING btree ("snapshot_id","source_agent_id","target_agent_id","edge_type");--> statement-breakpoint
CREATE INDEX "hierarchy_edges_snapshot_edge_type_idx" ON "hierarchy_edges" USING btree ("snapshot_id","edge_type");--> statement-breakpoint
CREATE INDEX "hierarchy_snapshots_company_status_idx" ON "hierarchy_snapshots" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "role_definitions_company_slug_idx" ON "role_definitions" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "role_definitions_company_label_idx" ON "role_definitions" USING btree ("company_id","label");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_role_definition_id_role_definitions_id_fk" FOREIGN KEY ("role_definition_id") REFERENCES "public"."role_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_spawned_by_agent_id_agents_id_fk" FOREIGN KEY ("spawned_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_company_kind_idx" ON "agents" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "agents_company_spawned_by_idx" ON "agents" USING btree ("company_id","spawned_by_agent_id");--> statement-breakpoint
CREATE INDEX "agents_company_role_definition_idx" ON "agents" USING btree ("company_id","role_definition_id");
