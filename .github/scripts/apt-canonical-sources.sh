#!/usr/bin/env bash
# Put apt on Ubuntu's canonical archive before any `apt-get update` on a CI runner.
#
# Why: the hosted ubuntu-24.04 image can point apt at a regional mirror (for example
# us-east-2.ec2.archive.ubuntu.com) or at apt's mirrorlist, /etc/apt/apt-mirrors.txt.
# When that mirror is unreachable, `apt-get update` prints repeated `Ign:` lines and
# spends its whole wall-clock bound there, so a job fails on infrastructure instead of
# on the change under test (run 44534018166, job "Landing page and browser"). The same
# runner's own log shows archive.ubuntu.com answering with `Hit:`/`Get:` at the time.
#
# What it changes: only the URI host of the sources files it is given. Suites,
# components, sections and Signed-By stay byte-for-byte, so the package set and its
# signature verification are unchanged; the runner is disposable, so nothing outlives
# the job. It is idempotent, and it only rewrites a file that exists: it never adds a
# suite, a component or a key. ports.ubuntu.com (arm64) is a separate canonical
# archive and is deliberately left alone.
#
# Usage: apt-canonical-sources.sh [sources-file...]
#   No argument: the two standard files, if present.
set -euo pipefail

readonly canonical='https://archive.ubuntu.com/ubuntu'

rewrite() {
  local file="$1" before after
  [ -f "${file}" ] || return 0
  before="$(mktemp)"
  after="$(mktemp)"
  cp "${file}" "${before}"
  sed -E \
    -e "s#mirror\+file:/etc/apt/apt-mirrors[.]txt#${canonical}#g" \
    -e 's#https?://[A-Za-z0-9.-]+[.]ec2[.]archive[.]ubuntu[.]com#https://archive.ubuntu.com#g' \
    -e 's#https?://[A-Za-z0-9.-]+[.]archive[.]ubuntu[.]com#https://archive.ubuntu.com#g' \
    "${before}" > "${after}"
  if cmp -s "${before}" "${after}"; then
    printf 'apt sources: %s already points at %s\n' "${file}" "${canonical}"
    rm -f "${before}" "${after}"
    return 0
  fi
  printf 'apt sources: rewriting %s to %s\n' "${file}" "${canonical}"
  diff -u "${before}" "${after}" || true
  if [ -w "${file}" ]; then
    cp "${after}" "${file}"
  else
    sudo cp "${after}" "${file}"
  fi
  rm -f "${before}" "${after}"
}

defaults=0
if [ "$#" -eq 0 ]; then
  defaults=1
  set -- /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list
fi
seen=0
for file in "$@"; do
  if [ -f "${file}" ]; then
    seen=$((seen + 1))
  fi
  rewrite "${file}"
done
if [ "${defaults}" -eq 1 ] && [ "${seen}" -eq 0 ]; then
  echo "::warning::no standard apt sources file found; the runner image may place its sources elsewhere"
fi
