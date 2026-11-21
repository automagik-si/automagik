import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWindowsCredential } from '../../../vault-dsh/src/windows-credential/adapter.js'
import { fakeClock } from '../../../vault-dsh/test/fixtures/harness.mjs'
import { apply } from '../../index.js'
import { fakeContext } from '../fake-ctx.js'

export const provider = 'windows-credential'
export const connection = 'current-user'
export const name = 'FIXTURE_KEY'
export const local = { origin: 'http://localhost' }
export const locked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const main = 'fixture-main', member = 'fixture-member', room = 'fixture-room'

export async function mount(t, { mapping = true, platform = 'win32', cloud = false, diagnosticsFile = true, target } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'wincred-mounted-'))
  const item = target ?? ' ' + randomUUID() + ' ç🌍  '
  const user = randomUUID()
  const value = randomUUID()
  const reference = { provider, connection, item, field: 'password', scope: [member] }
  const path = join(home, 'vault-sources.json')
  const auditPath = join(home, 'vault-audit.jsonl')
  const writeMappings = (row, key = name) => writeFile(path, JSON.stringify({ version: 1, sources: { [key]: row } }))
  await writeFile(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [main], exchanges: [], questions: {},
    bots: {
      [main]: { id: main, sessionId: main, name: 'Primary Fixture', role: 'Coordinator' },
      [member]: { id: member, sessionId: member, name: 'Member Fixture', role: 'Assistant', private: true },
    },
    rooms: { room: { id: 'room', name: 'Group Fixture', members: [main, member], sessions: { [member]: room } } },
  }))
  if (mapping) await writeMappings(reference)
  const timers = fakeClock()
  const operations = []
  let probeExit = 0
  let picker
  const streams = (code, stdout = '') => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) })
  const runner = {
    availability: () => platform !== 'win32' ? 'platform' : cloud ? 'cloud' : undefined,
    async run(op) {
      operations.push(op)
      if (op === 'probe') return streams(probeExit)
      const data = op === 'meta' ? Buffer.from(user) : Buffer.from(value, 'utf16le')
      const response = (op === 'meta' ? 'M ' : 'V ') + data.toString('base64') + '\n'
      return streams(0, response)
    },
    prepareQuit: async () => ({ ok: true, unconfirmed: 0 }),
  }
  const adapter = createWindowsCredential({ idleLockMinutes: 1 }, { runner, timers })
  const service = {
    providers: ['bitwarden', 'hashicorp-vault', provider],
    providerBinding: id => id === provider ? adapter.binding : undefined,
    activeConnection: () => adapter.connection === undefined ? undefined : { provider, connection: adapter.connection },
    status: options => options.provider === provider ? adapter.status() : { state: 'unlocked' },
    async unlock(options) {
      const binding = adapter.binding
      const current = () => binding === adapter.binding && !options.signal?.aborted
      const result = await adapter.preflight(options, current)
      return result.ok && current() ? adapter.unlock() : result
    },
    lock: options => options?.provider === 'hashicorp-vault' ? true : adapter.retire(),
    listItems: options => picker ? picker(options) : adapter.listItems(options),
    read: options => adapter.read(options),
  }
  const services = { secretSources: service }
  const ctx = fakeContext({ services })
  const warnings = [], notes = []
  let attach, detach, route
  ctx.inject = (names, mount) => {
    if (names.length !== 1 || names[0] !== 'secretSources') return
    attach = next => {
      services.secretSources = next
      mount({ secretSources: next, effect(setup) { detach = setup() } })
    }
    attach(service)
  }
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.sessions = { flush: async () => {} }
  ctx.sessionController = { resolveAgent: async () => ({ error: { message: 'Fixture has no live agent.' } }) }
  apply(ctx, { home, github: false, diagnosticsFile })
  const rt = ctx.get('omniTeam')
  rt.deliver = async note => { notes.push(note) }
  const forms = marker => [marker, Buffer.from(marker).toString('base64'), Buffer.from(marker, 'utf16le').toString('base64')]
  const contains = (bytes, marker) => forms(marker).some(needle => bytes.includes(needle))
  const containsTarget = bytes => contains(bytes, item) || contains(bytes, item.toUpperCase())
  const valueFree = text => !contains(text, value)
  t.after(async () => {
    try {
      await ctx.dispose()
      await adapter.prepareQuit()
      assert.equal(operations.includes('read'), false, 'host never read a value')
      for (const log of [notes, warnings, operations]) {
        const bytes = JSON.stringify(log)
        assert.equal(valueFree(bytes) && !containsTarget(bytes) && !contains(bytes, user), true, 'private markers stayed out of logs')
      }
      for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const bytes = await readFile(join(entry.parentPath, entry.name), 'utf8')
        assert.equal(valueFree(bytes) && !contains(bytes, user), true, 'value and picker user stayed out of files')
        if (entry.name !== 'vault-sources.json') assert.equal(containsTarget(bytes), false, 'target stayed out of state, logs and audit')
      }
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await rt.load()
  const request = async (endpoint, payload = {}, headers = local) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers,
    }))
    const body = await response.json()
    assert.equal(valueFree(JSON.stringify(body)), true, 'route does not return values')
    return { body, cache: response.headers.get('cache-control') }
  }
  const call = async (...args) => (await request(...args)).body
  const agent = (sessionId = member, cwd = home) => ({ id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd } } })
  const ask = (sessionId = member, args = {}, cwd) => ctx.registeredTools.get('request_secret').execute({
    name, command: 'fixture-command', shell: 'bash', purpose: 'Use the fixture', ...args,
  }, { agent: agent(sessionId, cwd) })
  const list = () => ctx.registeredTools.get('list_secrets').execute({}, { agent: agent() })
  const card = () => rt.state.secretRequests?.[member]?.at(-1)
  const detail = (row = card()) => request('secret-source-detail', { requestId: row.id })
  const allow = (details, row = card()) => call('secret-allow', { requestId: row.id, commandDigest: details.commandDigest, snapshot: details.snapshot })
  const execute = () => ctx.listeners.get('tools/execute').find(listener => listener.name === 'refuseVaultExecution')(
    { name: 'bash', arguments: { command: 'fixture-command' }, agent: agent() }, () => 'fixture shell')
  const unlock = (headers, args) => request('vault-unlock', { provider, ...args }, headers)
  const lock = (id = provider) => call('vault-lock', { provider: id })
  const pick = (target = item) => request('vault-items', { provider, target })
  const approve = async () => {
    assert.match(await ask(), /card asking the user/)
    assert.equal((await allow((await detail()).body.value)).ok, true)
  }
  const audit = async () => readFile(auditPath, 'utf8').then(bytes => bytes.trim().split('\n').map(JSON.parse), () => [])
  return {
    adapter, service, operations, reference, home, path, item, user, call, request, unlock, lock, ask, list, pick, card, detail, allow,
    execute, audit, auditPath, rt, approve, writeMappings, main, room, timers,
    setProbeExit: code => { probeExit = code },
    setPicker: next => { picker = next },
    breakAudit: async () => { await rm(auditPath, { force: true }); await mkdir(auditPath) },
    stop() { detach(); delete services.secretSources },
    replace(next) { detach(); attach(next) },
  }
}
