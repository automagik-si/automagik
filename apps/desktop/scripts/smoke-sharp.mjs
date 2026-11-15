// Run the shipped sharp pipeline in Electron's Node process, without starting the app.
// node scripts/smoke-sharp.mjs [runtime-directory | --fixture]
// --fixture installs only the locked sharp/wasm versions for the PR OS matrix.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchSafe } from './batch-spawn.mjs'
import { prepareSharpWasm } from './prune-runtime.mjs'

const SELF = fileURLToPath(import.meta.url)
const APP = resolve(dirname(SELF), '..')
const SUCCESS = 'sharp Electron wasm smoke passed'
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

// Exported so the timeout/crash/early-exit contract can be tested without launching an app.
export function runSharpChild(executable, args, { timeout = 60_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    let failure
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk)
      output = (output + chunk).slice(-8192)
    })
    const stop = reason => {
      failure = new Error(reason)
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop(`sharp smoke timed out after ${timeout}ms`), timeout)
    const interrupt = () => stop('sharp smoke interrupted by SIGINT')
    const terminate = () => stop('sharp smoke interrupted by SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    const cleanup = () => {
      clearTimeout(timer)
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
    }
    child.once('error', error => { failure = error })
    child.once('close', (code, signal) => {
      cleanup()
      if (failure) reject(failure)
      else if (signal || code !== 0) reject(new Error(`sharp smoke exited: code=${code} signal=${signal}`))
      else if (!output.split(/\r?\n/).includes(SUCCESS)) reject(new Error('sharp smoke exited before completing its assertions'))
      else resolve()
    })
  })
}

async function checkSharp(runtime) {
  assert.ok(process.versions.electron, 'the smoke must run in actual Electron')
  assert.equal(process.versions.electron, readJson(join(APP, 'package.json')).devDependencies.electron)
  const warnings = []
  // Register before requiring sharp: its native Linux loader emits this asynchronously.
  process.on('warning', warning => {
    warnings.push(warning.code)
    if (warning.code === 'SharpElectronLinux') process.exitCode = 1
  })
  const require = createRequire(join(runtime, 'package.json'))
  const sharpFile = require.resolve('sharp')
  const fromSharp = createRequire(sharpFile)
  const sharp = require('sharp')
  const binding = fromSharp('./sharp.cjs')
  assert.equal(binding.libvipsVersion().isWasm, true, 'sharp must select its wasm binding')
  const manifest = fromSharp('@img/sharp-wasm32/package')
  assert.equal(sharp.versions.sharp, manifest.version)
  assert.deepEqual(sharp.versions, { ...fromSharp('@img/sharp-wasm32/versions'), sharp: manifest.version })

  // Embedded 3x2 RGB PNG, all pixels [23, 101, 211]. No fixture depends on sharp encoding.
  const input = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWMQT70MQQxwFgBKMAfbpPnJ4QAAAABJRU5ErkJggg==', 'base64')
  const metadata = await sharp(input).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 3)
  assert.equal(metadata.height, 2)
  const raw = await sharp(input).raw().toBuffer({ resolveWithObject: true })
  assert.equal(raw.info.channels, 3)
  assert.deepEqual(raw.data, Buffer.from(Array.from({ length: 6 }, () => [23, 101, 211]).flat()))
  const rotated = await sharp(input).rotate(90).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  assert.equal(rotated.info.width, 2)
  assert.equal(rotated.info.height, 3)
  assert.deepEqual(rotated.data, raw.data)
  for (const format of ['png', 'jpeg', 'webp']) {
    const encoded = await sharp(input).rotate(90).toColourspace('srgb').resize(4, 6).toFormat(format).toBuffer()
    const result = await sharp(encoded).metadata()
    assert.equal(result.format, format)
    assert.equal(result.width, 4)
    assert.equal(result.height, 6)
    assert.equal(result.space, 'srgb')
    const decoded = await sharp(encoded).raw().toBuffer({ resolveWithObject: true })
    assert.equal(decoded.data.length, 4 * 6 * 3)
  }
  await assert.rejects(sharp(Buffer.from('corrupt image')).toBuffer(), Error)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!warnings.includes('SharpElectronLinux'))
  console.log(`Electron ${process.versions.electron}, sharp ${sharp.versions.sharp}, wasm libvips ${sharp.versions.vips}`)
  console.log(SUCCESS)
  // No process.exit(): worker handles must let Electron exit naturally. The parent waits
  // for close, not the success message, and fails on a timeout or a signal after success.
}

async function main(args) {
  if (args[0] === '--child' && args.length === 2) return checkSharp(resolve(args[1]))
  if (args.length > 1 || (args[0]?.startsWith('--') && args[0] !== '--fixture')) {
    throw new Error('usage: node scripts/smoke-sharp.mjs [runtime-directory | --fixture]')
  }
  const electron = createRequire(join(APP, 'package.json'))('electron')
  let fixture
  try {
    let runtime = resolve(args[0] || join(APP, 'build', 'runtime'))
    if (args[0] === '--fixture') {
      fixture = mkdtempSync(join(tmpdir(), 'automagik-sharp-smoke-'))
      runtime = fixture
      const lock = readJson(join(APP, 'runtime', 'package-lock.json')).packages
      const sharp = lock['node_modules/sharp'].version
      const wasm = lock['']['dependencies']['@img/sharp-wasm32']
      assert.equal(sharp, wasm, 'fixture uses the runtime sharp/wasm pin')
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true, dependencies: { sharp, '@img/sharp-wasm32': wasm } }))
      execFileSync(...batchSafe(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund'], {
          cwd: fixture, stdio: 'inherit', timeout: 180_000,
          env: { ...process.env, DO_NOT_TRACK: '1' },
        }))
      prepareSharpWasm(join(fixture, 'node_modules'))
    }
    await runSharpChild(electron, [SELF, '--child', runtime])
  } finally {
    if (fixture) rmSync(fixture, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
