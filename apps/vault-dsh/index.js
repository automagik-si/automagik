import Schema from '@deepseek-ai/schemastery'
import { createVault } from './src/bw/adapter.js'

export const name = 'vault-dsh'
export const Config = Schema.object({
  idleLockMinutes: Schema.number().min(1).max(480).default(5)
    .description('Minutes after unlocking or reading a field before the vault locks.'),
})

export function apply(ctx, config = {}) {
  const { dispose, ...service } = createVault(config)
  ctx.provide('secretSources', service)
  ctx.effect(() => dispose)
}
