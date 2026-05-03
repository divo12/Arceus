import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });
async function main() {
  const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL!;
  if (!url) { console.log("NO URL"); return; }
  const sql = postgres(url, { onnotice: () => {} });
  try {
    const r = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='heartbeat_runs' ORDER BY column_name`;
    console.log("heartbeat_runs columns:", r.map((c: any) => c.column_name).join(", "));
  } catch (e: any) {
    console.log("err1:", e?.message);
  }
  try {
    const r = await sql`SELECT id, company_id, agent_id, beat_number, trigger, trigger_detail, status, cause, session_id, trust_band, verdict_score, verdict_outcome, verdict_signals, total_tokens, total_cost_cents, tool_call_count, process_pid, process_started_at, retry_of_run_id, process_loss_retry_count, started_at, finished_at, created_at FROM heartbeat_runs WHERE status = 'running' AND started_at < NOW() LIMIT 1`;
    console.log("full select ok rows:", r.length);
  } catch (e: any) {
    console.log("FULL SELECT ERR code=", e?.code, "msg=", e?.message, "detail=", e?.detail, "hint=", e?.hint);
  }
  await sql.end();
}
main().catch(e => { console.error(e); process.exit(1); });
