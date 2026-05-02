/**
 * Spec 35 — verify team-visibility query change in pgvector.ts.
 *
 * Inserts a kind='team' static memory under agent A and a kind=NULL
 * (private) one, then asserts agent B (same company) sees the team
 * memory and not the private one via list() and searchByEmbedding().
 *
 * Run: npx tsx scripts/verify-team-visibility.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { isDatabaseConfigured, getDb, closeDbConnections } = await import("@arceus/db");
  const { sql } = await import("drizzle-orm");
  const { embed } = await import("../packages/hippocampus/src/backends/embedding.js");
  const { PgVectorStaticStore, setMemoryEmbedding } = await import(
    "../packages/hippocampus/src/backends/pgvector.js"
  );

  if (!isDatabaseConfigured()) {
    console.error("✗ SUPABASE_DB_URL not set");
    process.exit(1);
  }

  const COMPANY_ID = "00000000-0000-4000-a000-0000000000a1";
  const AGENT_A = "00000000-0000-4000-a000-0000000000a2";
  const AGENT_B = "00000000-0000-4000-a000-0000000000a3";
  const TEAM_MEM = "00000000-0000-4000-a000-0000000000a4";
  const PRIV_MEM = "00000000-0000-4000-a000-0000000000a5";

  const db = getDb();

  // Cleanup any prior run.
  await db.execute(sql`DELETE FROM memory_units WHERE company_id = ${COMPANY_ID}`);
  await db.execute(sql`DELETE FROM agents WHERE company_id = ${COMPANY_ID}`);
  await db.execute(sql`DELETE FROM companies WHERE id = ${COMPANY_ID}`);

  await db.execute(sql`
    INSERT INTO companies (id, name, status)
    VALUES (${COMPANY_ID}, 'Spec35 visibility test', 'active')
  `);
  await db.execute(sql`
    INSERT INTO agents (id, company_id, role, display_name)
    VALUES
      (${AGENT_A}, ${COMPANY_ID}, 'ceo', 'Agent A'),
      (${AGENT_B}, ${COMPANY_ID}, 'cto', 'Agent B')
  `);
  await db.execute(sql`
    INSERT INTO memory_units (id, company_id, agent_id, content, type, kind, container, tags, confidence, relevance_score)
    VALUES
      (${TEAM_MEM}, ${COMPANY_ID}, ${AGENT_A}, 'Team-shared decision: ship Friday', 'static', 'team',
       ${`company:${COMPANY_ID}:agent:${AGENT_A}`}, ARRAY[]::text[], 0.9, 1.0),
      (${PRIV_MEM}, ${COMPANY_ID}, ${AGENT_A}, 'Private note: I am unsure', 'static', NULL,
       ${`company:${COMPANY_ID}:agent:${AGENT_A}`}, ARRAY[]::text[], 0.9, 1.0)
  `);

  const teamEmb = await embed("Team-shared decision: ship Friday");
  const privEmb = await embed("Private note: I am unsure");
  await setMemoryEmbedding(TEAM_MEM, teamEmb);
  await setMemoryEmbedding(PRIV_MEM, privEmb);

  const store = new PgVectorStaticStore();
  let failed = 0;
  const check = (cond: boolean, msg: string) => {
    if (cond) {
      console.log(`  ✓ ${msg}`);
    } else {
      console.log(`  ✗ ${msg}`);
      failed++;
    }
  };

  console.log("agent B → list():");
  const bList = await store.list(AGENT_B);
  check(bList.some((m) => m.id === TEAM_MEM), "sees team memory");
  check(!bList.some((m) => m.id === PRIV_MEM), "does NOT see agent A's private memory");

  console.log("agent B → searchByEmbedding():");
  const q = await embed("when do we ship");
  const bSearch = await store.searchByEmbedding(AGENT_B, q, 10);
  check(bSearch.some((m) => m.id === TEAM_MEM), "search includes team memory");
  check(!bSearch.some((m) => m.id === PRIV_MEM), "search excludes private memory");

  console.log("agent A → list() (owner sees both):");
  const aList = await store.list(AGENT_A);
  check(aList.some((m) => m.id === TEAM_MEM), "sees own team memory");
  check(aList.some((m) => m.id === PRIV_MEM), "sees own private memory");

  // Cleanup.
  await db.execute(sql`DELETE FROM memory_units WHERE company_id = ${COMPANY_ID}`);
  await db.execute(sql`DELETE FROM agents WHERE company_id = ${COMPANY_ID}`);
  await db.execute(sql`DELETE FROM companies WHERE id = ${COMPANY_ID}`);
  await closeDbConnections();

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n✓ Spec 35 team-visibility verified");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
