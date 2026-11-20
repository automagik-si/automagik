import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

export async function imageWith20261111Policy() {
  const target = new URL('../../src/host/image.js?image-policy-2026-11-11', import.meta.url).href
  const hook = registerHooks({
    load(url, context, next) {
      const result = next(url, context)
      if (url !== target) return result
      const source = String(result.source)
      const policy = '\nconst ALLOW_IMAGE_READ_ONLY_FALLBACK = false\n'
      assert.ok(source.includes(policy))
      return { ...result, source: source.replace(policy, '\nconst ALLOW_IMAGE_READ_ONLY_FALLBACK = true\n') }
    },
  })
  try { return await import(target) } finally { hook.deregister() }
}
