// An update installs while the person is away, as RTH's does, so a restart is never waited for:
// once it is downloaded, the app looks every minute, and restarts into it when the computer
// has had no input for AWAY_MS, the window is not in front, and dsh's welcome says no agent is
// at work (welcome-dsh src/host/busy.js). A busy file that is missing or unreadable is an
// older welcome, or a dsh that is not up: the update then waits for a quit or Restart. Pure:
// main.js passes what it read.
// Since #859 the app no longer restarts into its own update by itself: main.js does not call
// awayInstall, and a downloaded update waits for the person's Restart or a quit. The rule stays
// here, with its tests; readBusy and LOOK_EVERY_MS still serve the plugins (auto-apply.js).
import { readFileSync } from 'node:fs'

export const AWAY_MS = 15 * 60 * 1000
export const LOOK_EVERY_MS = 60 * 1000

/** The welcome's busy file ({ running, at }), or null when there is none to trust. */
export function readBusy(file, read = readFileSync) {
  try {
    const busy = JSON.parse(read(file, 'utf8'))
    return busy?.untrusted !== true && Number.isInteger(busy?.running) && busy.running >= 0 ? busy : null
  } catch {
    return null
  }
}

/** 'install' when the update may go in now, else what it waits for. */
export function awayInstall({ ready, idleMs, focused, busy }) {
  if (!ready) return 'no update'
  if (focused) return 'window in front'
  if (!(idleMs >= AWAY_MS)) return 'person here'
  if (busy === null) return 'busy unknown'
  if (busy.running > 0) return 'agents at work'
  return 'install'
}
