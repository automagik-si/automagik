// Consented sharing of the CLI sign-in (#869): the record (consent.js) and what the acpAgents
// service does with it for chats, images and the sign-in card. Fakes only: no CLI runs, the
// record lives in a temp folder, and every identity is invented.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, SERVICE, SIGNED_IN_TTL_MS } from '../index.js'
import { AgentRun } from '../src/host/acp.js'
import { AGENTS } from '../src/host/agents.js'
import { CONSENT_FILE, ConsentStore } from '../src/host/consent.js'
import { UNAVAILABLE } from '../src/host/image.js'
import { adaptersHome } from '../src/host/install.js'
import { MODEL_ACCESS_REQUIRED } from '../src/host/names.js'

const CLAUDE = AGENTS['acp-claude']
const CODEX = AGENTS['acp-codex']
// The vendors with an account to confirm: a native agent (no adapter) has none.
const IDS = Object.keys(AGENTS).filter(id => AGENTS[id].adapter !== undefined)
const WORK = { kind: 'account', id: 'claude\norg-work\nana@work.example', facets: { kind: 'account', email: 'ana@work.example', org: 'org-work' }, email: 'ana@work.example', org: 'Acme', plan: 'team' }
const HOME = { kind: 'account', id: 'claude\norg-home\nana@home.example', facets: { kind: 'account', email: 'ana@home.example', org: 'org-home' }, email: 'ana@home.example', plan: 'max' }
const CODEX_WORK = { kind: 'account', id: 'codex\nchatgpt\nana@work.example', facets: { kind: 'account', email: 'ana@work.example' }, email: 'ana@work.example', plan: 'business' }
const CODEX_OTHER = { kind: 'account', id: 'codex\nchatgpt\nother@work.example', facets: { kind: 'account', email: 'other@work.example' }, email: 'other@work.example', plan: 'business' }

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-consent-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'acp', CONSENT_FILE)
}
const stored = file => JSON.parse(readFileSync(file, 'utf8'))

test('a new install: a signed-in vendor needs the person\'s word, once per account', (t) => {
  const file = scratch(t)
  const store = new ConsentStore({ file, ids: IDS, now: () => 1000 })
  // Nothing is written until there is something to keep.
  assert.equal(existsSync(file), false)
  assert.equal(store.note('acp-claude', undefined, undefined), undefined)
  assert.equal(existsSync(file), false)
  assert.equal(store.note('acp-claude', true, WORK), 'needed')
  assert.equal(store.note('acp-claude', true, WORK), 'needed')
  store.confirm('acp-claude', WORK)
  assert.equal(store.note('acp-claude', true, WORK), 'given')
  // Another account in the terminal: asked again; the first one coming back needs nothing.
  assert.equal(store.note('acp-claude', true, HOME), 'needed')
  assert.equal(store.note('acp-claude', true, WORK), 'given')
  // An account that cannot be read never turns a consented vendor into "needed".
  assert.equal(store.note('acp-claude', true, undefined), 'given')
  // Signed out says nothing, and the record stays for the sign-in that comes back.
  assert.equal(store.note('acp-claude', false, undefined), undefined)
  assert.equal(store.note('acp-claude', true, WORK), 'given')
  // The other vendor is its own question.
  assert.equal(store.note('acp-codex', true, CODEX_WORK), 'needed')
})

test('the file holds a digest keyed for this install: no email, organisation or plan, owner-only', (t) => {
  const file = scratch(t)
  const store = new ConsentStore({ file, ids: IDS, now: () => 1000 })
  store.note('acp-claude', true, WORK)
  store.confirm('acp-claude', WORK)
  const text = readFileSync(file, 'utf8')
  for (const secret of ['ana@work.example', 'Acme', 'org-work', 'team']) assert.equal(text.includes(secret), false, secret)
  const doc = stored(file)
  assert.deepEqual(Object.keys(doc).sort(), ['key', 'vendors', 'version'])
  assert.deepEqual(doc.vendors, { 'acp-claude': { consent: 'given', at: 1000, account: store.digests(WORK) } })
  assert.deepEqual(Object.keys(doc.vendors['acp-claude'].account).sort(), ['email', 'kind', 'org'])
  for (const digest of Object.values(doc.vendors['acp-claude'].account)) assert.match(digest, /^[A-Za-z0-9_-]{43}$/)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  // Another install digests the same account to another value.
  const other = new ConsentStore({ file: scratch(t), ids: IDS })
  assert.notEqual(other.digest(WORK.id), store.digest(WORK.id))
  // The record is read back by the next start.
  const again = new ConsentStore({ file, ids: IDS })
  assert.equal(again.note('acp-claude', true, WORK), 'given')
  assert.equal(again.note('acp-claude', true, HOME), 'needed')
})

test('an upgrade: a vendor an earlier version offered is carried when it is signed in, once', (t) => {
  const file = scratch(t)
  const earlier = id => id === 'acp-claude'
  const store = new ConsentStore({ file, ids: IDS, earlier, now: () => 2000 })
  // A failed or unknown read changes nothing: the carry waits for a definite answer.
  assert.equal(store.note('acp-claude', undefined, undefined), undefined)
  // Signed in, account not readable yet: carried, and the digest is retried until it can be read.
  assert.equal(store.note('acp-claude', true, undefined), 'carried')
  assert.deepEqual(stored(file).vendors['acp-claude'], { consent: 'carried', at: 2000 })
  assert.equal(store.noticePending('acp-claude'), true)
  assert.equal(store.note('acp-claude', true, undefined), 'carried')
  assert.equal(store.note('acp-claude', true, WORK), 'carried')
  assert.deepEqual(stored(file).vendors['acp-claude'].account, store.digests(WORK))
  // Recorded once: later reads of that account, or none, keep it carried.
  assert.equal(store.note('acp-claude', true, undefined), 'carried')
  assert.equal(store.note('acp-claude', true, WORK), 'carried')
  // Only another account, read for certain, asks again.
  assert.equal(store.note('acp-claude', true, HOME), 'needed')
  // The notice is acknowledged once and stays so across a restart.
  store.noticed('acp-claude')
  const again = new ConsentStore({ file, ids: IDS, earlier: () => true })
  assert.equal(again.noticePending('acp-claude'), false)
  assert.equal(again.note('acp-claude', true, WORK), 'carried')
  // The vendor no earlier version offered was never carried, and a later start cannot carry it.
  assert.equal(again.note('acp-codex', true, CODEX_WORK), 'needed')
})

test('a CLI release that starts or stops printing a field is not another account', (t) => {
  const file = scratch(t)
  const store = new ConsentStore({ file, ids: IDS, earlier: () => true })
  const onlyOrg = { kind: 'account', id: 'a', facets: { kind: 'account', org: 'org-work' } }
  const onlyEmail = { kind: 'account', id: 'b', facets: { kind: 'account', email: 'ana@work.example' } }
  // Carried on what this CLI printed then: the organisation alone.
  assert.equal(store.note('acp-claude', true, onlyOrg), 'carried')
  // An update prints the email too, another prints it alone: the same account, kept.
  assert.equal(store.note('acp-claude', true, WORK), 'carried')
  assert.equal(store.note('acp-claude', true, onlyEmail), 'carried')
  assert.equal(store.note('acp-claude', true, onlyOrg), 'carried')
  assert.deepEqual(Object.keys(stored(file).vendors['acp-claude'].account).sort(), ['email', 'kind', 'org'])
  // A field both reads have, with another value, is another account: by email, or by organisation.
  assert.equal(store.note('acp-claude', true, { kind: 'account', id: 'c', facets: { kind: 'account', email: 'bia@work.example' } }), 'needed')
  assert.equal(store.note('acp-claude', true, { kind: 'account', id: 'd', facets: { kind: 'account', org: 'org-other' } }), 'needed')
  // So is a key in the environment taking over from the person's sign-in.
  assert.equal(store.note('acp-claude', true, { kind: 'key', id: 'e', facets: { kind: 'key', source: 'key:ANTHROPIC_API_KEY' } }), 'needed')
  // A read that names nothing is no read.
  assert.equal(store.note('acp-claude', true, { kind: 'account', id: 'f', facets: {} }), 'carried')
  assert.equal(store.note('acp-claude', true, WORK), 'carried')
})

test('an upgrade read as signed out keeps the carry: a failed read never silences a Bot', (t) => {
  const file = scratch(t)
  const store = new ConsentStore({ file, ids: IDS, earlier: () => true, now: () => 3000 })
  // A CLI that cannot load its config, a locked keychain: the check says "signed out".
  assert.equal(store.note('acp-codex', false, undefined), undefined)
  assert.deepEqual(stored(file).vendors, { 'acp-claude': { carry: true }, 'acp-codex': { carry: true } })
  assert.equal(store.note('acp-codex', false, undefined), undefined)
  assert.equal(store.note('acp-codex', undefined, undefined), undefined)
  // The mark outlives a restart, whatever the connectors look like then.
  const again = new ConsentStore({ file, ids: IDS, earlier: () => false, now: () => 3000 })
  assert.equal(again.note('acp-codex', false, undefined), undefined)
  // The first signed-in read carries it, with the one-time notice.
  assert.equal(again.note('acp-codex', true, CODEX_WORK), 'carried')
  assert.equal(again.noticePending('acp-codex'), true)
  assert.deepEqual(stored(file).vendors['acp-codex'], { consent: 'carried', at: 3000, account: again.digests(CODEX_WORK) })
  // The other vendor's carry is untouched by that.
  assert.deepEqual(stored(file).vendors['acp-claude'], { carry: true })
  assert.equal(again.note('acp-claude', true, WORK), 'carried')
})

test('two processes on one home keep each other\'s word', (t) => {
  const file = scratch(t)
  // Both start on a new install, before either wrote the file: each made its own key.
  const a = new ConsentStore({ file, ids: IDS, now: () => 1 })
  const b = new ConsentStore({ file, ids: IDS, now: () => 2 })
  assert.equal(a.note('acp-claude', true, WORK), 'needed')
  assert.equal(b.note('acp-codex', true, CODEX_WORK), 'needed')
  a.confirm('acp-claude', WORK)
  // B writes for Codex after A wrote for Claude: A's word stays, under the file's one key.
  b.confirm('acp-codex', CODEX_WORK)
  assert.equal(stored(file).key, a.key)
  assert.equal(b.key, a.key)
  assert.deepEqual(stored(file).vendors, {
    'acp-claude': { consent: 'given', at: 1, account: a.digests(WORK) },
    'acp-codex': { consent: 'given', at: 2, account: a.digests(CODEX_WORK) },
  })
  // Each sees the other's word without a restart, and so does the next start.
  assert.equal(b.note('acp-claude', true, WORK), 'given')
  assert.equal(b.note('acp-claude', true, HOME), 'needed')
  assert.equal(a.note('acp-codex', true, CODEX_WORK), 'given')
  const next = new ConsentStore({ file, ids: IDS })
  assert.equal(next.note('acp-claude', true, WORK), 'given')
  assert.equal(next.note('acp-codex', true, CODEX_WORK), 'given')
  assert.equal(next.note('acp-codex', true, CODEX_OTHER), 'needed')
  // A notice acknowledged in one process does not undo a word given in the other.
  const c = new ConsentStore({ file: scratch(t), ids: IDS, earlier: () => true })
  const d = new ConsentStore({ file: c.file, ids: IDS, earlier: () => true })
  assert.equal(c.note('acp-claude', true, WORK), 'carried')
  assert.equal(d.note('acp-claude', true, WORK), 'carried')
  d.confirm('acp-claude', WORK)
  c.noticed('acp-claude')
  assert.equal(stored(c.file).vendors['acp-claude'].consent, 'given')
  // A digest made under a key the file did not keep goes; the next read records it again.
  const e = new ConsentStore({ file: scratch(t), ids: IDS })
  const f = new ConsentStore({ file: e.file, ids: IDS })
  e.vendors['acp-claude'] = { consent: 'given', at: 1, account: e.digests(WORK) }
  e.dirty.add('acp-claude')
  f.settle()
  e.save()
  assert.equal(e.key, f.key)
  assert.deepEqual(stored(e.file).vendors['acp-claude'], { consent: 'given', at: 1 })
  assert.equal(e.note('acp-claude', true, WORK), 'given')
  assert.deepEqual(stored(e.file).vendors['acp-claude'].account, e.digests(WORK))
})

test('the first-run record is on disk before a connector install, so a later start cannot carry', (t) => {
  const file = scratch(t)
  const fresh = new ConsentStore({ file, ids: IDS, earlier: () => false })
  fresh.settle()
  assert.deepEqual(stored(file).vendors, {})
  // By the next start the connector is installed; the record says this version installed it.
  const next = new ConsentStore({ file, ids: IDS, earlier: () => true })
  assert.equal(next.note('acp-claude', true, WORK), 'needed')
})

test('an unreadable record reads as a first run, and fields a newer version wrote are kept', (t) => {
  const file = scratch(t)
  new ConsentStore({ file, ids: IDS }).settle()
  writeFileSync(file, '{ not json')
  const logs = []
  const broken = new ConsentStore({ file, ids: IDS, earlier: () => true, log: line => logs.push(line) })
  assert.equal(logs.length, 1)
  // Read as the first run of an install an earlier version made: its Bots keep working.
  assert.equal(broken.note('acp-claude', true, WORK), 'carried')
  const doc = stored(file)
  writeFileSync(file, JSON.stringify({ ...doc, later: { mode: 'own' }, vendors: { ...doc.vendors, 'acp-codex': { consent: 'odd', account: 5 }, 'acp-other': { consent: 'given' } } }))
  assert.deepEqual(Object.keys(doc.vendors['acp-claude'].account).sort(), ['email', 'kind', 'org'])
  const again = new ConsentStore({ file, ids: IDS })
  assert.equal(again.note('acp-claude', true, WORK), 'carried')
  assert.equal(again.note('acp-codex', true, CODEX_WORK), 'needed')
  again.confirm('acp-codex', CODEX_WORK)
  assert.deepEqual(stored(file).later, { mode: 'own' })
})

// The acpAgents service over fakes, as status.test.js builds it, with a record file.
// `home` is the fake adapter store's folder and `update` its install; an `accounts` entry that
// is a function is called for each read (a read that is slow, or never answers).
function harness(t, { clis = { claude: '/bin/claude', codex: '/bin/codex' }, signedIn = {}, accounts = {}, bins = {}, file = scratch(t), config = { claude: true, codex: true }, extra = {}, home, update = async () => {} } = {}) {
  const emitted = []
  const logs = []
  const listeners = new Map()
  const services = {}
  const registered = {}
  const ctx = {
    logger: { warn: message => logs.push(message), info: message => logs.push(message) },
    llm: {
      registerAdapter(providers, adapter) { registered.adapter = adapter; return Object.assign(() => {}, { replace() {} }) },
      listProviders: () => Object.keys(AGENTS).map(id => ({ id, name: id })),
      listModels: () => new Promise(() => {}),
    },
    agents: { get: () => ({ status: 'idle', ctx: { tools: { register: () => () => {} } }, session: { header: {} } }), list: () => [] },
    get: () => undefined,
    provide: (name, value) => { services[name] = value },
    on: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    effect: (setup) => { const cleanup = setup(); listeners.set('stop', [...(listeners.get('stop') ?? []), cleanup]) },
    emit: (name, ...args) => { emitted.push([name, ...args]); for (const listener of listeners.get(name) ?? []) listener(...args) },
  }
  const spawned = []
  const store = { binOf: pkg => bins[pkg], busy: () => false, lastError: () => undefined, lastFailure: () => undefined, update: async (...args) => update(...args), dispose() {}, ...(home === undefined ? {} : { home }) }
  const probes = []
  const reads = []
  apply(ctx, config, {
    store,
    cliStore: undefined,
    find: name => clis[name],
    signedIn: async (spec) => { probes.push(spec.key); return signedIn[spec.key] },
    account: async (spec, cli, options) => { reads.push({ key: spec.key, cli, env: options.env }); const seen = accounts[spec.key]; if (seen instanceof Error) throw seen; return typeof seen === 'function' ? seen() : seen },
    consentFile: file ?? undefined,
    imageSetup: async () => ({ ok: true }),
    ...extra,
  })
  t.after(() => ctx.emit('stop'))
  return { ctx, service: services[SERVICE], emitted, logs, probes, reads, file, signedIn, accounts, bins, registered, spawned }
}
const ready = () => ({ [CLAUDE.adapter]: { path: '/adapters/claude', version: '1' }, [CODEX.adapter]: { path: '/adapters/codex', version: '1' } })
const lateBins = (h) => { Object.assign(h.bins, ready()) }
const settle = async () => { for (let turn = 0; turn < 6; turn++) await new Promise(resolve => setImmediate(resolve)) }
const loginReady = h => h.emitted.filter(([name]) => name === 'acp-dsh/login-ready').map(([, value]) => value)

test('a signed-in terminal on a new install: the row says consent is needed, and never who', async (t) => {
  const h = harness(t, { signedIn: { claude: true, codex: true }, accounts: { claude: WORK, codex: CODEX_WORK } })
  lateBins(h)
  const row = await h.service.inspect('acp-claude')
  assert.equal(row.signedIn, true)
  assert.equal(row.consent, 'needed')
  // Who it is rides on no status or inspect row, in no event and in no log.
  const everything = JSON.stringify([row, await h.service.status(), await h.service.refresh(), h.emitted, h.logs])
  for (const secret of ['ana@work.example', 'Acme', 'org-work', 'business']) assert.equal(everything.includes(secret), false, secret)
  // The account read gets the environment the sign-in check got.
  assert.equal(h.reads[0].cli, '/bin/claude')
  assert.equal(h.reads[0].env.PATH, process.env.PATH)
  // The owner's own call says who, and that it waits for their word.
  assert.deepEqual(await h.service.account('acp-claude'), { id: 'acp-claude', signedIn: true, consent: 'needed', ref: (await h.service.account('acp-claude')).ref, account: { kind: 'account', email: 'ana@work.example', org: 'Acme', plan: 'team' } })
  assert.match((await h.service.account('acp-claude')).ref, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(await h.service.account('nope'), undefined)
})

test('a turn on an unconfirmed account is refused before any process starts, as MODEL_ACCESS_REQUIRED', async (t) => {
  const h = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK } })
  lateBins(h)
  const adapter = h.registered.adapter
  // No probe ran yet: the first turn asks the CLI before it answers.
  const events = []
  for await (const event of adapter.stream({ provider: 'acp-claude', model: 'default', sessionId: 's1', messages: [{ role: 'user', content: 'hi' }] })) events.push(event)
  assert.equal(events.length, 1)
  assert.equal(events[0].reason.failure.code, MODEL_ACCESS_REQUIRED)
  // The Bot team's own refusal text, so its row is translated (bots-dsh HOST_TEMPLATES).
  assert.equal(events[0].reason.failure.message, 'Confirm the account of Claude Code before using this model.')
  assert.equal(events[0].reason.failure.message.includes('ana@work.example'), false)
  assert.deepEqual(h.probes, ['claude'])
  // After the person's word, the gate is silent.
  await h.service.accountConfirm('acp-claude')
  assert.equal(await adapter.access('acp-claude'), undefined)
  // The terminal moves to another account: refused again, and the text says it changed.
  h.accounts.claude = HOME
  await h.service.refresh()
  assert.equal(await adapter.access('acp-claude'), 'Confirm the account of Claude Code before using this model.')
  // A route that is no vendor CLI (the test agent) is never asked.
  assert.equal(await adapter.access('acp-fake'), undefined)
})

test('"Use this account": the word is recorded for the account shown, and the agent is announced ready', async (t) => {
  const h = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK } })
  lateBins(h)
  const shown = await h.service.account('acp-claude', { fresh: true })
  assert.equal(shown.consent, 'needed')
  assert.deepEqual(loginReady(h), [])
  // Another account signed in between the card and the click is not what the person agreed to.
  h.accounts.claude = HOME
  await assert.rejects(h.service.accountConfirm('acp-claude', { ref: shown.ref }), error => error.code === 'acp-account/changed')
  assert.equal((await h.service.inspect('acp-claude')).consent, 'needed')
  assert.deepEqual(loginReady(h), [])
  h.accounts.claude = WORK
  assert.deepEqual(await h.service.accountConfirm('acp-claude', { ref: shown.ref }), { id: 'acp-claude', signedIn: true, consent: 'given' })
  assert.deepEqual(loginReady(h), [{ id: 'acp-claude' }])
  assert.equal((await h.service.inspect('acp-claude')).consent, 'given')
  assert.equal(stored(h.file).vendors['acp-claude'].consent, 'given')
  // A signed-out CLI has nothing to confirm; an unknown agent is refused.
  h.signedIn.codex = false
  await assert.rejects(h.service.accountConfirm('acp-codex'), error => error.code === 'acp-account/signed-out')
  await assert.rejects(h.service.accountConfirm('nope'), error => error.code === 'acp-account/invalid')
})

test('an account the CLI does not show can still be confirmed, and is bound to the first one read', async (t) => {
  const h = harness(t, { signedIn: { codex: true }, accounts: {} })
  lateBins(h)
  const shown = await h.service.account('acp-codex')
  assert.deepEqual(shown, { id: 'acp-codex', signedIn: true, consent: 'needed', ref: 'unknown' })
  await h.service.accountConfirm('acp-codex', { ref: 'unknown' })
  assert.equal((await h.service.inspect('acp-codex')).consent, 'given')
  h.accounts.codex = CODEX_WORK
  assert.equal((await h.service.refresh()).agents.find(row => row.id === 'acp-codex').consent, 'given')
  h.accounts.codex = CODEX_OTHER
  assert.equal((await h.service.refresh()).agents.find(row => row.id === 'acp-codex').consent, 'needed')
})

test('upgrade: a vendor already signed in keeps working, through a failed account read too', async (t) => {
  // An earlier version installed the connectors: they are there before this one first starts.
  const h = harness(t, { signedIn: { claude: true, codex: true }, accounts: { claude: new Error('the CLI did not answer') }, bins: ready() })
  const adapter = h.registered.adapter
  assert.equal(await adapter.access('acp-claude'), undefined)
  assert.equal((await h.service.inspect('acp-claude')).consent, 'carried')
  assert.equal((await h.service.inspect('acp-codex')).consent, 'carried')
  assert.deepEqual(await h.service.imageAccess(), { ready: true, signedIn: true })
  // The owner's call says the one-time notice is due, and shows no account while none is read.
  assert.deepEqual(await h.service.account('acp-claude'), { id: 'acp-claude', signedIn: true, consent: 'carried', ref: 'unknown', notice: true })
  // The account is recorded once it can be read; the vendor stays carried, with or without it.
  h.accounts.claude = WORK
  assert.equal((await h.service.refresh()).agents.find(row => row.id === 'acp-claude').consent, 'carried')
  assert.match(stored(h.file).vendors['acp-claude'].account.email, /^[A-Za-z0-9_-]{43}$/)
  h.accounts.claude = new Error('again')
  assert.equal((await h.service.refresh()).agents.find(row => row.id === 'acp-claude').consent, 'carried')
  assert.equal(await adapter.access('acp-claude'), undefined)
  // (The gate read the CLI again in the background; let that read land first.)
  await settle()
  // A sign-in check that fails (unknown) asks nothing either: as before, the agent decides.
  h.signedIn.claude = undefined
  const unknown = (await h.service.refresh()).agents.find(row => row.id === 'acp-claude')
  assert.equal(unknown.signedIn, undefined)
  assert.equal(unknown.consent, undefined)
  assert.equal(await adapter.access('acp-claude'), undefined)
  // The notice is acknowledged once.
  h.signedIn.claude = true
  h.accounts.claude = WORK
  h.service.accountNoticed('acp-claude')
  assert.equal((await h.service.account('acp-claude', { fresh: true })).notice, undefined)
  assert.equal((await h.service.account('acp-claude')).account.email, 'ana@work.example')
  // A restart of the upgraded install reads the same record.
  const again = harness(t, { signedIn: { claude: true, codex: true }, accounts: { claude: WORK }, bins: ready(), file: h.file })
  assert.equal((await again.service.inspect('acp-claude')).consent, 'carried')
  assert.equal((await again.service.account('acp-claude')).notice, undefined)
})

test('images honour the consent: no image on an unconfirmed Codex account, and one after the word', async (t) => {
  const h = harness(t, { signedIn: { codex: true }, accounts: { codex: CODEX_WORK }, config: { claude: false, codex: true } })
  lateBins(h)
  assert.deepEqual(await h.service.imageAccess(), { ready: false, signedIn: true, reason: 'account' })
  await assert.rejects(h.service.generateImage({ prompt: 'a fox' }), error => error.code === UNAVAILABLE && /have not confirmed its account/.test(error.message) && !error.message.includes('ana@work.example'))
  await h.service.accountConfirm('acp-codex')
  assert.deepEqual(await h.service.imageAccess(), { ready: true, signedIn: true })
  // Another account in the terminal stops the images again.
  h.accounts.codex = CODEX_OTHER
  await h.service.refresh()
  assert.deepEqual(await h.service.imageAccess(), { ready: false, signedIn: true, reason: 'account' })
})

// A sign-in attempt over a fake CLI process (status.test.js's), to tell a sign-in the person
// made in the app from a CLI that was already signed in.
function loginFakes() {
  const children = []
  const timers = { now: () => 5_000_000, setTimeout: () => ({ unref() {} }), clearTimeout() {} }
  const loginSpawn = (file, args) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.writes = []
    child.stdin.on('data', chunk => child.writes.push(String(chunk)))
    child.kill = () => true
    children.push({ file, args, child })
    return child
  }
  return { children, extra: { loginSpawn, loginTimers: timers } }
}

test('loginStart on a CLI already signed in gives no consent and announces nothing', async (t) => {
  const fakes = loginFakes()
  const h = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, extra: fakes.extra })
  lateBins(h)
  const started = h.service.loginStart('acp-claude', { label: 'a-bot' })
  await settle()
  // The existing shortcut still ends the attempt ready, with no sign-in process.
  assert.equal(h.service.loginStatus('acp-claude', started.attemptId).status, 'ready')
  assert.equal(fakes.children.length, 0)
  // But nobody signed in here: the account still waits for the person, and no model is applied.
  assert.deepEqual(loginReady(h), [])
  assert.equal((await h.service.inspect('acp-claude')).consent, 'needed')
})

test('a sign-in the person makes in the app is their word for that account', async (t) => {
  const fakes = loginFakes()
  const h = harness(t, { signedIn: { codex: false }, accounts: {}, config: { claude: false, codex: true }, extra: fakes.extra })
  lateBins(h)
  assert.equal((await h.service.inspect('acp-codex')).signedIn, false)
  const started = h.service.loginStart('acp-codex', { label: 'a-bot' })
  await settle()
  const { child } = fakes.children[0]
  const sent = () => child.writes.flatMap(chunk => chunk.trim().split('\n')).filter(Boolean).map(line => JSON.parse(line))
  child.stdout.write(`${JSON.stringify({ id: sent()[0].id, result: {} })}\n`)
  await settle()
  const login = sent().find(row => row.method === 'account/login/start')
  child.stdout.write(`${JSON.stringify({ id: login.id, result: { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } })}\n`)
  await settle()
  h.signedIn.codex = true
  h.accounts.codex = CODEX_WORK
  child.stdout.write(`${JSON.stringify({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } })}\n`)
  await settle()
  assert.equal(h.service.loginStatus('acp-codex', started.attemptId).status, 'ready')
  assert.deepEqual(loginReady(h), [{ id: 'acp-codex' }])
  assert.equal((await h.service.inspect('acp-codex')).consent, 'given')
  assert.equal(stored(h.file).vendors['acp-codex'].consent, 'given')
})

test('without a record file nothing is asked and no account is read: the service is as before', async (t) => {
  const h = harness(t, { signedIn: { claude: true, codex: true }, accounts: { claude: WORK }, file: null })
  lateBins(h)
  const row = await h.service.inspect('acp-claude')
  assert.equal(row.signedIn, true)
  assert.equal(Object.hasOwn(row, 'consent'), false)
  assert.deepEqual(h.reads, [])
  assert.equal(await h.registered.adapter.access('acp-claude'), undefined)
  assert.deepEqual(await h.service.imageAccess(), { ready: true, signedIn: true })
  assert.deepEqual(await h.service.account('acp-claude'), { id: 'acp-claude', signedIn: true })
  await assert.rejects(h.service.accountConfirm('acp-claude'), error => error.code === 'acp-account/unavailable')
})

test('upgrade: a first check that says "signed out" keeps the Bot working once the CLI reads signed in', async (t) => {
  // Codex cannot load its config when the app starts: `login status` exits as signed out.
  const h = harness(t, { signedIn: { claude: true, codex: false }, accounts: { claude: WORK, codex: CODEX_WORK }, bins: ready() })
  const first = await h.service.inspect('acp-codex')
  assert.equal(first.signedIn, false)
  assert.equal(Object.hasOwn(first, 'consent'), false)
  assert.equal((await h.service.refresh()).agents.find(row => row.id === 'acp-codex').signedIn, false)
  // The config is fixed (or the keychain unlocked): carried, never "confirm the account".
  h.signedIn.codex = true
  assert.equal((await h.service.refresh()).agents.find(row => row.id === 'acp-codex').consent, 'carried')
  assert.equal(await h.registered.adapter.access('acp-codex'), undefined)
  assert.deepEqual(await h.service.imageAccess(), { ready: true, signedIn: true })
  assert.equal((await h.service.account('acp-codex')).notice, true)
  // And across a restart in between.
  const down = harness(t, { signedIn: { claude: false }, accounts: { claude: WORK }, bins: ready() })
  assert.equal((await down.service.inspect('acp-claude')).signedIn, false)
  const up = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, bins: ready(), file: down.file })
  assert.equal((await up.service.inspect('acp-claude')).consent, 'carried')
  assert.equal(await up.registered.adapter.access('acp-claude'), undefined)
})

test('each installation keeps its account record inside its isolated CLI root', async t => {
  const root = mkdtempSync(join(tmpdir(), 'acp-dsh-consent-home-'))
  const before = process.env.AUTOMAGIK_HOME
  process.env.AUTOMAGIK_HOME = root
  t.after(() => {
    if (before === undefined) delete process.env.AUTOMAGIK_HOME
    else process.env.AUTOMAGIK_HOME = before
    rmSync(root, { recursive: true, force: true })
  })
  // No `consentFile`: the default, as the app runs it.
  const h = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, file: null, home: adaptersHome() })
  lateBins(h)
  assert.equal((await h.service.inspect('acp-claude')).consent, 'needed')
  assert.match(await h.registered.adapter.access('acp-claude'), /Confirm the account of Claude Code/)
  const file = join(root, 'acp', 'cli-homes', CONSENT_FILE)
  assert.equal(dirname(file), join(dirname(adaptersHome()), 'cli-homes'))
  assert.deepEqual(stored(file).vendors, {})
  // Another installation gets its own record; it cannot inherit the first one's consent.
  const other = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, file: null, home: join(root, 'elsewhere', 'adapters') })
  lateBins(other)
  assert.equal((await other.service.inspect('acp-claude')).consent, 'needed')
  assert.equal(existsSync(join(root, 'elsewhere', CONSENT_FILE)), false)
  assert.deepEqual(stored(join(root, 'elsewhere', 'cli-homes', CONSENT_FILE)).vendors, {})
})

test('a connector is installed only once the first-run record is on disk', async (t) => {
  const file = scratch(t)
  const seen = []
  const h = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, file, update: async (pkg) => { seen.push([pkg, existsSync(file)]) } })
  await h.service.retry('acp-claude')
  await settle()
  assert.deepEqual(seen, [[CLAUDE.adapter, true]])
  // The next start finds the connector and the record: this version installed it, so it asks.
  const next = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, bins: ready(), file })
  assert.equal((await next.service.inspect('acp-claude')).consent, 'needed')
  // A record that cannot be written: no connector is installed, so no later start can take a
  // new install for an upgrade and carry its vendors unasked.
  const blocker = join(dirname(dirname(scratch(t))), 'blocker')
  writeFileSync(blocker, '')
  const stuck = []
  const blocked = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, file: join(blocker, 'acp', CONSENT_FILE), update: async pkg => { stuck.push(pkg) } })
  await blocked.service.retry('acp-claude')
  await settle()
  assert.deepEqual(stuck, [])
  assert.ok(blocked.logs.some(line => /not installed yet: the account record could not be saved/.test(line)))
  // A connector an earlier version installed is still kept up to date.
  const upgraded = harness(t, { signedIn: { claude: true }, accounts: { claude: WORK }, bins: ready(), file: join(blocker, 'acp', CONSENT_FILE), update: async pkg => { stuck.push(pkg) } })
  await upgraded.service.retry('acp-claude')
  await settle()
  assert.deepEqual(stuck, [CLAUDE.adapter])
  assert.equal((await upgraded.service.inspect('acp-claude')).consent, 'carried')
})

test('a consented agent never waits on the account read, and another account stops the next turn', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const h = harness(t, { signedIn: { codex: true }, accounts: { codex: CODEX_WORK }, config: { claude: false, codex: true } })
  lateBins(h)
  const adapter = h.registered.adapter
  // The first read of a process is waited for: no turn opens on an account nobody has read.
  assert.match(await adapter.access('acp-codex'), /Confirm the account of Codex/)
  await h.service.accountConfirm('acp-codex')
  assert.equal(await adapter.access('acp-codex'), undefined)
  // The terminal moves to another account. Until the sign-in is read again (SIGNED_IN_TTL_MS),
  // the last read answers: this is the bound, and it is not hidden.
  let land
  h.accounts.codex = () => new Promise((resolve) => { land = resolve })
  const reads = h.reads.length
  t.mock.timers.tick(SIGNED_IN_TTL_MS - 1)
  assert.equal(await adapter.access('acp-codex'), undefined)
  await settle()
  assert.equal(h.reads.length, reads)
  // Past it, the turn that asks is answered at once and the CLI is read behind it.
  t.mock.timers.tick(1)
  assert.equal(await adapter.access('acp-codex'), undefined)
  await settle()
  assert.equal(h.reads.length, reads + 1)
  // A status or a pick does not wait for that read either (Codex's is an app-server).
  const unwaited = async () => (await Promise.race([h.service.inspect('acp-codex'), settle().then(() => ({ consent: 'waited' }))])).consent
  assert.equal(await unwaited(), 'given')
  assert.equal(typeof land, 'function')
  // The read lands: the next turn is refused, the row says so, and no image is drawn.
  land(CODEX_OTHER)
  await settle()
  assert.match(await adapter.access('acp-codex'), /Confirm the account of Codex/)
  assert.equal((await h.service.status()).agents.find(row => row.id === 'acp-codex').consent, 'needed')
  assert.deepEqual(await h.service.imageAccess(), { ready: false, signedIn: true, reason: 'account' })
  // While it waits for the person every read is waited for, so the first account coming back
  // needs nothing, on the very next turn.
  h.accounts.codex = CODEX_WORK
  t.mock.timers.tick(SIGNED_IN_TTL_MS)
  assert.equal(await adapter.access('acp-codex'), undefined)
  // Two reads behind two checks: the older one, landing last, does not undo the newer.
  const landing = []
  h.accounts.codex = () => new Promise((resolve) => { landing.push(resolve) })
  t.mock.timers.tick(SIGNED_IN_TTL_MS)
  assert.equal(await unwaited(), 'given')
  t.mock.timers.tick(SIGNED_IN_TTL_MS)
  assert.equal(await unwaited(), 'given')
  assert.equal(landing.length, 2)
  landing[1](CODEX_OTHER)
  await settle()
  landing[0](CODEX_WORK)
  await settle()
  assert.equal((await h.service.status()).agents.find(row => row.id === 'acp-codex').consent, 'needed')
  h.accounts.codex = CODEX_WORK
  assert.equal((await h.service.refresh()).agents.find(row => row.id === 'acp-codex').consent, 'given')
  // A read that lands after a sign-out says nothing.
  h.accounts.codex = () => new Promise((resolve) => { land = resolve })
  t.mock.timers.tick(SIGNED_IN_TTL_MS)
  assert.equal(await unwaited(), 'given')
  h.signedIn.codex = false
  t.mock.timers.tick(SIGNED_IN_TTL_MS)
  assert.equal((await h.service.inspect('acp-codex')).signedIn, false)
  land(CODEX_OTHER)
  await settle()
  const out = (await h.service.status()).agents.find(row => row.id === 'acp-codex')
  assert.equal(out.signedIn, false)
  assert.equal(Object.hasOwn(out, 'consent'), false)
})

for (const phase of ['launch preparation', 'the first prompt gate']) {
  test(`D2b round 2 a background account withdrawal during ${phase} stops startup`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const id = 'acp-codex'
    const h = harness(t, {
      signedIn: { codex: true }, accounts: { codex: CODEX_WORK },
      config: { claude: false, codex: true, dshTools: true },
    })
    lateBins(h)
    const adapter = h.registered.adapter
    const agent = h.ctx.agents.get()
    h.ctx.agents.get = () => agent
    assert.match(await adapter.access(id), /Confirm the account of Codex/)
    await h.service.accountConfirm(id)

    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const wait = async () => { entered.resolve(); await release.promise }
    t.mock.method(adapter.agents.get(id), 'spawn', async () => {
      if (phase === 'launch preparation') await wait()
      return { command: 'fake-acp' }
    })
    t.mock.method(adapter.backchannel, 'listen', async () => {})
    const mint = t.mock.method(adapter.backchannel, 'mint')
    const launch = t.mock.method(AgentRun.prototype, 'start', async function () {
      this.child = {}
      this.sessionId = 'fake-acp-session'
      this.options = []
    })
    t.mock.method(AgentRun.prototype, 'setMode', async () => {})
    const prompt = t.mock.method(AgentRun.prototype, 'prompt', async function () {
      this.promptEnded = true
      this.push({ type: 'end', stopReason: 'end_turn' })
    })
    let gates = 0
    adapter.holds = () => [async () => {
      if (++gates === 2 && phase === 'the first prompt gate') await wait()
    }]
    const account = Promise.withResolvers()
    h.accounts.codex = () => account.promise
    t.mock.timers.tick(SIGNED_IN_TTL_MS)
    const turn = Array.fromAsync(adapter.stream({
      provider: id, sessionId: 'chat', model: 'default',
      messages: [{ id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fake prompt' }] }],
    }))
    await Promise.race([entered.promise, turn.then(chunks => {
      assert.fail(`startup ended before ${phase}: ${JSON.stringify(chunks.at(-1).reason)}`)
    })])
    const expectedStarts = phase === 'launch preparation' ? 0 : 1
    assert.equal(launch.mock.callCount(), expectedStarts)
    const live = adapter.live.get('chat')
    account.resolve(CODEX_OTHER)
    await settle()
    assert.equal((await h.service.status()).agents.find(row => row.id === id).consent, 'needed')
    release.resolve()
    const chunks = await turn

    assert.deepEqual([mint, launch, prompt].map(mock => mock.mock.callCount()), [expectedStarts, expectedStarts, 0])
    assert.equal(chunks.at(-1).reason.failure?.code, MODEL_ACCESS_REQUIRED)
    assert.equal(adapter.live.has('chat'), false)
    if (live !== undefined) {
      assert.equal(live.run.alive, false)
      assert.equal(live.bridge.closed, true)
    }
  })
}

test('C1: sameAccount names only the account the record holds; Claude needs its email on both sides', (t) => {
  const file = scratch(t)
  const store = new ConsentStore({ file, ids: IDS, now: () => 1000 })
  const who = email => ({ kind: 'account', id: email, facets: { kind: 'account', email }, email })
  assert.equal(store.sameAccount('acp-codex', who('a@x.example')), false, 'no record')
  store.confirm('acp-codex', who('a@x.example'))
  assert.equal(store.sameAccount('acp-codex', who('a@x.example')), true)
  assert.equal(store.sameAccount('acp-codex', who('b@x.example')), false)
  assert.equal(store.sameAccount('acp-codex', { kind: 'account', id: 'x', facets: { kind: 'account' } }), false, 'kind alone names nobody')
  assert.equal(store.sameAccount('acp-codex', undefined), false)
  assert.equal(store.sameAccount('acp-unknown', who('a@x.example')), false, 'an unknown id')
  // A key: the same `source` is the same key for Codex.
  const key = { kind: 'key', id: 'k', facets: { kind: 'key', source: 'env:OPENAI_API_KEY' } }
  store.confirm('acp-codex', key)
  assert.equal(store.sameAccount('acp-codex', key), true)
  // Claude: the email facet on both sides, never the org alone or a key's source.
  store.confirm('acp-claude', WORK)
  assert.equal(store.sameAccount('acp-claude', WORK), true)
  assert.equal(store.sameAccount('acp-claude', HOME), false)
  const orgOnly = { kind: 'account', id: 'o', facets: { kind: 'account', org: 'org-work' } }
  assert.equal(store.sameAccount('acp-claude', orgOnly), false)
  const claudeKey = { kind: 'key', id: 'ck', facets: { kind: 'key', source: 'env:ANTHROPIC_API_KEY' } }
  store.confirm('acp-claude', claudeKey)
  assert.equal(store.sameAccount('acp-claude', claudeKey), false)
})

const RECONFIRM_CODEX = 'Confirm the account of Codex before using this model.'

async function reforkAccountFixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const provider = 'acp-codex'
  const id = 'chat'
  const h = harness(t, {
    signedIn: { codex: true }, accounts: { codex: CODEX_WORK },
    config: { claude: false, codex: true, dshTools: true },
  })
  lateBins(h)
  const adapter = h.registered.adapter
  const session = Session.create(id)
  const originalAgent = { ...h.ctx.agents.get(), id, session }
  let agent = originalAgent
  h.ctx.agents.get = sessionId => sessionId === id ? agent : undefined
  h.ctx.sessions = new Map([[id, session]])
  let catalog = { key: 'first', text: 'First fake Skills catalog' }
  const skillCalls = { available: () => true, catalog: () => catalog, project: options => options }
  const tools = { definitions: () => [{ name: 'load_skill', description: 'Load a fake Skill' }] }
  h.ctx.get = name => name === 'omniTeam' ? { skillCalls } : name === 'tools' ? tools : undefined
  assert.equal(await adapter.access(provider), RECONFIRM_CODEX)
  await h.service.accountConfirm(provider)

  t.mock.method(adapter.agents.get(provider), 'spawn', () => ({ command: 'fake-acp' }))
  t.mock.method(adapter.backchannel, 'listen', async () => {})
  const mint = t.mock.method(adapter.backchannel, 'mint')
  const announced = t.mock.method(adapter.backchannel, 'announce')
  const refork = t.mock.method(adapter, 'refork')
  const accountRead = Promise.withResolvers()
  const freshAccount = Promise.withResolvers()
  const paused = Promise.withResolvers()
  const release = Promise.withResolvers()
  let phase
  let modeError
  let changedTools = false
  let originalBridge
  const pause = async () => { paused.resolve(); await release.promise }
  const renewals = []
  const forks = []
  const requests = []
  const firstLists = []
  async function list(record) {
    const request = Object.assign(Readable.from([Buffer.from('{"op":"list"}')]), {
      method: 'POST', url: record.path,
      headers: { authorization: `Bearer ${record.credential}`, 'x-dsh-bridge-attachment': '0'.repeat(32) },
    })
    let status
    let answer
    await adapter.backchannel.handle(request, {
      writeHead: code => { status = code }, end: body => { answer = JSON.parse(body) },
    })
    assert.equal(status, 200)
    return { tools: answer.tools.map(tool => tool.name), listed: record.listed, announced: record.announced }
  }
  t.mock.method(adapter.backchannel, 'refresh', record => changedTools && record === originalBridge)
  const launch = t.mock.method(AgentRun.prototype, 'start', async function () {
    this.child = {}
    this.sessionId = `fake-start-${launch.mock.callCount() + 1}`
    this.options = []
    const replacement = async (route, params, calls) => {
      calls.push(params.mcpServers.length)
      if (phase === 'request') await pause()
      firstLists.push(await list(mint.mock.calls.at(-1).result))
      requests.push(route)
      return { sessionId: `fake-${route}` }
    }
    this.conn = {
      cancel: async () => { await pause(); this.prompting = undefined },
      newSession: params => replacement('renewal', params, renewals),
      forkSession: params => replacement('fork', params, forks),
    }
    await list(mint.mock.calls.at(-1).result)
    await this.spec.onReady?.(this)
  })
  t.mock.method(AgentRun.prototype, 'setMode', async () => {
    if (phase !== 'mode') return
    await pause()
    if (modeError) throw new Error('fake mode failure')
  })
  const prompt = t.mock.method(AgentRun.prototype, 'prompt', async function () {
    this.promptEnded = true
    this.push({ type: 'end', stopReason: 'end_turn' })
  })
  const stream = text => Array.fromAsync(adapter.stream({
    provider, sessionId: id, model: 'default',
    messages: [{ id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  })).then(chunks => chunks.at(-1)?.reason)
  assert.equal((await stream('Warm the catalog')).kind, 'stop')
  const live = adapter.live.get(id)
  assert.equal(live.skillCatalog, 'first')
  assert.equal(live.run.alive, true)
  originalBridge = live.bridge
  assert.equal(originalBridge.closed, false)
  assert.deepEqual([launch, mint, prompt, announced].map(spy => spy.mock.callCount()), [1, 1, 1, 1])

  async function attempt({ skills, tools, at, account = CODEX_OTHER, failMode = false, replaceAgent = false }) {
    phase = at
    modeError = failMode
    changedTools = tools
    if (replaceAgent) agent = { ...originalAgent }
    if (skills) catalog = { key: 'changed', text: 'Changed fake Skills catalog' }
    if (at === 'before mint') live.run.prompting = release.promise
    h.accounts.codex = () => { accountRead.resolve(); return freshAccount.promise }
    t.mock.timers.tick(SIGNED_IN_TTL_MS)
    const turn = stream('Turn needing a replacement')
    try {
      await Promise.race([Promise.all([paused.promise, accountRead.promise]), turn.then(reason => {
        assert.fail(`Turn finished before ${at}: ${JSON.stringify(reason)}`)
      })])
      assert.equal((await h.service.status()).agents.find(row => row.id === provider).consent, 'given')
      assert.equal(adapter.live.get(id), live)
      assert.equal(mint.mock.callCount(), at === 'before mint' ? 1 : 2)
      freshAccount.resolve(account)
      await settle()
      assert.equal((await h.service.status()).agents.find(row => row.id === provider).consent,
        account === CODEX_WORK ? 'given' : 'needed')
    } finally {
      freshAccount.resolve(account)
      release.resolve()
    }
    return turn
  }
  const counts = () => ({
    starts: launch.mock.callCount(), mints: mint.mock.callCount() - 1,
    renewals, forks, reforks: refork.mock.callCount(), prompts: prompt.mock.callCount(),
  })
  const ended = () => {
    assert.equal(adapter.live.has(id), false)
    assert.equal(live.run.alive, false)
    assert.equal(originalBridge.closed, true)
    assert.equal(adapter.backchannel.records.has(originalBridge.credential), false)
  }
  const replacement = () => mint.mock.calls[1]?.result
  const publications = () => announced.mock.calls.slice(1).map(call => call.arguments[0])
  const reconfirm = () => h.service.accountConfirm(provider)
  return { attempt, counts, ended, firstLists, live, publications, replacement, reconfirm, requests, stream }
}

function assertAccountRefused(reason) {
  assert.deepEqual(reason, { kind: 'error', failure: { code: MODEL_ACCESS_REQUIRED, message: RECONFIRM_CODEX } })
}

for (const [label, route] of [['R1', 'Skills renewal'], ['T1', 'DSH-tools fork'], ['AD-2', 'Skills renewal']]) {
  test(`${label}: withdrawal before mint retires the warmed ${route} run`, { timeout: 5000 }, async t => {
    const h = await reforkAccountFixture(t)
    const reason = await h.attempt({
      skills: route === 'Skills renewal', tools: route === 'DSH-tools fork',
      at: 'before mint', replaceAgent: label === 'AD-2',
    })
    assert.deepEqual(h.counts(), { starts: 1, mints: 0, renewals: [], forks: [], reforks: 0, prompts: 1 })
    assertAccountRefused(reason)
    h.ended()
  })
}

for (const [label, skills] of [['R2', true], ['T2', false]]) {
  test(`${label}: an eligible account publishes the replacement bridge and prompts`, { timeout: 5000 }, async t => {
    const h = await reforkAccountFixture(t)
    const reason = await h.attempt({ skills, tools: !skills, at: 'before mint', account: CODEX_WORK })
    assert.deepEqual(h.counts(), {
      starts: 1, mints: 1, renewals: skills ? [1] : [], forks: skills ? [] : [1], reforks: 1, prompts: 2,
    })
    assert.equal(reason.kind, 'stop')
    assert.deepEqual(h.firstLists, [{ tools: ['load_skill'], listed: true, announced: false }])
    assert.deepEqual(h.publications(), [h.replacement()])
    assert.equal(h.replacement().listed, true)
    assert.equal(h.replacement().closed, false)
    assert.equal(h.live.skillCatalog, skills ? 'changed' : 'first')
  })
}

for (const [label, skills] of [['H3', true], ['T3', false]]) {
  test(`${label}: withdrawal during the replacement request refuses readiness before announce and list`, { timeout: 5000 }, async t => {
    const h = await reforkAccountFixture(t)
    const reason = await h.attempt({ skills, tools: !skills, at: 'request' })
    assert.deepEqual(h.requests, [skills ? 'renewal' : 'fork'])
    assert.deepEqual(h.firstLists, [{ tools: [], listed: false, announced: false }])
    assert.deepEqual(h.publications(), [], 'readiness must never announce the replacement')
    assert.notEqual(h.replacement().listed, true)
    assert.equal(h.replacement().closed, true)
    assert.equal(h.counts().mints, 1)
    assert.equal(h.counts().prompts, 1)
    assertAccountRefused(reason)
    h.ended()
  })
}

for (const [label, skills] of [['H4', true], ['T4', false]]) {
  test(`${label}: withdrawal after replacement readiness refuses the next prompt`, { timeout: 5000 }, async t => {
    const h = await reforkAccountFixture(t)
    const reason = await h.attempt({ skills, tools: !skills, at: 'mode' })
    assert.deepEqual(h.publications(), [h.replacement()], 'withdrawal landed after readiness')
    assert.equal(h.counts().prompts, 1)
    assertAccountRefused(reason)
    h.ended()
  })
}

for (const account of [CODEX_WORK, CODEX_OTHER]) {
  test(`AD-3: a mode failure after a fork ${account === CODEX_WORK ? 'keeps an eligible run' : 'retires a withdrawn run'}`, { timeout: 5000 }, async t => {
    const h = await reforkAccountFixture(t)
    const reason = await h.attempt({ tools: true, at: 'mode', account, failMode: true })
    assert.equal(h.counts().prompts, 1)
    if (account === CODEX_WORK) {
      assert.match(reason.failure.message, /would not take DSH's permission level: fake mode failure/)
      assert.equal(h.live.run.alive, true)
      assert.equal(h.replacement().closed, false)
    } else {
      assertAccountRefused(reason)
      h.ended()
      assert.equal(h.replacement().closed, true)
    }
  })
}

test('E1: withdrawal ends the old run and reconfirmation permits one fresh turn', { timeout: 5000 }, async t => {
  const h = await reforkAccountFixture(t)
  const reason = await h.attempt({ skills: true, tools: true, at: 'before mint' })
  assert.deepEqual(h.counts(), { starts: 1, mints: 0, renewals: [], forks: [], reforks: 0, prompts: 1 })
  assertAccountRefused(reason)
  h.ended()
  assert.equal((await h.reconfirm()).consent, 'given')
  assert.equal((await h.stream('Answer after reconfirmation')).kind, 'stop')
  assert.deepEqual(h.counts(), { starts: 2, mints: 1, renewals: [], forks: [], reforks: 0, prompts: 2 })
})
