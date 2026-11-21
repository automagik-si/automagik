import { symbols } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'

const trusted = new WeakSet()

// DSH 0.2.2-rc.2 keeps the exact registration in the registry layer, separately
// from the definition. Capture it at the trusted call site, before a caller
// can reuse the definition with its own activation condition.
export function attestToolRegistration(tools, definition) {
  const scope = scopeOf(tools.ctx)
  const layer = scope === undefined ? tools.layers?.global : tools.layers?.peek?.(scope)
  const registration = layer?.tools?.get?.(definition.name)
  if (registration?.definition === definition) trusted.add(registration)
}

export function registerTrustedTool(tools, definition, options) {
  const dispose = tools.register(definition, options)
  if (tools[symbols.original] !== undefined) attestToolRegistration(tools, definition)
  return dispose
}

export const isTrustedToolRegistration = registration => trusted.has(registration)
