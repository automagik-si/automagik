import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { versionsAnswer } from '../src/frame.js'

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
test('the frozen preload exposes force and forwards no arguments', async () => {
  const invoked = [], exposed = {}
  vm.runInNewContext(readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } },
      ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve() }, on() {}, off() {} } }),
    process: { platform: 'linux' }, document: { documentElement: { dataset: {} }, addEventListener() {} }, navigator: {},
  })
  await exposed.omniDesktop.updates.force({ url: 'ignored', reason: 'ignored' })
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [['automagik-updates-force']])
  assert.ok(Object.isFrozen(exposed.omniDesktop.updates))
})

test('force requires the page main frame on DSH origin and joins any running force', () => {
  assert.match(main, /ipcMain.handle\('automagik-updates-force', \(event\) => \{\s*if \(!draftsFrom\(event\) \|\| quitting\) return null/)
  assert.match(main, /forcing \?\?= .*forceUpdate\(forceDeps\)/)
  const expression = main.match(/const draftsFrom = ([\s\S]*?)\nipcMain.on/)[1]
  const frame = { origin: 'http://localhost:3000' }
  const page = { webContents: { mainFrame: frame } }
  const fromPage = event => event.sender === page.webContents
  const accepts = vm.runInNewContext(`(${expression})`, { page, fromPage, dshOrigin: frame.origin })
  assert.equal(accepts({ sender: page.webContents, senderFrame: frame }), true)
  assert.equal(accepts({ sender: {}, senderFrame: frame }), false)
  assert.equal(accepts({ sender: page.webContents, senderFrame: { origin: frame.origin } }), false)
  frame.origin = 'https://other.test'
  assert.equal(accepts({ sender: page.webContents, senderFrame: frame }), false)
})

test('all planned stops await preparation before stopping; force keeps a relaunch fallback', () => {
  assert.match(main, /async function prepareAndStop[\s\S]*?await keepPageDrafts\(\)[\s\S]*?await prepareRestart\([\s\S]*?laneLog\([\s\S]*?return stop\(\)/)
  for (const reason of ['app-update', 'restart', 'quit']) assert.ok(main.includes(`prepareAndStop('${reason}'`))
  assert.match(main, /await prepareAndStop\(reason\)/)
  assert.match(main, /cycleDsh\(\(\) => null, 'Restarting…', 'force'\)[\s\S]*?restartForLane/)
  assert.match(main, /force: forceState/)
  assert.match(main, /installedVersions\(laneProfile, profilePlugins\(\)\)/)
})

test('versions keep their legacy shape and sanitize all optional details', () => {
  assert.deepEqual(versionsAnswer({ app: '3.22.0', mode: 'auto' }), { app: '3.22.0', dsh: null, plugins: [], updates: true })
  const answer = versionsAnswer({ latest: { good: '3.23.0', bad: '/private/path' },
    reason: { code: 'app-line', params: { version: '3.23.1', line: '3.23', base: '3.23.0', app: 'file:///private', path: '/private' } },
    appUpdate: { version: '/private', latest: 'true' },
    force: { phase: 'failed', code: 'restart-failed', params: { version: '3.23.0', app: {} }, extra: '/private' },
  })
  assert.deepEqual(answer.latest, { good: '3.23.0' })
  assert.deepEqual(answer.reason, { code: 'app-line', params: { line: '3.23', base: '3.23.0', version: '3.23.1' } })
  assert.deepEqual(answer.appUpdate, { version: null, latest: false })
  assert.deepEqual(answer.force, { phase: 'failed', code: 'restart-failed', params: { version: '3.23.0' } })
  assert.equal(versionsAnswer({ reason: { code: 'unknown' } }).reason, null)
  assert.equal(versionsAnswer({ force: { phase: 'unknown' } }).force, null)
})
