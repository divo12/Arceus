from __future__ import annotations

import math


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    if len(a) != len(b):
        raise ValueError("Embedding dimensions must match")

    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def max_marginal_relevance(
    query_embedding: list[float],
    candidate_embeddings: list[list[float]],
    top_k: int,
    lambda_mult: float = 0.7,
) -> list[int]:
    if top_k <= 0 or not candidate_embeddings:
        return []

    top_k = min(top_k, len(candidate_embeddings))
    selected: list[int] = []
    remaining = list(range(len(candidate_embeddings)))

    while remaining and len(selected) < top_k:
        best_index = remaining[0]
        best_score = float("-inf")

        for candidate_index in remaining:
            candidate_embedding = candidate_embeddings[candidate_index]
            relevance = cosine_similarity(query_embedding, candidate_embedding)
            if not selected:
                score = relevance
            else:
                redundancy = max(
                    cosine_similarity(candidate_embedding, candidate_embeddings[selected_index])
                    for selected_index in selected
                )
                score = (lambda_mult * relevance) - ((1 - lambda_mult) * redundancy)

            if score > best_score:
                best_score = score
                best_index = candidate_index

        selected.append(best_index)
        remaining.remove(best_index)

    return selected
