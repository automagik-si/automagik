// Standalone fixture. CI stages this beside the Bot plugin's src/ and the ACP evidence module.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { userInfo } from 'node:os'
import { createMachineRecord } from './src/host/machine-reservations.js'
import { createReservationCheck } from './src/host/reservation-check.js'
import { reservationDigests } from '../acp/src/host/reservation-evidence.js'

const [, , op, json, ...extra] = process.argv
if (!op || !json || extra.length) process.exit(2)
const input = JSON.parse(json)
process.umask(0o077)
const random = (size, encoding) => randomBytes(size).toString(encoding)
const sleep = new Int32Array(new SharedArrayBuffer(4))
const machine = createMachineRecord({
  fs, dir: () => input.dir, platform: process.platform, uid: () => process.getuid(),
  pid: process.pid, random, now: Date.now, wait: ms => Atomics.wait(sleep, 0, 0, ms),
  userName: uid => uid === process.getuid() ? userInfo().username
    : fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':'))
      .find(([, , id]) => id === String(uid))?.[0] ?? `uid ${uid}`,
})
const ready = machine.open()
const print = value => console.log(JSON.stringify(value))
if (op === 'probe' || ready.state !== 'ready') {
  print({ state: ready.state })
  process.exit(ready.state === 'ready' ? 0 : 1)
}
const vendor = input.vendor ?? 'claude'
const identity = {
  vendor, email: input.other ? 'other@example.test' : 'two-users@example.test', person: true,
  ...(vendor === 'codex' ? { class: 'workspace' } : { org: 'fixture-org' }),
}
const digests = reservationDigests(identity, ready.key)
const name = `${vendor}-${digests.exact}.json`
const path = `${ready.dir}/${name}`
const claim = { vendor, instance: input.instance, ...digests }
switch (op) {
  case 'reserve':
    print({ ...machine.reserve(ready, {
      ...claim, label: input.label, ...(identity.class ? { class: identity.class } : {}),
    }), name })
    break
  case 'read': {
    const result = machine.readExact(ready, vendor, digests.exact)
    const { state, record, owner, uid } = result
    print({ state, label: record?.label, owner, uid })
    break
  }
  case 'make-shared':
    print(machine.makeShared(ready, {
      ...claim, expect: machine.readExact(ready, vendor, digests.exact),
    }))
    break
  case 'check': {
    const id = `acp-${vendor}`
    const signOuts = []
    let signedIn = true
    const service = {
      reservationEvidence: 2,
      authScope: 'isolated',
      async accountEvidence(provider, { key, keys }) {
        return signedIn && provider === id ? {
          id, authScope: 'isolated', signedIn, vendor, ref: 'two-users-ref', outcome: 'complete',
          reservable: true, ...reservationDigests(identity, key),
          ...(keys ? { digests: keys.map(k => reservationDigests(identity, k)) } : {}),
        } : { id: provider, signedIn: false }
      },
      async accountSignOut(provider, { expect }) {
        const seen = reservationDigests(identity, expect.key)
        if (seen.exact !== expect.exact || seen.loose !== expect.loose
          || expect.recheck?.() !== true) throw Object.assign(new Error(), {
          code: 'acp-account/changed',
        })
        signOuts.push({ provider, expect: true })
        signedIn = false
      },
    }
    const check = createReservationCheck({ ctx: { get: () => service }, warn() {} }, {
      machine, instanceId: () => input.instance,
    })
    const held = await check.gate(id, 'two-users')
    await check.idle()
    await check.fresh(id, 'card')
    print({ held, status: check.status(id), signOuts })
    break
  }
  default: {
    const temp = `${ready.dir}/.test-${process.pid}-${random(8, 'hex')}`
    try {
      if (op === 'unlink') fs.unlinkSync(path)
      else if (op === 'open-write') fs.closeSync(fs.openSync(path, 'r+'))
      else if (op === 'rename-over' || op === 'link-over') {
        fs.writeFileSync(temp, 'test', { flag: 'wx' })
        if (op === 'rename-over') fs.renameSync(temp, path)
        else fs.linkSync(temp, path)
      } else process.exit(2)
      print({ ok: true })
    } catch (error) { print({ code: error.code }) } finally { fs.rmSync(temp, { force: true }) }
  }
}
