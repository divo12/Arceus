import dotenv from 'dotenv';
import postgres from 'postgres';
dotenv.config({ path: '.env.local' });

const url = process.env.SUPABASE_DB_URL || process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL || process.env.DATABASE_URL;
if (!url) { console.log('NO URL'); process.exit(1); }

const sql = postgres(url);
try {
  const r = await sql.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='hippocampus' AND table_name='company_states' ORDER BY ordinal_position`);
  console.log('company_states columns:', r.map((x: any) => x.column_name).join(', '));

  const r2 = await sql.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='hippocampus' AND table_name='audit_events' ORDER BY ordinal_position`);
  console.log('audit_events columns:', r2.map((x: any) => x.column_name).join(', '));
} catch (e: any) {
  console.error('Error:', e.message);
}
await sql.end();
