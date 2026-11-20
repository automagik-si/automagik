import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const [command, ...args] = process.argv.slice(2)
const dir = process.env.BW_FIXTURE_DIR
const seed = process.env.BW_FIXTURE_SEED
const file = name => join(dir, name)
const options = JSON.parse(readFileSync(file('options.json'), 'utf8'))
const digest = value => createHash('sha256').update(value).digest('hex')
const derive = name => createHash('sha256').update(seed + name)
const hex = derive('id').digest('hex')
const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
const key = derive('key').digest('base64')
const field = derive('field').digest('hex')
const sensitive = [derive('password').digest('hex'), key]
const known = ['--version', 'status', 'unlock', 'lock', 'sync', 'get', 'list']
const sessionCommand = ['status', 'sync', 'get', 'list'].includes(command)
const controls = Object.keys(process.env).map(name => name.toUpperCase())
const log = {
  command: known.includes(command) ? command : 'unexpected',
  password: process.env.BW_PASSWORD === undefined ? null : digest(process.env.BW_PASSWORD) === options.hashes.password,
  session: process.env.BW_SESSION === undefined ? null : digest(process.env.BW_SESSION) === options.hashes.key,
  safeArgs: args.every(arg => sensitive.every(value => !arg.includes(value))),
  scrubbed: !controls.some(name => options.scrubbed.includes(name) || name.startsWith('OP_SESSION_')),
  noninteractive: process.env.BW_NOINTERACTION === 'true',
  response: process.env.BW_RESPONSE === 'true',
  forced: command === 'sync' && args.length === 1 && args[0] === '--force',
  correctItem: command === 'get' && args.length === 2 && args[0] === 'item' && args[1] === id,
  search: command === 'list' && args[0] === 'items' && args[1] === '--search=--fixture search',
  vaultwarden: process.env.BITWARDENCLI_APPDATA_DIR === file('appdata') && options.server === 'vaultwarden',
}
appendFileSync(file('commands'), JSON.stringify(log) + '\n')
if (options.hold?.includes(command)) {
  while (!existsSync(file('continue-' + command)) && !existsSync(file('continue'))) await wait(10)
} else if (options.pause === command) {
  while (!existsSync(file('continue'))) await wait(10)
}

// Write to the CLI's pipes synchronously so fixtures work in a sandbox with
// restricted Node IPC. Only the parent adapter reads these bytes.
const ok = data => writeSync(1, JSON.stringify({ success: true, data }))
const fail = message => {
  writeSync(1, JSON.stringify({ success: false, message }))
  process.exitCode = 1
}
const item = () => {
  const revision = existsSync(file('revision')) ? readFileSync(file('revision'), 'utf8') : 'old'
  const fields = [
    { name: field, type: 1, value: derive('custom').digest('hex') },
    { name: 'password', type: 0, value: derive('other').digest('hex') },
    { name: 'duplicate', type: 0, value: derive('other').digest('hex') },
    { name: 'duplicate', type: 2, value: derive('other').digest('hex') },
    { name: 'linked', type: 3, value: derive('other').digest('hex') },
  ]
  return {
    object: 'item', id: options.badId ? '00000000-0000-0000-0000-000000000000' : id.toUpperCase(),
    name: derive('name').digest('hex'), deletedDate: options.deleted ? '2026-11-19T12:00:00Z' : null,
    login: { username: derive('other').digest('hex'), password: options.empty ? '' : derive(revision).digest('hex'),
      totp: derive('other').digest('hex') },
    notes: derive('other').digest('hex'), fields,
  }
}

switch (command) {
  case '--version': writeSync(1, options.version ?? '2026.10.1'); break
  case 'status':
    if (options.auth === 'status') { fail('Invalid session key.'); break }
    ok({ object: 'template', template: {
      status: options.status ?? (log.session ? 'unlocked' : 'locked'),
      lastSync: options.lastSync ?? null, userEmail: derive('other').digest('hex'),
    } })
    break
  case 'unlock':
    if (!log.password || log.session !== null || log.response || args.join(' ') !== '--raw --passwordenv BW_PASSWORD') process.exitCode = 1
    else if (options.unlock === 'error') fail('Key Connector is enabled.')
    else if (options.unlock === 'malformed') writeSync(1, JSON.stringify({ session: key }))
    else if (options.unlock !== 'empty') writeSync(1, key + '\n')
    break
  case 'lock':
    if (options.lock === 'error') process.exitCode = 1
    break
  case 'sync':
    if (options.sync === 'truncated') writeSync(1, '{"success":')
    else if (options.sync === 'oversize') {
      ok({ object: 'message', title: 'Syncing complete.' })
      const oversized = Buffer.from(key.repeat(120000))
      for (let offset = 0; offset < oversized.length;) {
        try { offset += writeSync(1, oversized, offset, Math.min(16384, oversized.length - offset)) }
        catch (error) {
          if (error.code !== 'EAGAIN') break
          await wait(1)
        }
      }
    } else if (options.sync) fail(options.sync)
    else {
      if (log.forced && options.rotate) writeFileSync(file('revision'), options.rotate)
      ok({ object: 'message', title: 'Syncing complete.' })
    }
    break
  case 'get':
    if (options.auth === 'get') fail('Invalid session key.')
    else if (!log.correctItem || options.missing) fail('Not found.')
    else ok(item())
    break
  case 'list':
    if (options.auth === 'list') fail('Invalid session key.')
    else ok({ object: 'list', data: options.many ? Array.from({ length: 55 }, item) : [item()] })
    break
  default: process.exitCode = 1
}
if ((!sessionCommand && log.session !== null) || !log.safeArgs || !log.scrubbed || !log.noninteractive) process.exitCode = 1
