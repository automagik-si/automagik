import { AsyncLocalStorage } from 'node:async_hooks'

// The store holds the verified principal and the gate session family's hash. current() stays
// the principal: bots-dsh's callerOf reads it.
export function createScope() {
  const scope = new AsyncLocalStorage()
  return {
    run: (principal, fn, { session } = {}) => scope.run({ principal, session }, fn),
    current: () => scope.getStore()?.principal,
    session: () => scope.getStore()?.session,
  }
}
