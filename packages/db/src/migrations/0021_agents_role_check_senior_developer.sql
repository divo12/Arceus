ALTER TABLE "agents" DROP CONSTRAINT "agents_role_check";
ALTER TABLE "agents" ADD CONSTRAINT "agents_role_check" CHECK ("agents"."role" IN ('ceo','cto','pm','developer','senior_developer','tester','ui_designer','marketing','skills_lead') OR "agents"."is_internal" = true);
