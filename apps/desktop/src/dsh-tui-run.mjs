// One dsh-TUI action for the desktop app (#561), in a child Node process. The app spawns this
// file with Electron's own binary as Node (ELECTRON_RUN_AS_NODE), so `dsh plugin add` and pnpm
// never block the window. It imports the shared installer (am/dshTui.mjs) from
// AUTOMAGIK_DSH_TUI_MODULE and prints one JSON line for src/dsh-tui.js; it writes nothing else.
//
// The PATH it gives the module is the one Herdr panes get (the shared module's panePathOf), not
// the app's own launch PATH. The account's login shell from the OS stands in when the app was
// started without SHELL. DSH's home is the person's own: $DSH_HOME when the app has one, else
// the user's DSH home.
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeInheritedSockets } from './close-inherited.cjs'

closeInheritedSockets()
const action = process.argv[2]
const answer = async () => {
  if (!['doctor', 'install', 'update', 'uninstall'].includes(action)) {
    return { error: `dsh-tui needs doctor, install, update or uninstall, not "${action ?? ''}"` }
  }
  const dir = process.env.AUTOMAGIK_DSH_TUI_MODULE
  if (!dir) return { error: 'AUTOMAGIK_DSH_TUI_MODULE is not set' }
  const mod = await import(pathToFileURL(join(dir, 'dshTui.mjs')).href)
  const shell = process.env.SHELL?.trim() || userInfo().shell || '/bin/sh'
  const base = { ...process.env, SHELL: shell }
  const pane = mod.panePathOf({ env: base })
  // The doctor sees both PATHs (the pane's and this process's, for its own fix line); an install
  // uses the pane's, because the shim and Herdr's panes will.
  const env = { ...base, PATH: pane.path || base.PATH }
  let result
  if (action === 'doctor') {
    result = mod.doctorDshTui({ env: base, panePath: pane })
    result.skip = mod.findDsh(env) ? null : mod.SKIP
  } else if (action === 'uninstall') {
    result = mod.uninstallDshTui({ env })
  } else {
    // The CLI's own test hook, so a desktop test never reaches the registry (cmdDshTui).
    const asked = Object.hasOwn(env, 'AUTOMAGIK_HERDR_DSH_TUI_PUBLISHED')
      ? (env.AUTOMAGIK_HERDR_DSH_TUI_PUBLISHED || null) : undefined
    const extra = asked === undefined ? {} : { publishedAt: asked }
    result = await mod.installDshTui({ env, ...extra })
  }
  return {
    action,
    pane,
    pin: mod.PIN,
    profile: mod.PROFILE,
    presence: mod.dshTuiPresence({ env }),
    result,
  }
}

try {
  process.stdout.write(JSON.stringify(await answer()))
} catch (error) {
  process.stdout.write(JSON.stringify({ action, error: String(error?.message ?? error) }))
}
