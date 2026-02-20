#!/usr/bin/env python3
"""
Arceus entrypoint. Runs the gateway (heartbeat + cron) by default.

Usage:
  uv run python main.py                         # Run gateway (heartbeat + cron)
  uv run python main.py chat                     # Interactive chat (Markdown, streaming)
  uv run python main.py chat --no-markdown       # Chat with plain text output
  uv run python main.py chat --no-stream         # Chat without token streaming
  uv run python main.py status                   # Show config, provider, cron, sessions
  uv run python main.py onboard                  # Create .arceus/config.json, sessions/, skills/
  uv run python main.py --no-cron               # Run gateway without cron
  uv run python main.py "your problem"          # Run single problem
"""

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Configure logging to workspace/.arceus/logs/arceus.log
from observability import configure_logging
configure_logging(ROOT)

EXIT_COMMANDS = {"exit", "quit", "/exit", "/quit", ":q"}


def run_status(workspace: Path | None = None) -> None:
    """Print status: config path, provider, cron jobs, heartbeat, sessions."""
    from config import load_config
    from config.loader import find_config_path
    from cron.service import CronService
    from session.manager import SessionManager

    workspace = workspace or ROOT
    config = load_config(workspace=workspace)
    config_path = find_config_path(workspace)
    from settings import Settings
    has_key = config.providers.azure.api_key or Settings.AZURE_OPENAI_API_KEY
    has_ep = config.providers.azure.endpoint or Settings.AZURE_OPENAI_ENDPOINT
    provider = "Azure" if (has_key and has_ep) else "Not configured"

    store_path = workspace / ".arceus" / "cron.json"
    cron_svc = CronService(store_path=store_path, on_job=None)
    cron_count = len(cron_svc.list_jobs())

    mgr = SessionManager(workspace)
    sessions = mgr.list_sessions()
    session_count = len(sessions)

    print("Arceus status")
    print("-" * 40)
    print(f"  Config:    {config_path or '(default, no file)'}")
    print(f"  Provider:  {provider}")
    print(f"  Cron jobs: {cron_count}")
    print(f"  Heartbeat: default 1800s")
    print(f"  Sessions:  {session_count}")


def run_onboard(workspace: Path | None = None) -> None:
    """Create .arceus/config.json, sessions/, skills/workspace_skills/ if missing."""
    from config import load_config
    from config.loader import save_config

    workspace = workspace or ROOT
    config_path = workspace / ".arceus" / "config.json"

    created = []
    if not config_path.exists():
        config = load_config(workspace=workspace)
        save_config(config, config_path)
        created.append(str(config_path))
    else:
        created.append(f"(exists) {config_path}")

    sessions_dir = workspace / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    created.append(str(sessions_dir))

    skills_dir = workspace / "skills" / "workspace_skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    created.append(str(skills_dir))

    heartbeat_md = workspace / "HEARTBEAT.md"
    if not heartbeat_md.exists():
        heartbeat_md.write_text(
            "# Heartbeat\n\nTasks for the agent to execute on each heartbeat tick.\n\n"
            "Add markdown tasks here. The agent will process them every 30 minutes by default.\n",
            encoding="utf-8",
        )
        created.append(str(heartbeat_md))

    print("Arceus onboard")
    print("-" * 40)
    for path in created:
        print(f"  {path}")


def run_chat(
    session_key: str = "console:default",
    use_markdown: bool = True,
    workspace: Path | None = None,
    stream: bool = True,
) -> None:
    """Interactive chat mode (nanobot-style). Multi-turn with session persistence."""
    from execution.controller import Controller
    from prompt_toolkit import PromptSession
    from prompt_toolkit.history import FileHistory

    base = workspace or Path.home()
    history_path = base / ".arceus" / "history" / "cli_history"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    session = PromptSession(history=FileHistory(str(history_path)))

    ctrl = Controller(workspace or ROOT)
    print("Arceus chat. Type your problem, or exit/quit/:q to end. (↑/↓ for history)")
    print()

    while True:
        try:
            user_input = session.prompt("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            break

        if not user_input:
            continue
        if user_input.lower() in EXIT_COMMANDS:
            print("Bye.")
            break

        stream_callback = None
        if stream:
            if use_markdown:
                from rich.console import Console
                from rich.live import Live
                from rich.markdown import Markdown
                console = Console()
                console.print("\n[bold]Arceus:[/bold]")
                content_buf: list[str] = [""]

                def _cb(chunk: str) -> None:
                    content_buf[0] += chunk
                    live.update(Markdown(content_buf[0]))

                with Live(Markdown(""), refresh_per_second=8, console=console) as live:
                    result = ctrl.run_problem(
                        user_input, session_key=session_key, stream_callback=_cb
                    )
                print()
            else:
                def _cb(chunk: str) -> None:
                    print(chunk, end="", flush=True)

                print("\nArceus: ", end="", flush=True)
                result = ctrl.run_problem(
                    user_input, session_key=session_key, stream_callback=_cb
                )
                print()
        else:
            result = ctrl.run_problem(user_input, session_key=session_key)

        content = result.get("final", {}).get("content", "No response")
        if not stream:
            if use_markdown:
                from rich.console import Console
                from rich.markdown import Markdown
                console = Console()
                console.print("\n[bold]Arceus:[/bold]")
                console.print(Markdown(content))
                console.print()
            else:
                print(f"\nArceus:\n{content}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Arceus PM agent")
    parser.add_argument("problem", nargs="*", help="Problem to solve, or 'chat' for interactive mode")
    parser.add_argument("--no-cron", action="store_true", help="Disable cron jobs")
    parser.add_argument("--no-heartbeat", action="store_true", help="Disable heartbeat")
    parser.add_argument("--heartbeat", type=int, default=30 * 60, help="Heartbeat interval (seconds)")
    parser.add_argument("--session", default="console:default", help="Session key for chat (default: console:default)")
    parser.add_argument("--no-markdown", action="store_true", help="Plain text output in chat (no Markdown rendering)")
    parser.add_argument("--no-stream", action="store_true", help="Disable token streaming in chat (wait for full response)")
    args = parser.parse_args()

    if args.problem and args.problem[0].lower() == "chat":
        run_chat(
            session_key=args.session,
            use_markdown=not args.no_markdown,
            stream=not args.no_stream,
        )
        return
    if args.problem and args.problem[0].lower() == "status":
        run_status()
        return
    if args.problem and args.problem[0].lower() == "onboard":
        run_onboard()
        return

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
