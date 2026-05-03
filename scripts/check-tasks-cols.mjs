import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
const sql = postgres(process.env.DATABASE_URL);
const cols = await sql`select column_name from information_schema.columns where table_schema='public' and table_name='tasks' order by ordinal_position`;
console.log("tasks columns:", cols.map(c => c.column_name));
const fk = await sql`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.tasks'::regclass and contype='f'`;
console.log("tasks FKs:", fk);
await sql.end();
