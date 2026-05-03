import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
const sql = postgres(process.env.DATABASE_URL);
const r = await sql`select table_schema, table_name from information_schema.tables where table_name in ('companies','memory_units','agents') order by table_schema, table_name`;
console.log(r);
const fk = await sql`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='hippocampus.memory_units'::regclass and contype='f'`;
console.log("memory_units FKs:", fk);
await sql.end();
