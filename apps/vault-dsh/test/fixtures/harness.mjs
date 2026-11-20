import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { createVault } from '../../src/bw/adapter.js'
import { runBw } from '../../src/bw/run.js'
import { UNLOCK_ENV } from '../../src/bw/unlock-env.js'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const equalPrivate = (actual, expected) => {
  assert.equal(JSON.stringify(actual) === JSON.stringify(expected), true, 'the response has only the permitted fields')
}
export const unavailable = async operation => {
  let rejected = false
  try { await operation } catch (error) { rejected = error?.message === 'The vault did not answer.' }
  assert.equal(rejected, true, 'the rejection has only the fixed unavailable message')
}
const controls = ['BW_RAW', 'BW_PRETTY', 'BW_QUIET', 'BW_CLEANEXIT', 'NODE_DEBUG', 'NODE_OPTIONS']

export function fakeClock() {
  let now = 0
  const pending = new Map()
  return {
    setTimeout(run, delay) {
      const handle = { unref() {} }
      pending.set(handle, { run, at: now + delay })
      return handle
    },
    clearTimeout(handle) { pending.delete(handle) },
    tick(ms) {
      now += ms
      for (const [handle, { run, at }] of pending) if (at <= now) {
        pending.delete(handle)
        run()
      }
    },
  }
}

export function fakeVault(t, { timers, idleLockMinutes, shorten = {}, ...initial } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'test-vault-'))
  const file = name => join(root, name)
  const fixture = readFileSync(new URL('./fake-bw.mjs', import.meta.url))
  // The executable resolves Node by absolute path. PATH contains only this fake CLI.
  writeFileSync(file('bw'), Buffer.concat([Buffer.from("#!" + process.execPath + "\n"), fixture]), { mode: 0o700 })
  for (const directory of ['home', 'temp', 'appdata']) mkdirSync(file(directory), { mode: 0o700 })
  const seed = randomBytes(32).toString('hex')
  const hash = name => digest(seed + name)
  const hex = hash('id')
  const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
  const key = Buffer.from(hash('key'), 'hex').toString('base64')
  const password = hash('password')
  const connection = hash('connection')
  const field = hash('field')
  const scrubbed = [...controls, ...UNLOCK_ENV.filter(name => name !== 'BW_SESSION' && name !== 'BW_PASSWORD')]
  const hashes = { password: digest(password), key: digest(key) }
  let options = initial
  const configure = patch => {
    options = { ...options, ...patch }
    writeFileSync(file('options.json'), JSON.stringify({ ...options, scrubbed, hashes }))
  }
  configure({})
  const parent = {
    ...Object.fromEntries(scrubbed.map(name => [name.toLowerCase(), password])),
    BW_RESPONSE: 'unexpected', BW_NOINTERACTION: 'unexpected', BW_SESSION: key, BW_PASSWORD: password,
    op_session_fixture: password, PATH: root, HOME: file('home'), TMPDIR: file('temp'),
    BITWARDENCLI_APPDATA_DIR: file('appdata'), BW_FIXTURE_DIR: root, BW_FIXTURE_SEED: seed,
  }
  const run = (args, settings) => runBw(args, {
    ...settings, timeout: shorten[args[0]] ?? settings.timeout,
  }, { parent })
  const service = createVault({ idleLockMinutes }, { timers, run })
  const log = () => existsSync(file('commands'))
    ? readFileSync(file('commands'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const commands = () => log().map(row => row.command)
  const waitFor = async (command, count = 1) => {
    for (let i = 0; i < 300; i++) {
      if (commands().filter(row => row === command).length >= count) return
      await wait(10)
    }
    assert.fail('the expected fake CLI boundary was never reached')
  }
  const release = command => writeFileSync(file(command === undefined ? 'continue' : 'continue-' + command), 'continue')
  const absent = output => {
    const text = String(output)
    const forbidden = [password, key, hash('old'), hash('new'), hash('custom'), hash('other'), hash('name'), id, id.toUpperCase(), field, connection, seed]
    assert.equal(forbidden.some(value => text.includes(value)), false, 'private data reached an unapproved output')
  }
  t.after(async () => {
    try {
      release()
      await service.dispose()
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) absent(readFileSync(join(entry.parentPath, entry.name), 'utf8'))
      }
      for (const row of log()) assert.equal(row.scrubbed && row.safeArgs && row.noninteractive, true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  return {
    service, configure, log, commands, waitFor, release, absence: absent, parent,
    password, key, connection, id, field, value: hash,
    ref: { provider: 'bitwarden', connection, item: id, field: 'login.password' },
    unlock: () => service.unlock({ password, connection }),
  }
}
