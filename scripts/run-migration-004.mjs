import dotenv from 'dotenv';
import postgres from 'postgres';
dotenv.config({ path: '.env.local' });

const url = process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL;
const sql = postgres(url);

try {
  // beat_records table
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS hippocampus.beat_records (
    id              TEXT PRIMARY KEY,
    company_id      TEXT NOT NULL,
    agent_id        TEXT,
    beat_number     INTEGER NOT NULL,
    trigger         JSONB NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running',
    snapshot_version_read    INTEGER,
    snapshot_version_written INTEGER,
    phases          JSONB NOT NULL DEFAULT '{}',
    outcome         TEXT,
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_cents      NUMERIC(12,4) NOT NULL DEFAULT 0,
    error_message   TEXT,
    summary         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  console.log('✓ beat_records table');

  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_beat_records_company_agent ON hippocampus.beat_records (company_id, agent_id, started_at DESC)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_beat_records_company_number ON hippocampus.beat_records (company_id, beat_number DESC)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_beat_records_running ON hippocampus.beat_records (status) WHERE status = 'running'`);
  console.log('✓ beat_records indexes');

  await sql.unsafe(`ALTER TABLE hippocampus.audit_events ADD COLUMN IF NOT EXISTS beat_id TEXT`);
  console.log('✓ audit_events.beat_id added');

  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_audit_events_beat ON hippocampus.audit_events (beat_id) WHERE beat_id IS NOT NULL`);
  console.log('✓ audit_events beat index');

  await sql.unsafe(`ALTER TABLE hippocampus.company_states ADD COLUMN IF NOT EXISTS snapshot_version INTEGER NOT NULL DEFAULT 0`);
  console.log('✓ company_states.snapshot_version added');

  // Verify
  const r = await sql.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='hippocampus' AND table_name='company_states' ORDER BY ordinal_position`);
  console.log('company_states columns:', r.map(x => x.column_name).join(', '));

  const r2 = await sql.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='hippocampus' AND table_name='audit_events' ORDER BY ordinal_position`);
  console.log('audit_events columns:', r2.map(x => x.column_name).join(', '));

} catch (e) {
  console.error('Error:', e.message);
}
await sql.end();
