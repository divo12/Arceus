from __future__ import annotations

AGENT_EXTRACTION_PROMPT = """
You are a memory extraction system. Analyze the following agent interaction
and extract facts worth remembering.

For each fact, classify:
- type: "static" (permanent truth), "dynamic" (temporary context),
        "procedural" (behavioral rule/habit), "priming" (emotional signal)
- confidence: 0.0 to 1.0
- is_temporal: true if the fact has an expiry (e.g., "meeting tomorrow")
- entities: named entities mentioned
- relationships: (source_entity, relationship, target_entity) tuples

ONLY extract facts that would be useful for future tasks.
Do NOT extract obvious/trivial information.
Do NOT extract information that is purely conversational filler.

Return as JSON array of facts.
""".strip()

SUB_AGENT_EXTRACTION_PROMPT = """
You are analyzing a sub-agent's task execution. Extract:
- Tool effectiveness (which tools worked/failed)
- Execution patterns (successful action sequences)
- Error patterns (what went wrong and why)
- Time/cost observations

Classify each as static (always true), dynamic (temporary), or procedural (habit-worthy).
""".strip()

MEETING_EXTRACTION_PROMPT = """
You are analyzing a meeting transcript between agents. Extract:
- Decisions made (static if permanent, dynamic if temporary)
- Action items and assignments
- Blockers identified
- Learnings and insights
- Morale/confidence signals (priming)

Focus on facts that will be useful for future work, not meeting logistics.
""".strip()

MEMORY_ACTION_DECISION_PROMPT = """
Given a new fact and existing memories, decide:
- ADD: New fact, no existing match
- UPDATE: Refines or corrects an existing memory (specify which)
- DELETE: Contradicts an existing memory (specify which)
- NONE: Already captured or not worth storing

Return: {"action": "ADD|UPDATE|DELETE|NONE", "target_id": "...", "reason": "..."}
""".strip()

RELATIONSHIP_CLASSIFICATION_PROMPT = """
Classify the relationship between two entities into one of these types:
- updates: replaces or supersedes
- extends: adds to without replacing
- derives: inferred from
- uses: utilizes
- owns: responsible for
- depends_on: requires
- related_to: general association
- part_of: component of
- decided_in: agreed upon during (meeting/event)

Source entity: {source}
Target entity: {target}
Relationship described as: {relation_text}

Return ONLY the relationship type (one of the above).
""".strip()

CONTRADICTION_CHECK_PROMPT = """
You are a contradiction detector. Given two memory statements, determine if they
SEMANTICALLY CONTRADICT each other.

Two statements contradict if they make incompatible claims about the same subject.
Similar statements that ADD detail or REFINE each other are NOT contradictions.

Memory A: {memory_a}
Memory B: {memory_b}

Examples of CONTRADICTIONS:
- "We use REST for APIs" vs "All APIs must use GraphQL"
- "Deploy on Friday" vs "Never deploy on Fridays"

Examples of NOT contradictions:
- "We use Stripe" vs "We use Stripe webhooks for payment notifications"
- "Auth uses JWT" vs "Auth uses JWT with 24h expiry"

Answer ONLY "CONTRADICTION" or "NO_CONTRADICTION".
""".strip()

PROMOTION_REASON_PROMPT = """
A memory has been automatically promoted from dynamic (temporary) to static (permanent).
Generate a clear, human-readable reason for the dashboard.

Memory content: {content}
Times accessed: {access_count}
Confidence score: {confidence}
Age: {age_days} days
Original source: {source_type}

Explain in one sentence why this memory deserves permanent status.
Do not use numbers — describe in natural language.
""".strip()

TRIGGER_EVALUATION_PROMPT = """
You are evaluating which behavioral habits are relevant to the current context.

Current context:
{context}

Active habits:
{triggers}

For each habit (by index), decide if its trigger condition is relevant to the current context.
Return a JSON array of objects: [{{"index": 0, "relevant": true/false}}, ...]

ONLY mark a habit as relevant if the context clearly matches the trigger condition.
""".strip()

PRIMING_GENERATION_PROMPT = """
You are generating a disposition prompt for an AI agent based on its current emotional state.

Current state metrics:
- Confidence: {confidence} (0=uncertain, 1=confident)
- Caution: {caution} (0=reckless, 1=very cautious)
- Morale: {morale} (0=demoralized, 1=energized)

Recent events:
{recent_events}

Generate a 2-3 sentence disposition that:
1. References specific recent events where relevant
2. Adjusts tone based on the metrics (high caution = more careful, low morale = more encouraging)
3. Does NOT mention the numeric values — describe the disposition naturally

The disposition will be injected into the agent's system prompt.
""".strip()

HABIT_NAMING_PROMPT = """
A behavioral pattern has been used frequently with high success and should become a habit.

Domain: {domain}
Strategy: {strategy}
Usage count: {usage_count}
Success rate: {success_rate}

Generate a trigger condition and action for this habit.
Return JSON: {{"trigger": "when X happens...", "action": "always do Y..."}}

The trigger should be specific enough to avoid false positives but general enough to fire
when the pattern is relevant.
""".strip()

PATTERN_MERGE_PROMPT = """
Two similar patterns in the same domain should be merged into one.

Pattern A:
- Description: {description_a}
- Strategy: {strategy_a}

Pattern B:
- Description: {description_b}
- Strategy: {strategy_b}

Synthesize a merged description and strategy that captures the best of both.
Return JSON: {{"description": "...", "strategy": "..."}}
""".strip()

TRAJECTORY_ANALYSIS_PROMPT = """
You are analyzing an agent's task execution trajectory to extract learnings.

Outcome: {outcome}
Steps taken: {steps}

Identify:
1. strengths — what actions or decisions worked well
2. weaknesses — what could have been done better
3. suggestions — actionable improvements for future similar tasks

Return JSON: {{"strengths": [...], "weaknesses": [...], "suggestions": [...]}}
Each array should contain short string descriptions.
""".strip()

MEMORY_MERGE_PROMPT = """
Two similar memories should be merged into one comprehensive statement.

Memory A: {memory_a}
Memory B: {memory_b}

Write a single merged statement that captures all information from both memories
without being redundant. Keep it concise — one or two sentences.
""".strip()
