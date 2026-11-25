# agy 1.5.16 prompt screens (RFC 0042 delivery 0)

Captured on Linux on 2026-11-24 from an interactive `agy` 1.5.16 in a 40x120 pseudo-terminal
(TERM=xterm-256color), each a new folder outside any git tree. Each file is the screen as a
terminal shows it (cursor moves and erases applied), sanitized: the folders are `/work/project`
and `/work/outside`, the account is `<EMAIL>` and its subscription tier `<TIER>`.

- `folder-trust.txt`: `agy` with no flags in an untrusted folder, waiting at the folder-trust question.
- `file-access.txt`: asked to read a file outside the workspace, waiting at "Allow access to this file?".
- `no-prompt-pack-flags.txt`: the pack's launch flags (`--dangerously-skip-permissions --mode auto
  --settings <file>` with `trustedWorkspaces`), the same request: no prompt.
- `trust-answered-idle.txt`: the folder-trust question answered, agy idle at its input line.
