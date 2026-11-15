#!/bin/sh
# Runs one of the pack's scripts with the first JavaScript runtime it finds, every argument passed
# through:  sh run.sh <script.mjs> [args...]
#
# Herdr starts panes with its own PATH, which often has no `node` (nvm and bun put theirs in
# folders only a login shell adds), and Homebrew's node can lose its link. So this looks, in order:
#   1. `node` on PATH, if it is 22.7 or later;
#   2. the newest nvm node, 22.7 or later ($NVM_DIR, else ~/.nvm: versions/node/*/bin/node);
#   3. /opt/homebrew/bin/node, then /usr/local/bin/node, 22.7 or later;
#   4. `bun` on PATH, then ~/.bun/bin/bun, with --no-env-file (no project .env read in).
# A candidate counts only when `<it> --version` runs, so a dangling link is passed over. None
# found: one line on stderr, exit 127. Nothing is read from stdin: the script gets all of it (a
# Claude hook's JSON). For tests: AUTOMAGIK_HERDR_RUNTIME_DIRS, a colon list, replaces
# /opt/homebrew/bin:/usr/local/bin. Apache-2.0.

[ $# -ge 1 ] || { echo "usage: sh run.sh <script> [args...]" >&2; exit 64; }

# Sets MAJ, MIN and PAT from `$1 --version` (v22.7.0 or 1.2.3); fails when it doesn't run.
version_of() {
  v=$("$1" --version </dev/null 2>/dev/null) || return 1
  v=${v#v}
  MAJ=${v%%.*}
  v=${v#*.}
  MIN=${v%%.*}
  v=${v#*.}
  PAT=${v%%[!0-9]*}
  case $MAJ in '' | *[!0-9]*) return 1 ;; esac
  case $MIN in '' | *[!0-9]*) return 1 ;; esac
  case $PAT in '') PAT=0 ;; esac
}

# Whether $1 is a node that runs and is 22.7 or later; an older one is remembered for the error.
node_ok() {
  [ -x "$1" ] || return 1
  version_of "$1" || return 1
  if [ "$MAJ" -gt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -ge 7 ]; }; then return 0; fi
  OLD=${OLD:-" (node $MAJ.$MIN.$PAT at $1 is too old)"}
  return 1
}

OLD=

# 1. node on PATH
if c=$(command -v node 2>/dev/null) && node_ok "$c"; then exec "$c" "$@"; fi

# 2. the newest nvm node
best=
for c in "${NVM_DIR:-${HOME:-}/.nvm}"/versions/node/*/bin/node; do
  node_ok "$c" || continue
  if [ -z "$best" ] || [ "$MAJ" -gt "$BMAJ" ] \
    || { [ "$MAJ" -eq "$BMAJ" ] && { [ "$MIN" -gt "$BMIN" ] || { [ "$MIN" -eq "$BMIN" ] && [ "$PAT" -gt "$BPAT" ]; }; }; }; then
    best=$c BMAJ=$MAJ BMIN=$MIN BPAT=$PAT
  fi
done
if [ -n "$best" ]; then exec "$best" "$@"; fi

# 3. Homebrew's node (Apple silicon, then Intel). AUTOMAGIK_HERDR_RUNTIME_DIRS is a test override
# only: tests set it so the real Homebrew node can't be found; nothing else sets it.
rest=${AUTOMAGIK_HERDR_RUNTIME_DIRS-/opt/homebrew/bin:/usr/local/bin}
while [ -n "$rest" ]; do
  dir=${rest%%:*}
  case $rest in *:*) rest=${rest#*:} ;; *) rest= ;; esac
  if [ -n "$dir" ] && node_ok "$dir/node"; then exec "$dir/node" "$@"; fi
done

# 4. bun. Bun reads a .env from the working folder by default; --no-env-file keeps a project's
# .env out of the CLI, the briefing and the hc processes they start.
for c in "$(command -v bun 2>/dev/null)" "${HOME:-}/.bun/bin/bun"; do
  if [ -n "$c" ] && [ -x "$c" ] && "$c" --version </dev/null >/dev/null 2>&1; then exec "$c" --no-env-file "$@"; fi
done

echo "am needs Node.js 22.7 or later, or Bun: none on PATH, in ~/.nvm, /opt/homebrew/bin, /usr/local/bin or ~/.bun/bin$OLD. Install one: brew install node (or: curl -fsSL https://bun.sh/install | bash)" >&2
exit 127
