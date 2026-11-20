import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runOp } from '../../src/bw/run.js'
import { createOnePassword } from '../../src/onepassword/adapter.js'
import { digest } from './harness.mjs'

export function fakeOnePassword(t, { timers, readTimeout, ...overrides } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'test-onepassword-'))
  const path = name => join(dir, name)
  const script = readFileSync(new URL('./fake-op.mjs', import.meta.url))
  writeFileSync(path('op'), Buffer.concat([Buffer.from('#!' + process.execPath + '\n'), script]), { mode: 0o700 })
  const seed = randomBytes(32).toString('hex')
  const token = () => randomBytes(32).toString('base64url')
  const credential = token()
  const replacement = token()
  const ambient = token()
  const parent = {
    PATH: dir, HOME: dir, TMPDIR: dir, FIXTURE_OP_DIR: dir, FIXTURE_OP_SEED: seed,
    OP_SERVICE_ACCOUNT_TOKEN: ambient, OP_CONNECT_TOKEN: ambient, OP_CONNECT_HOST: ambient,
    OP_SESSION_TEST: ambient, OP_BIOMETRIC_UNLOCK_ENABLED: ambient, op_debug: ambient,
    NODE_DEBUG: 'child_process', NODE_OPTIONS: '--inspect', BW_SESSION: ambient, bw_password: ambient,
  }
  const opts = { version: '2.39.0', valueKey: 'first', tokenHash: digest(credential) }
  const configure = (more = {}) => {
    Object.assign(opts, more)
    writeFileSync(path('options.json'), JSON.stringify(opts))
  }
  configure()
  const id = key => (key === 'section' ? 'Section_' : '') + digest(seed + key).slice(0, 26)
  const value = key => '\ufeff  ' + digest(seed + key) + '\n'
  const ref = { provider: 'onepassword', connection: 'fixture', item: id('vault') + '/' + id('item'),
    field: id('section') + '/' + id('field') }
  const service = createOnePassword({}, {
    timers,
    run: (args, limits) => runOp(args, {
      ...limits, timeout: args[0] === 'read' && readTimeout ? readTimeout : limits.timeout,
    }, { parent }),
    ...overrides,
  })
  const commands = () => existsSync(path('commands'))
    ? readFileSync(path('commands'), 'utf8').trim().split('\n').map(row => JSON.parse(row))
    : []
  const clean = output => {
    const bytes = String(output)
    assert.equal([seed, credential, replacement, ambient, id('vault'), id('item'), id('section'), id('field'),
      digest(seed + 'first'), digest(seed + 'next')].some(canary => bytes.includes(canary)), false,
    'private data reached an unapproved output')
  }
  t.after(async () => {
    try {
      await service.prepareQuit()
      for (const row of commands()) assert.equal(row.envClean && row.argsClean, true, row.operation)
      for (const entry of readdirSync(dir)) clean(readFileSync(path(entry), 'utf8'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const waitForRead = async () => {
    for (let i = 0; i < 200; i++) {
      if (commands().some(row => row.operation === 'read')) return
      await delay(10)
    }
    assert.fail('the fake read did not start')
  }
  return { service, configure, commands, clean, waitForRead, ref, parent, credential, replacement, value,
    unlock: (privateToken = credential) => service.unlock({ connection: ref.connection, token: privateToken }) }
}

export function useFakeVaultExecutables(op, bw) {
  const env = {
    ...Object.fromEntries(Object.entries(bw.parent).filter(([name]) =>
      ['BITWARDENCLI_APPDATA_DIR', 'BW_FIXTURE_DIR', 'BW_FIXTURE_SEED'].includes(name))),
    PATH: op.parent.PATH + ':' + bw.parent.PATH, HOME: bw.parent.HOME, TMPDIR: bw.parent.TMPDIR,
    FIXTURE_OP_DIR: op.parent.FIXTURE_OP_DIR, FIXTURE_OP_SEED: op.parent.FIXTURE_OP_SEED,
  }
  const before = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
