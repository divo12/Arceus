-- Migration 001b: Fix hippocampus memory table schema placement
-- Original 001 created memory_units / habits / priming_state without a schema
-- prefix, so they landed in `public` while drizzle reads from
-- `hippocampus.*` (per ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA). This moves the
-- tables (preserving data, indexes, triggers, constraints) into `hippocampus`.
--
-- Idempotent: only moves tables that exist in public and are not yet in
-- hippocampus. Safe to re-run.

BEGIN;

CREATE SCHEMA IF NOT EXISTS hippocampus;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='memory_units')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hippocampus' AND table_name='memory_units') THEN
    EXECUTE 'ALTER TABLE public.memory_units SET SCHEMA hippocampus';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='habits')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hippocampus' AND table_name='habits') THEN
    EXECUTE 'ALTER TABLE public.habits SET SCHEMA hippocampus';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='priming_state')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hippocampus' AND table_name='priming_state') THEN
    EXECUTE 'ALTER TABLE public.priming_state SET SCHEMA hippocampus';
  END IF;
END
$$;

COMMIT;
