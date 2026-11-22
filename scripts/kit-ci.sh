#!/usr/bin/env bash
#
# Tests a kit's HEAD on GitHub (.github/workflows/kit-ci.yml, through the kit's ci.yml or a runner
# pool) and lands it on main when it is green. The developer's machine only compiles.
#
#   scripts/kit-ci.sh push <kit>      push HEAD to the kit's ci/agent branch (starts a run)
#   scripts/kit-ci.sh push <kit> --full   the same, and make sure HEAD gets the full run
#   scripts/kit-ci.sh wait <kit>      wait for the run of HEAD; exit 0 when it passed
#   scripts/kit-ci.sh failures <kit>  write $KIT_CI_DIR/<kit>/<run>/summary.txt (each job's result,
#                                     the lines before each failed job's errors) and download their evidence
#   scripts/kit-ci.sh land <kit>      fast-forward origin/main to HEAD when its run passed;
#                                     delete ci/agent (land <kit> --dry-run: check only, push nothing)
#   scripts/kit-ci.sh status <kit>    print the latest run of HEAD
#
# A change of text only (the list in scripts/kit-ci-plan.mjs, for example a README) gets the
# text-only run: build, Rust and tests skipped, green in about a minute; wait, status and land say
# "text-only". `push --full` (or KIT_CI_FULL=1) waits for the push's run to be planned and, when it
# is text-only, starts a full run of HEAD by hand (workflow_dispatch, which is always full); it
# cancels the text-only run (same concurrency group), and as the newer run of HEAD it is the one
# wait, status, failures and land read.
#
# Runner pools (scripts/kit-ci-pools.json, empty by default: then everything above is all there
# is). A pool is a public repository in another GitHub organization, written by
# scripts/kit-ci-runner-repo.mjs, whose <kit>.yml tests a commit of KitionAI/kition-<kit> on that
# organization's runners. With pools listed, `push` still pushes HEAD to ci/agent, then:
# - a text-only change (decided here with scripts/kit-ci-plan.mjs on the changes from the merge
#   base with origin/main, after fetching it; any doubt means full) stays at home: the kit's own
#   run is the text-only path, and no pool is used unless --full;
# - otherwise it counts the queued and running runs of the KitionAI organization (its 16 kit
#   repositories) and of each pool (one `gh run list` each) and picks the least loaded, home first
#   on a tie. Home: the kit's own run goes on as without pools. A pool: it dispatches
#   `gh workflow run <kit>.yml -R <pool> -f sha=<HEAD>`, finds the run named `<kit> <HEAD>`,
#   records it in the kit's .git/kit-ci-run.json, cancels the kit's own run of the push (and the
#   previous pool run), and says where the run is.
# wait, status, failures and land read the pool run when .git/kit-ci-run.json names HEAD, and the
# kit's own runs otherwise. land also checks that the pool run is named `<kit> <HEAD>` and that its
# artifact `tested` says it tested KitionAI/kition-<kit> at HEAD.
#
# The kit's checkout is <workspace>/kition-<kit>, where <workspace> is the folder holding this
# Kition checkout (KITION_WORKSPACE overrides it). Needs an authenticated `gh`. GIT names the git
# executable (default: git). KIT_CI_DIR defaults to ${TMPDIR:-/tmp}/kit-ci. KIT_CI_BRANCH replaces
# ci/agent (tests), KIT_CI_POOLS the pool list file (KIT_CI_POOLS=none: no pools, every run at
# home, as when the list is empty), and KIT_CI_POOL=<owner/repo> sends a full run to that pool
# whatever the load (to try a new pool).

set -euo pipefail

usage() {
  sed -n '6,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

full="${KIT_CI_FULL:-0}"
dry_run=0
[ $# -eq 2 ] ||
  { [ $# -eq 3 ] && [ "$1" = push ] && [ "$3" = --full ] && full=1; } ||
  { [ $# -eq 3 ] && [ "$1" = land ] && [ "$3" = --dry-run ] && dry_run=1; } ||
  usage
command="$1"
kit="$2"
poll="${KIT_CI_POLL:-60}"
GIT="${GIT:-git}"
scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="${KITION_WORKSPACE:-$(cd "$scripts/../.." && pwd)}"
repo="$workspace/kition-$kit"
slug="KitionAI/kition-$kit"
branch="${KIT_CI_BRANCH:-ci/agent}"
out_root="${KIT_CI_DIR:-${TMPDIR:-/tmp}/kit-ci}"
pools_file="${KIT_CI_POOLS:-$scripts/kit-ci-pools.json}"

[ -d "$repo/.git" ] || { echo "no kit checkout at $repo" >&2; exit 2; }
[ -f "$repo/.github/workflows/ci.yml" ] || { echo "kition-$kit has no .github/workflows/ci.yml (scripts/kit-ci-install.mjs $kit)" >&2; exit 2; }
sha="$("$GIT" -C "$repo" rev-parse HEAD)"
state_file="$repo/.git/kit-ci-run.json"

# The run a pool was given (.git/kit-ci-run.json): "<pool repo> <sha> <run id>", or nothing.
recorded_run() {
  [ -f "$state_file" ] || return 0
  node -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    if (/^[\w.-]+\/[\w.-]+$/.test(s.repo) && /^[0-9a-f]{40}$/.test(s.sha) && /^\d+$/.test(String(s.run))) console.log(`${s.repo} ${s.sha} ${s.run}`)
  ' "$state_file" 2>/dev/null || true
}

# Whose run is HEAD's: the pool's recorded run when it is of HEAD, else the kit's own (run_repo is
# the kit's repository and pool_run empty, as without pools).
run_repo="$slug"
pool_run=""
read -r recorded_repo recorded_sha recorded_id <<<"$(recorded_run)" || true
if [ -n "${recorded_id:-}" ] && [ "$recorded_sha" = "$sha" ]; then
  run_repo="$recorded_repo"
  pool_run="$recorded_id"
fi

# The newest ci.yml run of HEAD (by creation, so a run started by `push --full` wins over the
# push's run before it): "<id> <status> <conclusion>", or nothing. A pool run: the recorded one.
latest_run() {
  if [ -n "$pool_run" ]; then
    gh api "repos/$run_repo/actions/runs/$pool_run" -q '"\(.id) \(.status) \(.conclusion)"'
    return
  fi
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
  gh api "repos/$run_repo/actions/runs/$1/jobs?per_page=100" -q '
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

pool_note() {
  [ -z "$pool_run" ] || echo "runner pool $run_repo tests $slug@${sha:0:12} (run $pool_run)"
}

# The runner pools: KIT_CI_POOL alone, or the repos of the pool list (one per line; none when the
# list is empty or missing).
read_pools() {
  if [ -n "${KIT_CI_POOL:-}" ]; then echo "$KIT_CI_POOL"; return; fi
  [ "$pools_file" != none ] || return 0
  { [ -f "$pools_file" ] && grep -q '"repo"' "$pools_file"; } || return 0
  node -e '
    const file = process.argv[1]
    const pools = JSON.parse(require("node:fs").readFileSync(file, "utf8")).pools ?? []
    for (const pool of pools) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(pool.repo ?? "")) throw new Error(`${file}: a pool needs "repo": "<owner>/<repo>", not ${JSON.stringify(pool)}`)
      console.log(pool.repo)
    }
  ' "$pools_file"
}

# "true" when HEAD's change against the merge base with origin/main is text-only, else "false"
# (also when anything fails: then the run is full).
text_only() {
  local base
  "$GIT" -C "$repo" fetch --quiet origin main >&2 || { echo false; return; }
  base="$("$GIT" -C "$repo" merge-base origin/main "$sha" 2>/dev/null)" || { echo false; return; }
  [ -n "$base" ] || { echo false; return; }
  # The module comes through the environment: as argv[1] it would run as a command line.
  KIT_CI_PLAN="$scripts/kit-ci-plan.mjs" GIT="$GIT" node --input-type=module -e '
    import { pathToFileURL } from "node:url"
    const [repo, base, head] = process.argv.slice(1)
    const { changesBetween, classifyChanges } = await import(pathToFileURL(process.env.KIT_CI_PLAN).href)
    const verdict = classifyChanges(changesBetween(repo, base, head))
    console.error(`${verdict.textOnly ? "text-only" : "full"} change against ${base.slice(0, 12)}: ${verdict.reason}`)
    console.log(verdict.textOnly)
  ' "$repo" "$base" "$sha" || echo false
}

# Queued and running runs of a repository (one request), or nothing when GitHub does not answer.
active_runs() {
  gh run list -R "$1" --limit 50 --json status -q 'map(select(.status != "completed")) | length' 2>/dev/null || true
}

# The least loaded place for HEAD's full run: the kit's repository (home: the KitionAI organization,
# counted over its kit repositories) or a pool; home on a tie, then the pools in their order.
pick_runner() {
  local pools="$1" kits load home=0 best best_load
  if [ -n "${KIT_CI_POOL:-}" ]; then
    echo "KIT_CI_POOL: $KIT_CI_POOL" >&2
    echo "$KIT_CI_POOL"
    return
  fi
  kits="$(KIT_CI_INSTALL="$scripts/kit-ci-install.mjs" node --input-type=module -e '
    import { pathToFileURL } from "node:url"
    const { KITS } = await import(pathToFileURL(process.env.KIT_CI_INSTALL).href)
    console.log(KITS.join(" "))
  ')"
  case " $kits " in *" $kit "*) ;; *) kits="$kits $kit" ;; esac
  for name in $kits; do
    load="$(active_runs "KitionAI/kition-$name")"
    home=$((home + ${load:-0}))
  done
  echo "load: $home queued or running runs in the KitionAI kit repositories (home, $slug)" >&2
  best="$slug"
  best_load="$home"
  while IFS= read -r pool; do
    [ -n "$pool" ] || continue
    load="$(active_runs "$pool")"
    if [ -z "$load" ]; then echo "load: $pool did not answer; skipped" >&2; continue; fi
    echo "load: $load queued or running runs in $pool" >&2
    if [ "$load" -lt "$best_load" ]; then best="$pool"; best_load="$load"; fi
  done <<<"$pools"
  echo "$best"
}

# Sends HEAD's full run to <pool>: push (the kit's own run starts), dispatch the pool's <kit>.yml,
# record its run, then cancel the kit's own run of the push and the previous pool run.
pool_push() {
  local pool="$1" before_home before_pool dispatched="" home_run="" at
  before_home="$(gh run list -R "$slug" --workflow ci.yml --commit "$sha" --limit 20 --json databaseId -q 'map(.databaseId) | max // 0' 2>/dev/null || echo 0)"
  before_pool="$(gh run list -R "$pool" --workflow "$kit.yml" --limit 20 --json databaseId -q 'map(.databaseId) | max // 0' 2>/dev/null || echo 0)"
  "$GIT" -C "$repo" push --force --quiet origin "HEAD:refs/heads/$branch"
  echo "pushed ${sha:0:12} to $slug $branch"
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! gh workflow run "$kit.yml" -R "$pool" -f sha="$sha" -f ref_note="$slug $branch" >/dev/null; then
    echo "could not start $kit.yml in $pool; the run in $slug tests ${sha:0:12}" >&2
    if [ "$full" = 1 ]; then
      echo "for the full run at home: KIT_CI_POOLS=none scripts/kit-ci.sh push $kit --full" >&2
      exit 1
    fi
    exit 0
  fi
  for _ in $(seq 1 20); do
    dispatched="$(gh run list -R "$pool" --workflow "$kit.yml" --limit 20 --json databaseId,displayTitle \
      -q "map(select(.displayTitle == \"$kit $sha\" and .databaseId > $before_pool)) | sort_by(.databaseId) | last // empty | .databaseId" 2>/dev/null || true)"
    [ -n "$dispatched" ] && break
    sleep "${KIT_CI_STEP:-6}"
  done
  [ -n "$dispatched" ] || { echo "the run of ${sha:0:12} did not show up in $pool (gh run list -R $pool --workflow $kit.yml); the run in $slug tests it" >&2; exit 2; }
  printf '{"repo":"%s","kit":"%s","sha":"%s","run":%s,"workflow":"%s.yml","dispatchedAt":"%s"}\n' \
    "$pool" "$kit" "$sha" "$dispatched" "$kit" "$at" >"$state_file"
  echo "runner pool $pool: run $dispatched of ${sha:0:12}: https://github.com/$pool/actions/runs/$dispatched"
  for _ in $(seq 1 20); do
    home_run="$(run_after push "$before_home" 2>/dev/null || true)"
    [ -n "$home_run" ] && break
    sleep "${KIT_CI_STEP:-6}"
  done
  if [ -n "$home_run" ]; then
    gh run cancel "$home_run" -R "$slug" >/dev/null 2>&1 || true
    echo "cancelled run $home_run in $slug: the pool run tests ${sha:0:12}"
  else
    echo "the push started no run in $slug"
  fi
}

case "$command" in
  push)
    pools="$(read_pools)"
    if [ -n "$pools" ]; then
      previous="${recorded_repo:-} ${recorded_id:-}"
      runner="$slug"
      if [ "$full" != 1 ] && [ "$(text_only)" = true ]; then
        echo "text-only change: the run in $slug is the text-only path (no runner pool)"
      else
        runner="$(pick_runner "$pools")"
      fi
      rm -f "$state_file"
      if [ "$previous" != " " ]; then
        gh run cancel "${previous#* }" -R "${previous% *}" >/dev/null 2>&1 || true
      fi
      if [ "$runner" != "$slug" ]; then
        pool_push "$runner"
        exit 0
      fi
      echo "runner: $slug (home)"
    fi
    rm -f "$state_file"
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
    pool_note
    run=""
    for _ in $(seq 1 20); do
      run="$(latest_run 2>/dev/null || true)"
      [ -n "$run" ] && break
      sleep "${KIT_CI_STEP:-15}"
    done
    [ -n "$run" ] || { echo "no ci.yml run of ${sha:0:12} in $run_repo after 5 minutes (did you push?)" >&2; exit 2; }
    id="${run%% *}"
    echo "waiting for https://github.com/$run_repo/actions/runs/$id"
    # One API request per poll (KIT_CI_POLL seconds, default 60): many kits wait at once, and the
    # API allows 5000 requests an hour per user. An API error (rate limit, network) is retried.
    while :; do
      state="$(gh api "repos/$run_repo/actions/runs/$id" -q '"\(.status) \(.conclusion)"' 2>/dev/null || true)"
      case "$state" in
        "completed success") echo "PASSED: run $id of ${sha:0:12}$(kind_note "$id")"; break ;;
        completed\ *) echo "FAILED (${state#completed }): run $id of ${sha:0:12} (scripts/kit-ci.sh failures $kit)"; exit 1 ;;
      esac
      sleep "$poll"
    done
    ;;

  failures)
    pool_note
    run="$(latest_run)"
    [ -n "$run" ] || { echo "no ci.yml run of ${sha:0:12} in $run_repo" >&2; exit 2; }
    id="${run%% *}"
    dir="$out_root/$kit/$id"
    rm -rf "$dir"
    mkdir -p "$dir"
    summary="$dir/summary.txt"
    {
      echo "kit $kit, commit $sha, run https://github.com/$run_repo/actions/runs/$id"
      echo
      gh run view "$id" -R "$run_repo" --json jobs -q '.jobs[] | "\(.conclusion // .status)\t\(.name)"'
    } >"$summary"
    gh run view "$id" -R "$run_repo" --json jobs \
      -q '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | "\(.databaseId)\t\(.name)"' |
      while IFS=$'\t' read -r job name; do
        {
          echo
          echo "==== $name (job $job): the 60 lines before each error ===="
          gh api "repos/$run_repo/actions/jobs/$job/logs" 2>/dev/null |
            perl -pe 's/^\d{4}-\S+Z ?//; s/\e\[[0-9;]*m//g' |
            grep -B 60 '##\[error\]' | tail -n 200
        } >>"$summary"
      done
    gh run download "$id" -R "$run_repo" -D "$dir" -p 'evidence-*' >/dev/null 2>&1 || true
    cat "$summary"
    echo
    echo "summary and evidence: $dir"
    ;;

  land)
    pool_note
    run="$(latest_run)"
    read -r id status conclusion <<<"${run:-none none none}"
    if [ "$status" != completed ] || [ "$conclusion" != success ]; then
      echo "refusing to land ${sha:0:12}: its latest ci.yml run is ${run:-missing}${pool_run:+ (in $run_repo)}" >&2
      exit 1
    fi
    if [ -n "$pool_run" ]; then
      # A pool run lands only when it provably tested this kit at HEAD: its name and its artifact
      # `tested` (written by kit-ci.yml from the commit it checked out).
      title="$(gh api "repos/$run_repo/actions/runs/$id" -q .display_title 2>/dev/null || true)"
      if [ "$title" != "$kit $sha" ]; then
        echo "refusing to land ${sha:0:12}: run $id in $run_repo is named '$title', not '$kit $sha'" >&2
        exit 1
      fi
      proof_dir="$(mktemp -d "${TMPDIR:-/tmp}/kit-ci-tested.XXXXXX")"
      proof=""
      if gh run download "$id" -R "$run_repo" -n tested -D "$proof_dir" >/dev/null 2>&1; then
        proof="$(node -e '
          const t = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
          console.log(`${t.repository}@${t.sha}`)
        ' "$proof_dir/tested.json" 2>/dev/null || true)"
      fi
      rm -rf "$proof_dir"
      if [ "$proof" != "$slug@$sha" ]; then
        echo "refusing to land ${sha:0:12}: run $id in $run_repo tested ${proof:-nothing it can prove (no artifact tested)}, not $slug@$sha" >&2
        exit 1
      fi
      echo "run $id in $run_repo tested $slug@$sha (artifact tested)"
    fi
    if [ "$dry_run" = 1 ]; then
      echo "would land ${sha:0:12} on $slug main (run $id${pool_run:+ in $run_repo}$(kind_note "$id" | sed 's/^ (/, /; s/)$//')); --dry-run: nothing pushed"
      exit 0
    fi
    "$GIT" -C "$repo" push --quiet origin "HEAD:refs/heads/main"
    "$GIT" -C "$repo" push --quiet origin --delete "$branch" 2>/dev/null || true
    "$GIT" -C "$repo" fetch --quiet origin main
    rm -f "$state_file"
    echo "landed ${sha:0:12} on $slug main (run $id${pool_run:+ in $run_repo}$(kind_note "$id" | sed 's/^ (/, /; s/)$//'))"
    ;;

  status)
    pool_note
    run="$(latest_run)"
    if [ -z "$run" ]; then echo "no ci.yml run of ${sha:0:12} in $run_repo"; else
      read -r id status conclusion <<<"$run"
      echo "run $id of ${sha:0:12}: $status ${conclusion}$(kind_note "$id") https://github.com/$run_repo/actions/runs/$id"
    fi
    ;;

  *) usage ;;
esac
