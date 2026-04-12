/**
 * Unit tests for the MMR retrieval engine.
 * Pure functions — no database or embedding model needed.
 *
 * Run: npx tsx src/engines/retrieval.test.ts
 */
import { applyBoosts, selectByMMR, rankAndSelect, DEFAULT_RETRIEVAL_OPTIONS } from "./retrieval.js";
import type { RawCandidate } from "./retrieval.js";
import type { MemoryUnit } from "@arceus/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  id: string,
  content: string,
  tier: "static" | "dynamic",
  similarity: number,
  embedding?: number[],
  overrides?: Partial<RawCandidate>,
): RawCandidate {
  return {
    id,
    companyId: "company_1",
    agentId: "agent_1",
    sourceTaskId: null,
    sourceArtifactId: null,
    type: tier,
    visibility: "private",
    source: "task_completion",
    content,
    summary: content.slice(0, 200),
    confidence: 0.8,
    tags: [],
    createdAt: new Date().toISOString(),
    expiresAt: null,
    similarity,
    tier,
    embedding,
    ...overrides,
  };
}

/**
 * Create a simple embedding vector that points in a specific "direction".
 * direction=0 → [1,0,0,...], direction=1 → [0,1,0,...], etc.
 * This lets us control cosine similarity precisely:
 * - Same direction → similarity = 1.0
 * - Orthogonal directions → similarity = 0.0
 */
function makeEmbedding(direction: number, dim: number = 8): number[] {
  const vec = new Array(dim).fill(0);
  vec[direction % dim] = 1.0;
  return vec;
}

/** Mix two directional embeddings to get a known similarity */
function mixEmbeddings(a: number[], b: number[], ratio: number): number[] {
  return a.map((v, i) => v * ratio + b[i] * (1 - ratio));
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testEmptyInput() {
  console.log("1. Empty input returns empty array...");
  const result = rankAndSelect([], "company:1:agent:1");
  assert(result.length === 0, "Expected empty array");
  console.log("   ✓ Empty input handled");
}

function testTierBoosting() {
  console.log("\n2. Tier boosting — static gets 1.5x...");
  const candidates: RawCandidate[] = [
    makeCandidate("mem_static", "Framework: Next.js", "static", 0.6),
    makeCandidate("mem_dynamic", "Sprint velocity was 8", "dynamic", 0.6),
  ];

  const boosted = applyBoosts(candidates, "company:1:agent:1", DEFAULT_RETRIEVAL_OPTIONS);

  const staticBoosted = boosted.find((c) => c.id === "mem_static")!;
  const dynamicBoosted = boosted.find((c) => c.id === "mem_dynamic")!;

  assert(staticBoosted.boostedScore === 0.6 * 1.5, `Expected ${0.6 * 1.5}, got ${staticBoosted.boostedScore}`);
  assert(dynamicBoosted.boostedScore === 0.6 * 1.0, `Expected ${0.6 * 1.0}, got ${dynamicBoosted.boostedScore}`);
  assert(staticBoosted.boostedScore > dynamicBoosted.boostedScore, "Static should rank higher");

  console.log(`   ✓ Static: ${staticBoosted.boostedScore}, Dynamic: ${dynamicBoosted.boostedScore}`);
}

function testDynamicDecayUsed() {
  console.log("\n3. Dynamic memory uses decayedScore when available...");
  const candidates: RawCandidate[] = [
    makeCandidate("mem_old", "Old fact", "dynamic", 0.8, undefined, { decayedScore: 0.2 }),
    makeCandidate("mem_new", "New fact", "dynamic", 0.5, undefined, { decayedScore: 0.5 }),
  ];

  const boosted = applyBoosts(candidates, "", DEFAULT_RETRIEVAL_OPTIONS);
  const old = boosted.find((c) => c.id === "mem_old")!;
  const fresh = boosted.find((c) => c.id === "mem_new")!;

  // Old memory: decayedScore 0.2 × tierBoost 1.0 = 0.2
  assert(Math.abs(old.boostedScore - 0.2) < 0.001, `Expected 0.2, got ${old.boostedScore}`);
  // New memory: decayedScore 0.5 × tierBoost 1.0 = 0.5
  assert(Math.abs(fresh.boostedScore - 0.5) < 0.001, `Expected 0.5, got ${fresh.boostedScore}`);
  assert(fresh.boostedScore > old.boostedScore, "Fresher memory should rank higher");

  console.log(`   ✓ Old (decayed): ${old.boostedScore}, Fresh: ${fresh.boostedScore}`);
}

function testMMRDiversity() {
  console.log("\n4. MMR diversity — avoids redundant selections...");

  // 3 memories about "database" (same direction) + 2 about different topics
  const dbEmb = makeEmbedding(0);
  const frameworkEmb = makeEmbedding(1);
  const stylingEmb = makeEmbedding(2);

  const candidates: RawCandidate[] = [
    makeCandidate("db1", "Supabase PostgreSQL with pgvector", "static", 0.9, dbEmb),
    makeCandidate("db2", "Database connection string in .env", "static", 0.85, dbEmb), // same direction as db1!
    makeCandidate("db3", "PostgreSQL indices on memory_units", "static", 0.8, dbEmb),  // same direction
    makeCandidate("fw1", "Framework: Next.js 15 with App Router", "static", 0.7, frameworkEmb),
    makeCandidate("st1", "Styling: Tailwind CSS v4", "static", 0.6, stylingEmb),
  ];

  // Without MMR (pure relevance), we'd get: db1, db2, db3, fw1, st1
  // With MMR (λ=0.7), after picking db1, the penalty on db2/db3 should push fw1 and st1 up

  const boosted = applyBoosts(candidates, "", DEFAULT_RETRIEVAL_OPTIONS);
  const selected = selectByMMR(boosted, 5, 0.7);

  assert(selected.length === 5, `Expected 5 results, got ${selected.length}`);

  // First pick should still be db1 (highest relevance)
  assert(selected[0].id === "db1", `Expected db1 first, got ${selected[0].id}`);

  // fw1 and st1 should appear before db2 and db3 due to diversity penalty
  const fw1Idx = selected.findIndex((s) => s.id === "fw1");
  const st1Idx = selected.findIndex((s) => s.id === "st1");
  const db2Idx = selected.findIndex((s) => s.id === "db2");
  const db3Idx = selected.findIndex((s) => s.id === "db3");

  console.log(`   Selection order: ${selected.map((s) => s.id).join(" → ")}`);
  console.log(`   Scores: ${selected.map((s) => s.finalScore.toFixed(3)).join(", ")}`);

  // At least one of fw1/st1 should appear before at least one of db2/db3
  const diverseBeforeRedundant = fw1Idx < db3Idx || st1Idx < db3Idx;
  assert(diverseBeforeRedundant, "MMR should prefer diverse memories over redundant ones");

  console.log("   ✓ Diverse topics promoted over redundant database memories");
}

function testTopKLimit() {
  console.log("\n5. topK limit respected...");
  const candidates: RawCandidate[] = [];
  for (let i = 0; i < 10; i++) {
    candidates.push(makeCandidate(`mem_${i}`, `Memory ${i}`, "static", 0.9 - i * 0.05));
  }

  const result = rankAndSelect(candidates, "", { topK: 3 });
  assert(result.length === 3, `Expected 3, got ${result.length}`);
  console.log("   ✓ Returned exactly 3 results from 10 candidates");
}

function testNoEmbeddingsFallback() {
  console.log("\n6. Without embeddings, falls back to pure relevance ranking...");
  const candidates: RawCandidate[] = [
    makeCandidate("a", "High relevance", "static", 0.9),
    makeCandidate("b", "Medium relevance", "static", 0.7),
    makeCandidate("c", "Low relevance", "static", 0.5),
  ];

  // No embeddings → MMR can't compute inter-similarity → maxSimToSelected = 0
  // So mmrScore = lambda * normalizedRelevance, which is just scaled relevance
  const result = rankAndSelect(candidates, "", { topK: 3 });

  assert(result[0].id === "a", `Expected 'a' first, got ${result[0].id}`);
  assert(result[1].id === "b", `Expected 'b' second, got ${result[1].id}`);
  assert(result[2].id === "c", `Expected 'c' third, got ${result[2].id}`);

  console.log("   ✓ Pure relevance order maintained without embeddings");
}

function testSingleCandidate() {
  console.log("\n7. Single candidate returns it...");
  const candidates: RawCandidate[] = [
    makeCandidate("only", "The only memory", "static", 0.5),
  ];

  const result = rankAndSelect(candidates, "");
  assert(result.length === 1, `Expected 1, got ${result.length}`);
  assert(result[0].id === "only", `Expected 'only', got ${result[0].id}`);
  console.log("   ✓ Single candidate returned correctly");
}

function testMixedTiers() {
  console.log("\n8. Mixed tiers — static boost lifts lower-similarity static above dynamic...");
  const candidates: RawCandidate[] = [
    // Dynamic with high similarity but no boost
    makeCandidate("dyn", "Recent sprint update", "dynamic", 0.8),
    // Static with lower similarity but 1.5x boost
    makeCandidate("sta", "Architecture decision", "static", 0.6),
  ];

  const result = rankAndSelect(candidates, "", { topK: 2, lambda: 1.0 }); // lambda=1 = pure relevance

  // Static: 0.6 × 1.5 = 0.9
  // Dynamic: 0.8 × 1.0 = 0.8
  assert(result[0].id === "sta", `Expected static first (0.9 vs 0.8), got ${result[0].id}`);
  console.log(`   ✓ Static (boosted 0.9) beats Dynamic (0.8)`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("=== MMR Retrieval Engine Unit Tests ===\n");

try {
  testEmptyInput();
  testTierBoosting();
  testDynamicDecayUsed();
  testMMRDiversity();
  testTopKLimit();
  testNoEmbeddingsFallback();
  testSingleCandidate();
  testMixedTiers();
  console.log("\n=== All retrieval engine tests passed ===");
} catch (err: any) {
  console.error("\n✗ TEST FAILED:", err.message);
  process.exit(1);
}
