import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'

export type DecisionProviderId = string & { readonly __decisionProvider: unique symbol }
export type DecisionProtocol = 'system-one' | 'openai-decisions' | 'llm-structured'
export type DecisionPurpose = 'group-routing' | 'settings-test' | 'voice-turn-end' | 'voice-relevance' | 'approval-triage'
export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json }
export type DecisionState = string | { readonly [k: string]: Json } | readonly Json[]
export type QuestionId = string

export interface DecisionOption { readonly id: string; readonly description?: string }
interface QuestionBase { readonly id: QuestionId; readonly instructions: string }
export interface YesNoQuestion extends QuestionBase { readonly kind: 'yes-no'; readonly criteria?: { readonly yes: string; readonly no: string } }
export interface ChoiceQuestion extends QuestionBase { readonly kind: 'choice'; readonly options: readonly DecisionOption[] }        // 2..255
export interface MultiSelectQuestion extends QuestionBase { readonly kind: 'multi-select'; readonly options: readonly DecisionOption[] } // 1..64
export interface ScoreQuestion extends QuestionBase { readonly kind: 'score'; readonly levels: readonly string[] }                    // 2..10
export type DecisionQuestion = YesNoQuestion | ChoiceQuestion | MultiSelectQuestion | ScoreQuestion
export type WireQuestion = YesNoQuestion | ChoiceQuestion | ScoreQuestion

export interface DecisionRequest {
  readonly purpose: DecisionPurpose
  readonly rubricVersion: string           // `${purpose}/${n}`; bumped when instructions change
  readonly state: DecisionState
  readonly questions: readonly DecisionQuestion[]
  readonly deadlineMs: number              // 50..30_000, the whole budget including queueing and retries
  readonly signal?: AbortSignal
  readonly subject?: { readonly book: string; readonly ref: string }   // ledger link, never sent
}

export type DecisionAnswer =
  | { readonly id: QuestionId; readonly kind: 'yes-no'; readonly p: number }
  | { readonly id: QuestionId; readonly kind: 'choice'; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence?: number }
  | { readonly id: QuestionId; readonly kind: 'multi-select'; readonly p: Readonly<Record<string, number>> }
  | { readonly id: QuestionId; readonly kind: 'score'; readonly score: number; readonly probabilities: Readonly<Record<string, number>>; readonly confidence?: number }

export type UnavailableReason =
  | 'no-provider' | 'provider-gone' | 'no-model' | 'no-key' | 'auth' | 'quota'
  | 'timeout' | 'rate-limited' | 'overloaded' | 'server' | 'unreachable'
  | 'invalid-request' | 'too-large' | 'refused' | 'invalid-response'
  | 'breaker-open' | 'busy' | 'cancelled'

interface Meta { readonly decisionId: string; readonly latencyMs: number; readonly attempts: number }
export type DecisionOutcome =
  | (Meta & { readonly status: 'ok'; readonly providerId: DecisionProviderId; readonly protocol: DecisionProtocol
      readonly model: string; readonly answeredModel: string; readonly answers: readonly DecisionAnswer[]
      readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
      readonly calibrated: boolean; readonly truncation?: 'possible' })
  | (Meta & { readonly status: 'unavailable'; readonly reason: UnavailableReason
      readonly providerId?: DecisionProviderId; readonly model?: string
      readonly httpStatus?: number; readonly retryAfterMs?: number })   // never a response body

export interface DecisionProviderInfo {
  readonly id: DecisionProviderId; readonly name: string; readonly vendor: string; readonly protocol: DecisionProtocol
  readonly location: 'cloud' | 'model-route'
  readonly endpoint: string                       // no key, no query; may hold `{account}`
  readonly credential?: { readonly ref: CredentialRef; readonly header: 'bearer' | 'x-goog-api-key' }
  readonly config?: readonly { readonly key: string; readonly label: string; readonly secret: false }[]
  readonly models: readonly { readonly id: string; readonly note?: string }[]
  readonly limits: { readonly maxQuestions: number; readonly maxOptions: number; readonly maxLevels: number; readonly contextTokens?: number }
  readonly yesNoRange: readonly [number, number]  // [0,1], or [0.01,0.99] for Gemini
  readonly stateTruncation: 'rejects' | 'silent'
  readonly calibrated: boolean
  readonly privacy: { readonly zdr: 'default' | 'available' | 'route-dependent' | 'unknown'
    readonly training: 'no' | 'unknown' | 'route-dependent'; readonly docs: string }
}
export interface ProviderCall { readonly model: string; readonly state: DecisionState; readonly questions: readonly WireQuestion[]; readonly config: Readonly<Record<string, string>> }
export interface ProviderAnswerSet { readonly answeredModel: string; readonly answers: readonly Exclude<DecisionAnswer, { kind: 'multi-select' }>[]
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }; readonly truncation?: 'possible' }
export interface DecisionProvider {
  readonly info: DecisionProviderInfo
  evaluate(call: ProviderCall, key: string | undefined, signal: AbortSignal): Promise<ProviderAnswerSet>
}
export declare class DecisionProviderError extends Error {
  constructor(reason: UnavailableReason, init?: { httpStatus?: number; retryAfterMs?: number; cause?: unknown })
  readonly reason: UnavailableReason; readonly httpStatus?: number; readonly retryAfterMs?: number
}

export interface PurposeSettings { readonly tau: number; readonly k: number; readonly tau0: number; readonly deadlineMs: number; readonly sure: number }
export interface PurposeSpec { readonly id: DecisionPurpose; readonly label: string
  readonly kinds: readonly DecisionQuestion['kind'][]; readonly defaults: PurposeSettings }
export interface DecisionSelection { readonly providerId: DecisionProviderId | null; readonly model: string | null }
export interface DecisionSelectionPatch { readonly providerId?: DecisionProviderId | null; readonly model?: string | null
  readonly providerConfig?: Readonly<Record<string, string>>; readonly purposes?: Readonly<Record<string, Partial<PurposeSettings>>> }
export interface DecisionProviderView extends DecisionProviderInfo {
  readonly key: { readonly configured: boolean; readonly writable: boolean; readonly source?: string; readonly masked?: string; readonly rejected?: boolean } | null
  readonly health: { readonly breaker: 'closed' | 'open' | 'half-open'; readonly openUntil?: number; readonly last?: UnavailableReason } }
export interface DecisionSnapshot { readonly providers: readonly DecisionProviderView[]; readonly selection: DecisionSelection
  readonly purposes: readonly (PurposeSpec & { readonly settings: PurposeSettings })[]
  readonly ready: boolean; readonly notReady?: 'no-provider' | 'provider-gone' | 'no-model' | 'no-key' | 'auth' }
type DecisionLabelKey = { readonly questionId: QuestionId; readonly option?: string }
export type DecisionLabel = DecisionLabelKey & (
  | { readonly value: true; readonly source: 'overturn'; readonly strength: 'hard' }
  | { readonly value: boolean; readonly source: 'user'; readonly strength: 'hard' } // owner-only route-judge
  | { readonly value: true; readonly source: 'answered'; readonly strength: 'soft' }
  | { readonly value: false; readonly source: 'passed'; readonly strength: 'soft' }
)
type CohortEvaluation = {
  readonly providerId: string; readonly answeredModel: string; readonly rubricVersion: string
  readonly scoredDecisions: number; readonly scoredOptions: number
  readonly human: { readonly decisions: number; readonly positive: number; readonly negative: number
    readonly belowTau: { readonly positive: number; readonly negative: number }
    readonly atOrAboveTau: { readonly positive: number; readonly negative: number } }
  readonly behavior: { readonly decisions: number; readonly exposedDecisions: number; readonly exposedOptions: number; readonly answered: number; readonly passed: number }
  readonly bins: readonly { readonly from: number; readonly to: number; readonly n: number; readonly positives: number }[]
  readonly brier?: number
  readonly suggestion?: { readonly tau: number; readonly f1: number; readonly n: number }
  readonly sufficiency: { readonly currentTau: number; readonly positiveBelow: number; readonly negativeBelow: number;
    readonly positiveAtOrAbove: number; readonly negativeAtOrAbove: number; readonly distinctJudgedDecisions: number }
}
export interface DecisionEvaluation { readonly purpose: DecisionPurpose; readonly total: number; readonly ok: number
  readonly unavailable: Readonly<Partial<Record<UnavailableReason, number>>>; readonly latency: { readonly p50: number; readonly p95: number }
  readonly cohorts: readonly CohortEvaluation[]
}

export interface Decisions {
  register(provider: DecisionProvider): () => Promise<void>
  registerPurpose(spec: PurposeSpec): () => void
  listProviders(): readonly DecisionProviderInfo[]
  snapshot(): DecisionSnapshot
  follow(signal: AbortSignal): AsyncIterable<DecisionSnapshot>
  configure(patch: DecisionSelectionPatch): Promise<void>
  settings(purpose: DecisionPurpose): PurposeSettings
  decide(request: DecisionRequest): Promise<DecisionOutcome>
  test(selection?: Partial<DecisionSelection>, signal?: AbortSignal): Promise<DecisionOutcome>
  recordExposure(decisionId: string, key: { questionId: QuestionId; option: string }): Promise<void>
  label(decisionId: string, label: DecisionLabel): Promise<void>
  evaluation(purpose: DecisionPurpose, options?: { sinceMs?: number }): Promise<DecisionEvaluation>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    decisions: Decisions
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap {
    decision: true
  }
}
