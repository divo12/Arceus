#!/usr/bin/env python3
"""Example usage of BaseAgent for product management."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from agents import BaseAgent


def main():
    """Example of using BaseAgent to process a product management problem."""
    
    # Initialize the agent with workspace path
    workspace = Path(__file__).parent.parent
    agent = BaseAgent(workspace)
    
    print("=" * 60)
    print("Product Manager Agent - Example")
    print("=" * 60)
    
    # Show available skills and prompt references
    print("\n1. Available Skills:")
    print("-" * 60)
    all_skills = agent.get_available_skills()
    workspace_skills = agent.get_workspace_skills()
    builtin_skills = agent.get_builtin_skills()
    all_prompts = agent.get_available_prompts()
    
    print(f"Total skills: {len(all_skills)}")
    print(f"  - Workspace skills: {len(workspace_skills)}")
    print(f"  - Built-in skills: {len(builtin_skills)}")
    print(f"Prompt references: {len(all_prompts)}")
    
    # Example problem
    problem = """
    Users are complaining that our mobile app takes too long to load.
    The app currently takes 8-10 seconds to show the home screen on average devices.
    We're losing users during the loading phase.
    """
    
    print("\n2. Processing Problem:")
    print("-" * 60)
    print(f"Problem: {problem.strip()}")
    
    # Process the problem
    result = agent.process_problem(
        problem_description=problem,
        context={
            "platform": "mobile",
            "current_load_time": "8-10 seconds",
            "user_feedback": "complaints about slow loading",
        }
    )
    
    print(f"\nRecommended skills to use: {len(result['recommended_skills'])}")
    print("Skills:", ", ".join(result['recommended_skills'][:5]), "...")
    print(f"Recommended prompt references: {len(result['recommended_prompts'])}")
    print("Prompts:", ", ".join(result["recommended_prompts"][:3]) if result["recommended_prompts"] else "(none)")
    
    # Show system prompt preview
    print("\n3. System Prompt Preview:")
    print("-" * 60)
    system_prompt = agent.get_system_prompt(
        skill_names=result["recommended_skills"][:3],
        prompt_names=result["recommended_prompts"][:2],
    )
    preview = system_prompt[:500].replace('\n', ' ')
    print(f"{preview}...")
    
    # Build context for LLM
    print("\n4. Building Context for LLM:")
    print("-" * 60)
    messages = agent.build_context(
        user_message="How should we approach solving this problem?",
        skill_names=result['recommended_skills'][:3],
        prompt_names=result["recommended_prompts"][:2],
    )
    
    print(f"Total messages: {len(messages)}")
    print(f"System prompt length: {len(messages[0]['content'])} characters")
    print(f"User message: {messages[-1]['content'][:100]}...")
    
    print("\n" + "=" * 60)
    print("Example complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
