// Automagik's own apps, added on top of the upstream connector catalog. This file is the
// overlay: catalog.js belongs to upstream and is never edited to carry these rows, so an
// upstream sync merges cleanly. The Apps page draws this list first, under "Automagik
// official", and then the upstream categories unchanged.
//
// Plain data, no install behavior. `id` is what the page and the install state will refer
// to, `mark` names the client drawing to show, and `kind` says what installing it means
// later (`agent` is one of the team's Bots, `acp` a coding agent through ACP).

export const OFFICIAL_APPS = Object.freeze([
  Object.freeze({
    id: 'omni',
    name: 'Omni',
    kind: 'agent',
    mark: 'omni',
    about: 'The Main Bot: your team, channels, and memory',
  }),
  Object.freeze({
    id: 'genie',
    name: 'Genie',
    kind: 'agent',
    mark: 'genie',
    about: 'Plans, works, and reports on wishes',
  }),
  Object.freeze({
    id: 'claude',
    name: 'Claude',
    kind: 'acp',
    mark: 'claude',
    about: 'Claude Code through the Agent Client Protocol',
  }),
  Object.freeze({
    id: 'codex',
    name: 'Codex',
    kind: 'acp',
    mark: 'codex',
    about: 'OpenAI Codex through the Agent Client Protocol',
  }),
])

// The ids only this overlay owns: a real catalog id may never be shadowed, and a sync that
// brings one of these upstream is a collision to resolve here, not in catalog.js.
export const OFFICIAL_IDS = Object.freeze(OFFICIAL_APPS.map(app => app.id))
