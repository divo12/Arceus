import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
const sql = postgres(process.env.DATABASE_URL);
await sql`ALTER TABLE "agents" ALTER COLUMN "soul_prompt_ref" DROP NOT NULL`;
try { await sql`ALTER TABLE "policy_violations" ALTER COLUMN "agent_id" DROP NOT NULL`; } catch (e) { console.log("pv-drop:", e.message); }
try { await sql`ALTER TABLE "policy_violations" ADD COLUMN IF NOT EXISTS "agent_role" text`; } catch (e) { console.log("pv-add:", e.message); }
console.log("OK");
await sql.end();
