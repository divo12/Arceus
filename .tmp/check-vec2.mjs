import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
try {
  const vec = Array.from({ length: 384 }, () => Math.random());
  const vecStr = JSON.stringify(vec);
  const r = await sql`select 1 - (embedding <=> ${vecStr}) as sim from hippocampus.memory_units where agent_id is not null limit 1`;
  console.log("OK", r);
} catch (e) {
  console.log("ERR:", e.code, e.message);
}
await sql.end();
