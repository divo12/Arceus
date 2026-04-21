import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../.env.local') });

const postgres = (await import('postgres')).default;
const sql = postgres(process.env.DATABASE_URL);

// 1. Find companies with meeting data
const rows = await sql`
  SELECT company_id, jsonb_array_length(snapshot_data->'meetings') as meeting_count
  FROM hippocampus.company_states
  WHERE jsonb_array_length(snapshot_data->'meetings') > 0
  ORDER BY meeting_count DESC
  LIMIT 5
`;

console.log("=== Companies with meetings ===");
console.log(JSON.stringify(rows, null, 2));

if (rows.length > 0) {
  // 2. Find meetings with actual resolutions (conflicts resolved)
  const resolvedRows = await sql`
    SELECT cs.company_id, m
    FROM hippocampus.company_states cs,
         jsonb_array_elements(cs.snapshot_data->'meetings') AS m
    WHERE jsonb_array_length(cs.snapshot_data->'meetings') > 0
      AND m->'resolutions' IS NOT NULL
      AND m->>'resolutions' != 'null'
    ORDER BY m->>'createdAt' DESC
    LIMIT 2
  `;
  console.log(`\n=== Meetings with resolutions: ${resolvedRows.length} ===`);
  for (const row of resolvedRows) {
    console.log(`\n========== RESOLVED MEETING (${row.company_id}) ==========`);
    console.log(JSON.stringify(row.m, null, 2));
  }

  // 3. Find escalation meetings
  const escalationRows = await sql`
    SELECT cs.company_id, m
    FROM hippocampus.company_states cs,
         jsonb_array_elements(cs.snapshot_data->'meetings') AS m
    WHERE jsonb_array_length(cs.snapshot_data->'meetings') > 0
      AND m->>'type' = 'escalation'
    ORDER BY m->>'createdAt' DESC
    LIMIT 2
  `;
  console.log(`\n\n=== Escalation meetings: ${escalationRows.length} ===`);
  for (const row of escalationRows) {
    console.log(`\n========== ESCALATION MEETING (${row.company_id}) ==========`);
    console.log(JSON.stringify(row.m, null, 2));
  }

  // 4. Find meetings with non-empty synthesis.conflicts or synthesis.blockers
  const conflictRows = await sql`
    SELECT cs.company_id, m
    FROM hippocampus.company_states cs,
         jsonb_array_elements(cs.snapshot_data->'meetings') AS m
    WHERE jsonb_array_length(cs.snapshot_data->'meetings') > 0
      AND (
        jsonb_array_length(m->'synthesis'->'conflicts') > 0
        OR jsonb_array_length(m->'synthesis'->'blockers') > 0
      )
    ORDER BY m->>'createdAt' DESC
    LIMIT 2
  `;
  console.log(`\n\n=== Meetings with conflicts/blockers: ${conflictRows.length} ===`);
  for (const row of conflictRows) {
    console.log(`\n========== CONFLICT MEETING (${row.company_id}) ==========`);
    console.log(JSON.stringify(row.m, null, 2));
  }

  // 5. Also grab meeting schedules from the richest company
  const companyId = rows[0].company_id;
  const schedRows = await sql`
    SELECT s
    FROM hippocampus.company_states,
         jsonb_array_elements(snapshot_data->'meetingSchedules') AS s
    WHERE company_id = ${companyId}
    LIMIT 3
  `;
  console.log(`\n\n=== Meeting Schedules (${companyId}) ===`);
  for (const row of schedRows) {
    console.log(JSON.stringify(row.s, null, 2));
  }
}

await sql.end();
