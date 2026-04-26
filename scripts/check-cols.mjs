import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
const sql = postgres(process.env.DATABASE_URL);
for (const t of ["heartbeat_runs", "agents"]) {
  const cols = await sql`select column_name from information_schema.columns where table_schema='public' and table_name=${t} order by ordinal_position`;
  console.log(t, ":", cols.map(c => c.column_name));
}
await sql.end();
