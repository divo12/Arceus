-- Migration 008: drop legacy service_registry table.
--
-- The per-company tool catalog has been removed. Tool enforcement is
-- now performed by the OpenCode plugin against BeatContext.allowedTools,
-- which is built fresh per beat in beat-context-builder.ts. The static
-- arceus tool list lives in code (no DB persistence).

DROP TABLE IF EXISTS arceus.service_registry CASCADE;
