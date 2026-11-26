# The member runner's protocol

The member runner runs one command as one member or one Bot of a space. Each has its own host uid
(RFC 0038, section 3 and delivery 3). The runner runs as its own user on the space's machine,
outside DSH's container. DSH can open the runner's socket. This file is the contract between the
runner and its client.

The runner ships inert inside am's signed tarball. Only the template's unit starts it; no am
command, installer, pack path, hook or boot path does. Members stay off.

## Transport

- One unix stream socket, mode 0660, in a folder owned by the runner, mode 0750. Its group has
  DSH's service uid as its only member, and no account has it as its primary group. Whoever can
  open the socket and pass the proof can act as any member or Bot, so the socket's mode and
  folder are the gate.
- One connection carries one proof and one request. The runner ends the connection after the last
  reply frame.
- The client waits for `ok` before it sends the request. A request sent earlier is lost.

## The proof

The runner cannot read the caller's credentials. Instead the caller proves its uid with a file:

1. The runner sends one name on the connection: 192 bits from its crypto source, used once and
   good for three seconds. It is the whole first line.
2. The caller creates an empty file of exactly that name in the proof folder, then sends any line.
3. The runner `lstat`s it and serves only if it is a regular file with one link, empty, owned by
   DSH's uid, and changed no earlier than a marker the runner touched just before sending the
   name. The runner removes the proof itself.
4. On success the runner sends `ok`. On failure it sends one line, `refused: <reason>`, and ends
   the connection. No error becomes a stack trace.

The proof folder is mode 1730: the socket group may create files there by a known name but may not
list it. The runner sweeps strays.

## Request

One JSON object on one line, ending in `\n`, at most 64 KiB, within five seconds of `ok`.

```json
{"v":2,"identity":{"kind":"bot","id":"b-abcdefghij"},"argv":["sh","-c","id -u"],"cwd":"/work/.bots/b-abcdefghij","env":{"LANG":"C.UTF-8"},"timeoutMs":60000}
```

| Field | Rule |
|---|---|
| `v` | `2` |
| `identity` | Exactly `{"kind":"member","name":"alice"}` or `{"kind":"bot","id":"b-abcdefghij"}` with the member name or Bot id |
| `argv` | 1 to 1024 strings with no NUL. The first is a nonempty program name or path and cannot start with a dash. Run as given, never through a shell |
| `cwd` | The absolute path to the identity's work area or a folder below it. It must exist at the same path on the machine and in DSH's container. The child enters it after the uid switch |
| `env` | Optional. Only `PATH`, `LANG`, `LC_ALL`, `TERM` and `TZ`. Each is a string up to 32 KiB with no NUL |
| `timeoutMs` | A whole number from 1 to the runner's cap (600000 by default) |

Any other field, type or value is refused. The runner sets `HOME`, `USER`, `LOGNAME`, `TMPDIR` and
the five `XDG_*` folders itself and never takes them from the request. `LD_PRELOAD`,
`LD_LIBRARY_PATH` and `LD_AUDIT` are never passed. Nothing else from DSH's environment reaches the
child, so no DSH token or variable does.

Version 1 still takes `member` in place of `identity`. Member names in both versions match
`[a-z0-9][a-z0-9_-]{0,63}`.

```json
{"v":1,"member":"alice","argv":["sh","-c","id -u"],"cwd":"/work/alice","env":{"LANG":"C.UTF-8"},"timeoutMs":60000}
```

Use the Bot registry id (RFC 0014). The two accepted shapes are `b-` with ten lowercase base32
characters (`a-z2-7`) and `session-` with 36 lowercase hex characters or hyphens. The runner
refuses other spellings such as `unfold-root` with `BAD_REQUEST`.

The client resolves Bot identities from trusted registry state. It refuses an unresolved Bot or
a host-pinned Session (`sessionPinned`), even if the Session id matches the registry pattern.
A Bot request uses v2. An older runner can answer `BAD_REQUEST` for the unknown `identity` field or
`BAD_VERSION`. Either answer ends the request with exit 125. The client must never retry the Bot
as a v1 member or any other identity.

## Reply frames

One JSON object per line, in order, until the connection ends.

| Frame | When |
|---|---|
| `{"t":"start","member":"alice","uid":N,"gid":N,"mode":"subuid","run":"<run>","unit":"am-member-<run>"}` | A member run reached its own uid and passed the cwd check |
| `{"t":"start","bot":"<id>","uid":N,"gid":N,"mode":"subuid","run":"<run>","unit":"am-bot-<run>"}` | A Bot run reached its own uid and passed the cwd check |
| `{"t":"out","d":"<base64>"}` / `{"t":"err","d":"<base64>"}` | A stdout or stderr chunk after `start` |
| `{"t":"exit","code":N,"signal":null,"timedOut":false,"truncated":false,"ms":N}` | Last frame of a run, after every process of it ended. `code` is null when a signal ended it. `truncated` means the output cap (8 MiB by default) was passed and the run was stopped |
| `{"t":"error","code":"<CODE>","message":"..."}` | Last frame of a refused or failed request. It can follow `start` |

Error codes: `BAD_REQUEST`, `BAD_VERSION`, `BAD_CWD`, `ENV_NOT_ALLOWED`, `TOO_LARGE`, `BUSY`,
`RANGE_FULL`, `STATE_INVALID`, `HOME_INVALID`, `SCOPE_FAILED`, `SPAWN_FAILED`, `INTERNAL`.

The guard sends a marker after the uid switch and cwd check. The runner sends `start` when it
receives that marker. A launch that ends before the marker sends an `error` frame with
`SPAWN_FAILED` or `SCOPE_FAILED`. Any further byte on the marker stream stops the run and
ends it with `error` `SPAWN_FAILED`. Every `exit` frame follows a `start` frame.

A client exits with the command's code. A signal exits 128 plus the signal number. At child
close the runner has received all marker bytes. A timed-out run with a complete marker and no
trailing bytes sends `start` and any queued output if the switch was confirmed late, then sends
`exit` with `timedOut: true` and the client exits 124. If the deadline fired and no complete marker
arrived by close, the runner sends `error` `SPAWN_FAILED` and the client exits 125. The guard must
write the complete marker before executing the payload. An `error` frame, a failed proof or a
missing socket exits 125.

## The uid mapping

- Each member and Bot maps to a stable uid in the same subordinate range. The runner keeps
  member names in `members` and Bot ids in `bots` in its mode 0600 state file. Each identity
  takes the next slot after all assigned slots. Identities never share, reuse, move or free slots.
  With no slot left, the request gets `RANGE_FULL`.
- The runner writes state v1 without a `bots` field until it records a Bot slot. That write
  produces state v2 with a `bots` field. Older runners refuse v2 before they can assign a uid.
- The runner syncs the state file and its folder before using an assignment. On load it syncs
  both again. If a write fails after the rename, new assignments are blocked until restart.
  Already durable assignments still work.
- The runner creates a missing state file only after the member and Bot folder scans pass.
  For rollback, keep the current authoritative state file with every Bot slot. An older runner
  must never start on a recreated file.
- The runner refuses to start when its own uid or DSH's uid lies inside the range, or when the
  state file was made for another range. Moving the range could expose one identity's files to another.
- One mode only: a rootless user namespace through `newuidmap`/`newgidmap`, with util-linux
  `unshare` 2.39 or later. There is no docker mode and no fallback. A run also gets its own pid
  namespace and a new network namespace with loopback only.
- Each shell runs in its own delegated systemd scope with `MemoryMax` and `TasksMax` from the
  configuration. When the scope cannot be made, the shell is refused, never run unlimited.
- At startup the runner probes `systemd-run --help`. A failed probe refuses startup with
  `TOOL_MISSING`. When help advertises `--expand-environment`, the runner passes
  `--expand-environment=no`. Older systemd versions with a successful probe and no such option
  leave the scope's command line unchanged.
- The child sets `no_new_privs` and keeps no capability. The manager applies each shell's memory
  and task limits.

## Homes

Members use `<homesRoot>/<name>` for HOME and `<workRoot>/<name>` for their work area. Bots use
`<homesRoot>/.bots/<id>` and `<workRoot>/.bots/<id>`. The Bot root is `<workRoot>/.bots`, at the
same path on the machine and in DSH's container. Each `.bots` folder belongs to the runner and is
mode 0711. Member names start with a letter or digit, so they cannot collide with `.bots`.

The identity owns its HOME and work area, both mode 0700. The five XDG folders and TMPDIR sit under
HOME and have the same owner and mode. The runner creates and opens each folder without following
symlinks. It sets the owner and mode through the open handle. Every shell start checks the owner,
mode and path again.

Each command starts inside its own work area. Keep DSH's state outside the work root.

## Configuration

The runner is started only as:

    node <am store>/runner/main.mjs --config <file>

The config file is JSON, owned by the runner or root, and not writable by group or others. It names:

- `socket`: the socket path;
- `proofs`: the proof folder;
- `group`: the socket group's name;
- `dshUid`: DSH's service uid;
- `workRoot`: the member and Bot work root, at the same path in DSH's container;
- `homesRoot`: the member and Bot homes root;
- `state`: the identity-to-slot state file;
- `uidStart`, `uidCount`, `gidStart`, `gidCount`: the subordinate range;
- `limits`: `{ "memoryMax": "2G", "tasksMax": 256 }`;
- `maxTimeoutMs`, `maxOutputBytes`, `maxConcurrent`.

The parents of these paths must exist; the runner makes the socket folder, the proof folder, the
homes root, work root and their `.bots` folders when they are missing. The other parents must
already exist.

## What the runner refuses at start

One line on stderr, `member-runner: refused to start: <reason>`, and exit 125, when any of these
holds:

- it runs as root, or not on Linux;
- a folder from the socket folder or the proof folder up to `/` is a symbolic link or is writable
  by group or others;
- the socket folder is not the runner's, not mode 0750, or not in the socket group;
- the proof folder is not the runner's, not mode 1730, or not in the socket group;
- the socket path exists and is not the runner's socket;
- DSH's uid is not exactly one local account, has a login shell, has a password in a readable
  shadow file, is uid 0 or the runner's own uid, or is in `sudo`, `admin` or `wheel`;
- the socket group is missing, has any member but DSH, or is anyone's primary group;
- the config file is missing, not a regular file, not the runner's or root's, or writable by
  group or others;
- the member range is empty, starts below 1000, overflows, the gid range is smaller than the uid
  range, or the range holds the runner's own uid or DSH's uid;
- the state file is unreadable, writable by group or others, malformed, of an unknown version,
  made for another range, or cannot be synced with its folder;
- the resolved homes and work roots are equal or either is inside the other, or two of the four
  roots (the homes and work roots and their `.bots` folders) are one folder by device and inode,
  as a bind mount can show it at two paths;
- the socket folder is the homes or work root's `.bots` folder or inside one;
- the homes root or the work root is not the runner's or sits under a folder writable by group or
  others;
- either `.bots` folder is a symlink, is not a folder, belongs to another uid, or is writable by
  group or others;
- a member or Bot folder has no recorded uid, is not a real folder, or belongs to the wrong uid;
- two identities share a slot;
- `unshare` is older than 2.39 or a tool the runner needs is missing.

## For the template

- Use one live runner per state file and subordinate range during normal operation, upgrades,
  rollback and recovery. Stop the old runner fully before starting another. The runner does not
  lock the state itself.
- Install am as the runner's own user, out of DSH's write reach, and start this file from that
  store. The runner's binary, state and homes stay outside DSH's reach; DSH gets only the socket
  folder.
- The runner's unit gives it the socket group as a supplementary group, so the runner can make the
  socket folder, the socket and the proof folder in that group. It must not make the runner a
  member of the group in the group database.
- The unit must not set `NoNewPrivileges`: it breaks the setuid `newuidmap`/`newgidmap` that a
  member's user namespace needs. The runner sets `no_new_privs` on each child instead.
- Each shell's scope is delegated. Give the runner user a working user manager and runtime folder
  (`XDG_RUNTIME_DIR`) so `systemd-run --user --scope` can make it; with no scope, no shell runs.
- The template checks as root what the runner cannot: DSH's account has no `sudoers` entry and
  cannot reach the runner's store, state, homes or unit.
- The subordinate range comes from the runner user's `/etc/subuid` and `/etc/subgid` lines; the
  template passes it in the config.
- The runner never sets up its unit itself, and am never starts it.
