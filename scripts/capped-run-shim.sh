#!/bin/sh
# The payload shim text the wrapper runs inside the scope, as a function: the wrapper captures
# its output and the tests source it directly to check the generated text with sh -n and bash -n.
# The heredoc is quoted, so the text is literal: quotes and dollars inside need no escaping.
capped_run_shim() {
  cat <<'CAPPED_RUN_SHIM'
# Keep the wrapper's first argument slot, then raise 500 over the inherited value, capped
# at 1000 and never lowered. The separate monitor scope keeps its inherited value.
shift
inherited=$(cat /proc/self/oom_score_adj 2>/dev/null)
case $inherited in
  "" | *[!0-9-]*) inherited=0 ;;
esac
raised=$((inherited + 500))
[ "$raised" -gt 1000 ] && raised=1000
[ "$raised" -lt "$inherited" ] && raised=$inherited
if [ -w /proc/self/oom_score_adj ]; then
  printf "%s\n" "$raised" > /proc/self/oom_score_adj 2>/dev/null || :
fi
exec "$@"
CAPPED_RUN_SHIM
}

# The sibling monitor publishes the last sampled payload peak and the slice's final OOM count.
capped_run_monitor() {
  cat <<'CAPPED_RUN_MONITOR'
exec 2>/dev/null
trap final TERM

final() {
  oom=unknown
  if [ -n "${slice:-}" ] && [ -z "${CAPPED_RUN_TEST_UNREADABLE_EVENTS:-}" ] &&
    awk '$5 == "/sys/fs/cgroup" && / - cgroup2 / {
      found = 1
      local_events = ($NF ~ /(^|,)memory_localevents(,|$)/)
    }
    END { exit !(found && !local_events) }' /proc/self/mountinfo; then
    count=$(sed -n 's/^oom_kill //p' "$slice/memory.events")
    [ -n "$count" ] && oom=$count
  fi
  # The wrapper reads three whitespace-delimited fields, even before the first peak sample.
  publish done "${peak:-unknown}" "$oom"
  exit 0
}

publish() {
  printf '%s\n' "$*" >"$peek.tmp" && mv -f "$peek.tmp" "$peek"
}

peek=$1
unit=$2
wrapper=$3
umask 077
cg=$(sed -n 's/^0:://p' /proc/self/cgroup)
case ${cg%/*} in
  */app-cappedrun_*.slice) slice=/sys/fs/cgroup${cg%/*} ;;
  *) exit 1 ;;
esac
peak=
publish ready || exit 1
while kill -0 "$wrapper" 2>/dev/null; do
  if p=$(cat "$slice/$unit.scope/memory.peak") && [ -n "$p" ]; then
    peak=$p
    publish tick "$peak"
  fi
  sleep 0.1
done
CAPPED_RUN_MONITOR
}
