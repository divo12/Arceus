import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
const sql = postgres(process.env.DATABASE_URL);
try {
  const c = await sql`select id, friendly_id, name, status from companies order by created_at desc limit 5`;
  console.log("companies:", c);
  const t = await sql`select id, friendly_id, company_id, status from tasks order by created_at desc limit 5`;
  console.log("tasks:", t);
  const s = await sql`select id, friendly_id, company_id, status from sprints order by created_at desc limit 5`;
  console.log("sprints:", s);
} catch (e) {
  console.error("ERR:", e.message, "code=", e.code);
}
await sql.end();
