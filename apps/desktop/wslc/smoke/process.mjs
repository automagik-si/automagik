// What a running DSH looks like in the guest, for the smoke's stop checks.
//
// startDsh now starts DSH through the bundled-pnpm launcher (src/dsh-launch.cjs): the launcher
// process imports the pinned entry, whose path travels in AUTOMAGIK_DSH_ENTRY rather than on a
// command line. The process the guest lists is the launcher's; matching the entry (or the smoke
// fake's) path would report a live DSH as stopped.

/** The launcher path in the image: what `pgrep -f` finds while DSH runs. */
export const DSH_LAUNCHER = '/opt/automagik/dsh-launch/dsh-launch.cjs'

/**
 * Whether the guest still runs the launcher that hosts DSH. `guest.ok` runs a command in the
 * container as the smoke's Guest does; a test can pass a stand-in over a process list.
 */
export function dshRunning(guest, launcher = DSH_LAUNCHER) {
  return guest.ok('pgrep', '-f', launcher)
}
