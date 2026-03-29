CREATE TABLE "chat_messages" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"company_id" uuid NOT NULL,
"role" text NOT NULL,
"content" text NOT NULL,
"card_type" text,
"card_data" jsonb,
"card_state" jsonb,
"agent_id" uuid,
"metadata" jsonb,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_company_created_idx" ON "chat_messages" USING btree ("company_id","created_at");
