#!/usr/bin/env node
// Fetch am from the content release's pinned tarball and prove the bytes before they reach the
// image. The release asset pair is immutable and public:
//
//   automagik-am-<version>.tgz
//   automagik-am-<version>.tgz.sha256
//
// The tarball's own VERSION must name the release, it must carry bin/am.mjs, and it must not
// carry am's tests (the release workflow's pack step excludes them). The tarball is removed
// after extraction; the image carries the unpacked command, never an archive.
//
//   node fetch-am.mjs --version 3.149.2 --out /build/out/am
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_REPOSITORY = 'https://github.com/automagik-dev/automagik'
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The tarball's name for a release, as the release workflow builds it. */
export const amTarball = (version) => `automagik-am-${version}.tgz`
/** The sha256 a sum file names a file by, or undefined. */
export function sumOf(sums, file) {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim())
    if (match && match[2] === file) return match[1]
  }
  return undefined
}

async function get(fetchImpl, url, { timeout, attempts, delay }) {
  let failure
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      failure = error
      if (attempt < attempts) await delay(250 * attempt)
    }
  }
  throw failure
}

/**
 * Download, verify and unpack am into `out`. `fetch` and `delay` are injectable for tests; the
 * returned object is what versions.json records about the image's am.
 */
export async function fetchAm({
  version,
  out,
  repository = DEFAULT_REPOSITORY,
  fetch: fetchImpl = globalThis.fetch,
  log = console.log,
  timeout = 120_000,
  attempts = 2,
  delay = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  if (!VERSION_PATTERN.test(String(version ?? ''))) throw new Error(`not a release version: ${version}`)
  if (!/^https:\/\/[\w.-]+(?:\/[\w.-]+)+\/?$/.test(repository)) throw new Error(`not an https repository URL: ${repository}`)
  const base = `${repository.replace(/\/$/, '')}/releases/download/v${version}`
  const file = amTarball(version)
  const options = { timeout, attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 1, delay }
  const sums = (await get(fetchImpl, `${base}/${file}.sha256`, options)).toString('utf8')
  const expected = sumOf(sums, file)
  if (!expected) throw new Error(`${file}.sha256 does not name ${file}`)
  const bytes = await get(fetchImpl, `${base}/${file}`, options)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== expected) throw new Error(`${file}: sha256 ${digest}, not the release's ${expected}`)

  mkdirSync(out, { recursive: true })
  const tarball = join(out, `.${file}`)
  writeFileSync(tarball, bytes, { mode: 0o600 })
  try {
    const members = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd().split('\n').map((name) => name.replace(/^\.\//, ''))
    if (members.some((name) => name === 'test' || name.startsWith('test/'))) throw new Error(`${file}: carries am's tests`)
    if (!members.includes('VERSION') || !members.includes('bin/am.mjs')) throw new Error(`${file}: not an am tarball`)
    execFileSync('tar', ['-xzf', tarball, '-C', out], { stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    rmSync(tarball, { force: true })
  }
  const packedVersion = readFileSync(join(out, 'VERSION'), 'utf8').trim()
  if (packedVersion !== version) throw new Error(`${file}: VERSION is ${packedVersion}, not ${version}`)
  if (!existsSync(join(out, 'bin', 'am.mjs'))) throw new Error(`${file}: bin/am.mjs is missing`)
  log(`[am] ${version}: ${file} ${bytes.byteLength} bytes sha256=${digest}`)
  return { version, file, sha256: digest, size: bytes.byteLength }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {}
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!['--version', '--out', '--repository'].includes(name)) throw new Error(`unexpected argument: ${name}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${name} needs a value`)
    args[name.slice(2)] = value
    index += 1
  }
  try {
    if (!args.version || !args.out) throw new Error('usage: node fetch-am.mjs --version <v> --out <dir> [--repository <url>]')
    await fetchAm({ version: args.version, out: resolve(args.out), repository: args.repository })
  } catch (error) {
    console.error(`fetch-am: ${error?.message ?? error}`)
    process.exit(1)
  }
}
