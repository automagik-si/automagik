// The real welcome team step and its styles. The welcome host answers inside this page.
import { createElement as h } from 'react'
import { TeamStep } from '../../../welcome-dsh/src/client/team.js'
import { STAGE_CSS } from '../../../welcome-dsh/src/client/octopus.js'
import { ONBOARD_CSS } from '../../../welcome-dsh/src/client/onboard-css.js'
import { INK_CSS } from '../../../welcome-dsh/src/client/companion-art.js'
import { CLAY_ART_CSS } from '../../../welcome-dsh/src/client/vendor/clay-art.js'
import { PRODUCT_LOCKUP_CSS } from '../../../welcome-dsh/src/client/product-lockup.js'
import { TERMINAL_CSS } from '../../../welcome-dsh/src/client/terminal.js'
import { ACP_CSS } from '../../../welcome-dsh/src/client/acp-agents.js'
import { showPower } from '../../../welcome-dsh/src/client/power-store.js'

const { createRoot } = window.nativeSeeds['react-dom/client']

window.answers = {
  state: { host: null, preload: null, teamDone: false, companionName: 'ada' },
  'bot-type': { groups: [] },
  'omni-overview': { linked: true, instances: [] },
  'genie-plugin': { ready: false, canInstall: true, install: null },
  'unfold-plugin': { ready: false, canInstall: true, install: null },
  'team-save': {},
  done: {},
}
window.calls = []
window.fetch = async (url, init) => {
  const { endpoint, payload } = JSON.parse(init.body)
  window.calls.push({ url: String(url), endpoint, payload })
  const value = window.answers[endpoint] ?? {}
  return new Response(JSON.stringify({ ok: true, value }), {
    headers: { 'content-type': 'application/json' },
  })
}

const style = document.createElement('style')
style.textContent = STAGE_CSS + ONBOARD_CSS + INK_CSS + CLAY_ART_CSS
  + PRODUCT_LOCKUP_CSS + TERMINAL_CSS + ACP_CSS
document.head.append(style)
window.setPower = (kind, phase, detail = null) => showPower(kind, phase, detail)
window.mount = ({ dark = false, preload = null } = {}) => {
  window.answers.state = { ...window.answers.state, preload }
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
  createRoot(document.getElementById('root')).render(h(TeamStep, {
    stepId: 'omni-team', complete: () => {},
  }))
}
