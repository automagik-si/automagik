import { reservationDigests } from '../../../acp-dsh/src/host/reservation-evidence.js'

export const CODEX = 'acp-codex'
export const CLAUDE = 'acp-claude'
export const CODEX_ACCOUNT = {
  email: 'private-codex@example.test', plan: 'plus', ref: 'codex-ref', token: 'private-token',
}
export const CLAUDE_ACCOUNT = {
  email: 'private-claude@example.test', org: 'private-organisation', ref: 'claude-ref', token: 'private-token',
}

export function reservationAcp({
  authScope = 'isolated', evidenceVersion, outcome, deferred,
} = {}) {
  const r4 = evidenceVersion === 2
  const accounts = { [CODEX]: { ...CODEX_ACCOUNT }, [CLAUDE]: { ...CLAUDE_ACCOUNT } }
  const calls = []
  const identityOf = (id, account) => id === CODEX
    ? { person: true, vendor: 'codex', email: account.email, class: account.class ?? 'personal' }
    : { person: true, vendor: 'claude', email: account.email, org: account.org }
  const service = {
    authScope,
    ...(r4 ? { reservationEvidence: 2 } : {}),
    status: async () => ({ agents: Object.entries(accounts).map(([id, account]) => ({
      id, signedIn: !!account, consent: account?.consent ?? 'given',
    })) }),
    account: async (id, options) => {
      calls.push(['account', id, options])
      const account = accounts[id]
      return account ? {
        id, signedIn: true, ref: account.ref, consent: account.consent ?? 'given',
        notice: account.notice, account: { kind: 'account', ...account },
      } : { id, signedIn: false }
    },
    accountEvidence: async (id, { key, keys }) => {
      calls.push(['evidence', id])
      const account = accounts[id]
      if (!account) return { id, signedIn: false }
      const identity = identityOf(id, account)
      const { vendor } = identity
      const result = outcome?.(id, identity) ?? 'complete'
      if (result === 'ambiguous') {
        if (vendor === 'codex') identity.class = 'unknown'
        else delete identity.org
      }
      const digests = reservationDigests(identity, key)
      if (deferred) await deferred(id)
      return {
        id, signedIn: true, ref: account.ref, vendor, outcome: result,
        reservable: result === 'complete', ...(r4 && authScope === 'isolated' ? { authScope } : {}),
        ...(vendor === 'codex' ? { class: identity.class } : {}),
        ...digests, token: 'private-token',
        ...(r4 && keys && digests.loose
          ? { digests: keys.map(other => reservationDigests(identity, other)) } : {}),
      }
    },
    accountSwitch: async id => calls.push(['switch', id]),
    accountReset: async id => calls.push(['reset', id]),
    accountSignOut: r4 ? async (id, options) => {
      calls.push(['signout', id, options])
      const expect = options?.expect
      const account = accounts[id]
      const identity = account && identityOf(id, account)
      if (identity && outcome?.(id, identity) === 'ambiguous') {
        if (identity.vendor === 'codex') identity.class = 'unknown'
        else delete identity.org
      }
      const seen = identity && expect && reservationDigests(identity, expect.key)
      if (!seen || seen.loose !== expect.loose || seen.exact !== expect.exact
        || expect.recheck?.() === false) throw Object.assign(new Error(), {
        code: 'acp-account/changed',
      })
      accounts[id] = undefined
      return { id, signedIn: false, authScope }
    } : async id => calls.push(['signout', id]),
  }
  return { service, accounts, calls }
}
