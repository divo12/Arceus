import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
const sql = postgres(process.env.DATABASE_URL);
const r = await sql`select column_name, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='agents' order by ordinal_position`;
console.log(r);
await sql.end();
