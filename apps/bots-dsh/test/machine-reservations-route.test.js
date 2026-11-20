import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { apply } from '../index.js'
import { RESERVATION_FILE } from '../src/host/account-reservations.js'
import { fill, MACHINE_MESSAGES } from '../src/shared/machine-reservations.js'
import { fakeContext } from './fake-ctx.js'
import { CLAUDE, CLAUDE_ACCOUNT, CODEX, reservationAcp } from './fixtures/account-reservations.js'

const label = 'Project X'
const refusal = fill(MACHINE_MESSAGES.refused, { label })
const owner = { kind: 'owner' }

function reservationFetch(route) {
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() },
    route)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  return (endpoint, payload, principal = owner) => handler.fetch(
    new Request('http://localhost/api/omni-ui', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    }), { principal },
  )
}

function envFor(name, value) {
  const previous = process.env[name]
  process.env[name] = value
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

async function fixture(t, { configured = true, mode = 'isolated', evidenceVersion = 2 } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'automagik-reservation-route-'))
  const folder = join(root, 'records')
  const key = Buffer.alloc(32, 29)
  function setup() {
    fs.mkdirSync(folder)
    fs.chmodSync(folder, 0o3770)
    fs.writeFileSync(join(folder, 'key'), key)
    fs.chmodSync(join(folder, 'key'), 0o640)
  }
  if (configured) setup()
  const hosts = []
  t.after(async () => {
    for (const host of hosts) await host.ctx.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  })
  async function host(name, options) {
    const home = join(root, name)
    fs.mkdirSync(home)
    const auth = reservationAcp(options)
    const ctx = fakeContext({ services: { acpAgents: auth.service } })
    let route
    const register = ctx.connection.fetch.register
    ctx.connection.fetch.register = options => {
      if (options.path === '/api/omni-ui') route = options
      return register(options)
    }
    apply(ctx, { home })
    const rt = ctx.provided.get('omniTeam')
    const check = rt.machineReservations
    // Start reads finish before setting the per-call instance identity.
    await rt.load()
    await check.idle()
    const fetch = reservationFetch(route)
    async function call(endpoint, payload, principal) {
      const response = await fetch(endpoint, payload, principal)
      if (response.status === 403) return { response, result: await response.text() }
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return { response, result: await response.json() }
    }
    const get = async (endpoint, payload) => {
      const { result } = await call(endpoint, payload)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    }
    const card = async (provider = CLAUDE) => (
      await get('cli-login-accounts', { reservations: true })
    ).accounts[provider]
    const reserve = async (name, provider = CLAUDE) => get('cli-login-reserve', {
      ...(await card(provider)).reservation.offer, label: name,
    })
    const local = join(home, RESERVATION_FILE)
    const localClaims = () => Object.values(JSON.parse(fs.readFileSync(local)).claims)
    const turn = async (sessionId = 'bot-session') => {
      rt.isBotSession = () => true
      rt.modelAccess = async () => ({ ready: true })
      const items = []
      const handlers = ctx.listeners.get('llm/stream')
      const stream = handlers.find(handler => String(handler).includes('authenticateAgentStream'))
      for await (const item of stream({ provider: CLAUDE, model: 'default', sessionId },
        async function* () { yield 'next' })) items.push(item)
      for (const listener of ctx.listeners.get('session/event')) {
        // Release the storage-independent reservation lifecycle listener.
        if (String(listener).includes('check.turnEnded')) listener({ id: sessionId }, {
          type: 'turn/end',
        })
      }
      return items
    }
    const result = { ...auth, ctx, rt, check, card, call, get, reserve, local, localClaims, turn }
    hosts.push(result)
    return result
  }
  const restoreFolder = envFor('AUTOMAGIK_RESERVATIONS_DIR', folder)
  let x, y
  try {
    x = await host('x', { evidenceVersion })
    y = await host('y', { evidenceVersion, authScope: mode })
  } finally { restoreFolder() }
  let running
  async function as(host, id, work) {
    assert.equal(running, undefined, 'host calls must not overlap during identity changes')
    await (host === x ? y : x).check.idle()
    const restoreFolder = envFor('AUTOMAGIK_RESERVATIONS_DIR', folder)
    const restoreInstance = envFor('AUTOMAGIK_INSTANCE_ID', id)
    running = host
    try { return await work() } finally {
      await host.check.idle()
      running = undefined
      restoreInstance()
      restoreFolder()
    }
  }
  const files = () => fs.existsSync(folder) ? fs.readdirSync(folder).filter(name =>
    name.endsWith('.json')).map(name => join(folder, name)) : []
  const machineClaim = () => JSON.parse(fs.readFileSync(files()[0], 'utf8'))
  return { x, y, as, setup, files, machineClaim, folder, key }
}

test('C1/C2/C4/C11 both hosts see one machine claim, guarded logout, then release', async t => {
  const h = await fixture(t)
  const own = await h.as(h.x, 'X', async () => {
    await h.x.reserve(label)
    assert.equal(h.files().length, 1)
    assert.equal(h.machineClaim().instance, 'X')
    assert.equal(h.machineClaim().label, label)
    assert.equal(fs.existsSync(h.x.local), false)
    const { machine } = await h.x.card()
    assert.equal(machine.state, 'mine')
    assert.equal(machine.claims[0].current, true)
    assert.equal(machine.claims[0].owner, userInfo().username)
    return machine.claims[0]
  })
  await h.as(h.y, 'Y', () => h.y.ctx.emit('acp-dsh/login-ready', { id: CLAUDE }))
  await h.as(h.y, 'Y', async () => {
    const [call] = h.y.calls.filter(([method]) => method === 'signout')
    assert.equal(call[1], CLAUDE)
    assert.equal(typeof call[2].expect.recheck, 'function')
    const { machine } = await h.y.card()
    assert.deepEqual(machine, {
      state: 'refused', label, owner: userInfo().username, signedOut: true, claims: [],
    })
    assert.equal((await h.y.turn())[0].reason.failure.message, refusal)
  })
  await h.as(h.x, 'X', () => h.x.get('cli-login-release', { machineId: own.machineId }))
  assert.deepEqual(h.files(), [])
  await h.as(h.y, 'Y', async () => {
    h.y.accounts[CLAUDE] = { ...CLAUDE_ACCOUNT }
    h.y.ctx.emit('acp-dsh/login-ready', { id: CLAUDE })
    assert.deepEqual(await h.y.turn(), ['next'])
  })
})

test('C3 another installation cannot reserve the same account in consent mode', async t => {
  const h = await fixture(t, { mode: 'consent' })
  await h.as(h.x, 'X', () => h.x.reserve(label))
  await h.as(h.y, 'Y', async () => {
    const offer = (await h.y.card()).reservation.offer
    const { result } = await h.y.call('cli-login-reserve', { ...offer, label: 'Project Y' })
    assert.equal(result.error.code, 'bot/reservation-conflict')
    assert.equal(result.error.message, fill(MACHINE_MESSAGES.conflict, { label }))
    assert.equal(h.machineClaim().label, label)
  })
})

test('C4b the card and next Bot turn see a release without a login-ready event', async t => {
  const h = await fixture(t, { mode: 'consent' })
  const machineId = await h.as(h.x, 'X', async () => {
    await h.x.reserve(label)
    return (await h.x.card()).machine.claims[0].machineId
  })
  await h.as(h.y, 'Y', async () => {
    assert.equal((await h.y.card()).machine.state, 'refused')
    assert.equal((await h.y.turn())[0].reason.failure.message, refusal)
  })
  await h.as(h.x, 'X', () => h.x.get('cli-login-release', { machineId }))
  await h.as(h.y, 'Y', async () => {
    assert.equal((await h.y.card()).machine.state, 'shared')
    assert.deepEqual(await h.y.turn(), ['next'])
  })
})

test('C5/C6 a local claim promotes when ready, while a conflict leaves it intact', async t => {
  for (const conflict of [false, true]) {
    const h = await fixture(t, { configured: false, mode: 'consent' })
    await h.as(h.x, 'X', async () => {
      const saved = await h.x.reserve(label)
      assert.equal(saved.claims.length, 1)
      const { machine } = await h.x.card()
      assert.equal(machine.notice, 'absent')
      assert.deepEqual(h.files(), [])
    })
    h.setup()
    if (conflict) await h.as(h.y, 'Y', () => h.y.reserve('Project Y'))
    await h.as(h.x, 'X', async () => {
      const { machine, reservation } = await h.x.card()
      assert.equal(h.files().length, 1)
      if (conflict) {
        assert.equal(h.machineClaim().label, 'Project Y')
        assert.equal(h.x.localClaims()[0].label, label)
        assert.equal(reservation.claims[0].label, label)
        assert.equal(machine.state, 'refused')
      } else {
        assert.equal(h.machineClaim().label, label)
        assert.deepEqual(h.x.localClaims(), [])
        assert.deepEqual(reservation.claims, [])
        assert.equal(machine.claims[0].label, label)
      }
    })
  }
})

test('C7 viewer and read-only mutations refuse before touching the machine folder', async t => {
  const h = await fixture(t)
  const machineId = await h.as(h.x, 'X', async () => {
    await h.x.reserve(label)
    return (await h.x.card()).machine.claims[0].machineId
  })
  const path = h.files()[0]
  t.mock.method(h.x.rt.machineRecord, 'open', () => assert.fail('accessed disk'))
  const blocked = await h.x.call('cli-login-release', { machineId },
    { kind: 'shared', shareKey: 'view-token' })
  assert.equal(blocked.response.status, 403)
  h.x.rt.readOnly = () => 'This house is open elsewhere.'
  const readOnly = await h.x.call('cli-login-release', { machineId })
  assert.equal(readOnly.result.error.code, 'bot/read-only')
  assert.doesNotMatch(JSON.stringify([blocked.result, readOnly.result]),
    new RegExp(`${h.key.toString('hex')}|${h.machineClaim().exact}|${h.machineClaim().loose}`))
  assert.equal(h.files()[0], path)
})

test('C8 older ACP refuses machine writes and its evidence still drives the check', async t => {
  const h = await fixture(t, { evidenceVersion: 1 })
  await h.as(h.x, 'X', async () => {
    const card = await h.x.card()
    assert.equal(card.machine.state, 'shared')
    const { result } = await h.x.call('cli-login-reserve', { ...card.reservation.offer, label })
    assert.equal(result.error.code, 'bot/reservation-unsupported')
    assert.deepEqual(h.files(), [])
  })
})

test('C9 release removes a hidden local remnant before the promoted machine claim', async t => {
  const h = await fixture(t, { configured: false })
  await h.as(h.x, 'X', () => h.x.reserve(label))
  h.setup()
  await h.as(h.x, 'X', async () => {
    const rename = fs.renameSync
    let fail = true
    const mocked = t.mock.method(fs, 'renameSync', (previous, next) => {
      if (fail && next === h.x.local) throw Object.assign(new Error('fault'), { code: 'EIO' })
      rename(previous, next)
    })
    try {
      const { machine, reservation } = await h.x.card()
      assert.equal(h.x.localClaims().length, 1)
      assert.equal(h.files().length, 1)
      assert.deepEqual(reservation.claims, [])
      const [{ machineId }] = machine.claims
      const blocked = await h.x.call('cli-login-release', { machineId })
      assert.equal(blocked.result.error.message, 'The reservation could not be saved. Try again.')
      assert.equal(h.files().length, 1)
      fail = false
      await h.x.get('cli-login-release', { machineId })
      assert.deepEqual(h.x.localClaims(), [])
      assert.deepEqual(h.files(), [])
      assert.deepEqual((await h.x.card()).machine.claims, [])
      assert.deepEqual(h.files(), [])
    } finally { mocked.mock.restore() }
  })
})

test('C10 machineId rename changes only the label in the parsed Codex record', async t => {
  const h = await fixture(t)
  await h.as(h.x, 'X', async () => {
    await h.x.reserve(label, CODEX)
    const { reservation, machine } = await h.x.card(CODEX)
    const before = h.machineClaim()
    const stat = fs.statSync(h.files()[0])
    const [{ machineId }] = machine.claims
    await h.x.get('cli-login-reserve', { ...reservation.offer, label: 'Renamed', machineId })
    assert.deepEqual(h.machineClaim(), { ...before, label: 'Renamed' })
    // The mandated temp-then-rename publishes a replacement inode.
    assert.notEqual(fs.statSync(h.files()[0]).ino, stat.ino)
    assert.equal((await h.x.card(CODEX)).machine.claims[0].label, 'Renamed')
  })
})
