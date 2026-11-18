// The app's name, and the names its installed identity is filed under. Builds up to 3.11.x
// kept Omni's (ai.namastex.omni.desktop, ~/.omni/desktop, "Omni", omni-desktop); this one is
// Automagik's throughout, and an install of one of those is replaced by a fresh install:
//   appId ai.namastex.automagik     macOS updates (Squirrel takes only the same id and signer),
//                                   TCC permissions, preferences
//   ~/.automagik/desktop            the app's own home (dsh.js appHome): profile, Bots, link
//   userData under "Automagik"      Electron's window data: the page's storage, cookies, each
//                                   Bot browser's partition, the single-instance lock; a team
//                                   launch moves all of it with AUTOMAGIK_USER_DATA (below)
//   Linux: automagik                the executable, the desktop entry id, the deb package
//                                   (electron-builder.yml, package.json desktopName)
// The pin below files userData under this name whatever Electron derives from the app's — or,
// with AUTOMAGIK_USER_DATA, in a team's own folder. Pure Node: main.js applies it, tests read it
// without Electron.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** What the app is called wherever a person sees it. */
export const PRODUCT = 'Automagik'

/** The name the app's Electron data is filed under. */
export const DATA_NAME = 'Automagik'

// A leading `~` in a launch setting, as a shell writes it (dsh.js expands AUTOMAGIK_HOME the same).
const expandHome = text => (text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text)

/**
 * Where Electron keeps the window's data, given `app.getPath('appData')`: the folder the app
 * used as Omni (~/Library/Application Support/Omni, ~/.config/Omni). sessionData (the page's
 * storage and cookies, the Bot browsers' partitions) is in it, as Electron's default has it.
 *
 * `teamFolder` is the launch setting AUTOMAGIK_USER_DATA: when it names a folder, appData,
 * userData and sessionData all go there, and so does the single-instance lock Electron keeps in
 * userData. Blank (the default) is the app's own folder under appData, exactly as before.
 */
export function dataPathsOf(appData, teamFolder = '') {
  const chosen = typeof teamFolder === 'string' ? teamFolder.trim() : ''
  if (chosen === '') {
    const userData = join(appData, DATA_NAME)
    return { userData, sessionData: userData }
  }
  const folder = resolve(expandHome(chosen))
  return { appData: folder, userData: folder, sessionData: folder }
}

/**
 * Point an Electron `app` at dataPathsOf before anything reads a path: setPath refuses a folder
 * that is not there, so a team home is made first. Returns the paths it set.
 */
export function setDataPaths(app, teamFolder = '') {
  const paths = dataPathsOf(app.getPath('appData'), teamFolder)
  if (paths.appData) mkdirSync(paths.appData, { recursive: true })
  for (const [name, path] of Object.entries(paths)) app.setPath(name, path)
  return paths
}
