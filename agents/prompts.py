"""Prompt loader for reusable prompt references."""

import re
from pathlib import Path
from typing import Dict, List, Optional


DEFAULT_PROMPTS_DIR = (
    Path(__file__).parent.parent / "PM_Skills" / "product-manager-prompts" / "prompts"
)


class PromptLoader:
    """Loads and summarizes prompt reference files."""

    def __init__(self, workspace: Path, prompts_dir: Optional[Path] = None):
        self.workspace = workspace
        self.prompts_dir = prompts_dir or DEFAULT_PROMPTS_DIR

    def list_prompts(self) -> List[Dict[str, str]]:
        """List markdown prompts with basic metadata."""
        prompts: List[Dict[str, str]] = []
        if not self.prompts_dir.exists():
            return prompts

        for prompt_file in sorted(self.prompts_dir.glob("*.md")):
            if prompt_file.name.lower() == "readme.md":
                continue
            name = prompt_file.stem
            prompts.append(
                {
                    "name": name,
                    "path": str(prompt_file),
                    "source": "prompt_reference",
                    "description": self._extract_description(prompt_file),
                }
            )
        return prompts

    def load_prompt(self, name: str) -> Optional[str]:
        """Load prompt content by file stem (without extension)."""
        prompt_file = self.prompts_dir / f"{name}.md"
        if prompt_file.exists():
            return prompt_file.read_text(encoding="utf-8")
        return None

    def build_prompts_summary(self) -> str:
        """Build XML-like summary to support progressive loading."""
        all_prompts = self.list_prompts()
        if not all_prompts:
            return ""

        lines = ["<prompts>"]
        for p in all_prompts:
            lines.append("  <prompt>")
            lines.append(f"    <name>{self._escape_xml(p['name'])}</name>")
            lines.append(
                f"    <description>{self._escape_xml(p.get('description', p['name']))}</description>"
            )
            lines.append(f"    <location>{p['path']}</location>")
            lines.append("  </prompt>")
        lines.append("</prompts>")
        return "\n".join(lines)

    def load_prompts_for_context(self, prompt_names: List[str]) -> str:
        """Load selected prompts for optional in-context reference."""
        parts: List[str] = []
        for name in prompt_names:
            content = self.load_prompt(name)
            if content:
                trimmed = self._strip_comments(content)
                parts.append(f"### Prompt Reference: {name}\n\n{trimmed}")
        return "\n\n---\n\n".join(parts) if parts else ""

    def _extract_description(self, prompt_file: Path) -> str:
        content = prompt_file.read_text(encoding="utf-8")

        # Prefer explicit Description section.
        match = re.search(
            r"^\s*##?\s*Description\s*:\s*(.+)$", content, flags=re.IGNORECASE | re.MULTILINE
        )
        if match:
            return match.group(1).strip()

        # Fallback: first non-empty line after heading.
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        for line in lines:
            if not line.startswith("#"):
                return line[:180]
        return prompt_file.stem

    @staticmethod
    def _strip_comments(content: str) -> str:
        # Keep prompts concise in context by removing long HTML comment blocks.
        return re.sub(r"<!--[\s\S]*?-->", "", content).strip()

    @staticmethod
    def _escape_xml(value: str) -> str:
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

