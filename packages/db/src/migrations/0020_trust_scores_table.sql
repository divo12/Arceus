-- Spec 7.B.5.2-bis — restore the legacy `trust_scores` table.
--
-- The canonical replacement (`role_trust`) is partially wired but
-- `apps/api/src/persistence/control-plane.ts` still reads/writes
-- `trust_scores` for `cpLoadTrustScore` / `cpUpdateTrustScore` /
-- `cpHydrateTrustScores`. Without this table every governance call
-- on startup and on every beat completion logs a `Failed query`
-- warning. The schema mirrors `trustScoresTable` in
-- `packages/db/src/tables.ts`.

CREATE TABLE IF NOT EXISTS "trust_scores" (
  "agent_id" text PRIMARY KEY NOT NULL,
  "score" real NOT NULL DEFAULT 0.5,
  "history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
