// The one rule for what a copy of the app from before `check` (v3.120.0) may be asked to do.
//
// That app has only `open`, and its `open` puts staged plugins in at once, with DSH restarted,
// never asking whether an agent is at work (#1029). Auto-apply does not change that: it only says
// whether the app goes ahead by itself or waits for the person, and either way `open` restarts
// DSH there and then. So that app is not asked to update while it says plugins are staged (in
// the plugins' own part, or the whole marked as the plugins'), while they are still coming (they
// are staged a moment later, perhaps before the click is heard), or before it has said anything.
// What is left: a page reads what the app last said, so plugins staged since are not seen.
//
// About's Check for updates and the sidebar's update pills are the two controls that would ask
// it, directly or through `applyPlugins`. Both read this one rule, so the hold cannot drift.
const PLUGINS_COMING = new Set(['ready', 'downloading'])

/** Whether the app sends its own update apart from the plugins'. */
export const splitsPlugins = state => Boolean(state?.app && state?.plugins)

/** Whether asking this app to update would put staged plugins in now, or it has not said. */
export function opensIntoPlugins(bridge, state) {
  if (!bridge || typeof bridge.check === 'function') return false
  if (state == null) return true
  if (!splitsPlugins(state)) return false
  return PLUGINS_COMING.has(state.plugins.phase) || (state.kind === 'plugins' && PLUGINS_COMING.has(state.phase))
}
