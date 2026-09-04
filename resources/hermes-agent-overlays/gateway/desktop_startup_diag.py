"""Bounded startup diagnostics: no credentials, locals, or source text."""
import json
import os
from pathlib import Path
import sys
import threading
import time

_started = time.monotonic()
_stop = threading.Event()
_phase = "initializing"
_thread = None


def record(stage, **fields):
    try:
        home = os.environ.get("HERMES_HOME")
        if not home:
            return
        directory = Path(home) / "logs"
        directory.mkdir(parents=True, exist_ok=True)
        row = dict(stage=stage, pid=os.getpid(), parent_pid=os.getppid(),
                   at_ms=int(time.time() * 1000),
                   elapsed_ms=round((time.monotonic() - _started) * 1000),
                   startup_id=os.environ.get("HERMES_GATEWAY_START_ID", ""), **fields)
        with (directory / "gateway-startup-diag.jsonl").open("a", encoding="utf-8") as out:
            out.write(json.dumps(row, ensure_ascii=True) + "\n")
    except Exception:
        pass


def phase(name):
    global _phase
    _phase = name
    record(name)


def _watch():
    # At most 12 samples; does not keep the interpreter alive.
    for _ in range(12):
        if _stop.wait(10):
            return
        try:
            stacks = []
            for ident, frame in sys._current_frames().items():
                stack = []
                while frame is not None and len(stack) < 64:
                    stack.append(dict(file=frame.f_code.co_filename,
                                      function=frame.f_code.co_name,
                                      line=frame.f_lineno))
                    frame = frame.f_back
                stacks.append(dict(thread_id=ident, frames=stack))
            record("slow_start_stack", phase=_phase, threads=stacks)
        except Exception:
            pass


def begin():
    global _thread
    try:
        if _thread is not None:
            return
        phase("gateway_module_import.begin")
        _thread = threading.Thread(target=_watch, name="gateway-startup-diag", daemon=True)
        _thread.start()
    except Exception:
        pass


def finish():
    _stop.set()
    phase("api_listening")
