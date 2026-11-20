import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const digest = value => createHash('sha256').update(value).digest('hex')
const dir = process.env.FIXTURE_OP_DIR
const seed = process.env.FIXTURE_OP_SEED
const derived = key => digest(seed + key)
const id = key => (key === 'section' ? 'Section_' : '') + derived(key).slice(0, 26)
const options = JSON.parse(readFileSync(join(dir, 'options.json'), 'utf8'))
const [command, action, ...rest] = process.argv.slice(2)
const version = command === '--version'
const token = process.env.OP_SERVICE_ACCOUNT_TOKEN
const opVars = Object.keys(process.env).filter(key => key.toUpperCase().startsWith('OP_'))
const expectedEnv = version ? opVars.length === 0
  : opVars.length === 1 && token !== undefined && options.tokenHash === digest(token)
const envClean = expectedEnv && !Object.keys(process.env).some(key =>
  ['NODE_DEBUG', 'NODE_OPTIONS', 'BW_SESSION', 'BW_PASSWORD'].includes(key.toUpperCase()))
const operation = version ? 'version' : command === 'read' ? command : command + '-' + action
const itemURI = 'op://' + id('vault') + '/' + id('item') + '/'
const reference = itemURI + id('section') + '/' + id('field')
const expected = {
  version: action === undefined && rest.length === 0,
  'vault-list': rest.join(' ') === '--format json --cache=false',
  'item-list': rest.join(' ') === '--vault ' + id('vault') + ' --format json --cache=false',
  'item-get': rest.join(' ') === id('item') + ' --vault ' + id('vault') + ' --format json --cache=false',
  read: action === '--no-newline' && rest.length === 2 && rest[0] === '--cache=false'
    && [reference, itemURI + 'password'].includes(rest[1]),
}
appendFileSync(join(dir, 'commands'), JSON.stringify({ operation, envClean, argsClean: expected[operation] === true }) + '\n')
if (!envClean || !expected[operation]) process.exit(9)

const valueFor = key => '\ufeff  ' + derived(key) + '\n'
const value = valueFor(options.valueKey)
const password = valueFor(options.valueKey + ':password')
function diagnostic(message) {
  writeSync(2, '[ERROR] 2026/11/20 12:00:00 ' + message + '\n')
  process.exitCode = 1
}
// The 2.39.0 read diagnostic wraps HTTP status around the underlying client error.
const wrapped = (cause, uri = 'op://fixture-vault/fixture-item/password') =>
  'error initializing client for reference ' + uri + ': ' + cause
switch (operation) {
  case 'version':
    if (options.mode === 'version-auth') diagnostic(wrapped('(401) Unauthorized'))
    else if (options.mode === 'version-revoked') diagnostic('vault is not accessible')
    else writeSync(1, options.version + '\n')
    break
  case 'vault-list':
    if (options.mode === 'invalid-token') diagnostic('invalid service account token')
    else writeSync(1, JSON.stringify([{ id: id('vault'), name: 'Fixture vault', extra: value }]))
    break
  case 'item-list':
    writeSync(1, JSON.stringify([{ id: id('item'), title: 'Fixture item', extra: value }]))
    break
  case 'item-get':
    writeSync(1, JSON.stringify({
      id: id('item'), vault: { id: id('vault') }, notes: value,
      sections: [{ id: id('section'), label: 'Fixture section' }],
      fields: [
        { id: 'password', label: 'Password', value: password },
        { id: id('field'), label: 'Password', value, section: { id: id('section') } },
        { id: 'bad/path', label: 'Skip', value },
      ],
    }))
    break
  case 'read': {
    const selectedValue = rest[1] === itemURI + 'password' ? password : value
    const errors = {
      revoked: 'item not found', vault: 'vault is not accessible', field: 'field not found',
      auth: 'invalid service account token', offline: 'dial tcp: network is unreachable',
      throttled: 'Too Many Requests (429)', unknown: 'Unexpected error for ' + reference,
      'wrapped-401': wrapped('(401) Unauthorized: service account is no longer valid'),
      'wrapped-invalid-token': wrapped('failed to authenticate service account: invalid token'),
      'wrapped-auth-required': wrapped('request failed because authentication required for this account'),
      'wrapped-429': wrapped('(429) Too Many Requests: vault is not accessible'),
      'wrapped-503': wrapped('(503) Service Unavailable: item not found'),
      'quoted-vault': '"' + id('item') + '" isn\'t an item in the "authentication required (401) Unauthorized" vault. Specify the item with its UUID, name, or domain.',
      'quoted-reference': wrapped('(401) Unauthorized: service account is no longer valid', '"op://fixture (503)/item/password"'),
      'outage-with-auth-text': wrapped('(503) Service Unavailable: authentication required for the upstream service'),
    }
    if (options.mode === 'hang') await delay(30_000)
    if (options.mode === 'overflow') {
      const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 65)
      for (let offset = 0; offset < bytes.length;) {
        try { offset += writeSync(1, bytes, offset, Math.min(16384, bytes.length - offset)) }
        catch (error) {
          if (error.code !== 'EAGAIN') break
          await delay(1)
        }
      }
    } else if (options.mode === 'invalid-text') writeSync(1, Buffer.from([0xff]))
    else if (options.mode === 'warn') {
      writeSync(1, selectedValue)
      writeSync(2, 'Unexpected warning')
    } else if (errors[options.mode] !== undefined) {
      writeSync(1, selectedValue)
      diagnostic(errors[options.mode])
    } else {
      writeSync(1, selectedValue.slice(0, 5))
      await delay(10)
      writeSync(1, selectedValue.slice(5))
    }
    break
  }
}
