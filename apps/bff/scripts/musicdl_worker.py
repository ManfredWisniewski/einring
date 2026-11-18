#!/usr/bin/env python3
"""MusicDL worker — resolves a YouTube URL and downloads each item via
wit_pytools.ytdlptools, reporting JSON-lines progress on stdout.

Usage: musicdl_worker.py <url> <staging_dir>
Contract: +wit/specs/einring/einmusic-ytdl/plan.md
"""

import json
import sys
from pathlib import Path

def _repo_root(start: Path) -> Path:
    """Nearest ancestor containing the wit_pytools checkout."""
    for d in (start, *start.parents):
        if (d / "wit_pytools" / "ytdlptools.py").exists():
            return d
    return start.parents[2]


sys.path.insert(0, str(_repo_root(Path(__file__).resolve())))

from wit_pytools import ytdlptools


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    if len(sys.argv) != 3:
        emit({"type": "error", "error": "usage: musicdl_worker.py <url> <staging_dir>"})
        return 2
    url, staging = sys.argv[1], Path(sys.argv[2])
    try:
        items = ytdlptools.resolve_items(url)
    except Exception as exc:
        emit({"type": "error", "error": str(exc)[:400]})
        return 1
    emit({"type": "resolved", "count": len(items)})
    for item in items:
        try:
            result = ytdlptools.download_audio(item.url, staging)
            done = result.items[0] if result.items else None
        except Exception as exc:
            done = None
            error = str(exc)[:400]
        else:
            error = done.error if done else "no result"
        emit({
            "type": "item",
            "url": item.url,
            "title": item.title,
            "video_id": item.video_id,
            "ok": bool(done and done.ok),
            "file_path": done.file_path if done else None,
            "error": error,
        })
    emit({"type": "done"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
