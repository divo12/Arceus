"""Phase 3 verification scenarios — Delegation, Profiles, Projections, PromotionEngine."""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from arceus.core.delegation_memory import DelegationMemoryManager
from arceus.core.hippocampus.backends.in_memory_graph import InMemoryGraphStoreBackend
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import (
    MemoryType,
    MemoryUnit,
    RelationType,
)
from arceus.core.hippocampus.utils.time import utc_now
from arceus.core.memory_projections import ArceusMemoryProjections
from arceus.core.memory_scope import ArceusMemoryScope
from arceus.core.profile_engine import ArceusProfileEngine

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
        else:
            print(f"    [{i}] {str(m)[:90]}")


def _print_verdict(passed: bool, detail: str) -> None:
    tag = PASS if passed else FAIL
    print(f"\n  Result: [{tag}] {detail}")


def _make_config(embedding: str = "simple", dims: int = 64) -> HippocampusConfig:
    return HippocampusConfig(
        embedding_model=embedding,
        embedding_dimensions=dims,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
        extraction_model="noop",
        lightweight_model="noop",
    )


# ---------------------------------------------------------------------------
# Scenario 13: Delegation — memories copied from delegator to delegatee
# ---------------------------------------------------------------------------

async def scenario_delegation_copy() -> ScenarioResult:
    _print_header(13, "delegation_copy",
                  "DelegationMemoryManager copies delegator memories into task-scoped container")

    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    config = _make_config()
    from_hippo = await Hippocampus.create("cto-1", config)
    to_hippo = await Hippocampus.create("eng-1", config)

    from_container = scope.employee_container("startup-1", "cto-1")

    try:
        _print_step("CTO stores 3 memories in personal container")
        await from_hippo.remember("We use JWT for authentication", container=from_container, memory_type=MemoryType.STATIC)
        await from_hippo.remember("Auth rollout needs refresh-token metrics", container=from_container, memory_type=MemoryType.DYNAMIC)
        await from_hippo.remember("Redis caches session tokens", container=from_container, memory_type=MemoryType.STATIC)

        _print_step("Delegating task 'JWT refresh tokens' from CTO to Engineer")
        copied = await manager.prepare_delegation_context(
            from_hippocampus=from_hippo,
            to_hippocampus=to_hippo,
            from_agent_id="cto-1",
            to_agent_id="eng-1",
            startup_id="startup-1",
            task_id="task-42",
            task_description="JWT refresh tokens authentication",
        )
        _print_detail("Copied memories", str(len(copied)))
        for c in copied:
            _print_detail(f"  [{c.memory_type.value}]", c.content[:80])

        _print_step("Engineer recalls in task scope")
        task_container = scope.task_container("startup-1", "task-42")
        recalled = await to_hippo.recall("JWT auth refresh tokens", container=task_container, top_k=10, include_graph=False)
        _print_memories("Engineer's task-scoped recall", recalled)

        # All copies should be DYNAMIC (delegation downgrades static → dynamic)
        all_dynamic = all(m.memory_type is MemoryType.DYNAMIC for m in copied)
        # Delegation metadata should be persisted
        all_have_metadata = all(m.source_type == "delegation" and m.metadata.get("delegated_from") == "cto-1" for m in copied)
        # Should have at least 2 relevant memories (JWT + refresh tokens)
        has_recalled = len(recalled) >= 2

        passed = all_dynamic and all_have_metadata and has_recalled
        detail = (
            f"copied={len(copied)}, all_dynamic={all_dynamic}, "
            f"metadata_ok={all_have_metadata}, recalled={len(recalled)}"
        )
    finally:
        await from_hippo.close()
        await to_hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("delegation_copy", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 14: Delegation copies are independent — mutating one doesn't affect other
# ---------------------------------------------------------------------------

async def scenario_delegation_isolation() -> ScenarioResult:
    _print_header(14, "delegation_isolation",
                  "Delegated copies get new IDs and don't reference originals")

    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    config = _make_config()
    from_hippo = await Hippocampus.create("cto-1", config)
    to_hippo = await Hippocampus.create("eng-1", config)

    from_container = scope.employee_container("startup-1", "cto-1")

    try:
        _print_step("CTO stores a memory")
        original = await from_hippo.remember(
            "Stripe webhooks drive payment notifications",
            container=from_container,
            memory_type=MemoryType.STATIC,
        )
        _print_detail("Original ID", original.id[:16] + "...")

        _print_step("Delegating to engineer")
        copied = await manager.prepare_delegation_context(
            from_hippocampus=from_hippo,
            to_hippocampus=to_hippo,
            from_agent_id="cto-1",
            to_agent_id="eng-1",
            startup_id="startup-1",
            task_id="task-43",
            task_description="payment notifications",
        )

        _print_detail("Copy ID", copied[0].id[:16] + "..." if copied else "(none)")

        ids_differ = len(copied) == 1 and copied[0].id != original.id

        _print_step("Soft-deleting original from CTO's memory")
        await from_hippo.soft_delete(original.id, reason="test")

        _print_step("Engineer should still recall the copy")
        task_container = scope.task_container("startup-1", "task-43")
        recalled = await to_hippo.recall("payment notifications", container=task_container, top_k=5, include_graph=False)
        copy_survives = len(recalled) == 1

        passed = ids_differ and copy_survives
        detail = f"ids_differ={ids_differ}, copy_survives_deletion={copy_survives}"
    finally:
        await from_hippo.close()
        await to_hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("delegation_isolation", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 15: Internalize delegation results based on quality
# ---------------------------------------------------------------------------

async def scenario_internalize_quality() -> ScenarioResult:
    _print_header(15, "internalize_quality",
                  "High quality (>=0.9) → STATIC, medium (0.6-0.9) → DYNAMIC, low (<0.6) → skipped")

    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    config = _make_config()
    hippo = await Hippocampus.create("cto-1", config)
    container = scope.employee_container("startup-1", "cto-1")

    try:
        _print_step("Internalizing high quality (0.95) learning")
        await manager.internalize_delegation_result(
            delegator_hippocampus=hippo,
            delegator_agent_id="cto-1",
            startup_id="startup-1",
            learnings=["Keep JWT expiry aligned with session windows"],
            quality=0.95,
        )

        _print_step("Internalizing medium quality (0.70) learning")
        await manager.internalize_delegation_result(
            delegator_hippocampus=hippo,
            delegator_agent_id="cto-1",
            startup_id="startup-1",
            learnings=["Track auth rollout blockers daily"],
            quality=0.70,
        )

        _print_step("Internalizing low quality (0.50) learning — should be skipped")
        await manager.internalize_delegation_result(
            delegator_hippocampus=hippo,
            delegator_agent_id="cto-1",
            startup_id="startup-1",
            learnings=["Ignore this low-confidence note"],
            quality=0.50,
        )

        _print_step("Recalling all learnings")
        results = await hippo.recall("JWT expiry auth rollout blockers", container=container, top_k=10, include_graph=False)
        _print_memories("Internalized memories", results)

        content_types = {m.content: m.memory_type for m in results}
        _print_detail("JWT expiry type", str(content_types.get("Keep JWT expiry aligned with session windows", "NOT FOUND")))
        _print_detail("Auth rollout type", str(content_types.get("Track auth rollout blockers daily", "NOT FOUND")))

        high_is_static = content_types.get("Keep JWT expiry aligned with session windows") is MemoryType.STATIC
        medium_is_dynamic = content_types.get("Track auth rollout blockers daily") is MemoryType.DYNAMIC
        low_not_stored = not any("low-confidence" in m.content for m in results)

        passed = high_is_static and medium_is_dynamic and low_not_stored
        detail = f"high_static={high_is_static}, medium_dynamic={medium_is_dynamic}, low_skipped={low_not_stored}"
    finally:
        await hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("internalize_quality", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 16: EmployeeProfile generation from memory tiers
# ---------------------------------------------------------------------------

async def scenario_profile_generation() -> ScenarioResult:
    _print_header(16, "profile_generation",
                  "ArceusProfileEngine generates profile with core_knowledge (static) and current_context (dynamic)")

    scope = ArceusMemoryScope()
    engine = ArceusProfileEngine(scope)
    config = _make_config()
    hippo = await Hippocampus.create("cto-1", config)
    container = scope.employee_container("startup-1", "cto-1")

    try:
        _print_step("Storing 2 STATIC and 2 DYNAMIC memories")
        await hippo.remember("We use JWT for authentication", container=container, memory_type=MemoryType.STATIC)
        await hippo.remember("Our API uses REST with OpenAPI docs", container=container, memory_type=MemoryType.STATIC)
        await hippo.remember("Sprint 12 focuses on auth refresh tokens", container=container, memory_type=MemoryType.DYNAMIC)
        await hippo.remember("Team velocity is 42 points this week", container=container, memory_type=MemoryType.DYNAMIC)

        _print_step("Generating profile for CTO")
        profile = await engine.generate_profile(
            hippocampus=hippo,
            agent_id="cto-1",
            startup_id="startup-1",
            role="CTO",
        )

        _print_detail("Role", profile.role)
        _print_detail("Core knowledge", str(len(profile.core_knowledge)))
        for ck in profile.core_knowledge:
            _print_detail("  ", ck[:80])
        _print_detail("Current context", str(len(profile.current_context)))
        for cc in profile.current_context:
            _print_detail("  ", cc[:80])
        _print_detail("Habits (Phase 4 stub)", str(len(profile.habits)))
        _print_detail("State (Phase 4 stub)", str(len(profile.state)))

        passed = (
            profile.role == "CTO"
            and len(profile.core_knowledge) == 2
            and len(profile.current_context) == 2
            and profile.habits == []
            and profile.state == {}
        )
        detail = (
            f"role={profile.role}, core={len(profile.core_knowledge)}, "
            f"context={len(profile.current_context)}, habits={len(profile.habits)}"
        )
    finally:
        await hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("profile_generation", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 17: MemorySummaryProjection via dashboard projections
# ---------------------------------------------------------------------------

async def scenario_summary_projection() -> ScenarioResult:
    _print_header(17, "summary_projection",
                  "ArceusMemoryProjections.get_summary() returns correct counts by tier")

    projections = ArceusMemoryProjections()
    config = _make_config()
    hippo = await Hippocampus.create("cto-1", config)
    scope = ArceusMemoryScope()
    container = scope.employee_container("startup-1", "cto-1")

    try:
        _print_step("Storing 3 STATIC and 2 DYNAMIC memories")
        await hippo.remember("Fact A", container=container, memory_type=MemoryType.STATIC)
        await hippo.remember("Fact B", container=container, memory_type=MemoryType.STATIC)
        await hippo.remember("Fact C", container=container, memory_type=MemoryType.STATIC)
        await hippo.remember("Context D", container=container, memory_type=MemoryType.DYNAMIC)
        await hippo.remember("Context E", container=container, memory_type=MemoryType.DYNAMIC)

        summary = await projections.get_summary(hippo)
        _print_detail("Agent ID", summary.agent_id)
        _print_detail("Static count", str(summary.static_fact_count))
        _print_detail("Dynamic count", str(summary.dynamic_fact_count))

        passed = (
            summary.agent_id == "cto-1"
            and summary.static_fact_count == 3
            and summary.dynamic_fact_count == 2
        )
        detail = f"agent={summary.agent_id}, static={summary.static_fact_count}, dynamic={summary.dynamic_fact_count}"
    finally:
        await hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("summary_projection", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 18: Graph view projection for dashboard
# ---------------------------------------------------------------------------

async def scenario_graph_view_projection() -> ScenarioResult:
    _print_header(18, "graph_view_projection",
                  "ArceusMemoryProjections.get_graph_view() returns center node + neighbors")

    projections = ArceusMemoryProjections()
    config = _make_config()
    hippo = await Hippocampus.create("cto-1", config)
    scope = ArceusMemoryScope()
    container = scope.employee_container("startup-1", "cto-1")

    try:
        from arceus.core.hippocampus.types import GraphEntity

        _print_step("Creating graph nodes: JWT, AuthService, TokenRefresher")
        jwt_emb = await hippo._embedding.embed("JWT")
        auth_emb = await hippo._embedding.embed("AuthService")
        refresh_emb = await hippo._embedding.embed("TokenRefresher")

        jwt_node = GraphEntity(name="JWT", entity_type="technology", embedding=jwt_emb, container=container)
        auth_node = GraphEntity(name="AuthService", entity_type="service", embedding=auth_emb, container=container)
        refresh_node = GraphEntity(name="TokenRefresher", entity_type="service", embedding=refresh_emb, container=container)

        await hippo.graph_store.create_node(jwt_node)
        await hippo.graph_store.create_node(auth_node)
        await hippo.graph_store.create_node(refresh_node)

        _print_step("Wiring edges: JWT --USES--> AuthService, AuthService --DEPENDS_ON--> TokenRefresher")
        await hippo.graph_store.create_edge(jwt_node.id, auth_node.id, RelationType.USES)
        await hippo.graph_store.create_edge(auth_node.id, refresh_node.id, RelationType.DEPENDS_ON)

        _print_step("Getting graph view centered on 'JWT'")
        view = await projections.get_graph_view(hippocampus=hippo, query="JWT", container=container, depth=2)

        _print_detail("Center node", view.center_node.name if view.center_node else "(none)")
        _print_detail("Total nodes", str(len(view.nodes)))
        for n in view.nodes:
            _print_detail(f"  [{n.entity_type}]", n.name)
        _print_detail("Edges", str(len(view.edges)))

        has_center = view.center_node is not None and view.center_node.name == "JWT"
        has_neighbors = len(view.nodes) >= 2
        has_edges = len(view.edges) >= 1

        passed = has_center and has_neighbors and has_edges
        detail = f"center={view.center_node.name if view.center_node else None}, nodes={len(view.nodes)}, edges={len(view.edges)}"
    finally:
        await hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("graph_view_projection", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 19: PromotionEngine — qualifying memory gets promoted
# ---------------------------------------------------------------------------

async def scenario_promotion_engine() -> ScenarioResult:
    _print_header(19, "promotion_engine",
                  "PromotionEngine promotes a qualifying DYNAMIC memory to STATIC with graph edge")

    config = _make_config()
    hippo = await Hippocampus.create("agent-1", config)
    graph_backend: InMemoryGraphStoreBackend = hippo.graph_store._backend  # type: ignore[attr-defined]

    try:
        _print_step("Inserting a qualifying DYNAMIC memory (high usage, old, high confidence)")
        qualifying_mem = MemoryUnit(
            agent_id="agent-1",
            content="JWT auth is our standard authentication method",
            embedding=await hippo._embedding.embed("JWT auth standard"),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.9,
            container="startup:1:emp:agent-1",
            metadata={"usage_count": 15},
            created_at=utc_now() - timedelta(days=20),
            updated_at=utc_now() - timedelta(days=20),
        )
        await hippo._vector_store.upsert(qualifying_mem)

        _print_step("Running promotion cycle")
        events = await hippo.run_promotions()

        _print_detail("Promotion events", str(len(events)))
        for ev in events:
            _print_detail(f"  {ev.memory_id[:16]}...", f"{ev.from_type} → {ev.to_type}: {ev.reason[:60]}")

        _print_step("Checking vector store for new STATIC memory")
        static_list = await hippo._vector_store.list_by_type("agent-1", memory_type=MemoryType.STATIC)
        _print_detail("Static memories", str(len(static_list)))

        _print_step("Checking original DYNAMIC was soft-deleted")
        original = await hippo._vector_store.get(qualifying_mem.id)
        _print_detail("Original still exists?", str(original is not None))

        _print_step("Checking PROMOTED_FROM graph edge")
        edges = graph_backend.list_edges()
        promoted_edges = [e for e in edges if e.relation_type is RelationType.PROMOTED_FROM]
        _print_detail("PROMOTED_FROM edges", str(len(promoted_edges)))

        has_event = len(events) == 1
        has_static = len(static_list) == 1 and static_list[0].memory_type is MemoryType.STATIC
        original_gone = original is None
        has_graph_edge = len(promoted_edges) == 1

        passed = has_event and has_static and original_gone and has_graph_edge
        detail = (
            f"events={len(events)}, static={len(static_list)}, "
            f"original_deleted={original_gone}, graph_edges={len(promoted_edges)}"
        )
    finally:
        await hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("promotion_engine", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 20: Promotion blocked by contradiction with existing STATIC
# ---------------------------------------------------------------------------

async def scenario_promotion_contradiction() -> ScenarioResult:
    _print_header(20, "promotion_contradiction",
                  "Promotion is blocked when a contradicting STATIC memory exists (cosine >0.80 + LLM check)")

    config = _make_config()
    hippo = await Hippocampus.create("agent-1", config)

    try:
        # Use identical embedding so cosine similarity = 1.0 (passes the >0.80 pre-filter)
        # This isolates the LLM contradiction check behavior
        shared_embedding = await hippo._embedding.embed("JWT authentication")

        _print_step("Inserting existing STATIC: 'We never use JWT' (with shared embedding)")
        contra_mem = MemoryUnit(
            agent_id="agent-1",
            content="We never use JWT",
            embedding=shared_embedding,
            memory_type=MemoryType.STATIC,
            confidence=1.0,
            container="startup:1:emp:agent-1",
            metadata={"usage_count": 5},
        )
        await hippo._vector_store.upsert(contra_mem)

        _print_step("Inserting qualifying DYNAMIC: 'JWT auth is our standard' (same embedding → cosine=1.0)")
        candidate = MemoryUnit(
            agent_id="agent-1",
            content="JWT auth is our standard authentication method",
            embedding=shared_embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=0.9,
            container="startup:1:emp:agent-1",
            metadata={"usage_count": 15},
            created_at=utc_now() - timedelta(days=20),
            updated_at=utc_now() - timedelta(days=20),
        )
        await hippo._vector_store.upsert(candidate)

        _print_step("Running promotion cycle")
        events = await hippo.run_promotions()
        _print_detail("Promotion events", str(len(events)))

        _print_step("Checking candidate still exists as DYNAMIC")
        still_exists = await hippo._vector_store.get(candidate.id)
        _print_detail("Candidate still in store?", str(still_exists is not None))

        # NoopLLM.classify returns options[0] which is "CONTRADICTION"
        # Cosine = 1.0 passes the pre-filter, so LLM check fires and blocks promotion
        passed = len(events) == 0 and still_exists is not None
        detail = f"events={len(events)} (exp 0), candidate_preserved={still_exists is not None}"
    finally:
        await hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("promotion_contradiction", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 21: Full delegation + LLM integration — delegatee uses delegated context
# ---------------------------------------------------------------------------

async def scenario_delegation_with_llm(client, deployment: str) -> ScenarioResult:
    _print_header(21, "delegation_with_llm",
                  "Delegated memories are used by the LLM agent to answer task-relevant questions")

    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)

    config = HippocampusConfig(
        embedding_model="all-MiniLM-L6-v2",
        embedding_dimensions=384,
        sqlite_path=":memory:",
        graph_store_backend="in_memory",
        extraction_model="noop",
        lightweight_model="noop",
    )
    cto_hippo = await Hippocampus.create("cto-1", config)
    eng_hippo = await Hippocampus.create("eng-1", config)

    cto_container = scope.employee_container("startup-1", "cto-1")
    task_container = scope.task_container("startup-1", "task-50")

    try:
        _print_step("CTO stores domain knowledge")
        await cto_hippo.remember("We use JWT with RS256 signing for all API authentication", container=cto_container, memory_type=MemoryType.STATIC)
        await cto_hippo.remember("Refresh tokens have a 7-day expiry, access tokens 1 hour", container=cto_container, memory_type=MemoryType.STATIC)
        await cto_hippo.remember("Token rotation must be implemented before Q2 security audit", container=cto_container, memory_type=MemoryType.DYNAMIC)

        _print_step("Delegating auth task to engineer")
        copied = await manager.prepare_delegation_context(
            from_hippocampus=cto_hippo,
            to_hippocampus=eng_hippo,
            from_agent_id="cto-1",
            to_agent_id="eng-1",
            startup_id="startup-1",
            task_id="task-50",
            task_description="Implement JWT token rotation for security audit",
        )
        _print_detail("Memories delegated", str(len(copied)))

        _print_step("Engineer asks LLM about the task using delegated context")
        response, recalled = await agent_turn(
            eng_hippo, client, task_container,
            "What are the token expiry settings I should use for the rotation implementation?",
            deployment=deployment,
        )
        _print_memories("Recalled from task scope", recalled)
        print(f"    {BOLD}LLM:{RESET} {response[:250]}")

        combined = (response + " ".join(str(getattr(m, "content", "")) for m in recalled)).lower()
        has_jwt = "jwt" in combined
        has_expiry = "1 hour" in combined or "7-day" in combined or "7 day" in combined or "expir" in combined

        passed = len(copied) >= 2 and has_jwt and has_expiry
        detail = f"delegated={len(copied)}, has_jwt={has_jwt}, has_expiry={has_expiry}"
    finally:
        await cto_hippo.close()
        await eng_hippo.close()

    _print_verdict(passed, detail)
    return ScenarioResult("delegation_with_llm", passed, detail)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def run_all() -> None:
    load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

    deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT_REASONING", "gpt-4o")
    client = create_client()

    print(f"\n{BOLD}{'=' * 70}{RESET}")
    print(f"{BOLD}{CYAN}  Hippocampus Phase 3 Verification — Delegation + Profiles + Projections + Promotion{RESET}")
    print(f"{BOLD}{'=' * 70}{RESET}")
    print(f"  Deployment: {deployment}")
    print(f"  Embedding:  simple (64d) for unit scenarios, all-MiniLM-L6-v2 (384d) for LLM scenarios")

    results: list[ScenarioResult] = []

    # 13. Delegation copy
    results.append(await scenario_delegation_copy())

    # 14. Delegation isolation
    results.append(await scenario_delegation_isolation())

    # 15. Internalize quality thresholds
    results.append(await scenario_internalize_quality())

    # 16. Profile generation
    results.append(await scenario_profile_generation())

    # 17. Summary projection
    results.append(await scenario_summary_projection())

    # 18. Graph view projection
    results.append(await scenario_graph_view_projection())

    # 19. Promotion engine
    results.append(await scenario_promotion_engine())

    # 20. Promotion blocked by contradiction
    results.append(await scenario_promotion_contradiction())

    # 21. Full delegation + LLM integration
    results.append(await scenario_delegation_with_llm(client, deployment))

    # Summary
    print(f"\n{BOLD}{'=' * 70}{RESET}")
    print(f"{BOLD}{CYAN}  Phase 3 Final Summary{RESET}")
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
