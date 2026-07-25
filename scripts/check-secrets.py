#!/usr/bin/env python3
"""Reject tracked private keys and high-confidence credential formats."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SENSITIVE_SUFFIXES = {".key", ".p8", ".p12", ".pem"}
SENSITIVE_NAMES = {".env", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"}
SECRET_PATTERNS = (
    ("private key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("OpenAI-style API key", re.compile(r"\bsk-[A-Za-z0-9_-]{24,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("Stripe live secret", re.compile(r"\bsk_live_[A-Za-z0-9]{16,}\b")),
)


def tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return [entry.decode("utf-8") for entry in result.stdout.split(b"\0") if entry]


def main() -> int:
    findings: list[str] = []
    for relative_path in tracked_files():
        path = REPO_ROOT / relative_path
        lowered_name = path.name.lower()
        if lowered_name in SENSITIVE_NAMES or path.suffix.lower() in SENSITIVE_SUFFIXES:
            findings.append(f"{relative_path}: sensitive credential filename is tracked")
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if b"\0" in raw:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{relative_path}:{line}: possible {label}")

    if findings:
        print("Tracked credential scan failed:")
        for finding in findings:
            print(f"  {finding}")
        print("Remove the credential, rotate it, and purge it from Git history before publishing.")
        return 1

    print("OK: no tracked private keys or high-confidence credential formats found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
