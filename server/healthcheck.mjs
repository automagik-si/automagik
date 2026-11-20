#!/usr/bin/env node
// A keeper can request JSON; Docker keeps the compact HTTP status output. Neither path
// reads the launch credential or returns filesystem paths, raw configuration or diagnostics.
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProfileState, writeProfileState } from './gate-view.mjs'
import { GATE_VIEW_MOUNT, PORT, gateViewDir, profileDirOf } from './lib.mjs'
import {
  installedPlugins, profileState, readJson, releaseVersion, validBuild,
} from './profile-state.mjs'

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

export async function healthReport({
  root = ROOT, env = process.env, dshHome, viewDir, dshPort = PORT, probe = fenceProbe,
} = {}) {
  const enabled = env.AUTOMAGIK_GATE_ENABLED === '1'
  const build = readJson(join(root, 'versions.json'))
  let state
  if (enabled) {
    state = readProfileState(viewDir ?? GATE_VIEW_MOUNT, build)
  } else {
    const home = dshHome ?? env.DSH_HOME ?? '/data/dsh'
    const profile = profileDirOf(home)
    try { state = profileState({ profile, source: join(root, 'profile'), build, dshHome: home }) }
    catch {
      state = { plugins: installedPlugins(profile), followsImage: false, ownerManaged: false,
        reason: 'invalid-profile-state' }
    }
    if (viewDir) {
      // A failed publication leaves DSH's own health report intact.
      try { writeProfileState(viewDir, state) } catch {}
    }
  }
  const [dshStatus, gateStatus] = await Promise.all([probe(dshPort), enabled ? probe(Number(env.AUTOMAGIK_GATE_PORT || 3082)) : null])
  const fenced = dshStatus === 401 && (!enabled || gateStatus === 401)
  const version = releaseVersion(build?.automagik) ? build.automagik : null
  const revision = typeof build?.revision === 'string' && /^(?:[a-f0-9]{40}|unknown)$/.test(build.revision) ? build.revision : null
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
    healthy: fenced && validBuild(build) && revision !== null && (state.followsImage || state.ownerManaged),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const viewDir = process.env.AUTOMAGIK_GATE_ENABLED === '1'
    ? GATE_VIEW_MOUNT : gateViewDir(process.env.AUTOMAGIK_HOME || '/data')
  const report = await healthReport({ viewDir })
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report)}\n` : `${report.fence.status ?? '000'}\n`)
  process.exitCode = report.healthy ? 0 : 1
}
