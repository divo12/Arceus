-- Extensions required by this migration:
--   pgcrypto → gen_random_uuid()
--   pg_trgm  → gin_trgm_ops indexes on task / artifact / skill_artifact titles
--   vector   → pgvector column type on memory_embeddings
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"soul_prompt_ref" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_role_check" CHECK ("agents"."role" IN ('ceo','cto','pm','developer','tester','ui_designer','marketing','skills_lead') OR "agents"."is_internal" = true)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_role" text,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"decision" text,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" IN ('pending','approved','rejected','expired'))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sprint_id" uuid,
	"task_id" uuid,
	"agent_id" uuid,
	"agent_role" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"file_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_kind_check" CHECK ("artifacts"."kind" IN ('code','plan','output','design','report','campaign','handoff','test','spec'))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text DEFAULT 'supabase' NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text,
	"namespace" text DEFAULT 'misc' NOT NULL,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sender" text NOT NULL,
	"content" text NOT NULL,
	"related_task_id" uuid,
	"related_approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_messages_direction_check" CHECK ("board_messages"."direction" IN ('inbound','outbound'))
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"goal" text,
	"board_owner_email" text NOT NULL,
	"task_prefix" text DEFAULT 'ARC' NOT NULL,
	"task_counter" integer DEFAULT 0 NOT NULL,
	"budget_monthly_cents" integer DEFAULT 0 NOT NULL,
	"spent_monthly_cents" integer DEFAULT 0 NOT NULL,
	"budget_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_status_check" CHECK ("companies"."status" IN ('active','paused','archived'))
);
--> statement-breakpoint
CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"task_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heartbeat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"beat_number" integer NOT NULL,
	"trigger" text NOT NULL,
	"trigger_detail" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"cause" text,
	"session_id" text,
	"trust_band" text DEFAULT 'standard' NOT NULL,
	"verdict_score" real,
	"verdict_outcome" text,
	"verdict_signals" jsonb,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"process_pid" integer,
	"process_started_at" timestamp with time zone,
	"retry_of_run_id" uuid,
	"process_loss_retry_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeat_runs_status_check" CHECK ("heartbeat_runs"."status" IN ('running','completed','failed','stranded')),
	CONSTRAINT "heartbeat_runs_verdict_outcome_check" CHECK ("heartbeat_runs"."verdict_outcome" IN ('pass','fail') OR "heartbeat_runs"."verdict_outcome" IS NULL),
	CONSTRAINT "heartbeat_runs_trust_band_check" CHECK ("heartbeat_runs"."trust_band" IN ('probation','standard','senior'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"status_code" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"contribution" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sprint_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_kind_check" CHECK ("meetings"."kind" IN ('daily_sync','sprint_planning','retro','decision','ad_hoc')),
	CONSTRAINT "meetings_status_check" CHECK ("meetings"."status" IN ('scheduled','in_progress','completed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"kind" text,
	"content" text NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"source_task_id" uuid,
	"source_beat_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_units_type_check" CHECK ("memory_units"."type" IN ('static','dynamic','procedural','priming','delegation'))
);
--> statement-breakpoint
CREATE TABLE "policy_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"tool" text NOT NULL,
	"decision" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"beat_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_violations_severity_check" CHECK ("policy_violations"."severity" IN ('low','medium','high','critical'))
);
--> statement-breakpoint
CREATE TABLE "priming_states" (
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recent_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "priming_states_agent_id_pk" PRIMARY KEY("agent_id")
);
--> statement-breakpoint
CREATE TABLE "role_trust" (
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"band" text DEFAULT 'standard' NOT NULL,
	"rolling_pass_rate" numeric(4, 3) DEFAULT '0.500' NOT NULL,
	"beats_in_band" integer DEFAULT 0 NOT NULL,
	"last_verdict_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_trust_company_id_role_pk" PRIMARY KEY("company_id","role"),
	CONSTRAINT "role_trust_band_check" CHECK ("role_trust"."band" IN ('probation','standard','senior'))
);
--> statement-breakpoint
CREATE TABLE "role_trust_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"from_band" text NOT NULL,
	"to_band" text NOT NULL,
	"reason" text NOT NULL,
	"verdict_window" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_trust_events_from_band_check" CHECK ("role_trust_events"."from_band" IN ('probation','standard','senior')),
	CONSTRAINT "role_trust_events_to_band_check" CHECK ("role_trust_events"."to_band" IN ('probation','standard','senior'))
);
--> statement-breakpoint
CREATE TABLE "service_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"description" text NOT NULL,
	"allowed_roles" text[] NOT NULL,
	"blast_radius" text DEFAULT 'green' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"added_by" text DEFAULT 'system' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_registry_blast_radius_check" CHECK ("service_registry"."blast_radius" IN ('green','yellow','red'))
);
--> statement-breakpoint
CREATE TABLE "session_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"beat_id" uuid NOT NULL,
	"role" text NOT NULL,
	"trust_band" text NOT NULL,
	"allowed_tools" text[] NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trigger_condition" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"success_rate" numeric(5, 4) DEFAULT '0.5000' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_artifacts_status_check" CHECK ("skill_artifacts"."status" IN ('draft','active','deprecated'))
);
--> statement-breakpoint
CREATE TABLE "skill_evolve_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"target_skill_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "skill_evolve_jobs_trigger_check" CHECK ("skill_evolve_jobs"."trigger" IN ('ema_drop','cron','candidate','rollback')),
	CONSTRAINT "skill_evolve_jobs_status_check" CHECK ("skill_evolve_jobs"."status" IN ('pending','claimed','running','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "skill_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"git_tag" text NOT NULL,
	"git_sha" text,
	"applied_by" text NOT NULL,
	"proposal_id" uuid,
	"rollback_from_tag" text,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"beat_id" uuid,
	"agent_id" uuid,
	"outcome_score" real NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sprint_id" uuid,
	"sprint_number" integer NOT NULL,
	"git_tag" text NOT NULL,
	"bundle_key" text,
	"bundle_sha256" text,
	"bundle_bytes" bigint,
	"file_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprint_snapshots_status_check" CHECK ("sprint_snapshots"."status" IN ('active','rolled_back'))
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sprint_number" integer NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"goal" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprints_status_check" CHECK ("sprints"."status" IN ('planned','active','completed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sprint_id" uuid,
	"parent_task_id" uuid,
	"task_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'standard' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"assigned_role" text,
	"assigned_agent_id" uuid,
	"checkout_run_id" uuid,
	"execution_run_id" uuid,
	"execution_locked_at" timestamp with time zone,
	"depends_on_task_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb,
	"feedback" text,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('planned','ready','claimed','in_progress','blocked','completed','verified','cancelled')),
	CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" IN ('low','medium','high','critical')),
	CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" IN ('standard','technical_plan','acceptance_spec','implementation','board_handoff','service_validation','skill_apply_proposal'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"local_path" text,
	"status" text DEFAULT 'active' NOT NULL,
	"latest_bundle_key" text,
	"latest_bundle_sha256" text,
	"latest_bundle_bytes" bigint,
	"current_sprint_number" integer DEFAULT 0 NOT NULL,
	"current_git_ref" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_status_check" CHECK ("workspaces"."status" IN ('active','archived','restoring'))
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_related_task_id_tasks_id_fk" FOREIGN KEY ("related_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_related_approval_id_approvals_id_fk" FOREIGN KEY ("related_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_retry_of_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_contributions" ADD CONSTRAINT "meeting_contributions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_contributions" ADD CONSTRAINT "meeting_contributions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_memory_units_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memory_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_units" ADD CONSTRAINT "memory_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_units" ADD CONSTRAINT "memory_units_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_units" ADD CONSTRAINT "memory_units_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_units" ADD CONSTRAINT "memory_units_source_beat_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_beat_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_beat_id_heartbeat_runs_id_fk" FOREIGN KEY ("beat_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priming_states" ADD CONSTRAINT "priming_states_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priming_states" ADD CONSTRAINT "priming_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_trust" ADD CONSTRAINT "role_trust_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_trust_events" ADD CONSTRAINT "role_trust_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_registry" ADD CONSTRAINT "service_registry_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_beat_id_heartbeat_runs_id_fk" FOREIGN KEY ("beat_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_artifacts" ADD CONSTRAINT "skill_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evolve_jobs" ADD CONSTRAINT "skill_evolve_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evolve_jobs" ADD CONSTRAINT "skill_evolve_jobs_target_skill_id_skill_artifacts_id_fk" FOREIGN KEY ("target_skill_id") REFERENCES "public"."skill_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_skill_id_skill_artifacts_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_id_skill_artifacts_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_beat_id_heartbeat_runs_id_fk" FOREIGN KEY ("beat_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_snapshots" ADD CONSTRAINT "sprint_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_snapshots" ADD CONSTRAINT "sprint_snapshots_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_checkout_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("checkout_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_execution_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("execution_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_company_created_idx" ON "activity_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_entity_type_id_created_idx" ON "activity_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_run_id_idx" ON "activity_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "activity_log_agent_idx" ON "activity_log" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_company_role_idx" ON "agents" USING btree ("company_id","role");--> statement-breakpoint
CREATE INDEX "agents_company_is_internal_idx" ON "agents" USING btree ("company_id","is_internal");--> statement-breakpoint
CREATE INDEX "approvals_company_status_created_idx" ON "approvals" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "approvals_company_kind_status_idx" ON "approvals" USING btree ("company_id","kind","status");--> statement-breakpoint
CREATE INDEX "approvals_requested_by_agent_idx" ON "approvals" USING btree ("requested_by_agent_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_task_idx" ON "artifacts" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_sprint_idx" ON "artifacts" USING btree ("company_id","sprint_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_kind_idx" ON "artifacts" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "artifacts_company_created_idx" ON "artifacts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_title_search_idx" ON "artifacts" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "assets_company_object_key_idx" ON "assets" USING btree ("company_id","object_key");--> statement-breakpoint
CREATE INDEX "assets_company_namespace_idx" ON "assets" USING btree ("company_id","namespace");--> statement-breakpoint
CREATE INDEX "assets_created_by_agent_idx" ON "assets" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX "board_messages_company_created_idx" ON "board_messages" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "board_messages_company_direction_created_idx" ON "board_messages" USING btree ("company_id","direction","created_at");--> statement-breakpoint
CREATE INDEX "board_messages_related_task_idx" ON "board_messages" USING btree ("related_task_id");--> statement-breakpoint
CREATE INDEX "board_messages_related_approval_idx" ON "board_messages" USING btree ("related_approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_idx" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_task_prefix_idx" ON "companies" USING btree ("task_prefix");--> statement-breakpoint
CREATE INDEX "companies_status_idx" ON "companies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cost_events_company_occurred_idx" ON "cost_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_company_agent_occurred_idx" ON "cost_events" USING btree ("company_id","agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_company_provider_occurred_idx" ON "cost_events" USING btree ("company_id","provider","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_run_idx" ON "cost_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "cost_events_task_idx" ON "cost_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_agent_started_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","started_at");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_status_idx" ON "heartbeat_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_beat_number_idx" ON "heartbeat_runs" USING btree ("company_id","beat_number");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_retry_of_run_id_idx" ON "heartbeat_runs" USING btree ("retry_of_run_id");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_stranded_idx" ON "heartbeat_runs" USING btree ("status","started_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_contributions_meeting_agent_idx" ON "meeting_contributions" USING btree ("meeting_id","agent_id");--> statement-breakpoint
CREATE INDEX "meeting_contributions_meeting_idx" ON "meeting_contributions" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meetings_company_status_scheduled_idx" ON "meetings" USING btree ("company_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "meetings_company_kind_idx" ON "meetings" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "memory_units_agent_type_created_idx" ON "memory_units" USING btree ("agent_id","type","created_at");--> statement-breakpoint
CREATE INDEX "memory_units_dynamic_expires_idx" ON "memory_units" USING btree ("agent_id","expires_at") WHERE type = 'dynamic';--> statement-breakpoint
CREATE INDEX "memory_units_company_created_idx" ON "memory_units" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_units_source_task_idx" ON "memory_units" USING btree ("source_task_id");--> statement-breakpoint
CREATE INDEX "memory_units_source_beat_idx" ON "memory_units" USING btree ("source_beat_id");--> statement-breakpoint
CREATE INDEX "policy_violations_company_created_idx" ON "policy_violations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_violations_company_agent_created_idx" ON "policy_violations" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_violations_beat_idx" ON "policy_violations" USING btree ("beat_id");--> statement-breakpoint
CREATE INDEX "role_trust_events_company_role_created_idx" ON "role_trust_events" USING btree ("company_id","role","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_registry_company_tool_idx" ON "service_registry" USING btree ("company_id","tool_name");--> statement-breakpoint
CREATE INDEX "service_registry_company_tool_lookup_idx" ON "service_registry" USING btree ("company_id","tool_name");--> statement-breakpoint
CREATE UNIQUE INDEX "session_bindings_session_id_idx" ON "session_bindings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_bindings_beat_idx" ON "session_bindings" USING btree ("beat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_artifacts_company_slug_idx" ON "skill_artifacts" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "skill_artifacts_company_role_status_idx" ON "skill_artifacts" USING btree ("company_id","role","status");--> statement-breakpoint
CREATE INDEX "skill_artifacts_company_active_success_idx" ON "skill_artifacts" USING btree ("company_id","success_rate") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "skill_artifacts_name_search_idx" ON "skill_artifacts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "skill_evolve_jobs_pending_lease_idx" ON "skill_evolve_jobs" USING btree ("created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "skill_evolve_jobs_company_status_created_idx" ON "skill_evolve_jobs" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "skill_evolve_jobs_target_skill_idx" ON "skill_evolve_jobs" USING btree ("target_skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_revisions_git_tag_idx" ON "skill_revisions" USING btree ("git_tag");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_revisions_skill_revision_idx" ON "skill_revisions" USING btree ("skill_id","revision_number");--> statement-breakpoint
CREATE INDEX "skill_revisions_skill_revision_desc_idx" ON "skill_revisions" USING btree ("skill_id","revision_number");--> statement-breakpoint
CREATE INDEX "skill_usage_events_skill_occurred_idx" ON "skill_usage_events" USING btree ("skill_id","occurred_at");--> statement-breakpoint
CREATE INDEX "skill_usage_events_company_occurred_idx" ON "skill_usage_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "skill_usage_events_beat_idx" ON "skill_usage_events" USING btree ("beat_id");--> statement-breakpoint
CREATE INDEX "skill_usage_events_agent_idx" ON "skill_usage_events" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_snapshots_git_tag_idx" ON "sprint_snapshots" USING btree ("git_tag");--> statement-breakpoint
CREATE INDEX "sprint_snapshots_company_sprint_number_idx" ON "sprint_snapshots" USING btree ("company_id","sprint_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sprints_company_number_idx" ON "sprints" USING btree ("company_id","sprint_number");--> statement-breakpoint
CREATE INDEX "sprints_company_status_idx" ON "sprints" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_identifier_idx" ON "tasks" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_company_task_number_idx" ON "tasks" USING btree ("company_id","task_number");--> statement-breakpoint
CREATE INDEX "tasks_company_status_idx" ON "tasks" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "tasks_company_role_status_idx" ON "tasks" USING btree ("company_id","assigned_role","status");--> statement-breakpoint
CREATE INDEX "tasks_company_sprint_status_idx" ON "tasks" USING btree ("company_id","sprint_id","status");--> statement-breakpoint
CREATE INDEX "tasks_company_parent_idx" ON "tasks" USING btree ("company_id","parent_task_id");--> statement-breakpoint
CREATE INDEX "tasks_assigned_agent_idx" ON "tasks" USING btree ("assigned_agent_id");--> statement-breakpoint
CREATE INDEX "tasks_checkout_run_idx" ON "tasks" USING btree ("checkout_run_id");--> statement-breakpoint
CREATE INDEX "tasks_execution_run_idx" ON "tasks" USING btree ("execution_run_id");--> statement-breakpoint
CREATE INDEX "tasks_title_search_idx" ON "tasks" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_active_claim_idx" ON "tasks" USING btree ("id") WHERE checkout_run_id IS NOT NULL AND status IN ('claimed','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_company_idx" ON "workspaces" USING btree ("company_id");--> statement-breakpoint

-- pgvector approximate-nearest-neighbour index on memory embeddings.
-- ivfflat with cosine distance; tune `lists` later as row count grows.
CREATE INDEX IF NOT EXISTS "memory_embeddings_embedding_idx"
  ON "memory_embeddings" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);--> statement-breakpoint

-- Shared updated_at trigger. One function, many triggers.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER set_updated_at_companies BEFORE UPDATE ON "companies" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_agents BEFORE UPDATE ON "agents" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_sprints BEFORE UPDATE ON "sprints" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_workspaces BEFORE UPDATE ON "workspaces" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_tasks BEFORE UPDATE ON "tasks" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_meetings BEFORE UPDATE ON "meetings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_approvals BEFORE UPDATE ON "approvals" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_role_trust BEFORE UPDATE ON "role_trust" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_skill_artifacts BEFORE UPDATE ON "skill_artifacts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_memory_units BEFORE UPDATE ON "memory_units" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_priming_states BEFORE UPDATE ON "priming_states" FOR EACH ROW EXECUTE FUNCTION set_updated_at();