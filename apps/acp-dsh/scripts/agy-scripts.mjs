#!/usr/bin/env node
// The daily check that Google's official Antigravity install scripts still name the manifest
// host acp-dsh pins (src/host/agy-source.js, #2048), and that nothing in them or in the
// manifests changed since a person last read them (test/fixtures/agy-install.json). The scripts
// are read as text and never run; no Google script text is committed, only its byte count,
// sha256 and the base and manifest lines. Run by .github/workflows/acp-drift.yml
// (`agy-scripts`); the unit tests (test/agy-scripts.test.js) run it offline with a fake fetch.
//
//   node scripts/agy-scripts.mjs [--json]   check; the report is JSON on stdout
//   node scripts/agy-scripts.mjs --write    a person, with network: refresh the fixture and its
//                                           SHA256SUMS from the scripts as they are now; when a
//                                           base, platform or manifest line moved, re-read the
//                                           scripts' text before committing
//
// Exit codes, in this order:
//   2  a script could not be fetched (network, TLS or not 200 under AGY_SCRIPTS_BASE): no verdict
//   1  moved: a script's base is not AGY_MANIFEST_BASE (whatever the manifests say), or a
//      manifest at the pinned base answered 404/410 or failed agy-source.js's rule
//   2  a manifest could not be read (network, TLS, any other status): no verdict
//   3  changed: a script's bytes, sha256, base or manifest line, or a manifest's key set, is not
//      the fixture's; the report also says `changed: true` beside a code 1
//   0  as the fixture says
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGY_MANIFEST_BASE, AGY_PLATFORMS, AGY_SCRIPTS, AGY_SCRIPTS_BASE, parseAgyManifest } from '../src/host/agy-source.js'

export const FIXTURE = join(import.meta.dirname, '..', 'test', 'fixtures', 'agy-install.json')
export const SUMS = join(import.meta.dirname, '..', 'test', 'fixtures', 'agy-install.SHA256SUMS')
const MANIFEST_KEYS = ['sha512', 'url', 'version']
const TIMEOUT_MS = 30_000
const SCRIPT_MAX_BYTES = 256 * 1024

// The line in each script that sets the manifest host, and the one that builds the manifest's
// address from it. Each must match exactly one line.
const BASE_LINES = {
  'install.sh': /^DOWNLOAD_BASE_URL="([^"]+)"$/,
  'install.ps1': /^\s*\$DOWNLOAD_BASE_URL = "([^"]+)"$/,
  'install.cmd': /^set "DOWNLOAD_BASE_URL=([^"]+)"$/,
}
export const MANIFEST_LINES = {
  'install.sh': /^MANIFEST_URL=.*\/manifests\/.*\.json/,
  'install.ps1': /^\s*\$\w*manifest\w*\s*=.*\/manifests\/.*\.json/i,
  'install.cmd': /^\s*set\s+"?\w*manifest\w*=.*\/manifests\/.*\.json/i,
}

const linesOf = text => String(text).split(/\r?\n/)
const only = (pattern, text) => {
  const found = linesOf(text).filter(line => pattern.test(line))
  return found.length === 1 ? found[0] : undefined
}

/** The manifest host a script names (its one base line), or undefined. Works on one line too. */
export function scriptBase(name, text) {
  const pattern = BASE_LINES[name]
  if (pattern === undefined) return undefined
  const line = only(pattern, text)
  return line === undefined ? undefined : pattern.exec(line)[1]
}

/** The script's own lines the fixture records, trimmed: its base line and its manifest line. */
export function scriptLines(name, text) {
  const base = BASE_LINES[name] === undefined ? undefined : only(BASE_LINES[name], text)
  const manifest = MANIFEST_LINES[name] === undefined ? undefined : only(MANIFEST_LINES[name], text)
  return { baseLine: base?.trim(), manifestLine: manifest?.trim() }
}

const short = value => (typeof value === 'string' ? value.slice(0, 300) : value)

async function get(fetch, url, max) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (response.status !== 200) {
    await response.body?.cancel?.().catch(() => {})
    return { status: response.status }
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > max) return { status: response.status, tooLarge: true }
  return { status: 200, bytes }
}

/**
 * Reads the scripts first, then (only when they still name the pinned host) the manifests,
 * and answers { code, report }. `fixture` is the recorded state; `fetch` is the network.
 */
export async function check({ fetch = globalThis.fetch, fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) } = {}) {
  const report = { checked: new Date().toISOString(), pinned: AGY_MANIFEST_BASE, moved: false, changed: false, scripts: {}, manifests: {} }
  const done = code => ({ code, report: { ...report, code } })
  for (const name of AGY_SCRIPTS) {
    let read
    try { read = await get(fetch, `${AGY_SCRIPTS_BASE}${name}`, SCRIPT_MAX_BYTES) } catch (error) {
      report.scripts[name] = { unread: short(String(error?.message ?? error)) }
      return done(2)
    }
    if (read.status !== 200 || read.tooLarge) {
      report.scripts[name] = { unread: read.tooLarge ? 'too large' : `answered ${read.status}` }
      return done(2)
    }
    const text = read.bytes.toString('utf8')
    const sha256 = createHash('sha256').update(read.bytes).digest('hex')
    const base = scriptBase(name, text)
    const { baseLine, manifestLine } = scriptLines(name, text)
    const was = fixture.scripts?.[name] ?? {}
    const differences = [
      ...(read.bytes.length === was.bytes ? [] : ['bytes']),
      ...(sha256 === was.sha256 ? [] : ['sha256']),
      ...(baseLine === was.baseLine ? [] : ['baseLine']),
      ...(manifestLine === was.manifestLine ? [] : ['manifestLine']),
    ]
    report.scripts[name] = { bytes: read.bytes.length, sha256, base: short(base), baseLine: short(baseLine), manifestLine: short(manifestLine), differences }
    if (base !== AGY_MANIFEST_BASE) report.moved = true
    if (differences.length > 0) report.changed = true
  }
  // The scripts moved: that is the verdict, whatever the old host still answers.
  if (report.moved) return done(1)
  let unread = false
  for (const key of AGY_PLATFORMS) {
    let read
    try { read = await get(fetch, `${AGY_MANIFEST_BASE}/manifests/${key}.json`, 16 * 1024) } catch (error) {
      report.manifests[key] = { unread: short(String(error?.message ?? error)) }
      unread = true
      continue
    }
    if (read.status === 404 || read.status === 410) {
      report.manifests[key] = { moved: `answered ${read.status}` }
      report.moved = true
      continue
    }
    if (read.status !== 200 || read.tooLarge) {
      report.manifests[key] = { unread: read.tooLarge ? 'too large' : `answered ${read.status}` }
      unread = true
      continue
    }
    const text = read.bytes.toString('utf8')
    let keys
    try { keys = Object.keys(JSON.parse(text)).sort() } catch { keys = undefined }
    try {
      const manifest = parseAgyManifest(text, key)
      report.manifests[key] = { version: manifest.version, url: short(manifest.url), keys }
    } catch (error) {
      report.manifests[key] = { moved: short(String(error?.message ?? error)), keys }
      report.moved = true
    }
    const wanted = fixture.manifestKeys ?? MANIFEST_KEYS
    if (keys !== undefined && JSON.stringify(keys) !== JSON.stringify([...wanted].sort())) {
      report.manifests[key].keysChanged = true
      report.changed = true
    }
  }
  if (report.moved) return done(1)
  if (unread) return done(2)
  if (report.changed) return done(3)
  return done(0)
}

/** The fixture and its SHA256SUMS, from the scripts as they are now (a person, with network). */
export async function write({ fetch = globalThis.fetch, today = new Date().toISOString().slice(0, 10) } = {}) {
  const scripts = {}
  const sums = []
  for (const name of AGY_SCRIPTS) {
    const read = await get(fetch, `${AGY_SCRIPTS_BASE}${name}`, SCRIPT_MAX_BYTES)
    if (read.status !== 200 || read.tooLarge) throw new Error(`${name} could not be read (${read.status})`)
    const sha256 = createHash('sha256').update(read.bytes).digest('hex')
    const { baseLine, manifestLine } = scriptLines(name, read.bytes.toString('utf8'))
    if (baseLine === undefined || manifestLine === undefined) throw new Error(`${name}: no single base or manifest line; read the script`)
    scripts[name] = { bytes: read.bytes.length, sha256, baseLine, manifestLine }
    sums.push(`${sha256}  ${name}`)
  }
  const fixture = { source: AGY_SCRIPTS_BASE, read: today, scripts, platforms: [...AGY_PLATFORMS], manifestKeys: MANIFEST_KEYS }
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
  writeFileSync(SUMS, `${sums.join('\n')}\n`)
  return fixture
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--write')) {
    try {
      const fixture = await write()
      process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)
    } catch (error) {
      process.stderr.write(`agy-scripts: ${error?.message ?? error}\n`)
      process.exit(2)
    }
  } else {
    const { code, report } = await check().catch(error => ({ code: 2, report: { error: String(error?.message ?? error) } }))
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exit(code)
  }
}
