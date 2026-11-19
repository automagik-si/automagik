import { apply as upstream, Config, inject } from '@deepseek-ai/dsh-tool-fs-search'
import toolPackage from '@deepseek-ai/dsh-tool-fs-search/package.json' with { type: 'json' }
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import subprocessPackage from '@deepseek-ai/dsh-subprocess-local/package.json' with { type: 'json' }
import ripgrepPackage from '@deepseek-ai/dsh-util-ripgrep/package.json' with { type: 'json' }
import { registerLocalReadTools } from './read-scope-provider.js'

export { Config, inject }
export const name = 'automagik-read-scope-search'
export function apply(ctx, config) {
  return registerLocalReadTools(ctx, config, upstream, {
    service: 'subprocess',
    prototypes: [LocalSubprocessRuntime.prototype],
    verified: [toolPackage, subprocessPackage, ripgrepPackage].every(pkg => pkg.version === '0.2.2-rc.2'),
  })
}
