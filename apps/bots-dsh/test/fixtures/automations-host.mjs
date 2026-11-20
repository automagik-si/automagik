import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { install as installAutomations } from '../../src/host/automations.js'
import { install as installChannel } from '../../src/host/channel.js'
import { install as installHooks } from '../../src/host/extend.js'
import { fakeContext } from '../fake-ctx.js'

export const WINDOW = 'ab'.repeat(32)
export const DIGEST = createHash('sha256').update(WINDOW, 'ascii').digest('hex')
export const OWNER = { principal: { kind: 'owner' } }
export const fixturePath = fileURLToPath(new URL('./fake-herdr-automations.mjs', import.meta.url))

export function automationFixture(t, listing = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omni-automations-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = join(root, 'scheduler.json')
  const log = join(root, 'calls.jsonl')
  const write = value => writeFileSync(state, JSON.stringify(value))
  const bytes = () => readFileSync(state)
  const read = () => JSON.parse(bytes())
  write({ paused: false, scheduler: 123, automations: [], invalid: [], ...listing })
  return {
    root, env: { ...process.env, HOME: root, HERDR_AUTOMATIONS: fixturePath, FAKE_AUTOMATIONS_STATE: state, FAKE_AUTOMATIONS_LOG: log },
    write, read, bytes,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  }
}

// Use the registered /api route and DSH's own shared handler so both layers admit the call.
export function automationHost(t, { root, env }, { readOnly, loginTextMatches } = {}) {
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
  const rt = {
    ctx, state: { bots: {} }, home: root, load: async () => {}, refresh: async () => {},
    readOnly: () => readOnly, warn() {}, loginTextMatches,
  }
  installHooks(rt)
  t.after(installAutomations(rt, { env }))
  installChannel(rt)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const request = (endpoint, payload, { peer = OWNER, marker = WINDOW } = {}) => handler.fetch(new Request('http://127.0.0.1/api/omni-ui', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(marker ? { 'x-automagik-window': marker } : {}) },
    body: JSON.stringify({ endpoint, payload }),
  }), peer)
  const call = async (endpoint, payload, options) => {
    const response = await request(endpoint, payload, options)
    assertOwnerResponse(response)
    return response.json()
  }
  return { request, call }
}

function assertOwnerResponse(response) {
  if (response.status !== 200) throw new Error(`Expected a dispatcher response, got HTTP ${response.status}`)
}
