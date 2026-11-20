import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

// preload.cjs runs sandboxed in the page, where `require` gives only Electron's own modules: it
// is run here in a context of its own, with a fake Electron that records what it is asked.
function loadPreload({ activation }) {
  const exposed = {}
  const invoked = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } },
    ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve('answered') }, on: () => {}, off: () => {} },
  }
  const context = vm.createContext({
    require: name => { if (name === 'electron') return electron; throw new Error(`no ${name} in a sandboxed preload`) },
    process: { platform: 'darwin' },
    document: { documentElement: { dataset: {} }, addEventListener: () => {} },
    navigator: activation === undefined ? {} : { userActivation: { isActive: activation } },
    console,
  })
  vm.runInContext(readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8'), context)
  return { herdr: exposed.omniDesktop.herdr, account: exposed.omniDesktop.account, invoked }
}

test('the preload refuses open() without a click, and sends nothing to main', async () => {
  for (const activation of [undefined, false]) {
    const { herdr, invoked } = loadPreload({ activation })
    await assert.rejects(herdr.open({ botId: 'b1' }), /only on a click/)
    assert.deepEqual(invoked, [])
  }
})

test('during a click, open() sends the Bot id and nothing else; status() asks with nothing', async () => {
  const { herdr, invoked } = loadPreload({ activation: true })
  assert.equal(await herdr.open({ botId: 'b1', folder: '/etc', machine: 'vps' }), 'answered')
  await herdr.open({ botId: 42 })
  await herdr.open()
  await herdr.status()
  // The objects come from the preload's own realm: compare their JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['automagik-herdr-open', { botId: 'b1' }],
    ['automagik-herdr-open', { botId: null }],
    ['automagik-herdr-open', { botId: null }],
    ['automagik-herdr-status'],
  ])
  assert.ok(Object.isFrozen(herdr))
})

test('an answer to the update offer: only a boolean update reaches main, still only on a click', async () => {
  const { herdr, invoked } = loadPreload({ activation: true })
  await herdr.open({ botId: 'b1', update: true })
  await herdr.open({ botId: 'b1', update: false })
  await herdr.open({ botId: 'b1', update: 'yes', url: 'https://evil.example/herdr.tar.gz' })
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['automagik-herdr-open', { botId: 'b1', update: true }],
    ['automagik-herdr-open', { botId: 'b1', update: false }],
    ['automagik-herdr-open', { botId: 'b1' }],
  ])
  const idle = loadPreload({ activation: false })
  await assert.rejects(idle.herdr.open({ botId: 'b1', update: true }), /only on a click/)
  assert.deepEqual(idle.invoked, [])
})

test('the account bridge: a sign-in needs a click, and status/sign-out send nothing of the page', async () => {
  for (const activation of [undefined, false]) {
    const { account, invoked } = loadPreload({ activation })
    await assert.rejects(account.signIn(), /starts from a click/)
    assert.deepEqual(invoked, [])
  }
  const { account, invoked } = loadPreload({ activation: true })
  assert.equal(await account.signIn(), 'answered')
  assert.equal(await account.status(), 'answered')
  assert.equal(await account.signOut(), 'answered')
  assert.equal(typeof account.subscribe(() => {}), 'function')
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['automagik-account-signin'],
    ['automagik-account-status'],
    ['automagik-account-signout'],
  ])
  // Nothing the page can hand the bridge reaches main: the calls take no arguments.
  assert.equal(account.signIn.length, 0)
  assert.equal(account.status.length, 0)
  assert.equal(account.signOut.length, 0)
})
