import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export const digest = text => createHash('sha256').update(text).digest('hex')

export function fakeSecurity(path) {
  const calls = []
  let value = randomBytes(24).toString('hex')
  let mode = 'ok'
  let intercept
  const header = () => 'keychain: "' + path + '"\n'
  const result = (read) => {
    const stdout = header() + 'attributes:\n'
    if (mode === 'missing') return { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: item absent\n' }
    if (mode === 'denial') return { code: 36, stdout, stderr: 'security: interaction denied\n' }
    if (mode === 'locked' && read) return { code: 36, stdout, stderr: 'security: locked fixture\n' }
    const stderr = read ? 'password: "' + value + '"\n' : ''
    return { code: 0, stdout: mode === 'wrong-header' ? 'keychain: "other"\n' + stdout : stdout, stderr }
  }
  const run = (args, limits) => {
    const read = args[5] === '-g'
    calls.push({ operation: read ? 'read' : 'metadata', shape: [args[0], args[1], args[3], args.length, args.at(-2) === args.at(-1)],
      bound: args.at(-1) === path, service: digest(args[2]), account: digest(args[4]), timeout: limits.timeout })
    return Promise.resolve(intercept === undefined ? result(read) : intercept(limits, () => result(read)))
  }
  return { calls, run, value: () => value, rotate: () => { value = randomBytes(24).toString('hex') },
    setMode: next => { mode = next }, intercept: next => { intercept = next } }
}

export function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal) { queueMicrotask(() => child.emit('close', null, signal)) } })
  return child
}
