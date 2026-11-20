# RFC 0007: Desktop speed

| Field | Value |
|---|---|
| Status | In delivery (delivery 2: #184; delivery 4 in part: #179; slice 3 measured with no gain, not built; slices 1, 5 and 6 not found) |
| Milestone | 1 (marks, stable port, toward the #141 fix); 5. The app opens fast |
| Lanes | desktop (3.N) |
| Created | 2026-10-30 |

## Summary

Measure first, then change one thing at a time. Each speed slice ships alone with a before and
after number. The changes, in order: a stable port, Node's compile cache, an early DSH start
with an async profile copy, smaller bundles, and last, keeping DSH alive when the window closes.

## Motivation

The app takes seconds to open, but almost nothing has been timed. The one number on record is an
update restart of about 18 s on a Mac. Every gain below is a hypothesis until measured. The port
also changes on every launch, which defeats the browser's caches and loses unsent drafts (#141).

## Design

### Measure

- **Marks.** The start log already marks `ready`, `dsh spawned`, `dsh ready`, `window shown`
  and `page in`. Add `team drawn` (the Bot team's first paint) and `first input` (the first
  keystroke handled in the box). Marks carry no secrets: no token, no URL with a token.
- **Plan.** Five runs per case, median and p90, on a Mac and on a Linux desktop. Cases: truly
  cold (after a reboot), warm (relaunch right after quit), and first start after an update.
  Also memory per process after one minute idle, and idle CPU over five minutes.
- **Baseline.** One run of the plan before any change, written into the delivery's PR.

### Changes

1. **Stable port.** Pick a port once per install, save it, reuse it; fall back to a free one
   when it is busy. The per-launch token stays the guard. DSH binds to 127.0.0.1 only. The
   browser's HTTP cache and code cache then work across launches, and drafts survive (#141).
2. **Node compile cache.** DSH loads thousands of modules at boot. Turn on Node's compile cache
   in a folder under Automagik's home with mode 0700, cleared when the build id changes.
3. **Early DSH start and async profile copy.** Start DSH before the window is ready, and copy
   the shipped profile after an update without blocking the main thread, so the window shows at
   once.
4. **Smaller bundles.** Minify and tree-shake the plugin bundles, move inline art and fonts out
   of JavaScript, and load the welcome's first-run code only when it is needed. Related to the
   stale bundle report (#142).
5. **Keep DSH alive across window close.** Last, with its own lifecycle section below.

### Lifecycle when DSH outlives the window

- Closing the window leaves DSH running. On macOS the app stays in the Dock; on Linux a tray
  icon shows it. Reopening is a page load from a warm server.
- **Quit.** An explicit "Quit Automagik" stops DSH. A setting turns the whole behaviour off.
- **Token.** The token rotates every time the window reopens; the old one stops working.
- **Idle shutdown.** DSH stops after a configurable idle time with no window and no running
  Bot work. Recommended default below.
- **Bot browsers.** While no window is open, Bot browsers run in launched Chrome (RFC 0002, 3d)
  or wait for the window.
- **Updates.** An update installs while the window is closed, then restarts DSH when idle.
- **Memory.** DSH holds about 300 MB while the window is closed; the setting text says so.

## Contracts introduced

- The saved port, in the desktop's own data folder. Compatibility: an install with no saved
  port picks one on first start; nothing else changes.
- The compile cache folder under Automagik's home. Compatibility: created on demand; safe to
  delete.
- The "keep running when closed" setting. Compatibility: off for existing installs until the
  owner decides the default.

## Threat model

A long-lived local server is a trust boundary.

- **Who can reach it.** Any local process can reach a loopback port. On a shared Linux or WSL
  host that includes other users. The token is the guard, so its lifetime matters.
- **Controls.** Bind to 127.0.0.1 only. Keep the per-launch token; rotate it on reopen. Never
  write the token to the start log. The compile cache folder is 0700 and owned by the user.
- **Undo.** Turn the setting off, or quit; DSH stops.

## Deliveries

All slices are desktop lane except slice 5, which changes plugin builds and rides the plugin
lane. Desktop slices go through the staging branch (RFC 0001). Each slice ships alone, with its
before and after number in the PR. Slices 1 and 2 are in milestone 1, because the stable port is
the fix for #141; the marks go first so the fix has a before number. The rest are milestone 5.

1. **Marks and baseline.** Check: the start log shows every mark on a cold and a warm start.
   Rollback: revert.
2. **Stable port.** Fixes #141. Check: a draft survives a restart; warm `page in` improves.
   Rollback: the next release picks a random port again.
3. **Compile cache.** Check: warm `dsh ready` improves; the folder is 0700. Rollback: revert;
   delete the folder. *Measured, no gain* (`docs/perf/dsh-startup-2026-11-02.md:185-194`):
   eight interleaved warm rounds, spawn to ready, Electron 44.5.0 as Node, median 1,071 ms
   without the cache and 1,198 ms with `NODE_COMPILE_CACHE` (1,767 entries written). Compiling
   is about 110 ms of DSH's boot, and the cache does not touch module resolution or file reads.
   So the check cannot pass as things stand, and the slice is not built. A later DSH pin can be
   measured again the same way before any code.
4. **Early start and async copy.** Check: `window shown` after an update no longer waits for the
   copy. Rollback: revert.
5. **Smaller bundles.** Check: bundle bytes and `team drawn` both drop. Rollback: revert.
6. **Keep DSH alive.** Check: reopen time; token rotation; idle shutdown fires. Rollback: turn
   the setting off.

## Open questions

1. **Keep DSH alive by default?** Recommended: off by default at first; on by default once the
   idle shutdown and token rotation have shipped for one release.
2. **Idle shutdown time.** Recommended: 30 minutes with no window and no Bot work.
3. **Start at login?** Recommended: not now. Revisit after slice 6 is measured.

## Links

- #141 drafts lost on origin change, #142 stale client bundle
- [0002](0002-browser-group-1-completion.md) launched-Chrome host
