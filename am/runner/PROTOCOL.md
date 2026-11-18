# The member runner's protocol

The member runner runs one shell as one member of a space, under that member's own host uid. It
runs on the space's machine, outside DSH's container, as its own user. DSH holds no privilege: it
can open the runner's socket and nothing else. This file is the contract between the runner and
the client that reaches it.

The runner ships inert inside am's signed tarball. Only the template's unit starts it; no am
command, installer, pack path, hook or boot path does. Members stay off.

## Transport

- One unix stream socket, mode 0660, in a folder owned by the runner, mode 0750. Its group has
  DSH's service uid as its only member, and no account has it as its primary group. Whoever can
  open the socket can act as any member, so the socket's mode and folder are the gate.
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
{"v":1,"member":"alice","argv":["sh","-c","id -u"],"cwd":"/work/members/alice","env":{"LANG":"C.UTF-8"},"timeoutMs":60000}
```

| Field | Rule |
|---|---|
| `v` | `1` |
| `member` | `[a-z0-9][a-z0-9_-]{0,63}`: a name, never a uid, a path or a mode |
| `argv` | 1 to 1024 strings, no NUL; the first is the program, is not empty and does not begin with a dash. Run as given, never through a shell |
| `cwd` | An absolute path inside this member's own part of the members' work area, which must exist at the same path on the machine and in DSH's container. The child enters it after the uid switch |
| `env` | Optional. Only `PATH`, `LANG`, `LC_ALL`, `TERM` and `TZ`; each a string up to 32 KiB, no NUL |
| `timeoutMs` | A whole number from 1 to the runner's cap (600000 by default) |

Any other field, type or value is refused. The runner sets `HOME`, `USER`, `LOGNAME`, `TMPDIR` and
the five `XDG_*` folders itself and never takes them from the request. `LD_PRELOAD`,
`LD_LIBRARY_PATH` and `LD_AUDIT` are never passed. Nothing else from DSH's environment reaches the
child, so no DSH token or variable does.

## Reply frames

One JSON object per line, in order, until the connection ends.

| Frame | When |
|---|---|
| `{"t":"start","member":"alice","uid":N,"gid":N,"mode":"subuid","run":"<id>","unit":"<unit>"}` | The shell process was started. An `error` after it means the run failed and its code is not the shell's |
| `{"t":"out","d":"<base64>"}` / `{"t":"err","d":"<base64>"}` | A stdout or stderr chunk |
| `{"t":"exit","code":N,"signal":null,"timedOut":false,"truncated":false,"ms":N}` | Last frame of a run, after every process of it ended. `code` is null when a signal ended it. `truncated` means the output cap (8 MiB by default) was passed and the run was stopped |
| `{"t":"error","code":"<CODE>","message":"..."}` | Last frame of a refused or failed request |

Error codes: `BAD_REQUEST`, `BAD_VERSION`, `BAD_CWD`, `ENV_NOT_ALLOWED`, `TOO_LARGE`, `BUSY`,
`RANGE_FULL`, `HOME_INVALID`, `SCOPE_FAILED`, `SPAWN_FAILED`, `INTERNAL`.

A client exits with the member's code; a signal exits 128 plus the signal number; a timeout exits
124; any `error` frame, a connection that fails the proof, or a missing socket exits 125.

## The uid mapping

- One member maps to one stable uid in the runner user's subordinate range. The mapping lives in a
  runner-owned state file, mode 0600. A new member takes the next uid; a slot is never reused,
  moved or freed. With no slot left the request is refused with `RANGE_FULL`.
- An assignment is used only after it is written to the state file and synced, and after the
  state folder's own sync. A write failure refuses the request and hands out no uid. On start the
  runner refuses a state file with two members on one slot, a member folder with no recorded uid,
  and a folder whose owner is not its recorded uid.
- The runner refuses to start when its own uid or DSH's uid lies inside the range, or when the
  state file was made for another range: moving a range would put members onto each other's files.
- One mode only: a rootless user namespace through `newuidmap`/`newgidmap`, with util-linux
  `unshare` 2.39 or later. There is no docker mode and no fallback. A run also gets its own pid
  namespace and a new network namespace with loopback only.
- Each shell runs in its own delegated systemd scope with `MemoryMax` and `TasksMax` from the
  configuration. When the scope cannot be made, the shell is refused, never run unlimited.
- The child sets `no_new_privs` and keeps no capability. The manager applies each shell's memory
  and task limits.

## Homes

Each member's `HOME` is its own folder, owned by that member's uid, mode 0700, never a shared
folder. `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`
and `TMPDIR` all sit under it, each mode 0700 and owned by the member.

The runner makes these folders itself, through handles it opened: it creates a folder, opens it
with no symlink following, and sets its owner and mode through that handle. An existing folder is
checked and refused when it is not the member's own 0700 folder, and a path swapped for a link
between create and change is refused. Every shell start checks the whole set again (owner, mode,
path, or a symbolic link where a folder belongs).

The member's work area is the same-path root's `<root>/<member>`, owned by the member, mode 0700.
Only that area is in reach: the root is the members' work area, never all of DSH's data folder.
DSH's state stays outside it.

## Configuration

The runner is started only as:

    node <am store>/runner/main.mjs --config <file>

The config file is JSON, owned by the runner or root, and not writable by group or others. It names:

- `socket`: the socket path;
- `proofs`: the proof folder;
- `group`: the socket group's name;
- `dshUid`: DSH's service uid;
- `workRoot`: the members' work area, at the same path in DSH's container;
- `homesRoot`: the per-member homes' root;
- `state`: the member-to-uid state file;
- `uidStart`, `uidCount`, `gidStart`, `gidCount`: the subordinate range;
- `limits`: `{ "memoryMax": "2G", "tasksMax": 256 }`;
- `maxTimeoutMs`, `maxOutputBytes`, `maxConcurrent`.

The parents of these paths must exist; the runner makes the socket folder, the proof folder, the
homes root and the work root when they are missing, but never their parents.

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
- the state file is unreadable, malformed, or was made for another range;
- the homes root or the work root is not the runner's or sits under a folder writable by group or
  others;
- a member folder has no recorded uid, two members share a slot, or a folder's owner is not its
  recorded uid;
- `unshare` is older than 2.39 or a tool the runner needs is missing.

## For the template

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
