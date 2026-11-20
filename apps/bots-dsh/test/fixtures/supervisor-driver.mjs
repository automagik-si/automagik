import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { runSupervisor as currentSupervisor } from '../../src/host/supervisor/main.js'
import { updateContract } from '../../src/host/supervisor/rollback.js'
import { healthReply } from './supervisor-health-wire.mjs'

const options = JSON.parse(process.env.SUPERVISOR_DRIVER)
const tarballs = new Map(options.tarballs)
const fetch = async url => {
  if (tarballs.has(url)) return new Response(Buffer.from(tarballs.get(url), 'base64'))
  if (url === (process.env.SUPERVISOR_EXPECT_REGISTRY ?? 'https://registry.example.invalid/npm/') + '-/ping') return new Response('{}')
  throw new Error('Unexpected fixture request')
}

const { SUPERVISOR_VERDICT_FAILURE: failVerdict, SUPERVISOR_FAKE_TRANSPORT: fakeTransport,
  SUPERVISOR_FAKE_AGE_MS: age, SUPERVISOR_CUT_AFTER: cut, SUPERVISOR_MODE: mode, SUPERVISOR_UNDO_FSYNC_FAILURE: undoFsync,
  SUPERVISOR_FROZEN_MAIN: frozen, SUPERVISOR_ROLLBACK_VERDICT_PAUSE: pause, SUPERVISOR_PAUSE_TRIAL_HEALTH: pauseTrial } = process.env
const read = path => JSON.parse(fs.readFileSync(path))
let healthProbe
if (failVerdict || fakeTransport) {
  healthProbe = async (url, { cookie, payload, signal } = {}) => {
    if (url.origin !== 'http://127.0.0.1:3080') throw new Error('Unexpected health endpoint')
    const pid = Number(fs.readFileSync(join(process.env.SUPERVISOR_FIXTURE, 'dsh-child-pid'), 'utf8'))
    process.kill(pid, 0)
    const profile = join(options.home, 'profiles', options.profile)
    const plugins = Object.keys(read(join(profile, 'package.json')).dependencies).filter(name => name.startsWith('@automagik/'))
      .map(name => ({ name, loaded: true, version: read(join(profile, 'node_modules', name, 'package.json')).version }))
    const state = read(join(options.home, 'update', options.profile, 'state.json'))
    const version = plugins.find(plugin => plugin.name === '@automagik/bots-dsh').version
    const candidate = version === '3.160.3'
    if (candidate && pauseTrial) await wait(10_000, undefined, { signal })
    const fault = candidate && mode.startsWith('trial-') ? mode.slice('trial-'.length) : null
    if (fault === 'port' || (mode === 'rollback-unhealthy' && state.phase === 'rollingBack')) {
      throw new Error('Fixture listener unavailable')
    }
    const teamPath = join(process.env.AUTOMAGIK_BOTS_HOME, 'state.json')
    const present = fault !== 'team-missing' && fs.existsSync(teamPath)
    const team = fs.existsSync(teamPath) ? read(teamPath) : null
    const bots = team?.note ? 1 : Object.keys(team?.bots ?? {}).length
    if (mode === 'trial-team-missing' && !candidate && state.phase === 'rollingBack' && bots !== 1) {
      throw new Error('The previous roster was not restored')
    }
    const legacy = !updateContract(profile)
    const reply = healthReply({
      url, headers: { cookie }, payload, plugins, run: state.runId, present, bots, legacy,
      fault: mode === 'unchanged-page-fails' || ['new-format', 'dsh-edit', 'dependency-edit', 'compatibility-edit'].includes(fault)
        ? 'page' : fault,
    })
    if (process.env.SUPERVISOR_RECORD_HEALTH) {
      fs.appendFileSync(join(process.env.SUPERVISOR_FIXTURE, 'events.jsonl'), JSON.stringify({
        event: 'health-probe', candidate, endpoint: payload?.endpoint, status: reply.status,
        page: url.pathname === '/' && !url.search, health: payload?.payload?.health,
      }) + '\n')
    }
    return reply
  }
}

if (failVerdict || age || cut || pause || undoFsync) {
  const rename = fs.renameSync
  const now = Date.now
  const statePath = join(options.home, 'update', options.profile, 'state.json')
  let failNextSync = false
  let injected = false
  let checkingSaved = false
  if (undoFsync || cut === 'checking') {
    const sync = fs.fsyncSync
    fs.fsyncSync = fd => {
      if (failNextSync && fs.fstatSync(fd).isDirectory()) {
        failNextSync = false
        injected = true
        throw Object.assign(new Error('fixture reverse-rename fsync failed'), { code: 'EIO' })
      }
      sync(fd)
      if (checkingSaved && fs.fstatSync(fd).isDirectory()) process.kill(-process.pid, 'SIGKILL')
    }
  }
  fs.renameSync = (source, destination) => {
    if (basename(destination) === 'state.json' && dirname(destination) === join(options.home, 'update', options.profile)) {
      const state = read(source)
      if (state.phase === failVerdict) {
        fs.writeFileSync(join(dirname(destination), 'request.json'), JSON.stringify({
          version: 1, bootId: state.bootId, requestId: 'during-verdict-failure', requestedAt: new Date().toISOString(),
        }))
        throw Object.assign(new Error('fixture verdict write failed'), { code: 'EIO' })
      }
      if (age && state.phase === 'checking') Date.now = () => now() + Number(age)
      if (cut === 'checking' && state.phase === 'checking') {
        rename(source, destination)
        checkingSaved = true
        return
      }
      if (cut && state.phase === 'rollingBack') {
        const { step } = state.rollback
        if (step !== cut && !(cut === 'spawn' && step === 'health')) return rename(source, destination)
        if (cut !== 'spawn') rename(source, destination)
        // The driver is a detached test process group, with only its fixture child inside.
        process.kill(-process.pid, 'SIGKILL')
      }
      if (pause && state.phase === 'rolledBack') {
        rename(source, destination)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(pause))
        return
      }
    }
    rename(source, destination)
    if (undoFsync && !injected && /stage-[^/]+\/profiles\/web\/(?:node_modules|pnpm-lock\.yaml)$/.test(destination)
      && read(statePath).phase === 'rollingBack') failNextSync = true
  }
}

if (frozen) {
  globalThis.fetch = async url => {
    if (url !== 'http://127.0.0.1:3080/') throw new Error('Unexpected 5b health endpoint')
    return new Response('fixture only')
  }
}
const runSupervisor = frozen ? (await import(pathToFileURL(frozen))).runSupervisor : currentSupervisor
process.exitCode = await runSupervisor({ ...options, fetch, healthProbe, healthTimeout: fakeTransport && !pauseTrial ? 500 : 3500 })
