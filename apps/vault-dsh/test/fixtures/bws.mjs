import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

export const digest = text => createHash('sha256').update(text).digest('hex')
export const fakeToken = (clientSecret = randomBytes(16).toString('base64')) =>
  '0.' + randomUUID() + '.' + clientSecret + ':' + randomBytes(16).toString('base64')
export const completed = (code = 0, stdout = '', stderr = '') => ({ code, stdout, stderr })

export function fakeSpawn(respond) {
  return (file, args, options) => {
    const child = new EventEmitter()
    child.pid = 321
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    let closed = false
    let signal
    child.kill = name => {
      signal = name
      finish()
    }
    function finish(result = completed()) {
      if (closed) return
      closed = true
      child.stdout.end(result.stdout)
      child.stderr.end(result.stderr)
      child.emit('close', result.code, signal ?? null)
    }
    async function answer(stdin) {
      let result
      try { result = await respond({ file, args, options, stdin, child }) }
      catch { result = completed(99) }
      if (result !== undefined) finish(result)
    }
    if (options.stdio[0] === 'pipe' && options.stdio !== 'ignore') {
      const chunks = []
      child.stdin = new Writable({
        write(chunk, _encoding, next) { chunks.push(chunk); next() },
        final(next) { void answer(Buffer.concat(chunks).toString('utf8')); next() },
      })
    } else queueMicrotask(() => { void answer() })
    return child
  }
}

export function memoryKeychain() {
  const entries = new Map()
  const calls = []
  const keychain = {
    available: true, calls, entries,
    async lookup(id) { calls.push(['lookup', id]); return { ok: true, blob: entries.get(id) } },
    async store(id, blob) {
      calls.push(['store', id, digest(blob)])
      entries.set(id, blob)
      return { ok: true, confirm: signal => keychain.lookup(id, signal) }
    },
    async clear(id, signal, onDispatch) {
      onDispatch?.()
      if (!(await keychain.lookup(id, signal)).blob) return { ok: false, code: 'not-saved' }
      calls.push(['clear', id])
      entries.delete(id)
      return { ok: true }
    },
  }
  return keychain
}
