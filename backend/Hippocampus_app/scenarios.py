"""Scripted test scenarios that verify Hippocampus Phase 0/1 via a real LLM."""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType
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


def _print_memories(label: str, memories: list) -> None:
    if not memories:
        print(f"  {DIM}{label}: (none){RESET}")
        return
    print(f"  {label}:")
    for i, m in enumerate(memories, 1):
        tag = m.memory_type.value.upper()
        print(f"    [{i}] [{tag}] {m.content[:90]}")


def _print_verdict(passed: bool, detail: str) -> None:
    tag = PASS if passed else FAIL
    print(f"\n  Result: [{tag}] {detail}")


# ---------------------------------------------------------------------------
# Scenario 1: Static memories are recalled with higher priority
# ---------------------------------------------------------------------------

async def scenario_static_priority(
    hippocampus: Hippocampus,
    client,
    container: str,
    deployment: str,
) -> ScenarioResult:
    _print_header(1, "static_priority", "Static memories should rank above dynamic via tier boost (1.5x)")

    _print_step("Storing STATIC memory: 'tech stack is Python, FastAPI, PostgreSQL, Next.js'")
    await hippocampus.remember(
        "The company tech stack is Python, FastAPI, PostgreSQL, and Next.js.",
        container=container,
        memory_type=MemoryType.STATIC,
    )

    _print_step("Storing DYNAMIC memory: 'discussed switching to Go'")
    await hippocampus.remember(
        "We discussed possibly switching to Go for the backend.",
        container=container,
        memory_type=MemoryType.DYNAMIC,
    )

    _print_step("Asking LLM: 'What is our tech stack?'")
    response, recalled = await agent_turn(
        hippocampus, client, container,
        "What is our tech stack?",
        deployment=deployment,
    )

    _print_memories("Recalled memories", recalled)
    print(f"\n  {BOLD}LLM response:{RESET} {response[:200]}")

    if not recalled:
        _print_verdict(False, "No memories recalled")
        return ScenarioResult("static_priority", False, "No memories recalled")

    first = recalled[0]
    passed = first.memory_type is MemoryType.STATIC
    detail = f"First recalled = {first.memory_type.value.upper()} (expected STATIC)"
    _print_verdict(passed, detail)
    return ScenarioResult("static_priority", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 2: Scope isolation — agent A cannot see agent B memories
# ---------------------------------------------------------------------------

async def scenario_scope_isolation(deployment: str) -> ScenarioResult:
    _print_header(2, "scope_isolation", "Agent A must not see Agent B's memories (container filtering)")

    config = HippocampusConfig(
        embedding_model="simple",
        embedding_dimensions=64,
        sqlite_path=":memory:",
    )

    agent_a = await Hippocampus.create("agent-a", config)
    agent_b = await Hippocampus.create("agent-b", config)

    container_a = ArceusMemoryScope.employee_container("startup-1", "agent-a")
    container_b = ArceusMemoryScope.employee_container("startup-1", "agent-b")

    _print_step(f"Agent A stores in [{container_a}]: 'launch date is March 2027'")
    await agent_a.remember("Agent A secret: launch date is March 2027.", container=container_a)

    _print_step(f"Agent B stores in [{container_b}]: 'budget is $50k'")
    await agent_b.remember("Agent B note: budget is $50k.", container=container_b)

    _print_step("Agent A recalls 'launch date' in OWN scope...")
    a_results = await agent_a.recall("launch date", container=container_a)
    print(f"    Found: {len(a_results)} result(s)")
    for m in a_results:
        print(f"    -> {m.content[:80]}")

    _print_step("Agent A recalls 'budget' in AGENT B's scope...")
    cross_results = await agent_a.recall("budget", container=container_b)
    print(f"    Found: {len(cross_results)} result(s) (should be 0)")

    passed = len(a_results) > 0 and len(cross_results) == 0
    detail = f"own_scope={len(a_results)}, cross_scope={len(cross_results)}"
    _print_verdict(passed, detail)

    await agent_a.close()
    await agent_b.close()
    return ScenarioResult("scope_isolation", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 3: Conversational continuity — LLM uses prior context
# ---------------------------------------------------------------------------

async def scenario_conversational_continuity(
    hippocampus: Hippocampus,
    client,
    container: str,
    deployment: str,
) -> ScenarioResult:
    _print_header(3, "conversational_continuity", "LLM should reference Turn 1 context in Turn 2 via recall")

    _print_step("Turn 1: Telling LLM about our product...")
    response1, _ = await agent_turn(
        hippocampus, client, container,
        "Our product is called Nimbus and it helps small businesses manage invoices.",
        deployment=deployment,
    )
    print(f"    LLM acknowledged: {response1[:150]}")

    _print_step("Turn 2: Asking 'What does our product do again?' (without restating name)")
    response2, recalled = await agent_turn(
        hippocampus, client, container,
        "What does our product do again?",
        deployment=deployment,
    )

    _print_memories("Recalled memories for Turn 2", recalled)
    print(f"\n  {BOLD}LLM response:{RESET} {response2[:200]}")

    combined = response2.lower() + " ".join(m.content.lower() for m in recalled)
    has_nimbus = "nimbus" in combined
    has_invoice = "invoice" in combined
    passed = has_nimbus and has_invoice
    detail = f"mentions nimbus={has_nimbus}, invoice={has_invoice}"
    _print_verdict(passed, detail)
    return ScenarioResult("conversational_continuity", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 4: Memory deduplication via ArceusMemoryScope
# ---------------------------------------------------------------------------

async def scenario_scoped_retrieval(
    hippocampus: Hippocampus,
    client,
    deployment: str,
) -> ScenarioResult:
    _print_header(4, "scoped_retrieval", "ArceusMemoryScope merges 3 scopes without duplicates")

    startup_id = "startup-test"
    employee_id = "emp-cto"
    task_id = "task-42"

    shared_container = ArceusMemoryScope.startup_container(startup_id)
    private_container = ArceusMemoryScope.employee_container(startup_id, employee_id)
    task_container = ArceusMemoryScope.task_container(startup_id, task_id)

    _print_step(f"Storing STATIC in shared [{shared_container}]: 'democratize AI for SMBs'")
    await hippocampus.remember(
        "Company mission: democratize AI for SMBs.",
        container=shared_container,
        memory_type=MemoryType.STATIC,
    )

    _print_step(f"Storing STATIC in private [{private_container}]: 'use typed Python everywhere'")
    await hippocampus.remember(
        "CTO preference: use typed Python everywhere.",
        container=private_container,
        memory_type=MemoryType.STATIC,
    )

    _print_step(f"Storing DYNAMIC in task [{task_container}]: 'use sentence-transformers'")
    await hippocampus.remember(
        "Task-42 decision: use sentence-transformers for embeddings.",
        container=task_container,
        memory_type=MemoryType.DYNAMIC,
    )

    _print_step("Retrieving via ArceusMemoryScope.get_memories_for_agent()...")
    scope = ArceusMemoryScope()
    results = await scope.get_memories_for_agent(
        hippocampus=hippocampus,
        query="What tech decisions have we made?",
        startup_id=startup_id,
        employee_id=employee_id,
        task_id=task_id,
        include_shared=True,
    )

    _print_memories("Merged results", results)

    ids = [m.id for m in results]
    has_duplicates = len(ids) != len(set(ids))
    has_results = len(results) >= 2

    passed = has_results and not has_duplicates
    detail = f"retrieved={len(results)}, duplicates={has_duplicates}"
    _print_verdict(passed, detail)
    return ScenarioResult("scoped_retrieval", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 5: MMR diversity — repeated similar queries don't return clones
# ---------------------------------------------------------------------------

async def scenario_mmr_diversity(
    hippocampus: Hippocampus,
    client,
    container: str,
    deployment: str,
) -> ScenarioResult:
    _print_header(5, "mmr_diversity", "MMR (lambda=0.7) should diversify near-duplicate results")

    memories_to_store = [
        ("We use PostgreSQL as our primary database.", MemoryType.STATIC),
        ("PostgreSQL is our main relational database system.", MemoryType.STATIC),
        ("Redis is used for caching and Celery task broker.", MemoryType.STATIC),
        ("We deploy on AWS ECS with Fargate.", MemoryType.DYNAMIC),
    ]
    for content, mtype in memories_to_store:
        _print_step(f"Storing [{mtype.value.upper()}]: '{content[:60]}'")
        await hippocampus.remember(content, container=container, memory_type=mtype)

    _print_step("Recalling top-3 for: 'What infrastructure do we use?'")
    recalled = await hippocampus.recall("What infrastructure do we use?", container, top_k=3)

    _print_memories("Top-3 recalled", recalled)

    contents = [m.content.lower() for m in recalled]
    pg_count = sum(1 for c in contents if "postgresql" in c)

    passed = pg_count <= 1 and len(recalled) == 3
    detail = f"PostgreSQL entries in top-3: {pg_count} (max 1 expected), total: {len(recalled)}"
    _print_verdict(passed, detail)
    return ScenarioResult("mmr_diversity", passed, detail)


# ---------------------------------------------------------------------------
# Scenario 6: Tier boost verification via LLM acknowledgement
# ---------------------------------------------------------------------------

async def scenario_tier_boost_in_llm_response(
    hippocampus: Hippocampus,
    client,
    container: str,
    deployment: str,
) -> ScenarioResult:
    _print_header(6, "tier_boost_in_llm_response", "LLM should cite the STATIC price ($29) over DYNAMIC suggestion ($19)")

    _print_step("Storing STATIC: '$29/month per seat, 20% annual discount'")
    await hippocampus.remember(
        "Our pricing model is $29/month per seat, annual discount of 20%.",
        container=container,
        memory_type=MemoryType.STATIC,
    )

    _print_step("Storing DYNAMIC: 'customer mentioned $19 would be more competitive'")
    await hippocampus.remember(
        "A customer mentioned $19/month would be more competitive.",
        container=container,
        memory_type=MemoryType.DYNAMIC,
    )

    _print_step("Asking LLM: 'What is our pricing?'")
    response, recalled = await agent_turn(
        hippocampus, client, container,
        "What is our pricing?",
        deployment=deployment,
    )

    _print_memories("Recalled memories", recalled)
    print(f"\n  {BOLD}LLM response:{RESET} {response[:250]}")

    has_official = "$29" in response or "29" in response
    passed = has_official
    detail = f"LLM mentions $29={has_official}"
    _print_verdict(passed, detail)
    return ScenarioResult("tier_boost_in_llm_response", passed, detail)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def run_all() -> None:
    load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

    deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT_REASONING", "gpt-4o")
    client = create_client()

    print(f"\n{BOLD}{'=' * 70}{RESET}")
    print(f"{BOLD}{CYAN}  Hippocampus Phase 0/1 Verification — LLM-in-the-Loop{RESET}")
    print(f"{BOLD}{'=' * 70}{RESET}")
    print(f"  Deployment: {deployment}")
    print(f"  Embedding:  all-MiniLM-L6-v2 (384d)")

    # Shared hippocampus for LLM scenarios (real embeddings)
    config = HippocampusConfig(
        embedding_model="all-MiniLM-L6-v2",
        embedding_dimensions=384,
        sqlite_path=":memory:",
    )
    hippocampus = await Hippocampus.create("test-agent", config)
    container = ArceusMemoryScope.employee_container("startup-test", "test-agent")

    results: list[ScenarioResult] = []

    # 1. Static priority
    results.append(
        await scenario_static_priority(hippocampus, client, container, deployment)
    )

    # 2. Scope isolation (uses simple embeddings, self-contained)
    results.append(await scenario_scope_isolation(deployment))

    # 3. Conversational continuity
    results.append(
        await scenario_conversational_continuity(hippocampus, client, container, deployment)
    )

    # 4. Scoped retrieval via ArceusMemoryScope (fresh instance)
    config_scoped = HippocampusConfig(
        embedding_model="all-MiniLM-L6-v2",
        embedding_dimensions=384,
        sqlite_path=":memory:",
    )
    hippo_scoped = await Hippocampus.create("emp-cto", config_scoped)
    results.append(
        await scenario_scoped_retrieval(hippo_scoped, client, deployment)
    )
    await hippo_scoped.close()

    # 5. MMR diversity (fresh instance)
    config_mmr = HippocampusConfig(
        embedding_model="all-MiniLM-L6-v2",
        embedding_dimensions=384,
        sqlite_path=":memory:",
    )
    hippo_mmr = await Hippocampus.create("test-mmr", config_mmr)
    container_mmr = ArceusMemoryScope.employee_container("startup-test", "test-mmr")
    results.append(
        await scenario_mmr_diversity(hippo_mmr, client, container_mmr, deployment)
    )
    await hippo_mmr.close()

    # 6. Tier boost in LLM response (fresh instance)
    config_tier = HippocampusConfig(
        embedding_model="all-MiniLM-L6-v2",
        embedding_dimensions=384,
        sqlite_path=":memory:",
    )
    hippo_tier = await Hippocampus.create("test-tier", config_tier)
    container_tier = ArceusMemoryScope.employee_container("startup-test", "test-tier")
    results.append(
        await scenario_tier_boost_in_llm_response(
            hippo_tier, client, container_tier, deployment
        )
    )
    await hippo_tier.close()

    await hippocampus.close()

    # Summary
    print(f"\n{BOLD}{'=' * 70}{RESET}")
    print(f"{BOLD}{CYAN}  Final Summary{RESET}")
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
