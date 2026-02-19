"""Base agent class for product management agent."""

from pathlib import Path
from typing import Any, Optional, List, Dict
import json

from agents.context_builder import ContextBuilder
from agents.skills import SkillsLoader


class BaseAgent:
    """
    Base agent class for product management.
    
    This agent takes a holistic approach to product management:
    - Understands problems deeply from multiple perspectives
    - Makes data-driven decisions about what to build
    - Uses proven PM frameworks and methodologies
    - Balances user needs, business goals, and technical constraints
    """
    
    def __init__(self, workspace: Path):
        """
        Initialize the base agent.
        
        Args:
            workspace: Path to the workspace directory.
        """
        self.workspace = Path(workspace).expanduser().resolve()
        self.context_builder = ContextBuilder(self.workspace)
        self.skills = SkillsLoader(self.workspace)
        self.conversation_history: List[Dict[str, Any]] = []
    
    def get_available_skills(self) -> List[Dict[str, str]]:
        """
        Get list of available skills.
        
        Returns:
            List of skill info dicts with 'name', 'path', 'source'.
        """
        return self.skills.list_skills(filter_unavailable=False)
    
    def get_workspace_skills(self) -> List[Dict[str, str]]:
        """
        Get only workspace skills.
        
        Returns:
            List of workspace skill info dicts.
        """
        all_skills = self.get_available_skills()
        return [s for s in all_skills if s["source"] == "workspace"]
    
    def get_builtin_skills(self) -> List[Dict[str, str]]:
        """
        Get only built-in skills.
        
        Returns:
            List of built-in skill info dicts.
        """
        all_skills = self.get_available_skills()
        return [s for s in all_skills if s["source"] == "builtin"]
    
    def load_skill(self, skill_name: str) -> Optional[str]:
        """
        Load a specific skill by name.
        
        Args:
            skill_name: Name of the skill to load.
        
        Returns:
            Skill content or None if not found.
        """
        return self.skills.load_skill(skill_name)
    
    def build_context(
        self,
        user_message: str,
        skill_names: Optional[List[str]] = None,
        media: Optional[List[str]] = None,
        channel: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Build the complete context for an LLM call.
        
        Args:
            user_message: The user's message.
            skill_names: Optional list of specific skills to include.
            media: Optional list of media file paths.
            channel: Optional channel identifier.
            chat_id: Optional chat/user ID.
        
        Returns:
            List of messages ready for LLM API call.
        """
        return self.context_builder.build_messages(
            history=self.conversation_history,
            current_message=user_message,
            skill_names=skill_names,
            media=media,
            channel=channel,
            chat_id=chat_id,
        )
    
    def add_to_history(self, role: str, content: Any, **kwargs):
        """
        Add a message to conversation history.
        
        Args:
            role: Message role ('user', 'assistant', 'tool', etc.).
            content: Message content.
            **kwargs: Additional message fields (tool_calls, tool_call_id, etc.).
        """
        message = {"role": role, "content": content}
        message.update(kwargs)
        self.conversation_history.append(message)
    
    def clear_history(self):
        """Clear conversation history."""
        self.conversation_history = []
    
    def get_history(self) -> List[Dict[str, Any]]:
        """
        Get conversation history.
        
        Returns:
            List of conversation messages.
        """
        return self.conversation_history.copy()
    
    def process_problem(
        self,
        problem_description: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Process a product management problem using a holistic approach.
        
        This is the main entry point for the product manager agent.
        It takes a problem and applies PM methodologies to decide what to build.
        
        Args:
            problem_description: Description of the problem to solve.
            context: Optional additional context (user data, market info, etc.).
        
        Returns:
            Dictionary with analysis, recommendations, and next steps.
        """
        # Step 1: Understand the problem
        # Use discovery and problem-framing skills
        understanding_skills = [
            "problem-statement",
            "problem-framing-canvas",
            "discovery-process",
        ]
        
        # Step 2: Research and validate
        # Use research and validation skills
        research_skills = [
            "company-research",
            "jobs-to-be-done",
            "pol-probe",
        ]
        
        # Step 3: Decide what to build
        # Use prioritization and strategy skills
        decision_skills = [
            "prioritization-advisor",
            "product-strategy-session",
            "opportunity-solution-tree",
        ]
        
        # Step 4: Plan the solution
        # Use planning and documentation skills
        planning_skills = [
            "prd-development",
            "user-story",
            "roadmap-planning",
        ]
        
        # Build context with relevant skills
        recommended_skills = understanding_skills + research_skills + decision_skills + planning_skills
        
        # Filter to only available skills
        available_skill_names = [s["name"] for s in self.get_available_skills()]
        skills_to_use = [s for s in recommended_skills if s in available_skill_names]
        
        # Build the context
        messages = self.build_context(
            user_message=f"""Problem: {problem_description}

{self._format_context(context) if context else ''}

Please take a holistic approach to this problem:
1. First, understand the problem deeply from multiple perspectives
2. Research and validate assumptions
3. Decide what to build using data and frameworks
4. Create a plan with clear next steps

Use the available skills to guide your approach.""",
            skill_names=skills_to_use,
        )
        
        return {
            "messages": messages,
            "recommended_skills": skills_to_use,
            "available_skills": available_skill_names,
            "problem": problem_description,
            "context": context or {},
        }
    
    def _format_context(self, context: Dict[str, Any]) -> str:
        """Format additional context for inclusion in prompt."""
        if not context:
            return ""
        
        parts = []
        for key, value in context.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, indent=2)
            parts.append(f"{key}: {value}")
        
        return "\n".join(parts)
    
    def get_system_prompt(self, skill_names: Optional[List[str]] = None) -> str:
        """
        Get the system prompt.
        
        Args:
            skill_names: Optional list of skills to include.
        
        Returns:
            System prompt string.
        """
        return self.context_builder.build_system_prompt(skill_names)
