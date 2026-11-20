import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const MAIN = 'primary-fixture'
const MEMBER = 'member-fixture'
const CHAT = 'member-current'
const EARLIER = 'member-earlier'
const GROUP = 'member-group'
const NAME = 'VAULT_FIXTURE'
const SECOND = 'SECOND_VAULT_FIXTURE'
const TYPED = 'TYPED_FIXTURE'
const VALUE = 'planted-value-3124'
const RETAINED = 'planted-dual-value-4213'
const COMMAND = 'fixture-command "two words"\n  second-line'
const PURPOSE = 'Use the fixture'
const REFERENCE = { provider: 'bitwarden', item: 'item-fixture-325', field: 'field-fixture-532', connection: 'connection-fixture-253' }
const MAPPING = { ...REFERENCE, scope: [MEMBER], purpose: 'Mapped fixture' }
const BROKEN = 'The vault mapping file could not be read; no secret can be used until it is fixed.'
const MISSING = `Name the exact command and shell you will run: ${NAME} comes from a vault and is approved per command.`
const LOCKED = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const OFF = `${NAME} is unavailable because the vault plugin is off.`
const UNAVAILABLE = 'The vault did not answer; nothing was read. Ask again when it is available.'
const UNSAFE = 'That request cannot be shown on a card; ask again without secret material in it.'
const CHANGED = `The vault mapping for ${NAME} changed; ask again.`
const APPROVAL_FAILED = 'The approval could not be recorded; nothing was granted. Ask again.'
const OUT_OF_SCOPE = `You may not ask for ${NAME}; the user did not let you ask for it.`
const DIFFERENT = 'The approved command, shell or folder was different; ask again.'
const HANDOFF = 'Vault values cannot reach a shell on this version; nothing was read.'
const TOOL_BODY = { content: [{ type: 'text', text: 'tool body fixture' }] }

const replyOf = message => ({ isError: true, error: { message }, content: [{ type: 'text', text: 'Error: ' + message }] })
const digest = (workdir, command = COMMAND, tool = 'bash') => createHash('sha256')
  .update(JSON.stringify({ v: 1, tool, workdir, command }), 'utf8').digest('hex')
const typed = (name, value, scope = 'all') => ({ name, value, scope, purpose: 'Typed fixture' })
const json = (path, data) => writeFileSync(path, JSON.stringify(data))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

async function fixture(t, { present = true, headerCwd = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vault-grant-'))
  const paths = Object.fromEntries(['state.json', 'secrets.json', 'vault-sources.json', 'vault-audit.jsonl', 'vault-audit.jsonl.1']
    .map((file, index) => [['state', 'typed', 'sources', 'audit', 'rotated'][index], join(home, file)]))
  const cwd = join(home, 'committed-folder')
  const header = headerCwd ? join(home, 'header-folder') : undefined
  const writeSources = (rows = { [NAME]: MAPPING }) => json(paths.sources, { version: 1, sources: rows })
  const writeTyped = (rows = [typed(TYPED, VALUE, [MAIN])]) => json(paths.typed, { version: 1, secrets: rows })
  writeSources()
  writeTyped()
  json(paths.state, {
    version: 1, revision: 1, mainBotIds: [MAIN], exchanges: [], questions: {},
    bots: {
      [MAIN]: { id: MAIN, sessionId: MAIN, name: 'Primary Fixture', role: 'Coordinator' },
      [MEMBER]: { id: MEMBER, sessionId: CHAT, name: 'Member Fixture', role: 'Assistant', private: true,
        segments: [{ sessionId: EARLIER }] },
    },
    rooms: { room: { id: 'room', name: 'Group Fixture', members: [MAIN, MEMBER], sessions: { [MEMBER]: GROUP } } },
  })
  let folder = cwd
  let status = () => ({ state: 'unlocked' })
  let statusCalls = 0
  let reads = 0
  const adapter = {
    async status() { statusCalls++; return status() },
    read() { reads++; assert.fail('vault adapter read was called') },
  }
  const warnings = []
  const notes = []
  const shellEnv = { register(entry) { contribution = entry; return () => { contribution = undefined } } }
  let contribution
  let connectorLoads = 0
  const services = {
    ...(present ? { secretSources: adapter } : {}),
    workingDirectory: { get(session) { assert.equal(session.header.id, session.id); return folder } },
    shellEnv,
    loader: { import: async () => { connectorLoads++; assert.fail('connector must not dispatch') } },
  }
  const ctx = fakeContext({ services })
  let attachAdapter, stopAdapter, route, fileGuard
  ctx.inject = (names, attach) => {
    if (names.length !== 1) return
    if (names[0] === 'secretSources') {
      attachAdapter = service => attach({ secretSources: service, effect(setup) { stopAdapter = setup() } })
      if (present) attachAdapter(adapter)
    }
    if (names[0] === 'shellEnv') attach({ shellEnv, effect: ctx.effect })
  }
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.connection.fetch.register = options => { route = options; return () => {} }
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup() {} } }) }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessions = { flush: async () => {} }
  const register = ctx.on
  ctx.on = (name, listener, options) => {
    if (name === 'tools/execute' && /[\\/]src[\\/]host[\\/]private-bots\.js:/.test(new Error().stack)) fileGuard = listener
    return register(name, listener, options)
  }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  t.after(async () => {
    try {
      await ctx.dispose()
      assert.equal(reads, 0)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await rt.load()
  await rt.loadSecrets()
  rt.warn = (...args) => warnings.push(args)
  rt.deliver = async note => { notes.push(note) }
  rt.teamFolder = () => home

  const agent = (sessionId = CHAT) => ({ id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd: header } } })
  const tool = async (toolName, args, sessionId = CHAT) => {
    let concluded = false
    const text = await ctx.registeredTools.get(toolName).execute(args, {
      agent: agent(sessionId), callId: 'fixture-call', concludeTurn() { concluded = true },
    })
    return { text, concluded }
  }
  const ask = (args = {}, sessionId) => {
    const input = { name: NAME, purpose: PURPOSE, command: COMMAND, shell: 'bash', ...args }
    for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key]
    return tool('request_secret', input, sessionId)
  }
  const list = async () => (await tool('list_secrets', {})).text
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const view = async payload => (await call('state', payload)).value
  const rows = () => Object.values(rt.state.secretRequests ?? {}).flat()
  const audit = (path = paths.audit) => existsSync(path) ? readFileSync(path, 'utf8').trimEnd().split('\n').map(JSON.parse) : []
  const detail = request => call('secret-source-detail', { requestId: request.id })
  const allow = (request, details = {}) => call('secret-allow', { requestId: request.id, commandDigest: details.commandDigest, snapshot: details.snapshot })
  const allowed = async (args, sessionId) => {
    assert.equal((await ask(args, sessionId)).concluded, true)
    const row = rows().at(-1)
    const answer = await detail(row)
    assert.equal(answer.ok, true)
    assert.deepEqual(await allow(row, answer.value), { ok: true, value: true })
    return row
  }
  const wrapper = ctx.listeners.get('tools/execute').find(listener => listener.name === 'refuseVaultExecution')
  const shell = (extra = {}) => ({ name: 'bash', agent: agent(), arguments: { command: COMMAND }, ...extra })
  const execute = (extra, next = async () => TOOL_BODY) => wrapper(shell(extra), next)
  const assertNoGrant = async () => assert.deepEqual(await execute(), TOOL_BODY)
  return {
    home, paths, cwd, header, rt, ctx, notes, warnings, services, writeTyped, writeSources, ask, tool, list, call, view, rows,
    audit, detail, allow, allowed, agent, execute, shell, assertNoGrant, fileGuard,
    readCalls: () => reads, statusCalls: () => statusCalls, connectorLoads: () => connectorLoads,
    setStatus: next => { status = typeof next === 'function' ? next : () => next },
    setFolder: next => { folder = next },
    stopAdapter: () => stopAdapter(),
    attachAdapter: next => attachAdapter(next),
    env: () => contribution?.resolve({ agent: agent(), arguments: {} }) ?? {},
  }
}

const refused = async (answer, message) => {
  const result = await answer
  assert.equal(result.ok, false)
  if (message instanceof RegExp) assert.match(result.error.message, message)
  else assert.equal(result.error.message, message)
}
const denyAsk = async (h, message, args, sessionId) => {
  assert.deepEqual(await h.ask(args, sessionId), { text: message, concluded: false })
  assert.deepEqual(h.rows(), [])
  assert.deepEqual(h.audit().slice(-1).map(({ decision, result }) => [decision, result]), [['refused', 'refused']])
}

test('typed requests and approvals ignore both optional strings', async t => {
  const h = await fixture(t)
  for (const args of [{}, { command: 'ignored', shell: 'any-shell' }]) {
    h.writeTyped([typed(TYPED, VALUE, [MAIN])])
    assert.equal((await h.tool('request_secret', { name: TYPED, purpose: PURPOSE, ...args })).concluded, true)
    const row = h.rows().at(-1)
    assert.equal(row.kind, 'allow')
    for (const key of ['source', 'shell', 'workdir', 'command', 'commandDigest']) assert.equal(Object.hasOwn(row, key), false)
    const answer = await h.call('secret-allow', { requestId: row.id })
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.value.scope, [MAIN, MEMBER])
  }
  assert.equal(h.statusCalls(), 0)
  assert.deepEqual(h.audit(), [])
})

test('vault request refusal order and audits before any status check', async t => {
  const h = await fixture(t)
  writeFileSync(h.paths.sources, 'unreadable fixture')
  await denyAsk(h, BROKEN, { command: undefined }, MAIN)
  h.writeSources()
  h.writeTyped([typed(NAME, VALUE)])
  await denyAsk(h, `${NAME} is defined both in secrets.json and in vault-sources.json, so it cannot be used. The user must delete one of them in Settings › Secrets.`)
  h.writeTyped()
  h.stopAdapter()
  await denyAsk(h, OFF, { command: undefined }, MAIN)
  h.attachAdapter(h.services.secretSources)
  await denyAsk(h, OUT_OF_SCOPE, { command: undefined }, MAIN)
  assert.equal(h.readCalls(), 0)
  await denyAsk(h, 'Secret cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_secret there.', { command: undefined }, GROUP)
  await denyAsk(h, 'Secret cards only work in your current own chat.', { command: undefined }, EARLIER)
  await denyAsk(h, MISSING, { command: undefined })
  await denyAsk(h, MISSING, { shell: undefined })
  await denyAsk(h, 'Name the shell as bash or pwsh.', { shell: 'fixture-shell', command: 'x'.repeat(4001) })
  await denyAsk(h, 'The command is longer than 4,000 characters; shorten it and ask again.', { command: 'x'.repeat(4001) })
  h.setFolder('relative')
  await denyAsk(h, 'No working folder is set for this chat; nothing was asked.')
  assert.equal(h.statusCalls(), 0)
})

test('status classifies unavailable, locked and unlocked for requests and listing', async t => {
  const h = await fixture(t)
  for (const status of [() => { throw new Error(REFERENCE.item) }, null, { state: 'unexpected' }, { state: 'unlocked', lastSync: 'bad' }]) {
    h.setStatus(status)
    await denyAsk(h, UNAVAILABLE)
    assert.match(await h.list(), /unavailable: the vault did not answer/)
  }
  for (const state of ['locked', 'unauthenticated']) {
    h.setStatus({ state })
    assert.deepEqual(await h.ask(), { text: LOCKED, concluded: false })
    const row = h.rows().at(-1)
    assert.equal(row.status, 'locked')
    assert.equal(row.source, 'vault')
    assert.ok(row.settledAt >= row.askedAt)
    await refused(h.detail(row), CHANGED)
    assert.equal(h.notes.at(-1).text, LOCKED)
    assert.deepEqual(h.audit().slice(-1).map(({ decision, result }) => [decision, result]), [['locked', 'locked']])
    assert.match(await h.list(), /locked: the user must unlock the vault/)
  }
  h.setStatus({ state: 'unlocked', lastSync: 123 })
  assert.match(await h.list(), /available: ask with request_secret, naming the exact command and shell/)
  assert.equal(JSON.stringify(h.warnings).includes(REFERENCE.item), false)
})

test('status is bounded to five seconds', async t => {
  const h = await fixture(t)
  const started = Promise.withResolvers()
  h.setStatus(() => { started.resolve(); return new Promise(() => {}) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = h.ask()
  await started.promise
  t.mock.timers.tick(4999)
  assert.equal(h.rows().length, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(await waiting, { text: UNAVAILABLE, concluded: false })
  assert.equal(h.audit().at(-1).decision, 'refused')
})

test('live presence and the pending row expose only the approved command context', async t => {
  const h = await fixture(t)
  const before = await h.view()
  assert.equal(before.secretSourcesPresent, true)
  assert.deepEqual(Object.keys(before.secretSources).sort(), ['broken', 'rows'])
  const result = await h.ask()
  assert.match(result.text, /approve the exact command/)
  assert.equal(result.concluded, true)
  const [row] = h.rows()
  assert.deepEqual(row, {
    id: row.id, callId: 'fixture-call', sessionId: CHAT, name: NAME, purpose: PURPOSE, kind: 'allow', source: 'vault',
    command: COMMAND, shell: 'bash', workdir: h.cwd, commandDigest: digest(h.cwd), status: 'pending', askedAt: row.askedAt,
  })
  assert.deepEqual(h.audit().map(({ time, ...rest }) => rest), [
    { name: NAME, botId: MEMBER, consumer: 'shell', commandDigest: digest(h.cwd), decision: 'asked', result: 'ok' },
  ])
  const answer = await h.detail(row)
  assert.deepEqual(answer, { ok: true, value: { provider: REFERENCE.provider, item: REFERENCE.item, field: REFERENCE.field,
    snapshot: answer.value.snapshot, commandDigest: digest(h.cwd) } })
  assert.match(answer.value.snapshot, /^[\da-f-]{36}$/)
  assert.equal((await h.detail(row)).value.snapshot, answer.value.snapshot)
  const fingerprint = createHash('sha256').update(JSON.stringify({
    provider: REFERENCE.provider, connection: REFERENCE.connection, item: REFERENCE.item,
    field: REFERENCE.field, scope: [MEMBER],
  })).digest('hex')
  for (const data of [readFileSync(h.paths.state, 'utf8'), JSON.stringify(await h.view())]) {
    for (const token of [VALUE, ...Object.values(REFERENCE), answer.value.snapshot, fingerprint]) assert.equal(data.includes(token), false)
  }
  assert.deepEqual(h.env(), {})
  const full = await h.view()
  h.stopAdapter()
  const unchanged = await h.view({ since: full.revision, live: full.liveKey })
  assert.equal(unchanged.secretSourcesPresent, false)
  assert.deepEqual(unchanged.secretSources, full.secretSources)
})

test('a header-only absolute folder works and a missing folder refuses', async t => {
  const header = await fixture(t)
  header.setFolder(undefined)
  const row = await header.allowed()
  assert.equal(row.workdir, header.header)
  assert.deepEqual(await header.execute(), replyOf(HANDOFF))
  const missing = await fixture(t, { headerCwd: false })
  missing.setFolder(undefined)
  await denyAsk(missing, 'No working folder is set for this chat; nothing was asked.')
})

test('literal typed, retained dual and mapping material never reaches the card or diagnostics', async t => {
  const h = await fixture(t)
  h.writeSources({ [NAME]: MAPPING, [SECOND]: MAPPING })
  h.writeTyped([typed(TYPED, VALUE), typed(SECOND, RETAINED)])
  await h.rt.loadSecrets()
  h.writeTyped([typed(TYPED, VALUE)])
  for (const marker of [VALUE, RETAINED, REFERENCE.item]) {
    await denyAsk(h, UNSAFE, { command: `before ${marker} after` })
    await denyAsk(h, UNSAFE, { purpose: `${'x'.repeat(300)}${marker}` })
    h.setFolder(join(h.home, marker))
    await denyAsk(h, UNSAFE)
    h.setFolder(h.cwd)
  }
  for (const text of [readFileSync(h.paths.state, 'utf8'), JSON.stringify(await h.view()),
    readFileSync(h.paths.audit, 'utf8'), JSON.stringify(h.warnings)]) {
    for (const marker of [VALUE, RETAINED, ...Object.values(REFERENCE)]) assert.equal(text.includes(marker), false)
  }
})

test('a command may name the mapping field and connection without losing its card', async t => {
  const h = await fixture(t)
  const command = `fixture-command --field ${REFERENCE.field} --connection ${REFERENCE.connection}`
  assert.equal((await h.ask({ command })).concluded, true)
  const [row] = h.rows()
  assert.equal(row.status, 'pending')
  assert.equal(row.command, command)
  assert.equal(row.commandDigest, digest(h.cwd, command))
  assert.equal(h.audit().at(-1).decision, 'asked')
  assert.equal(h.readCalls(), 0)
})

test('detail and approval reject changes to every live card binding field', async t => {
  for (const [field, value] of [
    ['kind', 'fill'], ['source', 'typed'], ['shell', 'pwsh'], ['workdir', '/changed-fixture-folder'],
    ['commandDigest', '0'.repeat(64)], ['sessionId', EARLIER], ['name', SECOND],
  ]) {
    await t.test(field, async t => {
      const h = await fixture(t)
      await h.ask()
      const [row] = h.rows()
      const { value: details } = await h.detail(row)
      row[field] = value
      await refused(h.detail(row), /vault mapping.*changed/)
      await refused(h.allow(row, details), field === 'source' ? /comes from a vault/ : /vault mapping.*changed/)
      assert.equal(h.audit().some(entry => entry.decision === 'allowed'), false)
      await h.assertNoGrant()
    })
  }
})

test('approval requires the detail snapshot and exact live command tuple', async t => {
  const h = await fixture(t)
  await h.ask()
  const [row] = h.rows()
  const { value: details } = await h.detail(row)
  await refused(h.allow(row), /Update the app to approve this request/)
  await refused(h.allow(row, { ...details, commandDigest: '0'.repeat(64) }), CHANGED)
  await refused(h.allow(row, { ...details, snapshot: 'unknown-fixture' }), CHANGED)
  assert.equal(row.status, 'pending')
  assert.equal(h.audit().filter(entry => entry.decision === 'refused').length, 3)
  row.command = 'changed-fixture-command'
  await refused(h.detail(row), CHANGED)
  await refused(h.allow(row, details), CHANGED)
  row.command = COMMAND
  await h.ask({ command: 'new-fixture-command' })
  const newer = h.rows().at(-1)
  await refused(h.detail(row), CHANGED)
  await refused(h.allow(newer, { ...details, commandDigest: newer.commandDigest }), CHANGED)
  await h.assertNoGrant()
})

test('approval refuses when the mapping changes, collides or becomes unreadable', async t => {
  for (const change of [
    h => h.writeSources({ [NAME]: { ...MAPPING, provider: 'changed-provider-fixture' } }),
    h => h.writeSources({ [NAME]: { ...MAPPING, connection: 'changed-connection-fixture' } }),
    h => h.writeSources({ [NAME]: { ...MAPPING, item: 'changed-reference-fixture' } }),
    h => h.writeSources({ [NAME]: { ...MAPPING, field: 'changed-field-fixture' } }),
    h => h.writeSources({ [NAME]: { ...MAPPING, scope: [] } }),
    h => h.writeSources({}),
    h => writeFileSync(h.paths.sources, '{'),
    h => h.writeTyped([typed(NAME, VALUE)]),
  ]) {
    await t.test('changed backing state', async t => {
      const h = await fixture(t)
      await h.ask()
      const [row] = h.rows()
      const { value: details } = await h.detail(row)
      change(h)
      await refused(h.detail(row), CHANGED)
      await refused(h.allow(row, details), CHANGED)
      assert.equal(row.status, 'pending')
      await h.assertNoGrant()
    })
  }
})

test('approval revalidates service, writer, typed store and current chat', async t => {
  for (const [change, expected] of [
    [h => h.stopAdapter(), OFF],
    [h => { h.rt.holdsLock = () => false }, /cannot approve vault requests/],
    [h => { rmSync(h.paths.typed); mkdirSync(h.paths.typed) }, /The secrets file could not be read/],
    [h => { h.rt.state.bots[MEMBER].sessionId = 'rotated-chat-fixture' }, 'This card belongs to an earlier chat; ask again.'],
  ]) {
    await t.test(String(expected), async t => {
      const h = await fixture(t)
      await h.ask()
      const [row] = h.rows()
      const { value: details } = await h.detail(row)
      change(h)
      await refused(h.allow(row, details), expected)
      await h.assertNoGrant()
      if (typeof expected === 'string' && expected.startsWith('This card')) assert.equal(row.status, 'canceled')
    })
  }
})

test('only real locked or unauthenticated responses send the locked note on Allow', async t => {
  const h = await fixture(t)
  await h.ask()
  const [row] = h.rows()
  const { value: details } = await h.detail(row)
  for (const status of [() => { throw new Error(REFERENCE.item) }, { state: 'unlocked', lastSync: {} }]) {
    h.setStatus(status)
    await refused(h.allow(row, details), UNAVAILABLE)
    assert.equal(h.notes.length, 0)
    assert.equal(h.audit().at(-1).decision, 'refused')
  }
  const entered = Promise.withResolvers()
  h.setStatus(() => { entered.resolve(); return new Promise(() => {}) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const approval = h.allow(row, details)
  await entered.promise
  t.mock.timers.tick(5000)
  await refused(approval, UNAVAILABLE)
  t.mock.timers.reset()
  assert.equal(h.notes.length, 0)
  for (const state of ['locked', 'unauthenticated']) {
    h.setStatus({ state })
    await refused(h.allow(row, details), LOCKED)
    assert.equal(h.notes.at(-1).text, LOCKED)
    assert.equal(h.audit().at(-1).decision, 'locked')
  }
  assert.equal(row.status, 'pending')
  await h.assertNoGrant()
})

test('a superseding request during status cannot publish the old grant', async t => {
  const h = await fixture(t)
  await h.ask()
  const [row] = h.rows()
  const { value: details } = await h.detail(row)
  const status = Promise.withResolvers()
  const entered = Promise.withResolvers()
  h.setStatus(() => { entered.resolve(); return status.promise })
  const approval = h.allow(row, details)
  await entered.promise
  h.setStatus({ state: 'unlocked' })
  await h.ask({ command: 'replacement-fixture-command' })
  status.resolve({ state: 'unlocked' })
  await refused(approval, CHANGED)
  assert.deepEqual(h.rows().map(request => request.status), ['canceled', 'pending'])
  assert.equal(h.audit().some(entry => entry.decision === 'allowed'), false)
  await h.assertNoGrant()
})

test('replacing the live service during the required save prevents publication', async t => {
  const h = await fixture(t)
  await h.ask()
  const [row] = h.rows()
  const { value: details } = await h.detail(row)
  const save = h.rt.save
  h.rt.save = async options => {
    await save(options)
    h.stopAdapter()
    h.attachAdapter({ ...h.services.secretSources })
    h.rt.save = save
  }
  await refused(h.allow(row, details), OFF)
  assert.equal(row.status, 'canceled')
  assert.equal(h.audit().some(entry => entry.decision === 'allowed'), false)
  assert.equal(readJson(h.paths.state).secretRequests[MEMBER][0].status, 'canceled')
  await h.assertNoGrant()
})

test('chat rotation during the audit append prevents publication', async t => {
  const h = await fixture(t)
  await h.ask()
  const [row] = h.rows()
  const { value: details } = await h.detail(row)
  const original = fsPromises.open
  const entered = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  const hook = t.mock.method(fsPromises, 'open', async (path, ...args) => {
    if (path === h.paths.audit) {
      entered.resolve()
      await proceed.promise
    }
    return original(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    const approval = h.allow(row, details)
    await entered.promise
    h.rt.state.bots[MEMBER].sessionId = 'rotated-during-audit-fixture'
    proceed.resolve()
    await refused(approval, 'This card belongs to an earlier chat; ask again.')
    assert.equal(row.status, 'canceled')
    assert.equal(readJson(h.paths.state).secretRequests[MEMBER][0].status, 'canceled')
    // Run the handoff as the earlier Session so an incorrectly published grant would still match.
    assert.deepEqual(await h.execute(), TOOL_BODY)
  } finally {
    hook.mock.restore()
    syncBuiltinESMExports()
  }
})

test('save failure restores a retryable pending card and audit failure cancels the saved approval', async t => {
  const h = await fixture(t)
  await h.ask()
  const [row] = h.rows()
  const { value: details } = await h.detail(row)
  const save = h.rt.save
  h.rt.save = async options => {
    assert.deepEqual(options, { required: true })
    assert.equal(readJson(h.paths.state).secretRequests[MEMBER][0].status, 'pending')
    throw new Error(REFERENCE.item)
  }
  await refused(h.allow(row, details), APPROVAL_FAILED)
  h.rt.save = save
  assert.equal(row.status, 'pending')
  assert.equal(row.settledAt, undefined)
  assert.equal(readJson(h.paths.state).secretRequests[MEMBER][0].status, 'pending')
  assert.equal(h.audit().some(entry => entry.decision === 'allowed'), false)
  await h.assertNoGrant()
  rmSync(h.paths.audit)
  mkdirSync(h.paths.audit)
  await refused(h.allow(row, details), APPROVAL_FAILED)
  assert.equal(row.status, 'canceled')
  assert.equal(row.reason, 'audit')
  const saved = readJson(h.paths.state).secretRequests[MEMBER][0]
  assert.equal(saved.status, 'canceled')
  assert.equal(saved.reason, 'audit')
  await refused(h.allow(row, details), 'This request was already answered')
  await h.assertNoGrant()
  assert.equal(JSON.stringify(h.warnings).includes(REFERENCE.item), false)
  rmSync(h.paths.audit, { recursive: true })
  await h.allowed()
})

test('approval writes the allowed audit, keeps typed bytes and refuses the handoff once', async t => {
  const h = await fixture(t)
  const typedBytes = readFileSync(h.paths.typed)
  const row = await h.allowed()
  assert.deepEqual(readFileSync(h.paths.typed), typedBytes)
  assert.equal(row.status, 'allowed')
  assert.equal(Object.hasOwn(row, 'scope'), false)
  assert.equal(readJson(h.paths.state).secretRequests[MEMBER][0].status, 'allowed')
  assert.match(h.notes.at(-1).text, /approved this exact command once.*running it will be refused/)
  assert.deepEqual(h.audit().map(entry => entry.decision), ['asked', 'allowed'])
  await refused(h.detail(row), CHANGED)
  assert.deepEqual(h.env(), {})
  let executions = 0
  const body = async () => { executions++; return TOOL_BODY }
  assert.deepEqual(await h.execute({}, body), replyOf(HANDOFF))
  assert.equal(executions, 0)
  assert.deepEqual(await h.execute({}, body), TOOL_BODY)
  assert.equal(executions, 1)
  const { decision, result, commandDigest } = h.audit().at(-1)
  assert.deepEqual([decision, result, commandDigest], ['refused', 'refused', digest(h.cwd)])
  assert.equal(h.readCalls(), 0)
})

test('command, shell, folder, explicit workdir and nested mismatches consume the grant', async t => {
  const h = await fixture(t)
  for (const change of [
    () => ({ arguments: { command: 'different-fixture-command' } }),
    () => ({ name: 'pwsh' }),
    () => { h.setFolder(h.header); return {} },
    () => ({ arguments: { command: COMMAND, workdir: h.cwd } }),
    () => ({ parent: { name: 'fixture-parent' } }),
    () => { h.setFolder('relative'); return {} },
  ]) {
    h.setFolder(h.cwd)
    await h.allowed()
    assert.deepEqual(await h.execute(change(), () => assert.fail('mismatched shell body ran')), replyOf(DIFFERENT))
    await h.assertNoGrant()
  }
})

test('expiry and a denied pre-execute attempt only consume at tools/execute', async t => {
  const h = await fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: 100 })
  await h.allowed()
  const denied = replyOf('fixture policy declined')
  const preExecute = async () => denied
  assert.deepEqual(await preExecute(h.shell(), () => assert.fail('denied attempt reached tools/execute')), denied)
  assert.deepEqual(h.audit().map(entry => entry.decision), ['asked', 'allowed'])
  assert.deepEqual(await h.execute(), replyOf(HANDOFF))
  await h.allowed()
  t.mock.timers.tick(10 * 60_000)
  assert.deepEqual(await h.execute(), replyOf(`The approval for ${NAME} expired; ask again.`))
  await h.assertNoGrant()
})

test('other Bots, Sessions and non-shell tools leave a grant untouched', async t => {
  const h = await fixture(t)
  await h.allowed({ shell: 'pwsh' })
  for (const exec of [
    { agent: h.agent(MAIN) }, { agent: h.agent(EARLIER) }, { agent: h.agent(GROUP) }, { name: 'fixture-tool' },
  ]) assert.deepEqual(await h.execute(exec), TOOL_BODY)
  assert.deepEqual(h.audit().map(entry => entry.decision), ['asked', 'allowed'])
  assert.deepEqual(await h.execute({ name: 'pwsh' }), replyOf(HANDOFF))
})

test('a new grant replaces the unused grant for the same Bot and Session', async t => {
  const h = await fixture(t)
  h.writeSources({ [NAME]: MAPPING, [SECOND]: MAPPING })
  const old = await h.allowed()
  const next = await h.allowed({ name: SECOND, command: 'another-fixture-command' })
  assert.deepEqual(h.audit().map(({ name, commandDigest, decision }) => [name, commandDigest, decision]), [
    [NAME, old.commandDigest, 'asked'], [NAME, old.commandDigest, 'allowed'],
    [SECOND, next.commandDigest, 'asked'], [SECOND, next.commandDigest, 'allowed'], [NAME, old.commandDigest, 'canceled'],
  ])
  assert.deepEqual(await h.execute({ arguments: { command: next.command } }), replyOf(HANDOFF))
  await h.assertNoGrant()
})

test('mapping set and clear cancel pending cards and drop unused grants', async t => {
  const h = await fixture(t)
  for (const change of ['secret-source-set', 'secret-source-clear']) {
    await h.allowed()
    await h.ask()
    const row = h.rows().at(-1)
    const { value: details } = await h.detail(row)
    const result = await h.call(change, { ...MAPPING, name: NAME })
    assert.equal(result.ok, true)
    assert.equal(row.status, 'canceled')
    await refused(h.allow(row, details), 'This request was already answered')
    await refused(h.call('secret-set', { requestId: row.id, value: VALUE }), /cannot take a typed value/)
    assert.match(h.notes.at(-1).text, /changed the vault mapping.*ask again/)
    assert.deepEqual(h.audit().slice(-2).map(entry => [entry.decision, entry.result]), [['canceled', 'revoked'], ['canceled', 'revoked']])
    await h.assertNoGrant()
  }
  assert.equal(h.rt.secretStored(NAME), false)
})

test('a person may cancel a pending vault card, but cannot type a replacement into it', async t => {
  const h = await fixture(t)
  await h.ask()
  const [row] = h.rows()
  await refused(h.call('secret-set', { requestId: row.id, value: VALUE }), /cannot take a typed value/)
  assert.deepEqual(await h.call('secret-cancel', { requestId: row.id }), { ok: true, value: true })
  assert.equal(row.status, 'canceled')
  assert.match(h.notes.at(-1).text, /user canceled your request/)
  assert.equal(h.audit().at(-1).decision, 'denied')
  await h.assertNoGrant()
})

test('audit rotation keeps one 0600 generation and a follower modifies neither file', async t => {
  const h = await fixture(t)
  const padding = 'x'.repeat(1024 * 1024)
  writeFileSync(h.paths.audit, padding, { mode: 0o644 })
  writeFileSync(h.paths.rotated, 'old-fixture', { mode: 0o644 })
  const row = await h.allowed()
  assert.equal(readFileSync(h.paths.rotated, 'utf8'), padding)
  const files = [h.paths.audit, h.paths.rotated]
  if (process.platform !== 'win32') for (const file of files) assert.equal(statSync(file).mode & 0o777, 0o600)
  const kept = files.map(file => readFileSync(file))
  for (const token of [COMMAND, VALUE, ...Object.values(REFERENCE)]) assert.equal(kept[0].includes(token), false)
  assert.equal(h.audit().at(-1).commandDigest, row.commandDigest)

  h.rt.holdsLock = () => false
  h.rt.readOnly = () => 'This fixture is read-only.'
  assert.deepEqual(await h.ask(), { text: 'No card can be shown now. This fixture is read-only.', concluded: false })
  assert.deepEqual(files.map(file => readFileSync(file)), kept)
  assert.deepEqual(h.rows(), [row])
  for (const file of files) await assert.rejects(h.fileGuard({
    name: 'read', arguments: { file_path: file }, agent: h.agent(MAIN),
  }, async () => assert.fail('protected audit file reached read')), /private Bot/)
})

test('an unlocked service still cannot supply a custom connector', async t => {
  const h = await fixture(t)
  assert.match(await h.list(), /available: ask with request_secret/)
  const headers = { Authorization: 'Bearer $DSH_SECRET_VAULT_FIXTURE' }
  h.rt.state.connectors = { fixture: { custom: { url: 'https://fixture.invalid', headers } } }
  assert.throws(() => h.rt.connectorsInternals.upstreamOf('fixture'), {
    code: 'bot/refused', message: `${NAME} comes from a vault, and this version of the Bot team cannot use vault secrets yet.`,
  })
  delete h.rt.state.connectors.fixture
  await h.rt.connectorEndpoint('connector-add', {
    name: 'Fixture Connector', command: 'unused', env: { AUTH: '$DSH_SECRET_VAULT_FIXTURE' },
  })
  assert.equal(h.connectorLoads(), 0)
  assert.equal(h.readCalls(), 0)
})
