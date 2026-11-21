// New › Start an existing Bot (RFC 0030 delivery 6a), without React: what the menu lists and how
// an outcome reads. code-start-menu.js draws them.
import { t } from './i18n.js'

/** The outcome words the host answers, and the store's own `read-only`, as the page says them. */
const OUTCOME_TEXT = {
  started: name => t('{name} started.', { name }),
  'already-running': name => t('{name} is already running.', { name }),
  pending: () => t('Still starting. The tree updates when it is up.'),
  busy: () => t('Another start is running. Try again in a moment.'),
  'desktop-only': () => t('Start Bots from the Automagik app on this computer.'),
  'read-only': () => t('This team is read only here.'),
  invalid: () => t('This Bot is not on this computer.'),
  'not-this-computer': () => t('This Bot is not on this computer.'),
  'global-bot': () => t('A Bot with no folder can’t be started from here yet.'),
  'folder-missing': () => t('This Bot’s folder is missing.'),
  'ambiguous-clone': () => t('This Bot is listed in more than one folder. Start it with am start in the folder you mean.'),
  'not-in-roster': () => t('This Bot isn’t in its project’s Herdr team file, so am can’t start it.'),
  unverified: () => t('This Bot’s project file can’t be checked from here. Start it with am start in a terminal.'),
  'not-startable': () => t('This Bot can’t start yet. Check it with am show.'),
  'held-elsewhere': () => t('This Bot already has a seat elsewhere, or another start is placing it.'),
  'no-core': () => t('herdr-core isn’t running on this computer.'),
  'update-am': () => t('Update am to start Bots from here: am update.'),
  'no-cli': () => t('am isn’t installed on this computer.'),
  'start-failed': () => t('The start failed. Run am start in a terminal to see why.'),
  unknown: () => t('The start’s result is unknown. The tree was read again.'),
}

/** One outcome as the page says it; an unknown word reads as an unknown result. */
export const startOutcomeText = (outcome, name) => (OUTCOME_TEXT[outcome] ?? OUTCOME_TEXT.unknown)(name)

/**
 * What the menu lists: per project, its not-running Bots with the reason one cannot start (or
 * null). Running Bots are left out; the global group comes last.
 */
export function startChoices(tree) {
  const groups = []
  const core = tree?.machine?.core ?? null
  for (const project of tree?.projects ?? []) {
    const global = project.global === true
    const bots = (project.bots ?? []).filter(bot => bot.status === 'not-running')
      .map(bot => ({
        id: bot.id, name: bot.name, folder: global ? null : project.folder, launch: global ? null : project.launch ?? null, core,
        // Only a row the host checked may start; a row with no answer is not one.
        blocked: global ? 'global-bot' : bot.blocked === undefined ? 'unverified' : bot.blocked,
      }))
    if (bots.length === 0) continue
    groups.push({ key: global ? 'global' : project.folder, global, name: project.name, folder: project.folder, launch: project.launch ?? null, bots })
  }
  return [...groups.filter(group => !group.global), ...groups.filter(group => group.global)]
}
