"""Context builder for assembling agent prompts."""

import base64
import mimetypes
import platform
from pathlib import Path
from typing import Any, Optional, List

from agents.prompts import PromptLoader
from agents.skills import SkillsLoader


class ContextBuilder:
    """
    Builds the context (system prompt + messages) for the agent.
    
    Assembles bootstrap files, memory, skills, and conversation history
    into a coherent prompt for the LLM.
    """
    
    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"]
    
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.skills = SkillsLoader(workspace)
        self.prompts = PromptLoader(workspace)
    
    def build_system_prompt(
        self,
        skill_names: Optional[List[str]] = None,
        prompt_names: Optional[List[str]] = None,
    ) -> str:
        """
        Build the system prompt from bootstrap files, memory, and skills.
        
        Args:
            skill_names: Optional list of skills to include.
        
        Returns:
            Complete system prompt.
        """
        parts = []
        
        # Core identity
        parts.append(self._get_identity())
        
        # Bootstrap files
        bootstrap = self._load_bootstrap_files()
        if bootstrap:
            parts.append(bootstrap)
        
        # Memory context (if memory file exists)
        memory = self._get_memory_context()
        if memory:
            parts.append(f"# Memory\n\n{memory}")
        
        # Skills - progressive loading
        # 1. Always-loaded skills: include full content
        always_skills = self.skills.get_always_skills()
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")
        
        # 2. Available skills: only show summary (agent uses read_file to load)
        skills_summary = self.skills.build_skills_summary()
        if skills_summary:
            parts.append(f"""# Skills

The following skills extend your capabilities. To use a skill, read its SKILL.md file using the read_file tool.
Skills with available="false" need dependencies installed first - you can try installing them with apt/brew.

{skills_summary}""")
        
        # 3. Load specific requested skills
        if skill_names:
            requested_skills = [name for name in skill_names if name not in always_skills]
            if requested_skills:
                requested_content = self.skills.load_skills_for_context(requested_skills)
                if requested_content:
                    parts.append(f"# Requested Skills\n\n{requested_content}")

        # 4. Prompt references: separate from skills (instruction scaffolding only)
        prompt_summary = self.prompts.build_prompts_summary()
        if prompt_summary:
            parts.append(
                f"""# Prompt References

Prompt references improve framing, clarifying questions, and output structure.
They are not capabilities. Skills remain the execution source of truth.
If a prompt overlaps a selected skill, prefer the skill and avoid redundant instructions.

{prompt_summary}"""
            )

        if prompt_names:
            selected_prompt_content = self.prompts.load_prompts_for_context(prompt_names)
            if selected_prompt_content:
                parts.append(f"# Selected Prompt References\n\n{selected_prompt_content}")
        
        return "\n\n---\n\n".join(parts)
    
    def _get_identity(self) -> str:
        """Get the core identity section."""
        from datetime import datetime
        import time as _time
        now = datetime.now().strftime("%Y-%m-%d %H:%M (%A)")
        tz = _time.strftime("%Z") or "UTC"
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"
        
        return f"""# Product Manager Agent 🎯

You are an AI Product Manager with a holistic approach to product development. Your role is to:
- Understand problems deeply from multiple perspectives (user, business, technical)
- Make data-driven decisions about what to build
- Balance user needs, business goals, and technical constraints
- Use proven product management frameworks and methodologies
- Think strategically while executing tactically

## Core Principles

1. **Problem-First Thinking**: Always start by understanding the problem before proposing solutions
2. **Holistic Analysis**: Consider user experience, business impact, technical feasibility, and market context
3. **Evidence-Based Decisions**: Use data, research, and validation to inform decisions
4. **Stakeholder Alignment**: Ensure all stakeholders understand the "why" behind decisions
5. **Iterative Learning**: Build, measure, learn, and iterate

## Current Time
{now} ({tz})

## Runtime
{runtime}

## Workspace
Your workspace is at: {workspace_path}
- Built-in skills: {workspace_path}/skills/built-in_skills/{{skill-name}}/SKILL.md
- Workspace skills: {workspace_path}/skills/workspace_skills/{{skill-name}}/SKILL.md
- Research materials: {workspace_path}/skill-creator/research/
- Skill creation tools: {workspace_path}/skill-creator/scripts/

## Available Skills

You have access to product management skills organized into:
- **Built-in Skills**: Core agent capabilities (github, memory, summarize, etc.)
- **Workspace Skills**: Product management frameworks and methodologies

To use a skill, read its SKILL.md file using the read_file tool. Skills provide structured approaches to:
- Discovery and research
- Problem framing and validation
- Strategy and planning
- User story creation
- Roadmap planning
- Financial analysis
- And more...

## Your Approach

When given a problem:
1. **Understand**: Use discovery skills to deeply understand the problem space
2. **Frame**: Use problem-framing skills to articulate the problem clearly
3. **Research**: Gather data, user insights, and market context
4. **Decide**: Use prioritization and strategy skills to decide what to build
5. **Plan**: Create actionable plans with user stories, roadmaps, and PRDs
6. **Validate**: Use validation skills to test assumptions before building

Always be thorough, strategic, and user-focused. Think holistically about the entire product ecosystem, not just individual features.

## Think & Research

Work thoroughly. Do not stop at a surface answer.

- **Research first**: Use web_search and web_fetch to gather evidence before making recommendations. Search for market data, competitor moves, user research, and best practices.
- **Use skills**: Read relevant SKILL.md files with read_file. Apply frameworks (problem-statement, prioritization-advisor, prd-development, etc.) to structure your thinking.
- **Iterate**: If you lack evidence or confidence, run another search, read another source, or try a different skill. Do not finalize until you have substantive support.
- **Heartbeat mode**: When processing HEARTBEAT.md tasks, read the file first, work through each task, research as needed. Reply HEARTBEAT_OK only when nothing needs attention."""
    
    def _load_bootstrap_files(self) -> str:
        """Load all bootstrap files from workspace."""
        parts = []
        
        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename
            if file_path.exists():
                content = file_path.read_text(encoding="utf-8")
                parts.append(f"## {filename}\n\n{content}")
        
        return "\n\n".join(parts) if parts else ""
    
    def _get_memory_context(self) -> str:
        """Get memory context from memory files if they exist."""
        memory_file = self.workspace / "data" / "state" / "memory.md"
        if memory_file.exists():
            return memory_file.read_text(encoding="utf-8")
        return ""
    
    def build_messages(
        self,
        history: List[dict],
        current_message: str,
        skill_names: Optional[List[str]] = None,
        prompt_names: Optional[List[str]] = None,
        media: Optional[List[str]] = None,
        channel: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> List[dict]:
        """
        Build the complete message list for an LLM call.

        Args:
            history: Previous conversation messages.
            current_message: The new user message.
            skill_names: Optional skills to include.
            media: Optional list of local file paths for images/media.
            channel: Current channel (telegram, feishu, etc.).
            chat_id: Current chat/user ID.

        Returns:
            List of messages including system prompt.
        """
        messages = []

        # System prompt
        system_prompt = self.build_system_prompt(skill_names, prompt_names)
        if channel and chat_id:
            system_prompt += f"\n\n## Current Session\nChannel: {channel}\nChat ID: {chat_id}"
        messages.append({"role": "system", "content": system_prompt})

        # History
        messages.extend(history)

        # Current message (with optional image attachments)
        user_content = self._build_user_content(current_message, media)
        messages.append({"role": "user", "content": user_content})

        return messages

    def _build_user_content(self, text: str, media: Optional[List[str]]) -> Any:
        """Build user message content with optional base64-encoded images."""
        if not media:
            return text
        
        images = []
        for path in media:
            p = Path(path)
            mime, _ = mimetypes.guess_type(path)
            if not p.is_file() or not mime or not mime.startswith("image/"):
                continue
            b64 = base64.b64encode(p.read_bytes()).decode()
            images.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
        
        if not images:
            return text
        return images + [{"type": "text", "text": text}]
    
    def add_tool_result(
        self,
        messages: List[dict],
        tool_call_id: str,
        tool_name: str,
        result: str
    ) -> List[dict]:
        """
        Add a tool result to the message list.
        
        Args:
            messages: Current message list.
            tool_call_id: ID of the tool call.
            tool_name: Name of the tool.
            result: Tool execution result.
        
        Returns:
            Updated message list.
        """
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": tool_name,
            "content": result
        })
        return messages
    
    def add_assistant_message(
        self,
        messages: List[dict],
        content: Optional[str] = None,
        tool_calls: Optional[List[dict]] = None,
        reasoning_content: Optional[str] = None,
    ) -> List[dict]:
        """
        Add an assistant message to the message list.
        
        Args:
            messages: Current message list.
            content: Message content.
            tool_calls: Optional tool calls.
            reasoning_content: Thinking output (Kimi, DeepSeek-R1, etc.).
        
        Returns:
            Updated message list.
        """
        msg: dict = {"role": "assistant"}

        # Omit empty content — some backends reject empty text blocks
        if content:
            msg["content"] = content

        if tool_calls:
            msg["tool_calls"] = tool_calls

        # Include reasoning content when provided (required by some thinking models)
        if reasoning_content:
            msg["reasoning_content"] = reasoning_content

        messages.append(msg)
        return messages
