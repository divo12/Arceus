CREATE TABLE "meeting_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"content" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text DEFAULT 'attendee' NOT NULL,
	"joined_at" timestamp with time zone,
	"contribution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"agenda" jsonb,
	"scheduled_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"linked_issue_id" uuid,
	"linked_routine_id" uuid,
	"initiated_by_agent_id" uuid,
	"initiated_by_user_id" text,
	"meeting_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_events" ADD CONSTRAINT "meeting_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_events" ADD CONSTRAINT "meeting_events_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_events" ADD CONSTRAINT "meeting_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_linked_routine_id_routines_id_fk" FOREIGN KEY ("linked_routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_initiated_by_agent_id_agents_id_fk" FOREIGN KEY ("initiated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_events_meeting_seq_idx" ON "meeting_events" USING btree ("meeting_id","seq");--> statement-breakpoint
CREATE INDEX "meeting_events_company_kind_idx" ON "meeting_events" USING btree ("company_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_participants_meeting_agent_uq" ON "meeting_participants" USING btree ("meeting_id","agent_id");--> statement-breakpoint
CREATE INDEX "meeting_participants_company_agent_idx" ON "meeting_participants" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "meetings_company_type_idx" ON "meetings" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX "meetings_company_status_idx" ON "meetings" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "meetings_company_scheduled_idx" ON "meetings" USING btree ("company_id","scheduled_at");