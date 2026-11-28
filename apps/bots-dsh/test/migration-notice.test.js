import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'
import { indexRoster } from '../src/client/sources.js'

const { outputFiles: [bundle] } = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/client/migration-notice.js'],
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react'],
})
const maya = { id: 'maya', name: '<Maya>' }
const dev = { id: 'dev', name: 'Dev', private: true }
const notice = {
  id: 'solver-grants-v1', reason: 'A grant needs your review.',
  affected: [{ ...maya, capabilities: ['task-start', 'route-policy'] }, { ...dev, capabilities: ['audio-out'] }],
  action: { kind: 'role-settings', botId: 'maya' },
}
const recovery = { reason: 'The saved chief changed in an older app.', choices: [maya] }
const advertised = { migrationNotices: [notice], chiefRecovery: recovery }

function fixture({ owner = true, view = advertised } = {}) {
  const requests = []
  const settings = []
  let refreshed = 0
  let responding = async () => ({ ok: true, value: null })
  let roster = indexRoster({ bots: [maya, dev], rooms: [], ...view })
  const module = { exports: {} }
  let slots = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const slot = index++
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], value => { slots[slot] = value }]
    },
    useRef(initial) { return slots[index++] ??= { current: initial } },
  }
  runInNewContext(bundle.text, {
    module, require: () => react,
    fetch: async (route, options) => {
      requests.push([route, JSON.parse(options.body)])
      return { ok: true, json: responding }
    },
  })
  const { MigrationNotices } = module.exports
  const props = {
    useRoster: select => select(roster), readRoster: () => roster, isOwner: () => owner,
    after: promise => promise.then(() => { refreshed += 1 }),
    actions: { openSettings: (...args) => settings.push(args) },
  }
  const render = (node) => {
    if (Array.isArray(node)) return node.flatMap(child => render(child))
    if (typeof node?.type === 'function') return render(node.type(node.props))
    if (!node?.type) return [node]
    return [{ ...node, children: render(node.children) }]
  }
  const descendants = node => node.flatMap(child => child?.type ? [child, ...descendants(child.children)] : [])
  const tree = () => {
    index = 0
    const result = render(MigrationNotices(props))
    if (index === 0) slots = []
    return result
  }
  return {
    requests, settings, refreshed: () => refreshed,
    node: type => descendants(tree()).find(node => node.type === type),
    nodes: type => descendants(tree()).filter(node => node.type === type),
    update(fields) { roster = indexRoster({ bots: [maya, dev], rooms: [], ...fields }) },
    response(fn) { responding = fn },
    setOwner(value) { owner = value },
  }
}

const event = { preventDefault() {} }
const textOf = node => node?.children.map(child => (typeof child === 'string' ? child : '')).join('')

test('the owner sees only advertised notices and can open the named Bot’s Role settings', () => {
  const page = fixture({ view: { mainBotId: maya.id } })
  assert.equal(page.node('section'), undefined)
  page.update({ migrationNotices: [notice] })
  assert.deepEqual(page.nodes('p').map(textOf), [notice.reason])
  assert.deepEqual(page.nodes('li').map(textOf), ['<Maya> · task-start, route-policy', 'Dev · audio-out'])
  const action = page.node('button')
  assert.equal(textOf(action), 'Open Role settings for <Maya>')
  action.props.onClick()
  assert.deepEqual(page.settings, [['bots', 'maya']])
  page.setOwner(false)
  page.update(advertised)
  assert.equal(page.node('section'), undefined)
  action.props.onClick()
  assert.equal(page.settings.length, 1)
  assert.deepEqual(page.requests, [])
})

test('the chief picker submits the advertised id once and displays a refusal without hiding the picker', async () => {
  const page = fixture({ view: { chiefRecovery: recovery } })
  assert.deepEqual(page.nodes('option').map(textOf), ['Choose a Bot…', '<Maya>'])
  await page.node('form').props.onSubmit(event)
  assert.deepEqual(page.requests, [])
  page.node('select').props.onChange({ target: { value: 'maya' } })
  page.response(async () => ({ ok: false, error: { code: 'bot/refused', message: 'The lock was lost.' } }))
  const submit = page.node('form').props.onSubmit
  const pending = submit(event)
  assert.equal(page.node('select').props.disabled, true)
  await submit(event)
  await pending
  assert.deepEqual(page.requests, [['api/omni-ui', { endpoint: 'set-chief', payload: { id: 'maya' } }]])
  assert.equal(page.refreshed(), 0)
  assert.ok(page.nodes('p').some(node => node.props.role === 'alert' && textOf(node) === 'The lock was lost.'))
  page.response(async () => ({ ok: true, value: null }))
  await page.node('form').props.onSubmit(event)
  assert.equal(page.requests.length, 2)
  assert.equal(page.refreshed(), 1)
  page.update({})
  assert.equal(page.node('form'), undefined)
})

test('old, replaced, read-only and non-owner recovery views cannot send a stale selection', async () => {
  for (const next of [{}, { chiefRecovery: { ...recovery, choices: [{ id: 'new', name: 'New' }] } }, { ...advertised, readOnly: 'Another window owns the team.' }, advertised]) {
    const page = fixture()
    page.node('select').props.onChange({ target: { value: 'maya' } })
    const stale = page.node('form').props.onSubmit
    page.update(next)
    if (next === advertised) page.setOwner(false)
    if (next.readOnly) {
      assert.equal(page.node('select').props.disabled, true)
      assert.ok(page.nodes('p').some(node => textOf(node) === next.readOnly))
    }
    await stale(event)
    assert.deepEqual(page.requests, [])
  }
})

test('the migration notice and chief picker have Chinese and Brazilian Portuguese copy', () => {
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const source = readFileSync(new URL('../src/client/migration-notice.js', import.meta.url), 'utf8')
  for (const [, copy] of source.matchAll(/\bt\('([^']+)'/g)) {
    assert.ok(DICTIONARY.zh[copy], `zh: ${copy}`)
    assert.ok(pt[copy], `pt-BR: ${copy}`)
  }
})
