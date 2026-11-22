// SPDX-License-Identifier: Apache-2.0
// Preserve launch options across an update. Skip one-shot links and the already saved
// preload, and keep only the first --no-sandbox so the wrappers cannot accumulate copies.
import { isAppLink } from './deeplink.js'
import { PRELOADS } from './dsh.js'

export function relaunchArgs(argv) {
  if (!Array.isArray(argv)) return []
  const args = argv.slice(1)
  const kept = []
  let noSandbox = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (typeof arg !== 'string' || isAppLink(arg) || arg.startsWith('--preload=')) continue
    if (arg === '--preload') {
      const value = args[i + 1]
      if (typeof value === 'string' && PRELOADS.includes(value.trim().toLowerCase())) i++
      continue
    }
    if (arg === '--no-sandbox') {
      if (noSandbox) continue
      noSandbox = true
    }
    kept.push(arg)
  }
  return kept
}
