/**
 * pgvector store integration test.
 * Requires: SUPABASE_DB_URL set + pgvector extension + migration 001 applied.
 *
 * Run: npx tsx src/backends/pgvector.test.ts
 *
 * Skips gracefully if database is not configured.
 */
import { isDatabaseConfigured, getDb, closeDbConnections } from "@arceus/db";
import { sql } from "drizzle-orm";
import { embed, cosineSimilarity, EMBEDDING_DIM } from "./embedding.js";
import {
  PgVectorStaticStore,
  PgVectorDynamicStore,
  PgVectorProceduralStore,
  PgVectorPrimingStore,
  setMemoryEmbedding,
} from "./pgvector/index.js";
import type { MemoryUnit, Habit, PrimingState } from "@arceus/contracts";

// Use deterministic UUIDs so tests are idempotent and cleanable
const TEST_COMPANY_ID = "00000000-0000-4000-a000-000000000001";
const TEST_AGENT_ID = "00000000-0000-4000-a000-000000000002";

function makeMemoryUnit(id: string, content: string, type: "static" | "dynamic" = "static"): MemoryUnit {
  return {
    id,
    companyId: TEST_COMPANY_ID,
    agentId: TEST_AGENT_ID,
    sourceTaskId: null,
    sourceArtifactId: null,
    type,
    visibility: "private",
    source: "task_completion",
    content,
    summary: content.slice(0, 200),
    confidence: 0.85,
    tags: [],
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
}

async function setupTestFixtures() {
  const db = getDb();
  // memory_units has FKs to companies and agents — insert test rows
  await db.execute(sql`
    INSERT INTO companies (id, name, status)
    VALUES (${TEST_COMPANY_ID}, 'Test Company', 'active')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO agents (id, company_id, name, role, status)
    VALUES (${TEST_AGENT_ID}, ${TEST_COMPANY_ID}, 'Test Agent', 'developer', 'idle')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup() {
  const db = getDb();
  await db.execute(sql`DELETE FROM memory_units WHERE company_id = ${TEST_COMPANY_ID}`);
  await db.execute(sql`DELETE FROM habits WHERE company_id = ${TEST_COMPANY_ID}`);
  await db.execute(sql`DELETE FROM priming_state WHERE company_id = ${TEST_COMPANY_ID}`);
  await db.execute(sql`DELETE FROM agents WHERE id = ${TEST_AGENT_ID}`);
  await db.execute(sql`DELETE FROM companies WHERE id = ${TEST_COMPANY_ID}`);
}

async function run() {
  if (!isDatabaseConfigured()) {
    console.log("⏭ Skipping pgvector tests — SUPABASE_DB_URL not set.");
    return;
  }

  // Verify pgvector extension and tables exist
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1 FROM memory_units LIMIT 0`);
    await db.execute(sql`SELECT 1 FROM habits LIMIT 0`);
    await db.execute(sql`SELECT 1 FROM priming_state LIMIT 0`);
  } catch (err: any) {
    console.log(`⏭ Skipping — tables not created yet. Run migration 001 first. (${err.message})`);
    return;
  }

  console.log("=== pgvector Store Integration Tests ===\n");

  await cleanup();
  await setupTestFixtures();

  try {
    // ---------------------------------------------------------------
    // Test 1: Static store — insert and list
    // ---------------------------------------------------------------
    console.log("1. StaticStore: insert and list...");
    const staticStore = new PgVectorStaticStore();

    const mem1 = makeMemoryUnit("00000000-0000-4000-a000-000000000010", "Framework: Next.js 15 with App Router");
    const mem2 = makeMemoryUnit("00000000-0000-4000-a000-000000000011", "Database: Supabase PostgreSQL with pgvector");
    const mem3 = makeMemoryUnit("00000000-0000-4000-a000-000000000012", "Styling: Tailwind CSS v4");

    await staticStore.add(mem1);
    await staticStore.add(mem2);
    await staticStore.add(mem3);

    const listed = await staticStore.list(TEST_AGENT_ID);
    assert(listed.length === 3, `Expected 3 static memories, got ${listed.length}`);
    console.log("   ✓ 3 static memories inserted and listed");

    // ---------------------------------------------------------------
    // Test 2: Set embeddings and search by similarity
    // ---------------------------------------------------------------
    console.log("\n2. StaticStore: embedding search...");
    const [emb1, emb2, emb3] = await Promise.all([
      embed(mem1.content),
      embed(mem2.content),
      embed(mem3.content),
    ]);

    await setMemoryEmbedding(mem1.id, emb1);
    await setMemoryEmbedding(mem2.id, emb2);
    await setMemoryEmbedding(mem3.id, emb3);

    // Search for something related to "database" — should rank mem2 highest
    const queryEmb = await embed("PostgreSQL database setup");
    const results = await staticStore.searchByEmbedding(TEST_AGENT_ID, queryEmb, 3);

    assert(results.length === 3, `Expected 3 search results, got ${results.length}`);
    assert(results[0].id === mem2.id, `Expected mem2 (database) first, got ${results[0].id}`);
    assert(results[0].similarity > 0.3, `Expected similarity > 0.3, got ${results[0].similarity}`);
    console.log(`   ✓ Top result: "${results[0].content}" (similarity: ${results[0].similarity.toFixed(4)})`);
    console.log(`   ✓ Results ordered by similarity: ${results.map((r) => r.similarity.toFixed(3)).join(" > ")}`);

    // ---------------------------------------------------------------
    // Test 3: Dynamic store — insert with expiry
    // ---------------------------------------------------------------
    console.log("\n3. DynamicStore: insert and list...");
    const dynamicStore = new PgVectorDynamicStore();

    const dynMem = makeMemoryUnit("00000000-0000-4000-a000-000000000020", "Sprint 1 velocity was 8 points", "dynamic");
    dynMem.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    await dynamicStore.add(dynMem);

    const dynListed = await dynamicStore.list(TEST_AGENT_ID);
    assert(dynListed.length === 1, `Expected 1 dynamic memory, got ${dynListed.length}`);
    assert(dynListed[0].expiresAt !== null, "Expected expiresAt to be set");
    console.log("   ✓ Dynamic memory with expiry inserted");

    // ---------------------------------------------------------------
    // Test 4: Dynamic store — search with decay scoring
    // ---------------------------------------------------------------
    console.log("\n4. DynamicStore: decay-scored search...");
    const dynEmb = await embed(dynMem.content);
    await setMemoryEmbedding(dynMem.id, dynEmb);

    const dynQuery = await embed("Sprint velocity and team performance");
    const dynResults = await dynamicStore.searchByEmbedding(TEST_AGENT_ID, dynQuery, 5);

    assert(dynResults.length === 1, `Expected 1 dynamic result, got ${dynResults.length}`);
    // Just inserted, so decay should be ~1.0
    assert(dynResults[0].decayedScore > 0.1, `Expected decayedScore > 0.1, got ${dynResults[0].decayedScore}`);
    console.log(`   ✓ Decayed score: ${dynResults[0].decayedScore.toFixed(4)} (similarity: ${dynResults[0].similarity.toFixed(4)})`);

    // ---------------------------------------------------------------
    // Test 5: Procedural store — habits CRUD
    // ---------------------------------------------------------------
    console.log("\n5. ProceduralStore: habits...");
    const proceduralStore = new PgVectorProceduralStore();

    const habit: Habit = {
      id: "habit_test_1",
      companyId: TEST_COMPANY_ID,
      agentId: TEST_AGENT_ID,
      name: "Zod validation on API routes",
      description: "Always add Zod input validation to API route handlers",
      trigger: "When writing API routes",
      action: "Add Zod schema validation for request body",
      status: "active",
      usageCount: 0,
      successRate: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await proceduralStore.add(habit);
    const habits = await proceduralStore.list(TEST_AGENT_ID);
    assert(habits.length === 1, `Expected 1 habit, got ${habits.length}`);
    console.log("   ✓ Habit inserted and listed");

    // Token match
    const matched = await proceduralStore.findMatching(TEST_AGENT_ID, "Build user authentication API routes");
    assert(matched.length === 1, `Expected 1 matched habit, got ${matched.length}`);
    console.log("   ✓ Habit matched by token overlap");

    const notMatched = await proceduralStore.findMatching(TEST_AGENT_ID, "Design the landing page layout");
    assert(notMatched.length === 0, `Expected 0 matched habits, got ${notMatched.length}`);
    console.log("   ✓ Habit correctly NOT matched for unrelated task");

    // Increment usage
    await proceduralStore.incrementUsage(TEST_AGENT_ID, [habit.id]);
    const updatedHabits = await proceduralStore.list(TEST_AGENT_ID);
    assert(updatedHabits[0].usageCount === 1, `Expected usageCount 1, got ${updatedHabits[0].usageCount}`);
    console.log("   ✓ Usage count incremented to 1");

    // ---------------------------------------------------------------
    // Test 6: Priming store — get/set
    // ---------------------------------------------------------------
    console.log("\n6. PrimingStore: get/set...");
    const primingStore = new PgVectorPrimingStore();

    const initialPriming = await primingStore.get(TEST_AGENT_ID);
    assert(initialPriming === null, "Expected null priming for new agent");

    const primingState: PrimingState = {
      id: `priming_${TEST_AGENT_ID}`,
      companyId: TEST_COMPANY_ID,
      agentId: TEST_AGENT_ID,
      confidence: 0.65,
      caution: 0.4,
      morale: 0.75,
      lastDisposition: "Confident from recent progress.",
      recentEvents: ["task_1:success", "task_2:success"],
      updatedAt: new Date().toISOString(),
    };

    await primingStore.set(primingState);
    const retrieved = await primingStore.get(TEST_AGENT_ID);
    assert(retrieved !== null, "Expected non-null priming after set");
    assert(Math.abs(retrieved!.confidence - 0.65) < 0.01, `Expected confidence ~0.65, got ${retrieved!.confidence}`);
    assert(retrieved!.recentEvents.length === 2, `Expected 2 events, got ${retrieved!.recentEvents.length}`);
    console.log("   ✓ Priming state stored and retrieved");

    // Upsert — update existing
    await primingStore.set({ ...primingState, confidence: 0.8, morale: 0.9 });
    const updated = await primingStore.get(TEST_AGENT_ID);
    assert(Math.abs(updated!.confidence - 0.8) < 0.01, `Expected confidence ~0.8 after update, got ${updated!.confidence}`);
    console.log("   ✓ Priming upsert works correctly");

    // ---------------------------------------------------------------
    // Test 7: Soft delete does not appear in searches
    // ---------------------------------------------------------------
    console.log("\n7. Soft delete exclusion...");
    const db = getDb();
    await db.execute(sql`
      UPDATE memory_units
      SET deleted_at = now(), delete_reason = 'test_soft_delete'
      WHERE id = ${mem3.id}
    `);

    const afterDelete = await staticStore.list(TEST_AGENT_ID);
    assert(afterDelete.length === 2, `Expected 2 after soft delete, got ${afterDelete.length}`);
    assert(!afterDelete.some((m) => m.id === mem3.id), "Soft-deleted memory should not appear in list");

    const searchAfterDelete = await staticStore.searchByEmbedding(TEST_AGENT_ID, queryEmb, 10);
    assert(!searchAfterDelete.some((m) => m.id === mem3.id), "Soft-deleted memory should not appear in search");
    console.log("   ✓ Soft-deleted memories excluded from list and search");

    // ---------------------------------------------------------------
    // Test 8: setMemoryEmbedding — verify vector stored correctly
    // ---------------------------------------------------------------
    console.log("\n8. Embedding round-trip...");
    const rawResult = await db.execute(sql`
      SELECT embedding::text FROM memory_units WHERE id = ${mem1.id}
    `);
    const storedStr = (rawResult as any)[0]?.embedding;
    assert(storedStr !== null && storedStr !== undefined, "Embedding should be stored");
    // Parse the pgvector format [x,y,z,...] and check dimension
    const storedVec = JSON.parse(storedStr.replace(/^\[/, "[").replace(/\]$/, "]"));
    assert(storedVec.length === EMBEDDING_DIM, `Expected ${EMBEDDING_DIM}-dim stored vector, got ${storedVec.length}`);
    console.log(`   ✓ Embedding stored as ${EMBEDDING_DIM}-dim vector and retrievable`);

    console.log("\n=== All pgvector tests passed ===");
  } finally {
    await cleanup();
    await closeDbConnections();
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

run().catch((err) => {
  console.error("\n✗ TEST FAILED:", err.message);
  closeDbConnections().finally(() => process.exit(1));
});
