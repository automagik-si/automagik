import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { agentView } from '../src/host/acp.js'
import { fakeLocale } from './fake-locale.js'

const bundle = await build({
  stdin: {
    contents: "export { agentLines, useAcp } from './src/client/acp-agents.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react'],
})

function client() {
  const slots = []
  let index = 0
  const react = {
    useState(initial) {
      const slot = index++
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], next => { slots[slot] = next(slots[slot]) }]
    },
    useRef: current => ({ current }),
    useCallback: fn => fn,
    useEffect() {},
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, require: () => react })
  const ui = module.exports
  const locale = fakeLocale()
  locale.addLanguage({ id: 'pt-BR', fallback: 'en' })
  ui.installLocale(locale)
  const render = () => {
    index = 0
    return ui.useAcp(() => assert.fail('login should only open the chat'), { open: () => false })
  }
  return { ui, locale, render }
}

const row = (key, name, extra = {}) => agentView({
  key, name, id: `acp-${key}`, signedIn: false, on: true, cli: { found: true }, connector: { state: 'ready' }, ...extra,
})

for (const [key, name, command] of [['claude', 'Claude Code', 'claude auth login'], ['codex', 'Codex', 'codex login']]) {
  test(`isolated ${name} needs a Bot chat for sign-in in English and pt-BR`, () => {
    const { ui, locale, render } = client()
    const agent = row(key, name, { authScope: 'isolated' })
    assert.equal(agent.authScope, 'isolated')
    for (const [lang, signedOut, noChat] of [
      ['en', `Not signed in to ${name}. Sign in from a Bot's chat.`, 'Sign-in needs a Bot chat. If you have no Bot yet, set one up first.'],
      ['pt-BR', `Sem login no ${name}. Entre pelo chat de um Bot.`, 'Para entrar, você precisa de um chat de Bot. Se ainda não tiver um Bot, configure um primeiro.'],
    ]) {
      locale.setLocale(lang)
      const lines = ui.agentLines(agent)
      assert.equal(lines.find(line => line.action === 'login')?.text, signedOut)
      assert.equal(lines.some(line => line.text.includes(command)), false)
      assert.equal(render().login(agent), false)
      assert.equal(render().problems[agent.id], noChat)
    }
  })

  test(`${name} on a host without authScope still offers the terminal`, () => {
    const { ui, render } = client()
    const agent = row(key, name)
    assert.equal('authScope' in agent, false)
    assert.equal(ui.agentLines(agent).find(line => line.action === 'check')?.text, `Or run ${command} in a terminal, then check again.`)
    assert.equal(render().login(agent), false)
    assert.equal(render().problems[agent.id], `No Bot chat to sign in from here. Run ${command} in a terminal instead.`)
  })
}

test('a native agent still names its own terminal command', () => {
  const { ui, render } = client()
  const agent = row('omp', 'omp', { authScope: 'isolated', connector: { state: 'ready', native: true }, cli: { found: true, signInHint: 'omp login' } })
  const lines = ui.agentLines(agent)
  assert.equal(lines.find(line => line.action === 'check')?.text, 'Not signed in to omp. Run omp login in a terminal, then check again.')
  assert.equal(lines.some(line => line.action === 'login'), false)
  assert.equal(render().login(agent), false)
  assert.equal(render().problems[agent.id], 'No Bot chat to sign in from here. Run omp login in a terminal instead.')
})
