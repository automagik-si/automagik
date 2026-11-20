#!/usr/bin/env node
// Migrate the pinned three-plugin image with Omni installed, using no network for the update.
import { execFile, execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { ADAPTER, compareRelease, LEGACY_PLUGINS, PLUGINS } from './profile-state.mjs'

const run = promisify(execFile)
const pin = JSON.parse(readFileSync(new URL('./follow-companion.json', import.meta.url)))
const candidate = process.argv[2] || 'automagik-server:local'
const prefix = `automagik-follow-${process.pid}`
const volume = `${prefix}-data`, container = `${prefix}-workspace`, companion = `${prefix}:companion`
const profile = '/data/dsh/profiles/automagik-web'
const override = '\n# Preserve this owner setting.\n- id: web-fetch-http\n  disabled: true\n'
const docker = args => run('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const check = (value, message) => { if (!value) throw new Error(message) }
const pause = () => new Promise(resolve => setTimeout(resolve, 250))
const nodeIn = (script, ...args) => docker(['exec', container, '/nodejs/bin/node', '-e', script, ...args])
const installed = (actual, names, version) => Object.keys(actual).sort().join() === names.join() &&
  names.every(name => actual[name] === version)

async function imageVersions(image) {
  const result = await docker(['run', '--rm', '--network', 'none', '--entrypoint', '/nodejs/bin/node', image,
    '-e', 'process.stdout.write(require("node:fs").readFileSync("/opt/automagik/versions.json"))'])
  return JSON.parse(result.stdout)
}

async function buildCompanion(scratch) {
  const git = args => run('git', args, { cwd: scratch })
  await git(['init', '--quiet'])
  await git(['fetch', '--depth', '1', 'https://github.com/automagik-si/automagik', pin.revision])
  check((await git(['rev-parse', 'FETCH_HEAD'])).stdout.trim() === pin.revision, 'companion checkout revision')
  const tree = join(scratch, 'tree'), archive = join(scratch, 'tree.tar')
  mkdirSync(tree)
  const fd = openSync(archive, 'wx')
  try { execFileSync('git', ['archive', 'FETCH_HEAD'], { cwd: scratch, stdio: ['ignore', fd, 'pipe'] }) }
  finally { closeSync(fd) }
  await run('tar', ['-xf', archive, '-C', tree])
  await run('bun', ['install', '--cwd', 'server', '--frozen-lockfile', '--ignore-scripts', '--linker', 'hoisted'], { cwd: tree })
  await run(process.execPath, ['server/build.mjs', '--tag', companion, '--version', pin.version,
    '--image-version', pin.version, '--revision', pin.revision], { cwd: tree, maxBuffer: 32 * 1024 * 1024 })
  const versions = await imageVersions(companion)
  const label = await docker(['image', 'inspect', companion, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'])
  check(versions.automagik === pin.version && versions.revision === pin.revision && label.stdout.trim() === pin.revision &&
    installed(versions.plugins, pin.plugins, pin.version), 'companion image identity')
}

async function start(image, { online = false, reason = 'matching-image' } = {}) {
  await docker(['run', '--detach', ...(online ? [] : ['--network', 'none']),
    '--env', 'AUTOMAGIK_CLI_INSTALL=off', '--env', 'AUTOMAGIK_MULTIUSER=0',
    '--name', container, '--volume', `${volume}:/data`,
    '--health-interval', '2s', '--health-start-period', '0s', image])
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    check((await docker(['inspect', container, '--format', '{{.State.Status}}'])).stdout.trim() === 'running', 'update workspace stopped')
    let output, report
    try { output = await docker(['exec', container, '/nodejs/bin/node', '/opt/automagik/healthcheck.mjs', '--json']) }
    catch (error) { output = error }
    try { report = JSON.parse(output.stdout) } catch {}
    if (report?.reason === reason && report.dsh.status === 401 && report.healthy === (reason === 'matching-image')) return report
    if (report && report.reason !== reason && ['update-rolled-back', 'newer-than-image'].includes(report.reason)) {
      throw new Error(`update did not converge: ${report.reason}`)
    }
    await pause()
  }
  throw new Error(`update report did not reach ${reason}`)
}

async function stop() { await docker(['rm', '--force', container]).catch(() => {}) }

async function welcomePlugins(install = false) {
  const result = await docker(['exec', container, '/nodejs/bin/node', '--input-type=module', '-e', `
    import fs from 'node:fs';
    const launch = fs.readFileSync('/data/dsh/launch-url', 'utf8').trim();
    const auth = await fetch(launch, { redirect: 'manual' });
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    async function call(endpoint) {
      const response = await fetch(new URL('/api/omni-ai', launch), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload: null }) });
      const result = await response.json();
      if (!result.ok) throw new Error('Welcome endpoint failed: ' + endpoint);
      return result.value;
    }
    if (${install}) await call('omni-plugins-install');
    const deadline = Date.now() + 180000;
    for (;;) {
      const result = await call('omni-plugins');
      if (result.ready) { console.log(JSON.stringify(result.plugins.map(({ name, version, installed, enabled }) => ({ name, version, installed, enabled })))); break; }
      if (result.install?.phase === 'failed' || Date.now() > deadline) throw new Error('Welcome plugin installation failed');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  `])
  return JSON.parse(result.stdout)
}
let scratch
try {
  check(pin.plugins.join() === LEGACY_PLUGINS.join(), 'companion plugin set')
  const { automagik: newVersion, plugins } = await imageVersions(candidate)
  check(compareRelease(newVersion, pin.version) > 0 && installed(plugins, PLUGINS, newVersion),
    'candidate must be newer than the three-plugin companion')
  scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'automagik-follow-'))
  await buildCompanion(scratch)
  await docker(['volume', 'create', volume])
  const initial = await start(companion, { online: true })
  check(initial.followsImage && installed(initial.plugins, LEGACY_PLUGINS, pin.version), 'old image did not seed its actual release')
  const added = (await welcomePlugins(true)).filter(row => !PLUGINS.includes(row.name))
  check(added.length === 2 && added.every(row => row.installed && row.enabled), 'welcome did not install Omni')
  const oldDigests = (await nodeIn(`
    const fs = require('node:fs'), [profile, override] = process.argv.slice(1)
    const { createHash } = require('node:crypto')
    fs.writeFileSync(profile + '/follow-smoke-owner-setting', 'preserve')
    const file = profile + '/cordis.patch.yml'
    fs.appendFileSync(file, override)
    fs.copyFileSync(file, profile + '/follow-smoke-owner-patch')
    const digests = ['package.json', 'pnpm-lock.yaml'].map(name => {
      const bytes = fs.readFileSync(profile + '/' + name)
      if (!bytes.length) throw new Error('old profile input is empty: ' + name)
      return createHash('sha256').update(bytes).digest('hex')
    })
    console.log(JSON.stringify(digests))
  `, profile, override)).stdout.trim()
  await stop()

  const upgraded = await start(candidate)
  check(upgraded.followsImage && installed(upgraded.plugins, PLUGINS, newVersion), 'plugins did not follow the new image')
  check(JSON.stringify((await welcomePlugins()).filter(row => !PLUGINS.includes(row.name))) === JSON.stringify(added), 'Omni changed during image upgrade')
  await nodeIn(`
    const assert = require('node:assert/strict'), fs = require('node:fs')
    const { createHash } = require('node:crypto')
    const [profile, override, adapter, digests] = process.argv.slice(1)
    const expected = JSON.parse(digests)
    const read = (dir, file) => fs.readFileSync(dir + '/' + file, 'utf8')
    assert.equal(read(profile, 'follow-smoke-owner-setting'), 'preserve')
    const oldPatch = read(profile, 'follow-smoke-owner-patch')
    const patch = read(profile, 'cordis.patch.yml')
    assert.ok(oldPatch.endsWith(override))
    assert.ok(patch.includes(oldPatch) && patch.includes(adapter))
    const backups = '/data/dsh/backups'
    const dirs = fs.readdirSync(backups).map(dir => backups + '/' + dir + '/automagik-web')
    assert.ok(dirs.some(dir => ['package.json', 'pnpm-lock.yaml'].every((name, i) => {
      const bytes = fs.readFileSync(dir + '/' + name)
      return bytes.length > 0 && createHash('sha256').update(bytes).digest('hex') === expected[i]
    }) && !Object.hasOwn(JSON.parse(read(dir, 'package.json')).dependencies, adapter) &&
      !read(dir, 'pnpm-lock.yaml').includes(adapter) && read(dir, 'cordis.patch.yml') === oldPatch))
  `, profile, override, ADAPTER, oldDigests)
  const config = parse((await docker(['exec', container, 'dsh', '--profile', 'automagik-web', '--dump-config'])).stdout, { logLevel: 'error' })
  const adapter = config.filter(row => row.id === 'multiuser-dsh' && row.name === ADAPTER)
  check(adapter.length === 1 && (adapter[0].disabled === undefined || adapter[0].disabled === false), 'adapter did not compose enabled')
  const logs = await docker(['logs', container])
  check(`${logs.stdout}${logs.stderr}`.includes('image follow: updated; matching-image'), 'startup did not report the real update')
  await stop()

  const restarted = await start(candidate)
  check(restarted.followsImage && installed(restarted.plugins, PLUGINS, newVersion), 'updated profile did not survive restart')
  check(JSON.stringify((await welcomePlugins()).filter(row => !PLUGINS.includes(row.name))) === JSON.stringify(added), 'Omni did not survive restart')
  await stop()

  const older = await start(companion, { reason: 'newer-than-image' })
  check(!older.followsImage && LEGACY_PLUGINS.every(name => older.plugins[name] === newVersion), 'old image downgraded installed plugins')
  await nodeIn(`
    fetch('http://127.0.0.1:3081/_automagik/caller/api/x', { signal: AbortSignal.timeout(5000) }).then(async response => {
      if (response.status !== 401 || (await response.arrayBuffer()).byteLength !== 0) throw new Error('rollback-caller-route')
    })
  `)
  console.log(`FOLLOW SMOKE OK old=${pin.version} new=${newVersion} plugins=4 omni=${JSON.stringify(added)} upgrade_network=none backup=yes restart=yes newer-than-image=yes`)
} catch (error) {
  console.error(`FOLLOW SMOKE FAILED: ${error.message}`)
  process.exitCode = 1
} finally {
  await stop()
  await docker(['volume', 'rm', '--force', volume]).catch(() => {})
  await docker(['image', 'rm', companion]).catch(() => {})
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}
