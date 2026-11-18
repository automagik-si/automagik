#!/bin/sh
# The CAPPED line as a pure function: bytes in, the line out. The wrapper sources this file
# (found next to itself) and the tests source it directly, so a test can exercise the peak floor
# with a last sample under the limit without a scope, a log, a lock or any other side effect.
#
#   capped_run_capped_line LIMIT_BYTES SAMPLED_PEAK_BYTES LAST_SAMPLE_BYTES COMMAND
#
# The floor is max(sampled peak, limit): a memory kill means the scope reached its MemoryMax, so
# the printed peak is at least the limit even when the last sample is lower. The limit and the
# samples are printed in MiB with one decimal. A missing last sample prints "unknown", never
# 0.0M; the sampled peak may stay 0 for the floor.
capped_run_mib() {
  case ${1:-} in
    '' | *[!0-9]*) printf 'unknown' ;;
    *) awk -v bytes="$1" 'BEGIN { printf "%.1fM", bytes / 1048576 }' ;;
  esac
}

capped_run_capped_line() {
  limit=${1:-0}
  sampled=${2:-0}
  # No default on the last sample: an empty value is a missing sample, not 0.
  last=${3-}
  comm=${4:-?}
  case $limit in '' | *[!0-9]*) limit=0 ;; esac
  case $sampled in '' | *[!0-9]*) sampled=0 ;; esac
  floor=$sampled
  [ "$floor" -lt "$limit" ] && floor=$limit
  printf 'CAPPED: a process in the run was killed at the memory limit (limit=%s, peak>=%s, last sample %s, command=%s)\n' \
    "$(capped_run_mib "$limit")" "$(capped_run_mib "$floor")" "$(capped_run_mib "$last")" "$comm"
}
