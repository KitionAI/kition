#!/usr/bin/env bash
set -euo pipefail

dry_run=false
confirmed=false

usage() {
  cat <<'EOF'
Reset local Kition desktop data.

Usage:
  bash scripts/reset-local-data.sh --yes

Options:
  --yes       Execute the deletion.
  --dry-run   Print the paths that would be removed.
  -h, --help  Show this help.

Close the desktop app before running this command.
The reset refuses to run while a Kition desktop or runtime process is active.
EOF
}

kition_running_processes() {
  if command -v ps >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
    ps -ax -o pid=,command= 2>/dev/null | awk '
      {
        pid = $1
        $1 = ""
        sub(/^[[:space:]]+/, "")
        command = $0
        if (command ~ /(^|\/)kition-api([[:space:]]|$)/ || command ~ /electron\/scripts\/dev-electron\.mjs([[:space:]]|$)/ || command ~ /\/Kition\.app\/Contents\/MacOS\/Kition([[:space:]]|$)/) {
          print pid " " command
        }
      }
    '
    return
  fi

  if command -v tasklist >/dev/null 2>&1; then
    tasklist 2>/dev/null | grep -i 'Kition\.exe' || true
    return
  fi
}

for arg in "$@"; do
  case "$arg" in
    --yes) confirmed=true ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$dry_run" != true && "$confirmed" != true ]]; then
  echo "Refusing to delete data without --yes." >&2
  exit 1
fi

if [[ "$dry_run" != true ]]; then
  running_processes="$(kition_running_processes)"
  if [[ -n "$running_processes" ]]; then
    echo "Refusing to reset data while the Kition desktop client or runtime is running." >&2
    echo "Detected processes:" >&2
    while IFS= read -r process_line; do
      echo "  $process_line" >&2
    done <<< "$running_processes"
    if [[ "$(uname -s)" == "Darwin" ]]; then
      echo "On macOS, closing the window does not quit Kition. Use Kition > Quit Kition or press Command-Q." >&2
    fi
    echo "Stop the listed process and run the command again." >&2
    exit 1
  fi
fi

case "$(uname -s)" in
  Darwin)
    paths=(
      "$HOME/Library/Application Support/Kition"
      "$HOME/Library/Caches/Kition"
      "$HOME/Library/Logs/Kition"
    )
    ;;
  Linux)
    paths=(
      "${XDG_CONFIG_HOME:-$HOME/.config}/Kition"
      "${XDG_CACHE_HOME:-$HOME/.cache}/Kition"
      "${XDG_STATE_HOME:-$HOME/.local/state}/Kition"
    )
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    paths=(
      "${APPDATA:-$HOME/AppData/Roaming}/Kition"
      "${LOCALAPPDATA:-$HOME/AppData/Local}/Kition"
      "${LOCALAPPDATA:-$HOME/AppData/Local}/Kition/logs"
    )
    ;;
  *)
    paths=("$HOME/.kition" "$HOME/.cache/Kition" "$HOME/.local/state/Kition")
    ;;
esac

echo "Kition desktop data reset:"
reset_failed=false
for target in "${paths[@]}"; do
  echo "  - $target"
  if [[ "$dry_run" != true ]]; then
    rm -rf "$target"
    if [[ -e "$target" ]]; then
      echo "Failed to remove: $target" >&2
      reset_failed=true
    fi
  fi
done

if [[ "$reset_failed" == true ]]; then
  echo "Reset incomplete. Make sure all Kition processes are stopped, then retry." >&2
  exit 1
fi

if [[ "$dry_run" == true ]]; then
  echo "Dry run complete."
else
  echo "Reset complete."
fi
