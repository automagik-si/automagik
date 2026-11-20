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
  if [ -r "$main" ] && "$1" "$main" --self-check >/dev/null 2>&1; then
    exec "$1" "$main" run --dsh-home "$dsh_home" --profile "$profile" -- "$@"
  fi
done

unset AUTOMAGIK_SUPERVISOR_BOOT AUTOMAGIK_SUPERVISOR_VERSION
exec "$@"
