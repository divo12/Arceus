"""Tests for arceus_artifacts CLI."""

import shutil
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from artifacts.renderer import (
    render_decision_record,
    render_evidence_brief,
    render_options_set,
)


class TestArceusArtifacts(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_render_decision_record(self):
        payload = {
            "title": "Ship onboarding checklist",
            "context": "60% drop-off in first 24h.",
            "decision": "We will add a 3-step guided checklist.",
            "alternatives": [
                {"option": "Video tutorial", "reason": "Higher effort, lower completion"},
                {"option": "Do nothing", "reason": "Drop-off continues"},
            ],
            "rationale": "Minimal friction, measurable.",
            "risks": [{"risk": "Users dismiss", "mitigation": "Track dismissal rate"}],
            "revisit_triggers": ["If activation <50% in 60 days"],
        }
        out = render_decision_record(payload)
        self.assertIn("Ship onboarding checklist", out)
        self.assertIn("60% drop-off", out)
        self.assertIn("3-step guided checklist", out)
        self.assertIn("Video tutorial", out)
        self.assertIn("If activation <50%", out)

    def test_render_evidence_brief(self):
        payload = {
            "topic": "Onboarding drop-off",
            "findings": [
                {"finding": "60% drop in 24h", "sources": "Analytics", "confidence": "High"},
            ],
            "open_questions": ["What is the #1 blocker?"],
            "recommendation": "Proceed with checklist.",
        }
        out = render_evidence_brief(payload)
        self.assertIn("Onboarding drop-off", out)
        self.assertIn("60% drop", out)
        self.assertIn("Proceed with checklist", out)

    def test_render_options_set(self):
        payload = {
            "title": "Improve activation",
            "context": "Need to reduce drop-off.",
            "options": [
                {"name": "Checklist", "summary": "3-step guide", "tradeoffs": "Low effort"},
                {"name": "Video", "summary": "Tutorial", "tradeoffs": "High effort"},
            ],
            "recommendation": "Checklist first.",
        }
        out = render_options_set(payload)
        self.assertIn("Improve activation", out)
        self.assertIn("Checklist", out)
        self.assertIn("3-step guide", out)
