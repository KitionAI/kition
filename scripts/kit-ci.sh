#!/usr/bin/env bash
#
# Tests a kit's HEAD on GitHub (.github/workflows/kit-ci.yml, through the kit's ci.yml) and lands
# it on main when it is green. The developer's machine only compiles; GitHub runs the tests.
#
#   scripts/kit-ci.sh push <kit>      push HEAD to the kit's ci/agent branch (starts a run)
#   scripts/kit-ci.sh wait <kit>      wait for the run of HEAD; exit 0 when it passed
#   scripts/kit-ci.sh failures <kit>  write $KIT_CI_DIR/<kit>/<run>/summary.txt (each job's result,
#                                     the lines before each failed job's errors) and download their evidence
#   scripts/kit-ci.sh land <kit>      fast-forward origin/main to HEAD when its run passed;
#                                     delete ci/agent
#   scripts/kit-ci.sh status <kit>    print the latest run of HEAD
#
# The kit's checkout is <workspace>/kition-<kit>, where <workspace> is the folder holding this
# Kition checkout (KITION_WORKSPACE overrides it). Needs an authenticated `gh`. GIT names the git
# executable (default: git). KIT_CI_DIR defaults to ${TMPDIR:-/tmp}/kit-ci.

set -euo pipefail

usage() {
  sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ $# -eq 2 ] || usage
command="$1"
kit="$2"
GIT="${GIT:-git}"
workspace="${KITION_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
repo="$workspace/kition-$kit"
slug="KitionAI/kition-$kit"
branch="ci/agent"
out_root="${KIT_CI_DIR:-${TMPDIR:-/tmp}/kit-ci}"

[ -d "$repo/.git" ] || { echo "no kit checkout at $repo" >&2; exit 2; }
[ -f "$repo/.github/workflows/ci.yml" ] || { echo "kition-$kit has no .github/workflows/ci.yml (scripts/kit-ci-install.mjs $kit)" >&2; exit 2; }
sha="$("$GIT" -C "$repo" rev-parse HEAD)"

# The newest ci.yml run of HEAD: "<id> <status> <conclusion>", or nothing.
latest_run() {
  gh run list -R "$slug" --workflow ci.yml --commit "$sha" --limit 1 \
    --json databaseId,status,conclusion -q '.[] | "\(.databaseId) \(.status) \(.conclusion)"'
}

case "$command" in
  push)
    "$GIT" -C "$repo" push --force --quiet origin "HEAD:refs/heads/$branch"
    echo "pushed ${sha:0:12} to $slug $branch"
    ;;

  wait)
    run=""
    for _ in $(seq 1 20); do
      run="$(latest_run 2>/dev/null || true)"
      [ -n "$run" ] && break
      sleep 15
    done
    [ -n "$run" ] || { echo "no ci.yml run of ${sha:0:12} in $slug after 5 minutes (did you push?)" >&2; exit 2; }
    id="${run%% *}"
    echo "waiting for https://github.com/$slug/actions/runs/$id"
    # One API request per poll (KIT_CI_POLL seconds, default 60): many kits wait at once, and the
    # API allows 5000 requests an hour per user. An API error (rate limit, network) is retried.
    while :; do
      state="$(gh api "repos/$slug/actions/runs/$id" -q '"\(.status) \(.conclusion)"' 2>/dev/null || true)"
      case "$state" in
        "completed success") echo "PASSED: run $id of ${sha:0:12}"; break ;;
        completed\ *) echo "FAILED (${state#completed }): run $id of ${sha:0:12} (scripts/kit-ci.sh failures $kit)"; exit 1 ;;
      esac
      sleep "${KIT_CI_POLL:-60}"
    done
    ;;

  failures)
    run="$(latest_run)"
    [ -n "$run" ] || { echo "no ci.yml run of ${sha:0:12} in $slug" >&2; exit 2; }
    id="${run%% *}"
    dir="$out_root/$kit/$id"
    rm -rf "$dir"
    mkdir -p "$dir"
    summary="$dir/summary.txt"
    {
      echo "kit $kit, commit $sha, run https://github.com/$slug/actions/runs/$id"
      echo
      gh run view "$id" -R "$slug" --json jobs -q '.jobs[] | "\(.conclusion // .status)\t\(.name)"'
    } >"$summary"
    gh run view "$id" -R "$slug" --json jobs \
      -q '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | "\(.databaseId)\t\(.name)"' |
      while IFS=$'\t' read -r job name; do
        {
          echo
          echo "==== $name (job $job): the 60 lines before each error ===="
          gh api "repos/$slug/actions/jobs/$job/logs" 2>/dev/null |
            perl -pe 's/^\d{4}-\S+Z ?//; s/\e\[[0-9;]*m//g' |
            grep -B 60 '##\[error\]' | tail -n 200
        } >>"$summary"
      done
    gh run download "$id" -R "$slug" -D "$dir" -p 'evidence-*' >/dev/null 2>&1 || true
    cat "$summary"
    echo
    echo "summary and evidence: $dir"
    ;;

  land)
    run="$(latest_run)"
    read -r id status conclusion <<<"${run:-none none none}"
    if [ "$status" != completed ] || [ "$conclusion" != success ]; then
      echo "refusing to land ${sha:0:12}: its latest ci.yml run is ${run:-missing}" >&2
      exit 1
    fi
    "$GIT" -C "$repo" push --quiet origin "HEAD:refs/heads/main"
    "$GIT" -C "$repo" push --quiet origin --delete "$branch" 2>/dev/null || true
    "$GIT" -C "$repo" fetch --quiet origin main
    echo "landed ${sha:0:12} on $slug main (run $id)"
    ;;

  status)
    run="$(latest_run)"
    if [ -z "$run" ]; then echo "no ci.yml run of ${sha:0:12} in $slug"; else
      read -r id status conclusion <<<"$run"
      echo "run $id of ${sha:0:12}: $status ${conclusion} https://github.com/$slug/actions/runs/$id"
    fi
    ;;

  *) usage ;;
esac
