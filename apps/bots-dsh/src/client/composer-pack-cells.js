import { createElement as h } from 'react'
import { composerPacks, useEntries } from './extend.js'
import { ModelMenu } from './model-menu.js'
import { cellChoice, packFor, targetOf } from './composer-packs.js'

// The composer's model cell under a pack that offers it (every Bot with a model gets one):
// Omni's own model and thinking menu, which names the model this Bot runs on and saves to
// this Bot alone, like the one in its details. The menu is keyed by the Bot, so nothing of
// one conversation's menu carries into the next. DSH's own picker stays out, since it moves
// the Session without the Bot knowing. `env` carries the registrants of
// the composer's cells, for packs that depend on another plugin being there.
export function packModelCell(env) {
  return function PackModelCell({ sessionId, useRoster, actions }) {
    const roster = useRoster(value => value)
    const packs = useEntries(composerPacks)
    const target = targetOf(roster, sessionId)
    const pack = packFor(target, { packs, env })
    if (cellChoice(pack, 'model', target) !== 'model') return null
    const run = promise => Promise.resolve(promise)
      .then(() => true)
      .catch((failure) => { actions?.reportError?.(failure, 'composer-model'); return false })
    return h('span', { className: 'bt-composer-model', 'data-pack': pack.id },
      h(ModelMenu, { key: target.bot.id, bot: target.bot, roster, actions, run, chat: true, bar: true, running: sessionId === target.bot.sessionId }))
  }
}

// Fits the menu's trigger into the composer's tool row. The name and level always show:
// DSH's compact switch (--dsh-composer-model-text-display) measures its control row, which a
// Bot's composer flattens (display:contents), so it would always hide them. Instead the
// trailing group may shrink, and a long name ends in an ellipsis.
export const COMPOSER_PACK_CSS = `
.bt-composer-model{display:inline-flex;min-width:0;order:1!important}
[data-composer-card] .bt-mic{order:2!important}
[data-composer-card] .bt-voice{order:3!important}
.bt-composer-model .bt-model-trigger{min-height:30px;padding:2px 6px 2px 8px;background:transparent}
.bt-composer-model .bt-model-bar-trigger{background:transparent!important;padding:2px 4px;min-height:30px;gap:6px}
.bt-composer-model .bt-model-bar-trigger:hover,.bt-composer-model .bt-model-bar-trigger[aria-expanded=true]{background:transparent!important}
.bt-model-bar{display:inline-flex;align-items:center;gap:5px;min-width:0}
.bt-model-bar-route{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;color:var(--bt-ink-2)}
.bt-model-bar-name{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-model-bar-effort{font-size:12px;line-height:18px;font-weight:400;color:var(--bt-ink-3);white-space:nowrap}
.bt-model-bar-trigger .bt-model-caret{color:var(--bt-ink-3)}
[data-composer-card] [class*="_trailing"]:has(>[class*="_standardControls"]:not([hidden]) .bt-composer-model),[data-composer-card] [class*="_standardControls"]:has(.bt-composer-model){flex:0 1 auto!important;min-width:0!important}
`
