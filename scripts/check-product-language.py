#!/usr/bin/env python3
"""Reject borrowed product terminology from user-visible English surfaces."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
ENGLISH_LOCALE_ROOT = REPO_ROOT / "src/i18n/locales/en-US"
ONBOARDING_ROOT = REPO_ROOT / "public/onboarding"
DOCUMENT_PATHS = (
    REPO_ROOT / "README.md",
    REPO_ROOT / "docs/design.md",
    REPO_ROOT / "docs/product-ui-style.md",
)
PROHIBITED_WORDS = (
    "tea" + "ble",
    "obsi" + "dian",
    "no" + "tion",
    "air" + "table",
    "star" + "ter",
    "kit" + "able",
    "va" + "ult",
    "wiki" + "link",
    "back" + "link",
    "pro" + "perty",
    "pro" + "perties",
    "data" + "base",
)


def normalized_visible_text(value: str) -> str:
    return re.sub(r"\.kitable\b", "", value, flags=re.IGNORECASE)


def matched_word(value: str) -> str | None:
    normalized = normalized_visible_text(value).casefold()
    return next(
        (
            word
            for word in PROHIBITED_WORDS
            if re.search(rf"(?<![a-z]){re.escape(word)}(?![a-z])", normalized)
        ),
        None,
    )


def scan_json_value(value: Any, path: str, violations: list[tuple[str, str, str]]) -> None:
    if isinstance(value, str):
        word = matched_word(value)
        if word:
            violations.append((path, value, word))
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            scan_json_value(child, f"{path}[{index}]", violations)
        return
    if isinstance(value, dict):
        for key, child in value.items():
            scan_json_value(child, f"{path}.{key}" if path else key, violations)


def scan_json(path: Path, violations: list[tuple[str, str, str]]) -> None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        violations.append((str(path.relative_to(REPO_ROOT)), str(error), "invalid-json"))
        return
    scan_json_value(value, str(path.relative_to(REPO_ROOT)), violations)


def scan_text(path: Path, violations: list[tuple[str, str, str]]) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    relative_path = str(path.relative_to(REPO_ROOT))
    for line_number, line in enumerate(text.splitlines(), 1):
        word = matched_word(line)
        if word:
            violations.append((f"{relative_path}:{line_number}", line.strip(), word))


def scan() -> list[tuple[str, str, str]]:
    violations: list[tuple[str, str, str]] = []
    for path in sorted(ENGLISH_LOCALE_ROOT.glob("*.json")):
        scan_json(path, violations)
    for path in sorted(ONBOARDING_ROOT.rglob("*")):
        if path.suffix == ".json":
            scan_json(path, violations)
        elif path.suffix in {".md", ".txt"}:
            scan_text(path, violations)
    for path in DOCUMENT_PATHS:
        scan_text(path, violations)
    return violations


def main() -> int:
    violations = scan()
    if not violations:
        print("OK: user-visible English uses Kition product terminology.")
        return 0

    for location, value, word in violations[:200]:
        print(f"  {location}: prohibited product term '{word}' in {value[:160]!r}")
    if len(violations) > 200:
        print(f"  ... {len(violations) - 200} more violation(s)")
    print(f"FAIL: found {len(violations)} product-language violation(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
