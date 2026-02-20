"""Configuration loading from JSON (adapted from nanobot)."""

import json
from pathlib import Path

from config.schema import Config


def get_default_config_paths(workspace: Path | None = None) -> list[Path]:
    """Get config file paths to try, in order of precedence."""
    paths = []
    if workspace:
        paths.append(Path(workspace).expanduser().resolve() / ".arceus" / "config.json")
        paths.append(Path(workspace).expanduser().resolve() / "config.json")
    paths.append(Path.home() / ".arceus" / "config.json")
    paths.append(Path.cwd() / ".arceus" / "config.json")
    paths.append(Path.cwd() / "config.json")
    return paths


def find_config_path(workspace: Path | None = None) -> Path | None:
    """Return the first existing config path, or None if using defaults."""
    for path in get_default_config_paths(workspace):
        if path.exists():
            return path
    return None


def load_config(config_path: Path | None = None, workspace: Path | None = None) -> Config:
    """
    Load configuration from JSON file or return defaults.

    Args:
        config_path: Explicit path to config file. If None, searches default locations.
        workspace: Workspace path for workspace-relative config search.

    Returns:
        Loaded configuration object.
    """
    if config_path and config_path.exists():
        try:
            with open(config_path, encoding="utf-8") as f:
                data = json.load(f)
            return Config.model_validate(data)
        except (json.JSONDecodeError, ValueError):
            pass

    for path in get_default_config_paths(workspace):
        if path.exists():
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                return Config.model_validate(data)
            except (json.JSONDecodeError, ValueError):
                pass

    return Config()


def save_config(config: Config, config_path: Path) -> None:
    """Save configuration to JSON file."""
    config_path = Path(config_path).expanduser().resolve()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    data = config.model_dump(by_alias=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
