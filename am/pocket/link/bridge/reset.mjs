// Change the desktop key without touching the login service. No iroh here, so the tests can use fakes.
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ask, bridgeState, fits, store, withLock, BUSY_RETRIES, BUSY_WAIT, FILE, PING_TIMEOUT, SOCKET, TIMEOUT } from './devices.mjs'
import { KEY } from './state.mjs'
import { discardGrant } from './pairing.mjs'

const TURN_OFF = "This bridge can't change its key while it runs. Turn off Pocket Link, then press Reset key again."
const NO_ANSWER = 'The bridge did not answer, so the key may not have changed. Press Reset key again.'
const NOT_ADOPTED = 'Every phone was unpaired and the key changed, but a bridge that started meanwhile did not take the new key. Turn off Pocket Link and Turn on.'

export function wipe({ dir, generate }) {
  return withLock(dir, () => {
    const bytes = Buffer.from(generate())
    if (bytes.length !== 32) throw new Error('The new key must be 32 bytes.')
    for (const name of readdirSync(dir)) {
      if (/^secret\.key\..+\.tmp$/.test(name)) rmSync(join(dir, name), { force: true })
    }
    const key = join(dir, KEY)
    const tmp = `${key}.${process.pid}.tmp`
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    // If interrupted here, the old key remains with fewer ways to pair or connect to it.
    discardGrant(dir)
    rmSync(join(dir, 'pairing.json'), { force: true })
    const unpaired = store(join(dir, FILE)).clear()
    renameSync(tmp, key)
    const folder = openSync(dir, 'r')
    try { fsyncSync(folder) } finally { closeSync(folder) }
    return { unpaired }
  })
}

export async function resetKey({ dir, generate, owner, alive, started, command, timeout = TIMEOUT, retries = BUSY_RETRIES, wait = BUSY_WAIT, between, write = fn => fn() }) {
  const socket = join(dir, SOCKET)
  const state = () => bridgeState({ dir, alive, started, command, timeout: Math.min(timeout, PING_TIMEOUT) })
  if ((await state()).running) {
    for (let i = 0; ; i++) {
      if (!fits(socket) || !existsSync(socket)) throw new Error(TURN_OFF)
      let answer
      try { answer = await ask(socket, { reset: true, owner }, { timeout }) } catch { throw new Error(NO_ANSWER) }
      if (answer?.ok) return { ok: true, via: 'bridge', unpaired: answer.unpaired, id: answer.id }
      if (answer) throw new Error(answer.error === 'unknown request' ? TURN_OFF : answer.error)
      if (i >= retries) throw new Error(NO_ANSWER)
      await delay(wait)
    }
  }

  const { unpaired } = await write(() => wipe({ dir, generate }))
  await between?.()
  if ((await state()).running) {
    const answer = await ask(socket, { adopt: true, owner }, { timeout }).catch(() => null)
    if (!answer?.ok) throw new Error(NOT_ADOPTED)
  }
  return { ok: true, via: 'file', unpaired }
}

/** The endpoint and the exact key used to bind it. A failed bind leaves the next check to retry. */
export function keeper({ read, bind, swapped, log = () => {} }) {
  let ep, bound, pending
  let rotating = false
  let chain = Promise.resolve()
  const enqueue = (fn) => {
    const next = chain.then(fn)
    chain = next.catch(() => {})
    return next
  }
  const rebind = async () => {
    const bytes = Buffer.from(await read())
    if (bound?.equals(bytes)) { rotating = false; return ep }
    const old = ep
    rotating = Boolean(old)
    ep = await bind(bytes)
    bound = bytes
    rotating = false
    if (old) {
      try { await swapped(ep, old) } finally {
        try { await old.close() } catch (e) { log('close old endpoint:', e.message) }
      }
    }
    return ep
  }
  const ensure = () => {
    if (pending) return pending
    const next = enqueue(rebind)
    pending = next
    const done = () => { if (pending === next) pending = null }
    next.then(done, done)
    return next
  }
  return {
    start: () => enqueue(() => ep ?? rebind()),
    current: () => ep,
    get rotating() { return rotating },
    ensure,
    rotate(fn) {
      // A check requested after this rotation has to run after it.
      pending = null
      return enqueue(async () => {
        rotating = true
        const result = await fn()
        await rebind()
        return result
      })
    },
    async accept() {
      // Waiting for a connection must leave the rotation chain free to close this endpoint.
      for (;;) {
        const from = ep
        const incoming = await from.acceptNext()
        if (incoming || from === ep) return incoming
      }
    },
  }
}
