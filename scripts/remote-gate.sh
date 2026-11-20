#!/usr/bin/env bash
# Run one gate on a pull request or a commit, once, in a throwaway git worktree of a local clone,
# and print its test counts. Made for a shared Linux box that runs the gates the Mac should not.
#
#   remote-gate.sh --pr 123 herdr            the herdr pack's gate (AGENTS.md), per Node version
#   remote-gate.sh --sha 1a2b3c4 plugin bots-dsh   a plugin's install, lint and node --test
#   remote-gate.sh --sha 1a2b3c4 bun          the repository's bun run check
#   remote-gate.sh --sha 1a2b3c4 desktop      the desktop app's npm ci and node --test
#
# Only the named ref is fetched from REMOTE_GATE_REMOTE, into refs/remote-gate/ (a pull request's
# head, or one commit by its full sha when the clone lacks it); no other ref changes. It is
# checked out in a detached worktree, removed on any exit (git worktree remove --force, then
# prune). At most REMOTE_GATE_SLOTS gates run at once (mkdir slots); a gate waits for a free slot
# up to REMOTE_GATE_LOCK_TIMEOUT seconds, then gives up. Each step's full output goes to a log
# folder; the screen gets one line per step and the counts. A test step passes only with exit 0,
# a summary, at least one test, and no failed or cancelled test (as scripts/test-guard.mjs).
# At the start, refs/remote-gate/* not fetched or used for REMOTE_GATE_KEEP_DAYS (a stamp per ref)
# and log folders older than that go, and so does a worktree whose gate is surely gone.
#
# Needs Linux's GNU coreutils (mv -T, stat -c): a slot is claimed by renaming a folder that already
# holds its owner, so no slot is ever seen without one. A gate's identity is its pid, its start
# time in clock ticks (/proc/<pid>/stat) and the boot id: no time zone or clock step changes it.
# One REMOTE_GATE_BASE serves one pid namespace: gates in containers that share a base read each
# other's pids as gone and take each other's slots and worktrees, so give each namespace its own.
# The clone's git lock is never taken over from a gate of this boot, even a dead one (it says how
# to clear it); one whose owner names another boot id is from before a reboot and is cleared.
#
# Heads before the merged script kept their state in <clone>/.remote-gate, this one in
# <clone>-gate: the two share no slots and no git lock, so never run both against one clone.
#
# Environment (all optional):
#   REMOTE_GATE_ENV            a file sourced first (PATH, NVM_DIR, the variables below)
#   REMOTE_GATE_REPO           the clone (default: the checkout holding this script)
#   REMOTE_GATE_BASE           worktrees, locks and logs (default: <repo>-gate, beside the clone,
#                              so a worktree never resolves imports from the clone's node_modules)
#   REMOTE_GATE_REMOTE         remote to fetch from (default: origin)
#   REMOTE_GATE_SLOTS          gates at once (default: 3)
#   REMOTE_GATE_LOCK_TIMEOUT   seconds to wait for a slot (default: 1800)
#   REMOTE_GATE_GIT_TIMEOUT    seconds to wait for the clone's fetch lock (default: 600)
#   REMOTE_GATE_KEEP_DAYS      days to keep refs/remote-gate/* and logs (default: 7)
#   REMOTE_GATE_NODE_VERSIONS  herdr gate's Node versions, nvm-installed (default: "24 22 24.9.0")
#   REMOTE_GATE_PLUGIN_NODE    Node for the plugin, bun and desktop gates (default: 24.9, as CI)
#   REMOTE_GATE_NPM_CACHE      desktop gate's npm cache (default: <REMOTE_GATE_BASE>/npm-cache;
#                              a relative one is taken from the folder the gate is started in)
#   REMOTE_GATE_TEST_CONCURRENCY  herdr node --test concurrency (default: 8; Node's own default
#                              is one less than the cores, too many beside other work)
#   NVM_DIR                    where nvm keeps Node (default: $HOME/.nvm)
#   CHROME_BIN                 bots-dsh's browser (default: one at a usual path, if any)
#
# The desktop gate runs apps/desktop's main-process tests as CI's desktop job does: Node 24.9,
# npm ci --no-fund --no-audit with ELECTRON_SKIP_BINARY_DOWNLOAD=1 and DO_NOT_TRACK=1, then npm
# test (node --test). It unsets NODE_ENV (CI has none) and passes --include=dev, so neither the
# box's environment nor its npmrc (omit, npm_config_omit) makes npm ci drop the devDependencies.
# It is Electron-free: no Electron binary is downloaded or started, and no app is launched. That
# does not rest on ELECTRON_SKIP_BINARY_DOWNLOAD: the pinned electron (44.5.0) registers no
# install script, so npm ci never runs its download, and the flag stays only to match CI.
# Nothing runs Electron UI tests, here or on CI. What stays with CI: desktop-build.yml packages
# the app, and boot-check.yml boots the plugins' web UI in a headless browser.
# npm's download cache is reused by later gates; node_modules is installed fresh into each gate's
# throwaway worktree, never cached across shas. The cache under the gate base is removed whole
# once it is REMOTE_GATE_KEEP_DAYS old, by a gate that starts while no other holds a slot, and
# the next desktop gate starts cold. A cache set anywhere else is never swept.
#
# What differs from CI: the herdr gate leaves out test/am-quota-write.test.mjs, by the owner's
# rule that it never runs on our machines (CI still runs it). That rule is an instruction
# the owner gave the team; it is written down here and nowhere else in the repository (AGENTS.md
# and CI run every test file). Its static checks run once, on the first Node. A version like 24
# is the newest one nvm has installed, not the newest released; the record names the exact one. bun is
# whatever PATH has (CI pins 1.4.4); the record names it. The plugin gate does not fetch Omni for
# welcome-dsh. Without a browser it unsets CI, so bots-dsh's layout check skips instead of failing,
# and says so; with one it sets CHROME_BIN and CI as CI does. The desktop gate is CI's desktop job
# on Linux only (CI also runs windows-latest), reusing an npm cache where CI starts cold; its Node
# 24.9 and npm flags are CI's, with --include=dev added. Packaging and the boot check stay with CI.
#
# Signals: bash runs a trap only once the running command returns, so a TERM to this script
# waits for the step in progress (a test run can take minutes) before the cleanup; a terminal's
# ctrl-C reaches the whole process group and stops the step at once.
set -euo pipefail
# As on a Mac and on CI's runners. Under a 002 umask (one group per user, common on Linux) the
# tests' fixture files come out group-writable, and the worker refuses to read those.
umask 022

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

if [ -n "${REMOTE_GATE_ENV:-}" ]; then
  # shellcheck source=/dev/null
  . "$REMOTE_GATE_ENV"
fi

kind=''
ref=''
while [ $# -gt 0 ]; do
  case $1 in
    --pr | --sha)
      [ $# -ge 2 ] || usage
      kind=${1#--}
      ref=$2
      shift 2
      ;;
    -h | --help) usage ;;
    *) break ;;
  esac
done
gate=${1:-}
app=${2:-${REMOTE_GATE_APP:-bots-dsh}}

case $kind in
  pr) [[ $ref =~ ^[0-9]+$ ]] || usage ;;
  sha) [[ $ref =~ ^[0-9a-f]{7,40}$ ]] || usage ;;
  *) usage ;;
esac
case $gate in
  herdr | bun | desktop) ;;
  plugin) [[ $app =~ ^[a-z0-9-]+$ ]] || usage ;;
  *) usage ;;
esac

say() { printf 'remote-gate: %s\n' "$*"; }
die() {
  say "$*" >&2
  exit 1
}

# A path as an absolute one: a relative one is taken from the folder the gate is started in.
absolute() {
  case $1 in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

script_dir=$(cd "$(dirname "$0")" && pwd)
repo=${REMOTE_GATE_REPO:-$(git -C "$script_dir" rev-parse --show-toplevel)}
repo=$(cd "$repo" && pwd) || die "no clone at $repo"
base=${REMOTE_GATE_BASE:-$repo-gate}
mkdir -p "$base"
base=$(cd "$base" && pwd)
remote=${REMOTE_GATE_REMOTE:-origin}
slots=${REMOTE_GATE_SLOTS:-3}
lock_timeout=${REMOTE_GATE_LOCK_TIMEOUT:-1800}
git_timeout=${REMOTE_GATE_GIT_TIMEOUT:-600}
keep_days=${REMOTE_GATE_KEEP_DAYS:-7}
node_versions=${REMOTE_GATE_NODE_VERSIONS:-24 22 24.9.0}
plugin_node=${REMOTE_GATE_PLUGIN_NODE:-24.9}
# Absolute here, before any cd: resolved inside the throwaway worktree, a relative cache would
# be made there and deleted with it, and every run would be cold.
npm_cache=$(absolute "${REMOTE_GATE_NPM_CACHE:-$base/npm-cache}")
concurrency=${REMOTE_GATE_TEST_CONCURRENCY:-8}
if [ -n "${NVM_DIR:-}" ]; then
  nvm_dir=$NVM_DIR
elif [ -n "${HOME:-}" ]; then
  nvm_dir=$HOME/.nvm
else
  die "neither NVM_DIR nor HOME is set: set NVM_DIR to nvm's folder"
fi
lock_dir=$base/locks
git_lock=$lock_dir/git
wt_dir=$base/worktrees

slot=''
wt=''
wt_owner=''
held_git=''
failed=0
summary=()
started=$SECONDS

load() { cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || uptime | sed 's/.*load averages*: //'; }

boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)

# A process's identity: its pid, its start time in clock ticks since boot and the boot id, so a
# reused pid never reads as the same owner. The start time is field 20 after the LAST ')' of
# /proc/<pid>/stat (the process name may hold spaces and ')'). Elsewhere, ps's start time in UTC.
ident() {
  local stat start
  if stat=$(cat "/proc/$1/stat" 2>/dev/null) && [ -n "$stat" ]; then
    start=$(printf '%s\n' "${stat##*)}" | awk '{ print $20 }')
    if [[ $start =~ ^[0-9]+$ ]]; then
      printf '%s ticks:%s boot:%s\n' "$1" "$start" "$boot_id"
      return 0
    fi
  fi
  start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ') || return 1
  [ -n "$start" ] || return 1
  printf '%s utc:%s\n' "$1" "${start// /_}"
}
me=$(ident $$) || die "can't read this process's start time (/proc or ps)"

# Whether an owner line is a gate that may still run. Its identity read again must match; when it
# can't be read at all (hidepid, no ps), it counts as alive unless kill says no such process.
alive() {
  local pid=${1%% *} now
  [ -n "$1" ] || return 1
  if now=$(ident "$pid" 2>/dev/null); then
    [ "$now" = "$1" ]
    return
  fi
  case $(LC_ALL=C kill -0 "$pid" 2>&1) in
    *'No such process'*) return 1 ;;
    *) return 0 ;;
  esac
}

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# The newest nvm-installed Node matching a version prefix (24, 24.9, 24.9.0), as its bin folder.
node_bin() {
  local spec=$1 d best
  best=$(for d in "$nvm_dir/versions/node/v$spec" "$nvm_dir/versions/node/v$spec".*; do
    if [ -x "$d/bin/node" ]; then printf '%s\n' "$d"; fi
  done | sort -V | tail -n 1)
  if [ -z "$best" ]; then
    say "no Node $spec under $nvm_dir/versions/node" >&2
    return 1
  fi
  printf '%s/bin\n' "$best"
}

# Whether an owner line names a boot other than this one: its gate ended with that boot, whatever
# runs under its pid now. Never true when either boot id is unknown.
other_boot() {
  local was=${1##* boot:}
  [ "$was" != "$1" ] && [ -n "$was" ] && [ "$was" != unknown ] && [ "$boot_id" != unknown ] \
    && [ "$was" != "$boot_id" ]
}

# Clears a git lock left from before a reboot. Its owner file is moved aside inside the lock, so
# one gate wins and the lock's name stays taken meanwhile; a file that is not the one judged (a
# live lock made since) is put back.
git_lock_clear() {
  local judged=$1 aside=$git_lock/owner.stale-$$
  mv "$git_lock/owner" "$aside" 2>/dev/null || return 1
  if [ "$(cat "$aside" 2>/dev/null || true)" != "$judged" ]; then
    mv "$aside" "$git_lock/owner" 2>/dev/null || true
    return 1
  fi
  rm -rf "$git_lock"
  say "cleared the clone's git lock, left from before a reboot (owner: $judged)"
}

# The clone's lock for fetches and worktree bookkeeping, shared by every slot. One left by a gate
# of this boot that is gone is never taken over: it is reported with the command that clears it.
# One from before a reboot (another boot id in its owner file) is stale and is cleared here.
git_lock_take() {
  local deadline=$((SECONDS + git_timeout)) owner
  mkdir -p "$lock_dir"
  until mkdir "$git_lock" 2>/dev/null; do
    owner=$(cat "$git_lock/owner" 2>/dev/null || true)
    if other_boot "$owner" && git_lock_clear "$owner"; then continue; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      if alive "$owner"; then
        say "the clone's git lock is held by a running gate (pid ${owner%% *}) for over $git_timeout s" >&2
      else
        say "the clone's git lock is older than $git_timeout s and its gate is gone (owner: ${owner:-none})." >&2
        say "If no gate is running, clear it: rm -rf '$git_lock'" >&2
      fi
      return 1
    fi
    sleep 1
  done
  echo "$me" >"$git_lock/owner"
  held_git=1
}
git_lock_drop() {
  if [ -n "$held_git" ]; then rm -rf "$git_lock"; fi
  held_git=''
}

# A slot's owner line, or its folder's age as "none <mtime>" when it has no owner file yet.
slot_owner() {
  if [ -f "$1/owner" ]; then cat "$1/owner" 2>/dev/null || true; else echo "none $(mtime "$1")"; fi
}

# Takes a stale slot back. The move to a unique name lets one claimer win; the moved folder is
# checked again, and one that is not the slot judged stale (made since) is put back with mv -T,
# which fails rather than nest it when a new slot took the name meanwhile. Such a folder stays
# aside until its owner ends (sweep_stale).
reclaim() {
  local dir=$1 judged=$2 moved
  moved=$lock_dir/.stale-${dir##*/}-$$-$RANDOM
  mv -T "$dir" "$moved" 2>/dev/null || return 0
  if [ "$(slot_owner "$moved")" != "$judged" ]; then
    mv -T "$moved" "$dir" 2>/dev/null || true
    return 0
  fi
  say "took back ${dir##*/} (owner gone: $judged)"
  rm -rf "$moved"
}

# Folders set aside by reclaim or left by a claim that died: removed once their owner is gone.
sweep_stale() {
  local d owner
  for d in "$lock_dir"/.stale-* "$lock_dir"/.new-*; do
    [ -d "$d" ] || continue
    owner=$(slot_owner "$d")
    case $owner in
      'none '*) if [ $(($(date +%s) - ${owner#none })) -gt "$lock_timeout" ]; then rm -rf "$d"; fi ;;
      *) if ! alive "$owner"; then rm -rf "$d"; fi ;;
    esac
  done
}

# Claims one slot in one step: a folder holding the owner file is renamed to the slot's name.
# rename(2) refuses a name that a folder with an owner already holds.
claim() {
  local dir=$1 new
  new=$(mktemp -d "$lock_dir/.new-XXXXXX") || return 1
  echo "$me" >"$new/owner"
  if mv -T "$new" "$dir" 2>/dev/null; then return 0; fi
  rm -rf "$new"
  return 1
}

# One of the box's gate slots. A slot is stale when its owner (pid and start time) no longer runs,
# or when it has no owner file and is older than the wait.
slot_take() {
  local deadline=$((SECONDS + lock_timeout)) i dir owner waited=''
  mkdir -p "$lock_dir"
  while :; do
    sweep_stale
    for i in $(seq 1 "$slots"); do
      dir=$lock_dir/slot-$i
      if [ -e "$dir" ]; then
        owner=$(slot_owner "$dir")
        case $owner in
          'none '*) if [ $(($(date +%s) - ${owner#none })) -gt "$lock_timeout" ]; then reclaim "$dir" "$owner"; fi ;;
          *) if ! alive "$owner"; then reclaim "$dir" "$owner"; fi ;;
        esac
      fi
      # Also right after a stale slot was taken back, not on the next pass.
      if [ ! -e "$dir" ] && claim "$dir"; then
        slot=$dir
        say "slot $i of $slots (pid $$)"
        return 0
      fi
    done
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "all $slots slots busy for $lock_timeout s; giving up" >&2
      return 1
    fi
    if [ -z "$waited" ]; then
      say "all $slots slots busy; waiting up to $lock_timeout s"
      waited=1
    fi
    sleep 5
  done
}

remove_worktree() {
  local dir=$1
  if git -C "$repo" worktree remove --force "$dir" 2>/dev/null || { rm -rf "$dir" && [ ! -e "$dir" ]; }; then
    git -C "$repo" worktree prune
    return 0
  fi
  git -C "$repo" worktree prune
  return 1
}

# A ref's stamp file. A '/' in the ref's name (only in a ref made by hand) is written as %2F and
# a '%' as %25, so every stamp is one file in ref-stamps and no two refs share one.
stamp_file() {
  local name=${1#refs/remote-gate/}
  name=${name//%/%25}
  printf '%s\n' "$base/ref-stamps/${name//\//%2F}"
}

# A ref's stamp, touched whenever a gate fetches or uses it: the sweep ages refs by it.
stamp() {
  mkdir -p "$base/ref-stamps"
  touch "$(stamp_file "$1")"
}

# The desktop gate's npm cache, whole, once its stamp is older than the cutoff ($1): it grows with
# each lockfile set and npm never trims it. Only the one under the gate base (a cache set
# elsewhere is its owner's), and only while no other gate holds a slot: the caller holds the git
# lock, which every gate takes before its npm ci, so no install is reading the cache then. One
# with no stamp yet gets it now and is aged from there.
sweep_npm_cache() {
  local since=$npm_cache/.remote-gate-since d
  case $npm_cache in
    "$base"/*) ;;
    *) return 0 ;;
  esac
  [ -d "$npm_cache" ] || return 0
  if [ ! -e "$since" ]; then
    touch "$since" || true
    return 0
  fi
  [ "$(mtime "$since")" -lt "$1" ] || return 0
  for d in "$lock_dir"/slot-*; do
    if [ -d "$d" ] && [ "$d" != "$slot" ]; then return 0; fi
  done
  rm -rf "$npm_cache"
  say "removed the npm cache, older than $keep_days days: the next desktop gate starts cold"
}

# Old refs and logs, and worktrees left by a gate that is gone (killed, out of memory). A ref
# with no stamp yet gets one now and is aged from there.
sweep() {
  local cutoff owner_file dir name mark
  cutoff=$(($(date +%s) - keep_days * 86400))
  git -C "$repo" for-each-ref --format='%(refname)' refs/remote-gate/ | while read -r name; do
    mark=$(stamp_file "$name")
    if [ ! -e "$mark" ]; then
      stamp "$name"
    elif [ "$(mtime "$mark")" -lt "$cutoff" ]; then
      if git -C "$repo" update-ref -d "$name"; then rm -f "$mark"; fi
    fi
  done
  if [ -d "$base/logs" ]; then
    find "$base/logs" -mindepth 1 -maxdepth 1 -type d -mtime +"$keep_days" -exec rm -rf {} + || true
  fi
  sweep_npm_cache "$cutoff"
  for owner_file in "$wt_dir"/*.owner; do
    [ -f "$owner_file" ] || continue
    dir=${owner_file%.owner}
    if ! alive "$(cat "$owner_file" 2>/dev/null || true)"; then
      if remove_worktree "$dir"; then
        rm -f "$owner_file"
        say "removed ${dir##*/}, left by a gate that is gone"
      else
        say "could not remove ${dir##*/}, left by a gate that is gone" >&2
      fi
    fi
  done
  git -C "$repo" worktree prune
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  cd / || true
  if [ -n "$wt" ]; then
    if [ -z "$held_git" ]; then git_lock_take; fi
    if remove_worktree "$wt"; then
      rm -f "$wt_owner"
      say "worktree removed"
    else
      say "the worktree $wt could not be removed; the next gate's sweep tries again" >&2
      [ "$rc" -ne 0 ] || rc=1
    fi
  fi
  git_lock_drop
  if [ -n "$slot" ] && [ "$(cat "$slot/owner" 2>/dev/null)" = "$me" ]; then rm -rf "$slot"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Run one step with its output in the log folder; one line per step, the log's tail on failure.
step() {
  local name=$1 log rc=0 t0=$SECONDS
  shift
  log=$logs/$name.log
  "$@" >"$log" 2>&1 || rc=$?
  say "step $name: exit $rc, $((SECONDS - t0)) s"
  if [ "$rc" -ne 0 ]; then
    failed=1
    if grep -qE '^not ok ' "$log"; then
      grep -E '^not ok ' "$log" | head -n 20 || true
      { grep -m 3 -A 8 -E '^not ok ' "$log" | grep -E '^ +(location|error):|^    [^ ]' | head -n 12 \
        | sed 's/^/  | /'; } || true
    else
      tail -n 25 "$log" | sed 's/^/  | /' || true
    fi
  fi
  return 0
}

# Counts from node --test output: TAP's "# tests 12" or the spec reporter's "ℹ tests 12" (U+2139,
# its three bytes in octal below), at the line's start; the last one wins. No other first word
# counts. Prints "found tests pass fail skip todo cancelled", found 0 when there is no summary.
node_counts() {
  LC_ALL=C awk '/^[^ \t]/ && NF == 3 && $2 ~ /^(tests|pass|fail|skipped|todo|cancelled)$/ \
         && $3 ~ /^[0-9]+$/ && ($1 == "#" || $1 == "\342\204\271") { c[$2] = $3; found = 1 }
       END { printf "%d %d %d %d %d %d %d\n", found, c["tests"], c["pass"], c["fail"], \
         c["skipped"], c["todo"], c["cancelled"] }' "$1"
}

# Counts from bun test's summary (" 12 pass", "Ran 14 tests across 3 files."), in node_counts'
# order with the file count last; found 0 without the "Ran" line.
bun_counts() {
  LC_ALL=C awk '$1 ~ /^[0-9]+$/ && NF == 2 && $2 ~ /^(pass|fail|skip|todo)$/ { c[$2] = $1 }
       $1 == "Ran" && $3 ~ /^tests?$/ && $4 == "across" { t = $2; f = $5; found = 1 }
       END { printf "%d %d %d %d %d %d 0 %d\n", found, t, c["pass"], c["fail"], c["skip"], \
         c["todo"], f }' "$1"
}

# Judges a test step by its counts as well as its exit code: no summary, no test, or a failed or
# cancelled one fails the gate. Records one line: the counts, the time and the verdict.
judge() {
  local label=$1 counts=$2 wall=$3 found tests pass fail skip todo cancelled why=''
  read -r found tests pass fail skip todo cancelled _ <<<"$counts" || true
  found=${found:-0} tests=${tests:-0} pass=${pass:-0} fail=${fail:-0}
  skip=${skip:-0} todo=${todo:-0} cancelled=${cancelled:-0}
  if [ "$found" -eq 0 ]; then
    why='no test summary'
  elif [ "$tests" -eq 0 ]; then
    why='no tests ran'
  elif [ "$fail" -gt 0 ] || [ "$cancelled" -gt 0 ]; then
    why="$fail failed, $cancelled cancelled"
  fi
  if [ -n "$why" ]; then failed=1; fi
  summary+=("$label tests=$tests pass=$pass fail=$fail skip=$skip todo=$todo cancelled=$cancelled wall=${wall}s${why:+ FAIL ($why)}")
  say "${summary[${#summary[@]} - 1]}"
}

herdr_syntax() {
  local f rc=0 n=0
  for f in mods/*/*.js mods/*/*.mjs mods/*/bin/*.mjs mods/*/pack/*.mjs scripts/*.mjs scripts/*/*.mjs; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    node --check "$f" || { echo "node --check failed: $f"; rc=1; }
  done
  echo "node --check: $n files"
  sh -n install.sh || rc=1
  sh -n mods/am-sidebar/bin/run.sh || rc=1
  sh -n mods/am-sidebar/bin/automagik-herdr || rc=1
  shellcheck -s sh install.sh mods/am-sidebar/bin/run.sh mods/am-sidebar/bin/automagik-herdr || rc=1
  return "$rc"
}

gate_herdr() {
  local files=() f v bin ver t0
  cd "$wt/herdr"
  for f in test/*.test.mjs; do
    [ "$f" = test/am-quota-write.test.mjs ] || files+=("$f")
  done
  say "herdr: ${#files[@]} test files (test/am-quota-write.test.mjs left out)"
  for v in $node_versions; do
    bin=$(node_bin "$v")
    ver=$("$bin/node" --version)
    t0=$SECONDS
    step "test-node-$ver" env PATH="$bin:$PATH" node --test --test-reporter=tap \
      --test-concurrency="$concurrency" "${files[@]}"
    judge "gate=herdr node=$ver files=${#files[@]}" "$(node_counts "$logs/test-node-$ver.log")" $((SECONDS - t0))
  done
  bin=$(node_bin "${node_versions%% *}")
  export PATH="$bin:$PATH"
  step syntax herdr_syntax
  step privacy node scripts/privacy-check.mjs
  step catalog node scripts/catalog.mjs --check
  step version node scripts/version.mjs check
  step entries node scripts/entries.mjs --check
  step parts node scripts/parts.mjs --check
  step am-copies node ../scripts/am-copies.mjs --check
}

# bots-dsh's browser: CHROME_BIN when set, else one at a usual path; empty when none.
browser() {
  local b
  for b in "${CHROME_BIN:-}" /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium \
    /usr/bin/chromium-browser /snap/bin/chromium; do
    if [ -n "$b" ] && [ -x "$b" ]; then
      printf '%s\n' "$b"
      return 0
    fi
  done
}

gate_plugin() {
  local dir=$wt/apps/$app bin n t0 chrome layout
  [ -f "$dir/package.json" ] || die "no plugin at apps/$app"
  cd "$dir"
  bin=$(node_bin "$plugin_node")
  export PATH="$bin:$PATH"
  chrome=$(browser)
  if [ -n "$chrome" ]; then
    export CHROME_BIN=$chrome CI=true
    layout="layout=$chrome"
  else
    unset CHROME_BIN CI GITHUB_ACTIONS
    layout='layout=skipped'
    say "layout check skipped (CHROME_BIN unset): no browser found, CI unset"
  fi
  step install bun install --frozen-lockfile
  if [ "$app" = bots-dsh ]; then step acp-install bun install --cwd ../acp-dsh --frozen-lockfile; fi
  if grep -q '"harness"' package.json && [ ! -d dev/harness/node_modules ]; then
    step harness bun run harness
  fi
  if [ -f scripts/build-client.mjs ]; then step client node scripts/build-client.mjs --check; fi
  if grep -q '"lint"' package.json; then
    step lint bun run lint
  else
    say "lint skipped (no lint script)"
  fi
  n=$(find test -maxdepth 1 -name '*.test.js' | wc -l | tr -d ' ')
  t0=$SECONDS
  step test bun run test
  judge "gate=plugin app=$app node=$(node --version) files=$n $layout" "$(node_counts "$logs/test.log")" $((SECONDS - t0))
}

gate_bun() {
  local bin t0 counts
  cd "$wt"
  bin=$(node_bin "$plugin_node")
  export PATH="$bin:$PATH"
  step install bun install --frozen-lockfile --ignore-scripts
  t0=$SECONDS
  step check bun run check
  counts=$(bun_counts "$logs/check.log")
  judge "gate=bun node=$(node --version) bun=$(bun --version) files=${counts##* }" "$counts" $((SECONDS - t0))
}

gate_desktop() {
  local dir=$wt/apps/desktop bin n t0
  [ -f "$dir/package.json" ] || die "no desktop app at apps/desktop"
  cd "$dir"
  bin=$(node_bin "$plugin_node")
  export PATH="$bin:$PATH"
  # As CI's desktop job: the install is Electron-free and no app is started. CI sets no
  # NODE_ENV, and npm ci would omit the devDependencies if the box's environment had one.
  unset NODE_ENV
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1 DO_NOT_TRACK=1
  # npm's downloads only: node_modules is installed fresh in each gate's worktree. The stamp is
  # the cache's age for the sweep.
  mkdir -p "$npm_cache"
  npm_cache=$(cd "$npm_cache" && pwd)
  [ -e "$npm_cache/.remote-gate-since" ] || touch "$npm_cache/.remote-gate-since"
  n=$(find test -maxdepth 1 -name '*.test.js' | wc -l | tr -d ' ')
  say "desktop: $n test files (Electron-free: no binary, no app start)"
  # --include=dev: a box npmrc or npm_config_omit must not drop what the tests need.
  step install npm ci --no-fund --no-audit --include=dev --cache "$npm_cache"
  t0=$SECONDS
  step test npm test
  judge "gate=desktop node=$(node --version) files=$n" "$(node_counts "$logs/test.log")" $((SECONDS - t0))
}

slot_take

git_lock_take
sweep
if [ "$kind" = pr ]; then
  git -C "$repo" -c gc.auto=0 fetch -q --no-write-fetch-head "$remote" \
    "+refs/pull/$ref/head:refs/remote-gate/pr-$ref"
  sha=$(git -C "$repo" rev-parse --verify "refs/remote-gate/pr-$ref^{commit}")
  stamp "refs/remote-gate/pr-$ref"
else
  if ! git -C "$repo" cat-file -e "$ref^{commit}" 2>/dev/null; then
    [ ${#ref} -eq 40 ] || die "$ref isn't in the clone: give the full 40-character sha to fetch it"
    git -C "$repo" -c gc.auto=0 fetch -q --no-write-fetch-head "$remote" "+$ref:refs/remote-gate/sha-$ref"
  fi
  sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
  git -C "$repo" update-ref "refs/remote-gate/sha-$sha" "$sha"
  stamp "refs/remote-gate/sha-$sha"
fi
mkdir -p "$wt_dir"
target=$wt_dir/$gate-${sha:0:12}-$$
wt_owner=$target.owner
echo "$me" >"$wt_owner"
if ! git -C "$repo" worktree add -q --detach "$target" "$sha"; then
  remove_worktree "$target" || true
  rm -f "$wt_owner"
  die "git worktree add failed for $sha"
fi
wt=$target
git_lock_drop

logs=$base/logs/$gate-${sha:0:12}-$(date +%Y%m%d-%H%M%S)-$$
mkdir -p "$logs"
say "gate=$gate $kind $ref at $sha"
say "logs in $logs"
say "load before: $(load)"

"gate_$gate"

say "load after: $(load)"
for line in ${summary[@]+"${summary[@]}"}; do say "summary $line"; done
if [ "$failed" -ne 0 ]; then
  say "gate=$gate sha=${sha:0:12} FAIL in $((SECONDS - started)) s"
  exit 1
fi
say "gate=$gate sha=${sha:0:12} PASS in $((SECONDS - started)) s"
