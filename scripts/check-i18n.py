#!/usr/bin/env python3
"""Validate that multilingual text stays inside approved localization files.

The public repository is English-first. Simplified Chinese UI translations and
localized README files are explicit exceptions. Multilingual parsing code must
still use Unicode Script properties or named code-point constants instead of
embedding prose or hiding it behind Unicode escape sequences.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
# Loading copy belongs in locale files or the Skeleton primitive, never inline in JSX.
HARDCODED_LOADING_PATTERN = re.compile(r"Loading(?:\.\.\.|\u2026)")
# Sentence-case JSX text nodes and literal aria-labels are UI copy that
# belongs in the locale files. Existing ones are listed in the baseline,
# which may only shrink; new ones fail the check.
RAW_TEXT_NODE_PATTERN = re.compile(r">\s*([A-Z][a-z]+(?: [a-z][a-z']*)+)\s*<")
RAW_ARIA_LABEL_PATTERN = re.compile(r'aria-label="([^"{}]+)"')
RAW_STRING_BASELINE = REPO_ROOT / "tooling/i18n-raw-strings.baseline.json"
TEXT_SCAN_EXEMPT_PATHS = {
    "docs/legal/THIRD_PARTY_NOTICES.txt",
    "README.md",
    "README.de-DE.md",
    "README.es-ES.md",
    "README.fr-FR.md",
    "README.ja-JP.md",
    "README.ru-RU.md",
    "README.vi-VN.md",
    "README.zh-CN.md",
}
TEXT_SCAN_EXEMPT_PREFIXES = (
    "src/i18n/locales/zh-CN/",
)
ENGLISH_LOCALE_ROOT = REPO_ROOT / "src/i18n/locales/en-US"

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
PLACEHOLDER_RE = re.compile(r"\{\{[^}]+\}\}")


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
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return [entry.decode("utf-8") for entry in result.stdout.split(b"\0") if entry]


def is_text_scan_exempt(relative_path: str) -> bool:
    return relative_path in TEXT_SCAN_EXEMPT_PATHS or relative_path.startswith(
        TEXT_SCAN_EXEMPT_PREFIXES,
    )


def flatten_json_keys(value: object, prefix: str = "") -> set[str]:
    if not isinstance(value, dict):
        return {prefix}
    keys: set[str] = set()
    for key, child in value.items():
        child_prefix = f"{prefix}.{key}" if prefix else key
        keys.update(flatten_json_keys(child, child_prefix))
    return keys


def flatten_json_values(value: object, prefix: str = "") -> dict[str, object]:
    if not isinstance(value, dict):
        return {prefix: value}
    values: dict[str, object] = {}
    for key, child in value.items():
        child_prefix = f"{prefix}.{key}" if prefix else key
        values.update(flatten_json_values(child, child_prefix))
    return values


def localized_locale_roots() -> list[Path]:
    """Every locale directory other than English; each must mirror en-US."""
    return sorted(
        path for path in ENGLISH_LOCALE_ROOT.parent.iterdir()
        if path.is_dir() and path.name != ENGLISH_LOCALE_ROOT.name
    )


def locale_parity_violations() -> list[tuple[str, int, str]]:
    violations: list[tuple[str, int, str]] = []
    for locale_root in localized_locale_roots():
        violations.extend(locale_parity_violations_for(locale_root))
    return violations


def locale_parity_violations_for(locale_root: Path) -> list[tuple[str, int, str]]:
    violations: list[tuple[str, int, str]] = []
    for english_path in sorted(ENGLISH_LOCALE_ROOT.glob("*.json")):
        localized_path = locale_root / english_path.name
        relative_path = localized_path.relative_to(REPO_ROOT).as_posix()
        if not localized_path.is_file():
            violations.append((relative_path, 0, "missing localized namespace"))
            continue
        try:
            import json

            english = json.loads(english_path.read_text(encoding="utf-8"))
            localized = json.loads(localized_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            violations.append((relative_path, 0, f"invalid locale JSON: {error}"))
            continue
        english_keys = flatten_json_keys(english)
        localized_keys = flatten_json_keys(localized)
        missing = sorted(english_keys - localized_keys)
        stale = sorted(localized_keys - english_keys)
        if missing:
            violations.append((relative_path, 0, f"missing locale keys: {', '.join(missing[:10])}"))
        if stale:
            violations.append((relative_path, 0, f"stale locale keys: {', '.join(stale[:10])}"))
        english_values = flatten_json_values(english)
        localized_values = flatten_json_values(localized)
        for key in sorted(english_keys & localized_keys):
            english_value = english_values[key]
            localized_value = localized_values[key]
            if type(english_value) is not type(localized_value):
                violations.append((relative_path, 0, f"locale value type differs at {key}"))
                continue
            if not isinstance(english_value, str):
                continue
            expected_placeholders = sorted(PLACEHOLDER_RE.findall(english_value))
            actual_placeholders = sorted(PLACEHOLDER_RE.findall(localized_value))
            if expected_placeholders != actual_placeholders:
                violations.append((relative_path, 0, f"locale placeholders differ at {key}"))
    return violations


def raw_ui_strings() -> dict[str, tuple[str, int]]:
    """Every raw JSX text node or aria-label literal in a component, keyed by `path|kind|text`."""
    found: dict[str, tuple[str, int]] = {}
    for path in sorted((REPO_ROOT / "src").rglob("*.tsx")):
        relative_path = path.relative_to(REPO_ROOT).as_posix()
        if ".spec." in path.name:
            continue
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in RAW_TEXT_NODE_PATTERN.finditer(line):
                found[f"{relative_path}|text|{match.group(1)}"] = (relative_path, line_number)
            for match in RAW_ARIA_LABEL_PATTERN.finditer(line):
                found[f"{relative_path}|aria-label|{match.group(1)}"] = (relative_path, line_number)
    return found


def raw_string_violations(update_baseline: bool) -> list[tuple[str, int, str]]:
    import json

    found = raw_ui_strings()
    baseline: set[str] = set(json.loads(RAW_STRING_BASELINE.read_text(encoding="utf-8"))) if RAW_STRING_BASELINE.is_file() else set()
    fixed = sorted(baseline - set(found))
    new = sorted(set(found) - baseline)
    if update_baseline:
        RAW_STRING_BASELINE.write_text(json.dumps(sorted(set(found) & baseline), indent=2) + "\n", encoding="utf-8")
        print(f"[i18n-raw-strings] wrote {len(set(found) & baseline)} entries ({len(fixed)} fixed removed).")
        return []
    if fixed:
        print(f"[i18n-raw-strings] {len(fixed)} baseline entries are fixed; run with --update-raw-baseline to shrink the baseline.")
    return [(found[key][0], found[key][1], f"raw UI string {key.split('|', 1)[1]!r}; move it to a locale key") for key in new]


def scan() -> list[tuple[str, int, str]]:
    violations: list[tuple[str, int, str]] = []
    for relative_path in tracked_files():
        if contains_prohibited_script(relative_path):
            violations.append((relative_path, 0, "prohibited script in filename"))

        if is_text_scan_exempt(relative_path):
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

        is_component = relative_path.startswith("src/") and relative_path.endswith(".tsx") and ".spec." not in relative_path
        for line_number, line in enumerate(text.splitlines(), 1):
            if is_component and HARDCODED_LOADING_PATTERN.search(line):
                violations.append((relative_path, line_number, "hardcoded loading text in JSX; use SkeletonRows or an i18n key"))
            if contains_prohibited_script(line):
                violations.append((relative_path, line_number, line.strip()))
            elif contains_prohibited_escape(line):
                violations.append(
                    (relative_path, line_number, "escaped prohibited script code point"),
                )
    violations.extend(locale_parity_violations())
    violations.extend(raw_string_violations("--update-raw-baseline" in sys.argv))
    return violations


def main() -> int:
    os.chdir(REPO_ROOT)
    violations = scan()
    if not violations:
        print("OK: multilingual text is limited to approved localization files and locale keys match.")
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
