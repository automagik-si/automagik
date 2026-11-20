#!/usr/bin/env node
// Exercise a fresh image's authenticated Welcome install and the persistent Omni runtime.
import { execFile } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import { safeDshLine } from './lib.mjs'

const run = promisify(execFile)
const image = process.argv[2] || 'automagik-server:local'
const container = `automagik-omni-smoke-${process.pid}`
const volume = `${container}-data`
const welcome = 'node_modules/@automagik/welcome-dsh'
const workDeadline = Date.now() + 38 * 60_000
const check = (value, message) => { if (!value) throw new Error(message) }

async function docker(args, { timeout = 30_000, deadline = workDeadline } = {}) {
  const left = deadline - Date.now()
  check(left > 0, 'Smoke time budget expired')
  try {
    return await run('docker', args, {
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: Math.min(timeout, left),
    })
  } catch (error) {
    throw new Error(`docker ${args[0]} failed (${error.code ?? error.signal ?? 'unknown'})`)
  }
}

async function inContainer(fn, args, options) {
  const source = `
    const args = JSON.parse(process.argv[1]);
    try {
      console.log(JSON.stringify({ value: await (${fn})(...args) }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  `
  const { stdout } = await docker(['exec', container, '/nodejs/bin/node', '--input-type=module',
    '-e', source, JSON.stringify(args)], options)
  let result
  try { result = JSON.parse(stdout) } catch { throw new Error('Container smoke probe did not return JSON') }
  check(!Object.hasOwn(result, 'error'), result.error)
  return result.value
}

async function welcomeHasInstaller(path) {
  const { existsSync } = await import('node:fs')
  return existsSync(`/opt/automagik/profile/${path}/src/host/omni-github.js`)
}

async function waitForDsh() {
  const deadline = Date.now() + 4 * 60_000
  while (Date.now() < deadline) {
    const { stdout } = await docker(['inspect', container, '--format', '{{.State.Status}} {{.State.Health.Status}}'], { deadline })
    const [state, health] = stdout.trim().split(' ')
    check(state === 'running', 'Workspace stopped before DSH was healthy')
    if (health === 'healthy') return
    await pause(1000)
  }
  throw new Error('DSH did not become healthy')
}

async function installOmni(path, deadline) {
  const { readFileSync } = await import('node:fs')
  const { setTimeout: sleep } = await import('node:timers/promises')
  const { isDeepStrictEqual } = await import('node:util')
  const { profileDirOf } = await import('/opt/automagik/lib.mjs')
  const dshHome = process.env.DSH_HOME || '/data/dsh'
  const pkg = JSON.parse(readFileSync(`${profileDirOf(dshHome)}/${path}/package.json`, 'utf8'))
  const pin = pkg.automagik.omni
  const versionPattern = /^\d+\.\d{6}\.\d+$/
  if (!versionPattern.test(pin.version)) throw new Error('Invalid Welcome Omni pin')

  const route = '/api/omni-ai'
  const launch = new URL(readFileSync(`${dshHome}/launch-url`, 'utf8').trim())
  const api = new URL(route, launch)
  const callOptions = {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
  }
  const body = (endpoint, payload) => JSON.stringify({ endpoint, payload })
  const unauthenticated = await fetch(api, {
    ...callOptions, body: body('omni-github-status', {}), signal: AbortSignal.timeout(5000),
  })
  if (unauthenticated.status !== 401) throw new Error('The Omni route did not require authentication')
  await unauthenticated.body?.cancel()
  const auth = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  await auth.body?.cancel()
  if (!cookie) throw new Error('DSH did not issue a session cookie')
  async function call(endpoint, payload) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Omni install exceeded its time budget')
    const response = await fetch(api, {
      ...callOptions, headers: { ...callOptions.headers, cookie }, body: body(endpoint, payload),
      signal: AbortSignal.timeout(Math.min(remaining, 30_000)),
    })
    if (!response.ok) throw new Error(`Welcome endpoint ${endpoint} returned HTTP ${response.status}`)
    const result = await response.json()
    if (!result.ok) throw new Error(`Welcome endpoint ${endpoint} refused the smoke request`)
    return result.value
  }

  const tags = await fetch('https://registry.npmjs.org/-/package/@automagik%2fomni/dist-tags', {
    signal: AbortSignal.timeout(10_000),
  })
  if (!tags.ok) throw new Error('Could not resolve the published Omni version')
  const { latest } = await tags.json()
  if (!versionPattern.test(latest)) throw new Error('Invalid Omni npm dist-tag')
  const pinParts = pin.version.split('.').map(Number)
  const behind = value => (value.split('.').map((part, i) => Number(part) - pinParts[i]).find(Boolean) ?? 0) < 0
  // Keep testing a published version behind the pin when npm's latest catches up.
  const version = behind(latest) ? latest : '2.261109.2'
  if (!behind(version)) throw new Error('The smoke needs a published Omni version below the pin')
  const published = await fetch(`https://registry.npmjs.org/@automagik%2fomni/${version}`, {
    signal: AbortSignal.timeout(10_000),
  })
  await published.body?.cancel()
  if (!published.ok) throw new Error('The npm version behind the pin is not published')
  const server = await call('omni-server-check', { version, fallback: true })
  if (server.ok !== false || !['behind', 'no-systemd'].includes(server.reason) ||
      server.fallback?.version !== pin.version || server.fallback.commit !== pin.commit) {
    throw new Error('Welcome did not offer GitHub for the published Omni version behind its pin')
  }
  let { job } = await call('omni-github-install', { version, reason: server.reason })
  if (!job?.id) throw new Error('Welcome did not start an Omni job')
  const { id } = job
  while (job.phase === 'running') {
    await sleep(1000)
    job = (await call('omni-github-status', { id })).job
    if (job?.id !== id) throw new Error('Welcome lost the Omni job')
  }
  if (job.phase !== 'done' || job.source !== 'github' || job.npm?.version !== version ||
      job.release?.version !== pin.version || job.report?.version !== pin.version) {
    throw new Error('Omni job did not finish installing the pinned GitHub release')
  }
  const status = await call('omni-github-status', { id })
  const plugins = await call('omni-plugins', null)
  if (!isDeepStrictEqual(status.job, job) || !isDeepStrictEqual(plugins.server, status.job)) {
    throw new Error('Welcome endpoints disagree on the finished Omni job')
  }
  return { version: pin.version, npm: latest, requested: version }
}

async function waitForOmni(version, deadline) {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { setTimeout: sleep } = await import('node:timers/promises')
  const { omniRoot } = await import('/opt/automagik/lib.mjs')
  const config = JSON.parse(readFileSync(join(omniRoot(), 'sandbox', 'sandbox.json'), 'utf8'))
  const port = config.ports?.api
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid sandbox API port')
  while (Date.now() < deadline) {
    const health = await (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v2/health`, {
          redirect: 'error', signal: AbortSignal.timeout(Math.min(3000, Math.max(1, deadline - Date.now()))),
        })
        if (response.status === 200) return await response.json()
        await response.body?.cancel()
      } catch { /* The sandbox can still be starting. */ }
    })()
    if (health) {
      if (health.version !== version) throw new Error('Omni health reported the wrong version')
      return true
    }
    await sleep(1000)
  }
  throw new Error('Omni health did not return HTTP 200')
}

async function smoke() {
  await docker(['volume', 'create', volume])
  await docker(['run', '--detach', '--name', container, '--volume', `${volume}:/data`,
    '--env', 'AUTOMAGIK_CLI_INSTALL=off', '--env', 'AUTOMAGIK_MULTIUSER=0',
    '--health-interval', '2s', '--health-start-period', '0s', image])
  if (!(await inContainer(welcomeHasInstaller, [welcome]))) {
    check(process.env.GITHUB_EVENT_NAME !== 'pull_request', 'The candidate Welcome lacks the Omni installer')
    console.log('::notice::This image’s Welcome predates the Omni installer. Skipping the Omni smoke.')
    return
  }
  await waitForDsh()
  const installDeadline = Math.min(workDeadline, Date.now() + 26 * 60_000)
  const installed = await inContainer(installOmni, [welcome, installDeadline], {
    deadline: installDeadline + 1000, timeout: 26 * 60_000 + 1000,
  })
  const checkHealth = async (deadline) => {
    await inContainer(waitForOmni, [installed.version, Math.min(deadline, workDeadline) - 1000], {
      deadline: Math.min(deadline, workDeadline), timeout: 5 * 60_000,
    })
  }
  await checkHealth(Date.now() + 5 * 60_000)
  const restartDeadline = Math.min(workDeadline, Date.now() + 5 * 60_000)
  await docker(['restart', '-t', '90', container], { deadline: restartDeadline, timeout: 105_000 })
  await checkHealth(restartDeadline)
  console.log(`OMNI SMOKE OK github=${installed.version} npm-latest=${installed.npm} requested=${installed.requested} health=200 restart=200`)
}

try {
  await smoke()
} catch (error) {
  process.exitCode = 1
  console.error(`OMNI SMOKE FAILED: ${safeDshLine(error.message)}`)
  const logs = await docker(['logs', '--tail', '150', container], { timeout: 15_000, deadline: Date.now() + 15_000 })
    .catch(() => null)
  if (logs) {
    for (const output of [logs.stdout, logs.stderr]) {
      for (const line of output.trimEnd().split('\n')) if (line) console.error(safeDshLine(line))
    }
  }
} finally {
  const deadline = Date.now() + 90_000
  await docker(['rm', '--force', container], { deadline, timeout: 45_000 }).catch(() => {})
  await docker(['volume', 'rm', volume], { deadline, timeout: 45_000 }).catch(() => {})
}
