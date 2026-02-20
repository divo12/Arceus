"""Configuration loading from JSON (adapted from nanobot)."""

from config.loader import load_config
from config.schema import Config

__all__ = ["Config", "load_config"]
