// These adapters own the tool registration in the shipped profiles. A name, a
// tool schema, or a provider visible from the calling Agent cannot attest the
// services captured by another plugin's tool body.
import { AsyncLocalStorage } from 'node:async_hooks'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { READ_SCOPE_CODE } from '../shared/read-scope.js'
import { PROVIDER_REFUSAL, READ_PATH, scopedArguments } from './read-scope-policy.js'

const providers = new WeakMap()
const admissions = new WeakMap()

export const scopedProviderOf = definition => providers.get(definition)?.()
export const admitScopedRead = (exec, folder, definition) => admissions.set(exec.token, { folder, definition })

const refuse = reason => new HarnessError(reason, READ_SCOPE_CODE)

export function checkReadDispatch(exec, definition) {
  const admission = admissions.get(exec.token)
  if (admission !== undefined && (admission.definition !== definition || scopedProviderOf(definition) === undefined)) {
    throw refuse(PROVIDER_REFUSAL)
  }
}

// DSH reads after awaiting the working directory, and search awaits its binary.
// Check again at the provider boundary and hand the vetted provider the
// canonical path. The OS still resolves names when it opens files.
function scopedProvider(provider, service, folder, name) {
  const pathKey = READ_PATH[name]
  const checkedPath = path => {
    const checked = scopedArguments(folder, name, { [pathKey]: path })
    if (checked.reason !== undefined) throw refuse(checked.reason)
    return checked.args[pathKey]
  }
  const overrides = service === 'subprocess' ? {
    spawn(spec) {
      if (spec.argv.at(-2) !== '--') throw refuse(PROVIDER_REFUSAL)
      const path = checkedPath(spec.argv.at(-1))
      return provider.spawn({
        ...spec,
        argv: [...spec.argv.slice(0, -2), '--no-follow', '--no-ignore', '--', path],
      })
    },
  } : {
    async resolve(path, options) {
      const canonical = checkedPath(path)
      const target = await provider.resolve(canonical, options)
      if (provider.processPath(target) !== canonical) throw refuse(PROVIDER_REFUSAL)
      return target
    },
  }
  return new Proxy(provider, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key]
      const method = target[key]
      if (service === 'fs' && ['readText', 'streamText', 'readBytes'].includes(key)) {
        return (resolved, ...args) => {
          const path = target.processPath(resolved)
          if (checkedPath(path) !== path) throw refuse(PROVIDER_REFUSAL)
          return Reflect.apply(method, target, [resolved, ...args])
        }
      }
      return typeof method === 'function' ? method.bind(target) : method
    },
  })
}

export function registerLocalReadTools(ctx, config, apply, { service, prototypes, verified }) {
  const activeProvider = new AsyncLocalStorage()
  const adapt = target => new Proxy(target, {
    get(target, key) {
      if (key === service) return activeProvider.getStore() ?? target[service]
      if (key === 'inject') return (deps, fn) => target.inject(deps, child => fn(adapt(child)))
      if (key !== 'tools') return Reflect.get(target, key, target)
      return {
        get: (...args) => target.tools.get(...args),
        register(definition, options) {
          if (!Object.hasOwn(READ_PATH, definition.name)) return target.tools.register(definition, options)
          const providerOf = () => {
            const provider = target[service]
            return verified && provider && prototypes.includes(Object.getPrototypeOf(provider)) ? provider : undefined
          }
          const wrapped = {
            ...definition,
            execute(args, exec) {
              const admission = admissions.get(exec.token)
              if (admission === undefined) return definition.execute(args, exec)
              if (admission.definition !== wrapped) throw refuse(PROVIDER_REFUSAL)
              const { folder } = admission
              const provider = providerOf()
              const checked = provider === undefined ? { reason: PROVIDER_REFUSAL } : scopedArguments(folder, definition.name, args)
              if (checked.reason !== undefined) throw refuse(checked.reason)
              const scoped = scopedProvider(provider, service, folder, definition.name)
              return activeProvider.run(scoped, () => definition.execute(checked.args, exec))
            },
          }
          providers.set(wrapped, providerOf)
          return target.tools.register(wrapped, options)
        },
      }
    },
  })
  return apply(adapt(ctx), config)
}
