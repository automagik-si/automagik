#!/bin/sh
# The service keeps its original DSH command after --.
set -eu

if [ "$#" -lt 7 ] || [ "$1" != --dsh-home ] || [ "$3" != --profile ] || [ "$5" != -- ]; then
  echo "usage: $0 --dsh-home HOME --profile PROFILE -- NODE DSH [ARGS...]" >&2
  exit 2
fi
dsh_home=$2
profile=$4
case "$dsh_home" in /*) ;; *) echo 'The DSH home must be absolute.' >&2; exit 2 ;; esac
case "$profile" in ''|.|..|*[!a-zA-Z0-9._-]*) echo 'Invalid DSH profile.' >&2; exit 2 ;; esac
shift 5
root=$dsh_home/update/$profile/supervisor
export DSH_HOME="$dsh_home"

for copy in current kept; do
  main=$root/$copy/supervisor/main.js
  if [ -r "$main" ] && marker=$("$1" "$main" --self-check 2>/dev/null) &&
    [ "$marker" = automagik-supervisor-ok ]; then
    exec "$1" "$main" run --dsh-home "$dsh_home" --profile "$profile" -- "$@"
  fi
done

# The copy can be missing or broken. Check the recovery state with the service's Node.
if ! "$1" -e '
  const fs = require("node:fs")
  const { join } = require("node:path")
  const [home, profile] = process.argv.slice(1)
  const update = join(home, "update")
  const store = join(update, profile)
  const path = join(store, "state.json")
  const stat = path => fs.lstatSync(path, { throwIfNoEntry: false })
  for (const dir of [update, store]) {
    const entry = stat(dir)
    if (!entry) process.exit(0)
    if (!entry.isDirectory()) process.exit(1)
  }
  const entry = stat(path)
  if (!entry) process.exit(0)
  if (!entry.isFile() || entry.size > 65536) process.exit(1)
  const state = JSON.parse(fs.readFileSync(path, { encoding: "utf8", flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }))
  if (state?.version !== 1 || !["healthy", "rolledBack", "notUpdated"].includes(state.phase)) process.exit(1)
  const j = state.journal
  if (j != null && (j.op !== "switch" || j.pending !== null || !Array.isArray(j.steps) ||
    !Array.isArray(j.done) || (j.undo === true
      ? j.done.length !== 0
      : j.done.length !== j.steps.length || j.done.some((step, i) => step !== j.steps[i])))) process.exit(1)
' "$dsh_home" "$profile" >/dev/null 2>&1; then
  echo 'automagik supervisor: update recovery state prevents starting DSH; see state.json' >&2
  exit 1
fi

unset AUTOMAGIK_SUPERVISOR_BOOT AUTOMAGIK_SUPERVISOR_VERSION
exec "$@"
