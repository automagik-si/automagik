#!/usr/bin/env node
// A keeper can request JSON; Docker keeps the compact HTTP status output. Neither path
// reads the launch credential or returns filesystem paths, raw configuration or diagnostics.
import http from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORT, profileDirOf } from './lib.mjs'
import { TRIAD } from './first-boot.mjs'
import { installedPlugins, profileState, readJson, releaseVersion, validBuild } from './profile-state.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
export function fenceProbe(port) {
  return new Promise(resolve => {
    try {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 4000, headers: { connection: 'close' } }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
        res.on('error', () => resolve(null))
        res.on('aborted', () => resolve(null))
      })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
    } catch { resolve(null) }
  })
}

const reviewedModels = Object.fromEntries(TRIAD.map((role) => [role.name, role.model]))
const modelsOf = (bots) => Object.fromEntries((Array.isArray(bots) ? bots : []).map((bot) => [bot?.name, bot?.model]))
const sameModels = (actual) => Object.keys(reviewedModels).length === Object.keys(actual).length
  && Object.entries(reviewedModels).every(([name, model]) => actual[name] === model)

/** Ready is only real when the receipt and all three current rosters show the reviewed trio. */
function readyRosterEvidence(env, pinState) {
  const home = env.AUTOMAGIK_HOME || '/data'
  const workspace = env.AUTOMAGIK_WORKSPACE || '/data/workspace'
  const read = (file) => { try { return readJson(file) } catch { return null } }
  const v1 = read(join(workspace, '.herdr', 'bots.json'))
  const repo = read(join(workspace, '.automagik', 'bots', 'bots.json'))
  const homeRegistry = read(join(home, 'bots', 'bots.json'))
  const receipt = pinState?.receipt
  if (!receipt || receipt.version !== 1 || typeof receipt.verifiedAt !== 'string') {
    return { ok: false, reason: 'ready state has no verified receipt' }
  }
  const v1Bots = Array.isArray(v1?.bots) ? v1.bots : []
  const repoBots = Array.isArray(repo?.bots) ? repo.bots : []
  const homeBots = Array.isArray(homeRegistry?.bots) ? homeRegistry.bots : []
  const homeMain = homeBots.filter((bot) => bot?.folder === workspace && bot?.main === true)
  if (v1.version !== 1 || v1Bots.length !== TRIAD.length || v1Bots.filter((bot) => bot?.kind === 'main').length !== 1) {
    return { ok: false, reason: 'v1 roster is not the reviewed team' }
  }
  if (!sameModels(modelsOf(v1Bots)) || !sameModels(modelsOf(repoBots)) || homeMain.length !== 1 || homeMain[0].model !== reviewedModels.Purpose) {
    return { ok: false, reason: 'roster models do not match the reviewed trio' }
  }
  const receiptHome = Array.isArray(receipt.home) ? receipt.home : []
  if (!sameModels(Object.fromEntries((receipt.v1 ?? []).map((bot) => [bot?.name, bot?.model])))
    || !sameModels(Object.fromEntries((receipt.repo ?? []).map((bot) => [bot?.name, bot?.model])))
    || receiptHome.length !== 1 || receiptHome[0]?.name !== 'Purpose' || receiptHome[0]?.model !== reviewedModels.Purpose) {
    return { ok: false, reason: 'receipt does not cover the reviewed trio' }
  }
  return { ok: true }
}

export async function healthReport({ root = ROOT, env = process.env, dshHome, dshPort = PORT, probe = fenceProbe } = {}) {
  const enabled = env.AUTOMAGIK_GATE_ENABLED === '1'
  let home = dshHome ?? env.DSH_HOME ?? '/data/dsh'
  if (!dshHome && enabled && !existsSync(profileDirOf(home)) && existsSync(profileDirOf('/dsh/dsh'))) home = '/dsh/dsh'
  const build = readJson(join(root, 'versions.json'))
  const profile = profileDirOf(home)
  let state
  try { state = profileState({ profile, source: join(root, 'profile'), build, dshHome: home }) }
  catch { state = { plugins: installedPlugins(profile), followsImage: false, ownerManaged: false, reason: 'invalid-profile-state' } }
  const [dshStatus, gateStatus] = await Promise.all([probe(dshPort), enabled ? probe(Number(env.AUTOMAGIK_GATE_PORT || 3082)) : null])
  const fenced = dshStatus === 401 && (!enabled || gateStatus === 401)
  const version = releaseVersion(build?.automagik) ? build.automagik : null
  const revision = typeof build?.revision === 'string' && /^(?:[a-f0-9]{40}|unknown)$/.test(build.revision) ? build.revision : null
  const pinState = readJson(join(env.AUTOMAGIK_HOME || '/data', 'bots', 'model-pin-state.json'))
  const pinStates = ['pending', 'ready', 'failed', 'conflict']
  const pins = Array.isArray(pinState?.pins) ? pinState.pins : []
  let modelPins
  if (pinStates.includes(pinState?.state)) {
    const evidence = pinState.state === 'ready' ? readyRosterEvidence(env, pinState) : null
    modelPins = pinState.state === 'ready' && !evidence.ok
      ? { state: 'failed', count: 0, error: evidence.reason }
      : { state: pinState.state, count: pins.length, ...(pins.length ? { pins: pins.map((pin) => ({ id: pin?.id, name: pin?.name, model: pin?.model })) } : {}), ...(pinState.state === 'ready' ? { verifiedAt: pinState.receipt.verifiedAt } : {}), ...(pinState.error ? { error: pinState.error } : {}) }
  } else {
    modelPins = { state: 'unknown', count: 0 }
  }
  return {
    schemaVersion: 1,
    image: { version, revision },
    plugins: state.plugins,
    followsImage: state.followsImage,
    ownerManaged: state.ownerManaged,
    reason: state.reason,
    dsh: { up: dshStatus !== null, status: dshStatus },
    gate: { enabled, up: enabled ? gateStatus !== null : null, status: gateStatus },
    fence: { healthy: fenced, status: enabled ? gateStatus : dshStatus },
    modelPins,
    healthy: fenced && validBuild(build) && revision !== null && (state.followsImage || state.ownerManaged),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await healthReport()
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report)}\n` : `${report.fence.status ?? '000'}\n`)
  process.exitCode = report.healthy ? 0 : 1
}
