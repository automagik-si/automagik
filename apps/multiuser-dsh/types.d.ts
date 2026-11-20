import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-typert-protocol'

export interface AutomagikPrincipal {
  readonly kind: 'automagik'
  readonly instance: string
  readonly person: {
    readonly issuer: string
    readonly subject: string
    readonly roles: readonly ('owner' | 'admin' | 'member' | 'guest')[]
    readonly workspace: string
  }
  readonly bot?: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    automagik: AutomagikPrincipal
  }
}

export interface Config {
  maxRequestBodyBytes: number
}

export const name: 'multiuser-dsh'
export const Config: Schema<Partial<Config>, Config>
export function apply(ctx: Context, config: Config): void
