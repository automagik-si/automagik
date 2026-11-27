// Browser fixture for the composer's model picker (T3's layout, model-menu.js DockedPicker): the
// real ModelMenu in the composer's cell, with the real shell, theme and model styles, and a fake
// host in the page. The host keeps the Bot as roster.js does for a model, level and speed pick:
// a new model drops a speed saved for another, a speed binds to the Bot's model. Every call is
// kept in window.calls; nothing leaves the page.
import { createElement as h } from 'react'
import { SHELL_CSS } from '../../src/client/styles.js'
import { allThemes, themeCss } from '../../src/client/themes.js'
import { MODEL_CSS, ModelMenu } from '../../src/client/model-menu.js'
import { COMPOSER_PACK_CSS } from '../../src/client/composer-pack-cells.js'

const { createRoot } = window.nativeSeeds['react-dom/client']

const style = document.createElement('style')
document.head.append(style)
const setTheme = (dark) => {
  style.textContent = SHELL_CSS + themeCss(allThemes().deepseek) + MODEL_CSS + COMPOSER_PACK_CSS
    + '.fx-composer{position:fixed;left:16px;right:16px;bottom:16px;display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:8px 12px;border-radius:16px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}'
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}

const levels = (ids, defaultEffort) => ({ efforts: ids.map(id => ({ id, name: { xhigh: 'Extra High' }[id] ?? id.charAt(0).toUpperCase() + id.slice(1) })), defaultEffort })
const codex = (id, name, extra = {}) => ({ ref: `acp-codex/${id}`, id, provider: 'acp-codex', providerName: 'Codex', name, route: { connectedBy: 'acp', harness: 'codex' }, ...extra })
const claude = (id, name, extra = {}) => ({ ref: `acp-claude/${id}`, id, provider: 'acp-claude', providerName: 'Claude Code', name, route: { connectedBy: 'acp', harness: 'claude' }, ...extra })
const MODELS = [
  { ref: 'deepseek/flash', provider: 'deepseek', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'deepseek/pro', provider: 'deepseek', providerName: 'DeepSeek', name: 'DeepSeek Pro', reasoning: levels(['low', 'medium', 'high'], 'high') },
  codex('gpt-6.2-sol', 'GPT-6.2-Sol', { reasoning: levels(['low', 'medium', 'high', 'xhigh', 'max'], 'low') }),
  codex('gpt-6.2-astra', 'GPT-6.2-Astra', { reasoning: levels(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low') }),
  codex('gpt-6.1-terra', 'GPT-6.1 Terra', { reasoning: levels(['low', 'medium', 'high'], 'medium') }),
  codex('gpt-6-luna', 'GPT-6-Luna', { reasoning: levels(['low', 'medium'], 'low') }),
  claude('opus', 'Claude Opus', { reasoning: levels(['low', 'medium', 'high', 'max'], 'high') }),
  claude('sonnet', 'Claude Sonnet', { reasoning: levels(['low', 'medium', 'high'], 'medium') }),
]
// The models whose adapter offers Standard / Fast (acp-dsh's catalog, models.js speedOf).
const FAST = new Set(['acp-codex/gpt-6.2-sol', 'acp-codex/gpt-6.2-astra', 'acp-claude/opus'])

let root = null
let bot
let roster
window.calls = []
const render = () => {
  roster = { ...roster, byId: { [bot.id]: bot } }
  root.render(h('div', { className: 'fx-composer' },
    h('span', { className: 'bt-composer-model' },
      h(ModelMenu, { key: bot.id, bot, roster, actions, run: promise => Promise.resolve(promise).then(() => true, () => false), chat: true, bar: true }))))
}
// roster.js switchModel, for the fields the picker sends.
const apply = (patch) => {
  const next = { ...bot }
  if (patch.model !== undefined && patch.model !== next.model) {
    if (patch.speed === undefined) delete next.speed
    next.model = patch.model
    next.appliedModel = patch.model
  }
  if (patch.effort !== undefined) {
    if (patch.effort === null) delete next.effort
    else next.effort = patch.effort
  }
  if (patch.speed === null) delete next.speed
  else if (patch.speed !== undefined) next.speed = { model: next.model, value: patch.speed }
  bot = next
  render()
}
const actions = {
  updateBot: (id, patch) => { window.calls.push(['updateBot', patch]); apply(patch); return Promise.resolve() },
  chooseModelInChat: (id, ref, extra) => { window.calls.push(['chooseModelInChat', ref, extra]); apply({ model: ref, ...extra }); return Promise.resolve() },
  switchRouteInChat: (id, ref, extra, ...rest) => { window.calls.push(['switchRouteInChat', ref, extra, ...rest]); apply({ model: ref, ...extra }); return Promise.resolve() },
  efforts: ref => MODELS.find(model => model.ref === ref)?.reasoning ?? { efforts: [] },
  speed: ref => { window.calls.push(['speed', ref]); return { offered: FAST.has(ref) } },
  refreshModels: () => Promise.resolve(),
  turnRunning: () => window.replyRunning === true,
}

window.mount = ({ dark = false, model = 'acp-codex/gpt-6.2-astra', effort = 'high', speed, favorites, running = false } = {}) => {
  root?.unmount()
  window.replyRunning = running
  setTheme(dark)
  try {
    if (favorites === undefined) localStorage.removeItem('bt-model-favorites')
    else localStorage.setItem('bt-model-favorites', JSON.stringify(favorites))
  } catch { /* no storage: the picker keeps favorites for the menu only */ }
  window.calls = []
  bot = { id: 'b1', name: 'Ada', model, appliedModel: model, ...(effort ? { effort } : {}), ...(speed ? { speed } : {}) }
  roster = { ready: true, models: MODELS, defaultModel: 'deepseek/flash' }
  const host = document.createElement('div')
  host.id = 'root'
  document.body.replaceChildren(host)
  root = createRoot(host)
  render()
}
window.updateFromHost = apply
window.bot = () => bot
