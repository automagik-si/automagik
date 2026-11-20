import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { all, textOf } from '../../../test/gpui-stub.mjs'

// Herdr's calls stay inside the fixture. Finding Node uses the bridge's recorded path.
const source = String.raw`
  let status
  export const setStatus = value => { status = value }
  export const home = () => '/home/ada'
  export const appHome = () => home() + '/app'
  const root = appHome() + '/mods/pocket-link'
  const node = home() + '/bin/node'
  export const readTextFile = async path => path === root + '/.node' ? node : null
  export async function exec(path, args) {
    if (path !== node) throw new Error('Unexpected executable')
    if (args[0] === '--version') return { code: 0, stdout: 'v22.15.0\n' }
    if (args[0] !== root + '/bridge/bridge.mjs' || args[1] !== 'status') {
      throw new Error('Unexpected bridge command')
    }
    return { code: 0, stdout: JSON.stringify(status) + '\n' }
  }
  export const theme = () => ({ dim: 'dim' })
  export const props = () => ({})
  export const notify = () => {}
  export const closeOverlay = () => {}
  export const watchFolder = () => new Promise(() => {})
`
const herdr = new URL(`data:text/javascript,${encodeURIComponent(source)}`)
const gpui = new URL('../../../test/gpui-stub.mjs', import.meta.url)
const stubs = { herdr, 'gpui-kit': gpui, 'gpui-base': gpui }
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return Object.hasOwn(stubs, specifier)
      ? { url: stubs[specifier].href, shortCircuit: true } : next(specifier, context)
  },
})
const { default: PocketLink } = await import('../main.js')
hooks.deregister()
const { setStatus } = await import(herdr.href)

const label = 'Computer key fingerprint'
const digits = '4f1c 9a07 de21'
const phoneDigits = '6d35 626d c129'

async function draw(extra = {}) {
  setStatus({
    running: true, fingerprint: digits, state: '/home/ada/state',
    devices: [{ name: 'ada', id: '6d35626dc129', fingerprint: phoneDigits }], ...extra,
  })
  const ready = Promise.withResolvers()
  const cx = {
    focus_handle: () => ({}),
    spawn: fn => fn(cx).catch(ready.reject),
    timer: { every() {} },
    notify: ready.resolve,
  }
  const view = new PocketLink()
  view.init({}, cx)
  // The folder watch stays open. The first redraw is enough to render the status.
  await ready.promise
  assert.equal(view.status?.running, extra.running ?? true)
  return view.render()
}

test('the on card shows the desktop fingerprint and keeps its digits visible', async () => {
  const tree = await draw()
  assert.match(textOf(tree), new RegExp(phoneDigits))
  const row = all(tree).find(node => node.kind === 'h_flex'
    && textOf(node.kids[0]) === label)
  assert.ok(row)
  assert.equal(textOf(row), `${label} ${digits}`)
  assert.deepEqual(row.kids[0].__node.calls, [['truncate']])
  assert.deepEqual(row.kids[1].__node.calls, [['flex_none']])
})

test('the off card hides the desktop fingerprint even if status still has digits', async () => {
  const text = textOf(await draw({ running: false }))
  assert.ok(!text.includes(label))
  assert.ok(!text.includes(digits))
})

test('the on card hides the desktop fingerprint while the key is changing', async () => {
  const text = textOf(await draw({ fingerprint: null }))
  assert.ok(!text.includes(label))
})
