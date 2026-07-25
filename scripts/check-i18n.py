#!/usr/bin/env python3
"""Fail when tracked filenames or UTF-8 text contain prohibited CJK scripts.

The public repository is English-first. Multilingual parsing code must use
Unicode Script properties or named code-point constants instead of embedding
non-English prose or hiding it behind Unicode escape sequences.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
TEXT_SCAN_EXEMPT_PATHS = {
    "docs/legal/THIRD_PARTY_NOTICES.txt",
}

PROHIBITED_RANGES = (
    (0x3400, 0x4DBF),   # CJK Unified Ideographs Extension A
    (0x4E00, 0x9FFF),   # CJK Unified Ideographs
    (0xF900, 0xFAFF),   # CJK Compatibility Ideographs
    (0x20000, 0x2FA1F), # Supplementary ideograph planes
    (0x3040, 0x309F),   # Hiragana
    (0x30A0, 0x30FF),   # Katakana
    (0x31F0, 0x31FF),   # Katakana phonetic extensions
    (0xAC00, 0xD7AF),   # Hangul syllables
)

ESCAPE_PREFIX = chr(92) + "u"
ESCAPE_RE = re.compile(
    re.escape(ESCAPE_PREFIX) + r"(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))",
)


def is_prohibited_codepoint(value: int) -> bool:
    return any(start <= value <= end for start, end in PROHIBITED_RANGES)


def contains_prohibited_script(value: str) -> bool:
    return any(is_prohibited_codepoint(ord(char)) for char in value)


def contains_prohibited_escape(value: str) -> bool:
    for match in ESCAPE_RE.finditer(value):
        codepoint = int(match.group(1) or match.group(2), 16)
        if is_prohibited_codepoint(codepoint):
            return True
    return False


def tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return [entry.decode("utf-8") for entry in result.stdout.split(b"\0") if entry]


def scan() -> list[tuple[str, int, str]]:
    violations: list[tuple[str, int, str]] = []
    for relative_path in tracked_files():
        if contains_prohibited_script(relative_path):
            violations.append((relative_path, 0, "prohibited script in filename"))

        if relative_path in TEXT_SCAN_EXEMPT_PATHS:
            continue

        path = REPO_ROOT / relative_path
        if not path.is_file():
            continue

        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\0" in raw:
            continue

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue

        for line_number, line in enumerate(text.splitlines(), 1):
            if contains_prohibited_script(line):
                violations.append((relative_path, line_number, line.strip()))
            elif contains_prohibited_escape(line):
                violations.append(
                    (relative_path, line_number, "escaped prohibited script code point"),
                )
    return violations


def main() -> int:
    os.chdir(REPO_ROOT)
    violations = scan()
    if not violations:
        print("OK: tracked filenames and text are free of prohibited CJK scripts.")
        return 0

    for path, line_number, detail in violations[:200]:
        location = f"{path}:{line_number}" if line_number else path
        snippet = detail[:180]
        print(f"  {location}: {snippet}")
    if len(violations) > 200:
        print(f"  ... {len(violations) - 200} more violation(s)")
    print(f"FAIL: found {len(violations)} prohibited CJK occurrence(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
