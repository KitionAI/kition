#!/usr/bin/env python3
"""Fail when a tracked source file contains blanked-out comment blocks.

An earlier cleanup replaced non-English comments with whitespace instead of
deleting or rewriting them, leaving runs of lines that contain only spaces.
Those runs carry no information and hide where design intent used to be.
This guard reports any line that contains only spaces or tabs so the pattern
cannot return. Rewrite the comment in English or delete the line. Whitespace
inside template literals is not exempt; fixtures should not rely on it.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCANNED_SUFFIXES = {".ts", ".tsx", ".mjs", ".cjs", ".js", ".sh", ".py", ".css"}
SCANNED_ROOTS = ("src/", "electron/", "scripts/", "e2e/", "tooling/")
BLANK_COMMENT_LINE = re.compile(r"^[ \t]+$")


def tracked_files() -> list[Path]:
    output = subprocess.run(
        ["git", "ls-files", "--", *SCANNED_ROOTS],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [
        REPO_ROOT / line
        for line in output.splitlines()
        if Path(line).suffix in SCANNED_SUFFIXES
    ]


def main() -> int:
    violations: list[tuple[str, int]] = []
    for path in tracked_files():
        try:
            lines = path.read_text(encoding="utf-8").split("\n")
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(lines, start=1):
            if BLANK_COMMENT_LINE.match(line):
                violations.append((path.relative_to(REPO_ROOT).as_posix(), number))

    if violations:
        print("Blanked comment lines found (lines containing only spaces or tabs):", file=sys.stderr)
        for relative_path, number in violations[:200]:
            print(f"  {relative_path}:{number}", file=sys.stderr)
        if len(violations) > 200:
            print(f"  ... and {len(violations) - 200} more", file=sys.stderr)
        print("Rewrite the comment in English or delete the line.", file=sys.stderr)
        return 1

    print("OK: no blanked comment blocks in tracked source files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
