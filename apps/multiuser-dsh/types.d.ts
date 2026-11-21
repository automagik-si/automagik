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

export type CallerRole = 'owner' | 'member' | 'guest'

export interface BotFact {
  readonly id: string
  readonly main: boolean
  readonly people: {
    readonly mode: 'owners' | 'allowlist' | 'workspace'
    readonly allow: readonly { readonly issuer: string; readonly subject: string }[]
  }
}

export interface AutomagikCallerRoutes {
  readonly version: 1
  match(path: string, method: string):
    ((request: Request, principal: AutomagikPrincipal, peer: unknown) => Promise<Response>) | undefined
}

export interface AutomagikCaller {
  readonly version: 2
  readonly multiuser: boolean
  current(): AutomagikPrincipal | undefined
  verify?(request: Request):
    { principal: AutomagikPrincipal['person']; session: string } | undefined
  decide?(session: string, signal?: AbortSignal): Promise<
    { active: false }
    | { active: true; person: string; roles: AutomagikPrincipal['person']['roles'];
        resolved: boolean }
    | undefined
  >
  roleOf(principal: unknown): CallerRole | undefined
  visibleBotIds(principal: unknown): ReadonlySet<string>
  provide(provider: { bots(): Iterable<BotFact> }): () => void
  invalidate(principal?: AutomagikPrincipal): void
  seen(): readonly Readonly<Pick<AutomagikPrincipal['person'], 'issuer' | 'subject' | 'roles'> & { lastSeen: number }>[]
}
