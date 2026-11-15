// Browser fixture for the Hermes bot picker: the real wizard, styles and Automagik theme,
// with a fake host in the page. Detection returns two bots, a second home (running, on 9301) and
// Atlas (stopped); nothing leaves the page and no Hermes is started.
import { createElement as h } from 'react'
import { SHELL_CSS } from '../../src/client/styles.js'
import { allThemes, themeCss } from '../../src/client/themes.js'
import { HermesRemoteConnect } from '../../src/client/hermes-remote.js'

const { createRoot } = window.nativeSeeds['react-dom/client']
const cloneHome = '/Users/someone/.local/share/clone/hermes'
const cloneLock = `${cloneHome}/.local/state/hermes/gateway-locks`

const style = document.createElement('style')
document.head.append(style)
window.setTheme = (id = 'deepseek', dark = false) => {
  style.textContent = SHELL_CSS + themeCss(allThemes()[id])
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}

const bots = [
  { home: cloneHome, id: 'default', name: 'Luna', model: 'anthropic/claude-sonnet', provider: 'anthropic', running: true, recordDir: cloneLock, port: 9301, start: `HERMES_HOME=${cloneHome} hermes serve` },
  { home: '/Users/someone/.hermes', id: 'default', name: 'Atlas', model: 'openai/gpt-5.1', provider: 'openai', running: false, recordDir: '', port: 0, start: 'hermes serve' },
]
const endpoints = {
  'hermes-remote': () => ({ enabled: false, mode: 'ssh', profile: '', profiles: [], models: [], sessions: [], minimum: '0.22.5' }),
  'hermes-remote-ssh-hosts': () => ({ aliases: [{ alias: 'sample-mac', hostname: 'sample-mac.local', user: 'someone', port: '' }], knownHosts: [] }),
  'hermes-remote-detect': () => ({ homes: [], bots }),
  'hermes-remote-test': () => ({ testId: 'shot-test', profiles: [{ id: 'default', name: 'Luna', model: 'anthropic/claude-sonnet', provider: 'anthropic', running: true }], defaultProfile: 'default' }),
  'hermes-remote-save': () => ({ enabled: true, mode: 'ssh', profile: 'default', profileName: 'Luna', models: [{ id: 'attach', name: 'anthropic/claude-sonnet (anthropic)' }], attached: true, sessions: [] }),
}
window.calls = []
window.fetch = async (_url, init) => {
  const request = JSON.parse(init.body)
  window.calls.push(request.endpoint)
  const value = endpoints[request.endpoint]?.(request.payload) ?? {}
  return { ok: true, json: async () => ({ ok: true, value }) }
}

const clickLabel = label => {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent.replace(/[→←+−]/g, '').trim() === label || node.getAttribute('aria-label') === label)
  if (!button) throw new Error(`no button ${label}`)
  button.click()
}
window.clickLabel = clickLabel

let root = null
window.mount = ({ dark = false } = {}) => {
  root?.unmount()
  window.setTheme('deepseek', dark)
  document.getElementById('root').replaceChildren()
  const host = document.createElement('div')
  host.id = 'root'
  document.body.replaceChildren(host)
  root = createRoot(host)
  root.render(h(HermesRemoteConnect, { onClose() {}, onConnected() {} }))
}
window.pickHost = () => clickLabel('Use SSH host sample-mac')
