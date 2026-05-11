ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "companies_user_id_idx" ON "companies" ("user_id");
