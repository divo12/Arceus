#!/usr/bin/env python3
"""
CLI for cron jobs and gateway (heartbeat + cron).

Usage:
  uv run python scripts/run_gateway.py add --message "Break time!" --every 1200
  uv run python scripts/run_gateway.py add --message "Morning standup" --cron "0 9 * * 1-5" --tz "America/Vancouver"
  uv run python scripts/run_gateway.py list
  uv run python scripts/run_gateway.py remove <job_id>
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

    job = svc.add_job(
        name=args.message[:30],
        schedule=schedule,
        message=args.message,
        delete_after_run=bool(args.at),
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
    add_p.add_argument("--message", "-m", required=True, help="Job message")
    add_p.add_argument("--every", "-e", type=int, help="Interval in seconds (e.g. 1200 = 20 min)")
    add_p.add_argument("--cron", "-c", help="Cron expression (e.g. '0 9 * * 1-5')")
    add_p.add_argument("--tz", help="IANA timezone for cron (e.g. America/Vancouver)")
    add_p.add_argument("--at", help="One-time ISO datetime (e.g. 2026-02-21T10:00:00)")
    add_p.set_defaults(func=_add)

    list_p = sub.add_parser("list", help="List cron jobs")
    list_p.add_argument("--all", "-a", action="store_true", help="Include disabled jobs")
    list_p.set_defaults(func=_list)

    rm_p = sub.add_parser("remove", help="Remove a cron job")
    rm_p.add_argument("job_id", help="Job ID from list")
    rm_p.set_defaults(func=_remove)

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
