#!/usr/bin/env bash
#
# Tests a kit's HEAD on GitHub (.github/workflows/kit-ci.yml, through the kit's ci.yml) and lands
# it on main when it is green. The developer's machine only compiles; GitHub runs the tests.
#
#   scripts/kit-ci.sh push <kit>      push HEAD to the kit's ci/agent branch (starts a run)
#   scripts/kit-ci.sh push <kit> --full   the same, and make sure HEAD gets the full run
#   scripts/kit-ci.sh wait <kit>      wait for the run of HEAD; exit 0 when it passed
#   scripts/kit-ci.sh failures <kit>  write $KIT_CI_DIR/<kit>/<run>/summary.txt (each job's result,
#                                     the lines before each failed job's errors) and download their evidence
#   scripts/kit-ci.sh land <kit>      fast-forward origin/main to HEAD when its run passed;
#                                     delete ci/agent
#   scripts/kit-ci.sh status <kit>    print the latest run of HEAD
#
# A change of text only (the list in scripts/kit-ci-plan.mjs, for example a README) gets the
# text-only run: build, Rust and tests skipped, green in about a minute; wait, status and land say
# "text-only". `push --full` (or KIT_CI_FULL=1) waits for the push's run to be planned and, when it
# is text-only, starts a full run of HEAD by hand (workflow_dispatch, which is always full); it
# cancels the text-only run (same concurrency group), and as the newer run of HEAD it is the one
# wait, status, failures and land read.
#
# The kit's checkout is <workspace>/kition-<kit>, where <workspace> is the folder holding this
# Kition checkout (KITION_WORKSPACE overrides it). Needs an authenticated `gh`. GIT names the git
# executable (default: git). KIT_CI_DIR defaults to ${TMPDIR:-/tmp}/kit-ci.

set -euo pipefail

usage() {
  sed -n '6,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

full="${KIT_CI_FULL:-0}"
[ $# -eq 2 ] || { [ $# -eq 3 ] && [ "$1" = push ] && [ "$3" = --full ] && full=1; } || usage
command="$1"
kit="$2"
poll="${KIT_CI_POLL:-60}"
GIT="${GIT:-git}"
workspace="${KITION_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
repo="$workspace/kition-$kit"
slug="KitionAI/kition-$kit"
branch="ci/agent"
out_root="${KIT_CI_DIR:-${TMPDIR:-/tmp}/kit-ci}"

[ -d "$repo/.git" ] || { echo "no kit checkout at $repo" >&2; exit 2; }
[ -f "$repo/.github/workflows/ci.yml" ] || { echo "kition-$kit has no .github/workflows/ci.yml (scripts/kit-ci-install.mjs $kit)" >&2; exit 2; }
sha="$("$GIT" -C "$repo" rev-parse HEAD)"

# The newest ci.yml run of HEAD (by creation, so a run started by `push --full` wins over the
# push's run before it): "<id> <status> <conclusion>", or nothing.
latest_run() {
  gh run list -R "$slug" --workflow ci.yml --commit "$sha" --limit 20 \
    --json databaseId,status,conclusion,createdAt \
    -q 'sort_by(.createdAt, .databaseId) | last // empty | "\(.databaseId) \(.status) \(.conclusion)"'
}

# The newest run of HEAD started by <event> with an id above <after>, or nothing.
run_after() {
  gh run list -R "$slug" --workflow ci.yml --commit "$sha" --limit 20 \
    --json databaseId,event,createdAt \
    -q "map(select(.event == \"$1\" and .databaseId > $2)) | sort_by(.createdAt, .databaseId) | last // empty | .databaseId"
}

# What a run tests: "text-only" (its Text only job ran), "full" (its Build or Rust job runs or
# ran), or "pending" (not planned yet). A job is skipped when the plan rules it out, and cancelled
# without steps when the run was cancelled before it started. The jobs of the reusable workflow
# are named "ci / <job>".
run_kind() {
  gh api "repos/$slug/actions/runs/$1/jobs?per_page=100" -q '
    def ran(name): any(.jobs[]; (.name == name or (.name | endswith("/ " + name)))
      and .conclusion != "skipped" and (.conclusion != "cancelled" or ((.steps // []) | length) > 0));
    if ran("Text only") then "text-only" elif ran("Build") or ran("Rust") then "full" else "pending" end'
}

kind_note() {
  case "$(run_kind "$1" 2>/dev/null || true)" in
    text-only) echo " (text-only: full checks skipped)" ;;
    full) echo " (full)" ;;
  esac
}

case "$command" in
  push)
    before=0
    if [ "$full" = 1 ]; then
      before="$(gh run list -R "$slug" --workflow ci.yml --commit "$sha" --limit 20 --json databaseId -q 'map(.databaseId) | max // 0' 2>/dev/null || echo 0)"
    fi
    "$GIT" -C "$repo" push --force --quiet origin "HEAD:refs/heads/$branch"
    echo "pushed ${sha:0:12} to $slug $branch"
    [ "$full" = 1 ] || exit 0
    # The push's run must exist before the dispatch, or it would start later and cancel the full
    # run. A push that changed nothing (HEAD was already on ci/agent) starts none.
    pushed=""
    for _ in $(seq 1 20); do
      pushed="$(run_after push "$before" 2>/dev/null || true)"
      [ -n "$pushed" ] && break
      sleep "${KIT_CI_STEP:-6}"
    done
    if [ -n "$pushed" ]; then
      kind=pending
      for _ in $(seq 1 60); do
        kind="$(run_kind "$pushed" 2>/dev/null || echo pending)"
        [ "$kind" != pending ] && break
        [ "$(gh api "repos/$slug/actions/runs/$pushed" -q .status 2>/dev/null)" = completed ] && break
        sleep "${KIT_CI_STEP:-6}"
      done
      if [ "$kind" = full ]; then
        echo "run $pushed of ${sha:0:12} is already the full run"
        exit 0
      fi
      echo "run $pushed of ${sha:0:12} is $kind; starting the full run by hand"
      before="$pushed"
    else
      echo "the push started no run of ${sha:0:12}; starting the full run by hand"
    fi
    gh workflow run ci.yml -R "$slug" --ref "$branch" >/dev/null
    dispatched=""
    for _ in $(seq 1 20); do
      dispatched="$(run_after workflow_dispatch "$before" 2>/dev/null || true)"
      [ -n "$dispatched" ] && break
      sleep "${KIT_CI_STEP:-6}"
    done
    [ -n "$dispatched" ] || { echo "the full run of ${sha:0:12} did not start in $slug (gh workflow run ci.yml -R $slug --ref $branch)" >&2; exit 2; }
    echo "full run $dispatched of ${sha:0:12}: https://github.com/$slug/actions/runs/$dispatched"
    ;;

  wait)
    run=""
    for _ in $(seq 1 20); do
      run="$(latest_run 2>/dev/null || true)"
      [ -n "$run" ] && break
      sleep "${KIT_CI_STEP:-15}"
    done
    [ -n "$run" ] || { echo "no ci.yml run of ${sha:0:12} in $slug after 5 minutes (did you push?)" >&2; exit 2; }
    id="${run%% *}"
    echo "waiting for https://github.com/$slug/actions/runs/$id"
    # One API request per poll (KIT_CI_POLL seconds, default 60): many kits wait at once, and the
    # API allows 5000 requests an hour per user. An API error (rate limit, network) is retried.
    while :; do
      state="$(gh api "repos/$slug/actions/runs/$id" -q '"\(.status) \(.conclusion)"' 2>/dev/null || true)"
      case "$state" in
        "completed success") echo "PASSED: run $id of ${sha:0:12}$(kind_note "$id")"; break ;;
        completed\ *) echo "FAILED (${state#completed }): run $id of ${sha:0:12} (scripts/kit-ci.sh failures $kit)"; exit 1 ;;
      esac
      sleep "$poll"
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
    echo "landed ${sha:0:12} on $slug main (run $id$(kind_note "$id" | sed 's/^ (/, /; s/)$//'))"
    ;;

  status)
    run="$(latest_run)"
    if [ -z "$run" ]; then echo "no ci.yml run of ${sha:0:12} in $slug"; else
      read -r id status conclusion <<<"$run"
      echo "run $id of ${sha:0:12}: $status ${conclusion}$(kind_note "$id") https://github.com/$slug/actions/runs/$id"
    fi
    ;;

  *) usage ;;
esac
