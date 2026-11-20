# The member runner on a test VM

A run sheet for the real multi-user proof, on a throwaway Debian 13 or Ubuntu 24.04 VM. It proves
what a hermetic test cannot: a member's shell is a different host uid, the socket proof holds
between real users, the socket group is the gate, the per-member homes are private, and the
systemd scope limits apply. Run it on this PR's build (am's tarball), as root in the setup, never
on a live machine.

Placeholders: `$B` is a folder owned by the runner on a real filesystem, mode 0711 (members and
DSH may pass through it, no one but the runner may write it). `$S` is the socket, `$P` the proof
folder, `$W` the members' work area. Alice and Bob are member names; their host uids are assigned
from the runner's subordinate range, not accounts.

## Setup as root

```sh
B=/srv/am-runner

groupadd dshsock
useradd --system --no-create-home --shell /usr/sbin/nologin --user-group dsh
useradd --system --no-create-home --shell /usr/sbin/nologin --user-group dsh2
useradd --system --no-create-home --shell /usr/sbin/nologin --user-group outsider
useradd --system --no-create-home --shell /usr/sbin/nologin --user-group gate
usermod -aG dshsock dsh
useradd --system --no-create-home --shell /usr/sbin/nologin --user-group runner

RUNNER_UID=$(id -u runner); DSH_UID=$(id -u dsh); DSH2_UID=$(id -u dsh2)
GROUP_GID=$(getent group dshsock | cut -d: -f3)
S=$B/sock/runner.sock; P=$B/proofs; W=$B/work
BA=b-aaaaaaaaaa; BB=b-bbbbbbbbbb

# The runner's own folder: passable, not writable by anyone else.
install -d -m 0711 -o runner -g runner "$B"
install -d -m 0700 -o dsh -g dsh "$B/dsh-home"
install -m 0600 -o dsh -g dsh /dev/null "$B/dsh-home/launch"
printf 'launch-canary\n' > "$B/dsh-home/launch"
install -d -m 0700 -o gate -g gate "$B/gate"
install -m 0600 -o gate -g gate /dev/null "$B/gate/store.json"
printf 'gate-canary\n' > "$B/gate/store.json"

# The runner user's subordinate range: one line each, e.g. 64 ids.
echo 'runner:200000:64' >> /etc/subuid
echo 'runner:200000:64' >> /etc/subgid

# am, installed as the runner's own user (the template's install path; here from the tarball).
command -v setpriv unshare newuidmap newgidmap systemd-run || { echo tools missing; exit 1; }
install -d -m 0755 -o runner -g runner "$B/am"
tar -xzf automagik-am-<version>.tgz -C "$B/am"
chown -R runner:runner "$B/am"

cat > "$B/config.json" <<JSON
{
  "socket": "$B/sock/runner.sock",
  "proofs": "$B/proofs",
  "group": "dshsock",
  "dshUid": $DSH_UID,
  "workRoot": "$B/work",
  "homesRoot": "$B/homes",
  "state": "$B/state.json",
  "uidStart": 200000,
  "uidCount": 64,
  "gidStart": 200000,
  "gidCount": 64,
  "limits": { "memoryMax": "512M", "tasksMax": 128 },
  "maxTimeoutMs": 60000,
  "maxOutputBytes": 8388608,
  "maxConcurrent": 4
}
JSON
chown runner:runner "$B/config.json"; chmod 0600 "$B/config.json"

# A systemd user manager for the runner, for each shell's scope.
loginctl enable-linger runner

# The template's unit shape: the runner's own user, the socket group as a supplementary group,
# and no NoNewPrivileges (it would break setuid newuidmap/newgidmap).
cat > /etc/systemd/system/am-member-runner.service <<UNIT
[Unit]
Description=am member runner (test)
After=network.target

[Service]
Type=simple
User=runner
Group=runner
SupplementaryGroups=dshsock
Environment=XDG_RUNTIME_DIR=/run/user/$RUNNER_UID
ExecStart=/usr/bin/node $B/am/runner/main.mjs --config $B/config.json
NoNewPrivileges=no
Restart=no

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl start am-member-runner.service
sleep 1; systemctl is-active am-member-runner.service
```

The runner makes `$B/sock` (0750, group `dshsock`), `$B/proofs` (1730), `$B/work` and `$B/homes`
(0711) itself. Check them: `stat -c '%a %U %G %n' "$B/sock" "$B/proofs" "$B/work" "$B/homes"`.

## The client

Save this as `$B/client.mjs`, run `chmod 0755` on it, and run it as the uid under test.
The `who` argument is a member name for v1 or `bot:<id>` for v2. The client prints decoded
output after a `start` that matches the requested identity and gives a non-negative integer uid.
It reports that identity and uid on stderr. It exits 125 on a refusal or incomplete reply,
124 on a timeout after `start`, or with the command's status.

```js
import { closeSync, openSync, writeFileSync, symlinkSync, linkSync } from 'node:fs'
import { connect } from 'node:net'
import { constants } from 'node:os'
const [sock, proofs, who, cwd, attack = 'none', ...argv] = process.argv.slice(2)
const identity = who.startsWith('bot:')
  ? { v: 2, identity: { kind: 'bot', id: who.slice(4) } }
  : { v: 1, member: who }
const identityKey = identity.v === 2 ? 'bot' : 'member'
const otherKey = identity.v === 2 ? 'member' : 'bot'
const expectedName = identity.v === 2 ? identity.identity.id : identity.member
process.exitCode = 125
const conn = connect(sock)
let buf = ''
let stage = 'name'
let started = false
let terminal = null
const badFrame = () => {
  console.error('refused: bad frame')
  process.exit(125)
}
conn.setEncoding('utf8')
conn.on('error', (e) => { console.error(`client: ${e.code}`); process.exit(125) })
conn.on('end', () => {
  if (stage === 'frames' && buf !== '') badFrame()
  if (!started || terminal?.t !== 'exit') return
  if (terminal.timedOut) process.exitCode = 124
  else if (Number.isInteger(terminal.code)) process.exitCode = terminal.code
  else process.exitCode = 128 + constants.signals[terminal.signal]
})
conn.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (stage !== 'frames' && line.startsWith('refused: ')) {
      console.error(line)
      process.exit(125)
    }
    if (stage === 'name') {
      stage = 'proof'
      const file = `${proofs}/${line}${attack === 'wrong-name' ? 'x' : ''}`
      if (attack === 'silent') continue
      if (attack === 'late') { setTimeout(() => { writeFileSync(file, ''); conn.write('done\n') }, 4000); continue }
      if (attack === 'symlink') symlinkSync('/etc/hostname', file)
      else if (attack.startsWith('hardlink:')) linkSync(attack.slice('hardlink:'.length), file)
      else if (attack === 'nonempty') writeFileSync(file, 'x')
      else closeSync(openSync(file, 'wx', 0o600))
      conn.write('done\n')
    } else if (stage === 'proof') {
      if (line !== 'ok') { console.error(line); process.exit(125) }
      stage = 'frames'
      conn.write(JSON.stringify({ ...identity, argv, cwd, timeoutMs: 60000 }) + '\n')
    } else {
      let frame
      try { frame = JSON.parse(line) } catch { badFrame() }
      if (frame?.t === 'start') {
        if (started || terminal !== null || frame[identityKey] !== expectedName ||
            Object.hasOwn(frame, otherKey) || !Number.isInteger(frame.uid) || frame.uid < 0) {
          console.error('refused: wrong start frame')
          process.exit(125)
        }
        started = true
        console.error(`start ${identityKey}=${expectedName} uid=${frame.uid}`)
      } else if (terminal !== null) {
        badFrame()
      } else if ((frame?.t === 'out' || frame?.t === 'err') && started) {
        if (typeof frame.d !== 'string' || frame.d.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.d)) badFrame()
        const stream = frame.t === 'out' ? process.stdout : process.stderr
        stream.write(Buffer.from(frame.d, 'base64'))
      } else if (frame?.t === 'error') {
        if (typeof frame.code !== 'string' || typeof frame.message !== 'string') badFrame()
        terminal = frame
        console.error(`runner refused ${frame.code}: ${frame.message}`)
      } else if (frame?.t === 'exit' && started) {
        const validStatus = frame.code === null
          ? typeof frame.signal === 'string' && Object.hasOwn(constants.signals, frame.signal)
          : Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255 && frame.signal === null
        if (!validStatus ||
            (Object.hasOwn(frame, 'timedOut') && typeof frame.timedOut !== 'boolean') ||
            (Object.hasOwn(frame, 'truncated') && typeof frame.truncated !== 'boolean')) badFrame()
        terminal = frame
      } else {
        badFrame()
      }
    }
  }
})
```

## Rows

Each row prints one line; compare with the expected text. A row that says "run as dsh" (or dsh2)
runs through `setpriv --reuid dsh --regid dsh --init-groups --`, so the new `dshsock` membership is
in the process's groups. The outsider runs without it. `A` and `B` are member names.

| # | Run as | Command | Expected |
|---|---|---|---|
| 1 | runner (unit) | `systemctl is-active am-member-runner.service` | `active` |
| 2 | dsh | `node $B/client.mjs $S $P alice $W/alice none sh -c 'id -u'` | `200000` to `200063`, exit 0 |
| 3 | dsh | same, `member` alice, `sh -c 'grep CapEff /proc/self/status'` | `CapEff: 0000000000000000` |
| 4 | dsh | same, `sh -c 'cat /proc/net/dev'` | only `lo:` below the header |
| 5 | dsh | same, `sh -c 'ls /proc'` | its own processes only: no host pids |
| 6 | dsh | same, `sh -c 'pwd; stat -c "%u %a" "$HOME" "$XDG_CONFIG_HOME" "$TMPDIR"'` | `$W/alice`, then `200000 700` three times |
| 7 | dsh2 (in dshsock) | `setpriv --reuid dsh2 --regid dsh2 --init-groups -- node $B/client.mjs $S $P alice $W/alice none sh -c 'id -u'` | `refused: the proof is owned by uid $DSH2_UID`, exit 125 |
| 8 | outsider | `setpriv --reuid outsider --regid outsider --clear-groups -- node $B/client.mjs $S $P alice $W/alice none sh -c 'id -u'` | `client: EACCES` (or `EPERM`), exit 125 |
| 9 | dsh | row 2, attack `symlink` | `refused: the proof is not a regular file`, 125 |
| 10 | dsh2 | row 2, attack `hardlink:$B/hard-target` (a file dsh owns) | link denied, or `refused: the proof has more than one link`, 125 |
| 11 | dsh | row 2, attack `wrong-name` | `refused: no proof file`, 125 |
| 12 | dsh | row 2, attack `silent` | `refused: no proof in time`, 125 |
| 13 | dsh | row 2, attack `late` | `refused: no proof in time`, 125 |
| 14 | dsh | row 2, attack `nonempty` | `refused: the proof is not empty`, 125 |
| 15 | outsider | `setpriv --reuid outsider --regid outsider --clear-groups -- ls "$P"; setpriv --reuid outsider --regid outsider --clear-groups -- touch "$P/x"` | both denied |
| 16 | dsh2 | `ls $B/proofs` | denied (group has no read) |
| 17 | root, then dsh | `install -m 0600 -o dsh -g dsh /dev/null "$B/owner-canary"; printf 'canary\n' > "$B/owner-canary"`, then as dsh `cat "$B/owner-canary"` and row 2 with `cat "$B/owner-canary"` | `canary` for dsh, then `Permission denied` for the member |
| 18 | dsh | row 2 as A with `sh -c 'echo secret > "$HOME/.npmrc"'`, then as B with `cat "$B/homes/alice/.npmrc"` | `Permission denied`, even with the path known |
| 19 | dsh | row 2, `sh -c 'p=$(cut -d: -f3 /proc/self/cgroup); cat /sys/fs/cgroup$p/memory.max /sys/fs/cgroup$p/pids.max'` | `536870912` and `128` |
| 20 | dsh | row 2 with `sh -c 'exit 7'` | client exits `7` |
| 21 | dsh | `node $B/client.mjs $S $P Alice $W/Alice none sh -c true` | `runner refused BAD_REQUEST`, exit 125 |
| 22 | runner | a copy of the config with `socket: /tmp/runner.sock` and `proofs: /tmp/proofs`, root-owned 0644, run as runner | `member-runner: refused to start: ... writable by group or others`, exit 125 |
| 23 | dsh | the same root-owned 0644 config as row 22, run as dsh | `refused to start: DSH's uid is the runner's own uid`, exit 125 |
| 24 | root | `usermod -aG dshsock dsh2`, `systemctl restart am-member-runner`, then `gpasswd -d dsh2 dshsock` | the unit fails with `refused to start: the socket group dshsock must have DSH's uid as its only member`; start it again after removing dsh2 |
| 25 | dsh | row 2 as A with `sh -c 'chmod 0755 "$HOME/.config"'`, then row 2 again | `HOME_INVALID`, `... is mode 755, not 700`, exit 125 |
| 26 | dsh | row 2 as A with `sh -c 'ln -s /etc escape'`, then row 2 with cwd `$W/alice/escape` | `BAD_CWD`, exit 125 |

Rows 7, 10, 15 and 16 need `dsh2` in `dshsock`; the lock refuses a group with a second member, so
add it with `usermod -aG dshsock dsh2` after the runner started (the socket's mode is the gate at
run time) and remove it before row 24. `--init-groups` picks the new membership up. Row 24 proves
the start lock. Rows 12 and 13 take about three and seven seconds.

### Bot rows

Rows 27 through 32 are the external real-VM run for RFC 0038 delivery 3 (Arca/VM). They were not
run for this change. Use the setup values for `BA`, `BB`, `B`, `S`, `P` and `W` in the shell
running each row. In the dsh shell define this shorthand:

```sh
bot() {
  bot_id=$1
  shift
  node "$B/client.mjs" "$S" "$P" "bot:$bot_id" "$W/.bots/$bot_id" none "$@"
}
```

#### 27. bot-shell

As dsh, set `ALICE_UID` to stdout from row 2. Run:

```sh
(
  fail() { echo "FAIL: $*" >&2; exit 1; }
  bot_logs=$(mktemp -d) || fail "could not create Bot log folder"
  bot "$BA" sh -c 'id -u; echo "$HOME"; pwd' > "$bot_logs/a.out" 2> "$bot_logs/a.err" ||
    fail "Bot A launch failed. See $bot_logs/a.err"
  bot "$BB" id -u > "$bot_logs/b.out" 2> "$bot_logs/b.err" ||
    fail "Bot B launch failed. See $bot_logs/b.err"
  a_uid=$(head -n 1 "$bot_logs/a.out") || fail "could not read Bot A uid"
  b_uid=$(cat "$bot_logs/b.out") || fail "could not read Bot B uid"
  dsh_uid=$(id -u) || fail "could not read DSH uid"
  carol_uid=$(node "$B/client.mjs" "$S" "$P" carol "$W/carol" none id -u) ||
    fail "could not read carol's uid"
  for uid in "$a_uid" "$b_uid" "$dsh_uid" "${ALICE_UID:-}" "$carol_uid"; do
    case "$uid" in ''|*[!0-9]*) fail "expected a numeric uid, got '$uid'" ;; esac
  done
  for uid in "$a_uid" "$b_uid"; do
    test "$uid" -ge 200000 && test "$uid" -le 200063 ||
      fail "Bot uid $uid is outside 200000–200063"
    test "$uid" -ne "$dsh_uid" || fail "Bot uid $uid equals DSH's uid"
    test "$uid" -ne "$ALICE_UID" || fail "Bot uid $uid equals alice's uid"
    test "$uid" -ne "$carol_uid" || fail "Bot uid $uid equals carol's uid"
  done
  test "$a_uid" -ne "$b_uid" || fail "both Bots have uid $a_uid"
  grep -Fx "start bot=$BA uid=$a_uid" "$bot_logs/a.err" || fail "Bot A start uid mismatch"
  grep -Fx "start bot=$BB uid=$b_uid" "$bot_logs/b.err" || fail "Bot B start uid mismatch"
  printf '%s\n' "$a_uid" "$B/homes/.bots/$BA" "$W/.bots/$BA" | cmp -s "$bot_logs/a.out" - ||
    fail "Bot A output does not match its uid, home and work area. See $bot_logs/a.out"
  cat "$bot_logs/a.out" || fail "could not read Bot A output"
)
```

The row should exit 0. Bot A's stdout shows its uid, `$B/homes/.bots/$BA` and `$W/.bots/$BA`.

#### 28. gate-credential

As dsh, run `cat "$B/dsh-home/launch"` and check for `launch-canary`. As gate, run
`cat "$B/gate/store.json"` and check for `gate-canary`. Then run as dsh:

```sh
bot "$BA" cat "$B/dsh-home/launch"
bot "$BA" cat "$B/gate/store.json"
```

Both Bot reads should print `Permission denied` and exit 1.

#### 29. bot-owner-rights

As dsh, read `"$B/owner-canary"` with `cat` and check for `canary` before asking the Bot:

```sh
bot "$BA" cat "$B/owner-canary"
bot "$BA" touch "$B/dsh-home/x"
bot "$BA" node -e "require('net').connect(process.argv[1]).on('error',e=>{console.log(e.code);process.exit(1)})" "$S"
```

The read and write should print `Permission denied`. The socket probe should print `EACCES`,
confirming the Bot cannot reach the runner to ask for another identity. Each command should exit
1. The owner-cookie and `/api/private` outcomes are pending the integrated Arca run (3c and 3d).

#### 30. Bot A's files and member cross reads

Run as dsh:

```sh
bot "$BA" sh -c 'echo secret-a > "$HOME/.npmrc"; echo a > a.txt'
bot "$BB" cat "$B/homes/.bots/$BA/.npmrc"
bot "$BB" ls "$W/.bots/$BA"
node "$B/client.mjs" "$S" "$P" carol "$W/carol" none sh -c 'echo member-secret > "$HOME/.npmrc"'
node "$B/client.mjs" "$S" "$P" carol "$W/carol" none cat "$B/homes/.bots/$BA/.npmrc"
node "$B/client.mjs" "$S" "$P" carol "$W/carol" none ls "$W/.bots/$BA"
bot "$BA" cat "$B/homes/carol/.npmrc"
bot "$BA" sh -c 'cat "$HOME/.npmrc"'
```

Use the fresh member `carol` because row 25 changed the mode of alice's config folder. Both
writes should exit 0. Each cross read and listing should print `Permission denied`. The final
read should print `secret-a` and exit 0.

#### 31. Host-pinned id spelling

As dsh, run `bot unfold-root true`. Expect `runner refused BAD_REQUEST` and exit 125.

#### 32. Bot roots

As root, run `stat -c '%a %u %n' "$B/homes/.bots" "$B/work/.bots"`. Both lines should show mode
`711` and the runner uid.

## What to send back

The printed lines and exit codes of each row, including the Bot rows and their `start` lines,
the failing row's `journalctl -u am-member-runner` tail without
secrets, the kernel and distribution, `cat /proc/sys/fs/protected_hardlinks`, the runner config and
the `id` of `runner`, `dsh` and `dsh2`. A row that prints anything else is a finding, not a pass.
