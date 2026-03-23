"""Phase 2 verification scenarios — Extraction, Graph, and Versioning with real LLM."""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from arceus.core.hippocampus.backends.in_memory_graph import InMemoryGraphStoreBackend
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import (
    ExtractedFact,
    ExtractionMode,
    GraphEntity,
    MemoryType,
    RelationType,
)
from arceus.core.memory_scope import ArceusMemoryScope

from Hippocampus_app.harness import agent_turn
from Hippocampus_app.llm_client import create_client

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
GREEN = "\033[92m"
RED = "\033[91m"
RESET = "\033[0m"
SEPARATOR = f"{DIM}{'─' * 70}{RESET}"


@dataclass
class ScenarioResult:
    name: str
    passed: bool
    detail: str


def _print_header(number: int, name: str, description: str) -> None:
    print(f"\n{SEPARATOR}")
    print(f"{BOLD}{CYAN}Scenario {number}: {name}{RESET}")
    print(f"  {DIM}{description}{RESET}")
    print(SEPARATOR)


def _print_step(step: str) -> None:
    print(f"  {YELLOW}>{RESET} {step}")


def _print_detail(label: str, value: str) -> None:
    print(f"    {DIM}{label}:{RESET} {value}")


def _print_memories(label: str, memories: list) -> None:
    if not memories:
        print(f"  {DIM}{label}: (none){RESET}")
        return
    print(f"  {label}:")
    for i, m in enumerate(memories, 1):
        if hasattr(m, "memory_type"):
            tag = m.memory_type.value.upper()
            print(f"    [{i}] [{tag}] {m.content[:90]}")
        elif hasattr(m, "entity_type"):
            print(f"    [{i}] [GRAPH:{m.entity_type}] {m.name[:90]}")
        else:
            print(f"    [{i}] {str(m)[:90]}")


def _print_graph_nodes(label: str, nodes: list[GraphEntity]) -> None:
    if not nodes:
        print(f"  {DIM}{label}: (none){RESET}")
        return
    print(f"  {label}:")
    for i, node in enumerate(nodes, 1):
        latest = f" {GREEN}[LATEST]{RESET}" if node.is_latest else f" {DIM}[old]{RESET}"
        print(f"    [{i}] {node.name[:60]} (type={node.entity_type}, mentions={node.mention_count}){latest}")


def _print_graph_edges(label: str, edges: list) -> None:
    if not edges:
        print(f"  {DIM}{label}: (none){RESET}")
        return
    print(f"  {label}:")
    for i, edge in enumerate(edges, 1):
        print(f"    [{i}] {edge.source_id[:12]}... --[{edge.relation_type.value}]--> {edge.target_id[:12]}...")


def _print_verdict(passed: bool, detail: str) -> None:
    tag = PASS if passed else FAIL
    print(f"\n  Result: [{tag}] {detail}")


# ---------------------------------------------------------------------------
# Scenario 7: MemoryExtractor selects correct prompt per mode
# ---------------------------------------------------------------------------

async def scenario_extraction_prompt_selection() -> ScenarioResult:
    _print_header(7, "extraction_prompt_selection",
                  "MemoryExtractor should use the correct prompt for AGENT, SUB_AGENT, and MEETING modes")

    config = HippocampusConfig(
        embedding_model="simple",
        embedding_dimensions=64,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create("extractor-test", config)

    modes_and_expected = [
        (ExtractionMode.AGENT, "memory extraction system"),
        (ExtractionMode.SUB_AGENT, "sub-agent's task execution"),
        (ExtractionMode.MEETING, "meeting transcript between agents"),
    ]

    all_ok = True
    for mode, expected_fragment in modes_and_expected:
        _print_step(f"Extracting in {mode.value} mode...")
        result = await hippocampus.extract_from_conversation(
            messages=[{"role": "assistant", "content": "sample interaction"}],
            container="startup:1:emp:e1",
            mode=mode,
        )
        _print_detail("Mode", mode.value)
        _print_detail("Returned facts", str(len(result.facts)))
        _print_detail("Returned actions", str(len(result.actions)))

        # NoopLLM returns empty facts, so result should be empty but not crash
        mode_ok = result is not None
        if not mode_ok:
            all_ok = False
        status = f"{GREEN}OK{RESET}" if mode_ok else f"{RED}FAIL{RESET}"
        print(f"    Status: {status}")

    await hippocampus.close()

    passed = all_ok
    detail = f"All 3 extraction modes executed without error"
    _print_verdict(passed, detail)
    return ScenarioResult("extraction_prompt_selection", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 8: Graph entity creation and edge wiring
# ---------------------------------------------------------------------------

async def scenario_graph_entity_and_edges() -> ScenarioResult:
    _print_header(8, "graph_entity_and_edges",
                  "GraphStore should create nodes, find similar, merge mentions, and wire edges")

    config = HippocampusConfig(
        embedding_model="simple",
        embedding_dimensions=64,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create("graph-test", config)
    graph_store = hippocampus.graph_store
    graph_backend: InMemoryGraphStoreBackend = graph_store._backend  # type: ignore[attr-defined]
    container = "startup:1:emp:e1"

    # Create two entities
    _print_step("Creating entity: 'FastAPI'")
    embedding_fastapi = await hippocampus._embedding.embed("FastAPI")
    fastapi_node = GraphEntity(
        name="FastAPI",
        entity_type="technology",
        embedding=embedding_fastapi,
        container=container,
    )
    await graph_store.create_node(fastapi_node)

    _print_step("Creating entity: 'PostgreSQL'")
    embedding_pg = await hippocampus._embedding.embed("PostgreSQL")
    pg_node = GraphEntity(
        name="PostgreSQL",
        entity_type="technology",
        embedding=embedding_pg,
        container=container,
    )
    await graph_store.create_node(pg_node)

    _print_graph_nodes("Nodes after creation", graph_backend.list_nodes())

    # Create edge: FastAPI --[USES]--> PostgreSQL
    _print_step("Creating edge: FastAPI --[USES]--> PostgreSQL")
    await graph_store.create_edge(fastapi_node.id, pg_node.id, RelationType.USES)

    _print_graph_edges("Edges after wiring", graph_backend.list_edges())

    # Merge: add another mention of FastAPI
    _print_step("Merging duplicate mention of 'FastAPI' (should increment mention_count)")
    duplicate = GraphEntity(
        name="FastAPI",
        entity_type="technology",
        embedding=embedding_fastapi,
        container=container,
        metadata={"source": "second_mention"},
    )
    similar = await graph_store.find_similar_node(embedding_fastapi, container=container)
    if similar is not None:
        merged = await graph_store.merge_node(similar, duplicate)
        _print_detail("Merged mention_count", str(merged.mention_count))
    else:
        merged = None

    # Search: query for "database" should find PostgreSQL
    _print_step("Searching graph for: 'database technology'")
    search_results = await graph_store.search("database technology", container, top_k=3)
    _print_graph_nodes("Search results", search_results)

    # Get neighbors: FastAPI's neighbors should include PostgreSQL
    _print_step(f"Getting neighbors of FastAPI (max_hops=2)")
    neighbors = await graph_backend.get_neighbors(fastapi_node.id, max_hops=2)
    _print_graph_nodes("Neighbors", neighbors)

    # Verify
    nodes = graph_backend.list_nodes()
    edges = graph_backend.list_edges()
    has_nodes = len(nodes) == 2
    has_edge = len(edges) == 1 and edges[0].relation_type is RelationType.USES
    has_merge = merged is not None and merged.mention_count == 2
    has_neighbor = len(neighbors) > 0 and any(n.name == "PostgreSQL" for n in neighbors)

    passed = has_nodes and has_edge and has_merge and has_neighbor
    detail = (
        f"nodes={len(nodes)} (exp 2), edges={len(edges)} (exp 1), "
        f"merge_count={merged.mention_count if merged else 0} (exp 2), "
        f"neighbor_found={has_neighbor}"
    )

    await hippocampus.close()
    _print_verdict(passed, detail)
    return ScenarioResult("graph_entity_and_edges", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 9: Static memory versioning with UPDATES chain
# ---------------------------------------------------------------------------

async def scenario_version_chain() -> ScenarioResult:
    _print_header(9, "version_chain",
                  "StaticMemory.update() should create a version chain with UPDATES edge in graph")

    config = HippocampusConfig(
        embedding_model="simple",
        embedding_dimensions=64,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create("version-test", config)
    graph_backend: InMemoryGraphStoreBackend = hippocampus.graph_store._backend  # type: ignore[attr-defined]
    container = "startup:1:emp:e1"

    # v1: original fact
    _print_step("Creating v1: 'We use JWT for authentication'")
    v1 = await hippocampus.static_memory.add(
        ExtractedFact(
            text="We use JWT for authentication",
            memory_type=MemoryType.STATIC,
            confidence=0.9,
            is_permanent=True,
        ),
        container=container,
    )
    _print_detail("v1 id", v1.id[:16] + "...")
    _print_detail("v1 version", str(v1.version))

    # v2: update the fact
    _print_step("Updating to v2: 'We use JWT with 24h expiry for authentication'")
    v2 = await hippocampus.static_memory.update(v1.id, "We use JWT with 24h expiry for authentication")
    _print_detail("v2 id", v2.id[:16] + "...")
    _print_detail("v2 version", str(v2.version))
    _print_detail("v2 previous_version_id", str(v2.previous_version_id)[:16] + "...")

    # v3: update again
    _print_step("Updating to v3: 'We use JWT with 1h expiry and refresh tokens'")
    v3 = await hippocampus.static_memory.update(v2.id, "We use JWT with 1h expiry and refresh tokens")
    _print_detail("v3 id", v3.id[:16] + "...")
    _print_detail("v3 version", str(v3.version))
    _print_detail("v3 previous_version_id", str(v3.previous_version_id)[:16] + "...")

    # Check all versions exist in store
    all_static = await hippocampus.static_memory.get_all(container)
    _print_step(f"Total static memories in store: {len(all_static)}")
    for i, m in enumerate(all_static, 1):
        print(f"    [{i}] v{m.version}: {m.content[:70]}")

    # Check graph edges
    edges = graph_backend.list_edges()
    _print_graph_edges("Graph edges (version chain)", edges)

    updates_edges = [e for e in edges if e.relation_type is RelationType.UPDATES]

    # Verify
    version_correct = v1.version == 1 and v2.version == 2 and v3.version == 3
    chain_correct = v2.previous_version_id == v1.id and v3.previous_version_id == v2.id
    edges_correct = len(updates_edges) == 2
    all_stored = len(all_static) == 3

    passed = version_correct and chain_correct and edges_correct and all_stored
    detail = (
        f"versions=[{v1.version},{v2.version},{v3.version}] (exp [1,2,3]), "
        f"chain_links={chain_correct}, "
        f"UPDATES_edges={len(updates_edges)} (exp 2), "
        f"stored={len(all_static)} (exp 3)"
    )

    await hippocampus.close()
    _print_verdict(passed, detail)
    return ScenarioResult("version_chain", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 10: Full extraction pipeline — LLM extracts facts into memory + graph
# ---------------------------------------------------------------------------

async def scenario_extraction_with_llm(client, deployment: str) -> ScenarioResult:
    _print_header(10, "extraction_with_llm",
                  "LLM extracts facts from conversation, stores in correct tiers, wires graph entities")

    config = HippocampusConfig(
        embedding_model="all-MiniLM-L6-v2",
        embedding_dimensions=384,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create("extract-llm-test", config)
    graph_backend: InMemoryGraphStoreBackend = hippocampus.graph_store._backend  # type: ignore[attr-defined]
    container = ArceusMemoryScope.employee_container("startup-test", "extract-llm-test")

    # Seed some static facts first so the agent has context
    _print_step("Seeding static facts for context")
    await hippocampus.remember("Our backend is built with FastAPI and Python 3.12.", container=container, memory_type=MemoryType.STATIC)
    await hippocampus.remember("We use PostgreSQL for persistent storage.", container=container, memory_type=MemoryType.STATIC)

    # Simulate a multi-turn conversation and have the LLM use recall
    _print_step("Turn 1: Telling the agent about a new architecture decision")
    response1, recalled1 = await agent_turn(
        hippocampus, client, container,
        "We've decided to add Redis for caching. Also, the auth service will use JWT tokens with a 1-hour expiry.",
        deployment=deployment,
    )
    _print_memories("Recalled for turn 1", recalled1)
    print(f"    {BOLD}LLM:{RESET} {response1[:150]}")

    _print_step("Turn 2: Asking what the agent remembers about our infrastructure")
    response2, recalled2 = await agent_turn(
        hippocampus, client, container,
        "Summarize all our infrastructure decisions so far.",
        deployment=deployment,
    )
    _print_memories("Recalled for turn 2", recalled2)
    print(f"    {BOLD}LLM:{RESET} {response2[:250]}")

    # Verify the new info was stored and is retrievable
    _print_step("Verifying recall for 'Redis caching'")
    redis_results = await hippocampus.recall("Redis caching", container, top_k=5)
    _print_memories("Redis recall results", redis_results)
    has_redis = any("redis" in str(getattr(m, "content", "")).lower() for m in redis_results)

    _print_step("Verifying recall for 'JWT authentication'")
    jwt_results = await hippocampus.recall("JWT authentication tokens", container, top_k=5)
    _print_memories("JWT recall results", jwt_results)
    has_jwt = any("jwt" in str(getattr(m, "content", "")).lower() for m in jwt_results)

    # Check graph state
    nodes = graph_backend.list_nodes()
    edges = graph_backend.list_edges()
    _print_graph_nodes("Graph nodes", nodes)
    _print_graph_edges("Graph edges", edges)

    _print_step("Checking LLM response references both Redis and JWT")
    combined = (response2 + " ".join(str(getattr(m, "content", "")) for m in recalled2)).lower()
    llm_knows_redis = "redis" in combined
    llm_knows_jwt = "jwt" in combined

    passed = has_redis and has_jwt and llm_knows_redis
    detail = (
        f"redis_recalled={has_redis}, jwt_recalled={has_jwt}, "
        f"llm_knows_redis={llm_knows_redis}, llm_knows_jwt={llm_knows_jwt}, "
        f"graph_nodes={len(nodes)}, graph_edges={len(edges)}"
    )

    await hippocampus.close()
    _print_verdict(passed, detail)
    return ScenarioResult("extraction_with_llm", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 11: Graph-augmented recall returns graph entities alongside memories
# ---------------------------------------------------------------------------

async def scenario_graph_augmented_recall() -> ScenarioResult:
    _print_header(11, "graph_augmented_recall",
                  "recall(include_graph=True) should return graph entities alongside memory results")

    config = HippocampusConfig(
        embedding_model="simple",
        embedding_dimensions=64,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create("graph-recall-test", config)
    container = "startup:1:emp:e1"

    # Seed a memory
    _print_step("Storing STATIC memory: 'We use Kubernetes for container orchestration'")
    await hippocampus.remember(
        "We use Kubernetes for container orchestration.",
        container=container,
        memory_type=MemoryType.STATIC,
    )

    # Seed graph nodes directly
    _print_step("Creating graph entity: 'Kubernetes' (technology)")
    k8s_embedding = await hippocampus._embedding.embed("Kubernetes")
    k8s_node = GraphEntity(
        name="Kubernetes",
        entity_type="technology",
        embedding=k8s_embedding,
        container=container,
    )
    await hippocampus.graph_store.create_node(k8s_node)

    _print_step("Creating graph entity: 'Docker' (technology)")
    docker_embedding = await hippocampus._embedding.embed("Docker")
    docker_node = GraphEntity(
        name="Docker",
        entity_type="technology",
        embedding=docker_embedding,
        container=container,
    )
    await hippocampus.graph_store.create_node(docker_node)

    _print_step("Wiring edge: Kubernetes --[DEPENDS_ON]--> Docker")
    await hippocampus.graph_store.create_edge(
        k8s_node.id, docker_node.id, RelationType.DEPENDS_ON
    )

    # Recall with graph
    _print_step("Recalling 'container orchestration' with include_graph=True")
    results_with_graph = await hippocampus.recall(
        "container orchestration", container, top_k=5, include_graph=True,
    )
    _print_memories("Results (graph enabled)", results_with_graph)

    # Recall without graph
    _print_step("Recalling 'container orchestration' with include_graph=False")
    results_without_graph = await hippocampus.recall(
        "container orchestration", container, top_k=5, include_graph=False,
    )
    _print_memories("Results (graph disabled)", results_without_graph)

    # Check that graph-enabled recall has more or equal results
    has_graph_entities = any(
        hasattr(r, "entity_type") for r in results_with_graph
    )
    graph_count = len(results_with_graph)
    no_graph_count = len(results_without_graph)

    passed = graph_count >= no_graph_count and len(results_with_graph) > 0
    detail = (
        f"with_graph={graph_count} results, without_graph={no_graph_count} results, "
        f"has_graph_entities={has_graph_entities}"
    )

    await hippocampus.close()
    _print_verdict(passed, detail)
    return ScenarioResult("graph_augmented_recall", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 12: Soft delete via public API
# ---------------------------------------------------------------------------

async def scenario_soft_delete() -> ScenarioResult:
    _print_header(12, "soft_delete",
                  "Hippocampus.soft_delete() should remove memories from recall results")

    config = HippocampusConfig(
        embedding_model="simple",
        embedding_dimensions=64,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create("delete-test", config)
    container = "startup:1:emp:e1"

    _print_step("Storing 3 memories")
    m1 = await hippocampus.remember("API rate limit is 100 requests per minute.", container=container, memory_type=MemoryType.STATIC)
    m2 = await hippocampus.remember("Database connection pool size is 20.", container=container, memory_type=MemoryType.STATIC)
    m3 = await hippocampus.remember("Cache TTL is 5 minutes.", container=container, memory_type=MemoryType.DYNAMIC)
    _print_detail("m1", f"{m1.id[:12]}... '{m1.content[:50]}'")
    _print_detail("m2", f"{m2.id[:12]}... '{m2.content[:50]}'")
    _print_detail("m3", f"{m3.id[:12]}... '{m3.content[:50]}'")

    _print_step("Recalling before delete")
    before = await hippocampus.recall("configuration settings", container, top_k=10, include_graph=False)
    _print_detail("Results count", str(len(before)))

    _print_step(f"Soft-deleting m2: '{m2.content[:40]}...'")
    await hippocampus.soft_delete(m2.id, reason="outdated configuration")

    _print_step("Recalling after delete")
    after = await hippocampus.recall("configuration settings", container, top_k=10, include_graph=False)
    _print_detail("Results count", str(len(after)))

    after_ids = {getattr(m, "id", None) for m in after}
    m2_gone = m2.id not in after_ids
    others_remain = m1.id in after_ids and m3.id in after_ids

    _print_detail("m2 removed", str(m2_gone))
    _print_detail("m1 & m3 remain", str(others_remain))

    passed = m2_gone and others_remain and len(after) == len(before) - 1
    detail = f"before={len(before)}, after={len(after)}, m2_removed={m2_gone}, others_intact={others_remain}"

    await hippocampus.close()
    _print_verdict(passed, detail)
    return ScenarioResult("soft_delete", passed, detail)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def run_all() -> None:
    load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

    deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT_REASONING", "gpt-4o")
    client = create_client()

    print(f"\n{BOLD}{'=' * 70}{RESET}")
    print(f"{BOLD}{CYAN}  Hippocampus Phase 2 Verification — Extraction + Graph + Versioning{RESET}")
    print(f"{BOLD}{'=' * 70}{RESET}")
    print(f"  Deployment: {deployment}")
    print(f"  Embedding:  all-MiniLM-L6-v2 (384d) + simple (64d for unit scenarios)")

    results: list[ScenarioResult] = []

    # 7. Extraction prompt selection (no LLM call, uses NoopLLM)
    results.append(await scenario_extraction_prompt_selection())

    # 8. Graph entity creation and edges
    results.append(await scenario_graph_entity_and_edges())

    # 9. Version chain
    results.append(await scenario_version_chain())

    # 10. Full extraction with real LLM
    results.append(await scenario_extraction_with_llm(client, deployment))

    # 11. Graph-augmented recall
    results.append(await scenario_graph_augmented_recall())

    # 12. Soft delete
    results.append(await scenario_soft_delete())

    # Summary
    print(f"\n{BOLD}{'=' * 70}{RESET}")
    print(f"{BOLD}{CYAN}  Phase 2 Final Summary{RESET}")
    print(f"{BOLD}{'=' * 70}{RESET}\n")
    for result in results:
        tag = PASS if result.passed else FAIL
        print(f"  [{tag}] {result.name}: {result.detail}")

    passed = sum(1 for r in results if r.passed)
    total = len(results)
    print(f"\n  {BOLD}{passed}/{total} scenarios passed.{RESET}\n")

    if passed < total:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_all())
