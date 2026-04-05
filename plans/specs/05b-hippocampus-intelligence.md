# Spec 05b: Hippocampus Intelligence (Layer C) — POST-MVP

> Status: DESIGNED (implement after 05a is stable)
> Last updated: 2026-04-06

## What This Adds

Self-improving memory system. Knowledge consolidates automatically. Patterns emerge. Important facts get promoted. The company develops institutional knowledge.

## Components

### PatternLearner
- Extract patterns from successful task trajectories
- Cluster similar patterns (k-means on embeddings)
- Evolve patterns: EMA update success_rate on reuse
- Merge >90% similar patterns (LLM synthesis)
- Prune below 20th percentile composite score
- Auto-form habits from high-success patterns (usage>=10, success>=0.8)

### PromotionEngine
- Scan dynamic memories meeting threshold: access_count>=10, confidence>=0.8, age>=14 days
- LLM contradiction check against existing statics (gpt-4o-mini)
- Promote to static (immutable) if no contradiction
- LLM generates human-readable promotion reason
- 7-day probation window (demote if unused)
- 60-day unused static demotion
- Max 5 promotions per cycle per agent
- Rate limit prevents knowledge avalanche

### Full Consolidation Cycle
- Dedup: cosine >0.95 → keep highest confidence
- Contradiction detection: cosine >0.80 → LLM verify (gpt-4o-mini)
- Merge: cosine >0.90 same domain → LLM synthesize combined text
- Pattern merge: similar patterns → LLM synthesize description
- Habit naming: LLM generates readable trigger + action from pattern data

## Additional LLM Calls (6)

| # | Call | Model | When | Purpose |
|---|------|-------|------|---------|
| 5 | Contradiction verify | gpt-4o-mini | Consolidation | Binary: are these two memories contradictory? |
| 6 | Memory merge synthesis | gpt-4o-mini | Consolidation | Combine two similar memories into one |
| 7 | Pattern merge synthesis | gpt-4o-mini | Consolidation | Combine two similar patterns |
| 8 | Habit naming | gpt-4o-mini | Habit formation | Generate readable trigger + action from pattern |
| 9 | Promotion reasoning | gpt-4o-mini | Promotion | Human-readable explanation for dashboard |
| 10 | Relationship classification | gpt-4o-mini | Extraction | Classify entity relationship type |

All background (consolidation cycle), all gpt-4o-mini (cheap).

## Additional Schema

Uses existing `patterns` table from Spec 04. Adds `promotion_status` tracking on memory_units (already in schema).

## Why Post-MVP

- Layer A+B gives agents memory across sprints (Sprint 2 works)
- Layer C makes Sprint 10 better but doesn't block Sprint 2-5
- Pattern learning has subtle correctness issues (clustering, thresholds)
- Better to ship stable A+B than buggy A+B+C
- Architecture supports adding C without changing A or B
