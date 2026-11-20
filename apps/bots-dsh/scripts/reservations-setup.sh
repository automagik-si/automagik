#!/bin/sh
# Makes this machine's Automagik reservations folder (RFC 0024, delivery R4). An administrator
# runs it once, as root, after making the group (docs/cloud/0024-reservations-setup.md):
#   sudo sh reservations-setup.sh [--group NAME] [DIR]
# NAME defaults to automagik. DIR defaults to /var/lib/automagik/reservations on Linux and
# /Users/Shared/Automagik/reservations on macOS. No Automagik process runs this script.
set -eu
umask 077
usage() { echo "usage: sh reservations-setup.sh [--group NAME] [DIR]" >&2; exit 2; }
fail() { echo "reservations-setup: $*" >&2; exit 1; }
group=automagik
if [ "${1-}" = --group ]; then
  [ $# -ge 2 ] || usage
  group=$2
  shift 2
fi
[ $# -le 1 ] || usage
if [ $# -eq 1 ]; then
  dir=$1
else
  case "$(uname -s)" in
    Linux) dir=/var/lib/automagik/reservations ;;
    Darwin) dir=/Users/Shared/Automagik/reservations ;;
    *) fail "reservations are not offered on this system" ;;
  esac
fi
case "$dir" in
  */) fail "DIR must not end with /" ;;
  /?*) ;;
  *) fail "DIR must be an absolute path" ;;
esac
me=$(id -u)
name=$(id -un)
[ "$me" -eq 0 ] || echo "reservations-setup: not root: the folder's owner can remove any file" >&2
owned() { [ -n "$(find "$1" -prune -user "$me" -print)" ]; }
size32() { [ "$(wc -c < "$1" | tr -d ' ')" = 32 ]; }
trusted_path() {
  p=$1
  while :; do
    if [ -L "$p" ] && [ -z "$(find "$p" -prune -user 0 -print)" ]; then return 1; fi
    [ -d "$p" ] || return 1
    [ -n "$(find -H "$p" -prune \( -user 0 -o -user "$me" \) -print)" ] || return 1
    [ -z "$(find -H "$p" -prune \( -perm -0020 -o -perm -0002 \) ! -perm -1000 -print)" ] \
      || return 1
    [ "$p" = / ] && return 0
    p=$(dirname "$p")
  done
}
parent=$(dirname "$dir")
unsafe_path() {
  fail "every folder above $dir must be owned by root or $name, and only they can write to it"
}
if [ ! -e "$parent" ] && [ ! -L "$parent" ]; then
  # Check the existing path before mkdir can write through it.
  existing=$parent
  while [ ! -e "$existing" ] && [ ! -L "$existing" ]; do
    existing=$(dirname "$existing")
  done
  trusted_path "$existing" || unsafe_path
  (umask 022 && mkdir -p "$parent")
fi
trusted_path "$parent" || unsafe_path
mkdir "$dir" 2>/dev/null || true
if ! { [ -d "$dir" ] && [ ! -L "$dir" ] && owned "$dir"; }; then
  fail "$dir must be a folder owned by $name"
fi
# Members stay out while the key is checked or made; the folder opens (3770) last.
chmod 0700 "$dir"
chgrp "$group" "$dir"
key=$dir/key
if [ ! -e "$key" ] && [ ! -L "$key" ]; then
  tmp=$(mktemp "$dir/.key.XXXXXX")
  if ! dd if=/dev/urandom of="$tmp" bs=32 count=1 2>/dev/null || ! size32 "$tmp"; then
    rm -f "$tmp"
    fail "could not make $key"
  fi
  ln "$tmp" "$key" 2>/dev/null || true # Another run may have published its key first.
  rm -f "$tmp"
fi
if ! { [ -f "$key" ] && [ ! -L "$key" ] && owned "$key" && size32 "$key" &&
  [ -z "$(find "$key" -prune \( -perm -0004 -o -perm -0002 -o -perm -0020 \) -print)" ]; }; then
  fail "$key is not a safe 32-byte file owned by $name; move it aside and run this again" \
    "(the folder stays closed until then)"
fi
chgrp "$group" "$key"
chmod 0640 "$key"
[ -n "$(find "$key" -prune -group "$group" -perm 0640 -print)" ] \
  || fail "could not set $key to mode 0640 and group $group"
chmod 3770 "$dir"
[ -n "$(find "$dir" -prune -group "$group" -perm 3770 -print)" ] \
  || fail "could not set $dir to mode 3770 and group $group"
echo "reservations-setup: ready: $dir (group $group)"
