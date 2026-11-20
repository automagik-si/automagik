import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { runBw, runOp, runSensitive } from '../src/bw/run.js'
import { createBitwardenSecrets } from '../src/bws/adapter.js'
import { createKeychain } from '../src/keychain/index.js'
import { completed, digest, fakeSpawn, fakeToken } from './fixtures/bws.mjs'

const id = 'automagik-vault:v1:' + 'ab'.repeat(16)
const keychainFailure = { ok: false, code: 'keychain' }
const clearFailure = { ok: false, code: 'clear' }
const opaqueArgs = ['automagik-vault-item', id]

test('Linux Secret Service keeps the blob byte-exact and fails closed on ambiguous lookup and clear', async () => {
  const token = fakeToken()
  const blob = Buffer.from(JSON.stringify({ v: 1, token, server: 'us' })).toString('base64')
  let saved
  let error = 'No session bus'
  let retain = false
  let locked = false
  let lockOnClear = false
  const calls = []
  const keychain = createKeychain({
    platform: 'linux',
    parent: { BWS_ACCESS_TOKEN: token, BWS_PROFILE: 'fixture', DBUS_SESSION_BUS_ADDRESS: 'guest-session' },
    resolveHelper: () => ({ file: 'guest-secret-tool', prefix: [] }),
    spawnChild: fakeSpawn(({ file, args, options, stdin }) => {
      const op = args[0]
      calls.push({ file, args: args.some(arg => arg.includes(token)) ? [] : args,
        env: Object.keys(options.env), stdin: stdin === undefined ? undefined : digest(stdin) })
      if (op === 'store') { saved = stdin; return completed() }
      if (error) return completed(1, '', error)
      if (op === 'lookup') return saved === undefined || locked ? completed(1) : completed(0, saved)
      if (op === 'clear') {
        if (lockOnClear) locked = true
        if (!retain) saved = undefined
        return completed()
      }
      return completed(0, saved === undefined ? '' : 'locked match')
    }),
  })
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  assert.deepEqual(await keychain.clear(id), keychainFailure)
  error = ''
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  assert.equal((await keychain.store(id, blob)).ok, true)
  const result = await keychain.lookup(id)
  assert.equal(result.ok && digest(result.blob) === digest(blob), true)
  retain = true
  assert.deepEqual(await keychain.clear(id), clearFailure)
  locked = true
  assert.deepEqual(await keychain.clear(id), clearFailure)
  assert.deepEqual(calls.slice(-5).map(call => call.args[0]), ['lookup', 'search', 'clear', 'lookup', 'search'])
  locked = false
  lockOnClear = true
  assert.deepEqual(await keychain.clear(id), clearFailure)
  assert.deepEqual(calls.slice(-4).map(call => call.args[0]), ['lookup', 'clear', 'lookup', 'search'])
  lockOnClear = false
  retain = false
  locked = false
  assert.equal((await keychain.clear(id)).ok, true)
  assert.equal(calls.every(call => call.file === 'guest-secret-tool' && call.env.join() === 'DBUS_SESSION_BUS_ADDRESS'), true)
  const stored = calls.find(call => call.args[0] === 'store')
  assert.deepEqual(stored.args, ['store', '--label=Automagik Vault', ...opaqueArgs])
  assert.equal(stored.stdin === digest(blob), true)
  assert.equal(calls.filter(call => call.args[0] !== 'store').every(call =>
    call.stdin === undefined && call.args.slice(-2).join() === opaqueArgs.join()), true)
  assert.deepEqual(calls.at(-1).args, ['search', '--all', ...opaqueArgs])
  saved = '!' + blob.slice(1)
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  assert.equal((await keychain.clear(id)).ok, true)
  assert.equal(saved === undefined, true)
})

test('Linux Clear removes oversized and binary records whose values Unlock cannot read', async () => {
  let saved
  let lookupError
  const calls = []
  const keychain = createKeychain({
    platform: 'linux', resolveHelper: () => ({ file: '/fake/secret-tool', prefix: [] }),
    spawnChild: fakeSpawn(({ args: [operation] }) => {
      calls.push(operation)
      if (operation === 'lookup' && lookupError !== undefined) return lookupError
      if (operation === 'lookup') {
        if (saved === undefined) return completed(1)
        // libsecret exits 1 when it cannot represent the item's value as a password.
        // https://github.com/GNOME/libsecret/blob/0.21.7/tool/secret-tool.c#L177-L185
        if (Buffer.isBuffer(saved)) return completed(1, '', 'secret-tool: secret does not contain a textual password\n')
        return completed(0, saved)
      }
      if (operation === 'search') return completed(0, saved ?? '')
      if (operation === 'clear') saved = undefined
      return completed()
    }),
  })
  for (const damaged of [randomBytes(7 * 1024).toString('base64'), Buffer.concat([Buffer.from([0xff]), randomBytes(32)])]) {
    saved = damaged
    assert.deepEqual(await keychain.lookup(id), keychainFailure)
    const before = calls.length
    assert.deepEqual(await keychain.clear(id), { ok: true })
    assert.deepEqual(calls.slice(before), Buffer.isBuffer(damaged)
      ? ['lookup', 'search', 'clear', 'lookup', 'search'] : ['lookup', 'clear', 'lookup', 'search'])
    assert.equal(saved === undefined, true)
  }
  lookupError = completed(1, '', 'fixture error\n'.repeat(1024))
  const before = calls.length
  assert.deepEqual(await keychain.clear(id), keychainFailure)
  assert.deepEqual(calls.slice(before), ['lookup'])
})

test('Linux Clear leaves the record untouched when lookup and search both fail', async () => {
  const commands = []
  const keychain = createKeychain({
    platform: 'linux', resolveHelper: () => ({ file: '/fake/secret-tool', prefix: [] }),
    spawnChild: fakeSpawn(({ args }) => {
      commands.push(args)
      return completed(1, '', 'secret-tool: No session bus\n')
    }),
  })
  assert.deepEqual(await keychain.clear(id), keychainFailure)
  assert.deepEqual(commands, [['lookup', ...opaqueArgs], ['search', '--all', ...opaqueArgs]])
})

test('macOS interactive security gets one bounded command followed by EOF', async () => {
  let saved
  const token = fakeToken()
  const blob = Buffer.from(JSON.stringify({ v: 1, token, server: 'eu' })).toString('base64')
  const history = []
  // The piped interactive loop emits no prompt and prints the command-qualified status on stderr.
  // https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c#L1098-L1125
  // The delete handler prints item attributes to stdout and the confirmation to stderr.
  // https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_find.c#L485-L495
  const missing = verb => completed(44, '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n' +
    verb + ': returned -25300\n')
  const attributes = 'keychain: "/fixture.keychain-db"\nversion: 512\nclass: "genp"\nattributes:\n' +
    '    "acct"<blob>="' + id + '"\n    "svce"<blob>="' + id + '"\n'
  let failure
  let retain = false
  const keychain = createKeychain({
    platform: 'darwin', parent: { BW_SESSION: token, RUST_LOG: 'trace' },
    exists: file => file === '/usr/bin/security',
    spawnChild: fakeSpawn(({ args, options, stdin, file }) => {
      const [, verb, suffix] = /^(\S+) (.*)\n$/.exec(stdin) ?? []
      history.push({ verb, argv: args.join(' '), exact: file === '/usr/bin/security' && Object.keys(options.env).length === 0
        && !stdin.slice(0, -1).includes('\n') && suffix?.includes('-s ' + id + ' -a ' + id),
      size: Buffer.byteLength(stdin) })
      if (failure !== undefined) return failure
      if (verb === 'add-generic-password') { saved = suffix.split(' -w ')[1]; return completed() }
      if (saved === undefined) return missing(verb)
      if (verb === 'delete-generic-password') {
        if (!retain) saved = undefined
        return completed(0, attributes, 'password has been deleted.\n')
      }
      return completed(0, suffix.endsWith(' -w') ? saved + '\n' : attributes)
    }),
  })
  assert.equal((await keychain.store(id, blob)).ok, true)
  const result = await keychain.lookup(id)
  assert.equal(result.ok && digest(result.blob) === digest(blob), true)
  assert.equal((await keychain.clear(id)).ok, true)
  assert.deepEqual(history.map(row => row.verb), ['add-generic-password', 'find-generic-password', 'find-generic-password',
    'delete-generic-password', 'find-generic-password'])
  assert.equal(history.every(row => row.argv === '-i' && row.exact), true)
  assert.deepEqual(await keychain.clear(id), { ok: false, code: 'not-saved' })
  assert.equal((await keychain.store(id, 'A'.repeat(2560))).ok, true)
  assert.equal(history.at(-1).size < 4096, true)
  const count = history.length
  assert.deepEqual(await keychain.store(id, 'A'.repeat(2564)), keychainFailure)
  assert.equal(history.length, count)
  retain = true
  assert.deepEqual(await keychain.clear(id), clearFailure)
  failure = missing('find-generic-password')
  assert.deepEqual(await keychain.lookup(id), { ok: true })
  failure = missing('delete-generic-password')
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  failure = completed(0, '', 'security: SecKeychainItemDelete: interaction not allowed.\nreturned 36\n')
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  assert.deepEqual(await keychain.clear(id), keychainFailure)
  failure = undefined
  retain = false
  saved = '!' + blob.slice(1)
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  assert.equal((await keychain.clear(id)).ok, true)
  assert.equal(saved === undefined, true)
})

test('macOS refuses to spawn an interactive command that exceeds the complete line limit', async () => {
  const blob = 'A'.repeat(2560)
  const fixed = Buffer.byteLength('add-generic-password -U -s ' + id + ' -a ' + id + ' -w ' + blob + ' "/"\n')
  const path = '/' + 'x'.repeat(4095 - fixed)
  let size
  const spawnChild = fakeSpawn(({ stdin }) => { size = Buffer.byteLength(stdin); return completed() })
  const options = { platform: 'darwin', spawnChild, exists: file => file === '/usr/bin/security' }
  assert.equal((await createKeychain({ ...options, testKeychainFile: path }).store(id, blob)).ok, true)
  assert.equal(size, 4095)
  size = undefined
  assert.deepEqual(await createKeychain({ ...options, testKeychainFile: path + 'x' }).store(id, blob), keychainFailure)
  assert.equal(size, undefined)
})

test('Windows PowerShell keeps bounded data in C# and uses fixed native errors', async () => {
  let saved
  let blocked = false
  const calls = []
  const token = fakeToken()
  const blob = Buffer.from(JSON.stringify({ v: 1, token, server: 'us' })).toString('base64')
  const keychain = createKeychain({
    platform: 'win32', parent: { SystemRoot: 'C:\\Windows', BWS_ACCESS_TOKEN: token, RUST_BACKTRACE: '1' },
    exists: file => file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnChild: fakeSpawn(({ file, args, options, stdin }) => {
      const [operation, id, blob] = stdin.split('\n')
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
      calls.push({ file, flags: args.slice(0, -1), script: digest(script),
        noData: !script.includes(token) && !script.includes(id) && !/ConvertFrom-Json|Write-Output|\$input/i.test(script)
          && script.includes('Console.In') && script.includes('Console.Out'),
        id, stdin: blob ? digest(blob) : undefined, env: Object.keys(options.env) })
      if (blocked) return completed(11)
      if (operation === 'store') { saved = blob; return completed() }
      if (operation === 'clear') { saved = undefined; return completed() }
      if (operation === 'exists') return completed(saved === undefined ? 10 : 0)
      return saved === undefined ? completed(10) : completed(0, saved)
    }),
  })
  assert.deepEqual(await keychain.lookup(id), { ok: true })
  blocked = true
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  assert.deepEqual(await keychain.clear(id), keychainFailure)
  blocked = false
  assert.equal((await keychain.store(id, blob)).ok, true)
  const result = await keychain.lookup(id)
  assert.equal(result.ok && digest(result.blob) === digest(blob), true)
  assert.equal((await keychain.clear(id)).ok, true)
  const count = calls.length
  assert.deepEqual(await keychain.store(id, 'é'.repeat(1281)), keychainFailure)
  assert.equal(calls.length, count)
  assert.equal(new Set(calls.map(row => row.script)).size, 1)
  assert.equal(calls.every(row => row.noData && row.id === id && row.file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    && row.env.join() === 'SystemRoot' && row.flags.join() === '-NoProfile,-NonInteractive,-EncodedCommand'), true)
  assert.equal(calls.filter(row => row.stdin === digest(blob)).length, 1)
  saved = '!' + blob.slice(1)
  assert.deepEqual(await keychain.lookup(id), keychainFailure)
  assert.equal((await keychain.clear(id)).ok, true)
  assert.equal(saved === undefined, true)
})

test('Linux pins the resolved absolute helper through store, Clear and their confirming lookups',
  { skip: process.platform === 'win32' }, async t => {
    const home = mkdtempSync(join(tmpdir(), 'secret-tool-path-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const [decoy, preferred, trusted] = ['decoy', 'preferred', 'trusted'].map(name => join(home, name))
    for (const dir of [decoy, preferred, trusted]) mkdirSync(dir)
    for (const dir of [decoy, trusted]) writeFileSync(join(dir, 'secret-tool'), '', { mode: 0o700 })
    const higherPriority = join(preferred, 'secret-tool')
    const calls = []
    let saved
    const keychain = createKeychain({
      platform: 'linux', parent: { PATH: [relative(process.cwd(), decoy), preferred, trusted].join(':') },
      spawnChild: fakeSpawn(({ file, args: [operation], stdin }) => {
        calls.push([file, operation])
        if (file !== join(trusted, 'secret-tool')) return completed(99)
        if (operation === 'store' || operation === 'clear') {
          saved = stdin
          writeFileSync(higherPriority, '', { mode: 0o700 })
        }
        if (operation === 'lookup') return saved === undefined ? completed(1) : completed(0, saved)
        return completed()
      }),
    })
    assert.equal(keychain.available, true)
    const adapter = createBitwardenSecrets({}, { keychain, identity: { item: () => id },
      run: async args => completed(0, args[0] === '--version' ? 'bws 2.1.0\n' : '[]'),
    })
    t.after(() => adapter.prepareQuit())
    assert.deepEqual(await adapter.setToken({ token: fakeToken(), server: 'us', connection: 'Work' }), { ok: true })
    rmSync(higherPriority)
    assert.deepEqual(await keychain.clear(id), { ok: true })
    assert.deepEqual(calls, ['store', 'lookup', 'lookup', 'clear', 'lookup', 'search'].map(op => [join(trusted, 'secret-tool'), op]))
})

test('store distinguishes missing or unspawnable helpers from failures after dispatch', async () => {
  const blob = Buffer.from(fakeToken()).toString('base64')
  const resolveHelper = () => ({ file: '/fake/secret-tool', prefix: [] })
  const options = { platform: 'linux', parent: { PATH: '' } }
  assert.deepEqual(await createKeychain(options).store(id, blob), keychainFailure)
  assert.deepEqual(await createKeychain({ ...options, resolveHelper, spawnChild() { throw new Error('fixture') } })
    .store(id, blob), keychainFailure)
  const spawnChild = fakeSpawn(() => undefined)
  const spawnFailure = (...args) => {
    const child = spawnChild(...args)
    child.pid = undefined
    queueMicrotask(() => child.emit('error', new Error('fixture')))
    return child
  }
  assert.deepEqual(await createKeychain({ ...options, resolveHelper, spawnChild: spawnFailure }).store(id, blob), keychainFailure)
  for (const respond of [() => completed(1), ({ child }) => child.kill('SIGKILL')]) {
    const keychain = createKeychain({ ...options, resolveHelper, spawnChild: fakeSpawn(respond) })
    assert.deepEqual(await keychain.store(id, blob), { ok: false, code: 'set', committed: true })
  }
})

test('bw, op, and Windows taskkill keep credentials in only the intended child environment', async () => {
  const token = fakeToken()
  const history = []
  let active
  const options = {
    platform: 'win32', parent: { PATH: 'C:\\fixture', SystemRoot: 'C:\\Windows', BWS_ACCESS_TOKEN: token, OP_SESSION: token },
    exists: () => true,
    spawnChild: fakeSpawn(({ file, args, options, stdin, child }) => {
      history.push({ file, args: args.some(arg => arg.includes(token)) ? [] : args, pipe: stdin !== undefined,
        secrets: Object.entries(options.env).filter(([, value]) => value === token).map(([key]) => key),
        stdio: options.stdio })
      if (file.endsWith('bw.exe')) return completed()
      if (file.endsWith('op.exe')) { active = child; return undefined }
      active.kill('SIGKILL')
      return completed()
    }),
  }
  assert.equal((await runBw(['status'], { session: token, timeout: 100 }, options)).code, 0)
  assert.deepEqual(await runOp(['vault', 'list'], { token, timeout: 20 }, options), { failure: 'timeout' })
  assert.deepEqual(history.map(row => row.secrets), [['BW_SESSION'], ['OP_SERVICE_ACCOUNT_TOKEN'], []])
  assert.equal(history.every(row => !row.pipe), true)
  assert.deepEqual(history.map(row => row.args), [['status'], ['vault', 'list', '--cache=false'], ['/PID', '321', '/T', '/F']])
  assert.equal(history[2].file, 'C:\\Windows\\System32\\taskkill.exe')
  assert.equal(history[2].stdio, 'ignore')
})

test('sensitive runner refuses tracing before spawn and handles EPIPE while waiting for child close', async () => {
  const runner = new URL('../src/bw/run.js', import.meta.url).href
  const traced = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { randomBytes } from 'node:crypto'
    import { runSensitive } from ${JSON.stringify(runner)}
    const resolve = () => process.exit(10)
    const value = randomBytes(24).toString('hex')
    for (const limits of [{ stdin: value }, { credentials: { FIXTURE: value }, sensitive: false }, {}]) {
      if ((await runSensitive([], limits, resolve)).failure !== 'refused') process.exit(11)
    }
  `], { env: { ...process.env, NODE_DEBUG: 'child_process' } })
  assert.equal(traced.status, 0)
  let close
  const input = fakeToken()
  const spawned = Promise.withResolvers()
  const running = runSensitive([], { stdin: input, timeout: 1000 }, () => ({ file: 'fake', prefix: [] }), {
    spawnChild: fakeSpawn(({ child }) => {
      child.kill = () => {}
      close = () => child.emit('close', 0, null)
      child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }))
      spawned.resolve()
    }),
  })
  await spawned.promise
  let done = false
  void running.then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false)
  close()
  assert.deepEqual(await running, { failure: 'unavailable' })
})
