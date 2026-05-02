import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";
const u = process.env.SUPABASE_DB_URL;
console.log("url ok:", !!u);
const p = postgres(u, { max: 1, connect_timeout: 5 });
try {
  const r = await p`select now()`;
  console.log("OK", r);
  process.exit(0);
} catch (e) {
  console.error("ERR", e.message);
  process.exit(1);
}
