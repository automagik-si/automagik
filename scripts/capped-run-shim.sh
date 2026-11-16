#!/bin/sh
# The payload shim text the wrapper runs inside the scope, as a function: the wrapper captures
# its output and the tests source it directly to check the generated text with sh -n and bash -n.
# The heredoc is quoted, so the text is literal: quotes and dollars inside need no escaping.
capped_run_shim() {
  cat <<'CAPPED_RUN_SHIM'
peek=$1
shift
parent=$$
if [ -n "$peek" ]; then
  cg=$(sed -n "s/^0:://p" /proc/self/cgroup 2>/dev/null)
  if [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/memory.peak" ]; then
    peakf=/sys/fs/cgroup$cg/memory.peak
    eventsf=/sys/fs/cgroup$cg/memory.events
    (
      exec 2>/dev/null
      umask 077
      peak=
      oom=unknown
      while kill -0 "$parent" 2>/dev/null; do
        p=$(cat "$peakf" 2>/dev/null) || break
        if [ -n "$p" ]; then
          peak=$p
          if [ -z "${CAPPED_RUN_TEST_UNREADABLE_EVENTS:-}" ]; then
            o=$(sed -n "s/^oom_kill //p" "$eventsf" 2>/dev/null)
            [ -n "$o" ] && oom=$o
          fi
          printf "peak %s %s\n" "$p" "$oom" >"$peek.tmp" && mv "$peek.tmp" "$peek"
        fi
        sleep 0.1
      done
      # The final read is explicit: once the payload has ended (the parent is gone), read
      # memory.peak and memory.events once more, then write done; no tick can lose the cause.
      p=$(cat "$peakf" 2>/dev/null)
      [ -n "$p" ] && peak=$p
      if [ -z "${CAPPED_RUN_TEST_UNREADABLE_EVENTS:-}" ]; then
        o=$(sed -n "s/^oom_kill //p" "$eventsf" 2>/dev/null)
        [ -n "$o" ] && oom=$o
      fi
      printf "done %s %s\n" "$peak" "$oom" >"$peek.tmp" && mv "$peek.tmp" "$peek"
    ) &
  fi
fi
# The payload exec path only: raise 500 over what this process inherits, capped at 1000, and
# never lower (an unprivileged process may only raise). The monitor was forked above and keeps
# the inherited value, so the payload is strictly above it unless the inherited value is 1000.
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
