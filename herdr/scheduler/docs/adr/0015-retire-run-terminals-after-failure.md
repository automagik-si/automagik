# ADR 0015 — retire run terminals after failure

**Status** accepted · **Date** 2026-11-27

Amends [ADR 0001](0001-cleanup-is-never-scheduled.md),
[ADR 0006](0006-occurrences-are-dropped-not-queued.md),
[ADR 0012](0012-a-successful-run-may-close-its-workspace.md) and
[ADR 0014](0014-an-automation-targets-a-bot-or-a-worker.md).

## Context

One automation left 431 agent terminals in eight days. Each was waiting at a
folder trust prompt before its first turn. The run ended, its terminal stayed
live, and the next occurrence launched another. This exhausted the terminal
limit.

## Decision

- On failure, the runner records the reason and up to 12 lines of plain-text
  terminal output in history before removing the run's terminal. The `screen`
  and `cleanup` fields remain readable through `history --json`. Missing
  output and removal errors can occur if the backend is unavailable. If the
  history write fails, removal waits for a later occurrence. Existing failure
  toasts retain their one-line reason (ADR 0007).
  History files are private to the scheduler's user.
- hc ends the terminal and removes its core record. Herdr closes the pane the
  run opened. In a shared space, removal first checks that another pane or tab
  can keep the space open. If the run has the sole pane in the last tab, a
  shell preserves that tab. An unlabelled hc terminal is treated as sharing
  its space if the automation names that workspace or other users of the
  space are present. Scheduler processes sharing the state directory
  serialize these checks per space. A person can still change the layout
  between the check and the backend call, which offers no atomic guard.
  A space created solely for the run can disappear when its pane is removed.
- Before provisioning, an occurrence reconciles earlier run terminals for its
  automation. hc can also discover orphaned terminals by their automation
  label, checking the terminal folder and any scheduler install label.
  Recovery updates the earlier run when history identifies it and
  creates a recovery record otherwise. A refusal or failed removal holds up
  provisioning until the next occurrence can reconcile it. A nonblocking
  automation lock across scheduler processes preserves dropping an occurrence
  when a scheduler is actively running it. An unavailable Herdr pane list
  records a cleanup skip in the affected runs' history and allows provisioning.
- Before the first turn, an interactive question with a selected option and a
  key hint can fail the run early if held for ten seconds within the first two
  minutes. hc also inspects a silent startup. The configured grace governs
  other blocked states. With `blocked_grace_minutes: -1`, startup dialog
  checks are disabled and only the run timeout bounds a blocked state.
- A worker target still uses the pack's checked stop on success. On failure,
  the scheduler may stop its own worker mid-turn using the core's terminal
  removal calls. The worker must match the run's launch identity, automation
  branch and worker label. A bot target uses a shared bot terminal and leaves
  its lifetime to the bot's owner.

A successful run still follows `close_workspace` when it ends. If its agent
remains live, the next occurrence reconciles it before launch. The worktree
and its files remain available to the owner. `internal/cleanup` stays manual.
