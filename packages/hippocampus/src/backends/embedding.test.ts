/**
 * Embedding backend verification.
 * Run: npx tsx src/backends/embedding.test.ts
 */
import { embed, embedBatch, cosineSimilarity, EMBEDDING_DIM } from "./embedding.js";

async function run() {
  console.log("=== Embedding Backend Test ===\n");

  // Test 1: Single embed returns correct dimension
  console.log("1. Single embed...");
  const vec = await embed("Next.js 15 with App Router");
  assert(vec.length === EMBEDDING_DIM, `Expected ${EMBEDDING_DIM} dims, got ${vec.length}`);
  console.log(`   ✓ ${EMBEDDING_DIM}-dim vector`);

  // Test 2: Vectors are normalized (magnitude ≈ 1.0)
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  assert(Math.abs(magnitude - 1.0) < 0.01, `Expected magnitude ~1.0, got ${magnitude}`);
  console.log(`   ✓ Normalized (magnitude = ${magnitude.toFixed(4)})`);

  // Test 3: Similar texts have high cosine similarity
  console.log("\n2. Similarity: similar texts...");
  const vecA = await embed("Add user authentication with JWT tokens");
  const vecB = await embed("Implement login and signup with JSON web tokens");
  const simAB = cosineSimilarity(vecA, vecB);
  assert(simAB > 0.5, `Expected similarity > 0.5, got ${simAB}`);
  console.log(`   ✓ Similar texts: ${simAB.toFixed(4)} (> 0.5)`);

  // Test 4: Dissimilar texts have low cosine similarity
  console.log("\n3. Similarity: dissimilar texts...");
  const vecC = await embed("Deploy PostgreSQL database with pgvector extension");
  const vecD = await embed("The weather in Tokyo is sunny today");
  const simCD = cosineSimilarity(vecC, vecD);
  assert(simCD < 0.3, `Expected similarity < 0.3, got ${simCD}`);
  console.log(`   ✓ Dissimilar texts: ${simCD.toFixed(4)} (< 0.3)`);

  // Test 5: Self-similarity is 1.0
  const selfSim = cosineSimilarity(vecA, vecA);
  assert(Math.abs(selfSim - 1.0) < 0.001, `Expected self-similarity ~1.0, got ${selfSim}`);
  console.log(`   ✓ Self-similarity: ${selfSim.toFixed(4)}`);

  // Test 6: Batch embed
  console.log("\n4. Batch embed...");
  const batch = await embedBatch([
    "Framework: Next.js 15",
    "Database: Supabase PostgreSQL",
    "Styling: Tailwind CSS",
  ]);
  assert(batch.length === 3, `Expected 3 vectors, got ${batch.length}`);
  assert(batch.every((v) => v.length === EMBEDDING_DIM), "All vectors should be 384-dim");
  console.log(`   ✓ 3 vectors, all ${EMBEDDING_DIM}-dim`);

  // Test 7: Empty batch
  const empty = await embedBatch([]);
  assert(empty.length === 0, `Expected 0 vectors, got ${empty.length}`);
  console.log(`   ✓ Empty batch returns []`);

  // Test 8: Cosine similarity edge case — zero vector
  const zeroVec = new Array(EMBEDDING_DIM).fill(0);
  const zeroSim = cosineSimilarity(zeroVec, vecA);
  assert(zeroSim === 0, `Expected 0 for zero vector, got ${zeroSim}`);
  console.log(`   ✓ Zero vector → similarity 0`);

  console.log("\n=== All tests passed ===");
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

run().catch((err) => {
  console.error("\n✗ TEST FAILED:", err.message);
  process.exit(1);
});
