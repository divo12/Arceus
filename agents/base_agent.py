"""Base agent class for product management agent."""

from pathlib import Path
from typing import Any, Optional, List, Dict
import json

from agents.context_builder import ContextBuilder
from agents.prompts import PromptLoader
from agents.skills import SkillsLoader
from cognition.cognitive_loop import CognitiveLoop


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
        self.prompts = PromptLoader(self.workspace)
        self.cognitive_loop = CognitiveLoop(self.workspace)
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
        Get non-workspace skills (essential + open).
        
        Returns:
            List of skill info dicts from essential and open sources.
        """
        all_skills = self.get_available_skills()
        return [s for s in all_skills if s["source"] in ("essential", "open")]
    
    def load_skill(self, skill_name: str) -> Optional[str]:
        """
        Load a specific skill by name.
        
        Args:
            skill_name: Name of the skill to load.
        
        Returns:
            Skill content or None if not found.
        """
        return self.skills.load_skill(skill_name)

    def get_available_prompts(self) -> List[Dict[str, str]]:
        """Get available prompt references."""
        return self.prompts.list_prompts()

    def load_prompt(self, prompt_name: str) -> Optional[str]:
        """Load a specific prompt reference by name."""
        return self.prompts.load_prompt(prompt_name)
    
    def build_context(
        self,
        user_message: str,
        skill_names: Optional[List[str]] = None,
        prompt_names: Optional[List[str]] = None,
        media: Optional[List[str]] = None,
        channel: Optional[str] = None,
        chat_id: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Build the complete context for an LLM call.

        Args:
            user_message: The user's message.
            skill_names: Optional list of specific skills to include.
            media: Optional list of media file paths.
            channel: Optional channel identifier.
            chat_id: Optional chat/user ID.
            history: Optional conversation history (overrides conversation_history when provided).

        Returns:
            List of messages ready for LLM API call.
        """
        h = history if history is not None else self.conversation_history
        return self.context_builder.build_messages(
            history=h,
            current_message=user_message,
            skill_names=skill_names,
            prompt_names=prompt_names,
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

        Uses the cognition loop (interpret -> reason -> plan -> decide)
        and then builds LLM-ready context based on selected skills.
        """
        available_skill_names = [s["name"] for s in self.get_available_skills()]
        available_prompt_names = [p["name"] for p in self.get_available_prompts()]
        cognition_result = self.cognitive_loop.run(
            problem_description=problem_description,
            context=context,
            available_skills=available_skill_names,
            available_prompts=available_prompt_names,
        )
        skills_to_use = cognition_result.get("skills_to_use", [])
        prompts_to_reference = cognition_result.get("prompts_to_reference", [])
        skill_gaps = self.skills.detect_skill_gaps(cognition_result.get("plan", {}))
        skill_drafts: List[str] = []
        if context and context.get("draft_skill_specs"):
            for gap in skill_gaps:
                path = self.skills.create_skill_draft(
                    skill_name=gap["suggested_skill_name"],
                    problem=problem_description,
                    rationale=gap["reason"],
                    evidence=[cognition_result.get("reflection", {})],
                )
                skill_drafts.append(str(path))

        messages = self.build_context(
            user_message=f"""Problem: {problem_description}

{self._format_context(context) if context else ''}

Cognitive Analysis:
- Objectives: {', '.join(cognition_result['interpreted_state'].get('objectives', []))}
- Decision: {cognition_result['decision'].get('decision', '')}
- Priority: {cognition_result['decision'].get('priority', '')}

Please use the selected skills and provide a holistic recommendation on what to build, why, and in what sequence.""",
            skill_names=skills_to_use,
            prompt_names=prompts_to_reference,
        )

        return {
            "messages": messages,
            "recommended_skills": skills_to_use,
            "recommended_prompts": prompts_to_reference,
            "skill_gaps": skill_gaps,
            "skill_drafts": skill_drafts,
            "available_skills": available_skill_names,
            "available_prompts": available_prompt_names,
            "problem": problem_description,
            "context": context or {},
            "cognition": cognition_result,
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
    
    def get_system_prompt(
        self,
        skill_names: Optional[List[str]] = None,
        prompt_names: Optional[List[str]] = None,
    ) -> str:
        """
        Get the system prompt.
        
        Args:
            skill_names: Optional list of skills to include.
        
        Returns:
            System prompt string.
        """
        return self.context_builder.build_system_prompt(skill_names, prompt_names)
