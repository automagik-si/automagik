import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { publicUrlArgs } from '../lib.mjs'

const ENTRY = fileURLToPath(new URL('../entrypoint.mjs', import.meta.url))
const LIB = new URL('../lib.mjs', import.meta.url).href
const FOLLOW = new URL('../profile-follow.mjs', import.meta.url).href
const FIRST_BOOT = new URL('../first-boot.mjs', import.meta.url).href
const BASE = ['--profile', 'automagik-web', '--no-open', '--host', '127.0.0.1', '--port', '3081']

// Run the real entrypoint, replacing only data preparation and the DSH process. No service
// or live data is touched; validation, argument wiring, logging and launch-file writes run.
const harness = `
  import { registerHooks } from 'node:module'
  const lib = await import(${JSON.stringify(`${LIB}?test-original`)})
  globalThis.serverTestLib = {
    ...lib,
    ensureDataDirs() {}, prepareWorkspace() {}, pinStore() {},
    async seedProfile() { return { seeded: false, target: 'test-profile' } },
  }
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ${JSON.stringify(FOLLOW)}) return { format: 'module', shortCircuit: true,
        source: 'export async function followImage() { const result=process.env.TEST_FOLLOW_RESULT || "owner-managed"; return { seeded: false, target: "test-profile", result, reason: result } }',
      }
      if (url === ${JSON.stringify(FIRST_BOOT)}) return {
        format: 'module', shortCircuit: true,
        source: 'export function runFirstBoot() { return { fresh: false } } export async function installVendorClis() { return { state: "ready" } }',
      }
      if (url === ${JSON.stringify(LIB)}) return {
        format: 'module', shortCircuit: true,
        source: Object.keys(lib).map(key => 'export const ' + key + ' = globalThis.serverTestLib.' + key).join(';'),
      }
      if (url === 'node:child_process') return {
        format: 'module', shortCircuit: true,
        source: \`
          import { EventEmitter } from 'node:events'
          import { PassThrough } from 'node:stream'
          import { mkdirSync, writeFileSync } from 'node:fs'
          import { dirname } from 'node:path'
          export function spawn(command, args, options) {
            if (command === '/usr/local/bin/herdr-core' || args[0] === 'serve') {
              console.log('CORE ' + JSON.stringify({ command, args }))
              const core = new EventEmitter()
              core.stdout = new PassThrough()
              core.stderr = new PassThrough()
              const socket = options.env?.HC_TERMINAL_SOCKET
              if (process.env.TEST_CORE_FAIL) {
                setImmediate(() => {
                  core.exitCode = 1
                  core.signalCode = null
                  core.stderr.write('core map failed')
                  core.stderr.end()
                  core.emit('exit', 1, null)
                })
                return core
              }
              if (socket) { mkdirSync(dirname(socket), { recursive: true }); writeFileSync(socket, '') }
              return core
            }
            console.log('SPAWN ' + JSON.stringify({ command, args, shell: options.shell ?? false, socket: options.env?.HC_TERMINAL_SOCKET, appHome: options.env?.HERDR_APP_HOME }))
            const child = new EventEmitter()
            child.stdout = new PassThrough()
            child.stderr = new PassThrough()
            setImmediate(() => {
              const at = args.indexOf('--public-url')
              const url = new URL(at < 0 ? 'http://127.0.0.1:3081/' : args[at + 1])
              if (!url.pathname.endsWith('/')) url.pathname += '/'
              url.searchParams.set('token', 'test-launch-value')
              child.stdout.end('dsh web: ' + url.href + '\\\\n')
              child.stderr.end()
            })
            return child
          }
        \`,
      }
      return nextLoad(url, context)
    },
  })
  await import(${JSON.stringify(new URL('../entrypoint.mjs', import.meta.url).href)})
`

function run(value, dir, followResult = 'owner-managed', extra = {}) {
  const env = { ...process.env, DSH_HOME: dir, AUTOMAGIK_HOME: dir, AUTOMAGIK_WORKSPACE: dir, HERDR_APP_HOME: join(dir, 'herdr-app'), HC_TERMINAL_SOCKET: join(dir, 'run', 'herdr-core', 'default.sock'), XDG_RUNTIME_DIR: join(dir, 'run'), HC_RUNTIME: join(dir, 'run', 'herdr-core'), HC_SESSION: 'test-entrypoint', DEEPSEEK_API_KEY: 'test-only', TEST_FOLLOW_RESULT: followResult, ...extra }
  delete env.AUTOMAGIK_PUBLIC_URL
  if (value !== undefined) env.AUTOMAGIK_PUBLIC_URL = value
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', harness], {
    env, encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(result.error)
  return result
}

// ENTRY_ABORT_ROLLBACK: a failed update must not prevent starting the coherent old profile.
test('a non-default HC_SESSION derives <session>.sock and announces it after it exists', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-core-env-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = run(undefined, dir)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CORE /)
  assert.match(result.stdout, /herdr-core: serving on .*test-entrypoint\.sock/)
  const call = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('SPAWN ')).slice(6))
  assert.equal(call.socket, join(dir, 'run', 'herdr-core', 'test-entrypoint.sock'))
  assert.equal(call.appHome, join(dir, 'herdr-app'))
})

test('a core socket failure prints no serving line and logs stderr, exit code and the listing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-core-fail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = run(undefined, dir, 'owner-managed', { TEST_CORE_FAIL: '1' })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /herdr-core: serving on /)
  assert.match(result.stderr, /herdr-core exited before its socket .*test-entrypoint\.sock/)
  assert.match(result.stderr, /core map failed/)
  assert.match(result.stderr, /herdr-core exitCode=1 signal=none/)
  assert.match(result.stderr, new RegExp(`${join(dir, 'run', 'herdr-core').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\(empty\\)`))
})

test('the real entrypoint still starts DSH after the updater reports rollback', t => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-follow-entry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = run(undefined, dir, 'update-rolled-back')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /image follow: update-rolled-back/)
  assert.match(result.stdout, /SPAWN /)
  assert.equal(existsSync(join(dir, 'launch-url')), true)
})

for (const value of [undefined, 'https://example.invalid/', 'https://example.invalid:8443/ui']) {
  test(`entrypoint public URL: ${value ?? 'unset'}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'automagik-public-url-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const result = run(value, dir)
    assert.equal(result.status, 0, result.stderr)
    const call = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('SPAWN ')).slice(6))
    assert.equal(call.command, process.execPath)
    assert.equal(call.shell, false)
    const extra = value === undefined ? [] : ['--public-url', value, '--trusted-host', new URL(value).host]
    assert.deepEqual(call.args.slice(1), [...BASE, ...extra])
    assert.match(call.args[0], /\/dsh\/lib\/bin\.js$/)
    const launchFile = join(dir, 'launch-url')
    const launch = new URL(value ?? 'http://127.0.0.1:3081/')
    if (!launch.pathname.endsWith('/')) launch.pathname += '/'
    launch.searchParams.set('token', 'test-launch-value')
    assert.equal(readFileSync(launchFile, 'utf8'), `${launch.href}\n`)
    assert.equal(statSync(launchFile).mode & 0o777, 0o600)
    assert.doesNotMatch(result.stdout, /token=test-launch-value/)
    assert.match(result.stdout, /token=<redacted>/)
  })
}

for (const value of [
  '', ' ', 'not a URL', 'http://example.invalid/', '//example.invalid/', 'https:example.invalid',
  'https:///example.invalid', 'https://', 'https://example.invalid:99999/',
  'https://user:password@example.invalid/', 'https://@example.invalid/',
  'https://example.invalid/?x=1', 'https://example.invalid/#', 'https://example.invalid?',
  ' https://example.invalid/', 'https://example.invalid/\n', 'https://example.invalid/with space',
  'https://example.invalid\\other', 'https://*.example.invalid/',
]) {
  test(`invalid public URL is rejected: ${JSON.stringify(value)}`, () => {
    assert.throws(() => publicUrlArgs(value), /AUTOMAGIK_PUBLIC_URL must be an absolute https:\/\/ URL/)
  })
}

test('invalid configuration stops the real entrypoint before DSH or data preparation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-public-url-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [ENTRY], {
    env: { ...process.env, AUTOMAGIK_PUBLIC_URL: 'http://example.invalid/', AUTOMAGIK_WORKSPACE: join(dir, 'unused') },
    encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^automagik-web: AUTOMAGIK_PUBLIC_URL must be an absolute https:\/\/ URL[^\n]*\n$/)
  assert.equal(existsSync(join(dir, 'unused')), false)
})

test('shell metacharacters remain one URL argument and execute no commands', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-public-url-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const marker = join(dir, 'injected')
  const value = 'https://example.invalid/;$(touch${IFS}' + marker + ');`touch${IFS}' + marker + '`'
  const result = run(value, dir)
  assert.equal(result.status, 0, result.stderr)
  const call = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('SPAWN ')).slice(6))
  assert.equal(call.shell, false)
  assert.deepEqual(call.args.slice(1), [...BASE, '--public-url', value, '--trusted-host', 'example.invalid'])
  // Exercise the same argv with a real process as well as the entrypoint's captured spawn.
  const echo = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...call.args.slice(1)], {
    encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(echo.error)
  assert.equal(echo.status, 0, echo.stderr)
  assert.deepEqual(JSON.parse(echo.stdout), call.args.slice(1))
  assert.equal(existsSync(marker), false)
})
