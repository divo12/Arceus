#!/usr/bin/env python3
"""Example usage of PM agent components (ContextBuilder, SkillsLoader, CognitiveLoop).

For full agent execution with tools and LLM, use AgentLoop via main.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from agents import ContextBuilder, SkillsLoader, PromptLoader, CognitiveLoop


def main():
    """Example of using PM agent components to process a problem."""
    workspace = Path(__file__).parent.parent

    skills = SkillsLoader(workspace)
    prompts = PromptLoader(workspace)
    context_builder = ContextBuilder(workspace)
    loop = CognitiveLoop(workspace)

    print("=" * 60)
    print("Product Manager Agent - Component Example")
    print("=" * 60)

    all_skills = skills.list_skills(filter_unavailable=False)
    all_prompts = prompts.list_prompts()
    workspace_skills = [s for s in all_skills if s["source"] == "workspace"]
    builtin_skills = [s for s in all_skills if s["source"] in ("essential", "open")]

    print("\n1. Available Skills:")
    print("-" * 60)
    print(f"Total skills: {len(all_skills)}")
    print(f"  - Workspace skills: {len(workspace_skills)}")
    print(f"  - Built-in skills: {len(builtin_skills)}")
    print(f"Prompt references: {len(all_prompts)}")

    problem = """
    Users are complaining that our mobile app takes too long to load.
    The app currently takes 8-10 seconds to show the home screen on average devices.
    We're losing users during the loading phase.
    """

    print("\n2. Cognitive Analysis:")
    print("-" * 60)
    print(f"Problem: {problem.strip()}")

    cognition = loop.run(
        problem_description=problem,
        context={
            "platform": "mobile",
            "current_load_time": "8-10 seconds",
            "user_feedback": "complaints about slow loading",
        },
        available_skills=[s["name"] for s in all_skills],
        available_prompts=[p["name"] for p in all_prompts],
    )

    recommended_skills = cognition.get("skills_to_use", [])
    recommended_prompts = cognition.get("prompts_to_reference", [])
    print(f"\nRecommended skills: {len(recommended_skills)}")
    print("Skills:", ", ".join(recommended_skills[:5]), "...")
    print(f"Recommended prompts: {len(recommended_prompts)}")
    print("Prompts:", ", ".join(recommended_prompts[:3]) if recommended_prompts else "(none)")

    print("\n3. System Prompt Preview:")
    print("-" * 60)
    system_prompt = context_builder.build_system_prompt(
        skill_names=recommended_skills[:3],
        prompt_names=recommended_prompts[:2],
    )
    preview = system_prompt[:500].replace("\n", " ")
    print(f"{preview}...")

    print("\n4. Building Context for LLM:")
    print("-" * 60)
    messages = context_builder.build_messages(
        history=[],
        current_message="How should we approach solving this problem?",
        skill_names=recommended_skills[:3],
        prompt_names=recommended_prompts[:2],
    )
    print(f"Total messages: {len(messages)}")
    print(f"System prompt length: {len(messages[0]['content'])} characters")
    print(f"User message: {messages[-1]['content'][:100]}...")

    print("\n" + "=" * 60)
    print("For full agent run with tools and LLM: python main.py \"<problem>\"")
    print("=" * 60)


if __name__ == "__main__":
    main()
