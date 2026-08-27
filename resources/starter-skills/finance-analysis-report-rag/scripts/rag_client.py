"""Run the canonical company RAG client bundled with market-report-rag."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[2] / "market-report-rag" / "scripts" / "rag_client.py"
    sys.path.insert(0, str(target.parent))
    runpy.run_path(str(target), run_name="__main__")
