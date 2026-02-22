#!/usr/bin/env python3
"""
Test runner for Web Search MCP integration with Arceus main agent.

Runs the main agent with Web Search MCP tools (full-web-search, get-web-search-summaries,
get-single-web-page-content) when configured in .arceus/config.json.

Usage:
  uv run python examples/test_web_search_mcp.py              # Quick search test
  uv run python examples/test_web_search_mcp.py --ideas      # Full PM ideas sweep
  uv run python examples/test_web_search_mcp.py "your query" # Custom search query
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def run_search_test(query: str = "AI product management tools 2025", max_iterations: int = 6) -> str:
    """Run main agent with a search query; uses Web Search MCP if configured."""
    from execution.controller import Controller

    prompt = f"""Search the web for: {query}

Use available search tools (web_search, searx_search, or mcp_web_search_* if present).
Summarize 2-3 key findings in 2-3 sentences. Be concise."""

    ctrl = Controller(ROOT)
    result = ctrl.run_problem(
        problem_description=prompt,
        max_iterations=max_iterations,
        skill_sources=["essential", "open"],
    )
    content = result.get("final", {}).get("content", "No response")
    return content


def run_ideas_sweep(max_iterations: int = 12) -> str:
    """Run full PM ideas sweep (surf web, create PM_IDEAS.md)."""
    from execution.controller import Controller

    ctrl = Controller(ROOT)
    return ctrl.run_ideas_sweep(max_iterations=max_iterations)


def main():
    parser = argparse.ArgumentParser(description="Test Web Search MCP with Arceus main agent")
    parser.add_argument(
        "query",
        nargs="?",
        default="AI product management tools 2025",
        help="Search query (default: AI product management tools 2025)",
    )
    parser.add_argument("--ideas", action="store_true", help="Run full PM ideas sweep instead")
    parser.add_argument("--max-iterations", type=int, default=6, help="Max agent iterations")
    args = parser.parse_args()

    print("=" * 60)
    print("Web Search MCP Test Runner")
    print("=" * 60)

    if args.ideas:
        print("Running PM ideas sweep (creates PM_IDEAS.md)...")
        result = run_ideas_sweep(max_iterations=args.max_iterations)
        print("\n--- Result ---")
        print(result[:1500] + "..." if len(result) > 1500 else result)
        print("\nCheck PM_IDEAS.md for full output.")
    else:
        print(f"Query: {args.query}")
        print("-" * 60)
        result = run_search_test(query=args.query, max_iterations=args.max_iterations)
        print("\n--- Result ---")
        print(result)

    print("\n" + "=" * 60)
    print("Done.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
