import { reservationDigests } from '../../../acp-dsh/src/host/reservation-evidence.js'

export const CODEX = 'acp-codex'
export const CLAUDE = 'acp-claude'
export const CODEX_ACCOUNT = {
  email: 'private-codex@example.test', plan: 'plus', ref: 'codex-ref', token: 'private-token',
}
export const CLAUDE_ACCOUNT = {
  email: 'private-claude@example.test', org: 'private-organisation', ref: 'claude-ref', token: 'private-token',
}

export function reservationAcp({ authScope = 'isolated' } = {}) {
  const accounts = { [CODEX]: { ...CODEX_ACCOUNT }, [CLAUDE]: { ...CLAUDE_ACCOUNT } }
  const calls = []
  const service = {
    authScope,
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
    accountEvidence: async (id, { key }) => {
      calls.push(['evidence', id])
      const account = accounts[id]
      if (!account) return { id, signedIn: false }
      const vendor = id === CODEX ? 'codex' : 'claude'
      const identity = { person: true, vendor, email: account.email,
        ...(vendor === 'codex' ? { class: account.class ?? 'personal' } : { org: account.org }) }
      return {
        id, signedIn: true, ref: account.ref, vendor, outcome: 'complete', reservable: true,
        ...(vendor === 'codex' ? { class: identity.class } : {}),
        ...reservationDigests(identity, key), token: 'private-token',
      }
    },
    accountSwitch: async id => calls.push(['switch', id]),
    accountReset: async id => calls.push(['reset', id]),
    accountSignOut: async id => calls.push(['signout', id]),
  }
  return { service, accounts, calls }
}
