#!/bin/sh
# A wish's copy as a worktree on one shared clone per project (issues #1698 and #1695).
#
# A full clone costs every wish a second copy of the repository's objects; a worktree costs
# only its working tree and branch. This helper keeps one shared clone per project and adds
# each wish's copy as a linked worktree of it.
#
#   scripts/wish-worktree.sh [--shared-root <dir>] [--shared <dir>] [--shared-clone] \
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
# --shared-clone is for a sandbox that allows writes only inside the wish itself. Git
# uses --reference to borrow objects from the shared clone while leaving HEAD, refs and
# config inside the copy. The copy's origin fetches from <repo>; origin pushes are
# disabled and the local credential helper is empty. A host that has authorized a scoped
# follow-up can remove that local helper setting and configure its own 'publish' remote
# in the copy before launching the wish.
#
# Keep the shared clone and its objects while any copies depend on it. A normal Git GC
# in the shared clone keeps unreachable objects (gc.pruneExpire=never). A manual
# prune/repack that drops objects, or deleting the shared clone, may break the copies.
# Repack borrowing copies without alternates before intentionally retiring the store.
#
# A plain clone already on disk is not removable here: `git worktree remove` cannot remove a
# clone's main working tree. Use scripts/wish-reap.mjs for those, under its gates.
set -eu

PROG=wish-worktree
SHARED_ROOT=${WISH_SHARED_ROOT:-"$HOME/.automagik/bots/workspace/wishes/.shared"}
SHARED=
SHARED_CLONE=false
NO_PUSH_URL=/dev/null/genie-wish-copies-push-nowhere

usage() {
  cat <<'EOF'
usage: scripts/wish-worktree.sh [--shared-root <dir>] [--shared <dir>] [--shared-clone]
       create <repo> <copy> <branch> [<base>]
       scripts/wish-worktree.sh [--shared-root <dir>] [--shared <dir>] remove <copy>

  create   add <copy> as a linked worktree of the project's shared clone, on a new <branch>
           from <base> (default origin/dev). The shared clone is cloned or fetched first.
  remove   remove a clean, unlocked linked worktree and prune its clone's stale records.

  --shared-root <dir>  where per-project shared clones live (default $WISH_SHARED_ROOT, else
                       $HOME/.automagik/bots/workspace/wishes/.shared)
  --shared <dir>       use this shared clone for create instead of the per-project default
                       (remove finds the clone that owns the copy)
  --shared-clone      create an independent .git that borrows objects, for sandboxes that
                       can write only inside the copy. Origin cannot push. The runner
                       chooses any scoped publish route before launching the wish.
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
  name=$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-')
  case $name in
    '' | . | .. | .shared) die "cannot name a project from the repository" ;;
  esac
  printf '%s' "$name"
}

lock_create() {
  shared_parent=$(dirname "$SHARED")
  mkdir -p "$shared_parent"
  # Noclobber creates the lock exclusively. A lock left by an interrupted process
  # requires operator reconciliation; another creator never takes it over.
  lock=$SHARED.create.lock
  attempts=0
  while ! (set -C; printf '%s\n' "$$" >"$lock") 2>/dev/null; do
    [ "$attempts" -lt 60 ] || die "could not acquire the shared clone lock: $lock"
    attempts=$((attempts + 1))
    sleep 1
  done
  trap 'rm -- "$lock"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

ensure_shared() {
  if [ -e "$SHARED" ] || [ -L "$SHARED" ]; then
    if [ ! -e "$SHARED/.git" ] && [ ! -e "$SHARED/HEAD" ]; then
      die "shared path exists and is not a clone: $SHARED"
    fi
    if ! origin=$(git -C "$SHARED" config --local --get-all remote.origin.url) ||
      [ "$origin" != "$repo" ]; then
      die "shared clone has a different origin: $SHARED; choose a distinct --shared path"
    fi
  elif ! git clone --quiet --no-hardlinks --no-checkout -- "$repo" "$SHARED"; then
    die "cannot initialise the shared clone: $SHARED"
  fi
  if "$SHARED_CLONE" && ! git -C "$SHARED" config --local gc.pruneExpire never; then
    die "cannot set object retention for the shared clone: $SHARED"
  fi
  if ! git -C "$SHARED" fetch --quiet --prune origin; then
    die "cannot fetch the shared clone: $SHARED"
  fi
}

resolve_base() {
  if base_commit=$(git -C "$SHARED" rev-parse --verify --quiet --end-of-options "$base^{commit}"); then
    return
  fi
  # The host may have pinned an exact commit that it fetched into the source checkout,
  # with no branch pointing to it. Fetch that object by ID before creating the copy.
  case $base in
    *[!0-9a-fA-F]*) die "base not found in the shared clone: $base" ;;
  esac
  case ${#base} in
    40 | 64) ;;
    *) die "base not found in the shared clone: $base" ;;
  esac
  if ! git -C "$SHARED" fetch --quiet --no-tags origin "$base" ||
    ! base_commit=$(git -C "$SHARED" rev-parse --verify --quiet --end-of-options "$base^{commit}"); then
    die "base not found in the shared clone: $base"
  fi
}

create_copy() {
  if [ -e "$copy" ] || [ -L "$copy" ]; then
    die "copy already exists: $copy"
  fi
  if ! git -C "$SHARED" check-ref-format --branch "$branch" >/dev/null 2>&1 ||
    ! git check-ref-format "refs/heads/$branch"; then
    die "invalid branch name: $branch"
  fi
  resolve_base
  mkdir -p "$(dirname "$copy")"
  if "$SHARED_CLONE"; then
    if ! git clone --quiet --reference "$SHARED" --no-local --no-checkout \
      --config "remote.origin.pushurl=$NO_PUSH_URL" --config credential.helper= \
      -- "$repo" "$copy"; then
      die "cannot create the borrowing clone: $copy"
    fi
    if ! git -C "$copy" checkout --quiet -b "$branch" "$base_commit"; then
      die "cannot check out $branch in the borrowing clone: $copy"
    fi
  else
    if git -C "$SHARED" show-ref --verify --quiet "refs/heads/$branch"; then
      die "branch already exists in the shared clone: $branch"
    fi
    if ! git -C "$SHARED" worktree add -q "$copy" -b "$branch" "$base"; then
      die "git worktree add failed for $copy (never forced)"
    fi
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
  if ! locks=$(find "$git_dir" "$common_dir" -name '*.lock' -print 2>/dev/null); then
    die "cannot inspect lock files; refusing to remove: $copy"
  fi
  if [ -n "$locks" ]; then
    first=$(printf '%s\n' "$locks" | sed -n '1p')
    die "copy is locked ($first); refusing to remove: $copy"
  fi
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
    --shared-clone)
      SHARED_CLONE=true
      shift
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
    if [ -d "$repo" ]; then
      repo=$(CDPATH='' cd -P -- "$repo" && pwd -P)
    fi
    if [ -z "$SHARED" ]; then
      project=$(project_name "$repo")
      SHARED=$SHARED_ROOT/$project
    fi
    lock_create
    ensure_shared
    create_copy
    ;;
  remove)
    if [ $# -ne 1 ] || "$SHARED_CLONE"; then
      usage_error
    fi
    remove_copy "$(abspath "${1%/}")"
    ;;
  *)
    usage_error
    ;;
esac
