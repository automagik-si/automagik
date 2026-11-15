// Red/green runner: the exact same tests can load a saved pre-fix adapter at its normal
// URL, preserving all relative imports. Never swaps or edits working-tree source.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
const adapter = new URL('../../src/host/adapter.js', import.meta.url).href
if (process.env.ACP_UPLOAD_OLD_SOURCE) registerHooks({
  load(url, context, next) {
    if (url !== adapter) return next(url, context)
    return { format: 'module', shortCircuit: true, source: readFileSync(process.env.ACP_UPLOAD_OLD_SOURCE, 'utf8') }
  },
})
