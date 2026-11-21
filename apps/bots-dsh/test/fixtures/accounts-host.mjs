import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { install as installAccounts } from '../../src/host/accounts.js'
import { install as installChannel } from '../../src/host/channel.js'
import { install as installHooks } from '../../src/host/extend.js'
import { fakeContext } from '../fake-ctx.js'
import { DIGEST, OWNER, WINDOW } from './automations-host.mjs'

export const LIST = 'accounts-claude'
export const USE = 'accounts-claude-use'
export const SNAPSHOT = 'a'.repeat(64)
export const CANARY = 'private-accounts-test-canary'

export function accountsFixture(t, { install = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omni-accounts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const appHome = join(root, 'app-home')
  const amHome = join(root, 'am-home')
  const pack = join(appHome, 'mods/am-sidebar')
  const am = join(amHome, 'parts/automagik.am/current')
  const log = join(root, 'calls.jsonl')
  const state = join(root, 'fixture.json')
  const env = { PATH: process.env.PATH, HOME: root, HERDR_APP_HOME: `${appHome}/`, AM_HOME: amHome,
    HERDR_APP_BIN: '/bin/false', FAKE_ACCOUNTS_LOG: log, FAKE_ACCOUNTS_STATE: state }
  const answer = {
    v: 1, kind: 'accounts.here', appHome, writer: { setLogin: true, panel: 'absent', panelWrites: false, sidebarWrites: true, confirmed: false },
    versions: { pack: CANARY }, core: CANARY, codex: { home: CANARY }, exceptions: { list: [CANARY] },
    claude: {
      record: 'ok', snapshot: SNAPSHOT, selected: 'default', effective: 'default', email: 'A@example.test', state: 'eligible', slotsComplete: true,
      slots: [{ id: 'default', email: 'A@example.test', state: 'eligible', dir: null },
        { id: '2', email: 'B@example.test', state: 'eligible', dir: CANARY },
        { id: '3', email: null, state: 'not-signed-in', dir: CANARY }],
      routes: { record: { state: 'eligible', email: 'A@example.test' }, bare: { state: 'eligible', email: CANARY } },
    },
  }
  const add = (path, { version = '3.160.3', writer = true } = {}) => {
    mkdirSync(dirname(path), { recursive: true })
    cpSync(new URL('./fake-am/', import.meta.url), path, { recursive: true })
    writeFileSync(join(path, 'VERSION'), `${version}\n`)
    if (!writer) rmSync(join(path, 'accountsWrite.js'))
  }
  const respond = (control = {}) => writeFileSync(state, JSON.stringify({ answer, ...control }))
  if (install) add(pack)
  respond()
  return { root, appHome, amHome, pack, am, env, answer, add, respond,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] }
}

export function accountsHost(t, { root, env }, { readOnly, ...options } = {}) {
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send')
  process.send = () => true
  t.after(() => previousSend ? Object.defineProperty(process, 'send', previousSend) : delete process.send)
  for (const [key, value] of Object.entries({ AUTOMAGIK_APP_BROWSER: '1', AUTOMAGIK_WINDOW_DIGEST: DIGEST })) {
    const original = process.env[key]
    process.env[key] = value
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original })
  }

  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  ctx.connection.fetch.register = route => HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, route)
  const diagnostics = []
  const ownership = { generation: 1, readOnly }
  const rt = {
    ctx, state: { bots: {} }, home: root, load: async () => {}, refresh: async () => {},
    readOnly: () => ownership.readOnly, teamGeneration: () => ownership.generation,
    sameTeam: gen => gen === ownership.generation,
    noteFailure: (...args) => diagnostics.push(args), warn: (...args) => diagnostics.push(args),
  }
  installHooks(rt)
  t.after(installAccounts(rt, { env, ...options }))
  installChannel(rt)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const request = (endpoint, payload, { peer = OWNER, marker = WINDOW } = {}) => handler.fetch(new Request('http://127.0.0.1/api/omni-ui', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(marker ? { 'x-automagik-window': marker } : {}) },
    body: JSON.stringify({ endpoint, payload }),
  }), peer)
  return { request, rt, ownership, diagnostics }
}
