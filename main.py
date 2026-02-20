#!/usr/bin/env python3
"""
Arceus entrypoint. Runs the gateway (heartbeat + cron) by default.

Usage:
  uv run python main.py                         # Run gateway (heartbeat + cron)
  uv run python main.py --no-cron               # Run gateway without cron
  uv run python main.py --no-heartbeat         # Run gateway without heartbeat
  uv run python main.py "your problem"          # Run single problem
"""

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description="Arceus PM agent")
    parser.add_argument("problem", nargs="*", help="Problem to solve (runs single problem)")
    parser.add_argument("--no-cron", action="store_true", help="Disable cron jobs")
    parser.add_argument("--no-heartbeat", action="store_true", help="Disable heartbeat")
    parser.add_argument("--heartbeat", type=int, default=30 * 60, help="Heartbeat interval (seconds)")
    args = parser.parse_args()

    from execution.controller import Controller

    ctrl = Controller(ROOT)

    if args.problem:
        problem = " ".join(args.problem)
        result = ctrl.run_problem(problem)
        print(result.get("final", {}).get("content", "No response"))
    else:
        print("Arceus gateway starting. Ctrl+C to stop.")
        print(f"  Cron: {'disabled' if args.no_cron else 'enabled'}")
        print(f"  Heartbeat: {'disabled' if args.no_heartbeat else f'every {args.heartbeat}s'}")
        asyncio.run(
            ctrl.run_gateway(
                heartbeat_interval_s=args.heartbeat,
                heartbeat_enabled=not args.no_heartbeat,
                cron_enabled=not args.no_cron,
            )
        )


if __name__ == "__main__":
    main()
