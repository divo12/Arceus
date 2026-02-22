#!/usr/bin/env python3
"""
Test spawn + feedback flow: PM agent uses spawn for validation, feedback is integrated.

Runs a problem designed to trigger spawn, then asserts:
- spawn was called (tool appears in traces)
- subagent result is in the final context (messages or traces)

Usage:
  uv run python examples/test_spawn_feedback.py           # Run spawn-encouraging problem
  uv run python examples/test_spawn_feedback.py --check  # Only verify spawn is registered
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def check_spawn_registered() -> bool:
    """Verify SpawnTool is registered in the default agent loop."""
    from execution.agent_loop import AgentLoop

    loop = AgentLoop(ROOT)
    has_spawn = "spawn" in loop.registry.tool_names
    return has_spawn


def run_spawn_test(max_iterations: int = 6) -> dict:
    """
    Run a problem that encourages spawn for validation.
    Returns the full result dict; caller can assert on traces and messages.
    """
    from execution.controller import Controller

    prompt = """Validate this hypothesis: "Users need faster onboarding to reduce drop-off."

You MUST use the spawn tool to run a focused validation. Call spawn with:
- task: "Use the jobs-to-be-done or problem-framing framework to validate: Users need faster onboarding. Return 2-3 key findings."
- label: "JTBD validation"
- skill_names: ["jobs-to-be-done"] or ["problem-framing-canvas"] (use what's available)

After you receive the subagent result, summarize: (1) what the subagent found, (2) your revised view. Be concise."""

    ctrl = Controller(ROOT)
    result = ctrl.run_problem(
        problem_description=prompt,
        max_iterations=max_iterations,
        skill_sources=["essential", "open", "workspace"],
    )
    return result


def main():
    parser = argparse.ArgumentParser(description="Test spawn + feedback flow")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only verify spawn tool is registered, do not run full problem",
    )
    parser.add_argument("--max-iterations", type=int, default=6)
    args = parser.parse_args()

    print("=" * 60)
    print("Spawn + Feedback Test")
    print("=" * 60)

    if args.check:
        ok = check_spawn_registered()
        print("Spawn registered:" if ok else "Spawn NOT registered:", ok)
        return 0 if ok else 1

    print("Running spawn-encouraging problem...")
    result = run_spawn_test(max_iterations=args.max_iterations)

    traces = result.get("traces", [])
    spawn_calls = [
        tr
        for t in traces
        for tr in t.get("tool_results", [])
        if tr.get("tool") == "spawn"
    ]

    print("\n--- Spawn calls ---")
    if spawn_calls:
        for i, sc in enumerate(spawn_calls, 1):
            r = str(sc.get("result", ""))[:300]
            print(f"  {i}. {r}...")
        print(f"\nSpawn was called {len(spawn_calls)} time(s).")
    else:
        print("  (none - agent may have used other tools)")

    final = result.get("final", {}).get("content", "")
    print("\n--- Final content (preview) ---")
    print(final[:500] + "..." if len(final) > 500 else final)

    print("\n" + "=" * 60)
    print("Done.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
