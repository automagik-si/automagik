import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../src/host/endpoint.js'
import { CODEX_IMAGES, CODEX_IMAGE_MODEL, CODEX_RECORD, COMPANION_ROLE, OMNI_BOT, OMNI_BOT_FALLBACK, OPENAI_IMAGES, OPENAI_RECORD, accountIdOf, companionPrompt } from '../src/host/companion.js'
import { fakeContext } from './fake-ctx.js'

const ACCESS = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-7' } })).toString('base64url')}.sig`
const KEY = 'sk-openai-secret-0123456789'
const PNG = Buffer.from('a tiny png').toString('base64')

// The Omni team service (@automagik/bots-dsh's omniTeam), as far as onboarding uses it.
function fakeTeam({ mainName = 'Omni', folder } = {}) {
  const calls = []
  const state = { mainBotIds: ['main'], bots: { main: { id: 'main', name: mainName } } }
  const rt = {
    state,
    calls,
    async load() {},
    async bootstrap() { calls.push(['bootstrap']) },
    botOf: id => state.bots[id],
    findBot: name => Object.values(state.bots).find(bot => bot.name.toLowerCase() === name.toLowerCase()),
    teamFolder: () => folder,
    async updateBot(id, patch) {
      calls.push(['updateBot', id, patch])
      Object.assign(state.bots[id], patch)
    },
    async createBot(options) {
      calls.push(['createBot', options])
      const bot = { id: `bot-${calls.length}`, ...options }
      state.bots[bot.id] = bot
      return bot
    },
  }
  return rt
}

function host({ entries = { 'omni-ai': {} }, team, codex, fetch, env = {}, ...rest } = {}) {
  const fake = fakeContext({ entries, services: { ...(team ? { omniTeam: team } : {}), ...(codex ? { acpAgents: codex } : {}) }, ...rest })
  const requests = []
  const fetchImpl = fetch ?? (async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const { handle } = install(fake.ctx, { companion: { fetch: fetchImpl, env, now: () => 1_000_000 } })
  return { ...fake, handle, requests }
}

// acp-dsh's acpAgents, as far as the drawing uses it: Codex's readiness and one image.
const codexOf = ({ ready = true, authScope = 'isolated', accountGeneration, fail } = {}) => {
  const calls = []
  return {
    calls,
    authScope,
    imageAccess: async () => ({ ready, accountGeneration }),
    generateImage: async (request) => {
      calls.push(request)
      if (fail) throw Object.assign(new Error(fail), { code: 'acp/image-signed-out' })
      return { base64: PNG, mimeType: 'image/png' }
    },
  }
}

const grant = (expires = 9_000_000) => ({ [CODEX_RECORD]: { kind: 'grant', payload: { access: ACCESS, refresh: 'r-secret', expires } } })

test('the vendored characters and inks are still the team plugin\'s own', () => {
  for (const name of ['characters.js', 'inks.js']) {
    const copy = readFileSync(new URL(`../src/client/vendor/${name}`, import.meta.url), 'utf8').split('\n').slice(2).join('\n')
    const original = readFileSync(new URL(`../../bots-dsh/src/client/${name}`, import.meta.url), 'utf8')
    assert.equal(copy, original, `${name} drifted from bots-dsh: copy it again`)
  }
})

test('companion says which image source is ready, and never what it holds', async () => {
  assert.equal((await host().handle('companion')).value.generate, null)

  const chatgpt = await host({ recordValues: grant(), codex: codexOf({ ready: false, authScope: 'shared' }) }).handle('companion')
  assert.deepEqual(chatgpt.value.generate, { kind: 'chatgpt', ready: true })
  assert.doesNotMatch(JSON.stringify(chatgpt), /r-secret|sig/)

  const stale = await host({ recordValues: grant(1_000), codex: codexOf({ ready: false, authScope: 'shared' }) }).handle('companion')
  assert.deepEqual(stale.value.generate, { kind: 'chatgpt', ready: false })

  const keyed = await host({ recordValues: { [OPENAI_RECORD]: { kind: 'api-key', key: KEY } } }).handle('companion')
  assert.deepEqual(keyed.value.generate, { kind: 'openai', ready: true })
  assert.doesNotMatch(JSON.stringify(keyed), new RegExp(KEY))

  // A key saved in the app (DSH's credential file: fake-ctx resolves source: 'file').
  const saved = await host({ credentials: { OPENAI_API_KEY: KEY } }).handle('companion')
  assert.deepEqual(saved.value.generate, { kind: 'openai', ready: true })

  // The Bots' order: a key, then a signed-in Codex, then a grant on a shared scope.
  const both = await host({ recordValues: { ...grant(), [OPENAI_RECORD]: { kind: 'api-key', key: KEY } }, codex: codexOf() }).handle('companion')
  assert.deepEqual(both.value.generate, { kind: 'openai', ready: true })
  const codex = await host({ recordValues: grant(), codex: codexOf() }).handle('companion')
  assert.deepEqual(codex.value.generate, { kind: 'codex', ready: true })
  const signedOut = await host({ recordValues: grant(), codex: codexOf({ ready: false }) }).handle('companion')
  assert.equal(signedOut.value.generate, null)
})

test('an OPENAI_API_KEY inherited from the environment is not used for the companion', async () => {
  const codex = codexOf()
  for (const { source, service, kind } of [
    { source: 'env' }, { source: 'env', service: codex, kind: 'codex' },
    {}, { source: '' }, { source: 'user-env', kind: 'openai' }, { source: 'keychain', kind: 'openai' },
  ]) {
    const drawing = host({ codex: service })
    drawing.ctx.credentials.resolve = async ref => ref === 'OPENAI_API_KEY'
      ? { value: KEY, ...(source === undefined ? {} : { source }) } : undefined

    const status = await drawing.handle('companion')
    const reply = await drawing.handle('companion-generate', { description: 'a fox' })
    assert.deepEqual(status.value.generate, kind ? { kind, ready: true } : null)
    assert.doesNotMatch(JSON.stringify([status, reply]), new RegExp(KEY))
    if (kind === undefined) {
      assert.equal(reply.error.code, 'omni-ai/refused')
      assert.match(reply.error.message, /Sign in to Codex first/)
    } else assert.equal(reply.value.via, kind)
    assert.equal(drawing.requests.length, kind === 'openai' ? 1 : 0)
    if (kind === 'openai') {
      assert.equal(drawing.requests[0].url, OPENAI_IMAGES)
      assert.equal(drawing.requests[0].init.headers.authorization, `Bearer ${KEY}`)
    }
  }
  assert.equal(codex.calls.length, 1)
  assert.doesNotMatch(JSON.stringify(codex.calls), new RegExp(KEY))
})

for (const [name, codex] of [
  ['isolated and signed out', codexOf({ ready: false })],
  ['absent', undefined],
  ['reloading', { authScope: 'shared' }],
  ['throwing', { ...codexOf({ authScope: 'shared' }), imageAccess: async () => { throw new Error('unavailable') } }],
  ['throwing synchronously', { ...codexOf({ authScope: 'shared' }), imageAccess: () => { throw new Error('unavailable') } }],
  ['without a scope', { ...codexOf({ ready: false }), authScope: undefined }],
  ['with scope only in the answer', { ...codexOf(), imageAccess: async () => ({ ready: false, authScope: 'shared' }) }],
  ...[undefined, null, {}, false, 'unavailable', { ready: 'false' }].map(answer => [
    `with malformed answer ${JSON.stringify(answer)}`,
    { ...codexOf({ authScope: 'shared' }), imageAccess: async () => answer },
  ]),
]) {
  test(`ACP ${name} refuses the legacy grant without reading it or making HTTP requests`, async () => {
    const drawing = host({ recordValues: grant(), codex })
    const reads = []
    const readRecord = drawing.ctx.credentials.readRecord
    drawing.ctx.credentials.readRecord = async key => {
      reads.push(key)
      return readRecord(key)
    }
    assert.equal((await drawing.handle('companion')).value.generate, null)
    const reply = await drawing.handle('companion-generate', { description: 'a fox' })
    assert.equal(reply.error.code, 'omni-ai/refused')
    assert.match(reply.error.message, /Sign in to Codex first/)
    assert.equal(reads.includes(CODEX_RECORD), false)
    assert.equal(drawing.requests.length, 0)
    assert.deepEqual(codex?.calls ?? [], [])
  })
}

test('a run-out earlier grant never blocks a key or Codex (it is not refreshed here)', async () => {
  const keyed = host({ recordValues: { ...grant(1_000), [OPENAI_RECORD]: { kind: 'api-key', key: KEY } } })
  assert.deepEqual((await keyed.handle('companion')).value.generate, { kind: 'openai', ready: true })
  assert.equal((await keyed.handle('companion-generate', { description: 'a fox' })).value.via, 'openai')
  const codex = codexOf()
  const viaCodex = host({ recordValues: grant(1_000), codex })
  assert.deepEqual((await viaCodex.handle('companion')).value.generate, { kind: 'codex', ready: true })
  assert.equal((await viaCodex.handle('companion-generate', { description: 'a fox' })).value.via, 'codex')
  assert.equal(viaCodex.requests.length, 0)
})

test('with no key, a signed-in Codex draws the companion: no request leaves from here', async () => {
  const codex = codexOf({ accountGeneration: 7 })
  const drawing = host({ codex })
  const reply = await drawing.handle('companion-generate', { description: 'a sleepy fox' })
  assert.deepEqual(reply.value, { image: `data:image/png;base64,${PNG}`, via: 'codex' })
  assert.equal(drawing.requests.length, 0)
  assert.deepEqual(codex.calls.map(({ signal, ...rest }) => rest), [{ prompt: companionPrompt('a sleepy fox'), size: '1024x1024', accountGeneration: 7 }])
  // Codex's refusal is the answer, as it is.
  const refusing = host({ codex: codexOf({ fail: 'Codex is not signed in. Sign in to Codex from a Bot\'s chat.' }) })
  const refused = await refusing.handle('companion-generate', { description: 'a fox' })
  assert.equal(refused.error.code, 'omni-ai/refused')
  assert.match(refused.error.message, /not signed in/)
})

for (const accountGeneration of [0, 9, undefined]) {
  test(`Codex receives accountGeneration ${accountGeneration} without changing it`, async () => {
    const codex = codexOf({ accountGeneration })
    const drawing = host({ codex })
    assert.equal((await drawing.handle('companion-generate', { description: 'a fox' })).value.via, 'codex')
    assert.equal(codex.calls[0].accountGeneration, accountGeneration)
    assert.equal(Object.hasOwn(codex.calls[0], 'accountGeneration'), accountGeneration !== undefined)
    assert.equal(drawing.requests.length, 0)
  })
}

test('a changed Codex account refuses the stale ticket as not ready without using a grant', async () => {
  let accountGeneration = 4
  const codex = codexOf({ authScope: 'shared' })
  codex.imageAccess = async () => {
    const access = { ready: true, accountGeneration }
    accountGeneration += 1
    return access
  }
  codex.generateImage = async request => {
    codex.calls.push(request)
    if (request.accountGeneration !== accountGeneration) {
      throw Object.assign(new Error('Codex is not ready. The account changed.'), { code: 'acp/image-not-ready' })
    }
    return { base64: PNG }
  }
  const drawing = host({ codex, recordValues: grant() })
  const reads = []
  const readRecord = drawing.ctx.credentials.readRecord
  drawing.ctx.credentials.readRecord = async key => {
    reads.push(key)
    return readRecord(key)
  }
  const reply = await drawing.handle('companion-generate', { description: 'a fox' })
  assert.equal(codex.calls[0].accountGeneration, 4)
  assert.equal(reply.error.code, 'omni-ai/refused')
  assert.equal(reply.error.message, 'Codex is not ready. The account changed.')
  assert.equal(reads.includes(CODEX_RECORD), false)
  assert.equal(drawing.requests.length, 0)
})

test('a ChatGPT plan draws through the Codex images endpoint; a key through OpenAI\'s', async () => {
  assert.equal(accountIdOf(ACCESS), 'acct-7')
  const chatgpt = host({ recordValues: grant(), codex: codexOf({ ready: false, authScope: 'shared' }) })
  const reply = await chatgpt.handle('companion-generate', { description: 'a sleepy fox' })
  assert.deepEqual(reply.value, { image: `data:image/png;base64,${PNG}`, via: 'chatgpt' })
  const [request] = chatgpt.requests
  assert.equal(request.url, CODEX_IMAGES)
  assert.equal(request.init.headers['chatgpt-account-id'], 'acct-7')
  assert.equal(request.init.headers.authorization, `Bearer ${ACCESS}`)
  const body = JSON.parse(request.init.body)
  assert.equal(body.model, CODEX_IMAGE_MODEL)
  assert.equal(body.prompt, companionPrompt('a sleepy fox'))

  const keyed = host({ recordValues: { [OPENAI_RECORD]: { kind: 'api-key', key: KEY } } })
  assert.equal((await keyed.handle('companion-generate', { description: 'a sleepy fox' })).value.via, 'openai')
  assert.equal(keyed.requests[0].url, OPENAI_IMAGES)
})

test('drawing is refused without a source, with a stale sign-in, or when the service says no', async () => {
  const none = host()
  assert.match((await none.handle('companion-generate', { description: 'a fox' })).error.message, /Sign in to Codex first/)
  assert.equal(none.requests.length, 0)
  const stale = host({ recordValues: grant(1_000), codex: codexOf({ ready: false, authScope: 'shared' }) })
  assert.match((await stale.handle('companion-generate', { description: 'a fox' })).error.message, /has run out/)
  assert.equal(stale.requests.length, 0)
  assert.equal((await host({ recordValues: grant() }).handle('companion-generate', { description: 'x' })).error.code, 'omni-ai/invalid')
  const failing = host({ recordValues: grant(), codex: codexOf({ ready: false, authScope: 'shared' }), fetch: async () => new Response(JSON.stringify({ error: { message: 'quota reached' } }), { status: 429 }) })
  assert.equal((await failing.handle('companion-generate', { description: 'a fox' })).error.message, 'The image was not made: quota reached')
})

test('saving the companion makes it the Main Bot, by look and name', async () => {
  const team = fakeTeam()
  const fake = host({ team })
  const reply = await fake.handle('companion-save', { name: ' Mochi ', shape: 'octopus', color: 'orange' })
  assert.deepEqual(reply.value, { name: 'Mochi', applied: true, image: false })
  assert.deepEqual(team.calls, [['updateBot', 'main', { name: 'Mochi', role: COMPANION_ROLE, color: 'orange', avatar: { shape: 'octopus' } }]])
  assert.deepEqual(fake.valueOf('omni-ai'), { companionName: 'Mochi', companionShape: 'octopus', companionColor: 'orange' })
  assert.equal((await fake.handle('state')).value.companionName, 'Mochi')

  // Without the team plugin the companion is kept for later.
  assert.deepEqual((await host().handle('companion-save', { name: 'Pip', shape: 'star' })).value, { name: 'Pip', applied: false, image: false })
})

test('the companion is the Orchestrator, and keeps a role the person gave it', async () => {
  assert.equal(COMPANION_ROLE, 'Orchestrator')
  // The roles set before (this plugin's and the team's own default) give way to it.
  for (const role of ['Your companion', 'Channel orchestrator']) {
    const team = fakeTeam()
    team.state.bots.main.role = role
    await host({ team }).handle('companion-save', { name: 'Pip', shape: 'octopus' })
    assert.equal(team.state.bots.main.role, 'Orchestrator')
  }
  const team = fakeTeam()
  team.state.bots.main.role = 'Chief of staff'
  await host({ team }).handle('companion-save', { name: 'Pip', shape: 'octopus' })
  assert.deepEqual(team.calls, [['updateBot', 'main', { name: 'Pip', avatar: { shape: 'octopus' } }]])
  assert.equal(team.state.bots.main.role, 'Chief of staff')
})

test('a drawn companion becomes the Main Bot\'s avatar, shrunk', async () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-ai-companion-'))
  try {
    const team = fakeTeam()
    const fake = host({ team, env: { AUTOMAGIK_BOTS_HOME: home } })
    const avatar = `data:image/webp;base64,${PNG}`
    const reply = await fake.handle('companion-save', { name: 'Nova', image: `data:image/png;base64,${PNG}`, avatar })
    assert.deepEqual(reply.value, { name: 'Nova', applied: true, image: true })
    assert.deepEqual(team.calls, [['updateBot', 'main', { name: 'Nova', role: COMPANION_ROLE, avatar: { image: avatar } }]])
    // Past the Bot avatar limit, the save is refused rather than failing in the team plugin.
    const big = `data:image/webp;base64,${'A'.repeat(160_000)}`
    assert.equal((await fake.handle('companion-save', { name: 'Nova', image: `data:image/png;base64,${PNG}`, avatar: big })).error.code, 'omni-ai/invalid')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a drawn companion is kept as a private file in the Bot team\'s home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-ai-companion-'))
  try {
    const fake = host({ env: { AUTOMAGIK_BOTS_HOME: home } })
    const reply = await fake.handle('companion-save', { name: 'Nova', image: `data:image/png;base64,${PNG}` })
    assert.deepEqual(reply.value, { name: 'Nova', applied: false, image: true })
    const file = join(home, 'companion', 'companion.png')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(readFileSync(file).toString('base64'), PNG)
    assert.deepEqual((await fake.handle('companion-image')).value, { image: `data:image/png;base64,${PNG}` })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a companion needs a plain name and a look', async () => {
  const fake = host({ team: fakeTeam() })
  for (const payload of [{ name: '', shape: 'octopus' }, { name: '<b>x</b>', shape: 'octopus' }, { name: 'Pip' }, { name: 'Pip', shape: 'Octo pus' }, { name: 'Pip', image: 'data:text/html;base64,AAAA' }]) {
    assert.equal((await fake.handle('companion-save', payload)).error.code, 'omni-ai/invalid', JSON.stringify(payload))
  }
  assert.deepEqual(fake.updates, [])
})

test('Omni joining the team adds the Omni Bot once, in its own project, with its greeting held', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'omni-ai-team-'))
  try {
    const team = fakeTeam({ mainName: 'Mochi', folder })
    const fake = host({ team })
    const reply = await fake.handle('team-save', { omni: true, genie: false, omniAbilities: { channels: true, shell: false } })
    assert.equal(reply.value.omniBot.name, 'Omni')
    const [, options] = team.calls.find(call => call[0] === 'createBot')
    assert.deepEqual({ ...options, avatar: { ...options.avatar } }, { ...OMNI_BOT, avatar: { ...OMNI_BOT.avatar }, workDir: join(folder, 'omni'), pickModel: true })
    assert.ok(statSync(join(folder, 'omni')).isDirectory())
    assert.deepEqual(fake.valueOf('omni-ai'), { teamOmni: true, teamGenie: false, teamOmniAbilities: '{"channels":true,"shell":false}' })

    await fake.handle('team-save', { omni: true })
    assert.equal(team.calls.filter(call => call[0] === 'createBot').length, 1)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a deleted Omni Bot comes back from the Bot team\'s Add Omni, made as the team step makes it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'omni-ai-add-'))
  try {
    const team = fakeTeam({ mainName: 'Mochi', folder })
    const views = []
    const endpoints = new Map()
    team.hooks = { view: (fn) => { views.push(fn); return () => {} }, endpoint: (name, fn) => { endpoints.set(name, fn); return () => {} } }
    const fake = fakeContext({ entries: { 'omni-ai': {} }, services: { omniTeam: team } })
    // While the Bot team and Omni's channels run (cordis ctx.inject).
    fake.ctx.inject = (names, callback) => callback({ omniTeam: team, omniChannels: {}, effect: fn => fn() })
    install(fake.ctx, {})
    const addable = () => Object.assign({}, ...views.map(fn => fn())).omniAddable
    assert.equal(addable(), true)
    const bot = await endpoints.get('omni-add')()
    assert.equal(bot.name, 'Omni')
    const [, options] = team.calls.find(call => call[0] === 'createBot')
    assert.equal(options.kind, OMNI_BOT.kind)
    assert.equal(options.workDir, join(folder, 'omni'))
    assert.equal(addable(), false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the Omni Bot takes another name when the companion is called Omni', async () => {
  const team = fakeTeam({ mainName: 'Omni' })
  const reply = await host({ team }).handle('team-save', { omni: true })
  assert.equal(reply.value.omniBot.name, OMNI_BOT_FALLBACK)
})

test('Omni left out adds no Bot and skips its connect step; a bad choice changes nothing', async () => {
  const team = fakeTeam()
  const fake = host({ team })
  assert.deepEqual((await fake.handle('team-save', { omni: false })).value, { omni: false, genie: false, abilities: null, omniBot: null })
  assert.deepEqual(team.calls, [])
  assert.deepEqual(fake.valueOf('omni-ai'), { teamOmni: false, teamGenie: false, connectOmniSkipped: true })

  const strict = host({ team })
  for (const payload of [{}, { omni: 'yes' }, { omni: true, omniAbilities: { 'Not A Key': true } }, { omni: true, omniAbilities: { shell: 'on' } }]) {
    assert.equal((await strict.handle('team-save', payload)).error.code, 'omni-ai/invalid', JSON.stringify(payload))
  }
  assert.deepEqual(strict.updates, [])
})

// The team service's model side, as assignModels uses it: `served` lists what can run,
// in turn, one read per entry (a provider that registers late).
function withModels(team, served) {
  let reads = 0
  team.catalog = async () => { reads += 1 }
  team.defaultModel = async () => served[Math.min(reads, served.length) - 1]
  return team
}

test('Connect AI finished with an AI on gives the companion, the Omni Bot and the Genie Bot a model', async () => {
  const team = withModels(fakeTeam({ mainName: 'Pip' }), ['anthropic/claude-opus-5-5'])
  team.state.bots.omni = { id: 'omni', name: 'Omni', kind: 'omni' }
  team.state.bots.genie = { id: 'genie', name: 'Genie', kind: 'genie' }
  team.state.bots.other = { id: 'other', name: 'Writer' }
  const fake = host({ team })
  const reply = await fake.handle('done', { stepId: 'omni-connect-ai', connected: true })
  assert.deepEqual(reply.value, { connectAiDone: true })
  assert.deepEqual(team.calls, [['updateBot', 'main', { model: 'anthropic/claude-opus-5-5' }], ['updateBot', 'omni', { model: 'anthropic/claude-opus-5-5' }], ['updateBot', 'genie', { model: 'anthropic/claude-opus-5-5' }]])
  assert.equal(team.state.bots.other.model, undefined)
})

// G6-18 (#2048): with only Antigravity on, the first model that can run is an Antigravity one
// (bots-dsh pickDefault), and the first Bots start on it, as with Claude or Codex alone.
test('Connect AI finished with only Antigravity on gives the first Bots its model; none yet sets nothing', async () => {
  const team = withModels(fakeTeam({ mainName: 'Pip' }), ['acp-antigravity/x'])
  team.state.bots.omni = { id: 'omni', name: 'Omni', kind: 'omni' }
  team.state.bots.genie = { id: 'genie', name: 'Genie', kind: 'genie' }
  const fake = host({ team })
  assert.deepEqual((await fake.handle('done', { stepId: 'omni-connect-ai', connected: true })).value, { connectAiDone: true })
  assert.deepEqual(team.calls, [['updateBot', 'main', { model: 'acp-antigravity/x' }], ['updateBot', 'omni', { model: 'acp-antigravity/x' }], ['updateBot', 'genie', { model: 'acp-antigravity/x' }]])
  const none = withModels(fakeTeam(), [undefined])
  none.state.bots.omni = { id: 'omni', name: 'Omni', kind: 'omni' }
  const { install: installAgain } = await import('../src/host/endpoint.js')
  const quick = installAgain(host({ team: none }).ctx, { assignWaitMs: 0 })
  assert.equal((await quick.handle('done', { stepId: 'omni-connect-ai', connected: true })).ok, true)
  assert.deepEqual(none.calls, [])
})

test('a skipped Connect AI, a Bot with a model, or no model that can run sets nothing', async () => {
  const skipped = withModels(fakeTeam(), ['anthropic/claude-opus-5-5'])
  await host({ team: skipped }).handle('done', { stepId: 'omni-connect-ai' })
  assert.deepEqual(skipped.calls, [])
  const chosen = withModels(fakeTeam(), ['anthropic/claude-opus-5-5'])
  chosen.state.bots.main.model = 'deepseek/deepseek-v4-pro'
  await host({ team: chosen }).handle('done', { stepId: 'omni-connect-ai', connected: true })
  assert.deepEqual(chosen.calls, [])
  const none = withModels(fakeTeam(), [undefined])
  const fake = host({ team: none })
  const { install: installAgain } = await import('../src/host/endpoint.js')
  const quick = installAgain(fake.ctx, { assignWaitMs: 0 })
  assert.equal((await quick.handle('done', { stepId: 'omni-connect-ai', connected: true })).ok, true)
  assert.deepEqual(none.calls, [])
  // Another step's done never assigns.
  const other = withModels(fakeTeam(), ['anthropic/claude-opus-5-5'])
  await host({ team: other }).handle('done', { stepId: 'omni-team', connected: true })
  assert.deepEqual(other.calls, [])
})

test('a provider Connect AI just turned on is waited for', async () => {
  const team = withModels(fakeTeam(), [undefined, undefined, 'anthropic/claude-opus-5-5'])
  const fake = host({ team })
  const { assignModels } = await import('../src/host/companion.js').then(({ createCompanionActions }) => createCompanionActions(fake.ctx))
  assert.deepEqual(await assignModels(team, { waitMs: 5_000, pauseMs: 1 }), ['Omni'])
  assert.deepEqual(team.calls, [['updateBot', 'main', { model: 'anthropic/claude-opus-5-5' }]])
})
