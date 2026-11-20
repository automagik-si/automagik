# Set up machine account reservations

Use one reservations folder for the Automagik instances on this machine. An administrator sets
it up once. Each OS user running an instance needs membership in the reservations group.

## Linux

```sh
sudo groupadd automagik
sudo usermod -aG automagik <user>
sudo sh reservations-setup.sh
```

Repeat the membership command for each instance user. Have those users log out and back in.

## macOS

```sh
sudo dseditgroup -o create automagik
sudo dseditgroup -o edit -a <user> -t user automagik
sudo sh reservations-setup.sh
```

Repeat the membership command for each instance user, then have them log out and back in.

## Folder, key and records

Save the script below as `reservations-setup.sh`. The defaults are
`/var/lib/automagik/reservations` on Linux and `/Users/Shared/Automagik/reservations` on macOS.
For a custom location, pass its absolute path (and optionally `--group NAME`) to the script
and set `AUTOMAGIK_RESERVATIONS_DIR` to that path in every instance. Keep the folder under
a root-owned parent that other users cannot write to.

The script closes the folder while it checks or publishes the shared 32-byte key, then opens
the folder for the group. It refuses an unsafe ancestor, a symlink or non-directory at the
reservation path, a folder owned by someone else, and an unsafe existing key. An unsafe key
leaves the folder closed until the administrator moves the key aside and reruns setup.

Verify with `ls -ld "$dir"` and `ls -l "$dir/key"`. With the default group, the folder shows
`drwxrws--T root automagik` and the 32-byte key shows `-rw-r----- root automagik`.
Keep the key across reruns. Changing it makes existing records unreachable by their digests.

To remove a dead instance's reservation, locate the file by its project label and remove that
one file. Set `dir` and replace `<project>` and the file name before using these commands.

```sh
sudo grep -Fl '"label": "<project>"' "$dir"/*.json
sudo rm "$dir/<vendor>-<digest>.json"
```

Review the resulting path if labels are reused. To undo setup and discard every machine
reservation, an administrator can remove the folder with `sudo rm -r "$dir"`.

## Scope

A reservation covers cooperating instances on one machine. The sticky bit limits removal and
replacement to the file owner or an administrator in normal use. A process running as the same
OS user can modify that user's files. A group member can reserve an account they can name, and
the card shows the file owner so an administrator can remove that reservation. The file uses
keyed digests for account identity. Anyone in the group can test a guessed email with the key.
A copied home shares its instance id. A Codex workspace reservation covers every ChatGPT
workspace of that email. Windows support awaits an ACL design.

## Manual two-user check on macOS

Use two distinct test users A and B in the group and a fresh test folder. Verify the modes and
group above. With each user, create a mode-0640 file in the folder and verify the other user can
read it. As B, try to write, remove, or rename B's file over A's file. Each operation must fail.
Verify A's bytes, owner, group, mode and modification time are unchanged. Each owner should be
able to remove their own file. For the app check, use the fake identity in
`apps/bots-dsh/test/fixtures/reservation-driver.mjs` with the staged layout in the plugin CI
step. Reserve as A, then run the `check` operation as B and verify it reports A's label and a
guarded sign-out of the fake Bot account. This macOS procedure has yet to be run for R4.

<!-- setup-script:start -->
```sh
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
```
<!-- setup-script:end -->
