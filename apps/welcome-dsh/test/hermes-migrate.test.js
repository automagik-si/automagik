// The "From another tool" step's host half: Hermes's files read and switched off only on the
// Hermes host, the key carried through the Bot team's write-only store, and Omni's write-only
// attach. The Python half runs against throwaway homes (never a real Hermes, never a restart);
// the move runs with stubbed script, restart and Omni, so no service is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOVE_STEPS, CARRIER_NAME, chatUrlOf, createMigrateActions, hermesTargetOf, omniApi, redactKey, scriptCommand } from '../src/host/hermes-migrate.js'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = readFileSync(join(PLUGIN, 'src/host/hermes-migrate.py'), 'utf8')
// A fixture key, assembled here so no secret-shaped literal sits in the tree.
const FIXTURE_KEY = ['123456789', `${'A'.repeat(20)}${'B'.repeat(15)}`].join(':')
const CHANNEL = '0f0f0f0f-1111-4222-8333-444444444444'
const OTHER_CHANNEL = 'e0e0e0e0-4444-4555-8666-777777777777'
const KEY_PREFIX = FIXTURE_KEY.slice(0, FIXTURE_KEY.indexOf(':'))
const OTHER_BOT = '987654321'
const BOT = 'b0b0b0b0-2222-4333-8444-555555555555'
const GENIE = 'd0d0d0d0-3333-4444-8555-666666666666'

function home(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-migrate-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}
function script(dir, mode, extra = {}) {
  const job = { home: dir, mode, ...extra }
  const source = SCRIPT.replace('__OMNI_HERMES_JOB__', Buffer.from(JSON.stringify(job), 'utf8').toString('base64'))
  const out = execFileSync('python3', ['-'], { input: source, encoding: 'utf8' })
  return JSON.parse(out.trim().split('\n').at(-1))
}
const CONFIG = `# Hefesto
model:
  default: gpt-6-astra
platforms:
  telegram:
    enabled: true
    token: "${FIXTURE_KEY}"
    home_channel: "42"
  discord:
    enabled: true
`
const STATE = JSON.stringify({ pid: 4242, updated_at: '2026-11-15T07:00:00Z', platforms: { telegram: { state: 'connected' } } })

test('a key split by a space or a line break after the colon is masked before anything else', () => {
  const suffix = FIXTURE_KEY.slice(FIXTURE_KEY.indexOf(':') + 1)
  for (const split of [`${FIXTURE_KEY.slice(0, 10)} ${suffix}`, `${FIXTURE_KEY.slice(0, 10)}\n${suffix}`, `${FIXTURE_KEY.slice(0, 10)}${suffix.slice(0, 15)}\n${suffix.slice(15)}`]) {
    assert.equal(redactKey(`failed with ${split} here`), 'failed with [hidden] here')
  }
  assert.equal(redactKey(`full ${FIXTURE_KEY} end`), 'full [hidden] end')
  assert.equal(redactKey('nothing 123456789:short'), 'nothing 123456789:short')
})

test('Hermes\'s probe reads the channel and never the key; read hands it over only when asked', () => {
  const dir = home({ 'config.yaml': CONFIG, '.env': 'TELEGRAM_ALLOWED_USERS=42\n', 'gateway_state.json': STATE })
  try {
    const probe = script(dir, 'probe')
    assert.equal(probe.ok, true)
    assert.deepEqual(probe.hermes, { found: true, channel: 'on', key: 'available' })
    assert.equal(probe.gateway.pid, 4242)
    assert.equal(probe.gateway.telegram, 'connected')
    assert.ok(!JSON.stringify(probe).includes(FIXTURE_KEY), 'the probe leaked the key')

    const read = script(dir, 'read')
    assert.equal(read.token, FIXTURE_KEY)
    assert.equal(read.tokenSource, 'config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the environment\'s token is the one Hermes would use, and an explicit disable wins', () => {
  const dir = home({ 'config.yaml': CONFIG, '.env': `TELEGRAM_BOT_TOKEN="${FIXTURE_KEY}"\n` })
  try {
    const read = script(dir, 'read')
    assert.equal(read.tokenSource, 'env')
    assert.equal(read.hermes.channel, 'on')

    const disabled = home({ 'config.yaml': CONFIG.replace('enabled: true', 'enabled: false') })
    const off = script(disabled, 'probe')
    assert.equal(off.hermes.channel, 'off')
    const again = script(disabled, 'disable')
    assert.deepEqual(again, { ok: true, changed: false, channel: 'off' })
    rmSync(disabled, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('switching Hermes off edits one flag, keeps the rest, copies the file first, and restores', () => {
  const dir = home({ 'config.yaml': CONFIG, '.env': 'TELEGRAM_ALLOWED_USERS=42\n' })
  try {
    const off = script(dir, 'disable')
    assert.equal(off.ok, true)
    assert.equal(off.changed, true)
    assert.equal(off.channel, 'off')
    assert.match(off.backup, /^config\.yaml\.bak-omni-/)
    const edited = readFileSync(join(dir, 'config.yaml'), 'utf8')
    assert.match(edited, /# Hefesto\nmodel:\n {2}default: gpt-6-astra/)
    assert.ok(edited.includes(`platforms:\n  telegram:\n    enabled: false\n    token: "${FIXTURE_KEY}"`))
    assert.match(edited, / {2}discord:\n {4}enabled: true/)
    assert.equal(readFileSync(join(dir, off.backup), 'utf8'), CONFIG)
    assert.equal(script(dir, 'probe').hermes.channel, 'off')

    const back = script(dir, 'restore', { backup: off.backup })
    assert.deepEqual(back, { ok: true, restored: true })
    assert.equal(readFileSync(join(dir, 'config.yaml'), 'utf8'), CONFIG)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a config without a platforms block gets one, and a top-level telegram block stays put', () => {
  const plain = home({ 'config.yaml': 'model:\n  default: gpt-6-astra\n' })
  const top = home({ 'config.yaml': `telegram:\n  enabled: true\n  token: "${FIXTURE_KEY}"\n` })
  try {
    assert.equal(script(plain, 'disable').changed, true)
    assert.match(readFileSync(join(plain, 'config.yaml'), 'utf8'), /model:\n {2}default: gpt-6-astra\nplatforms:\n {2}telegram:\n {4}enabled: false\n/)
    assert.equal(script(plain, 'probe').hermes.channel, 'off')

    assert.equal(script(top, 'probe').hermes.channel, 'on')
    assert.equal(script(top, 'disable').changed, true)
    const edited = readFileSync(join(top, 'config.yaml'), 'utf8')
    assert.match(edited, /telegram:\n {2}enabled: true\n {2}token:/)
    assert.match(edited, /platforms:\n {2}telegram:\n {4}enabled: false\n/)
    assert.equal(script(top, 'probe').hermes.channel, 'off')
  } finally {
    rmSync(plain, { recursive: true, force: true })
    rmSync(top, { recursive: true, force: true })
  }
})

test('no channel, a broken config and a symlink are each named, never guessed', () => {
  const none = home({ 'config.yaml': 'model:\n  default: x\n' })
  const broken = home({ 'config.yaml': 'platforms: [\n' })
  const linked = home({ 'config.yaml': CONFIG })
  try {
    assert.equal(script(none, 'probe').hermes.channel, 'none')
    assert.equal(script(none, 'probe').hermes.key, 'missing')
    assert.equal(script(broken, 'probe').error, 'config-unreadable')
    assert.equal(readFileSync(join(broken, 'config.yaml'), 'utf8'), 'platforms: [\n')
    assert.equal(script(broken, 'disable').error, 'config-unreadable')

    const linkDir = home()
    symlinkSync(join(linked, 'config.yaml'), join(linkDir, 'config.yaml'))
    assert.equal(script(linkDir, 'disable').error, 'config-link')
    rmSync(linkDir, { recursive: true, force: true })
  } finally {
    for (const dir of [none, broken, linked]) rmSync(dir, { recursive: true, force: true })
  }
})

test('the gateway record says whether the pid is alive and who owns Telegram', () => {
  const dir = home({ 'gateway_state.json': JSON.stringify({ pid: 999999, platforms: { telegram: { state: 'connected' } } }) })
  try {
    const gateway = script(dir, 'gateway').gateway
    assert.equal(gateway.pid, 999999)
    assert.equal(gateway.pidAlive, false)
    assert.equal(gateway.telegram, 'connected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the Hermes host is the Bot team\'s SSH one when it is on, else this computer', () => {
  const ssh = hermesTargetOf({ hermesRemote: { view: () => ({ enabled: true, mode: 'ssh', ssh: { host: 'proxy.example.com', user: 'me', port: '2222', identityFile: '/keys/h', hermesHome: '~/hermes' } }) } })
  assert.deepEqual(ssh, { where: 'ssh', ssh: { host: 'proxy.example.com', user: 'me', port: 2222, identityFile: '/keys/h', hermesHome: '~/hermes' } })
  assert.equal(scriptCommand(ssh).command, 'ssh')
  assert.ok(scriptCommand(ssh).args.includes('me@proxy.example.com'))
  assert.equal(scriptCommand(ssh).args.at(-2), 'me@proxy.example.com')
  assert.match(scriptCommand(ssh).args.at(-1), /python3 -/)

  assert.deepEqual(hermesTargetOf({ hermesRemote: { view: () => ({ enabled: false, mode: 'ssh', ssh: { host: 'proxy.example.com' } }) } }, { env: {}, home: '~/me' }), { where: 'local', home: '~/me/.hermes' })
  assert.deepEqual(hermesTargetOf({}, { env: { HERMES_HOME: '/srv/hermes' }, home: '~/me' }), { where: 'local', home: '/srv/hermes' })
  assert.deepEqual(hermesTargetOf({ hermesRemote: { view: () => ({ enabled: true, mode: 'ssh', ssh: { host: '-oProxyCommand=x' } }) } }, { env: {}, home: '~/me' }), { where: 'local', home: '~/me/.hermes' })
})

const fakeTeam = ({ bots = [{ id: BOT, name: 'Omni', kind: 'omni' }], main = BOT } = {}) => {
  const secrets = new Map()
  const calls = []
  const team = {
    state: { bots: Object.fromEntries(bots.map(bot => [bot.id, bot])), mainBotId: main },
    hermesRemote: { view: () => ({ enabled: false }) },
    async load() {},
    async secretEndpoint(endpoint, body) {
      calls.push(['secret', endpoint, body])
      if (endpoint === 'secret-set') {
        secrets.set(body.name, body.value)
        return { name: body.name, scope: body.scope }
      }
      if (endpoint === 'secret-delete') {
        secrets.delete(body.name)
        return true
      }
      throw new Error(`unknown secret endpoint ${endpoint}`)
    },
    secretValue: name => secrets.get(name),
    async deleteSecretIfUnchanged(name, expected) {
      calls.push(['delete', name])
      if (secrets.get(name) !== expected) return false
      secrets.delete(name)
      return true
    },
  }
  return { team, secrets, calls }
}

const fakeChannels = ({ attach, instances = [], pairing = { state: 'connected', connected: true, detail: '@HefestoBot' } } = {}) => {
  const calls = []
  const channels = {
    config: { omni: { url: 'http://omni.test' } },
    omniNamed: () => true,
    omniRequest: async (_method, path) => {
      if (path === '/instances') return { ok: true, json: async () => ({ items: instances }) }
      const status = /^\/instances\/([^/]+)\/status$/.exec(path)
      if (status !== null) {
        const item = instances.find(row => row.id === status[1])
        return { ok: true, json: async () => ({ data: { state: item?.state ?? 'connected', isConnected: item?.state !== 'connecting', botId: item?.botId ?? null } }) }
      }
      return { ok: true, json: async () => ({ items: instances }) }
    },
    omniChannelEndpoint: async (name, body) => {
      calls.push([name, body])
      if (name === 'omni-channel-create') return { id: CHANNEL, type: 'telegram', name: body.name }
      if (name === 'omni-channel-act') return { ok: true }
      if (name === 'omni-channel-pairing') return pairing
      throw Object.assign(new Error(`unknown endpoint ${name}`), { code: 'bot/invalid' })
    },
  }
  if (attach !== undefined) channels.omniTelegramAttach = attach
  return { channels, calls }
}

const fakeScript = ({ channel = 'on', key = 'available', token = FIXTURE_KEY, gateway = { pid: 100, pidAlive: true, telegram: 'connected' }, after = { pid: 200, pidAlive: true, telegram: null }, backup = 'config.yaml.bak-omni-1' } = {}) => {
  const modes = []
  const execute = async (_target, job) => {
    modes.push(job.mode)
    if (job.mode === 'probe') return { ok: true, hermes: { found: true, channel, key }, gateway }
    if (job.mode === 'read') {
      if (key !== 'available') throw Object.assign(new Error('Hermes did not have a Telegram bot key this wizard can read.'), { code: 'omni-ai/migrate-no-key' })
      return { ok: true, hermes: { found: true, channel, key }, gateway, token, tokenSource: 'env' }
    }
    if (job.mode === 'disable') return { ok: true, changed: true, channel: 'off', backup }
    if (job.mode === 'restore') return { ok: true, restored: true }
    if (job.mode === 'gateway') return { ok: true, gateway: after }
    throw new Error(`unexpected ${job.mode}`)
  }
  return { execute, modes }
}

const install = ({ script, team, channels, restart = async () => ({ ok: true }), times = {} }) => createMigrateActions(
  { get: () => undefined },
  { team: team.team, channels: channels.channels, execute: script.execute, restart, sleep: async () => {}, times: { pollMs: 0, offWaitMs: 0, listenMs: 0, ...times } },
)

const status = (actions, jobId) => actions['migrate-status']({ jobId })
async function settled(actions, jobId) {
  for (let tries = 0; tries < 200; tries += 1) {
    const reply = await status(actions, jobId)
    if (reply.phase !== 'running') return reply
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('the move did not settle')
}

test('the probe answers what Hermes has, and never a key', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels()
  const actions = install({ script, team, channels })
  const probe = await actions['migrate-probe']()
  assert.deepEqual(probe.hermes, { found: true, where: 'local', channel: 'on', key: 'available', gatewayRunning: true, pendingRestart: false })
  assert.equal(probe.omni.linked, true)
  assert.equal(probe.omni.attach, false)
  assert.deepEqual(probe.omni.bots, [{ id: BOT, name: 'Omni', main: true }])
  assert.ok(!JSON.stringify(probe).includes(FIXTURE_KEY))
})

test('the probe offers only the Bots Omni can bind as the one who answers', async () => {
  const team = fakeTeam({
    bots: [
      { id: BOT, name: 'Omni', kind: 'omni' },
      { id: 'd0d0d0d0-3333-4444-8555-666666666666', name: 'Genie', kind: 'genie' },
    ],
  })
  const actions = install({ script: fakeScript(), team, channels: fakeChannels() })
  const probe = await actions['migrate-probe']()
  assert.deepEqual(probe.omni.bots, [{ id: BOT, name: 'Omni', main: true }])
})

test('the release contract: the base receipt has no bot id, and detail is the profile name', async () => {
  const seen = []
  const channels = fakeChannels({
    attach: async (input) => {
      seen.push(input)
      return { channelId: CHANNEL, channelName: 'Telegram', connected: true, detail: 'Helper' }
    },
  })
  const actions = install({ script: fakeScript(), team: fakeTeam(), channels })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true, answerBot: BOT })).jobId)
  assert.equal(done.phase, 'done')
  assert.deepEqual(seen, [{ token: FIXTURE_KEY, name: 'Telegram', source: 'hermes', answerBot: BOT }])
  assert.deepEqual(done.result, {
    channelId: CHANNEL, channelName: 'Telegram', connected: true, botName: 'Helper', chatUrl: 'https://t.me/Helper',
    answering: false, answeringOff: false, attached: true, existing: false,
    answerBot: { id: BOT, name: 'Omni' }, hermesOff: true, hermesWasOff: false, hermesWasStopped: false, gatewayStopped: false,
  })
  assert.equal('botId' in done.result, false)
  assert.ok(!JSON.stringify(done).includes(FIXTURE_KEY))
})

test('the release contract: a reported Telegram bot id and the answerBot echo are not used for display or routing', async () => {
  const channels = fakeChannels({
    attach: async (input) => ({ channelId: CHANNEL, channelName: 'Telegram', connected: true, detail: 'Helper', botId: 824600000, answerBot: input.answerBot, answering: true }),
  })
  const actions = install({ script: fakeScript(), team: fakeTeam(), channels })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true, answerBot: BOT })).jobId)
  assert.equal(done.phase, 'done')
  assert.equal(done.result.answering, true)
  assert.deepEqual(done.result.answerBot, { id: BOT, name: 'Omni' })
  assert.equal('botId' in done.result, false)
  assert.ok(!JSON.stringify(done).includes('824600000'))
})

test('a move needs the person\'s confirmation and a key this wizard can read', async () => {
  const team = fakeTeam()
  const channels = fakeChannels()
  const script = fakeScript()
  const actions = install({ script, team, channels })
  await assert.rejects(actions['migrate-start']({}), { code: 'omni-ai/migrate-confirm' })
  assert.deepEqual(script.modes, [])

  const off = install({ script: fakeScript({ channel: 'none' }), team: fakeTeam(), channels: fakeChannels() })
  await assert.rejects(off['migrate-start']({ confirm: true }), { code: 'omni-ai/migrate-no-channel' })

  const noOmni = install({ script: fakeScript(), team: fakeTeam(), channels: { channels: undefined } })
  await assert.rejects(noOmni['migrate-start']({ confirm: true }), { code: 'omni-ai/migrate-no-omni' })
})

test('a Bot Omni cannot bind stops the move before the key is read or Hermes changes', async () => {
  const script = fakeScript()
  const team = fakeTeam({ bots: [{ id: GENIE, name: 'Genie', kind: 'genie' }, { id: BOT, name: 'Omni', kind: 'omni' }], main: GENIE })
  const channels = fakeChannels()
  const actions = install({ script, team, channels })
  await assert.rejects(actions['migrate-start']({ confirm: true, answerBot: GENIE }), { code: 'omni-ai/migrate-answerer' })
  assert.deepEqual(script.modes, [])
  assert.deepEqual(channels.calls, [])
  assert.equal(team.secrets.size, 0)
})

test('the default answerer is an Omni-kind Bot even when the Main Bot is another kind', async () => {
  const script = fakeScript()
  const seen = []
  const channels = fakeChannels({
    attach: async (input) => {
      seen.push(input)
      return { channelId: CHANNEL, channelName: 'Telegram', connected: true, detail: 'Helper' }
    },
  })
  const team = fakeTeam({ bots: [{ id: GENIE, name: 'Genie', kind: 'genie' }, { id: BOT, name: 'Omni', kind: 'omni' }], main: GENIE })
  const actions = install({ script, team, channels })
  const probe = await actions['migrate-probe']()
  assert.deepEqual(probe.omni.bots, [{ id: BOT, name: 'Omni', main: false }])
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'done')
  assert.equal(seen[0].answerBot, BOT)
})

test('the move reads the key, switches Hermes off, then hands it to Omni, and keeps no copy', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels()
  const actions = install({ script, team, channels })
  const started = await actions['migrate-start']({ confirm: true, answerBot: BOT })
  const done = await settled(actions, started.jobId)

  assert.equal(done.phase, 'done')
  assert.deepEqual(done.steps, MOVE_STEPS.map(id => ({ id, state: 'done' })))
  assert.deepEqual(script.modes, ['probe', 'read', 'disable', 'gateway'])
  assert.deepEqual(channels.calls.map(([name]) => name), ['omni-channel-create', 'omni-channel-pairing'])
  assert.equal(team.secrets.size, 0, 'the key stayed in the Bot team\'s store')
  assert.deepEqual(team.calls.filter(([kind]) => kind === 'secret').map(([, endpoint, body]) => [endpoint, body.name, body.scope]), [['secret-set', CARRIER_NAME, []]])
  assert.ok(!JSON.stringify(done).includes(FIXTURE_KEY), 'the status leaked the key')
  assert.deepEqual(done.result, {
    channelId: CHANNEL, channelName: 'Telegram', connected: true, botName: '@HefestoBot', chatUrl: 'https://t.me/HefestoBot',
    answering: false, answeringOff: false, attached: false, existing: false, answerBot: { id: BOT, name: 'Omni' }, hermesOff: true, hermesWasOff: false, hermesWasStopped: false, gatewayStopped: false,
  })
})

test('Omni\'s own attach is preferred and its answering answer is carried through', async () => {
  const team = fakeTeam()
  const seen = []
  const channels = fakeChannels({
    attach: async (input) => {
      seen.push(input)
      return { channelId: CHANNEL, channelName: 'Telegram', connected: true, detail: '@HefestoBot', botId: '777', answerBot: input.answerBot, answering: true }
    },
  })
  const actions = install({ script: fakeScript(), team, channels })
  const started = await actions['migrate-start']({ confirm: true, answerBot: BOT })
  const done = await settled(actions, started.jobId)
  assert.equal(done.phase, 'done')
  assert.deepEqual(seen, [{ token: FIXTURE_KEY, name: 'Telegram', source: 'hermes', answerBot: BOT }])
  assert.equal(channels.calls.length, 0, 'the fallback create ran beside the attach')
  assert.equal(done.result.attached, true)
  assert.equal(done.result.answering, true)
  assert.equal(team.secrets.size, 0)

  const off = install({ script: fakeScript(), team: fakeTeam(), channels: fakeChannels({
    attach: async (input) => ({ channelId: CHANNEL, channelName: 'Telegram', connected: true, detail: '@HefestoBot', answerBot: input.answerBot, answering: false, reason: 'other-channels' }),
  }) })
  const startedOff = await off['migrate-start']({ confirm: true, answerBot: BOT })
  const doneOff = await settled(off, startedOff.jobId)
  assert.equal(doneOff.result.answering, false)
  assert.equal(doneOff.result.answeringOff, true)
})

test('a Hermes that will not confirm its channel stopped starts nothing, puts the config back and keeps no key', async () => {
  const script = fakeScript({ after: { pid: 100, pidAlive: true, telegram: 'connected' } })
  const team = fakeTeam()
  const channels = fakeChannels()
  const actions = install({ script, team, channels })
  const started = await actions['migrate-start']({ confirm: true })
  const done = await settled(actions, started.jobId)

  assert.equal(done.phase, 'failed')
  assert.equal(done.error.code, 'hermes-still-on')
  assert.deepEqual(done.error.changed, { hermesOff: false, omniCreated: false })
  assert.ok(script.modes.includes('restore'))
  assert.deepEqual(channels.calls, [])
  assert.equal(team.secrets.size, 0)
  assert.ok(!JSON.stringify(done).includes(FIXTURE_KEY))
})

test('a gateway that refuses to restart puts the config back and never hands the key to Omni', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels()
  const actions = install({ script, team, channels, restart: async () => ({ ok: false, code: 'refused', message: 'Hermes would not restart.' }) })
  const started = await actions['migrate-start']({ confirm: true })
  const done = await settled(actions, started.jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.code, 'refused')
  assert.ok(script.modes.includes('restore'))
  assert.deepEqual(channels.calls, [])
  assert.equal(team.secrets.size, 0)
})

test('Hermes already off needs no restart, no edit and no backup', async () => {
  const script = fakeScript({ channel: 'off', gateway: { pid: 100, pidAlive: true, telegram: null } })
  const team = fakeTeam()
  const channels = fakeChannels()
  const restarts = []
  const actions = install({ script, team, channels, restart: async () => { restarts.push(1); return { ok: true } } })
  const started = await actions['migrate-start']({ confirm: true })
  const done = await settled(actions, started.jobId)
  assert.equal(done.phase, 'done')
  assert.deepEqual(script.modes, ['probe', 'read'])
  assert.deepEqual(restarts, [])
  assert.equal(done.result.hermesOff, true)
})

test('a gateway that does not come back still counts as off, and the page says so', async () => {
  const script = fakeScript({ after: { pid: null, pidAlive: false, telegram: null } })
  const actions = install({ script, team: fakeTeam(), channels: fakeChannels() })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'done')
  assert.equal(done.result.gatewayStopped, true)
})

test('Omni holding the move\'s own channel, with a bot id, keeps Hermes off and never acts on it', async () => {
  const channels = fakeChannels({ attach: async () => { throw new Error('name exists') }, instances: [{ id: CHANNEL, channel: 'telegram', name: 'Telegram', botId: KEY_PREFIX }] })
  const actions = install({ script: fakeScript(), team: fakeTeam(), channels })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'done')
  assert.equal(done.result.channelId, CHANNEL)
  assert.equal(done.result.connected, true)
  assert.equal(done.result.hermesOff, true)
  assert.equal(channels.calls.some(([name]) => name === 'omni-channel-act'), false)
  assert.ok(!done.error)
})

test('a retry with a channel and no bot id stops with Hermes off and says it is unknown', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels({ attach: async () => { throw new Error('name exists') }, instances: [{ id: CHANNEL, channel: 'telegram', name: 'Telegram' }] })
  let restarts = 0
  const actions = install({ script, team, channels, restart: async () => { restarts += 1; return { ok: true } } })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.changed.omniUnknown, true)
  assert.equal(done.error.changed.hermesOff, true)
  assert.equal(done.error.restored, undefined)
  assert.ok(!script.modes.includes('restore'), 'Hermes was put back without knowing the channel')
  assert.equal(restarts, 1, 'only the switch-off restart')
})

test('a refused attach is one fixed sentence, puts Hermes back on, and never echoes the key', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels({ attach: async () => { throw new Error(`bad request: ${FIXTURE_KEY}`) } })
  let restarts = 0
  const actions = install({ script, team, channels, restart: async () => { restarts += 1; return { ok: true } } })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.code, 'omni')
  assert.equal(done.error.message, 'Omni did not take the bot key. Nothing was handed to it.')
  assert.equal(done.error.restored, true)
  assert.deepEqual(done.error.changed, { hermesOff: false, omniCreated: false })
  assert.ok(script.modes.includes('restore'), 'Hermes was not put back')
  assert.equal(restarts, 2, 'the off restart and the restore restart')
  assert.ok(!JSON.stringify(done).includes(FIXTURE_KEY), 'the failure echoed the key')
  assert.equal(team.secrets.size, 0)

  const falling = fakeTeam()
  falling.team.secretEndpoint = async () => { throw new Error(`store refused ${FIXTURE_KEY}`) }
  const before = install({ script: fakeScript(), team: falling, channels: fakeChannels() })
  const failed = await settled(before, (await before['migrate-start']({ confirm: true })).jobId)
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error.message, 'The move did not finish.')
  assert.ok(!JSON.stringify(failed).includes(FIXTURE_KEY))
})

test('a key-shaped Hermes restart message reaches the job error only as [hidden]', async () => {
  const split = `${FIXTURE_KEY.slice(0, 10)} ${FIXTURE_KEY.slice(10)}`
  const actions = install({
    script: fakeScript(),
    team: fakeTeam(),
    channels: fakeChannels(),
    restart: async () => ({ ok: false, code: 'refused', message: `Hermes said ${split}` }),
  })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.code, 'refused')
  assert.ok(done.error.message.includes('[hidden]'), done.error.message)
  assert.ok(!JSON.stringify(done).includes(FIXTURE_KEY))
})

test('a Bot that stops being Omni between start and move fails before the key is read', async () => {
  const base = fakeTeam()
  let loads = 0
  base.team.load = async () => {
    loads += 1
    if (loads === 2) base.team.state.bots[BOT] = { ...base.team.state.bots[BOT], kind: 'genie' }
  }
  const script = fakeScript()
  const channels = fakeChannels()
  const actions = install({ script, team: base, channels })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true, answerBot: BOT })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.code, 'answerer')
  assert.deepEqual(script.modes, ['probe'])
  assert.deepEqual(channels.calls, [])
  assert.equal(base.secrets.size, 0)
})

test('an unreadable Omni channel list stops before Hermes changes', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels()
  channels.channels.omniRequest = async (_method, path) => path === '/instances' ? { ok: false } : { ok: true, json: async () => ({ items: [] }) }
  const actions = install({ script, team, channels })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.code, 'omni-list')
  assert.deepEqual(done.error.changed, { hermesOff: false, omniCreated: false })
  assert.deepEqual(script.modes, ['probe', 'read'])
  assert.equal(team.secrets.size, 0)
})

test('a stopped Hermes is not started to switch its channel off', async () => {
  const script = fakeScript({ gateway: { pid: null, pidAlive: false, telegram: null } })
  const team = fakeTeam()
  const channels = fakeChannels()
  let restarts = 0
  const actions = install({ script, team, channels, restart: async () => { restarts += 1; return { ok: true } } })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'done')
  assert.equal(done.result.hermesWasStopped, true)
  assert.deepEqual(script.modes, ['probe', 'read', 'disable'])
  assert.equal(restarts, 0)
})

test('a refusal on a stopped Hermes restores its settings without starting it', async () => {
  const script = fakeScript({ gateway: { pid: null, pidAlive: false, telegram: null } })
  const team = fakeTeam()
  const channels = fakeChannels({ attach: async () => { throw new Error('bad request') } })
  let restarts = 0
  const actions = install({ script, team, channels, restart: async () => { restarts += 1; return { ok: true } } })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.restored, true)
  assert.deepEqual(done.error.changed, { hermesOff: false, omniCreated: false })
  assert.ok(script.modes.includes('restore'))
  assert.ok(!script.modes.includes('gateway'))
  assert.equal(restarts, 0)
})

test('another bot named Telegram is never taken for the move, and a refusal puts Hermes back', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels({ attach: async () => { throw new Error('bad request') }, instances: [{ id: OTHER_CHANNEL, channel: 'telegram', name: 'Telegram', botId: OTHER_BOT }] })
  const actions = install({ script, team, channels })
  const probe = await actions['migrate-probe']()
  assert.equal(probe.omni.telegram, null)
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.restored, true)
  assert.deepEqual(done.error.changed, { hermesOff: false, omniCreated: false })
  assert.equal(channels.calls.some(([name]) => name === 'omni-channel-act'), false, 'the key was handed to another bot')
  assert.ok(script.modes.includes('restore'), 'Hermes was left off for another bot')
})

test('Omni refusing while holding the move\'s own channel keeps Hermes off', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  let listings = 0
  const channels = fakeChannels({ attach: async () => { throw new Error('bad request') } })
  channels.channels.omniRequest = async (_method, path) => {
    if (path === '/instances') return { ok: true, json: async () => ({ items: ++listings === 1 ? [] : [{ id: CHANNEL, channel: 'telegram', name: 'Telegram' }] }) }
    const status = /^\/instances\/([^/]+)\/status$/.exec(path)
    if (status !== null) return { ok: true, json: async () => ({ data: { state: 'connected', botId: KEY_PREFIX } }) }
    return { ok: true, json: async () => ({ items: [] }) }
  }
  const actions = install({ script, team, channels })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'done')
  assert.equal(done.result.channelId, CHANNEL)
  assert.equal(done.result.existing, false)
  assert.equal(done.result.hermesOff, true)
  assert.ok(!script.modes.includes('restore'), 'Hermes was put back while Omni had the move channel')
})

test('when Hermes cannot be put back, the page still says it is off', async () => {
  const script = fakeScript()
  const team = fakeTeam()
  const channels = fakeChannels({ attach: async () => { throw new Error('bad request') } })
  let restarts = 0
  const actions = install({ script, team, channels, restart: async () => { restarts += 1; return restarts === 1 ? { ok: true } : { ok: false, code: 'refused' } } })
  const done = await settled(actions, (await actions['migrate-start']({ confirm: true })).jobId)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.restoreFailed, 'restart')
  assert.deepEqual(done.error.changed, { hermesOff: true, omniCreated: false })
  assert.equal(team.secrets.size, 0)
})

test('two confirms are one move, and a finished job is readable by id only', async () => {
  const script = fakeScript()
  const channels = fakeChannels()
  const actions = install({ script, team: fakeTeam(), channels })
  const first = await actions['migrate-start']({ confirm: true })
  const second = await actions['migrate-start']({ confirm: true })
  assert.equal(second.jobId, first.jobId)
  await settled(actions, first.jobId)
  assert.deepEqual(channels.calls.filter(([name]) => name === 'omni-channel-create').length, 1)
  assert.deepEqual(await status(actions, '00000000-0000-0000-0000-000000000000'), { phase: 'none', steps: [] })
})

test('the Omni attach is preferred by the probe, and the t.me link only comes from a real username', async () => {
  const channels = fakeChannels({ attach: async () => ({}) })
  assert.equal(typeof omniApi(channels.channels).attach, 'function')
  assert.equal(omniApi(undefined), null)
  assert.equal(chatUrlOf('@HefestoBot'), 'https://t.me/HefestoBot')
  assert.equal(chatUrlOf('Hefesto'), 'https://t.me/Hefesto')
  assert.equal(chatUrlOf('Hefesto Bot'), null)
  assert.equal(chatUrlOf(''), null)
  assert.equal(chatUrlOf(null), null)
})
