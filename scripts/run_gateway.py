#!/usr/bin/env python3
"""
CLI for cron jobs and gateway (heartbeat + cron).

Usage:
  uv run python scripts/run_gateway.py add --message "Break time!" --every 1200
  uv run python scripts/run_gateway.py add --new-ideas --cron "0 9 * * *"   # Cursor for PMs → new_ideas.md
  uv run python scripts/run_gateway.py add --ideas --cron "0 9 * * *"       # PM ideas → PM_IDEAS.md
  uv run python scripts/run_gateway.py add --pm-loop --every 900            # PM loop continuous cycle
  uv run python scripts/run_gateway.py list
  uv run python scripts/run_gateway.py remove <job_id>
  uv run python scripts/run_gateway.py new_ideas   # Run new ideas sweep once
  uv run python scripts/run_gateway.py ideas       # Run PM ideas sweep once
  uv run python scripts/run_gateway.py pm_loop     # Run PM loop once
  uv run python scripts/run_gateway.py run [--heartbeat-interval 1800] [--no-heartbeat] [--no-cron]
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Add project root to path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from observability import configure_logging
configure_logging(ROOT)


def _add(args):
    from cron.service import CronService
    from cron.types import CronSchedule

    store_path = ROOT / ".arceus" / "cron.json"
    svc = CronService(store_path=store_path)

    if args.every:
        schedule = CronSchedule(kind="every", every_ms=args.every * 1000)
    elif args.cron:
        schedule = CronSchedule(kind="cron", expr=args.cron, tz=args.tz)
    elif args.at:
        from datetime import datetime
        dt = datetime.fromisoformat(args.at)
        schedule = CronSchedule(kind="at", at_ms=int(dt.timestamp() * 1000))
    else:
        print("Error: specify --every, --cron, or --at")
        sys.exit(1)

    if not args.ideas and not args.new_ideas and not args.pm_loop and not args.message:
        print("Error: specify --message, --ideas, --new-ideas, or --pm-loop")
        sys.exit(1)

    payload_kind = "agent_turn"
    name = args.message[:30] if args.message else "PM ideas sweep"
    message = args.message or "PM ideas sweep"
    if args.ideas:
        payload_kind = "ideas_sweep"
        name = "PM ideas sweep"
        message = "PM ideas sweep"
    elif args.new_ideas:
        payload_kind = "new_ideas"
        name = "New ideas (Cursor for PMs)"
        message = "New ideas sweep: Cursor for product managers — what to build next"
    elif args.pm_loop:
        payload_kind = "pm_loop"
        name = "PM loop (continuous)"
        message = (
            args.message
            or "PM loop: iterate problem->evidence->options->decision->plan->feedback"
        )

    job = svc.add_job(
        name=name,
        schedule=schedule,
        message=message,
        delete_after_run=bool(args.at),
        payload_kind=payload_kind,
    )
    print(f"Created job '{job.name}' (id: {job.id})")


def _list(args):
    from cron.service import CronService

    store_path = ROOT / ".arceus" / "cron.json"
    svc = CronService(store_path=store_path)
    jobs = svc.list_jobs(include_disabled=args.all)

    if not jobs:
        print("No scheduled jobs.")
        return

    print("Scheduled jobs:")
    for j in jobs:
        status = "enabled" if j.enabled else "disabled"
        print(f"  - {j.name} (id: {j.id}, {status}, {j.schedule.kind})")


def _remove(args):
    from cron.service import CronService

    store_path = ROOT / ".arceus" / "cron.json"
    svc = CronService(store_path=store_path)
    if svc.remove_job(args.job_id):
        print(f"Removed job {args.job_id}")
    else:
        print(f"Job {args.job_id} not found")
        sys.exit(1)


def _ideas(args):
    """Run PM ideas sweep once (creates PM_IDEAS.md)."""
    from pm_ideas.service import run_ideas_sweep
    print("Running PM ideas sweep...")
    run_ideas_sweep(ROOT, max_iterations=args.max_iterations)
    print("Done. Check PM_IDEAS.md")


def _new_ideas(args):
    """Run new ideas sweep once: Cursor-for-PMs problem, spawn subagents, creates new_ideas.md."""
    from pm_ideas.service import run_new_ideas_sweep
    print("Running new ideas sweep (Cursor for PMs)...")
    run_new_ideas_sweep(ROOT, max_iterations=args.max_iterations)
    print("Done. Check new_ideas.md")


def _pm_loop(args):
    """Run PM loop once with one or more cycles."""
    from execution.controller import Controller

    ctrl = Controller(ROOT)
    result = ctrl.run_pm_problem(
        idea=args.idea,
        loop_id=args.loop_id,
        max_cycles=args.max_cycles,
        simulate_feedback=not args.no_sim_feedback,
        cooldown_seconds=args.cooldown_seconds,
    )
    print(
        f"PM loop done. loop_id={result.get('loop_id')} "
        f"cycles={result.get('cycles_executed')} "
        f"remaining_queue={len(result.get('state', {}).get('problem_queue', []))}"
    )


def _run(args):
    from execution.controller import Controller

    ctrl = Controller(ROOT)
    print("Starting gateway (heartbeat + cron). Ctrl+C to stop.")
    print(f"  Heartbeat: {'every %ds' % args.heartbeat_interval if args.heartbeat else 'disabled'}")
    print(f"  Cron: {'enabled' if args.cron else 'disabled'}")
    asyncio.run(
        ctrl.run_gateway(
            heartbeat_interval_s=args.heartbeat_interval,
            heartbeat_enabled=args.heartbeat,
            cron_enabled=args.cron,
        )
    )


def main():
    parser = argparse.ArgumentParser(description="Cron jobs and gateway CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    add_p = sub.add_parser("add", help="Add a cron job")
    add_p.add_argument("--message", "-m", help="Job message (required for agent_turn)")
    add_p.add_argument("--every", "-e", type=int, help="Interval in seconds (e.g. 1200 = 20 min)")
    add_p.add_argument("--cron", "-c", help="Cron expression (e.g. '0 9 * * 1-5')")
    add_p.add_argument("--tz", help="IANA timezone for cron (e.g. America/Vancouver)")
    add_p.add_argument("--at", help="One-time ISO datetime (e.g. 2026-02-21T10:00:00)")
    add_p.add_argument("--ideas", action="store_true", help="PM ideas sweep → PM_IDEAS.md")
    add_p.add_argument("--new-ideas", action="store_true", help="New ideas sweep (Cursor for PMs) → new_ideas.md")
    add_p.add_argument("--pm-loop", action="store_true", help="PM loop cycle job")
    add_p.set_defaults(func=_add)

    list_p = sub.add_parser("list", help="List cron jobs")
    list_p.add_argument("--all", "-a", action="store_true", help="Include disabled jobs")
    list_p.set_defaults(func=_list)

    rm_p = sub.add_parser("remove", help="Remove a cron job")
    rm_p.add_argument("job_id", help="Job ID from list")
    rm_p.set_defaults(func=_remove)

    ideas_p = sub.add_parser("ideas", help="Run PM ideas sweep once (PM_IDEAS.md)")
    ideas_p.add_argument("--max-iterations", type=int, default=12)
    ideas_p.set_defaults(func=_ideas)

    new_ideas_p = sub.add_parser("new_ideas", help="Run new ideas sweep once (new_ideas.md, Cursor for PMs)")
    new_ideas_p.add_argument("--max-iterations", type=int, default=12)
    new_ideas_p.set_defaults(func=_new_ideas)

    pm_loop_p = sub.add_parser("pm_loop", help="Run PM loop once (continuous PM cycle engine)")
    pm_loop_p.add_argument("--idea", required=True, help="Initial idea/problem for PM loop")
    pm_loop_p.add_argument("--loop-id", default="pm_loop_default", help="Persistent PM loop id")
    pm_loop_p.add_argument("--max-cycles", type=int, default=1, help="Number of cycles to run this invocation")
    pm_loop_p.add_argument("--cooldown-seconds", type=int, default=0, help="Sleep between cycles")
    pm_loop_p.add_argument("--no-sim-feedback", action="store_true", help="Disable synthetic feedback generation")
    pm_loop_p.set_defaults(func=_pm_loop)

    run_p = sub.add_parser("run", help="Run gateway (heartbeat + cron)")
    run_p.add_argument("--heartbeat-interval", type=int, default=30 * 60, help="Heartbeat interval (seconds)")
    run_p.add_argument("--no-heartbeat", action="store_true", help="Disable heartbeat")
    run_p.add_argument("--no-cron", action="store_true", help="Disable cron")
    run_p.set_defaults(func=_run)

    args = parser.parse_args()
    if args.cmd == "run":
        args.heartbeat = not args.no_heartbeat
        args.cron = not args.no_cron
    args.func(args)


if __name__ == "__main__":
    main()
