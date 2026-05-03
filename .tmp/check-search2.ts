import { getDb } from "../packages/db/src/client.ts";
import { memoryUnitsTable } from "../packages/db/src/memory-tables.ts";
import { sql, eq, and, isNull, desc, cosineDistance } from "drizzle-orm";

async function main() {
  const db = getDb();
  // Pass a wrong-length array to provoke an error
  const v = Array.from({length: 384}, () => Math.random());
  try {
    const sim = sql<number>`1 - (${cosineDistance(memoryUnitsTable.embedding, v as any)})`;
    const rows = await db.select({ id: memoryUnitsTable.id, similarity: sim, all: memoryUnitsTable })
      .from(memoryUnitsTable)
      .where(and(eq(memoryUnitsTable.memoryType, "static"), isNull(memoryUnitsTable.deletedAt)))
      .orderBy(desc(sim))
      .limit(3);
    console.log("OK len:", rows.length);
  } catch (e: any) {
    console.log("=== top-level error ===");
    console.log("name:", e.name);
    console.log("message:", e.message?.slice(0, 200));
    console.log("code:", e.code);
    console.log("=== cause ===");
    console.log("cause:", e.cause);
    console.log("cause.code:", e.cause?.code);
    console.log("cause.message:", e.cause?.message);
  }
  process.exit(0);
}
main();
