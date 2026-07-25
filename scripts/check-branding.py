#!/usr/bin/env python3
"""Reject non-canonical product identities in tracked files and paths."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
PROHIBITED_SUBSTRINGS = (
    "tea" + "ble",
    "obsi" + "dian",
)
PROHIBITED_WORDS = (
    "no" + "tion",
    "air" + "table",
)


def tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return [entry.decode("utf-8") for entry in result.stdout.split(b"\0") if entry]


def matched_identity(value: str) -> str | None:
    normalized = value.casefold()
    substring = next(
        (identity for identity in PROHIBITED_SUBSTRINGS if identity in normalized),
        None,
    )
    if substring:
        return substring
    return next(
        (
            identity
            for identity in PROHIBITED_WORDS
            if re.search(rf"(?<![a-z]){re.escape(identity)}(?![a-z])", normalized)
        ),
        None,
    )


def matched_binary_identity(raw: bytes) -> tuple[str, int] | None:
    normalized = raw.lower()
    for identity in PROHIBITED_SUBSTRINGS:
        offset = normalized.find(identity.encode("ascii"))
        if offset >= 0:
            return identity, offset
    for identity in PROHIBITED_WORDS:
        match = re.search(
            rb"(?<![a-z])" + re.escape(identity.encode("ascii")) + rb"(?![a-z])",
            normalized,
        )
        if match:
            return identity, match.start()
    return None


def scan() -> list[tuple[str, str, str]]:
    violations: list[tuple[str, str, str]] = []
    for relative_path in tracked_files():
        path = REPO_ROOT / relative_path
        if not path.is_file():
            continue

        identity = matched_identity(relative_path)
        if identity:
            violations.append((relative_path, "", identity))

        try:
            raw = path.read_bytes()
        except OSError:
            continue
        is_binary = b"\0" in raw
        text: str | None = None
        if not is_binary:
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                is_binary = True

        if text is not None:
            for line_number, line in enumerate(text.splitlines(), 1):
                identity = matched_identity(line)
                if identity:
                    violations.append((relative_path, str(line_number), identity))
        elif is_binary:
            match = matched_binary_identity(raw)
            if match:
                identity, offset = match
                violations.append((relative_path, f"byte {offset}", identity))
    return violations


def main() -> int:
    violations = scan()
    if not violations:
        print("OK: tracked files and paths use the canonical Kition identity.")
        return 0

    for path, detail, identity in violations[:200]:
        location = f"{path}:{detail}" if detail else path
        print(f"  {location}: prohibited non-canonical identity '{identity}'")
    if len(violations) > 200:
        print(f"  ... {len(violations) - 200} more violation(s)")
    print(f"FAIL: found {len(violations)} branding violation(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
