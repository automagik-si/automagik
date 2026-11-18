// The app's name, and the names its installed identity is filed under. Builds up to 3.11.x
// kept Omni's (ai.namastex.omni.desktop, ~/.omni/desktop, "Omni", omni-desktop); this one is
// Automagik's throughout, and an install of one of those is replaced by a fresh install:
//   appId ai.namastex.automagik     macOS updates (Squirrel takes only the same id and signer),
//                                   TCC permissions, preferences
//   ~/.automagik/desktop            the app's own home (dsh.js appHome): profile, Bots, link
//   userData under "Automagik"      Electron's window data: the page's storage, cookies, each
//                                   Bot browser's partition, the single-instance lock
//   Linux: automagik                the executable, the desktop entry id, the deb package
//                                   (electron-builder.yml, package.json desktopName)
// The pin below keeps userData on this name whatever Electron derives from the app's. Pure
// Node: main.js applies it, tests read it without Electron.
import { join } from 'node:path'

/** What the app is called wherever a person sees it. */
export const PRODUCT = 'Automagik'

/** The name the app's Electron data is filed under. */
export const DATA_NAME = 'Automagik'

/**
 * Where Electron keeps the window's data, given `app.getPath('appData')`: the folder the app
 * used as Omni (~/Library/Application Support/Omni, ~/.config/Omni). sessionData (the page's
 * storage and cookies, the Bot browsers' partitions) is in it, as Electron's default has it.
 */
export function dataPathsOf(appData) {
  const userData = join(appData, DATA_NAME)
  return { userData, sessionData: userData }
}
