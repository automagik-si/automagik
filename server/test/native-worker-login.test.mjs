import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  BOT_CLI_POINTER_ENV,
  NATIVE_WORKER_LOGIN_ENV,
  NATIVE_WORKER_LOGIN_REQUIRED,
  installationIdentity,
  nativeWorkerEnv,
  panelCliHomes,
} from '../native-worker-login.mjs'
import { installationCliHome } from '../../apps/acp-dsh/src/host/installation.js'
import { CliGenerations } from '../../apps/acp-dsh/src/host/cli-generations.js'
import { spawnCapture } from './fixtures/spawn-capture.mjs'

function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), 'native-worker-login-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const acp = join(home, 'acp')
  const dsh = join(home, 'dsh')
  const other = join(home, 'dsh-other')
  mkdirSync(join(acp, 'cli-homes'), { recursive: true })
  mkdirSync(dsh)
  mkdirSync(other)
  return { home, acp, dsh, other, claim: join(acp, 'cli-homes', 'installation.json') }
}

const claimOf = identity => JSON.stringify({ version: 1, identity })

// Each case is decided by the export first (read-only), then by the panel's own function, which
// may publish the claim: the export must name the root the panel then signs in under.
const CASES = {
  'no claim yet (the panel claims the shared root)': () => {},
  'this installation owns the claim': ({ claim, dsh }) => writeFileSync(claim, claimOf(installationIdentity(dsh))),
  'another installation owns the claim': ({ claim, other }) => writeFileSync(claim, claimOf(installationIdentity(other))),
  'a corrupt claim': ({ claim }) => writeFileSync(claim, '{'),
  // A link to this installation's own claim: following it would wrongly take the shared root.
  'a claim that is a link': ({ claim, dsh }) => {
    writeFileSync(`${dsh}.claim`, claimOf(installationIdentity(dsh)))
    symlinkSync(`${dsh}.claim`, claim)
  },
  'an oversized claim': ({ claim, dsh }) => writeFileSync(claim, claimOf(installationIdentity(dsh)) + ' '.repeat(5000)),
  'a claim that is a folder': ({ claim }) => mkdirSync(claim),
}

for (const [name, plant] of Object.entries(CASES)) {
  test(`the exported root is the panel's sign-in root: ${name}`, t => {
    const s = scratch(t)
    plant(s)
    const exported = panelCliHomes(s.acp, s.dsh)
    const { root } = installationCliHome(s.acp, s.dsh)
    assert.equal(exported, root)
  })
}

test('the pointer names the panel root\'s current/, and each vendor\'s own pointer derives from it', t => {
  const s = scratch(t)
  writeFileSync(s.claim, claimOf(installationIdentity(s.other)))
  const env = nativeWorkerEnv({ AUTOMAGIK_HOME: s.home, DSH_HOME: s.dsh })
  const { root } = installationCliHome(s.acp, s.dsh)
  assert.notEqual(root, join(s.acp, 'cli-homes'))
  const generations = new CliGenerations(root, 'test')
  for (const vendor of ['claude', 'codex']) {
    assert.equal(join(dirname(env[BOT_CLI_POINTER_ENV]), vendor), generations.pointer(vendor))
  }
  assert.equal(env[NATIVE_WORKER_LOGIN_ENV], NATIVE_WORKER_LOGIN_REQUIRED)
  assert.deepEqual(Object.keys(env).sort(), ['AUTOMAGIK_HOME', BOT_CLI_POINTER_ENV, 'DSH_HOME', NATIVE_WORKER_LOGIN_ENV].sort())
})

test('the export reads no record, pointer or home: it names a path that need not exist yet', t => {
  const s = scratch(t)
  const env = nativeWorkerEnv({ AUTOMAGIK_HOME: s.home, DSH_HOME: s.dsh })
  assert.equal(env[BOT_CLI_POINTER_ENV], join(s.acp, 'cli-homes', 'current', 'claude'))
})

// The real entrypoint, with data preparation, the image follow and the DSH process replaced:
// the env DSH is spawned with carries both values, under this installation's own root.
const LIB = new URL('../lib.mjs', import.meta.url).href
const FOLLOW = new URL('../profile-follow.mjs', import.meta.url).href
const harness = `
  import { registerHooks, syncBuiltinESMExports } from 'node:module'
  const fs = process.getBuiltinModule('node:fs')
  globalThis.testSpawn = process.getBuiltinModule('node:child_process').spawn
  const lstat = fs.lstatSync
  fs.lstatSync = (path, options) => path === globalThis.testCoreSocket
    ? { isSocket: () => true } : lstat(path, options)
  // A host's own /data is never this test's: the view stays in the fixture's home.
  const exists = fs.existsSync
  fs.existsSync = (path) => path !== '/data' && exists(path)
  syncBuiltinESMExports()
  const lib = await import(${JSON.stringify(`${LIB}?test-original`)})
  globalThis.serverTestLib = {
    ...lib,
    ensureDataDirs() {}, prepareWorkspace() {}, pinStore() {},
    async seedProfile() { return { seeded: false, target: 'test-profile' } },
  }
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ${JSON.stringify(FOLLOW)}) return { format: 'module', shortCircuit: true,
        source: 'export async function followImage() { return { seeded: false, target: "test-profile", result: "owner-managed", reason: "owner-managed" } }',
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
          export function execFileSync() { return '' }
          export function spawn(command, args, options) {
            if (command === '/usr/bin/flock') return globalThis.testSpawn(command, args, options)
            const env = options.env ?? process.env
            const child = new EventEmitter()
            child.stdout = new PassThrough()
            child.stderr = new PassThrough()
            if (args[0] === 'serve') {
              globalThis.testCoreSocket = env.HC_TERMINAL_SOCKET
              return child
            }
            console.log('DSH SPAWNENV ' + JSON.stringify({
              pointer: env.${BOT_CLI_POINTER_ENV}, marker: env.${NATIVE_WORKER_LOGIN_ENV},
            }))
            setImmediate(() => {
              child.stdout.end('dsh web: http://127.0.0.1:3081/?token=test-launch-value\\\\n')
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

function entrypointSpawnEnv(s) {
  const env = {
    ...process.env, HOME: s.home, AUTOMAGIK_HOME: s.home, DSH_HOME: s.dsh,
    AUTOMAGIK_WORKSPACE: s.home, DEEPSEEK_API_KEY: 'test-only', HC_SESSION: 'test-worker-login',
    XDG_RUNTIME_DIR: join(s.home, 'run'), HERDR_APP_HOME: join(s.home, 'herdr-app'),
  }
  delete env.AUTOMAGIK_PUBLIC_URL
  delete env[BOT_CLI_POINTER_ENV]
  delete env[NATIVE_WORKER_LOGIN_ENV]
  const result = spawnCapture(s.home, process.execPath, ['--input-type=module', '--eval', harness], { env, timeout: 30_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const line = result.stdout.split('\n').find(row => row.startsWith('DSH SPAWNENV '))
  assert.ok(line, result.stdout)
  return JSON.parse(line.slice('DSH SPAWNENV '.length))
}

test('the real entrypoint spawns DSH with the pointer and the marker (the shared root it owns)', t => {
  const s = scratch(t)
  writeFileSync(s.claim, claimOf(installationIdentity(s.dsh)))
  assert.deepEqual(entrypointSpawnEnv(s), {
    pointer: join(s.acp, 'cli-homes', 'current', 'claude'), marker: NATIVE_WORKER_LOGIN_REQUIRED,
  })
})

test('the real entrypoint never exports another installation\'s login on a reused volume', t => {
  const s = scratch(t)
  writeFileSync(s.claim, claimOf(installationIdentity(s.other)))
  const seen = entrypointSpawnEnv(s)
  assert.equal(seen.pointer, join(installationCliHome(s.acp, s.dsh).root, 'current', 'claude'))
  assert.ok(!seen.pointer.startsWith(join(s.acp, 'cli-homes')))
  assert.equal(seen.marker, NATIVE_WORKER_LOGIN_REQUIRED)
})
