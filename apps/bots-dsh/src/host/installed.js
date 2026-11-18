// Whether a Bot of a crew kind can run here. The team saves the Bots other Automagik
// plugins make (roster.js BOT_KINDS): the Omni Bot the welcome's team step adds, Genie, and
// Unfold. The plugin that owns the kind is what actually runs the Bot, so a saved Bot whose
// plugin is missing from this DSH, or is switched off, is not an idle Bot: it is not
// installed, and every report of its status says so with the reason, so nothing routes work
// to it.
//
// The answer comes from DSH's plugin manager, which lists every bundle of the profile. A
// DSH without one is not asked, and the team answers as it always did. The list is read at
// most once per INSTALLATION_TTL_MS; the list and message tools read it on the spot.
import { BOT_KINDS } from './roster.js'

// The plugin each crew kind belongs to, by package name (the plugin ids are public: see
// docs/rfcs/0011-monorepo-parts-and-releases.md). The welcome (welcome-dsh bot-types.js)
// installs these same bundles for Omni and Genie; Unfold's own release carries its own.
export const KIND_PLUGINS = Object.freeze({
  omni: '@automagik/omni-channels-dsh',
  genie: '@automagik/genie-dsh',
  unfold: '@automagik/unfold-bot-dsh',
})

export const INSTALLATION_TTL_MS = 10_000

export function install(rt) {
  const { ctx } = rt
  // A kind with no plugin to check would quietly read as running again: refuse to start
  // instead, so adding one to BOT_KINDS without its bundle fails here and in the tests.
  for (const kind of BOT_KINDS) {
    if (!Object.hasOwn(KIND_PLUGINS, kind)) throw new Error(`ds-bot: the ${kind} Bot kind names no plugin to check`)
  }
  // Per kind, what the last read said; a kind not read yet is running.
  let states = {}
  let readAt = 0
  let reading = null
  const read = async () => {
    let rows
    try {
      rows = await ctx.get?.('pluginManager')?.listBundles?.()
    } catch {
      return null
    }
    if (!Array.isArray(rows)) return null
    return Object.fromEntries(Object.entries(KIND_PLUGINS).map(([kind, name]) => {
      const row = rows.find(entry => entry?.name === name)
      if (row === undefined || row.availability === 'missing') {
        return [kind, { installed: false, reason: `the ${name} plugin is missing from this DSH` }]
      }
      if (row.enabled === false) {
        return [kind, { installed: false, reason: `the ${name} plugin is switched off in this DSH` }]
      }
      // A bundle DSH could not load contributes nothing to the running profile.
      if (row.error !== undefined) {
        const code = typeof row.error?.code === 'string' ? ` (${row.error.code})` : ''
        return [kind, { installed: false, reason: `the ${name} plugin did not load in this DSH${code}` }]
      }
      return [kind, { installed: true }]
    }))
  }
  // `force` reads now; otherwise the last answer stands until INSTALLATION_TTL_MS has gone.
  // A read that fails keeps the last answer rather than guessing.
  const refresh = async ({ force = false } = {}) => {
    if (reading !== null) return reading
    if (!force && Date.now() - readAt < INSTALLATION_TTL_MS) return states
    reading = read()
      .then((next) => {
        if (next !== null) {
          states = next
          readAt = Date.now()
        }
        return states
      })
      .finally(() => { reading = null })
    return reading
  }
  // Synchronous, for the status lines: what the last read said, else running.
  const installationOf = (bot) => {
    const kind = bot?.kind
    return typeof kind === 'string' && Object.hasOwn(states, kind) ? states[kind] : { installed: true }
  }
  Object.assign(rt, { refreshInstallation: refresh, installationOf })
}
