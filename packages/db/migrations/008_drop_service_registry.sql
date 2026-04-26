-- Migration 008: drop legacy service_registry table.
--
-- The per-company tool catalog has been removed. Tool enforcement is
-- now performed by the OpenCode plugin against BeatContext.allowedTools,
-- which is built fresh per beat in beat-context-builder.ts. The static
-- arceus tool list lives in code (no DB persistence).

-- The table was created at different times in different schemas:
--   public        — drizzle/spec-31 path (current location on local + supabase)
--   hippocampus   — legacy migration 003_service_registry.sql (still present on supabase)
-- Drop both. CASCADE handles any leftover FKs we don't know about.
DROP TABLE IF EXISTS public.service_registry CASCADE;
DROP TABLE IF EXISTS hippocampus.service_registry CASCADE;
