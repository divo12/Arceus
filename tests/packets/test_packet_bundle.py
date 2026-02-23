import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from integrations.jira import format_packet_reference_comment
from integrations.publish import publish_packet_reference_to_jira
from packets.service import write_packet_bundle
from packets.types import DecisionItem, SourceItem


class TestPacketBundle(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_writes_versioned_bundle_and_latest_pointer(self):
        decisions = [
            DecisionItem(
                id="DEC-1",
                title="Ship packet export MVP",
                decidedAt="2026-02-23",
                owner="pm@company.com",
                evidenceIds=["SRC-1"],
            )
        ]
        sources = [
            SourceItem(
                id="SRC-1",
                type="evidence",
                uri="https://example.com/doc",
                title="Evidence doc",
                scope="org",
                citedInDecisions=["DEC-1"],
            )
        ]

        v1_dir = write_packet_bundle(
            workspace=self.workspace,
            packet_id="cursor-pm",
            decisions=decisions,
            sources=sources,
            exported_by="tester",
            export_scope="team",
            export_reason="unit test",
        )
        self.assertTrue((v1_dir / "packet.md").exists())
        self.assertTrue((v1_dir / "sources.json").exists())

        packet_root = self.workspace / "data" / "packets" / "cursor-pm"
        self.assertTrue((packet_root / "LATEST").exists())
        self.assertTrue((packet_root / "latest.json").exists())
        self.assertEqual((packet_root / "LATEST").read_text(encoding="utf-8").strip(), "v1")

        manifest = json.loads((v1_dir / "sources.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["packetId"], "cursor-pm")
        self.assertEqual(manifest["packetVersion"], "v1")
        self.assertGreaterEqual(len(manifest["sources"]), 1)
        self.assertIn("hash", manifest["sources"][0])

        v2_dir = write_packet_bundle(
            workspace=self.workspace,
            packet_id="cursor-pm",
            decisions=decisions,
            sources=sources,
        )
        self.assertTrue(v2_dir.name == "v2")
        self.assertEqual((packet_root / "LATEST").read_text(encoding="utf-8").strip(), "v2")

    def test_publish_reference_requires_auth(self):
        packet_id = "cursor-pm"
        write_packet_bundle(
            workspace=self.workspace,
            packet_id=packet_id,
            decisions=[],
            sources=[],
        )

        old = {k: os.environ.get(k) for k in ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]}
        try:
            for k in old:
                os.environ.pop(k, None)

            with self.assertRaises(RuntimeError):
                publish_packet_reference_to_jira(
                    workspace=self.workspace,
                    packet_id=packet_id,
                    issue_key="PROJ-123",
                )
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_jira_comment_format_contains_stable_reference(self):
        body = format_packet_reference_comment(
            packet_id="cursor-pm",
            packet_version="v1",
            stable_reference="data/packets/cursor-pm/latest.json",
        )
        self.assertIn("packetId: cursor-pm", body)
        self.assertIn("packetVersion: v1", body)
        self.assertIn("data/packets/cursor-pm/latest.json", body)


if __name__ == "__main__":
    unittest.main()

