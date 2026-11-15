// The Hermes half of the welcome's "From another tool" step. A person who runs Hermes can
// move Hermes's Telegram bot into Omni: this host reads the bot key only after the person
// confirms, switches Hermes's Telegram channel off on the Hermes host, and hands the key to
// Omni's write-only attach. The key never reaches the page, a log, this plugin's settings or
// a file: it travels through the Bot team's own write-only secrets (rt.secretEndpoint
// 'secret-set', rt.secretValue) and is deleted again as soon as Omni has it.
//
// The Hermes host is the one the Bot team already knows (Remote Hermes over SSH), else this
// computer's ~/.hermes. hermes-migrate.py runs there with the whole program on stdin: it
// reads config.yaml and .env, writes the explicit platforms.telegram.enabled: false that
// Hermes documents as the per-platform switch, copies config.yaml beside itself before the
// write, and reports the gateway record so this side can wait for the Telegram adapter to go.
// A failed check puts the copy back, and Omni is not started: one bot, one listener.
//
// Omni's own attach (omniTelegramAttach, host to host) is preferred the moment it exists;
// until then the linked Omni's existing write-only omni-channel-create and pairing answer.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = readFileSync(new URL('./hermes-migrate.py', import.meta.url), 'utf8')
const SENTINEL = '__OMNI_HERMES_JOB__'
export const CARRIER_NAME = 'OMNI_TELEGRAM_MOVE'
export const CHANNEL_NAME = 'Telegram'
const CARRIER_PURPOSE = 'Telegram bot key moving from Hermes into Omni'
// One fixed sentence for every Omni refusal: the shared redactor does not know a Telegram bot
// key's shape, so no provider text (which could quote it) is ever passed through.
const OMNI_REFUSED = 'Omni did not take the bot key. Nothing was handed to it.'
const KEY_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/
const TELEGRAM_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_OUT = 64 * 1024
const ACTIVE = new Set(['connected', 'connecting', 'reconnecting', 'starting', 'pending', 'qr'])
const DEFAULT_TIMES = Object.freeze({
  probeMs: 20_000, restartMs: 120_000, offWaitMs: 60_000, listenMs: 20_000, pollMs: 1_500, omniMs: 15_000,
})
// The steps a move reports, in the order the split requires. The page names them.
export const MOVE_STEPS = Object.freeze(['key', 'hermes', 'omni', 'listen'])

const fail = (code, message, extra) => Object.assign(new Error(message), { code: `omni-ai/migrate-${code}`, ...extra })
const text = value => (typeof value === 'string' ? value.trim() : '')
// A key may arrive split by a space or a line break after the colon. Masking runs first, over
// the raw text, so turning control characters into spaces can never separate a key first.
export function redactKey(value) {
  return String(value ?? '').replace(/\d{6,12}:(?:\s*[A-Za-z0-9_-]+)+/g, (match) => {
    const body = match.slice(match.indexOf(':') + 1).replace(/\s/g, '')
    return body.length >= 30 ? '[hidden]' : match
  })
}
// Nothing a Hermes child printed, and no key, ever comes back to the page.
const visible = value => Array.from(String(value ?? ''), ch => (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f ? ' ' : ch)).join('')
const clean = value => visible(redactKey(value))
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 300)

/** The Hermes host: the Bot team's Remote Hermes SSH details, else this computer. */
export function hermesTargetOf(team, { env = process.env, home = homedir() } = {}) {
  let view
  try {
    view = team?.hermesRemote?.view?.()
  } catch {
    view = undefined
  }
  const ssh = view?.enabled === true && view?.mode === 'ssh' ? view.ssh : undefined
  const host = text(ssh?.host).replace(/^.*@/, '')
  if (host !== '' && /^[a-zA-Z0-9_.:[\]-]+$/.test(host) && !host.startsWith('-')) {
    const user = text(ssh?.user)
    const port = ssh?.port === undefined || ssh?.port === '' ? undefined : Number(ssh.port)
    const identityFile = text(ssh?.identityFile)
    const usable = (user === '' || (/^[a-zA-Z0-9_.-]+$/.test(user) && !user.startsWith('-')))
      && (port === undefined || (Number.isSafeInteger(port) && port >= 1 && port <= 65535))
      && !identityFile.startsWith('-')
    if (usable) {
      return {
        where: 'ssh',
        ssh: {
          host,
          ...(user !== '' ? { user } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(identityFile !== '' ? { identityFile } : {}),
          ...(text(ssh?.hermesPath) !== '' ? { hermesPath: text(ssh.hermesPath) } : {}),
          ...(text(ssh?.hermesHome) !== '' ? { hermesHome: text(ssh.hermesHome) } : {}),
        },
      }
    }
  }
  const raw = text(env?.HERMES_HOME)
  return { where: 'local', home: raw !== '' ? raw : join(home, '.hermes') }
}

function sshCommand(target, remote) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', '-T']
  if (target.ssh.port !== undefined) args.push('-p', String(target.ssh.port))
  if (target.ssh.identityFile !== undefined) args.push('-i', target.ssh.identityFile)
  args.push(target.ssh.user !== undefined ? `${target.ssh.user}@${target.ssh.host}` : target.ssh.host, remote)
  return { command: 'ssh', args }
}

const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
const jobFor = (target, job) => ({
  ...job,
  ...(target.where === 'local' ? { home: target.home } : target.ssh.hermesHome !== undefined ? { home: target.ssh.hermesHome } : {}),
})

/** The command that runs hermes-migrate.py on the Hermes host, one JSON answer on stdout. */
export function scriptCommand(target, { python = 'python3' } = {}) {
  return target.where === 'local'
    ? { command: python, args: ['-'] }
    : sshCommand(target, 'command -v python3 >/dev/null 2>&1 && exec python3 - || exec python -')
}

/** Runs one command with bounded output, a deadline, and stdin carrying `input`. */
function run(command, args, { input = '', timeoutMs, env = process.env, spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, out: '', err: '', timedOut: false, spawnError: error?.code ?? 'SPAWN' })
      return
    }
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    let killed = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killed !== null) clearTimeout(killed)
      resolve(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* gone already */ }
      // A process that ignores SIGKILL on a dead pipe must not hold the step forever.
      killed = setTimeout(() => finish({ code: null, out, err, timedOut: true }), 1_500)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { if (out.length + chunk.length <= MAX_OUT) out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { if (err.length + chunk.length <= MAX_OUT) err += chunk.toString('utf8') })
    child.on?.('error', (error) => finish({ code: null, out, err, timedOut, spawnError: error?.code ?? 'SPAWN' }))
    child.on?.('close', (code) => finish({ code, out, err, timedOut }))
    try {
      child.stdin?.end(input)
    } catch {
      // A child that never opened its pipe fails on close, with its own code.
    }
  })
}

function lastJson(out) {
  const lines = String(out ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (!lines[at].startsWith('{')) continue
    try {
      return JSON.parse(lines[at])
    } catch {
      // Not our line.
    }
  }
  return null
}

/**
 * One hermes-migrate.py call. `execute` is injectable (tests use a stub, never a real Hermes).
 * Resolves the script's JSON; a handled failure is a `no-*`/`script` code on the error.
 */
export async function runHermes(target, job, { execute, timeoutMs = DEFAULT_TIMES.probeMs, spawn = nodeSpawn, python = 'python3' } = {}) {
  if (typeof execute === 'function') return execute(target, jobFor(target, job))
  const source = SCRIPT.replace(SENTINEL, Buffer.from(JSON.stringify(jobFor(target, job)), 'utf8').toString('base64'))
  const attempts = target.where === 'local' && python === 'python3' ? ['python3', 'python'] : [python]
  let last = null
  for (const binary of attempts) {
    const { command, args } = scriptCommand(target, { python: binary })
    const result = await run(command, args, { input: source, timeoutMs, spawn })
    if (result.spawnError === 'ENOENT' && attempts.length > 1) continue
    last = result
    break
  }
  if (last === null) throw fail('script', 'Hermes could not be reached from this computer.')
  if (last.timedOut) throw fail('timeout', 'Hermes did not answer in time. Nothing was changed.')
  if (last.spawnError !== undefined) throw fail('script', 'Hermes\'s host could not be reached from this computer.')
  const reply = lastJson(last.out)
  if (reply === null) throw fail('script', 'Hermes did not answer in a way this wizard could read. Nothing was changed.')
  if (reply.ok !== true) throw fail(reply.error ?? 'hermes', clean(reply.message) || 'Hermes could not do that. Nothing was changed.')
  return reply
}

/** `hermes gateway restart` on the Hermes host: the running adapter only stops when it restarts. */
export async function restartHermes(target, { execute, timeoutMs = DEFAULT_TIMES.restartMs, spawn = nodeSpawn, env = process.env } = {}) {
  if (typeof execute === 'function') return execute(target)
  const home = target.where === 'local' ? text(target.home) : text(target.ssh?.hermesHome)
  const hermes = target.where === 'local' ? 'hermes' : text(target.ssh?.hermesPath) || 'hermes'
  if (target.where === 'local') {
    const result = await run(hermes, ['gateway', 'restart'], {
      timeoutMs,
      spawn,
      input: '',
      env: { ...env, ...(home !== '' ? { HERMES_HOME: home } : {}), HERMES_NONINTERACTIVE: '1' },
    })
    return restartReply(result)
  }
  const command = `${home !== '' ? `HERMES_HOME=${quote(home)} ` : ''}HERMES_NONINTERACTIVE=1 ${quote(hermes)} gateway restart`
  const result = await run('ssh', sshCommand(target, command).args, { timeoutMs, spawn, input: '', env })
  return restartReply(result)
}

function restartReply(result) {
  if (result.spawnError === 'ENOENT') return { ok: false, code: 'missing', message: 'Hermes\'s own command is not on this computer, so it cannot restart itself here.' }
  if (result.timedOut) return { ok: false, code: 'timeout', message: 'Hermes did not come back after its restart in time.' }
  if (result.code !== 0) return { ok: false, code: 'refused', message: 'Hermes would not restart. It may still have a chat open, so nothing was handed to Omni.' }
  return { ok: true }
}

// ── Omni's side ───────────────────────────────────────────────────────────────────────────

const channelsOf = (ctx, deps) => deps.channels ?? ctx.get?.('omniChannels')
const teamOf = (ctx, deps) => deps.team ?? ctx.get?.('omniTeam')

/** The Omni channel type this move uses: A's attach when it is here, else create + pairing. */
export function omniApi(channels) {
  if (channels === undefined || channels === null) return null
  const attach = typeof channels.omniTelegramAttach === 'function' ? channels.omniTelegramAttach.bind(channels) : null
  const call = typeof channels.omniChannelEndpoint === 'function' ? channels.omniChannelEndpoint.bind(channels) : null
  if (attach === null && call === null) return null
  return { attach, call }
}

export function chatUrlOf(detail) {
  const name = text(detail).replace(/^@/, '')
  return TELEGRAM_NAME.test(name) ? `https://t.me/${name}` : null
}

async function pairingOf(api, id, { listenMs = 0, pollMs = 1_500 } = {}, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof api?.call !== 'function') return { state: 'unknown', connected: false, detail: null }
  const until = now() + listenMs
  let last = { state: 'unknown', connected: false, detail: null }
  for (;;) {
    try {
      const reply = await api.call('omni-channel-pairing', { id })
      last = {
        state: text(reply?.state) || (reply?.connected === true ? 'connected' : 'unknown'),
        connected: reply?.connected === true,
        detail: text(reply?.detail) || null,
      }
    } catch {
      // A read that fails is not a channel that is down; keep the last answer.
    }
    if (last.connected || now() >= until) return last
    await sleep(pollMs)
  }
}

// Reads the linked Omni's instances, to find a Telegram channel a previous try made. Kept
// quiet: a listing this wizard cannot make never blocks a move.
async function telegramChannel(channels, times, deps) {
  if (typeof channels?.omniRequest !== 'function' || typeof channels?.omniChannelEndpoint !== 'function') return null
  try {
    const response = await channels.omniRequest('GET', '/instances', { signal: AbortSignal.timeout(times.omniMs) })
    if (!response?.ok) return undefined
    const body = await response.json()
    const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.data) ? body.data : []
    const found = items.find(item => item && item.channel === 'telegram' && typeof item.id === 'string' && UUID.test(item.id))
    if (found === undefined) return null
    const pairing = await pairingOf({ call: channels.omniChannelEndpoint }, found.id, {}, { now: deps.now, sleep: deps.sleep })
    return { id: found.id, name: text(found.name) || CHANNEL_NAME, connected: pairing.connected === true, detail: pairing.detail ?? null }
  } catch {
    return undefined
  }
}

/** Hands the key to Omni: A's attach first (write-only, host to host), else the linked Omni's own create. */
async function attachInOmni(api, { token, answerBot }, { name = CHANNEL_NAME, source = 'hermes' } = {}) {
  if (typeof api?.attach === 'function') {
    let reply
    try {
      reply = await api.attach({ token, name, source, ...(answerBot !== undefined ? { answerBot } : {}) })
    } catch {
      throw fail('omni', OMNI_REFUSED)
    }
    const id = text(reply?.channelId)
    if (!UUID.test(id)) throw fail('omni', OMNI_REFUSED)
    return {
      id,
      name: text(reply?.channelName) || name,
      connected: reply?.connected === true,
      detail: text(reply?.detail) || null,
      answering: reply?.answering === true,
      reason: text(reply?.reason) || null,
      answerBot: text(reply?.answerBot) || answerBot,
      attached: true,
      existing: false,
    }
  }
  if (typeof api?.call !== 'function') throw fail('omni', 'Omni\'s channels plugin is not answering here, so the bot key cannot be handed to Omni.')
  let made
  try {
    made = await api.call('omni-channel-create', { type: 'telegram', name, token })
  } catch {
    throw fail('omni', OMNI_REFUSED)
  }
  if (!text(made?.id) || !UUID.test(made.id)) throw fail('omni', 'Omni did not return the channel it made.')
  return { id: made.id, name: text(made.name) || name, connected: false, detail: null, answering: false, reason: null, answerBot: answerBot ?? null, attached: false, existing: false }
}

// ── the step's answers ────────────────────────────────────────────────────────────────────

const setStep = (job, id, state) => {
  const step = job.steps.find(entry => entry.id === id)
  if (step !== undefined) step.state = state
}

// Omni's attach binds one of its channel Bots (the release refuses any other kind), so the
// picker has exactly those.
const cleanBots = (team) => {
  const bots = Object.values(team?.state?.bots ?? {})
    .filter(bot => bot && bot.kind === 'omni' && typeof bot.id === 'string' && typeof bot.name === 'string' && bot.name.trim() !== '')
    .map(bot => ({ id: bot.id, name: bot.name.trim().slice(0, 80), main: bot.id === team?.state?.mainBotId }))
  return bots.slice(0, 40)
}

const ANSWERER_REFUSED = 'Omni cannot use that Bot as the one who answers. Pick another; nothing was changed.'

/** Who Omni will let answer: only its channel Bots; the pick must still be one of them. */
function answererOf(team, wanted) {
  const bots = cleanBots(team)
  const asked = typeof wanted === 'string' && wanted !== '' ? wanted : null
  const picked = asked === null ? bots.find(bot => bot.main === true) ?? bots[0] ?? null : bots.find(bot => bot.id === asked) ?? null
  return { picked, valid: asked === null || picked !== null }
}

/**
 * The step's reads and its one move. `deps` are the host plugin's own (ctx), plus the
 * injectable edges tests use: execute, restart, channels, team, now, sleep, times.
 */
export function createMigrateActions(ctx, deps = {}) {
  const times = { ...DEFAULT_TIMES, ...deps.times }
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const state = { job: null }
  const team = () => teamOf(ctx, deps)
  const channels = () => channelsOf(ctx, deps)

  async function probe() {
    const target = hermesTargetOf(team(), deps)
    const hermes = await runHermes(target, { mode: 'probe' }, { ...deps, timeoutMs: times.probeMs })
    const channelsRt = channels()
    await Promise.resolve(team()?.load?.()).catch(() => {})
    const linked = Boolean(channelsRt?.omniNamed?.() ?? channelsRt?.config?.omni?.url)
    const listed = linked ? await telegramChannel(channelsRt, { ...times, listenMs: 0 }, { now, sleep }) : null
    const telegram = listed === undefined ? null : listed
    const gateway = hermes.gateway ?? {}
    const running = gateway.pidAlive === true && gateway.pid !== null
    const channel = text(hermes.hermes?.channel) || 'unknown'
    return {
      hermes: {
        found: hermes.hermes?.found === true,
        where: target.where,
        channel,
        key: text(hermes.hermes?.key) || 'missing',
        gatewayRunning: running,
        pendingRestart: channel === 'off' && running && ACTIVE.has(text(gateway.telegram).toLowerCase()),
      },
      omni: {
        linked,
        attach: typeof channelsRt?.omniTelegramAttach === 'function',
        bots: cleanBots(team()),
        telegram,
      },
    }
  }

  function begin(answerBot) {
    // One move at a time. A finished one is replaced by the next confirm, so a retry really retries.
    if (state.job?.phase === 'running') return state.job.id
    state.job = {
      id: randomUUID(),
      phase: 'running',
      startedAt: now(),
      steps: MOVE_STEPS.map(id => ({ id, state: 'pending' })),
      answerBot: typeof answerBot === 'string' ? answerBot : undefined,
      result: null,
      error: null,
    }
    void move(state.job).catch(() => {})
    return state.job.id
  }

  async function move(job) {
    const target = hermesTargetOf(team(), deps)
    const api = omniApi(channels())
    const botTeam = team()
    let carried
    let stored = false
    let hermesOff = false
    let hermesWasOff = false
    let gatewayStopped = false
    let channelId = null
    let backup = null
    let changed = { hermesOff: false, omniCreated: false }
    try {
      if (api === null) throw fail('no-omni', 'Omni is not connected in this DSH yet. Connect Omni, then come back to this step.')
      if (botTeam?.secretEndpoint === undefined || botTeam?.secretValue === undefined) throw fail('no-secrets', 'The Bot team\'s key store is not running here, so the key cannot be carried safely.')
      // Who answers is settled before the key is read and before Hermes changes at all: Omni
      // refuses a Bot it cannot bind, and that must not land after Hermes is already off.
      await Promise.resolve(botTeam?.load?.()).catch(() => {})
      const answerer = answererOf(botTeam, job.answerBot)
      if (answerer.valid !== true) throw fail('answerer', ANSWERER_REFUSED)

      setStep(job, 'key', 'now')
      const read = await runHermes(target, { mode: 'read' }, { ...deps, timeoutMs: times.probeMs })
      if (read.hermes?.found !== true) throw fail('no-hermes', 'Hermes was not found on the computer this DSH knows.')
      const token = text(read.token)
      if (!KEY_SHAPE.test(token)) throw fail('no-key', 'Hermes did not have a Telegram bot key this wizard can read. Nothing was changed.')
      if (read.hermes.channel === 'none') throw fail('no-channel', 'Hermes has no Telegram channel to move. Nothing was changed.')
      // The Bot team's own write-only store carries it between here and Omni; no Bot may use it.
      await botTeam.secretEndpoint('secret-set', { name: CARRIER_NAME, value: token, purpose: CARRIER_PURPOSE, scope: [] })
      stored = true
      carried = botTeam.secretValue(CARRIER_NAME)
      if (carried !== token) throw fail('no-secrets', 'The Bot team\'s key store did not take the key, so nothing was moved.')
      setStep(job, 'key', 'done')

      setStep(job, 'hermes', 'now')
      const before = read.gateway ?? { pid: null }
      const gatewayRunning = before.pidAlive === true && before.pid !== null
      const stillPolling = gatewayRunning && ACTIVE.has(text(before.telegram).toLowerCase())
      if (read.hermes.channel === 'off' && !stillPolling) {
        hermesOff = true
        hermesWasOff = true
      } else {
        if (read.hermes.channel === 'off') hermesWasOff = true
        if (read.hermes.channel !== 'off') {
          const off = await runHermes(target, { mode: 'disable' }, { ...deps, timeoutMs: times.probeMs })
          backup = text(off.backup) || null
        }
        const restarted = await restartHermes(target, { execute: deps.restart, timeoutMs: times.restartMs, spawn: deps.spawn })
        if (restarted.ok !== true) {
          // The old process still runs the channel: put its settings back exactly as they were.
          if (backup !== null) await runHermes(target, { mode: 'restore', backup }, { ...deps, timeoutMs: times.probeMs }).catch(() => {})
          throw fail(restarted.code ?? 'restart', restarted.message ?? 'Hermes would not restart.')
        }
        const waited = await waitOff(target, before)
        if (waited.off !== true) {
          // Put the Hermes channel back exactly as it was: Omni does not start on a maybe.
          if (backup !== null) await runHermes(target, { mode: 'restore', backup }, { ...deps, timeoutMs: times.probeMs }).catch(() => {})
          throw fail('hermes-still-on', 'Hermes did not confirm that its Telegram channel stopped, so nothing was handed to Omni and its settings were put back.')
        }
        hermesOff = true
        changed = { ...changed, hermesOff: true }
        gatewayStopped = waited.gatewayStopped === true
      }
      setStep(job, 'hermes', 'done')

      setStep(job, 'omni', 'now')
      let made
      try {
        const existing = await telegramChannel(channels(), { ...times, listenMs: 0 }, { now, sleep })
        if (existing !== undefined && existing !== null && existing.connected === true) {
          made = { id: existing.id, name: existing.name, connected: true, detail: existing.detail, answering: null, reason: null, answerBot: null, attached: false, existing: true }
        } else if (existing !== undefined && existing !== null && api.call !== null) {
          try {
            await api.call('omni-channel-act', { id: existing.id, action: 'token', token: carried })
          } catch {
            throw fail('omni', OMNI_REFUSED)
          }
          made = { id: existing.id, name: existing.name, connected: false, detail: null, answering: null, reason: null, answerBot: null, attached: false, existing: true }
        } else {
          made = await attachInOmni(api, { token: carried, answerBot: answerer.picked?.id }, { name: CHANNEL_NAME })
        }
      } catch (error) {
        // What Omni holds decides what happens to Hermes. A channel there is the move's
        // channel and stays the one listener; a confirmed empty Omni means Hermes goes back
        // on; an unreadable Omni leaves Hermes off and says so, never two listeners.
        const onOmni = await telegramChannel(channels(), { ...times, listenMs: 0 }, { now, sleep })
        if (onOmni !== undefined && onOmni !== null) {
          made = { id: onOmni.id, name: onOmni.name, connected: onOmni.connected, detail: onOmni.detail, answering: false, reason: null, answerBot: null, attached: true, existing: true }
          channelId = onOmni.id
          changed = { ...changed, omniCreated: true }
        } else {
          if (onOmni === null && hermesOff && backup !== null) {
            const restored = await restoreHermes(target, backup)
            if (restored.ok === true) {
              hermesOff = false
              changed = { ...changed, hermesOff: false }
              error.restored = true
            } else {
              error.restoreFailed = restored.reason
            }
          }
          throw error
        }
      }
      channelId = made.id
      changed = { ...changed, omniCreated: true }
      setStep(job, 'omni', 'done')

      setStep(job, 'listen', 'now')
      const pairing = made.connected === true
        ? { state: 'connected', connected: true, detail: made.detail }
        : await pairingOf(api, made.id, times, { now, sleep })
      setStep(job, 'listen', 'done')
      const detail = pairing.detail ?? made.detail
      job.result = {
        channelId: made.id,
        channelName: made.name,
        connected: pairing.connected === true,
        botName: detail,
        chatUrl: chatUrlOf(detail),
        answering: made.answering === true,
        answeringOff: made.answering === false && made.reason === 'other-channels',
        attached: made.attached === true,
        existing: made.existing === true,
        answerBot: answerer.picked === null ? null : { id: answerer.picked.id, name: answerer.picked.name },
        hermesOff,
        hermesWasOff,
        gatewayStopped,
      }
      job.phase = 'done'
      job.finishedAt = now()
    } catch (error) {
      const known = typeof error?.code === 'string' && error.code.startsWith('omni-ai/migrate-')
      const step = job.steps.find(entry => entry.state === 'now')
      if (step !== undefined) step.state = 'failed'
      job.error = {
        code: known ? error.code.slice('omni-ai/migrate-'.length) : 'failed',
        message: clean(known ? error.message : 'The move did not finish.'),
        changed,
        channelId,
        ...(error?.restored === true ? { restored: true } : {}),
        ...(typeof error?.restoreFailed === 'string' ? { restoreFailed: error.restoreFailed } : {}),
      }
      job.phase = 'failed'
      job.finishedAt = now()
    } finally {
      // Whatever happened, the carrier goes: Omni has the key or it does not, and this plugin
      // never keeps a copy (the Bot team's store only holds it while the move runs).
      if (stored) {
        if (typeof botTeam?.deleteSecretIfUnchanged === 'function' && carried !== undefined) {
          await Promise.resolve(botTeam.deleteSecretIfUnchanged(CARRIER_NAME, carried)).catch(() => {})
        } else {
          await Promise.resolve(botTeam?.secretEndpoint?.('secret-delete', { name: CARRIER_NAME })).catch(() => {})
        }
      }
      carried = undefined
    }
  }

  async function waitOff(target, before) {
    const until = now() + times.offWaitMs
    // A gateway found dead is given this long to come back with its new process before the
    // move carries on without it. Telegram is already off in the config either way.
    const reviveMs = Math.min(15_000, times.offWaitMs)
    let deadSince = null
    for (;;) {
      await sleep(times.pollMs)
      let last
      try {
        const reply = await runHermes(target, { mode: 'gateway' }, { ...deps, timeoutMs: times.probeMs })
        last = reply.gateway ?? {}
      } catch {
        if (now() >= until) return { off: false, gatewayStopped: false }
        continue
      }
      const pid = last.pid ?? null
      const moved = pid !== (before?.pid ?? null)
      const alive = last.pidAlive === true
      const telegram = text(last.telegram).toLowerCase()
      const stopped = telegram === '' || ['stopped', 'disabled', 'disconnected', 'fatal'].includes(telegram)
      if (!alive) {
        deadSince ??= now()
        if (now() - deadSince >= reviveMs || now() >= until) return { off: true, gatewayStopped: true }
        continue
      }
      deadSince = null
      if (moved && stopped) return { off: true, gatewayStopped: false }
      if (now() >= until) return { off: false, gatewayStopped: false, gateway: last }
    }
  }


  // Hermes goes back on after a refusal it did not cause: settings back, gateway restarted,
  // and a moment to see the process return. It is never done while Omni has the channel.
  async function restoreHermes(target, backup) {
    try {
      await runHermes(target, { mode: 'restore', backup }, { ...deps, timeoutMs: times.probeMs })
    } catch {
      return { ok: false, reason: 'copy' }
    }
    const restarted = await restartHermes(target, { execute: deps.restart, timeoutMs: times.restartMs, spawn: deps.spawn })
    if (restarted.ok !== true) return { ok: false, reason: 'restart' }
    const until = now() + Math.min(15_000, times.offWaitMs)
    for (;;) {
      await sleep(times.pollMs)
      try {
        const reply = await runHermes(target, { mode: 'gateway' }, { ...deps, timeoutMs: times.probeMs })
        if (reply.gateway?.pidAlive === true) return { ok: true }
      } catch {
        // The next look asks again.
      }
      if (now() >= until) return { ok: false, reason: 'pending' }
    }
  }

  return {
    async 'migrate-probe'() {
      return probe()
    },
    async 'migrate-start'(payload) {
      if (payload?.confirm !== true) throw fail('confirm', 'Confirm the move first.')
      if (state.job?.phase === 'running') return { jobId: state.job.id, running: true }
      const botTeam = team()
      await Promise.resolve(botTeam?.load?.()).catch(() => {})
      const wanted = typeof payload?.answerBot === 'string' && payload.answerBot !== '' ? payload.answerBot : undefined
      if (wanted !== undefined && answererOf(botTeam, wanted).valid !== true) throw fail('answerer', ANSWERER_REFUSED)
      const target = hermesTargetOf(team(), deps)
      const read = await runHermes(target, { mode: 'probe' }, { ...deps, timeoutMs: times.probeMs })
      if (read.hermes?.found !== true) throw fail('no-hermes', 'Hermes was not found on the computer this DSH knows.')
      if (read.hermes.channel === 'none') throw fail('no-channel', 'Hermes has no Telegram channel to move.')
      if (read.hermes.key !== 'available') throw fail('no-key', 'Hermes keeps its bot key where this wizard cannot read it.')
      if (omniApi(channels()) === null) throw fail('no-omni', 'Omni is not connected in this DSH yet.')
      const id = begin(wanted)
      return { jobId: id, running: true }
    },
    async 'migrate-status'(payload) {
      const id = text(payload?.jobId)
      if (state.job === null || state.job.id !== id) return { phase: 'none', steps: [] }
      return {
        jobId: state.job.id,
        phase: state.job.phase,
        steps: state.job.steps.map(step => ({ ...step })),
        result: state.job.result === null ? null : { ...state.job.result },
        error: state.job.error === null ? null : { ...state.job.error },
      }
    },
    async 'migrate-omni-status'(payload) {
      const id = text(payload?.channelId)
      if (!UUID.test(id)) throw fail('channel', 'Unknown Omni channel.')
      const api = omniApi(channels())
      if (api?.call === null) throw fail('no-omni', 'Omni\'s channels plugin is not answering here.')
      const pairing = await pairingOf({ call: api.call }, id, { listenMs: 0 }, { now, sleep })
      return { connected: pairing.connected, state: pairing.state, detail: pairing.detail, chatUrl: chatUrlOf(pairing.detail) }
    },
  }
}
