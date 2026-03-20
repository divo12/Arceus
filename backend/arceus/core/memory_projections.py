"""
ArceusMemoryProjections — dashboard-facing projection layer.

Spec reference: hippocampus_design_v6.md section 8.4
Generates typed views for the board UI without exposing raw memory.
"""
from __future__ import annotations

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import (
    GraphMemoryView,
    MemoryPromotionEvent,
    MemorySummaryProjection,
)


class ArceusMemoryProjections:
    """Dashboard-facing projection layer."""

    async def get_summary(
        self,
        hippocampus: Hippocampus,
    ) -> MemorySummaryProjection:
        return await hippocampus.get_summary()

    async def get_graph_view(
        self,
        hippocampus: Hippocampus,
        query: str,
        container: str,
        depth: int = 2,
    ) -> GraphMemoryView:
        """Generate graph neighborhood view for dashboard."""
        graph_results = await hippocampus.graph_store.search(
            query=query,
            container=container,
            top_k=1,
        )
        if not graph_results:
            return GraphMemoryView()

        center = graph_results[0]
        neighbors = await hippocampus.graph_store.get_neighbors(
            center.id,
            max_hops=depth,
        )

        edges = []
        for neighbor in neighbors:
            edges.append(
                {
                    "source": center.id,
                    "target": neighbor.id,
                    "type": "related_to",
                    "weight": 1.0,
                }
            )

        return GraphMemoryView(
            center_node=center,
            nodes=[center] + neighbors,
            edges=edges,
            depth=depth,
        )

    async def get_promotion_stream(
        self,
        hippocampus: Hippocampus,
    ) -> list[MemoryPromotionEvent]:
        return await hippocampus.get_recent_promotions()
