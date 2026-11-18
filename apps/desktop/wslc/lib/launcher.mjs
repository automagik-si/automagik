// dsh-launch, the guest launcher (RFC 0016, "Electron to DSH"): Electron, through the WSLC
// helper, runs /opt/automagik/bin/dsh-launch in the container with piped stdio. The launcher
// starts DSH exactly as the desktop does (src/dsh.js startDsh: the same profile install, tools,
// environment and arguments, stdio ['ignore', 'pipe', 'pipe', 'ipc']), on the image's own Node,
// and speaks for it over its stdin and stdout in frames (lib/frame.mjs; the contract is
// wslc/README.md). Nothing but frames is ever written to its stdout. DSH's output goes to
// logs/dsh.log in the volume and to the launcher's stderr.
//
// A start: seeds, the profile, the lane's handoff (lib/lane.mjs) and its `lane` frame, the
// tools, the `open` socket, DSH, then `ready`. Then, until stdin closes: DSH's IPC messages go
// out as `ipc` frames and Electron's come in to DSH, a browser endpoint's URL is moved onto the
// CDP tunnel (lib/tunnel.mjs), and links out go to Electron as `open` frames (lib/open.mjs).
// Stdin's end is the stop (RFC 0016, "Parent death"): DSH gets SIGTERM, SIGKILL if it is still
// there 3 s later, and the launcher is gone within 5 s of the end whatever happens.
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ANONYMOUS_ID, appHome, automagikHome, dshEnv, installProfile, pinProfileStore, preloadOf, privacyFileOf, privacyPatchOf, resourcesOf, startDsh, stopDsh, storeLayoutOf, writeTools } from '../../src/dsh.js'
import { readChoices, writeOverlay } from '../../src/privacy.js'
import { tarOf } from '../../src/tar.js'
import { FrameReader, FrameWriter, PROTOCOL } from './frame.mjs'
import { judgeTrial, laneStep } from './lane.mjs'
import { callbackPortOf, listenForOpens, openSocketOf } from './open.mjs'
import { plantSeeds } from './seeds.mjs'
import { Tunnels } from './tunnel.mjs'

export const DSH_PORT = 41700
export const KILL_AFTER_MS = 3_000
export const EXIT_AFTER_MS = 4_500
// Exit codes: 0 stopped as asked (stdin's end, a signal); 1 DSH did not start or stopped on its
// own; 2 stdin carried something that is no frame; 3 the profile could not be put in place.
export const EXIT = Object.freeze({ stopped: 0, dsh: 1, protocol: 2, setup: 3 })

/**
 * Where everything is. The defaults are the image's; the variables exist for tests and the CI
 * smoke: AUTOMAGIK_IMAGE (the image's root, /opt/automagik), AUTOMAGIK_EXCHANGE (the exchange
 * folder, /mnt/automagik-exchange), DSH_LAUNCH_BIN (another DSH entry, such as a fake) and
 * DSH_LAUNCH_PORT (another port than 41700). AUTOMAGIK_HOME and HOME are the desktop's own.
 */
export function configOf(env = process.env) {
  const image = env.AUTOMAGIK_IMAGE?.trim() || '/opt/automagik'
  const resources = resourcesOf({ packaged: true, resourcesPath: image })
  const port = env.DSH_LAUNCH_PORT?.trim() ? Number(env.DSH_LAUNCH_PORT) : DSH_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`DSH_LAUNCH_PORT ${JSON.stringify(env.DSH_LAUNCH_PORT)} is not a port`)
  return {
    image,
    bin: env.DSH_LAUNCH_BIN?.trim() || resources.bin,
    pnpm: resources.pnpm,
    profile: resources.profile,
    seeds: join(image, 'seeds'),
    shim: join(image, 'bin', 'xdg-open'),
    exchange: env.AUTOMAGIK_EXCHANGE?.trim() || '/mnt/automagik-exchange',
    root: automagikHome(env),
    home: appHome(env),
    userHome: env.HOME?.trim() || homedir(),
    port,
  }
}

/** DSH's environment: the desktop's (dsh.js dshEnv), with the image's bin first on PATH. */
export function launchEnv({ env, config, binDir, privacy, openSocket }) {
  const base = { ...env, BROWSER: config.shim, ...(openSocket ? { AUTOMAGIK_OPEN_SOCKET: openSocket } : {}) }
  delete base.DSH_LAUNCH_BIN
  delete base.DSH_LAUNCH_PORT
  const own = join(config.image, 'bin')
  base.PATH = [own, ...String(base.PATH ?? '').split(':').filter(dir => dir !== '' && dir !== own)].join(':')
  return dshEnv({ base, home: config.home, binDir, userHome: config.userHome, preload: preloadOf({ home: config.root, env }), privacy, platform: 'linux' })
}

export async function main({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, exit = code => process.exit(code) } = {}) {
  const writer = new FrameWriter(stdout)
  let fileLog = null
  let child = null
  let tunnels = null
  let openServer = null
  let openSocket = null
  let settingUp = true
  let stopping = false
  let stopCode = EXIT.stopped
  let finished = false

  const send = (frame) => {
    try { return writer.send(frame) } catch (error) {
      stderr.write(`[dsh-launch] error: a ${frame.type} frame was not sent: ${error.message}\n`)
      return true
    }
  }
  const say = (level, text) => {
    const line = `[dsh-launch] ${level}: ${text}\n`
    stderr.write(line)
    fileLog?.write(line)
    send({ type: 'log', level, text })
  }
  // DSH's output: the volume's log and the launcher's stderr, never its stdout.
  const tee = { write: (chunk) => { stderr.write(chunk); fileLog?.write(chunk) } }

  const finish = (code) => {
    if (finished) return
    finished = true
    void tunnels?.close()
    openServer?.close()
    if (openSocket) try { rmSync(openSocket, { force: true }) } catch {}
    fileLog?.end()
    // What is still in stdout's buffer goes before the process does.
    const fallback = setTimeout(() => exit(code), 300)
    stdout.write('', () => { clearTimeout(fallback); exit(code) })
  }

  const stop = (reason, code = EXIT.stopped) => {
    if (stopping) return
    stopping = true
    stopCode = code
    say(code === EXIT.stopped ? 'info' : 'error', `stopping: ${reason}`)
    setTimeout(() => finish(stopCode), EXIT_AFTER_MS)
    void tunnels?.close()
    if (child) void stopDsh(child, KILL_AFTER_MS).then(() => finish(stopCode))
    else if (!settingUp) finish(stopCode)
  }

  let config
  try {
    config = configOf(env)
  } catch (error) {
    say('error', error.message)
    return finish(EXIT.setup)
  }
  tunnels = new Tunnels({ writer, log: say })

  // Electron's frames. IPC messages go to DSH in the order they came, each once its browser
  // endpoint (if it is one) is on the tunnel.
  let ipcChain = Promise.resolve()
  const relayIn = async (message) => {
    if (message?.type === 'ds-bot:browser-endpoint-response' && typeof message.url === 'string') {
      try {
        message = { ...message, url: await tunnels.endpoint(message.url) }
      } catch (error) {
        say('error', `the browser endpoint has no tunnel: ${error.message}`)
        message = { type: message.type, id: message.id, error: 'The app browser relay is unavailable.' }
      }
    }
    if (child?.connected) child.send(message, (error) => { if (error) say('warn', `an ipc message did not reach DSH: ${error.message}`) })
    else say('warn', 'an ipc message came while DSH is not running; dropped')
  }
  const onFrame = (frame) => {
    if (frame.type === 'ipc') {
      if (!Object.hasOwn(frame, 'message')) return say('warn', 'an ipc frame with no message; ignored')
      ipcChain = ipcChain.then(() => relayIn(frame.message)).catch(error => say('error', `ipc: ${error.message}`))
    } else if (frame.type === 'tunnel') {
      tunnels.receive(frame)
    } else if (frame.type === 'lane') {
      if (frame.trial !== 'passed' && frame.trial !== 'failed') return say('warn', `a lane frame with trial ${JSON.stringify(frame.trial)}; ignored`)
      let recorded = false
      try { recorded = judgeTrial(config.home, frame.trial) } catch (error) { say('error', `lane: ${error.message}`) }
      send({ type: 'lane', trial: frame.trial, recorded })
    } else {
      say('warn', `a ${JSON.stringify(frame.type)} frame is not known to protocol ${PROTOCOL}; ignored`)
    }
  }
  const reader = new FrameReader(onFrame, error => stop(`stdin: ${error.message}`, EXIT.protocol))
  stdin.on('data', chunk => reader.push(chunk))
  stdin.on('end', () => {
    reader.end()
    stop('stdin closed')
  })
  stdin.on('close', () => stop('stdin closed'))
  stdin.on('error', error => stop(`stdin: ${error.message}`))
  stdout.on('error', error => stop(`stdout: ${error.message}`))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal))

  const home = config.home
  try {
    mkdirSync(join(home, 'logs'), { recursive: true })
    fileLog = createWriteStream(join(home, 'logs', 'dsh.log'), { flags: 'a' })
    fileLog.on('error', () => { fileLog = null })
    say('info', `${new Date().toISOString()} dsh-launch, protocol ${PROTOCOL}, DSH on 127.0.0.1:${config.port}`)
    plantSeeds({ from: config.seeds, home: config.userHome, log: say }).forEach(path => say('info', `seed copied: ${path}`))
  } catch (error) {
    say('error', `the volume cannot be written: ${error.message}`)
    settingUp = false
    return finish(EXIT.setup)
  }

  let target
  try {
    ({ target } = await installProfile({ dshHome: join(home, 'dsh'), source: config.profile }))
    pinProfileStore({ target, home, layout: storeLayoutOf(config.pnpm) })
  } catch (error) {
    say('error', `the profile could not be put in place: ${error.message}`)
    settingUp = false
    return finish(stopping ? stopCode : EXIT.setup)
  }
  if (stopping) { settingUp = false; return finish(stopCode) }

  // Before DSH: the plugins Electron handed over go in, and this start is their trial.
  const lane = await laneStep({ exchange: config.exchange, home, target, tar: tarOf({ platform: process.platform }), log: say })
  send({ type: 'lane', ...lane })
  if (stopping) { settingUp = false; return finish(stopCode) }

  let dshEnvironment
  let overlay
  try {
    const binDir = writeTools({ dir: join(home, 'bin'), node: process.execPath, pnpm: config.pnpm, platform: 'linux' })
    const privacy = readChoices(privacyFileOf(home))
    // A new anonymous id every launch, unless the person chose to keep one (as main.js does).
    if (privacy['stable-id'] !== true) rmSync(join(home, 'dsh', ANONYMOUS_ID), { force: true })
    overlay = writeOverlay(privacyPatchOf(home), privacy)
    try {
      openSocket = openSocketOf(home, env)
      openServer = await listenForOpens(openSocket, {
        onOpen: (url) => {
          if (stopping) throw new Error('the launcher is stopping')
          const callbackPort = callbackPortOf(url)
          send({ type: 'open', url, ...(callbackPort ? { callbackPort } : {}) })
        },
      })
    } catch (error) {
      say('warn', `links out are off: ${error.message}`)
      openSocket = null
    }
    dshEnvironment = launchEnv({ env, config, binDir, privacy, openSocket })
  } catch (error) {
    say('error', `DSH's tools could not be written: ${error.message}`)
    settingUp = false
    return finish(EXIT.setup)
  }
  if (stopping) { settingUp = false; return finish(stopCode) }

  let running
  try {
    running = await startDsh({
      node: process.execPath,
      bin: config.bin,
      env: dshEnvironment,
      port: config.port,
      cwd: home,
      log: tee,
      privacy: overlay,
      onSpawn: (spawned) => {
        child = spawned
        spawned.on('message', (message) => {
          try { writer.send({ type: 'ipc', message }) } catch (error) { say('error', `an ipc message from DSH was dropped: ${error.message}`) }
        })
        settingUp = false
        if (stopping) void stopDsh(spawned, KILL_AFTER_MS).then(() => finish(stopCode))
      },
    })
  } catch (error) {
    settingUp = false
    if (stopping) return
    say('error', `DSH did not start: ${error.message}`)
    stopping = true
    return finish(EXIT.dsh)
  }
  if (stopping) return
  send({ type: 'ready', url: running.url, port: config.port })
  running.child.once('exit', (code, signal) => {
    if (stopping) return
    say('error', `DSH stopped on its own (${signal ?? code})`)
    stopping = true
    finish(EXIT.dsh)
  })
}
