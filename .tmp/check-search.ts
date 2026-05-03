import { embed } from "../packages/hippocampus/src/backends/embedding.ts";
import { getDb } from "../packages/db/src/client.ts";
import { memoryUnitsTable } from "../packages/db/src/memory-tables.ts";
import { sql, eq, and, isNull, desc, cosineDistance } from "drizzle-orm";

async function main() {
  const db = getDb();
  const v = await embed("hello world test");
  console.log("embed len:", v.length);
  try {
    const sim = sql<number>`1 - (${cosineDistance(memoryUnitsTable.embedding, v)})`;
    const rows = await db.select({ id: memoryUnitsTable.id, similarity: sim })
      .from(memoryUnitsTable)
      .where(and(eq(memoryUnitsTable.memoryType, "static"), isNull(memoryUnitsTable.deletedAt)))
      .orderBy(desc(sim))
      .limit(3);
    console.log("OK:", rows);
  } catch (e: any) {
    console.log("ERR code:", e.code, "msg:", e.message);
    console.log("query:", e.query);
    console.log("params:", e.params?.map((p: any) => typeof p === "string" ? p.slice(0,80) : p));
  }
  process.exit(0);
}
main();
