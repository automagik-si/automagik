import Schema from '@deepseek-ai/schemastery'
import { createVault } from './src/bw/adapter.js'
import { createOnePassword } from './src/onepassword/adapter.js'

export const name = 'vault-dsh'
export const Config = Schema.object({
  idleLockMinutes: Schema.number().min(1).max(480).default(5)
    .description('Minutes after unlocking or reading a field before the vault locks.'),
})

export function apply(ctx, config = {}) {
  const adapters = new Map([['bitwarden', createVault(config)], ['onepassword', createOnePassword(config)]])
  let selection = Object.freeze({ provider: 'bitwarden', generation: 0 })
  let generation = 0
  let retiring
  let disposed = false
  const refused = () => ({ ok: false, code: 'refused' })
  const service = {
    version: 1,
    status({ provider = 'bitwarden' } = {}) {
      const adapter = adapters.get(provider)
      if (adapter === undefined) throw new Error('The vault did not answer.')
      return adapter.status()
    },
    async unlock({ provider = 'bitwarden', ...options } = {}) {
      const adapter = adapters.get(provider)
      if (adapter === undefined || disposed) return refused()
      if (options.signal?.aborted) return { ok: false, code: 'locked' }
      const switching = provider !== selection.provider
      const current = switching || retiring !== undefined ? ++generation : generation
      if (switching) {
        retiring ??= adapters.get(selection.provider).retire().catch(() => false).finally(() => { retiring = undefined })
      }
      const retired = await retiring
      if (disposed || current !== generation || options.signal?.aborted) return { ok: false, code: 'locked' }
      if (switching) {
        if (retired !== true) return { ok: false, code: 'unavailable' }
        selection = Object.freeze({ provider, generation: current })
      }
      return adapter.unlock(options)
    },
    async lock({ provider } = {}) {
      generation++
      if (provider !== undefined && !adapters.has(provider)) return false
      const targets = provider === undefined ? [...adapters.values()] : [adapters.get(provider)]
      const results = await Promise.allSettled(targets.map(adapter => adapter.retire()))
      return results.every(result => result.status === 'fulfilled' && result.value === true)
    },
    read(ref, options) {
      return adapters.get(ref?.provider)?.read(ref, options) ?? refused()
    },
    listItems({ provider = 'bitwarden', ...options } = {}) {
      return adapters.get(provider)?.listItems(options) ?? refused()
    },
    async prepareQuit() {
      disposed = true
      const results = await Promise.all([...adapters.values()].map(adapter => adapter.prepareQuit()))
      return { ok: results.every(result => result.ok) }
    },
  }
  // Capability metadata is discovered directly. Keep the enumerable v1 method surface.
  Object.defineProperty(service, 'providers', { value: Object.freeze([...adapters.keys()]) })
  // Publish the selection only after the old adapter has been retired.
  Object.defineProperty(service, 'providerSelection', { get: () => selection })
  Object.defineProperty(service, 'activeConnection', { value: () => {
    const { provider } = selection
    const connection = adapters.get(provider).connection
    return connection === undefined ? undefined : { provider, connection }
  } })
  ctx.provide('secretSources', service)
  ctx.effect(() => service.prepareQuit)
}
