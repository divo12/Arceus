# Memory (Hippocampus)

Three-tier memory system providing agents with persistent, searchable knowledge.

## Tiers

| Tier | Name | Store | Examples |
|------|------|-------|----------|
| L1 | Static | `static_memories` | Company description, product vision, coding standards |
| L2 | Dynamic | `dynamic_memories` + pgvector | Meeting decisions, sprint outcomes, learned patterns |
| L3 | Procedural | `procedural_memories` | Skills, SOPs, workflow templates |

## Write Path

### Static Memory
- Set during company creation via `initStaticMemory()` in `packages/hippocampus/src/static.ts`
- Rarely updated; forms the "constitution" of the company

### Dynamic Memory
- Written after significant events via `storeDynamicMemory()` in `packages/hippocampus/src/dynamic.ts`
- LLM extraction: `extractMemories()` takes a conversation transcript and returns structured facts
- Each memory is embedded (OpenAI `text-embedding-3-small`) and stored with pgvector for similarity search

### Procedural Memory
- Skills stored as Markdown with YAML frontmatter
- Version-controlled via `upsertSkill()` in `packages/hippocampus/src/procedural.ts`
- Evolved through pattern learning and ATA pipeline

## Read Path (Priming)

`primeAgent(agentRole, taskContext)` in `packages/hippocampus/src/priming.ts`:

1. Loads all L1 static memories for the company
2. Queries L2 dynamic memories by vector similarity to the current task
3. Retrieves relevant L3 skills for the agent's role
4. Composes a memory context block injected into the agent prompt

## Decay & Consolidation

- Dynamic memories have a `relevanceScore` that decays over time
- Consolidation runs periodically: merges similar memories, prunes low-relevance ones
- Cross-sprint pattern transfer promotes recurring patterns to procedural memory
