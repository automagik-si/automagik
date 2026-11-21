import Schema from '@deepseek-ai/schemastery'
import { createVault } from './src/bw/adapter.js'
import { createOnePassword } from './src/onepassword/adapter.js'
import { cloudProfile, createHashicorpVault } from './src/hashicorp-vault/adapter.js'
import { endpointOf, provider as hashicorp, validMount, validToken } from './src/hashicorp-vault/parse.js'
import { createSecretService } from './src/secret-service/adapter.js'
import { provider as secretService } from './src/secret-service/parse.js'
import { cloudProfile as protonCloud, createProtonPass } from './src/proton-pass/adapter.js'
import { protonPass, validConnection as validProtonConnection, validToken as validProtonToken } from './src/proton-pass/parse.js'
import { checkSetToken, createBitwardenSecrets } from './src/bws/adapter.js'
import { keychainIdentity } from './src/keychain/index.js'
import { createMacosKeychain } from './src/macos-keychain/adapter.js'
import { provider as macosKeychain } from './src/macos-keychain/parse.js'

const secretsManager = 'bitwarden-secrets'

export const name = 'vault-dsh'
export const Config = Schema.object({
  idleLockMinutes: Schema.number().min(1).max(480).default(5)
    .description('Minutes after unlocking or reading a field before the vault locks.'),
})

export function apply(ctx, config = {}, { keychain } = {}) {
  const adapters = new Map([
    ['bitwarden', createVault(config)],
    ['onepassword', createOnePassword(config)],
    [hashicorp, createHashicorpVault(config)],
    [secretService, createSecretService(config)],
    [protonPass, createProtonPass(config)],
    [secretsManager, createBitwardenSecrets(config, { identity: keychainIdentity(ctx), keychain })],
    [macosKeychain, createMacosKeychain(config)],
  ])
  let selection = Object.freeze({ provider: 'bitwarden', generation: 0 })
  let generation = 0
  let secretServiceRevision = 0
  let managerLockRevision = 0
  let retiring
  let disposed = false
  const refused = () => ({ ok: false, code: 'refused' })
  async function enter(provider, options, operation) {
    const adapter = adapters.get(provider)
    if (adapter === undefined || disposed) return refused()
    if (provider === secretService || provider === macosKeychain) {
      const code = adapter.availability()
      if (code !== undefined) return { ok: false, code }
    }
    if (provider === protonPass) {
      if (protonCloud()) return { ok: false, code: 'cloud' }
      if (!validProtonToken(options.token) || !validProtonConnection(options.connection)) return refused()
    }
    if (options.signal?.aborted) return { ok: false, code: 'locked' }
    if (provider === macosKeychain && !adapter.validUnlock(options)) return refused()
    if (provider === hashicorp) {
      if (cloudProfile()) return { ok: false, code: 'cloud' }
      if (!validToken(options.token) || !endpointOf(options.address, options.namespace)
        || (options.mount !== undefined && !validMount(options.mount))) return refused()
    }
    if (provider === secretsManager) {
      const code = adapter.availability()
      if (code !== undefined) return { ok: false, code }
    }
    const revision = secretServiceRevision
    const managerRevision = managerLockRevision
    const switching = provider !== selection.provider
    const binding = provider === macosKeychain ? adapter.binding : undefined
    const current = switching || retiring !== undefined ? ++generation : generation
    if (switching) {
      retiring ??= adapters.get(selection.provider).retire().catch(() => false).finally(() => { retiring = undefined })
    }
    const retired = await retiring
    if (disposed || current !== generation || options.signal?.aborted
      || (provider === secretService && revision !== secretServiceRevision)
      || (provider === secretsManager && managerRevision !== managerLockRevision)
      || (provider === macosKeychain && binding !== adapter.binding)) return { ok: false, code: 'locked' }
    if (switching) {
      if (retired !== true) return { ok: false, code: 'unavailable' }
      selection = Object.freeze({ provider, generation: current })
    }
    return adapter[operation](options)
  }
  const service = {
    version: 1,
    status({ provider = 'bitwarden' } = {}) {
      const adapter = adapters.get(provider)
      if (adapter === undefined) throw new Error('The vault did not answer.')
      return adapter.status()
    },
    unlock({ provider = 'bitwarden', ...options } = {}) {
      return enter(provider, options, 'unlock')
    },
    async lock({ provider } = {}) {
      if (provider === secretService) secretServiceRevision++
      else if (provider === secretsManager) managerLockRevision++
      // The Keychain gate invalidates its own queued entry synchronously on retire.
      else if (provider !== macosKeychain) generation++
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
  Object.defineProperty(service, 'checkSetToken', { value: checkSetToken })
  Object.defineProperties(service, {
    activationId: { value: ({ provider } = {}) =>
      provider === secretsManager ? adapters.get(provider).activationId : undefined },
    checkAvailability: { value: ({ provider } = {}) =>
      provider === secretsManager ? adapters.get(provider).availability() : undefined },
  })
  Object.defineProperty(service, 'setToken', { value: ({ provider, ...options } = {}) => {
    if (provider !== secretsManager || !checkSetToken(options)) return refused()
    return enter(provider, options, 'setToken')
  } })
  Object.defineProperty(service, 'clearToken', { value: ({ provider, connection } = {}) => {
    if (provider !== secretsManager || disposed) return refused()
    managerLockRevision++
    return adapters.get(provider).clearToken({ connection })
  } })
  // Publish the selection only after the old adapter has been retired.
  Object.defineProperty(service, 'providerSelection', { get: () => selection })
  Object.defineProperty(service, 'activeConnection', { value: () => {
    const { provider } = selection
    const connection = adapters.get(provider).connection
    return connection === undefined ? undefined : { provider, connection }
  } })
  Object.defineProperties(service, {
    connectionFor: { value: ({ provider, address, namespace }) =>
      provider === hashicorp ? endpointOf(address, namespace)?.connection : undefined },
    providerBinding: { value: provider =>
      provider === secretService || provider === macosKeychain ? adapters.get(provider).binding : undefined },
    resolveHandle: { value: ({ provider, ...options }) => adapters.get(provider)?.resolveHandle?.(options) ?? refused() },
    itemDetail: { value: ({ provider, ...options }) => adapters.get(provider)?.detail?.(options) ?? refused() },
    sessionOf: { value: ({ provider } = {}) => provider === protonPass ? adapters.get(provider).session : undefined },
    listFields: { value: ({ provider, ...options }) => adapters.get(provider)?.listFields?.(options) ?? refused() },
  })
  ctx.provide('secretSources', service)
  ctx.effect(() => service.prepareQuit)
}
