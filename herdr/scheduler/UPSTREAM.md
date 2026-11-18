# Upstream: herdr-automations

The scheduler that fires the automations the pack's panel edits is vendored here from
[DnzzL/herdr-automations](https://github.com/DnzzL/herdr-automations) (MIT, © 2026 Thomas Legrand;
its notice is upstream's `LICENSE`, kept here as `LICENSE` and repeated in `LICENSE-upstream` under
the pack's naming convention). The folder is upstream's tarball, byte for byte, apart from the
excluded paths below and the fork's patch listed under Local changes. `go.mod` keeps upstream's
module path, `github.com/DnzzL/herdr-automations`.

This is not a herdr mod: there is no `mods/` or `main.js` here. The panel stays
`herdr/mods/am-automations`; this folder is the Go binary the panel and the automations run on.

- **Tag:** `v0.12.1`
- **Commit:** `900b4f258f5c1c3a42e13b9115c0df80782f2f4c` (short `900b4f25`)
- **Date:** 2026-11-04 (the commit is dated 2026-11-04T21:01:12Z)

## Excluded upstream paths

```
app/
herdr-automations
docs/*.gif
docs/*.png
.github/
```

- `app/` — upstream's own herdr mod (`app/mods/automations`, its preview and RECIPE). In this
  repository it would show up as a second `herdr-mod` entry; the panel is `herdr/mods/am-automations`.
- `herdr-automations` — the binary upstream commits at its root. Our binary is built by
  `.github/workflows/scheduler-release.yml` and attached to its own release, never committed.
- `docs/*.gif`, `docs/*.png` — the demo recordings and screenshots; they are not source.
- `.github/` — upstream's CI and release workflows. This repository's CI owns our builds.

Every other path is upstream's, byte for byte, except the fork's patch under Local changes. This
folder also adds two files that are not upstream's, which the check script below knows: `UPSTREAM.md`
(this note) and `LICENSE-upstream` (a copy of the tarball's `LICENSE`, checked against it; `LICENSE`
itself stays where upstream puts it).

## Local changes

The fork's patch, one line per path: the check script allows exactly these to differ (or, for a new
file, to be here) and prints each as patched or added; any other difference fails.

```
docs/adr/0012-a-successful-run-may-close-its-workspace.md — patched: existing mode closes its own tab; blocked grace
docs/adr/0013-a-command-is-a-run-the-scheduler-does-itself.md — added: why a run may be a plain command (#938)
automations.example.yaml       — patched: a command entry
CHANGELOG.md                   — patched: the command kind, under Unreleased
CONTEXT.md                     — patched: work has three kinds; command, result line, report
internal/api/api.go            — patched: ls --json carries blocked_grace_minutes, kinds, command and notify; history a command run's result
internal/api/api_test.go       — patched: the listing carries blocked_grace_minutes and its default; kinds, a command entry, a command run
internal/cleanup/cleanup.go    — patched: a command entry has no repo to scan
internal/command/command.go    — added: runs a command, its exit status, last lines, timeout and shutdown (#938)
internal/command/command_test.go — added: exit 0, other exits, signal, timeout and its group, start failure, cleaned lines, shutdown
internal/config/config.go      — patched: blocked_grace_minutes, its default and range; existing mode may close its tab; a new automation's default agent args; command and notify
internal/config/config_test.go — patched: the grace defaults, -1, and existing + on-success load; command entries that load and that do not
internal/config/edit_test.go   — patched: put's merge cases for blocked_grace_minutes; existing + on-success accepted
internal/daemon/daemon.go      — patched: a daemon told to stop ends its running commands first
internal/daemon/daemon_test.go — patched: the stop ends a running command and waits for its record
internal/hc/hc.go              — patched: hc read, the blocked run's screen; live terminals by label; hc send
internal/history/history.go    — patched: a command run's exit code, result line, stderr and report
internal/notify/bot.go         — added: a result line to a bot, by its label, through hc send (#938)
internal/notify/bot_test.go    — added: label lookup, the terminal-name fallback, an undelivered report
internal/runner/runner.go      — patched: a command run skips the host; true status, then the report
skills/creating-automations/SKILL.md — patched: the command entry
internal/herdr/herdr.go        — patched: tab id/list/close; pane process-info for a blocked agent's stop request
internal/herdr/herdr_test.go   — patched: tab and pane process-info wire cases
internal/host/agent.go         — patched: herdr blocked grace, rechecked stop; deadline and paced bounded submit retries; only idle or done ends a run done
internal/host/agent_test.go    — patched: herdr blocked/blips/-1; submit mismatch deadline, attempt limit and pacing; error and unknown status rows
internal/host/close.go         — added: read and close serialized per workspace within one scheduler process
internal/host/close_test.go    — added: concurrent closes on two tabs leave the last visible tab
internal/host/hc.go            — patched: blocked/close/status fixes; Codex --no-daemon (#929)
internal/host/hc_test.go       — patched: blocked/close/status rows; hc launch arguments (#929)
internal/host/host.go          — patched: Session carries the run's tab; existing mode asks only for a tab a read says is listed and not last
internal/host/host_test.go     — patched: own-tab close, last tab, unlisted tab, unreadable list, race row, worktree/root unchanged
internal/host/ops.go           — patched: tab operations and rechecked AgentStop result in the seam
internal/host/stop_unix.go     — added: recheck status and foreground group before SIGTERM request
internal/host/stop_unix_test.go — added: status/group changes, unchanged target, read errors and refusals
internal/host/stop_resume_unix_test.go — added: cleared dialog before signal resumes startup/submit/wait
internal/host/stop_other.go    — added: unsupported platform stop reports an error
internal/host/screen.go        — added: the dialog line read from a blocked screen
internal/host/screen_test.go   — added: dialog line, control characters, the bound and the fallback
internal/runner/runner_test.go — patched: the blocked failure's notice; existing mode's default; command runs and their reports
main.go                        — patched: put copies blocked_grace_minutes, command and notify into the entry; put gives a new automation the form's default agent args, never a command; list and history show a command
main_test.go                   — added: the put wire path carries blocked_grace_minutes; existing + on-success accepted; put and a form save write the same file; a command and its bot
README.md                      — patched: blocked_grace_minutes, and existing mode's own-tab close; run a plain command
```

Issue #929 (Refs #498): direct Codex launches under `backend: hc` add `--no-daemon` unless
already supplied, so execution stays associated with the run's terminal. Permission flags, model,
MCP config, explicit arguments and prompt keep their order and values. The 6 Nov automation
permission ruling remains unchanged. Templates still forward exactly their name and task to hc:
hc supplies the template's command and instructions, including its runtime flags. This patch
does not read or rewrite local templates; template commands must supply `--no-daemon` themselves.
The fake-hc regressions cover default, automatic and custom Codex launches, template forwarding,
and unchanged non-Codex launches. Delivery requires a separate scheduler binary release because
scheduler source is `NEVER_SHIPPED` in the monorepo lane.

Why: the #498 stopgap, two scheduler changes. An agent that stays `blocked` on a
dialog longer than `blocked_grace_minutes` on either agent backend (default 2,
`-1` waits for completion or the timeout) now fails at once. The history error carries the
dialog line from the screen and the failure goes out through notify. On hc the
terminal is killed without removing its record. Herdr has no agent-stop API:
the scheduler re-reads the agent status and `pane process-info` before requesting
SIGTERM for an unchanged foreground group, refusing a missing, shell, or scheduler
group. A cleared dialog resumes the run without a blocked failure. The failure
error and log say "asked the agent to stop (SIGTERM)"; exit is not confirmed and
SIGTERM is not escalated, so a TERM-ignoring dialog can survive. Refused or failed
requests are reported as such. The read/signal window is narrowed, not atomic.
Neither failure path asks to close its layout.
Herdr prompt retries check the run deadline before every submit and wait one
status-poll interval between submissions. Three consecutive blocked-submit errors
without an observed blocked status fail with a clear error; the run deadline can
expire sooner. This mismatch does not request a signal.

`close_workspace: on-success` is valid with `workspace: existing`: it asks to
close only the tab the run opened, and closes nothing when the run has no tab id,
when the space's tabs cannot be read, when its tab is no longer listed, or when
that tab is the space's last one at the time of the check. In one scheduler process,
closes serialize per workspace (and Herdr session) and re-read under the lock
immediately before acting: it leaves the last tab it can see. A person closing
the other tabs between the read and the close can still leave it last, and the
app then closes the space. The lock is process-local: a manual `run` or a second
daemon does not share it and can race the same way. The scheduler issues no
space close itself in existing mode; on hc, where a terminal is the tab, it ends
the run's terminal only while another one is there at that read. Each refusal logs
why. The loader no longer refuses that combination, and `ls --json` / `put` carry
`blocked_grace_minutes` like the other keys.

Issue #938, the run status and `put`. A run's status is written in one place,
`runner.Run`, from what the host's `Do` returns; the panel and the board only show
it. Three verdicts were wrong on hc and one on Herdr:

- Listed `failed` with the work finished (hc): `done` was accepted only after a turn
  count or a wait that caught the agent working, so a turn shorter than one wait, or
  an agent that reports no turn count, ended as "never started working". `done` is
  the agent's own word and is now enough. `idle` still needs one of the two, since an
  agent is idle before it reads its prompt.
- Listed `failed` with the work finished (hc): a program that ended on its own with
  exit code 0 was "exited with code 0 before finishing". Exit 0 is now `done` when
  the program never reported a status (a plain program, a template's script), or its
  last word was `done`, or `idle` after its turn. An agent that exits 0 while
  `working` or `blocked`, or `idle` before any work, was quit and still fails, as does
  any other code, or none; a killed terminal is still `cancelled`.
- Listed `done` with no work (hc): `blocked` counted as proof the prompt landed, so a
  dialog before the first turn followed by `idle` was a finished run. Only `working`
  or a turn count is that proof now.
- Listed `done` with the work failed (Herdr): any status but `working` after a wait
  that returned was a finished run. Only `idle` or `done` is; `error` fails at once,
  and any other word (`unknown`) is waited out and named if the timeout comes first.

What the scheduler still cannot read is whether a finished turn did its task: an
agent that ends its turn having given up reports `done` like any other.

`put` gives a new automation the form's automatic mode when the request sends no
`agent_args` key (`config.DefaultAgentArgs`: codex and claude; no other agent, no
template, no workflow, no command). A sent key stands, an empty one included, and an edit
(`--original`) keeps the entry's own args as before. The table is the panel's
`AUTO_ARGS`; `herdr/test/fixtures/automation-put-parity.json` holds the two equal
(the panel's test checks the form's side, `main_test.go` that both write one file).

The command kind (#938, ADR 0013): an automation may name `command:` (argv, a working folder,
env) instead of a prompt or a workflow. The daemon starts the program itself, as its own user, with
no pane and no model, bounded by `timeout_minutes` (SIGTERM to its process group, SIGKILL after ten seconds if anything in the
group is left; a daemon told to stop ends its commands the same way). Exit 0 is `done`; any other exit, a signal, the
timeout or a program that would not start is `failed`, with the exit code, the last lines of stderr
and a one-line result in history. `notify: <bot>` sends that line to the terminal labelled
`bot=<id>` (else a terminal by that name) through `hc send`; what became of the report is recorded
after the status and never changes it. `ls --json` names the kinds a build runs (`kinds`), and
carries `command` and `notify` like the other keys; `put` writes them with the same merge rules.

The earlier patch is still why `close_workspace` exists in the API at all: the pack's
panel sets it per automation (issue #498). `ls --json` names it for every entry, and
`put` accepts it with the same merge rules as the other keys: a value writes it, a
request without the key keeps the hand-written value, an empty value removes the key.
An invalid value is refused by the loader. Keep the patch to this list.

## Refreshing

1. Put the new tarball in a scratch folder (`.cache/` is gitignored and outside the comparison):

   ```sh
   mkdir -p .cache/upstream-v0.12.1
   gh api repos/DnzzL/herdr-automations/tarball/v0.12.1 > .cache/upstream-v0.12.1.tar.gz
   tar -xzf .cache/upstream-v0.12.1.tar.gz -C .cache/upstream-v0.12.1 --strip-components=1
   ```

2. Replace the copy, leaving the excluded paths out. This overwrites the local changes above: re-apply
   them after (or restore your copies), and update the list when the patch changes:

   ```sh
   tar -C .cache/upstream-v0.12.1 -cf - \
     --exclude='./app' --exclude='./herdr-automations' \
     --exclude='./docs/*.gif' --exclude='./docs/*.png' --exclude='./.github' . \
     | tar -C herdr/scheduler -xf -
   ```

3. Prove it. The script downloads that tag's tarball into a temp folder, compares every path the
   exclusion list leaves in, checks `LICENSE-upstream` against the tarball's `LICENSE`, and prints
   the local changes it allowed as patched or added:

   ```sh
   node herdr/scripts/scheduler-upstream.mjs --tag v0.12.1 --dir herdr/scheduler
   ```

   It prints each differing, missing or extra path and exits 1 on any difference; exit 0 means the
   copy is byte-identical to upstream minus the exclusions, with only the Local changes above
   differing.

4. Update the tag, commit and date above, the Local changes list and the entry in `herdr/NOTICE`.
   No lane change is
   needed: `scripts/lane.ts` lists `herdr/scheduler/` in `NEVER_SHIPPED`, so a scheduler refresh
   cuts no release of its own (the binary ships from its own release lane).
