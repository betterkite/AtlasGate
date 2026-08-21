from __future__ import annotations

import argparse
import json
import sys
import traceback

from atlasgate_agent import AgentCoreError, prepare_knowledge_run
from atlasgate_agent.ingest import prepare_ingest_analysis, prepare_ingest_generation
from atlasgate_agent.lint import prepare_lint


def configure_utf8_streams() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")


def run_operation(db_path: str, request: dict) -> dict:
    """Dispatch one worker request by its op field (default: knowledge ask)."""
    op = request.pop("op", "ask")
    if op == "ask":
        return prepare_knowledge_run(db_path, request)
    if op == "ingest_analysis":
        return prepare_ingest_analysis(db_path, request)
    if op == "ingest_generation":
        return prepare_ingest_generation(db_path, request)
    if op == "ingest_lint":
        return prepare_lint(db_path, request)
    raise AgentCoreError("unknown_operation", f"Unknown agent operation: {op}")


def main() -> int:
    configure_utf8_streams()
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    if args.loop:
        return run_loop(args.db)
    try:
        request = json.load(sys.stdin)
        result = run_operation(args.db, request)
        json.dump({"ok": True, "result": result}, sys.stdout, ensure_ascii=False)
        return 0
    except AgentCoreError as error:
        json.dump(
            {"ok": False, "error": {"code": error.code, "message": str(error)}},
            sys.stdout,
            ensure_ascii=False,
        )
        return 0
    except Exception as error:  # pragma: no cover - defensive worker boundary
        traceback.print_exc(file=sys.stderr)
        json.dump(
            {"ok": False, "error": {"code": "python_agent_error", "message": str(error)}},
            sys.stdout,
            ensure_ascii=False,
        )
        return 1


def run_loop(db_path: str) -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            envelope = json.loads(line)
            request_id = envelope.get("id")
            result = run_operation(db_path, envelope.get("input", {}))
            payload = {"id": request_id, "ok": True, "result": result}
        except AgentCoreError as error:
            payload = {
                "id": request_id,
                "ok": False,
                "error": {"code": error.code, "message": str(error)},
            }
        except Exception as error:  # pragma: no cover - defensive worker boundary
            traceback.print_exc(file=sys.stderr)
            payload = {
                "id": request_id,
                "ok": False,
                "error": {"code": "python_agent_error", "message": str(error)},
            }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
