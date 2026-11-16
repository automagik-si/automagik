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
usermod -aG dshsock dsh
useradd --system --no-create-home --shell /usr/sbin/nologin --user-group runner

RUNNER_UID=$(id -u runner); DSH_UID=$(id -u dsh); DSH2_UID=$(id -u dsh2)
GROUP_GID=$(getent group dshsock | cut -d: -f3)
S=$B/sock/runner.sock; P=$B/proofs; W=$B/work

# The runner's own folder: passable, not writable by anyone else.
install -d -m 0711 -o runner -g runner "$B"

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

`client.mjs` is the runner's own protocol, enough to send one request (or one bad proof). Save it
as `$B/client.mjs`, `chmod 0755`, and run it as the uid under test. It prints decoded output, the
frames and exits 125 on a refusal, 124 on a timeout, else the member's code.

```js
import { closeSync, openSync, writeFileSync, symlinkSync, linkSync } from 'node:fs'
import { connect } from 'node:net'
const [sock, proofs, member, cwd, attack = 'none', ...argv] = process.argv.slice(2)
const conn = connect(sock)
let buf = ''
let stage = 'name'
conn.setEncoding('utf8')
conn.on('error', (e) => { console.error(`client: ${e.code}`); process.exit(125) })
conn.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (stage === 'name') {
      stage = 'proof'
      const file = attack === 'wrong-name' ? `${line}x` : `${proofs}/${line}`
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
      conn.write(JSON.stringify({ v: 1, member, argv, cwd, timeoutMs: 60000 }) + '\n')
    } else {
      const frame = JSON.parse(line)
      if (frame.t === 'out' || frame.t === 'err') {
        process.stdout.write(Buffer.from(frame.d, 'base64'))
      } else if (frame.t === 'error') {
        console.error(`runner refused ${frame.code}: ${frame.message}`); process.exitCode = 125
      } else if (frame.t === 'exit') {
        if (frame.code !== null) process.exitCode = frame.code
        else if (frame.timedOut) process.exitCode = 124
        else process.exitCode = 128 + 9
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
| 8 | outsider | `setpriv --reuid outsider --regid outsider -- node $B/client.mjs $S $P alice $W/alice none sh -c 'id -u'` | `client: EACCES` (or `EPERM`), exit 125 |
| 9 | dsh | row 2, attack `symlink` | `refused: the proof is not a regular file`, 125 |
| 10 | dsh2 | row 2, attack `hardlink:$B/hard-target` (a file dsh owns) | link denied, or `refused: the proof has more than one link`, 125 |
| 11 | dsh | row 2, attack `wrong-name` | `refused: no proof file`, 125 |
| 12 | dsh | row 2, attack `silent` | `refused: no proof in time`, 125 |
| 13 | dsh | row 2, attack `late` | `refused: no proof in time`, 125 |
| 14 | dsh | row 2, attack `nonempty` | `refused: the proof is not empty`, 125 |
| 15 | outsider | `ls $B/proofs; touch $B/proofs/x` | both denied |
| 16 | dsh2 | `ls $B/proofs` | denied (group has no read) |
| 17 | dsh | `echo canary > $B/owner-canary; chmod 600 $B/owner-canary`, then row 2 with `sh -c 'cat $B/owner-canary'` | `Permission denied`; dsh reads it itself |
| 18 | dsh | row 2 as A plants `$HOME/.npmrc`, then as B `sh -c 'cat $B/homes/alice/.npmrc'` | `Permission denied`, even with the path known |
| 19 | dsh | row 2, `sh -c 'p=$(cut -d: -f3 /proc/self/cgroup); cat /sys/fs/cgroup$p/memory.max /sys/fs/cgroup$p/tasks.max'` | `536870912` and `128` |
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

## What to send back

The printed line of each row, the failing row's `journalctl -u am-member-runner` tail without
secrets, the kernel and distribution, `cat /proc/sys/fs/protected_hardlinks`, the runner config and
the `id` of `runner`, `dsh` and `dsh2`. A row that prints anything else is a finding, not a pass.
