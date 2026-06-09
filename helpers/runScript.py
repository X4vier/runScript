"""runScript Python helper — the ESCAPE HATCH, not a peer of the TS helper.

Default to TypeScript on Bun for scripts. Use Python ONLY when an essential library
exists only in Python (a specific ML/scientific package with no JS equivalent) — not
because Python feels more familiar. This file exists so that, when you genuinely must
use Python, the script still emits progress in the engine's format and checkpoints
correctly instead of being hand-rolled.

Emit progress as a single OVERWRITTEN line "<done> <total> <message>" to the file
runScript injects at $RUNSCRIPT_PROGRESS. Falls back to a local .progress/ dir
when run standalone, so the same script works in both contexts.

    from runScript import progress, checkpoint

    ck = checkpoint("ingest", {"done": []})
    todo = [f for f in files if f not in ck.state["done"]]
    for i, f in enumerate(todo):
        ingest_one(f)                 # idempotent (UPSERT)
        ck.state["done"].append(f); ck.save()
        progress(i + 1, len(todo), f)
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _run_dir() -> Path:
    d = os.environ.get("RUNSCRIPT_RUN_DIR") or ".progress"
    p = Path(d)
    p.mkdir(parents=True, exist_ok=True)
    return p


def progress(done: int, total: int, msg: str = "") -> None:
    """Write the latest progress line (overwrite, not append)."""
    target = os.environ.get("RUNSCRIPT_PROGRESS")
    if not target:
        target = str(_run_dir() / "progress")
    with open(target, "w") as f:
        f.write(f"{done} {total} {msg}\n".rstrip(" ") + ("" if msg else "\n"))


class _Checkpoint:
    def __init__(self, name: str, initial: Any):
        self._file = _run_dir() / f"{name}.checkpoint.json"
        self.resumed = self._file.exists()
        self.state = (
            json.loads(self._file.read_text()) if self.resumed else initial
        )

    def save(self) -> None:
        self._file.write_text(json.dumps(self.state, indent=2))

    def clear(self) -> None:
        if self._file.exists():
            self._file.unlink()


def checkpoint(name: str, initial: Any) -> _Checkpoint:
    """Persisted resume state. Loaded on start so a re-run skips done units.

    The loop body MUST be idempotent (UPSERT, not blind insert) so a
    kill/timeout resumes cleanly.
    """
    return _Checkpoint(name, initial)
