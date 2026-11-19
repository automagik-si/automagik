#!/bin/sh
# A wish's copy as a worktree on one shared clone per project (issues #1698 and #1695).
#
# A full clone costs every wish a second copy of the repository's objects; a worktree costs
# only its working tree and branch. This helper keeps one shared clone per project and adds
# each wish's copy as a linked worktree of it.
#
#   scripts/wish-worktree.sh [--shared-root <dir>] [--shared <dir>] \
#     create <repo> <copy> <branch> [<base>]
#   scripts/wish-worktree.sh [--shared-root <dir>] [--shared <dir>] remove <copy>
#
#   create   ensures the shared clone exists (git clone --no-hardlinks into
#            <shared-root>/<project>, fetched on every call), then
#            `git worktree add <copy> -b <branch> <base>` (base defaults to origin/dev).
#   remove   refuses a dirty tree or a lock, then `git worktree remove <copy>` and
#            `git worktree prune` on the clone that owns it. Never --force.
#
# The shared clone lives at $WISH_SHARED_ROOT/<project>, default
# $HOME/.automagik/bots/workspace/wishes/.shared/<project>; --shared pins another path and
# --shared-root another root. The project name is the last segment of the repository URL
# without .git, sanitised; two repositories with the same name in different owners need an
# explicit --shared.
#
# Worktrees are the only mode here. `git clone --shared`/`--reference` is the fallback when a
# worktree is impossible (for example a filesystem that cannot follow the worktree gitdir
# pointer): the copy borrows the shared object store through alternates and keeps its own HEAD
# and refs, but deleting the shared clone breaks every copy that borrows it until each is
# repacked with `git repack -a -d` (or cloned again). A deleted shared clone breaks worktrees
# too -- their objects live there -- though their working trees stay on disk; recreate the
# clone and re-add or prune the worktrees. Never delete the shared clone while a wish runs.
#
# A plain clone already on disk is not removable here: `git worktree remove` cannot remove a
# clone's main working tree. Use scripts/wish-reap.mjs for those, under its gates.
set -eu

PROG=wish-worktree
SHARED_ROOT=${WISH_SHARED_ROOT:-"$HOME/.automagik/bots/workspace/wishes/.shared"}
SHARED=

usage() {
  cat <<'EOF'
usage: scripts/wish-worktree.sh [--shared-root <dir>] [--shared <dir>]
       create <repo> <copy> <branch> [<base>]
       scripts/wish-worktree.sh [--shared-root <dir>] [--shared <dir>] remove <copy>

  create   add <copy> as a linked worktree of the project's shared clone, on a new <branch>
           from <base> (default origin/dev). The shared clone is cloned or fetched first.
  remove   remove a clean, unlocked linked worktree and prune its clone's stale records.

  --shared-root <dir>  where per-project shared clones live (default $WISH_SHARED_ROOT, else
                       $HOME/.automagik/bots/workspace/wishes/.shared)
  --shared <dir>       use this shared clone for create instead of the per-project default
                       (remove finds the clone that owns the copy)
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

usage_error() {
  usage >&2
  exit 2
}

abspath() {
  case $1 in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}

project_name() {
  name=${1%/}
  name=${name##*/}
  name=${name%.git}
  if [ -z "$name" ]; then
    die "cannot name a project from the repository: $1"
  fi
  printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-'
}

ensure_shared() {
  repo_url=$1
  if [ -e "$SHARED" ]; then
    if [ ! -e "$SHARED/.git" ] && [ ! -e "$SHARED/HEAD" ]; then
      die "shared path exists and is not a clone: $SHARED"
    fi
    if ! git -C "$SHARED" fetch --quiet --prune origin; then
      die "cannot fetch the shared clone: $SHARED"
    fi
    return 0
  fi
  mkdir -p "$(dirname "$SHARED")"
  if ! git clone --quiet --no-hardlinks "$repo_url" "$SHARED"; then
    die "cannot clone $repo_url into $SHARED"
  fi
  if ! git -C "$SHARED" fetch --quiet --prune origin; then
    die "cannot fetch the shared clone: $SHARED"
  fi
}

create_copy() {
  repo_url=$1
  copy=$2
  branch=$3
  base=$4
  if [ -e "$copy" ]; then
    die "copy already exists: $copy"
  fi
  if ! git -C "$SHARED" check-ref-format --branch "$branch" >/dev/null 2>&1; then
    die "invalid branch name: $branch"
  fi
  if git -C "$SHARED" show-ref --verify --quiet "refs/heads/$branch"; then
    die "branch already exists in the shared clone: $branch"
  fi
  if ! git -C "$SHARED" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    die "base not found in the shared clone: $base"
  fi
  mkdir -p "$(dirname "$copy")"
  if ! git -C "$SHARED" worktree add -q "$copy" -b "$branch" "$base"; then
    die "git worktree add failed for $copy (never forced)"
  fi
  printf 'created %s\n  branch %s from %s\n  shared clone %s\n' "$copy" "$branch" "$base" "$SHARED"
}

remove_copy() {
  copy=$1
  if [ ! -d "$copy" ]; then
    die "copy does not exist: $copy"
  fi
  if [ ! -e "$copy/.git" ]; then
    die "not a git checkout: $copy"
  fi
  if ! git_dir=$(git -C "$copy" rev-parse --path-format=absolute --git-dir); then
    die "cannot read the git dir: $copy"
  fi
  if ! common_dir=$(git -C "$copy" rev-parse --path-format=absolute --git-common-dir); then
    die "cannot read the common git dir: $copy"
  fi
  if [ "$git_dir" = "$common_dir" ]; then
    die "not a linked worktree (this is a clone's main tree): $copy; use scripts/wish-reap.mjs"
  fi
  for lock in "$git_dir/index.lock" "$git_dir/HEAD.lock" "$common_dir/config.lock"; do
    if [ -e "$lock" ]; then
      die "copy is locked ($lock); refusing to remove: $copy"
    fi
  done
  if [ -n "$(git -C "$copy" --no-optional-locks status --porcelain --untracked-files=all)" ]; then
    printf '%s: refusing to remove a dirty worktree (never forced): %s\n' "$PROG" "$copy" >&2
    git -C "$copy" --no-optional-locks status --short --untracked-files=all >&2 || true
    exit 1
  fi
  case $common_dir in
    */.git) owner=${common_dir%/.git} ;;
    *) owner=$common_dir ;;
  esac
  if ! git -C "$owner" worktree remove "$copy"; then
    die "git worktree remove failed (never forced): $copy"
  fi
  if ! git -C "$owner" worktree prune; then
    die "worktree removed but its records could not be pruned: $owner"
  fi
  printf 'removed %s\n  pruned worktree records of %s\n' "$copy" "$owner"
}

while [ $# -gt 0 ]; do
  case $1 in
    --shared-root)
      [ $# -ge 2 ] || usage_error
      SHARED_ROOT=$2
      shift 2
      ;;
    --shared)
      [ $# -ge 2 ] || usage_error
      SHARED=$2
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      usage_error
      ;;
    *)
      break
      ;;
  esac
done

[ $# -ge 1 ] || usage_error
action=$1
shift

SHARED_ROOT=$(abspath "${SHARED_ROOT%/}")
if [ -n "$SHARED" ]; then
  SHARED=$(abspath "${SHARED%/}")
fi

case $action in
  create)
    if [ $# -lt 3 ] || [ $# -gt 4 ]; then
      usage_error
    fi
    repo=$1
    copy=$(abspath "${2%/}")
    branch=$3
    base=${4:-origin/dev}
    if [ -z "$SHARED" ]; then
      SHARED=$SHARED_ROOT/$(project_name "$repo")
    fi
    ensure_shared "$repo"
    create_copy "$repo" "$copy" "$branch" "$base"
    ;;
  remove)
    if [ $# -ne 1 ]; then
      usage_error
    fi
    remove_copy "$(abspath "${1%/}")"
    ;;
  *)
    usage_error
    ;;
esac
