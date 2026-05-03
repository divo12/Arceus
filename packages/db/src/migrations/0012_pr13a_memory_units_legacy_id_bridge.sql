ALTER TABLE "memory_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(384);--> statement-breakpoint
ALTER TABLE "memory_units" ADD COLUMN "legacy_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_units_legacy_id_idx" ON "memory_units" USING btree ("legacy_id") WHERE "memory_units"."legacy_id" IS NOT NULL;