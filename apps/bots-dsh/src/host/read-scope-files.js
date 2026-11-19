import { apply as upstream, Config, inject } from '@deepseek-ai/dsh-tool-fs'
import toolPackage from '@deepseek-ai/dsh-tool-fs/package.json' with { type: 'json' }
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import localPackage from '@deepseek-ai/dsh-fs-local/package.json' with { type: 'json' }
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import sandboxPackage from '@deepseek-ai/dsh-fs-sandbox/package.json' with { type: 'json' }
import { registerLocalReadTools } from './read-scope-provider.js'

export { Config, inject }
export const name = 'automagik-read-scope-files'
export function apply(ctx, config) {
  return registerLocalReadTools(ctx, config, upstream, {
    service: 'fs',
    prototypes: [LocalFileSystem.prototype, SandboxedFileSystem.prototype],
    verified: [toolPackage, localPackage, sandboxPackage].every(pkg => pkg.version === '0.2.2-rc.2'),
  })
}
