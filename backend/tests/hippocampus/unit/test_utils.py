from arceus.core.hippocampus.utils.similarity import (
    cosine_similarity,
    max_marginal_relevance,
)


def test_cosine_similarity_handles_basic_vectors() -> None:
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == 1.0
    assert round(cosine_similarity([1.0, 0.0], [0.0, 1.0]), 6) == 0.0


def test_max_marginal_relevance_prefers_diversity_after_first_pick() -> None:
    selected = max_marginal_relevance(
        query_embedding=[1.0, 0.0],
        candidate_embeddings=[
            [1.0, 0.0],
            [0.98, 0.02],
            [0.2, 0.8],
        ],
        top_k=2,
        lambda_mult=0.3,
    )

    assert selected == [0, 2]
