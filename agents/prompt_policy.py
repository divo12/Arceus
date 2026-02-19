"""Prompt selection policy to avoid redundancy with skills."""

from typing import Dict, List, Set


class PromptPolicy:
    """Maps prompts to roles and overlapping skills, then filters references."""

    PROMPT_TYPES: Dict[str, str] = {
        "framing-the-problem-statement": "framing",
        "jobs-to-be-done": "discovery",
        "customer-journey-mapping-prompt-template": "discovery",
        "positioning-statement": "strategy",
        "proto-persona-profile": "discovery",
        "recommendation-canvas-template": "template",
        "user-story-prompt-template": "template",
        "user-story_ai-enhanced_prompt-template": "template",
        "user-story-splitting-prompt-template": "template",
        "user-story-mapping": "template",
        "visionary-press-release": "storytelling",
        "storyboard-storytelling-prompt": "storytelling",
        "pestel-analysis-prompt-template": "analysis",
    }

    # Prompt name -> skills with overlapping procedure logic.
    OVERLAP_MAP: Dict[str, List[str]] = {
        "framing-the-problem-statement": ["problem-statement", "problem-framing-canvas"],
        "jobs-to-be-done": ["jobs-to-be-done"],
        "customer-journey-mapping-prompt-template": ["customer-journey-map"],
        "positioning-statement": ["positioning-statement"],
        "proto-persona-profile": ["proto-persona"],
        "recommendation-canvas-template": ["recommendation-canvas"],
        "user-story-prompt-template": ["user-story"],
        "user-story_ai-enhanced_prompt-template": ["user-story"],
        "user-story-splitting-prompt-template": ["user-story-splitting"],
        "user-story-mapping": ["user-story-mapping"],
        "visionary-press-release": ["press-release"],
        "storyboard-storytelling-prompt": ["storyboard"],
        "pestel-analysis-prompt-template": ["pestel-analysis"],
    }

    PHASE_TO_PROMPTS: Dict[str, List[str]] = {
        "understand": ["framing-the-problem-statement", "proto-persona-profile"],
        "validate": ["jobs-to-be-done", "customer-journey-mapping-prompt-template"],
        "decide": ["positioning-statement", "recommendation-canvas-template"],
        "plan": [
            "user-story-prompt-template",
            "user-story-splitting-prompt-template",
            "visionary-press-release",
        ],
    }

    def select_prompt_references(
        self,
        phase_names: List[str],
        available_prompts: List[str],
        selected_skills: List[str],
    ) -> List[str]:
        """Choose prompt refs with anti-redundancy filtering."""
        candidates: List[str] = []
        for phase in phase_names:
            candidates.extend(self.PHASE_TO_PROMPTS.get(phase, []))

        # Keep only available prompts.
        candidates = [name for name in candidates if name in available_prompts]

        # Deduplicate while preserving order.
        seen: Set[str] = set()
        ordered_candidates: List[str] = []
        for name in candidates:
            if name not in seen:
                seen.add(name)
                ordered_candidates.append(name)

        # Redundancy rule: only include prompt if it adds net-new reference value.
        result: List[str] = []
        selected_skills_set = set(selected_skills)
        for prompt_name in ordered_candidates:
            overlapping = set(self.OVERLAP_MAP.get(prompt_name, []))
            if overlapping and overlapping.issubset(selected_skills_set):
                # Skip if fully covered by selected skills.
                continue
            result.append(prompt_name)

        return result

