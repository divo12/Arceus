import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
const sql = postgres(process.env.DATABASE_URL);
const cols = await sql`select column_name, data_type from information_schema.columns where table_schema='public' and table_name='agents' order by ordinal_position`;
console.log("agents columns:");
cols.forEach(c => console.log("  ", c.column_name, c.data_type));
await sql.end();
