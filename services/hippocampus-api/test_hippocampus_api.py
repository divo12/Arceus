"""Smoke tests for the Hippocampus API sidecar.

Run:  python test_hippocampus_api.py [--base-url http://localhost:8100]

Tests the full API surface using only in-memory/noop backends so no
Azure OpenAI key is required.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import urllib.error

DEFAULT_URL = "http://localhost:8100"
AGENT_ID = "test-agent-smoke"
passed = 0
failed = 0


def req(method: str, path: str, body: dict | None = None, base: str = DEFAULT_URL) -> dict:
    url = f"{base}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if data else {}
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read())


def test(name: str, fn):
    global passed, failed
    try:
        fn()
        print(f"  ✓ {name}")
        passed += 1
    except Exception as e:
        print(f"  ✗ {name}: {e}")
        failed += 1


def main():
    global DEFAULT_URL
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_URL)
    args = parser.parse_args()
    DEFAULT_URL = args.base_url

    print(f"\n🧪 Hippocampus API smoke tests ({DEFAULT_URL})\n")

    # 1. Health
    def t_health():
        r = req("GET", "/health", base=DEFAULT_URL)
        assert r["status"] == "ok", f"Expected ok, got {r['status']}"

    test("GET /health", t_health)

    # 2. Remember (dynamic)
    def t_remember_dynamic():
        r = req("POST", "/remember", {
            "agent_id": AGENT_ID,
            "content": "The project uses TypeScript and pnpm",
            "container": "test",
            "memory_type": "dynamic",
        }, base=DEFAULT_URL)
        assert "id" in r, f"Missing id in response: {r}"
        assert r["memory_type"] == "dynamic"

    test("POST /remember (dynamic)", t_remember_dynamic)

    # 3. Remember (static)
    def t_remember_static():
        r = req("POST", "/remember", {
            "agent_id": AGENT_ID,
            "content": "Company name is Acme Corp",
            "container": "test",
            "memory_type": "static",
        }, base=DEFAULT_URL)
        assert r["memory_type"] == "static"

    test("POST /remember (static)", t_remember_static)

    # 4. Recall
    def t_recall():
        r = req("POST", "/recall", {
            "agent_id": AGENT_ID,
            "query": "What stack does the project use?",
            "container": "test",
            "top_k": 5,
        }, base=DEFAULT_URL)
        assert "items" in r, f"Missing items: {r}"

    test("POST /recall", t_recall)

    # 5. List memories
    def t_list():
        r = req("GET", f"/agents/{AGENT_ID}/memories?limit=10", base=DEFAULT_URL)
        assert "items" in r
        assert r["total"] >= 2, f"Expected at least 2 memories, got {r['total']}"

    test("GET /agents/:id/memories", t_list)

    # 6. Summary
    def t_summary():
        r = req("GET", f"/agents/{AGENT_ID}/summary", base=DEFAULT_URL)
        assert "total_static" in r
        assert "total_dynamic" in r

    test("GET /agents/:id/summary", t_summary)

    # 7. Priming
    def t_priming():
        r = req("GET", f"/agents/{AGENT_ID}/priming", base=DEFAULT_URL)
        assert "prompt" in r

    test("GET /agents/:id/priming", t_priming)

    # 8. Habits
    def t_habits():
        r = req("GET", f"/agents/{AGENT_ID}/habits", base=DEFAULT_URL)
        assert "habits" in r

    test("GET /agents/:id/habits", t_habits)

    # 9. GC
    def t_gc():
        r = req("POST", f"/agents/{AGENT_ID}/gc", {}, base=DEFAULT_URL)
        assert "expired" in r

    test("POST /agents/:id/gc", t_gc)

    # 10. Promotions
    def t_promotions():
        r = req("POST", f"/agents/{AGENT_ID}/promotions", {}, base=DEFAULT_URL)
        assert "promotions" in r

    test("POST /agents/:id/promotions", t_promotions)

    # 11. Extract (will be noop without LLM but should not crash)
    def t_extract():
        r = req("POST", "/extract", {
            "agent_id": AGENT_ID,
            "messages": [
                {"role": "user", "content": "We decided to use React for the frontend"},
                {"role": "assistant", "content": "Got it, I'll set up React."},
            ],
            "container": "test",
            "mode": "conversation",
        }, base=DEFAULT_URL)
        assert "added" in r

    test("POST /extract (noop LLM)", t_extract)

    # 12. Trajectory (will be noop without LLM but should not crash)
    def t_trajectory():
        r = req("POST", "/trajectory", {
            "agent_id": AGENT_ID,
            "task_id": "task-001",
            "outcome": "completed migration",
            "quality": 0.9,
            "steps": [
                {"action": "read docs", "result": "understood", "reasoning": "needed context"},
            ],
            "container": "test",
        }, base=DEFAULT_URL)
        assert "verdict" in r

    test("POST /trajectory (noop LLM)", t_trajectory)

    # Summary
    total = passed + failed
    print(f"\n{'='*40}")
    print(f"  {passed}/{total} passed", end="")
    if failed:
        print(f"  ({failed} FAILED)")
    else:
        print("  🎉 All green!")
    print()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
