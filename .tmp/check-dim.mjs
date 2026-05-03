import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const r = await sql`select format_type(atttypid, atttypmod) as t from pg_attribute where attrelid='hippocampus.memory_units'::regclass and attname='embedding'`;
console.log(r);
const r2 = await sql`select count(*) from hippocampus.memory_units`;
console.log("rows:", r2);
await sql.end();
