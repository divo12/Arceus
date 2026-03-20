from __future__ import annotations

import pytest
import pytest_asyncio

from arceus.core.hippocampus.backends.noop_llm import NoopLLMEngine
from arceus.core.hippocampus.backends.sqlite_relational import SQLiteRelationalStore
from arceus.core.hippocampus.tiers.priming import PrimingMemory


@pytest_asyncio.fixture
async def relational_store(tmp_path):
    store = SQLiteRelationalStore(str(tmp_path / "priming.db"))
    await store.initialize()
    try:
        yield store
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_default_state(relational_store: SQLiteRelationalStore) -> None:
    memory = PrimingMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    state = await memory.get_current_state()

    assert state == {
        "confidence": 0.5,
        "caution": 0.3,
        "morale": 0.5,
        "recent_events": [],
    }


@pytest.mark.asyncio
async def test_update_state_positive_signal(relational_store: SQLiteRelationalStore) -> None:
    memory = PrimingMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    state = await memory.update_state("success", signal=1.0, source="test")

    assert state["confidence"] > 0.5
    assert state["morale"] > 0.5


@pytest.mark.asyncio
async def test_update_state_negative_signal(relational_store: SQLiteRelationalStore) -> None:
    memory = PrimingMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    state = await memory.update_state("failure", signal=-1.0, source="test")

    assert state["caution"] > 0.3


@pytest.mark.asyncio
async def test_recent_events_capped_at_10(relational_store: SQLiteRelationalStore) -> None:
    memory = PrimingMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    state = {}
    for index in range(12):
        state = await memory.update_state(
            f"event-{index}",
            signal=1.0 if index % 2 == 0 else -1.0,
            source="test",
        )

    assert len(state["recent_events"]) == 10
    assert state["recent_events"][0]["stimulus"] == "event-2"


@pytest.mark.asyncio
async def test_generate_priming_prompt_noop(relational_store: SQLiteRelationalStore) -> None:
    memory = PrimingMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    prompt = await memory.generate_priming_prompt()

    assert isinstance(prompt, str)
    assert prompt != ""


@pytest.mark.asyncio
async def test_update_state_clamps_signal(relational_store: SQLiteRelationalStore) -> None:
    memory = PrimingMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    state = await memory.update_state("huge success", signal=3.0, source="test")
    assert state["recent_events"][-1]["signal"] == 1.0
    assert state["confidence"] == pytest.approx(0.575)
    assert state["morale"] == pytest.approx(0.575)

    state = await memory.update_state("huge failure", signal=-4.0, source="test")
    assert state["recent_events"][-1]["signal"] == -1.0
    assert 0.0 <= state["confidence"] <= 1.0
    assert 0.0 <= state["caution"] <= 1.0
    assert 0.0 <= state["morale"] <= 1.0
