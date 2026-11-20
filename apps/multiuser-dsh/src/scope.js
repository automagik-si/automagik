import { AsyncLocalStorage } from 'node:async_hooks'

export function createScope() {
  const scope = new AsyncLocalStorage()
  return { run: (principal, fn) => scope.run(principal, fn), current: () => scope.getStore() }
}
