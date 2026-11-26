import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createSecretService } from '../src/secret-service/adapter.js'
import { bus, busPath, connectBus, parseAddress } from '../src/secret-service/dbus.js'
import { itemParts } from '../src/secret-service/parse.js'

const dbusDaemon = '/usr/bin/dbus-daemon'
const gnomeDaemonBin = '/usr/bin/gnome-keyring-daemon'
const python = '/usr/bin/python3'
const provider = 'secret-service'
const service = 'org.freedesktop.secrets'
const root = '/org/freedesktop/secrets'
const login = root + '/collection/login'

// Fixture writes and observations use python-dbus and libsecret on the verified
// isolated bus. Input is piped so canaries never enter argv, env or failure output.
const fixture = String.raw`
import json, os, sys
import dbus
import gi
gi.require_version('Secret', '1')
from gi.repository import Gio, Secret

data = json.load(sys.stdin)
address = os.environ['DBUS_SESSION_BUS_ADDRESS']
connection = dbus.bus.BusConnection(address)
bus = dbus.Interface(connection.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus', introspect=False), 'org.freedesktop.DBus')
bus_id = str(bus.GetId())
if data['action'] == 'bus':
    print(bus_id)
    sys.exit(0)

assert bus_id == data['busId']
assert Gio.bus_get_sync(Gio.BusType.SESSION).call_sync(
    'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
    'GetId', None, None, Gio.DBusCallFlags.NO_AUTO_START, 2000, None
).unpack() == (bus_id,)
owner = bus.GetNameOwner('org.freedesktop.secrets')
assert bus.GetConnectionUnixProcessID(owner) == data['pid']
login = '/org/freedesktop/secrets/collection/login'
props = dbus.Interface(connection.get_object(owner, login, introspect=False), 'org.freedesktop.DBus.Properties')
assert not props.Get('org.freedesktop.Secret.Collection', 'Locked')
if data['action'] == 'ready':
    sys.exit(0)

if data['action'] == 'lock':
    obj = connection.get_object(owner, '/org/freedesktop/secrets', introspect=False)
    locked, prompt = dbus.Interface(obj, 'org.freedesktop.Secret.Service').Lock(dbus.Array([login], signature='o'))
    assert login in locked and prompt == '/'
    assert props.Get('org.freedesktop.Secret.Collection', 'Locked')
else:
    schema = Secret.Schema.new('ai.namastex.AutomagikFixture', Secret.SchemaFlags.NONE, {'fixture': Secret.SchemaAttributeType.STRING})
    attrs = {'fixture': data['attribute']}
    if data['action'] == 'store':
        assert Secret.password_store_sync(schema, attrs, login, data['label'], data['value'], None)
        # Rename the collection inside the disposable keyring. Its canonical path stays login.
        props.Set('org.freedesktop.Secret.Collection', 'Label', dbus.String(data['collection'], variant_level=1))
    elif data['action'] == 'delete':
        assert Secret.password_clear_sync(schema, attrs, None)
    else:
        raise AssertionError()
`

async function privateBus(children, scratch, env, name) {
  const path = join(scratch, name)
  const config = path + '.conf'
  await writeFile(config, `<busconfig>
    <type>session</type>
    <listen>unix:path=${path}</listen>
    <auth>EXTERNAL</auth>
    <servicedir>${join(scratch, 'services')}</servicedir>
    <policy context="default">
      <allow send_destination="*"/>
      <allow receive_sender="*"/>
      <allow own="*"/>
    </policy>
  </busconfig>`)
  const daemon = spawn(dbusDaemon, ['--nofork', '--print-address=1', '--config-file=' + config], {
    cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(daemon)
  daemon.on('error', () => {})
  const ended = new Promise(resolve => daemon.once('close', resolve))
  let socketDenied = false
  daemon.stderr.on('data', data => {
    if (/permission denied|operation not permitted/i.test(data.toString())) socketDenied = true
  })
  let output = ''
  const start = AbortSignal.timeout(3000)
  const onTimeout = () => { void stop(daemon) }
  start.addEventListener('abort', onTimeout, { once: true })
  try {
    for await (const bytes of daemon.stdout.iterator({ destroyOnReturn: false })) {
      output += bytes.toString()
      if (output.includes('\n') || output.length > 4096) break
    }
  } finally { start.removeEventListener('abort', onTimeout) }
  const address = output.trim()
  if (address === '') await ended
  assert.ok(address, socketDenied ? 'sandbox denied the isolated bus socket' : 'private dbus-daemon printed no address')
  assert.equal(parseAddress(address).path === path && parseAddress(address).guid !== undefined, true, 'isolated bus did not print its scratch address')
  const scope = { ...env, DBUS_SESSION_BUS_ADDRESS: address }
  const independently = pythonCall(scope, { action: 'bus' })
  assert.equal(independently.status, 0, 'independent private bus probe failed')
  const busId = independently.stdout.trim()
  assert.match(busId, /^[a-f0-9]{32}$/)
  const client = await connectBus(address, { signal: AbortSignal.timeout(3000), env: scope })
  try {
    assert.equal(client.guid, parseAddress(address).guid)
    assert.deepEqual(await client.call(bus, busPath, bus, 'GetId', '', [], 's'), [busId])
  } finally {
    await client.close()
  }
  return { env: scope, busId }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}

function pythonCall(env, input) {
  return spawnSync(python, ['-I', '-B', '-c', fixture], {
    env, input: JSON.stringify(input), encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'],
  })
}

test('private GNOME Keyring: independent create, encrypted read, rotation, deletion, OS lock and no activation', {
  skip: process.env.VAULT_SS_REAL === undefined, timeout: 30000,
}, async t => {
  for (const binary of [dbusDaemon, gnomeDaemonBin, python]) {
    await access(binary, constants.X_OK).catch(() => assert.fail('Required test binary is missing: ' + binary))
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ss-'))
  const children = []
  const adapters = []
  t.after(async () => {
    for (const adapter of adapters) await adapter.prepareQuit()
    for (const child of children.reverse()) await stop(child)
    try {
      assert.equal(await access(join(scratch, 'activation-count')).then(() => true, () => false), false,
        'the unowned service was never activated')
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
  const env = {
    PATH: '/usr/bin:/bin', HOME: scratch, LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: join(scratch, 'runtime'), XDG_DATA_HOME: join(scratch, 'data'),
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
    DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=' + join(scratch, 'no-system-bus'),
  }
  for (const path of [env.XDG_RUNTIME_DIR, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, join(scratch, 'services')]) {
    await mkdir(path, { mode: 0o700 })
  }
  const activated = join(scratch, 'activation-count')
  const standIn = join(scratch, 'activate.sh')
  await writeFile(standIn, '#!/bin/sh\nprintf 1 >> "' + activated + '"\n')
  await chmod(standIn, 0o700)
  await writeFile(join(scratch, 'services', service + '.service'), '[D-BUS Service]\nName=' + service + '\nExec=' + standIn + '\n')

  const isolated = await privateBus(children, scratch, env, 'session')
  const empty = await privateBus(children, scratch, env, 'empty')
  const unavailable = createSecretService({}, { env: empty.env })
  adapters.push(unavailable)
  assert.deepEqual(await unavailable.unlock(), { ok: false, code: 'unavailable' })

  const control = join(env.XDG_RUNTIME_DIR, 'keyring')
  await mkdir(control, { mode: 0o700 })
  const daemon = spawn(gnomeDaemonBin, [
    '--foreground', '--components=secrets', '--unlock', '--control-directory=' + control,
  ], { env: isolated.env, cwd: scratch, stdio: ['pipe', 'ignore', 'ignore'] })
  children.push(daemon)
  daemon.on('error', () => {})
  daemon.stdin.on('error', () => {})
  daemon.stdin.end(randomBytes(24).toString('hex'))
  const call = (action, options = {}) => pythonCall(isolated.env, { action, busId: isolated.busId, pid: daemon.pid, ...options })
  let ready = false
  for (let i = 0; i < 50 && daemon.exitCode === null; i++) {
    if (call('ready').status === 0) { ready = true; break }
    await delay(100)
  }
  assert.equal(ready, true, 'expected private owner and unlocked canonical login collection')
  const label = 'item-' + randomBytes(16).toString('hex')
  const collection = 'collection-' + randomBytes(16).toString('hex')
  const attribute = 'attribute-' + randomBytes(16).toString('hex')
  const initial = 'value-' + randomBytes(16).toString('hex')
  const rotated = 'value-' + randomBytes(16).toString('hex')
  const store = value => assert.equal(call('store', { label, collection, attribute, value }).status, 0, 'independent fixture store failed')
  store(initial)

  const adapter = createSecretService({}, { env: isolated.env })
  adapters.push(adapter)
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const picker = await adapter.listItems()
  assert.equal(picker.ok && picker.items.length === 1, true)
  const [row] = picker.items
  assert.equal(row.name === label && row.collection === collection, true, 'the expected item is shown in its collection')
  const mapped = await adapter.resolveHandle({ handle: row.handle })
  assert.equal(mapped.ok && itemParts(mapped.item)?.[0].startsWith(login + '/'), true)
  const ref = { provider, item: mapped.item, field: 'secret' }
  assert.equal((await adapter.read(ref)).value === initial, true, 'encrypted read does not match the stored value')
  store(rotated)
  assert.equal((await adapter.read(ref)).value === rotated, true, 'rotation did not retain the mapping')
  assert.equal(call('delete', { attribute }).status, 0, 'independent fixture removal failed')
  assert.deepEqual(await adapter.read(ref), { ok: false, code: 'revoked' })
  store(initial)
  const next = (await adapter.listItems()).items[0]
  ref.item = (await adapter.resolveHandle({ handle: next.handle })).item
  assert.equal(call('lock').status, 0, 'independent fixture lock did not lock the intended collection')
  assert.deepEqual(adapter.status(), { state: 'unlocked' })
  const locked = await adapter.listItems()
  assert.equal(JSON.stringify(locked) === JSON.stringify({ ok: true, items: [{ collection, locked: true }] }), true)
  assert.deepEqual(await adapter.read(ref), { ok: false, code: 'locked' })
})
