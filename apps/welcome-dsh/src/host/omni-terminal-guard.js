// Omni owns the editable prompt. Only an unedited Enter lets the welcome take over
// the install, and the terminal keeps the same offsets after its PTY is released.
import { setTimeout as delay } from 'node:timers/promises'

const TITLE = 'Install Omni on this computer'
const VERSION = /(?:^|\s)@automagik\/omni@(\d+\.\d{6}\.\d+(?:-[0-9A-Za-z.]+)?)(?=\s|$)/
const ENDED = new Set(['done', 'failed', 'cancelled'])
const BUFFER_MAX = 256 * 1024
const IDLE_MS = 30 * 60_000
const READY_MS = 6 * 60_000
const STOP = Symbol()
const READ = 'omni-terminal-read'
const CLOSE = 'omni-terminal-close'
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const enter = data => data === '\r' || data === '\n' || data === '\r\n'
const pause = (ms, signal) => delay(ms, undefined, { signal, ref: false })

const WORDS = {
  behind: ["npm's newest Omni is {npm}, older than Omni {version}, which this Automagik installs.", 'A versão mais recente do Omni no npm é {npm}, anterior à versão {version} que este Automagik instala.'],
  older: ['The Omni release on npm is too old.', 'A versão do Omni no npm é antiga demais.'],
  unpublished: ['Omni {version} is not on npm (the newest there is {npm}).', 'O Omni {version} não está no npm (a versão mais recente lá é {npm}).'],
  'no-systemd': ["Omni's npm installer needs systemd, and this computer has none.", 'O instalador do Omni pelo npm precisa do systemd, que não está disponível neste computador.'],
  'npm-failed': ['Installing Omni from npm failed (exit code {code}).', 'A instalação do Omni pelo npm falhou (código de saída {code}).'],
  npmFailed: ['Installing Omni from npm failed.', 'A instalação do Omni pelo npm falhou.'],
  github: ['Installing Omni {version} from GitHub instead.', 'Instalando o Omni {version} pelo GitHub.'],
  npm: ['Installing Omni {version} from npm.', 'Instalando o Omni {version} pelo npm.'],
  fellBack: ['npm could not install it either. Installing Omni {version} from GitHub instead.', 'A instalação pelo npm também falhou. Instalando o Omni {version} pelo GitHub.'],
  unknown: ['unknown', 'desconhecida'],
  check: ['Check', 'Verificar'],
  download: ['Download', 'Baixar'],
  build: ['Build', 'Compilar'],
  install: ['Install', 'Instalar'],
  connect: ['Connect', 'Conectar'],
  stopping: ['Stopping after this step…', 'Parando após esta etapa…'],
  retry: ['Open the terminal again to try again.', 'Abra o terminal novamente para tentar de novo.'],
  update: ['Update Automagik, then try again.', 'Atualize o Automagik e tente novamente.'],
  'other-omni': ['Use an Omni on another computer.', 'Use um Omni em outro computador.'],
  lost: ["The install's progress was lost (Automagik may have restarted).", 'O progresso da instalação foi perdido (o Automagik pode ter reiniciado).'],
  installFailed: ['Omni could not be installed from GitHub.', 'Não foi possível instalar o Omni pelo GitHub.'],
  readFailed: ['Could not read the Omni terminal.', 'Não foi possível ler o terminal do Omni.'],
  notReady: ["Omni's terminal did not get ready. Close it and try again.", 'O terminal do Omni não ficou pronto. Feche-o e tente novamente.'],
  readOnly: ['This window no longer controls the Bot team. Open the team where it runs to finish connecting Omni.', 'Esta janela não controla mais a equipe de Bots. Abra a equipe onde ela está rodando para terminar de conectar o Omni.'],
  noAddress: ['Omni is installed, but its address is unknown.', 'O Omni está instalado, mas não foi possível identificar o endereço.'],
  noAnswer: ['Omni is installed but did not answer at {url}.', 'O Omni está instalado, mas não respondeu em {url}.'],
  otherLink: ['This Automagik is already connected to another Omni ({origin}). The new Omni runs at {url}; connect to it from the Omni list.', 'Este Automagik já está conectado a outro Omni ({origin}). O novo Omni está em {url}; conecte-se a ele pela lista de Omnis.'],
  otherPairing: ['Another Omni sign-in is waiting ({origin}). Finish or cancel it, then connect to the new Omni at {url} from the Omni list.', 'Há outro login do Omni aguardando ({origin}). Conclua ou cancele esse login e depois conecte-se ao novo Omni em {url} pela lista de Omnis.'],
  connected: ['Connected to Omni {version}.', 'Conectado ao Omni {version}.'],
  connectFailed: ['Could not connect to the new Omni.', 'Não foi possível conectar ao novo Omni.'],
}
const words = (entry, key, fields = {}) => WORDS[key][entry.pt ? 1 : 0].replace(/\{(\w+)\}/g, (_, name) => fields[name])

function reasonLine(entry, { reason, npm, release }) {
  if (reason === 'behind' && !release?.version) return words(entry, 'older')
  if (reason === 'npm-failed' && !Number.isInteger(npm.exitCode)) return words(entry, 'npmFailed')
  return words(entry, reason, {
    npm: npm.latest ?? (reason === 'behind' ? npm.version : words(entry, 'unknown')),
    version: reason === 'behind' ? release.version : npm.version, code: npm.exitCode,
  })
}

function publicError(error, fallback) {
  return ['omni-ai/refused', 'omni-ai/invalid', 'bot/refused', 'bot/invalid'].includes(error?.code)
    ? error.message : fallback
}

// Keep in sync with the welcome card's URL comparison in team.js.
function cleanUrl(text) {
  const value = String(text ?? '').trim()
  if (!value || (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value))) return null
  let url
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`) } catch { return null }
  if (url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/api\/v2\/?$/, '').replace(/\/+$/, '')}`
}

const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'localhost' : host

function sameUrl(a, b) {
  const left = cleanUrl(a)
  const right = cleanUrl(b)
  if (!left || !right) return false
  const first = new URL(left)
  const second = new URL(right)
  return first.protocol === second.protocol && loopback(first.hostname) === loopback(second.hostname)
    && first.port === second.port && first.pathname === second.pathname
}

function sameOrigin(origin, target) {
  if (typeof origin !== 'string' || /[/\\?#@\s]/.test(origin)) return false
  const url = new URL(target)
  try {
    const candidate = new URL(`${url.protocol}//${origin}`)
    return loopback(candidate.hostname) === loopback(url.hostname) && candidate.port === url.port
  } catch { return false }
}

// Bound the local wait even when the endpoint has no cancellation support.
async function until(signal, request, ms) {
  let timer
  let abort
  const stopped = new Promise(resolve => {
    abort = () => resolve(STOP)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    if (ms !== undefined) timer = setTimeout(abort, Math.max(0, ms))
  })
  try { return await Promise.race([stopped, request]) } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

function outputOf({ data = '', next = 0, base = next - data.length }) {
  return { base, data, end: next }
}

function appendOutput(output, text) {
  output.data = (output.data + text).slice(-BUFFER_MAX)
  output.end += text.length
  output.base = output.end - output.data.length
}

function append(entry, text, color) {
  const line = color ? `\x1b[${color}m${text}\x1b[0m` : text
  appendOutput(entry.output, line.replace(/\r?\n/g, '\r\n'))
}

function line(entry, text, color) { append(entry, text + '\r\n', color) }

function fail(entry, error, advice) {
  entry.phase = 'failed'
  entry.error = error
  line(entry, error, 31)
  if (advice) line(entry, advice)
}

export function createOmniTerminalGuard({
  check, available, installer, endpointOf, readOnly, language, now = Date.now, wait = pause,
  generation = () => undefined, sameTeam = () => true,
  connectMs = 180_000, connectPoll = 2000, jobPoll = 1000,
}) {
  const terminals = new Map()
  let live = true
  const ownsTeam = entry => sameTeam(entry.generation) && readOnly() === undefined
  const call = (name, body, signal) => endpointOf(name)?.(body, signal)
  const terminalRead = (entry, from) => call(READ, { terminal: entry.id, from }, entry.signal)
  const ask = version => Promise.resolve().then(() => check(version, available)).catch(() => undefined)

  function requireTeam(entry) {
    if (ownsTeam(entry)) return true
    beginOutput(entry)
    fail(entry, words(entry, 'readOnly'))
    return false
  }

  const active = entry => live && !entry.signal.aborted && !ENDED.has(entry.phase)
  const canContinue = entry => active(entry) && requireTeam(entry)

  function get(body) {
    const entry = terminals.get(body?.terminal)
    if (entry) entry.touched = now()
    return entry
  }

  function queue(entry, run) {
    const result = entry.writes.then(() => entry.signal.aborted ? { ok: false } : run())
    entry.writes = result.catch(() => {})
    return result
  }

  function releasePty(entry, close) {
    if (!entry.pty) return { ok: true }
    entry.pty = false
    return close({ terminal: entry.id })
  }

  async function detach(entry, close = body => call(CLOSE, body)) {
    terminals.delete(entry.id)
    if (!entry.useDispatched) {
      if (!ENDED.has(entry.phase)) entry.phase = 'cancelled'
      entry.controller.abort()
    }
    return releasePty(entry, close)
  }

  function sweep() {
    const time = now()
    for (const entry of terminals.values()) {
      if (time - entry.touched >= IDLE_MS) void detach(entry).catch(() => {})
    }
  }
  const timer = setInterval(sweep, 60_000)
  timer.unref()

  function dispose() {
    live = false
    clearInterval(timer)
    for (const entry of terminals.values()) void detach(entry).catch(() => {})
  }

  async function open(body, _signal, next) {
    await Promise.all([...terminals.values()].map(async entry => {
      if (entry.phase !== 'npm' || !entry.forwarded || entry.flushed || ENDED.has(entry.snapshot.reply.state)) return
      // Omni's open reaps ended terminals. Save their last reply for the npm monitor.
      try {
        const reply = await terminalRead(entry, entry.snapshot.output.end)
        if (entry.phase === 'npm' && ENDED.has(reply?.state) && !ENDED.has(entry.snapshot.reply.state)) {
          entry.flushed = reply
          snapshotPending(entry, reply)
        }
      } catch { /* The terminal may already have closed. */ }
    }))
    if (body?.via === 'welcome') {
      const { via, ...payload } = body
      return next(payload)
    }
    if (body?.kind !== 'install' || !live || readOnly() !== undefined) return next(body)
    sweep()
    const pt = /^(pt(?:-|$)|portugu[êe]s|portuguese)/i.test(language?.() ?? '')
    const reply = await next(body)
    if (live && reply?.terminal) {
      const controller = new AbortController()
      terminals.set(reply.terminal, {
        id: reply.terminal, pt, controller, signal: controller.signal, touched: now(),
        phase: 'npm', pty: true, deciding: false, forwarded: false, cancelled: false,
        passthrough: false, servedNext: 0, writes: Promise.resolve(),
      })
    }
    return reply
  }

  async function ready(entry) {
    const deadline = now() + READY_MS
    while (!entry.signal.aborted && now() < deadline) {
      const reply = await until(entry.signal, terminalRead(entry, 0), deadline - now())
      if (reply === STOP) break
      if (reply?.state === 'ready' || ENDED.has(reply?.state)) return reply
      await wait(Math.min(250, deadline - now()), entry.signal)
    }
  }

  function snapshot(entry, reply) {
    const { data, next, base, ...status } = reply
    const output = outputOf({ data, next, base })
    const old = entry.snapshot?.output
    if (old && old.end > output.end) return
    if (old && output.base >= old.base && output.base <= old.end) {
      appendOutput(old, output.data.slice(old.end - output.base))
      entry.snapshot.reply = status
    } else {
      entry.snapshot = { output, reply: status }
    }
  }

  function snapshotPending(entry, reply) {
    // The monitor decides the outcome once Omni has accepted the write.
    const { terminal, title, command, data, next, base } = reply
    snapshot(entry, { terminal, title, command, state: 'ready', step: null, data, next, base })
  }

  function beginOutput(entry) {
    if (entry.output) return
    entry.prefix = entry.snapshot?.output ?? outputOf({})
    const base = Math.max(entry.prefix.end, entry.servedNext)
    entry.output = { base, data: '', end: base }
    entry.snapshot = null
    append(entry, '\n')
  }

  function switchTerminal(entry) {
    if (entry.cutover) return entry.cutover
    // Publish the cutover promise before reading the PTY so racing reads can use one offset space.
    entry.cutover = Promise.resolve().then(async () => {
      if (!canContinue(entry)) return false
      const finalRead = Promise.resolve().then(() => terminalRead(entry, 0)).catch(() => null)
      const reply = await until(entry.signal, finalRead)
      if (reply === STOP || !canContinue(entry)) return false
      if (reply) snapshot(entry, reply)
      beginOutput(entry)
      entry.phase = 'github'
      try {
        await releasePty(entry, body => call(CLOSE, body))
        return true
      } catch (error) {
        if (canContinue(entry)) fail(entry, publicError(error, words(entry, 'readFailed')))
        return false
      }
    })
    void entry.cutover.then(() => { if (!entry.output) entry.cutover = undefined })
    return entry.cutover
  }

  function paired(entry, origin, version) {
    entry.phase = 'done'
    entry.result = { status: 'paired', origin, version }
    line(entry, '✓ ' + words(entry, 'connect'), 32)
    line(entry, words(entry, 'connected', { version }), 32)
  }

  function pairing(entry, value, target) {
    if (!sameOrigin(value.origin, target)) {
      return fail(entry, words(entry, 'otherPairing', { origin: value.origin ?? words(entry, 'unknown'), url: target }))
    }
    entry.phase = 'done'
    entry.result = { status: 'pairing', pairing: value }
  }

  async function connect(entry, job) {
    const target = cleanUrl(job.report?.apiUrl)
    if (!target) return fail(entry, words(entry, 'noAddress'))
    entry.phase = 'connect'
    line(entry, '→ ' + words(entry, 'connect'))
    const deadline = now() + connectMs
    const read = endpoint => {
      if (!canContinue(entry) || now() >= deadline) return STOP
      const request = Promise.resolve().then(() => {
        if (active(entry)) return call(endpoint, {}, entry.signal)
      }).catch(() => null)
      return until(entry.signal, request, deadline - now())
    }
    let claimLost = false
    while (canContinue(entry) && now() < deadline) {
      const found = claimLost ? null : await read('omni-discover')
      if (found === STOP || now() >= deadline) break
      // This is the final link check before the claim. A winning claim dispatches use immediately.
      const link = await read('omni-link')
      if (link === STOP || !canContinue(entry) || now() >= deadline) break
      if (link?.linked === true || link?.configured === true) {
        // Omni's public origin is a host and port. The runtime also supplies its saved URL.
        const origin = link.url ?? (link.origin && (link.origin.includes('://') ? link.origin : new URL(target).protocol + '//' + link.origin))
        if (!link.origin || !sameUrl(origin, target)) {
          return fail(entry, words(entry, 'otherLink', { origin: link.origin ?? words(entry, 'unknown'), url: target }))
        }
        if (!claimLost) {
          try { void Promise.resolve(installer.ack({ id: job.id })).catch(() => {}) } catch { /* Already linked. */ }
        }
        return paired(entry, link.origin, job.report.version)
      }
      if (link?.pairing) return pairing(entry, link.pairing, target)
      const omnis = Array.isArray(found?.omnis) ? found.omnis : []
      const sandbox = omnis.find(omni => omni.source === 'sandbox' && omni.reachable === true
        && omni.version === job.report.version && sameUrl(omni.url, target))
      if (link && sandbox) {
        const ack = installer.ack({ id: job.id })
        const claim = typeof ack?.then === 'function' ? await ack : ack
        if (claim?.claimed === true) {
          if (entry.cancelled || !requireTeam(entry)) return
          // The endpoint can save a link after the card closes. Await its actual outcome.
          entry.useDispatched = true
          entry.phase = 'connect'
          const reply = await call('omni-discover-use', { id: sandbox.id })
          if (reply?.status === 'paired') return paired(entry, reply.origin, job.report.version)
          if (reply?.status === 'pairing' && reply.pairing) return pairing(entry, reply.pairing, target)
          return fail(entry, reply?.message ?? words(entry, 'connectFailed'))
        }
        claimLost = true
      }
      if (!canContinue(entry)) break
      await wait(Math.min(connectPoll, deadline - now()), entry.signal)
    }
    if (canContinue(entry)) fail(entry, words(entry, 'noAnswer', { url: target }))
  }

  function showStopping(entry, job) {
    if (job?.phase !== 'running' || !job.cancelRequested || entry.stopping) return
    entry.stopping = true
    line(entry, words(entry, 'stopping'))
  }

  function showJob(entry, job) {
    if (job.fellBack && !entry.fellBack) {
      entry.fellBack = true
      line(entry, words(entry, 'fellBack', job.release), 36)
    }
    for (const { id, state } of job.steps) {
      if (state === entry.steps.get(id)) continue
      entry.steps.set(id, state)
      if (state === 'now') line(entry, '→ ' + words(entry, id))
      if (state === 'done') line(entry, '✓ ' + words(entry, id), 32)
    }
    showStopping(entry, job)
  }

  async function driveJob(entry, payload, answer) {
    if (!canContinue(entry)) return
    try {
      const previousId = installer.status()?.job?.id
      entry.starting = Promise.resolve(installer.start(payload))
      const started = await until(entry.signal, entry.starting)
      if (started === STOP || !active(entry)) return
      let { job } = started
      if (!requireTeam(entry)) {
        if (job && job.id !== previousId) {
          try { await installer.cancel({ id: job.id }) } catch { /* Cancellation may be refused in a read-only view. */ }
        }
        return
      }
      if (!job) return fail(entry, words(entry, 'lost'))
      entry.jobId = job.id
      entry.steps = new Map()
      line(entry, reasonLine(entry, job), 33)
      if (!job.fellBack) line(entry, words(entry, job.source, job.release), 36)
      for (;;) {
        showJob(entry, job)
        if (job.phase === 'done') return await connect(entry, job)
        if (job.phase === 'failed') {
          fail(entry, job.error ?? words(entry, 'installFailed'), job.next && words(entry, job.next))
          const log = (job.log ?? '').replace(/\r?\n$/, '')
          if (log) for (const text of log.split(/\r?\n/).slice(-20)) line(entry, text.slice(0, 300))
          return
        }
        if (job.phase === 'cancelled') {
          entry.phase = 'cancelled'
          return
        }
        await wait(jobPoll, entry.signal)
        if (!canContinue(entry)) return
        const status = await until(entry.signal, installer.status({ id: entry.jobId }))
        if (status === STOP || !canContinue(entry)) return
        job = status?.job
        if (!job) return fail(entry, words(entry, 'lost'))
      }
    } catch (error) {
      if (!entry.useDispatched && !canContinue(entry)) return
      if (!entry.jobId) {
        line(entry, reasonLine(entry, {
          reason: payload.reason, npm: { version: payload.version, latest: answer?.npm, exitCode: payload.exitCode },
          release: answer?.fallback,
        }), 33)
      }
      const fallback = words(entry, entry.phase === 'connect' ? 'connectFailed' : 'installFailed')
      fail(entry, publicError(error, fallback))
    }
  }

  async function monitor(entry, version, answer) {
    try {
      while (canContinue(entry)) {
        let reply = entry.flushed
        if (!reply) {
          try {
            reply = await until(entry.signal, terminalRead(entry, entry.snapshot.output.end))
          } catch (error) {
            if (!entry.flushed) throw error
          }
          reply = entry.flushed ?? reply
        }
        entry.flushed = undefined
        if (reply === STOP || !canContinue(entry)) return
        if (!reply) throw new Error('Omni terminal reply missing')
        const { exitCode } = reply
        if (reply.state === 'failed' && typeof exitCode === 'number' && exitCode !== 0 && exitCode !== 130 && !entry.cancelled) {
          answer ??= await until(entry.signal, ask(version))
          if (!canContinue(entry)) return
          if (!entry.cancelled && (answer?.fallback || (answer?.reason === 'no-systemd' && answer.npmHas === true))) {
            snapshot(entry, reply)
            if (await switchTerminal(entry)) await driveJob(entry, { version, reason: 'npm-failed', exitCode }, answer)
            return
          }
        }
        snapshot(entry, reply)
        if (ENDED.has(reply.state)) return
        await wait(400, entry.signal)
      }
    } catch (error) {
      if (canContinue(entry)) {
        beginOutput(entry)
        fail(entry, publicError(error, words(entry, 'readFailed')))
      }
    }
  }

  async function write(body, _signal, next) {
    const entry = get(body)
    if (!entry) return next(body)
    if (ENDED.has(entry.phase) || entry.useDispatched) return { ok: false }
    const forward = async () => {
      const reply = await until(entry.signal, next(body))
      return reply === STOP ? { ok: false } : reply
    }
    if (entry.passthrough || (!entry.deciding && !entry.forwarded && !entry.output && readOnly() !== undefined)) {
      return queue(entry, forward)
    }
    const { data } = body
    if (typeof data !== 'string' || !data.length || data.length > 4096) throw invalid('Name the terminal and what to type')
    const isEnter = enter(data)
    if (isEnter && entry.deciding) return { ok: true }
    if (isEnter && entry.phase === 'npm' && !entry.forwarded) {
      entry.generation = generation()
      entry.deciding = true
    }
    return queue(entry, async () => {
      try {
        if (entry.useDispatched || !canContinue(entry)) return { ok: false }
        if (entry.passthrough) return forward()
        // Fallback can begin in the monitor between writes.
        if (entry.cutover) await entry.cutover
        if (!canContinue(entry)) return { ok: false }
        if (entry.phase !== 'npm') {
          if (data !== '\u0003') return { ok: false }
          return cancel(entry)
        }
        if (entry.forwarded) {
          if (data.includes('\u0003')) entry.cancelled = true
          return forward()
        }
        if (!isEnter) {
          entry.passthrough = true
          return forward()
        }
        try {
          const reply = await ready(entry)
          if (!canContinue(entry)) return { ok: false }
          if (reply && (!entry.snapshot || reply.next > entry.snapshot.output.end)) snapshot(entry, reply)
          if (reply?.state !== 'ready') {
            beginOutput(entry)
            fail(entry, reply?.error ?? words(entry, 'notReady'))
            return { ok: false }
          }
          const version = VERSION.exec(reply.command)?.[1]
          if (!version) {
            entry.passthrough = true
            return forward()
          }
          entry.command = reply.command
          const answer = await until(entry.signal, ask(version))
          if (!canContinue(entry)) return { ok: false }
          if (answer?.ok === false) {
            if (await switchTerminal(entry)) void driveJob(entry, { version, reason: answer.reason }, answer)
            return { ok: true }
          }
          entry.deciding = false
          entry.forwarded = true
          try {
            const result = await forward()
            if (!canContinue(entry)) return { ok: false }
            if (result?.ok === true) {
              entry.monitoring = true
              void monitor(entry, version, answer)
            }
            return result
          } finally {
            if (!entry.monitoring) {
              entry.forwarded = false
              if (entry.flushed && !entry.output) snapshot(entry, entry.flushed)
            }
          }
        } catch (error) {
          if (canContinue(entry)) {
            beginOutput(entry)
            fail(entry, publicError(error, words(entry, 'readFailed')))
          }
          return { ok: false }
        }
      } finally {
        if (isEnter) entry.deciding = false
      }
    })
  }

  async function cancel(entry) {
    if (entry.phase === 'github' && !entry.jobId && entry.starting) {
      await until(entry.signal, entry.starting.catch(() => {}))
    }
    if (entry.useDispatched || !canContinue(entry)) return { ok: false }
    if (entry.phase === 'github' && entry.jobId) {
      const request = installer.cancel({ id: entry.jobId })
      const result = typeof request?.then === 'function' ? await request : request
      if (entry.useDispatched || !canContinue(entry)) return { ok: false }
      if (result?.job?.id !== entry.jobId) return { ok: true }
      if (result.job.phase !== 'done') {
        showStopping(entry, result.job)
        return { ok: true }
      }
      // The install completed between status polls. Cancel the pending connection.
    } else if (entry.phase !== 'connect') {
      return { ok: false }
    }
    entry.cancelled = true
    entry.phase = 'cancelled'
    entry.controller.abort()
    return { ok: true }
  }

  function view(entry, from) {
    const slice = output => output.data.slice(Math.max(0, from - output.base))
    if (entry.output) {
      return {
        terminal: entry.id, title: TITLE, command: entry.command, step: null,
        state: entry.phase === 'github' ? 'ready' : entry.phase === 'connect' ? 'linking' : entry.phase,
        data: slice(entry.prefix) + slice(entry.output), next: entry.output.end,
        ...(entry.result ? { result: entry.result } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      }
    }
    return { ...entry.snapshot.reply, data: slice(entry.snapshot.output), next: entry.snapshot.output.end }
  }

  async function read(body, _signal, next) {
    const entry = get(body)
    if (!entry || entry.passthrough) return next(body)
    const from = body.from ?? 0
    if (body.from !== undefined && (!Number.isSafeInteger(body.from) || body.from < 0)) throw invalid('Name the terminal to read')
    const readNative = () => !entry.cutover && !entry.output && !entry.monitoring && !entry.flushed
    let native
    if (readNative()) {
      try {
        native = await next(body)
        if (readNative()) {
          if (entry.forwarded && ENDED.has(native.state)) {
            snapshotPending(entry, native)
            native = undefined
          } else snapshot(entry, native)
        } else native = undefined
      } catch (error) {
        if (readNative()) throw error
      }
    }
    if (entry.cutover) await entry.cutover
    const reply = native ?? view(entry, from)
    entry.servedNext = Math.max(entry.servedNext, reply.next)
    return { ...reply, next: entry.servedNext }
  }

  async function resize(body, _signal, next) {
    const entry = get(body)
    if (!entry?.cutover) return next(body)
    const { cols, rows } = body
    if (!Number.isInteger(cols) || cols < 20 || cols > 400 || !Number.isInteger(rows) || rows < 4 || rows > 120) {
      throw invalid('Name the terminal and its size')
    }
    await entry.cutover
    return { ok: true }
  }

  function close(body, _signal, next) {
    const entry = get(body)
    if (!entry || readOnly() !== undefined) return next(body)
    return detach(entry, () => next(body))
  }

  return { open, read, write, resize, close, dispose, sweep }
}
