import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { tracing } from '../../src/bw/run.js'
import { createMacosKeychain } from '../../src/macos-keychain/adapter.js'
import { connection, provider } from '../../src/macos-keychain/parse.js'

assert.ok(process.platform === 'darwin' && process.env.VAULT_MACOS_NATIVE === '1',
  'Native Keychain checks require macOS and VAULT_MACOS_NATIVE=1')
assert.ok(!tracing(), 'Native Keychain checks require child tracing to be off')

const home = userInfo().homedir
const directory = join(home, 'Library', 'Keychains')
const suffix = randomBytes(12).toString('hex')
const primary = join(directory, 'am-ci-' + suffix + '-a.keychain-db')
const secondary = join(directory, 'am-ci-' + suffix + '-b.keychain-db')
const missing = join(directory, 'am-ci-' + suffix + '-missing.keychain-db')
const password = randomBytes(32).toString('hex')
const security = '/usr/bin/security'

function command(args) {
  return new Promise(resolve => {
    if (tracing()) return resolve({ code: undefined })
    try {
      execFile(security, args, {
        env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C' },
        timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }))
    } catch { resolve({ code: undefined }) }
  })
}

async function setup(args) {
  const result = await command(args)
  assert.ok(result.code === 0, 'security setup/cleanup failed: ' + args[0])
  return result.stdout
}

async function searchList() {
  const listing = await setup(['list-keychains', '-d', 'user'])
  return listing.split('\n').filter(Boolean).map(line => {
    const entry = /^\s*"([^\r\n]+)"$/.exec(line)
    assert.ok(entry?.[1].startsWith('/'), 'unexpected search-list entry')
    return entry[1]
  })
}

let next = 0
const pair = () => ({ service: 'am-ci-' + suffix + '-' + ++next, account: randomBytes(12).toString('hex') })
const finder = ({ service, account }) => ['find-generic-password', '-s', service, '-a', account]
const add = (path, { service, account }, value, trusted = security) =>
  setup(['add-generic-password', '-s', service, '-a', account, '-w', value, '-T', trusted, path])
const ref = ({ service, account }, path = primary) =>
  ({ provider, connection, item: JSON.stringify([path, service, account]), field: 'password' })

const options = { timeouts: { read: 5000, metadata: 10_000 } }
const adapter = createMacosKeychain({}, { ...options, keychainPath: primary })
const absent = createMacosKeychain({}, { ...options, keychainPath: missing })
const fixtures = [
  ['a"b', '"a"b"'],
  ['\\', '0x5C '],
  ['çã', '0xC3A7C3A3 '],
  ['ção', '0xC3A7C3A36F  "\\303\\247\\303\\243o"'],
  ['trailing  ', '"trailing  "'],
  ['0x41', '"0x41"'],
].map(([value, formatted]) => ({ value, formatted, identity: pair() }))

mkdirSync(directory, { recursive: true })
assert.ok(![primary, secondary, missing].some(existsSync), 'scratch keychain path collision')
const original = await searchList()
try {
  for (const path of [primary, secondary]) {
    await setup(['create-keychain', '-p', password, path])
    await setup(['unlock-keychain', '-p', password, path])
  }
  for (const { value, formatted, identity } of fixtures) {
    await add(primary, identity, value)
    const raw = await command([...finder(identity), '-g', primary, primary])
    assert.ok(raw.code === 0 && raw.stdout.split('\n', 1)[0] === 'keychain: "' + primary + '"'
      && raw.stderr === 'password: ' + formatted + '\n', 'native header and password record match')
  }

  assert.ok((await adapter.unlock()).ok && (await absent.unlock()).ok, 'plugin gates open')
  for (const { value, identity } of fixtures) {
    const read = await adapter.read(ref(identity))
    assert.ok(read.ok && read.value === value, 'adapter read round-trips')
    const picked = await adapter.listItems({ connection, ...identity })
    assert.ok(picked.ok && picked.items.length === 1 && picked.items[0].id === ref(identity).item
      && picked.items[0].service === identity.service && picked.items[0].account === identity.account
      && picked.items[0].fields.length === 1 && picked.items[0].fields[0] === 'password', 'metadata picker round-trips')
  }

  const collision = pair()
  await add(primary, collision, 'bound-canary')
  await add(secondary, collision, 'other-canary')
  await setup(['list-keychains', '-d', 'user', '-s', secondary, ...original])
  const read = await adapter.read(ref(collision))
  assert.ok(read.ok && read.value === 'bound-canary', 'duplicate identity reads the bound store')

  const elsewhere = pair()
  await add(secondary, elsewhere, 'elsewhere-canary')
  const control = await command(finder(elsewhere))
  assert.ok(control.code === 0 && control.stdout.split('\n', 1)[0] === 'keychain: "' + secondary + '"',
    'metadata control finds the item in the search list')
  const unusable = await command([...finder(elsewhere), missing, missing])
  assert.ok(Number.isInteger(unusable.code) && unusable.code !== 0 && unusable.stdout === '',
    'two unusable paths return no item')
  const revoked = await adapter.read(ref(elsewhere))
  assert.ok(!revoked.ok && revoked.code === 'revoked' && revoked.audit === 'refused', 'bound item absence is audited as refusal')
  const refused = await absent.read(ref(elsewhere, missing))
  assert.ok(!refused.ok && ['revoked', 'refused'].includes(refused.code), 'missing bound file refuses')

  const untrusted = pair()
  const locked = pair()
  await add(primary, untrusted, 'untrusted-canary', '/usr/bin/true')
  await add(primary, locked, 'locked-canary')
  const boundedRefusal = async identity => {
    const started = performance.now()
    const answer = await adapter.read(ref(identity))
    assert.ok(!answer.ok && performance.now() - started < 8000, 'bounded refusal')
  }
  await boundedRefusal(untrusted)
  await setup(['lock-keychain', primary])
  await boundedRefusal(locked)
  console.log('Native Keychain checks passed, including two bounded refusals.')
} finally {
  await Promise.allSettled([adapter.prepareQuit(), absent.prepareQuit()])
  // Attempt every cleanup step even if another fails. Restore order before deletion.
  const cleaned = []
  cleaned.push(await command(['list-keychains', '-d', 'user', '-s', ...original]))
  for (const path of [primary, secondary]) {
    if (existsSync(path)) cleaned.push(await command(['delete-keychain', path]))
  }
  assert.ok(cleaned.every(result => result.code === 0), 'scratch Keychain cleanup succeeded')
  assert.ok(JSON.stringify(await searchList()) === JSON.stringify(original), 'original search-list order restored')
}
