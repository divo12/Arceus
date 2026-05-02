import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
try {
  const vec = Array.from({ length: 384 }, () => Math.random());
  // Try the same shape as drizzle's cosineDistance binding
  const r = await sql`select 1 - (embedding <=> ${vec}) as sim from hippocampus.memory_units limit 1`;
  console.log("OK", r);
} catch (e) {
  console.log("ERR:", e.code, e.message);
  console.log("hint:", e.hint, "where:", e.where);
}
await sql.end();
