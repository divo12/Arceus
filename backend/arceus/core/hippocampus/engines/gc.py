from __future__ import annotations

from typing import TYPE_CHECKING

from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
from arceus.core.hippocampus.types import GCResult

if TYPE_CHECKING:
    from arceus.core.hippocampus.hippocampus import Hippocampus


class MemoryGarbageCollector:
    def __init__(self, hippocampus: Hippocampus, promotion_engine: PromotionEngine) -> None:
        self._hippocampus = hippocampus
        self._promotion_engine = promotion_engine

    async def run(self) -> GCResult:
        expired_memories = await self._hippocampus.dynamic_memory.find_expired()
        for memory in expired_memories:
            await self._hippocampus.soft_delete(memory.id, reason="temporal_expiry")

        decayed_removed = 0
        decayed_memories = await self._hippocampus.dynamic_memory.find_decayed()
        for memory in decayed_memories:
            if self._promotion_engine._qualifies_for_static(memory):
                continue
            await self._hippocampus.soft_delete(memory.id, reason="relevance_decay")
            decayed_removed += 1

        deduped = 0
        pruned = 0
        merged = 0
        if self._hippocampus.reasoning_bank is not None:
            consolidation = await self._hippocampus.reasoning_bank.consolidate()
            deduped = consolidation.deduped
            pruned = consolidation.pruned
            merged = consolidation.merged

        patterns_merged = 0
        patterns_pruned = 0
        if self._hippocampus.pattern_learner is not None:
            pattern_result = await self._hippocampus.pattern_learner.consolidate_patterns()
            patterns_merged = int(pattern_result.get("merged", 0))
            patterns_pruned = int(pattern_result.get("pruned", 0))

        promotions = await self._promotion_engine.run_promotions()
        await self._promotion_engine.check_probation_demotions()
        await self._promotion_engine.check_unused_static_demotions()

        return GCResult(
            expired_removed=len(expired_memories),
            decayed_removed=decayed_removed,
            deduped=deduped,
            pruned=pruned,
            merged=merged,
            patterns_merged=patterns_merged,
            patterns_pruned=patterns_pruned,
            promotions_fired=len(promotions),
        )
