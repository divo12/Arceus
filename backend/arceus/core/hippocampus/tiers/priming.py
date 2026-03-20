from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import LLMEngine, RelationalStore
from arceus.core.hippocampus.prompts import PRIMING_GENERATION_PROMPT
from arceus.core.hippocampus.utils.time import utc_now


class PrimingMemory:
    def __init__(
        self,
        agent_id: str,
        relational_store: RelationalStore,
        llm_light: LLMEngine,
    ) -> None:
        self._agent_id = agent_id
        self._store = relational_store
        self._llm = llm_light

    async def update_state(self, stimulus: str, signal: float, source: str) -> dict:
        current = await self.get_current_state()
        lr = 0.15
        bounded_signal = max(-1.0, min(signal, 1.0))
        new_state = {
            "confidence": current["confidence"] * (1 - lr) + max(bounded_signal, 0) * lr,
            "caution": current["caution"] * (1 - lr) + max(-bounded_signal, 0) * lr,
            "morale": current["morale"] * (1 - lr) + (bounded_signal * 0.5 + 0.5) * lr,
            "recent_events": [
                *current["recent_events"][-9:],
                {
                    "stimulus": stimulus,
                    "signal": bounded_signal,
                    "source": source,
                    "timestamp": utc_now().isoformat(),
                },
            ],
        }
        await self._store.set_priming_state(self._agent_id, new_state)
        return new_state

    async def get_current_state(self) -> dict:
        return await self._store.get_priming_state(self._agent_id) or {
            "confidence": 0.5,
            "caution": 0.3,
            "morale": 0.5,
            "recent_events": [],
        }

    async def generate_priming_prompt(self) -> str:
        state = await self.get_current_state()
        recent_events = state["recent_events"][-5:]
        recent_events_text = "\n".join(
            (
                f"- {event['stimulus']} "
                f"(source: {event['source']}, "
                f"signal: {'positive' if event['signal'] > 0 else 'negative'})"
            )
            for event in recent_events
        )
        if not recent_events_text:
            recent_events_text = "No recent events."
        return await self._llm.generate(
            prompt=PRIMING_GENERATION_PROMPT.format(
                confidence=f"{state['confidence']:.2f}",
                caution=f"{state['caution']:.2f}",
                morale=f"{state['morale']:.2f}",
                recent_events=recent_events_text,
            )
        )
