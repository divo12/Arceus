import { PgVectorStaticStore, PgVectorDynamicStore } from "../packages/hippocampus/src/backends/pgvector.ts";
import { embed } from "../packages/hippocampus/src/backends/embedding.ts";

async function main() {
  const store = new PgVectorStaticStore();
  const v = await embed("hello world test");
  // Try with a known agent_id from existing data
  const { getDb } = await import("../packages/db/src/client.ts");
  const { sql } = await import("drizzle-orm");
  const db = getDb();
  const r = await db.execute(sql`select agent_id from hippocampus.memory_units where deleted_at is null limit 1`);
  const aid = (r as any)[0]?.agent_id;
  console.log("test agent_id:", aid);
  try {
    const rows = await store.searchByEmbedding(`agent_${aid}`, v, 3);
    console.log("OK rows:", rows.length);
  } catch (e: any) {
    console.log("STATIC ERR top:", e.name, e.message?.slice(0,150));
    console.log("STATIC code:", e.code, "cause.code:", e.cause?.code, "cause.msg:", e.cause?.message?.slice(0,200));
  }
  const dyn = new PgVectorDynamicStore();
  try {
    const rows = await dyn.searchByEmbedding(`agent_${aid}`, v, 3);
    console.log("OK dyn rows:", rows.length);
  } catch (e: any) {
    console.log("DYN ERR top:", e.name, e.message?.slice(0,150));
    console.log("DYN code:", e.code, "cause.code:", e.cause?.code, "cause.msg:", e.cause?.message?.slice(0,200));
  }
  process.exit(0);
}
main();
