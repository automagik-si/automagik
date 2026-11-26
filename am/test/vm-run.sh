#!/usr/bin/env bash
# The member runner's real-uid proof: am/runner/VM-RUN.md's setup and rows 1-32, made executable,
# each row asserting the sheet's expected text (RFC 0038 delivery 3, #1374).
#
# Only on a THROWAWAY machine, as root: CI's runner-vm job on a GitHub-hosted ubuntu-24.04 runner,
# or a disposable Debian 13 / Ubuntu 24.04 VM. It adds accounts, a systemd unit, /etc/subuid lines
# and /srv/am-runner, and never undoes them. Two keys before it touches anything: it refuses unless
# AM_RUNNER_VM_DISPOSABLE=yes and either RUNNER_ENVIRONMENT=github-hosted (CI passes it through
# sudo) or AM_RUNNER_VM_HOSTNAME names this machine's hostname (a person on a throwaway VM).
# It never ships: am's tarball excludes test/ (release.yml "Pack am").
#
#   CI:              AM_RUNNER_VM_DISPOSABLE=yes NODE_BIN=<node 22.7+> (RUNNER_ENVIRONMENT from Actions)
#   a throwaway VM:  AM_RUNNER_VM_DISPOSABLE=yes AM_RUNNER_VM_HOSTNAME=<its hostname> NODE_BIN=<node 22.7+>
#   then:            bash am/test/vm-run.sh <am.tgz> <out-dir>
# The two keys guard against an accidental run on a contributor's machine; never set them there.
#
# <am.tgz> is am packed as a release packs it (git archive <rev>:am -- . ':(exclude)test').
# <out-dir> receives rows.txt (every row's output and verdict), report.txt (the sheet's "what to
# send back") and probe.json (the endpoint the bots-dsh probe rows read, D2).
#
# Where it differs from the sheet, and why:
# - The runner account is amrunner, not runner: the GitHub-hosted image already has a `runner`
#   user (the Actions agent).
# - Node is NODE_BIN installed root-owned at /opt/am-vm/bin/node; the unit, every client and the
#   in-Bot socket probe (row 29) use that path, since a Bot's PATH is the runner's fixed default.
# - The client is read from the tarball's runner/VM-RUN.md, so the sheet and this run stay one text.
# - dsh2 is in dshsock for rows 7-16 only; row 24 adds it again itself.
# - The 64 member and Bot ids start at 200000 only when no subordinate grant on the machine already
#   covers them; otherwise past every existing grant (the hosted image has one for its own runner).
# - Row 23 runs a root-owned 0644 config with protected, unused endpoints under $B/alt: the sheet's
#   /tmp config is refused by the chain lock (checkGivenChains) before the account lock that row is
#   about.
# - Some rows check more than the sheet's line: host-side owners of files the member and the Bots
#   make (the outer uid, not only the namespace's `id -u`), the pid and network namespace ids
#   against the host's, and after rows 11-14 that a good request still runs and the proof folder
#   holds only the runner's marker.
# - Row 26 runs as a fresh member, dave: after row 25 every alice request is HOME_INVALID by design.
# shellcheck disable=SC2016 # single-quoted commands are the text a member's or Bot's own shell runs
set -uo pipefail

die() { printf 'vm-run: %s\n' "$*" >&2; exit 2; }

[ "$#" -eq 2 ] || die "usage: AM_RUNNER_VM_DISPOSABLE=yes NODE_BIN=<node> $0 <am.tgz> <out-dir>"
[ "${AM_RUNNER_VM_DISPOSABLE:-}" = yes ] || die "refused: only on a throwaway VM (set AM_RUNNER_VM_DISPOSABLE=yes there)"
if [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] && [ "${AM_RUNNER_VM_HOSTNAME:-}" != "$(hostname)" ]; then
  die "refused: not a GitHub-hosted runner; on a throwaway VM also set AM_RUNNER_VM_HOSTNAME=\$(hostname)"
fi
[ "$(uname -s)" = Linux ] || die "refused: Linux only"
[ "$(id -u)" -eq 0 ] || die "refused: run as root on the throwaway VM"
AM_TGZ=$1
ART=$2
readonly ART
[ -f "$AM_TGZ" ] || die "no am tarball at $AM_TGZ"
[ -x "${NODE_BIN:-}" ] || die "NODE_BIN must name a node binary"

B=/srv/am-runner
RUNNER=amrunner
NODE=/opt/am-vm/bin/node
UNIT=am-member-runner.service
for path in "$B" /opt/am-vm "/etc/systemd/system/$UNIT"; do
  [ ! -e "$path" ] || die "refused: $path already exists (not a fresh machine)"
done
# The members' and Bots' 64 ids must be no one's: the sheet's 200000 when it is free, else the
# first 65536-aligned start past every subordinate grant already in /etc/subuid and /etc/subgid
# (the hosted image grants its own `runner` user a range). No account or group may hold one.
FIRST=200000
GRANTS_END=$(cat /etc/subuid /etc/subgid 2> /dev/null | awk -F: 'NF >= 3 && $2 + $3 > m { m = $2 + $3 } END { print m + 0 }')
if [ "$GRANTS_END" -gt "$FIRST" ]; then FIRST=$(( (GRANTS_END + 65535) / 65536 * 65536 )); fi
LAST=$((FIRST + 63))
for file in /etc/subuid /etc/subgid; do
  [ ! -e "$file" ] || ! awk -F: -v a="$FIRST" -v z="$LAST" '$2 + 0 <= z && $2 + $3 > a { found = 1 } END { exit !found }' "$file" ||
    die "refused: $file already grants part of $FIRST-$LAST"
done
if awk -F: -v a="$FIRST" -v z="$LAST" '$3 >= a && $3 <= z { found = 1 } END { exit !found }' /etc/passwd /etc/group; then
  die "refused: an account or group already has an id in $FIRST-$LAST"
fi
for name in dsh dsh2 outsider gate "$RUNNER" dshsock; do
  if getent passwd "$name" > /dev/null || getent group "$name" > /dev/null; then
    die "refused: the account or group $name already exists (not a fresh machine)"
  fi
done
for tool in setpriv unshare newuidmap newgidmap systemd-run loginctl journalctl timeout; do
  command -v "$tool" > /dev/null || die "missing tool: $tool"
done

mkdir -p "$ART" || die "cannot make $ART"
ROWS=$ART/rows.txt
REPORT=$ART/report.txt
: > "$ROWS"
T=$(mktemp -d) || die "no temp folder"
chmod 0755 "$T"

report() {
  {
    echo "== uname -a"; uname -a
    echo "== /etc/os-release"; cat /etc/os-release
    echo "== protected_hardlinks"; cat /proc/sys/fs/protected_hardlinks
    echo "== apparmor_restrict_unprivileged_userns"
    cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2> /dev/null || echo "(no such sysctl)"
    echo "== unshare --version"; unshare --version
    echo "== node"; "$NODE" --version 2> /dev/null
    echo "== config.json"; cat "$B/config.json" 2> /dev/null
    echo "== id"; id "$RUNNER"; id dsh; id dsh2; id outsider; id gate
    echo "== /etc/subuid"; grep "^$RUNNER:" /etc/subuid
    echo "== systemctl status"; systemctl --no-pager status "$UNIT" 2>&1 | head -n 20
    echo "== journalctl -u $UNIT (canaries only on this machine; no secrets)"
    journalctl --no-pager -u "$UNIT" -n 200 -o cat
  } > "$REPORT" 2>&1
  chmod a+r "$ROWS" "$REPORT" "$ART/probe.json" 2> /dev/null
  rm -rf "$T"
}
trap report EXIT

# --- Setup as root (VM-RUN.md "Setup as root") ---------------------------------------------------

setup() {
  groupadd dshsock &&
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group dsh &&
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group dsh2 &&
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group outsider &&
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group gate &&
  usermod -aG dshsock dsh &&
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$RUNNER" || return 1

  install -d -m 0755 -o root -g root /opt/am-vm /opt/am-vm/bin &&
  install -m 0755 -o root -g root "$NODE_BIN" "$NODE" || return 1

  install -d -m 0711 -o "$RUNNER" -g "$RUNNER" "$B" &&
  install -d -m 0700 -o dsh -g dsh "$B/dsh-home" &&
  install -m 0600 -o dsh -g dsh /dev/null "$B/dsh-home/launch" &&
  printf 'launch-canary\n' > "$B/dsh-home/launch" &&
  install -d -m 0700 -o gate -g gate "$B/gate" &&
  install -m 0600 -o gate -g gate /dev/null "$B/gate/store.json" &&
  printf 'gate-canary\n' > "$B/gate/store.json" &&
  install -m 0600 -o dsh -g dsh /dev/null "$B/owner-canary" &&
  printf 'canary\n' > "$B/owner-canary" &&
  install -m 0600 -o dsh -g dsh /dev/null "$B/hard-target" || return 1

  echo "subordinate grants before ours:"; cat /etc/subuid /etc/subgid
  echo "the members' and Bots' ids: $FIRST-$LAST"
  echo "$RUNNER:$FIRST:64" >> /etc/subuid &&
  echo "$RUNNER:$FIRST:64" >> /etc/subgid || return 1

  install -d -m 0755 -o "$RUNNER" -g "$RUNNER" "$B/am" &&
  tar -xzf "$AM_TGZ" -C "$B/am" &&
  chown -R "$RUNNER:$RUNNER" "$B/am" || return 1
  if [ ! -f "$B/am/runner/main.mjs" ] || [ -e "$B/am/test" ]; then
    echo "the tarball is not am without its tests"; return 1
  fi

  # The sheet's client, verbatim from the sheet the tarball carries.
  awk '/^```js$/{f=1;next} /^```$/{if(f){exit}} f' "$B/am/runner/VM-RUN.md" > "$B/client.mjs" &&
  [ -s "$B/client.mjs" ] && chown root:root "$B/client.mjs" && chmod 0755 "$B/client.mjs" || return 1
  # Row 13's fixture: a late proof that really is made late, after the runner's refusal.
  cat > "$B/late-client.mjs" <<'LATE'
import { closeSync, openSync } from 'node:fs'
import { connect } from 'node:net'
const [sock, proofs] = process.argv.slice(2)
const conn = connect(sock)
let buf = ''
let name = null
let refused = false
conn.setEncoding('utf8')
conn.on('error', (e) => { console.log(`error ${e.code}`) })
conn.on('data', (chunk) => {
  buf += chunk
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (name === null) {
      name = line
      setTimeout(() => {
        try { closeSync(openSync(`${proofs}/${name}`, 'wx', 0o600)); console.log(`late proof made, refused before: ${refused}`) } catch (e) { console.log(`late proof not made ${e.code}`) }
        try { conn.write('done\n') } catch {}
        setTimeout(() => process.exit(0), 1500)
      }, 4000)
    } else {
      if (line.startsWith('refused: ')) refused = true
      console.log(line)
    }
  }
})
LATE
  chown root:root "$B/late-client.mjs" && chmod 0755 "$B/late-client.mjs" || return 1

  RUNNER_UID=$(id -u "$RUNNER"); DSH_UID=$(id -u dsh); DSH2_UID=$(id -u dsh2)
  cat > "$B/config.json" <<JSON
{
  "socket": "$B/sock/runner.sock",
  "proofs": "$B/proofs",
  "group": "dshsock",
  "dshUid": $DSH_UID,
  "workRoot": "$B/work",
  "homesRoot": "$B/homes",
  "state": "$B/state.json",
  "uidStart": $FIRST,
  "uidCount": 64,
  "gidStart": $FIRST,
  "gidCount": 64,
  "limits": { "memoryMax": "512M", "tasksMax": 128 },
  "maxTimeoutMs": 60000,
  "maxOutputBytes": 8388608,
  "maxConcurrent": 4
}
JSON
  chown "$RUNNER:$RUNNER" "$B/config.json" && chmod 0600 "$B/config.json" || return 1

  # A systemd user manager for the runner, for each shell's scope; systemd-run --user needs its bus.
  loginctl enable-linger "$RUNNER" || return 1
  for _ in $(seq 60); do [ -S "/run/user/$RUNNER_UID/bus" ] && break; sleep 1; done
  [ -S "/run/user/$RUNNER_UID/bus" ] || { echo "no user bus at /run/user/$RUNNER_UID/bus"; return 1; }
  systemctl is-active "user@$RUNNER_UID.service" || return 1
  # Preflight: the runner's account can make a scope with the limits each shell gets.
  echo "scope preflight as $RUNNER:"
  timeout 60 setpriv --reuid "$RUNNER" --regid "$RUNNER" --init-groups -- \
    env XDG_RUNTIME_DIR="/run/user/$RUNNER_UID" systemd-run --user --scope --quiet \
    -p MemoryMax=512M -p TasksMax=128 -- sh -c \
    'p=$(cut -d: -f3 /proc/self/cgroup); echo "$p" >&2; cat "/sys/fs/cgroup$p/memory.max" "/sys/fs/cgroup$p/pids.max"' \
    > "$T/preflight" || true
  cat "$T/preflight"
  if [ "$(cat "$T/preflight")" != "$(printf '536870912\n128')" ]; then
    echo "the runner's account cannot make a scope with MemoryMax=512M and TasksMax=128"
    journalctl --no-pager -u "user@$RUNNER_UID.service" -n 50 -o cat
    return 1
  fi

  cat > "/etc/systemd/system/$UNIT" <<UNIT
[Unit]
Description=am member runner (test)
After=network.target

[Service]
Type=simple
User=$RUNNER
Group=$RUNNER
SupplementaryGroups=dshsock
Environment=XDG_RUNTIME_DIR=/run/user/$RUNNER_UID
ExecStart=$NODE $B/am/runner/main.mjs --config $B/config.json
NoNewPrivileges=no
Restart=no

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload || return 1

  # Record what this util-linux does with the provisioning namespace's maps: two --map-users
  # ranges (what spawn.mjs passed before; 2.39 keeps only the last) and one --map-user=0 plus one
  # range (what it passes now). Ids inside, the maps, and a chown to a member id seen from outside.
  RUNNER_GID=$(id -g "$RUNNER")
  unshare --version
  for form in two-ranges user-plus-range; do
    install -d -m 0700 -o "$RUNNER" -g "$RUNNER" "$B/userns-$form" || return 1
    if [ "$form" = two-ranges ]; then
      set -- "--map-users=0:$RUNNER_UID:1" "--map-users=$FIRST:$FIRST:1" "--map-groups=0:$RUNNER_GID:1" "--map-groups=$FIRST:$FIRST:1"
    else
      set -- --map-user=0 "--map-users=$FIRST:$FIRST:1" --map-group=0 "--map-groups=$FIRST:$FIRST:1"
    fi
    echo "userns check as $RUNNER, $form: $*"
    ( cd "$B/userns-$form" && timeout 30 setpriv --reuid "$RUNNER" --regid "$RUNNER" --init-groups -- \
      unshare "$@" -- sh -c 'echo "inside: uid=$(id -u) gid=$(id -g)"
        echo "uid_map:"; cat /proc/self/uid_map; echo "gid_map:"; cat /proc/self/gid_map
        mkdir d && chown "$1:$1" d; echo "chown rc=$?"; stat -c "inside d: %u %g" d' sh "$FIRST" ) || true
    stat -c "outside d: %u %g" "$B/userns-$form/d" 2> /dev/null || echo "outside: no d"
  done
  set --
  start_runner
}

start_runner() {
  systemctl start "$UNIT" || return 1
  for _ in $(seq 30); do [ -S "$B/sock/runner.sock" ] && break; sleep 1; done
  [ -S "$B/sock/runner.sock" ] || { echo "the runner made no socket"; return 1; }
}

echo "setup (as root, VM-RUN.md)" | tee -a "$ROWS"
if ! setup >> "$ROWS" 2>&1; then
  echo "setup FAILED" | tee -a "$ROWS"
  exit 1
fi
S=$B/sock/runner.sock; P=$B/proofs; W=$B/work
BA=b-aaaaaaaaaa; BB=b-bbbbbbbbbb
stat -c '%a %U %G %n' "$B/sock" "$P" "$W" "$B/homes" | tee -a "$ROWS"

# --- Row helpers ----------------------------------------------------------------------------------

FAILED=()
CUR=''
CUR_OK=1
RC=0; OUT=''; ERR=''

row() {
  CUR=$1; CUR_OK=1
  printf '\n== row %s: %s\n' "$1" "$2" >> "$ROWS"
}
# capture <cmd...>: runs it, keeps rc, stdout and stderr, and logs all three. Every command run
# as another user is bounded by as_user/as_outsider's timeout.
capture() {
  "$@" > "$T/out" 2> "$T/err"
  RC=$?
  OUT=$(cat "$T/out"); ERR=$(cat "$T/err")
  {
    printf '$ %s\n' "$*"
    printf 'rc=%s\n' "$RC"
    [ -z "$OUT" ] || printf 'stdout:\n%s\n' "$OUT"
    [ -z "$ERR" ] || printf 'stderr:\n%s\n' "$ERR"
  } >> "$ROWS"
}
expect() {
  local what=$1; shift
  if ! "$@"; then CUR_OK=0; printf 'NOT: %s\n' "$what" >> "$ROWS"; fi
}
has() { grep -Fq -- "$1" <<< "$2"; }
is_line() { grep -Fxq -- "$1" <<< "$2"; }
rc_is() { [ "$RC" -eq "$1" ]; }
rc_not() { [ "$RC" -ne "$1" ]; }
both() { printf '%s\n%s\n' "$OUT" "$ERR"; }
end_row() {
  if [ "$CUR_OK" -eq 1 ]; then
    printf 'row %s: PASS\n' "$CUR" | tee -a "$ROWS"
  else
    printf 'row %s: FAIL\n' "$CUR" | tee -a "$ROWS"
    FAILED+=("$CUR")
  fi
}
uid_in_range() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge "$FIRST" ] && [ "$1" -le "$LAST" ]; }

as_user() { local u=$1; shift; timeout 90 setpriv --reuid "$u" --regid "$u" --init-groups -- "$@"; }
as_outsider() { timeout 90 setpriv --reuid outsider --regid outsider --clear-groups -- "$@"; }
count_between() { local n; n=$(grep -c . <<< "$1"); [ "$n" -ge "$2" ] && [ "$n" -le "$3" ]; }
no_ok_start() { ! grep -Eq '^(ok|\{"t":"start")' <<< "$OUT"; }
no_secret() { ! grep -q secret <<< "$OUT"; }
owner_of() { stat -c %u "$1" 2> /dev/null; }
host_ns() { readlink "/proc/self/ns/$1"; }
ns_differs() { [ "$RC" -eq 0 ] && [ -n "$OUT" ] && [ "$OUT" != "$(host_ns "$1")" ]; }
same_uid() { [ "$RC" -eq 0 ] && [ "$OUT" = "$1" ]; }
only_marker() { [ "$(ls -A "$P")" = .clock ]; }
# member <who> <cwd> <attack> argv...: the sheet's client as dsh.
client() { as_user dsh "$NODE" "$B/client.mjs" "$S" "$P" "$@"; }
member() { local who=$1; shift; client "$who" "$W/$who" none "$@"; }
bot() { local id=$1; shift; client "bot:$id" "$W/.bots/$id" none "$@"; }

cd / || die "cannot enter /"

# --- Rows 1-26 ------------------------------------------------------------------------------------

row 1 "the unit is active"
capture timeout 30 systemctl is-active "$UNIT"
expect "active" is_line active "$OUT"
end_row

row 2 "a member's shell is a uid from the runner's range"
capture member alice sh -c 'id -u'
ALICE_UID=$OUT
expect "exit 0" rc_is 0
expect "uid in $FIRST-$LAST" uid_in_range "$ALICE_UID"
expect "start line names alice and her uid" is_line "start member=alice uid=$ALICE_UID" "$ERR"
end_row

row 3 "no effective capabilities"
capture member alice sh -c 'grep CapEff /proc/self/status'
expect "exit 0" rc_is 0
expect "CapEff all zero" grep -Eq '^CapEff:[[:space:]]+0{16}$' <<< "$OUT"
end_row

row 4 "its own network namespace: only lo"
capture member alice sh -c 'cat /proc/net/dev'
expect "exit 0" rc_is 0
DEVS=$(tail -n +3 <<< "$OUT" | cut -d: -f1 | tr -d ' ')
expect "exactly one interface below the header" count_between "$DEVS" 1 1
expect "the interface is lo" [ "$DEVS" = lo ]
capture member alice readlink /proc/self/ns/net
expect "a network namespace that is not the host's" ns_differs net
end_row

row 5 "its own pid namespace: no host pids"
capture member alice sh -c 'ls /proc'
expect "exit 0" rc_is 0
PIDS=$(grep -E '^[0-9]+$' <<< "$OUT")
expect "1 to 5 processes" count_between "$PIDS" 1 5
expect "only small pids (namespace-local)" [ -z "$(awk '$1 >= 100' <<< "$PIDS")" ]
capture member alice readlink /proc/self/ns/pid
expect "a pid namespace that is not the host's" ns_differs pid
end_row

row 6 "cwd is the work area; HOME, XDG_CONFIG_HOME and TMPDIR are the member's, 0700"
capture member alice sh -c 'pwd; stat -c "%u %a" "$HOME" "$XDG_CONFIG_HOME" "$TMPDIR"'
expect "exit 0" rc_is 0
expect "the exact four lines" [ "$OUT" = "$(printf '%s\n%s 700\n%s 700\n%s 700' "$W/alice" "$ALICE_UID" "$ALICE_UID" "$ALICE_UID")" ]
capture member alice touch made-by-alice
expect "touch: exit 0" rc_is 0
expect "on the host the file is owned by alice's uid" [ "$(owner_of "$W/alice/made-by-alice")" = "$ALICE_UID" ]
end_row

usermod -aG dshsock dsh2 >> "$ROWS" 2>&1

row 7 "dsh2 in the socket group: the proof is not DSH's"
capture as_user dsh2 "$NODE" "$B/client.mjs" "$S" "$P" alice "$W/alice" none sh -c 'id -u'
expect "exit 125" rc_is 125
expect "refused: the proof is owned by uid $DSH2_UID" has "refused: the proof is owned by uid $DSH2_UID" "$ERR"
end_row

row 8 "outside the socket group: no connection"
capture as_outsider "$NODE" "$B/client.mjs" "$S" "$P" alice "$W/alice" none sh -c 'id -u'
expect "exit 125" rc_is 125
expect "client: EACCES or EPERM" grep -Eq '^client: (EACCES|EPERM)$' <<< "$ERR"
end_row

row 9 "a symlinked proof"
capture client alice "$W/alice" symlink sh -c 'id -u'
expect "exit 125" rc_is 125
expect "refused: the proof is not a regular file" has "refused: the proof is not a regular file" "$ERR"
end_row

row 10 "a hard-linked proof (protected_hardlinks=$(cat /proc/sys/fs/protected_hardlinks))"
capture as_user dsh2 "$NODE" "$B/client.mjs" "$S" "$P" alice "$W/alice" "hardlink:$B/hard-target" sh -c 'id -u'
expect "not exit 0" rc_not 0
expect "link denied, or refused for more than one link" \
  grep -Eq 'EPERM|operation not permitted|refused: the proof has more than one link' <<< "$(both)"
if has 'refused: the proof has more than one link' "$ERR"; then
  echo "branch: the runner's link-count check" >> "$ROWS"
  expect "a refusal exits 125" rc_is 125
else
  echo "branch: the kernel denied the link (protected_hardlinks)" >> "$ROWS"
  expect "the denial names link() of the target" grep -Fq "link '$B/hard-target'" <<< "$ERR"
fi
end_row

row 10b "a hard link DSH may make (its own file): the runner's link-count check"
capture client alice "$W/alice" "hardlink:$B/hard-target" sh -c 'id -u'
expect "exit 125" rc_is 125
expect "refused: the proof has more than one link" has "refused: the proof has more than one link" "$ERR"
expect "the command did not run" [ -z "$OUT" ]
end_row

row 11 "a proof under the wrong name"
capture client alice "$W/alice" wrong-name sh -c 'id -u'
expect "exit 125" rc_is 125
expect "refused: no proof file" has "refused: no proof file" "$ERR"
end_row

row 12 "no proof at all"
capture client alice "$W/alice" silent sh -c 'id -u'
expect "exit 125" rc_is 125
expect "refused: no proof in time" has "refused: no proof in time" "$ERR"
end_row

row 13 "a late proof"
# The sheet's client exits on the refusal before its 4 s timer fires, so this row also runs a
# fixture that stays connected, makes the proof after 4 s anyway and reports what it saw.
capture client alice "$W/alice" late sh -c 'id -u'
expect "exit 125" rc_is 125
expect "refused: no proof in time" has "refused: no proof in time" "$ERR"
capture as_user dsh "$NODE" "$B/late-client.mjs" "$S" "$P"
expect "fixture: exit 0" rc_is 0
expect "the runner refused before the proof existed" is_line "refused: no proof in time" "$OUT"
expect "the late proof was made after the refusal" is_line "late proof made, refused before: true" "$OUT"
expect "no ok and no start" no_ok_start
end_row

row 14 "a non-empty proof"
capture client alice "$W/alice" nonempty sh -c 'id -u'
expect "exit 125" rc_is 125
expect "refused: the proof is not empty" has "refused: the proof is not empty" "$ERR"
capture member alice sh -c 'id -u'
expect "after the refusals a good request still runs" same_uid "$ALICE_UID"
expect "the proof folder holds only the runner's marker" only_marker
end_row

row 15 "the outsider can neither list nor write the proof folder"
capture as_outsider ls "$P"
expect "ls denied" rc_not 0
expect "ls: Permission denied" has "Permission denied" "$ERR"
capture as_outsider touch "$P/x"
expect "touch denied" rc_not 0
expect "touch: Permission denied" has "Permission denied" "$ERR"
end_row

row 16 "the socket group cannot list the proof folder"
capture as_user dsh2 ls "$P"
expect "denied" rc_not 0
expect "Permission denied" has "Permission denied" "$ERR"
end_row

gpasswd -d dsh2 dshsock >> "$ROWS" 2>&1

row 17 "DSH's own file: dsh reads it, the member cannot"
capture as_user dsh cat "$B/owner-canary"
expect "dsh reads canary" is_line canary "$OUT"
capture member alice cat "$B/owner-canary"
expect "member: exit 1" rc_is 1
expect "member: Permission denied" has "Permission denied" "$ERR"
expect "member: no canary" [ -z "$OUT" ]
end_row

row 18 "one member's home is closed to another"
capture member alice sh -c 'echo secret > "$HOME/.npmrc"'
expect "alice writes: exit 0" rc_is 0
capture member bob cat "$B/homes/alice/.npmrc"
expect "bob: exit 1" rc_is 1
expect "bob: Permission denied" has "Permission denied" "$ERR"
expect "bob: no secret" [ -z "$OUT" ]
end_row

row 19 "the scope's limits"
capture member alice sh -c 'p=$(cut -d: -f3 /proc/self/cgroup); cat /sys/fs/cgroup$p/memory.max /sys/fs/cgroup$p/pids.max'
expect "exit 0" rc_is 0
expect "536870912 then 128" [ "$OUT" = "$(printf '536870912\n128')" ]
end_row

row 20 "the command's exit code passes through"
capture member alice sh -c 'exit 7'
expect "exit 7" rc_is 7
end_row

row 21 "a member name outside the spelling"
capture client Alice "$W/Alice" none sh -c true
expect "exit 125" rc_is 125
expect "runner refused BAD_REQUEST" has "runner refused BAD_REQUEST" "$ERR"
end_row

# Rows 22 and 23: second runner processes, root-owned 0644 configs.
"$NODE" -e '
  const [src, dst, tmp] = process.argv.slice(1)
  const c = JSON.parse(require("fs").readFileSync(src, "utf8"))
  if (tmp === "tmp") { c.socket = "/tmp/runner.sock"; c.proofs = "/tmp/proofs" }
  else for (const k of ["socket", "proofs", "workRoot", "homesRoot", "state"]) c[k] = c[k].replace("/srv/am-runner/", "/srv/am-runner/alt/")
  require("fs").writeFileSync(dst, JSON.stringify(c, null, 2) + "\n")
' "$B/config.json" "$B/config-tmp.json" tmp &&
"$NODE" -e '
  const [src, dst] = process.argv.slice(1)
  const c = JSON.parse(require("fs").readFileSync(src, "utf8"))
  for (const k of ["socket", "proofs", "workRoot", "homesRoot", "state"]) c[k] = c[k].replace("/srv/am-runner/", "/srv/am-runner/alt/")
  require("fs").writeFileSync(dst, JSON.stringify(c, null, 2) + "\n")
' "$B/config.json" "$B/config-copy.json" &&
chown root:root "$B/config-tmp.json" "$B/config-copy.json" &&
chmod 0644 "$B/config-tmp.json" "$B/config-copy.json" >> "$ROWS" 2>&1

row 22 "a socket under a world-writable folder"
capture as_user "$RUNNER" "$NODE" "$B/am/runner/main.mjs" --config "$B/config-tmp.json"
expect "exit 125" rc_is 125
expect "member-runner: refused to start:" has "member-runner: refused to start:" "$ERR"
expect "writable by group or others" has "writable by group or others" "$ERR"
expect "no socket made in /tmp" [ ! -e /tmp/runner.sock ]
end_row

row 23 "the runner as DSH's own uid"
capture as_user dsh "$NODE" "$B/am/runner/main.mjs" --config "$B/config-copy.json"
expect "exit 125" rc_is 125
expect "refused to start: DSH's uid is the runner's own uid" has "refused to start: DSH's uid is the runner's own uid" "$ERR"
expect "nothing made under $B/alt" [ ! -e "$B/alt" ]
end_row

row 24 "a second member in the socket group stops the start"
usermod -aG dshsock dsh2 >> "$ROWS" 2>&1
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
sleep 1
capture systemctl restart "$UNIT"
STATE=''
for _ in $(seq 10); do STATE=$(systemctl is-active "$UNIT"); [ "$STATE" = failed ] && break; sleep 1; done
printf 'unit state: %s\n' "$STATE" >> "$ROWS"
expect "the unit failed" [ "$STATE" = failed ]
LOG=''
for _ in $(seq 10); do
  LOG=$(journalctl --no-pager -u "$UNIT" --since "$SINCE" -o cat)
  has "refused to start: the socket group dshsock must have DSH's uid as its only member" "$LOG" && break
  sleep 1
done
printf 'journal since restart:\n%s\n' "$LOG" >> "$ROWS"
expect "the journal names the group lock" has "refused to start: the socket group dshsock must have DSH's uid as its only member" "$LOG"
gpasswd -d dsh2 dshsock >> "$ROWS" 2>&1
systemctl reset-failed "$UNIT" >> "$ROWS" 2>&1
expect "the runner starts again without dsh2" start_runner
capture systemctl is-active "$UNIT"
expect "active again" is_line active "$OUT"
end_row

row 25 "a member's folder opened by the member is refused"
capture member alice sh -c 'chmod 0755 "$HOME/.config"'
expect "chmod: exit 0" rc_is 0
capture member alice sh -c 'id -u'
expect "exit 125" rc_is 125
expect "HOME_INVALID" has "HOME_INVALID" "$ERR"
expect "is mode 755, not 700" has "is mode 755, not 700" "$ERR"
end_row

row 26 "a cwd through a symlink out of the work area (fresh member dave)"
capture member dave sh -c 'ln -s /etc escape'
expect "ln: exit 0" rc_is 0
capture client dave "$W/dave/escape" none sh -c 'id -u'
expect "exit 125" rc_is 125
expect "BAD_CWD" has "BAD_CWD" "$ERR"
end_row

# --- Bot rows 27-32 -------------------------------------------------------------------------------

row 27 "bot-shell: each Bot is its own uid, not DSH's, not a member's"
capture bot "$BA" sh -c 'id -u; echo "$HOME"; pwd'
A_RC=$RC; A_OUT=$OUT; A_ERR=$ERR
capture bot "$BB" id -u
B_RC=$RC; B_UID=$OUT; B_ERR=$ERR
capture member carol id -u
CAROL_UID=$OUT
expect "carol: exit 0" rc_is 0
A_UID=$(head -n 1 <<< "$A_OUT")
expect "Bot A: exit 0" [ "$A_RC" -eq 0 ]
expect "Bot B: exit 0" [ "$B_RC" -eq 0 ]
for uid in "$A_UID" "$B_UID"; do
  expect "Bot uid $uid in $FIRST-$LAST" uid_in_range "$uid"
  expect "Bot uid $uid is not DSH's" [ "$uid" != "$DSH_UID" ]
  expect "Bot uid $uid is not alice's" [ "$uid" != "$ALICE_UID" ]
  expect "Bot uid $uid is not carol's" [ "$uid" != "$CAROL_UID" ]
  expect "Bot uid $uid is not the runner's" [ "$uid" != "$RUNNER_UID" ]
done
expect "the two Bots differ" [ "$A_UID" != "$B_UID" ]
expect "Bot A start line" is_line "start bot=$BA uid=$A_UID" "$A_ERR"
expect "Bot B start line" is_line "start bot=$BB uid=$B_UID" "$B_ERR"
expect "Bot A: uid, home, work area" [ "$A_OUT" = "$(printf '%s\n%s\n%s' "$A_UID" "$B/homes/.bots/$BA" "$W/.bots/$BA")" ]
capture bot "$BA" touch made-by-a
capture bot "$BB" touch made-by-b
expect "on the host Bot A's file is Bot A's uid" [ "$(owner_of "$W/.bots/$BA/made-by-a")" = "$A_UID" ]
expect "on the host Bot B's file is Bot B's uid" [ "$(owner_of "$W/.bots/$BB/made-by-b")" = "$B_UID" ]
end_row

row 28 "gate-credential: a Bot cannot read the launch file or the gate store"
capture as_user dsh cat "$B/dsh-home/launch"
expect "dsh reads launch-canary" is_line launch-canary "$OUT"
capture as_user gate cat "$B/gate/store.json"
expect "gate reads gate-canary" is_line gate-canary "$OUT"
for file in "$B/dsh-home/launch" "$B/gate/store.json"; do
  capture bot "$BA" cat "$file"
  expect "Bot read of $file: exit 1" rc_is 1
  expect "Bot read of $file: Permission denied" has "Permission denied" "$ERR"
  expect "Bot read of $file: no canary" [ -z "$OUT" ]
done
end_row

row 29 "bot-owner-rights: no owner file, no owner folder, no runner socket"
capture as_user dsh cat "$B/owner-canary"
expect "dsh reads canary" is_line canary "$OUT"
capture bot "$BA" cat "$B/owner-canary"
expect "Bot read: exit 1" rc_is 1
expect "Bot read: Permission denied" has "Permission denied" "$ERR"
capture bot "$BA" touch "$B/dsh-home/x"
expect "Bot write: exit 1" rc_is 1
expect "Bot write: Permission denied" has "Permission denied" "$ERR"
expect "no file made" [ ! -e "$B/dsh-home/x" ]
capture bot "$BA" "$NODE" -e "require('net').connect(process.argv[1]).on('error',e=>{console.log(e.code);process.exit(1)})" "$S"
expect "socket probe: exit 1" rc_is 1
expect "socket probe: EACCES" is_line EACCES "$OUT"
end_row

row 30 "Bot A's files and member cross reads"
capture bot "$BA" sh -c 'echo secret-a > "$HOME/.npmrc" && echo a > a.txt'
expect "Bot A writes: exit 0" rc_is 0
capture member carol sh -c 'echo member-secret > "$HOME/.npmrc"'
expect "carol writes: exit 0" rc_is 0
for probe in "bot $BB cat $B/homes/.bots/$BA/.npmrc" "bot $BB ls $W/.bots/$BA" \
  "member carol cat $B/homes/.bots/$BA/.npmrc" "member carol ls $W/.bots/$BA" \
  "bot $BA cat $B/homes/carol/.npmrc"; do
  # shellcheck disable=SC2086 # each probe is words with no spaces inside them
  capture $probe
  expect "$probe: denied" rc_not 0
  expect "$probe: Permission denied" has "Permission denied" "$ERR"
  expect "$probe: no secret" no_secret
done
capture bot "$BA" sh -c 'cat "$HOME/.npmrc"'
expect "Bot A reads its own: exit 0" rc_is 0
expect "Bot A reads secret-a" is_line secret-a "$OUT"
end_row

row 31 "a host-pinned id spelling"
capture bot unfold-root true
expect "exit 125" rc_is 125
expect "runner refused BAD_REQUEST" has "runner refused BAD_REQUEST" "$ERR"
end_row

row 32 "the Bot roots"
capture stat -c '%a %u %n' "$B/homes/.bots" "$W/.bots"
expect "both 711 and the runner's" [ "$OUT" = "$(printf '711 %s %s\n711 %s %s' "$RUNNER_UID" "$B/homes/.bots" "$RUNNER_UID" "$W/.bots")" ]
end_row

# --- The endpoint for the bots-dsh probe rows (D2) ------------------------------------------------

cat > "$ART/probe.json" <<JSON
{
  "socket": "$S",
  "proofs": "$P",
  "workRoot": "$W",
  "homesRoot": "$B/homes",
  "runnerUid": $RUNNER_UID,
  "socketGid": $(getent group dshsock | cut -d: -f3),
  "dshUid": $DSH_UID,
  "dshGid": $(id -g dsh),
  "uidStart": $FIRST,
  "uidCount": 64,
  "node": "$NODE",
  "dshHome": "$B/dsh-home",
  "launch": "$B/dsh-home/launch",
  "gateStore": "$B/gate/store.json",
  "gateUser": "gate",
  "ownerCanary": "$B/owner-canary"
}
JSON
if [ ! -s "$ART/probe.json" ]; then echo "vm-run: could not write $ART/probe.json" | tee -a "$ROWS"; exit 1; fi

printf '\n' | tee -a "$ROWS"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf 'vm-run: FAILED rows: %s\n' "${FAILED[*]}" | tee -a "$ROWS"
  exit 1
fi
echo "vm-run: rows 1-32 PASS" | tee -a "$ROWS"
