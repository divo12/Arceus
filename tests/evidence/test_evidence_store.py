"""Tests for evidence store and claims ledger."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from evidence.store import (
    add_claim,
    get_evidence,
    list_claims,
    list_evidence,
    upsert_evidence,
)


class TestEvidenceStore(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_upsert_evidence_idempotent(self):
        eid1 = upsert_evidence(
            self.workspace,
            uri="https://example.com/doc1",
            source_system="web_fetch",
            source_id="doc1",
            title="Doc 1",
        )
        eid2 = upsert_evidence(
            self.workspace,
            uri="https://example.com/doc1",
            source_system="web_fetch",
            source_id="doc1",
            title="Doc 1 Updated",
        )
        self.assertEqual(eid1, eid2)
        item = get_evidence(self.workspace, eid1)
        self.assertIsNotNone(item)
        self.assertEqual(item["title"], "Doc 1 Updated")

    def test_upsert_evidence_different_sources(self):
        eid1 = upsert_evidence(
            self.workspace,
            uri="https://a.com/1",
            source_system="web_fetch",
            source_id="a1",
        )
        eid2 = upsert_evidence(
            self.workspace,
            uri="https://b.com/2",
            source_system="support_query",
            source_id="b2",
        )
        self.assertNotEqual(eid1, eid2)
        items = list_evidence(self.workspace)
        self.assertEqual(len(items), 2)

    def test_add_claim_and_list(self):
        cid = add_claim(
            self.workspace,
            claim="Users want faster onboarding",
            evidence_chunk_ids=["chunk-1", "chunk-2"],
            confidence=0.85,
            decision_id="DEC-001",
        )
        self.assertTrue(cid.startswith("CLM-"))
        claims = list_claims(self.workspace, decision_id="DEC-001")
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["claim"], "Users want faster onboarding")
        self.assertEqual(claims[0]["confidence"], 0.85)
