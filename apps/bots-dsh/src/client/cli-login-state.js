// The sign-in rows of this page (plan v3, 2.3). The attempt lives in the host (acp-dsh, through
// the Bot team's cli-login-* endpoints); a row is only this page's view of it, for one Bot and
// one agent. Nothing here is written to storage, a Session, a draft, team state or a model call,
// and a row never cancels an attempt by going away: only the person's explicit cancel does.
//
// A row's life (the diagram in 2.3):
//   offer        "To use {name} in this Bot, sign in"            [Sign in] [Not now]
//   account      the CLI is already signed in on this computer: the account, and that Bots
//                will use and bill it, shared with the terminal (#869)  [Use this account] [Not now]
//   attempt      the link, the Codex code or the Claude code field, its expiry   [Cancel sign-in]
//   done         "Done: signed in to {name}."  gone by itself after DONE_MS
//   applyFailed  signed in, but the chosen model could not be used  gone after APPLY_FAILED_MS
//   failed       one line                                        [Try again] [Close]
//   interrupted  a restart ended the attempt                     [Try again] [Close]
// The account step comes before any sign-in starts: the host answers `confirm` where it would
// have answered ready at once. "Use this account" is the person's word; the host then applies
// the model chosen with the entry, exactly as after a sign-in (done, applyFailed).
// A row that only offers or reports (offer, account, failed, interrupted) closes by itself when the Bot's
// selected model moves to another provider: it is about a model the Bot left. A live attempt
// stays, since it belongs to the CLI, not to the Bot's pick.
import { APPLY_FAILED_MS, CLI_NAMES, DONE_MS, rememberLinkState } from './cli-login-model.js'

const ACTIVE = new Set(['starting', 'waiting'])
// The host's codes for an attempt it no longer has, and for one a restart ended: the message
// itself is already in the page's language (api.js, hostText), so it is never compared.
const ENDED = 'bot/login-ended'
const RESTARTED = 'bot/login-restarted'
const EXPIRED = 'This sign-in expired. Start again.'
// How often, and how many times, a finished sign-in asks what became of the chosen model.
const CHOICE_MS = 500
const CHOICE_TRIES = 8
const known = provider => Object.hasOwn(CLI_NAMES, provider)
const CLOSES_ON_MOVE = new Set(['offer', 'account', 'failed', 'interrupted'])
const ACCESS_REQUIRED = 'MODEL_ACCESS_REQUIRED'
const ACCOUNT_CHANGED = 'bot/account-changed'
const ACCOUNT_SIGNED_OUT = 'bot/account-signed-out'
const providerOf = ref => (typeof ref === 'string' && ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : undefined)
const messageOf = error => (typeof error?.message === 'string' && error.message !== '' ? error.message : 'Could not continue this sign-in. Try again.')

/**
 * @param {object} options
 * @param {object} options.actions the team actions: cliLoginStart/Current/Status/Answer/Cancel/Connections/Confirm, refreshModels.
 * @param {number} [options.pollMs] how often a live attempt is read.
 * @param {() => number} [options.now]
 * @param {{ setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function }} [options.timers]
 * @param {(botId: string) => (string | null | undefined)} [options.modelOf] the Bot's selected model, as the
 *   last state answer carried it; followModels() closes a row whose Bot moved to another provider.
 */
export function createCliLogin({ actions, pollMs = 1500, now = Date.now, timers = globalThis, modelOf, botOf }) {
  const listeners = new Set()
  let snapshot = Object.freeze({ rows: Object.freeze({}) })
  let disposed = false
  let sequence = 0
  let intent = 0
  const recoveries = new Set()
  // The last view of each agent's attempt, shared by every row that shows it.
  const attempts = {}
  const polls = {}
  const providerEpochs = new Map()
  const rowTimers = new Map()
  const restored = new Set()
  // Bot id -> the row (by seq) and the model its Bot was on when the row first showed.
  const baselines = new Map()

  const emit = () => { for (const listener of listeners) listener() }
  const rowOf = botId => snapshot.rows[botId]
  const live = (botId, seq) => !disposed && rowOf(botId)?.seq === seq
  function setRow(botId, row) {
    if (disposed) return
    const rows = { ...snapshot.rows }
    if (row === null) {
      delete rows[botId]
      timers.clearTimeout(rowTimers.get(botId))
      rowTimers.delete(botId)
      baselines.delete(botId)
    } else {
      rows[botId] = Object.freeze(row)
      if (baselines.get(botId)?.seq !== row.seq) baselines.set(botId, { seq: row.seq, model: modelOf?.(botId) })
    }
    snapshot = Object.freeze({ rows: Object.freeze(rows) })
    emit()
  }
  // Retire only the pending view owned by this recovery, never the host attempt or a
  // replacement row. An ordinary entry can then read/join whatever the host completed.
  function retireRecovery(owner) {
    const row = rowOf(owner.botId)
    const seq = owner.seq
    owner.seq = undefined // A newer intent may reuse a settled row with this same sequence.
    if (row?.seq === seq && row?.busy) setRow(owner.botId, null)
  }
  function retireInvalidRecoveries() {
    for (const owner of recoveries) if (!owner.current()) retireRecovery(owner)
  }
  function nextIntent() {
    ++intent
    retireInvalidRecoveries()
    return intent
  }
  const patchRow = (botId, seq, patch) => { if (live(botId, seq)) setRow(botId, { ...rowOf(botId), ...patch }) }
  const attemptRows = provider => Object.values(snapshot.rows).filter(row => row.provider === provider && row.stage === 'attempt')
  const accountRows = provider => Object.values(snapshot.rows).filter(row => row.provider === provider && row.stage === 'account')
  // Bot id -> the refused turn (its time) the account step was last offered for.
  const offered = new Map()
  // A row that ended on its own leaves by itself, with no residue (D17, rule 8).
  function leaveAfter(botId, seq, ms) {
    timers.clearTimeout(rowTimers.get(botId))
    rowTimers.set(botId, timers.setTimeout(() => { if (live(botId, seq)) setRow(botId, null) }, ms))
  }

  function stopPoll(provider) {
    if (polls[provider]?.timer !== undefined) timers.clearInterval(polls[provider].timer)
    polls[provider]?.controller?.abort()
    delete polls[provider]
  }
  function armPoll(provider) {
    if (disposed || polls[provider] !== undefined || attemptRows(provider).length === 0) return
    polls[provider] = { timer: timers.setInterval(() => { void poll(provider) }, pollMs) }
  }

  // A view from the host, for every row of that agent.
  function applyView(provider, view) {
    if (disposed || view === null || view === undefined) return
    attempts[provider] = view
    if (provider === 'acp-claude' && typeof view.url === 'string') rememberLinkState(view.url)
    if (ACTIVE.has(view.status)) {
      for (const row of attemptRows(provider)) setRow(row.botId, { ...row, attempt: view })
      armPoll(provider)
    } else if (view.status === 'ready') succeed(provider, view)
    else if (view.status === 'confirm') askAccount(provider, view.account)
    else if (view.status === 'cancelled') {
      stopPoll(provider)
      for (const row of attemptRows(provider)) setRow(row.botId, null)
    } else {
      stopPoll(provider)
      for (const row of attemptRows(provider)) setRow(row.botId, { ...row, stage: 'failed', attempt: null, busy: false, confirm: false, message: view.message ?? 'Sign-in did not finish. Try again.' })
    }
  }

  // The CLI was already signed in: every row of that agent asks the person about the account
  // before anything else happens. No attempt is at work, so nothing is polled.
  function askAccount(provider, account) {
    stopPoll(provider)
    for (const row of attemptRows(provider)) setRow(row.botId, { ...row, stage: 'account', attempt: null, busy: false, confirm: false, error: null, account: Object.freeze({ ...account }) })
  }

  // The person's word was taken: the rows of that agent end as after a sign-in.
  function accountTaken(provider, botId, view) {
    void Promise.resolve().then(() => actions.refreshModels?.()).catch(() => {})
    for (const row of accountRows(provider)) {
      setRow(row.botId, { ...row, stage: 'done', taken: true, account: undefined, busy: false, error: null })
      leaveAfter(row.botId, row.seq, DONE_MS)
      const choice = row.botId === botId ? view?.choice : undefined
      if (choice?.state === 'failed') applyFailed(row.botId, row.seq, choice)
      else void followChoice(row.botId, provider, row.seq)
    }
  }

  // What the host says of an agent's account now, for one row: still waiting for the person
  // (the account, read again), or not any more (the offer to sign in).
  async function readAccount(botId, provider, seq, error) {
    let current
    try { current = await actions.cliLoginCurrent(botId, provider) } catch { current = undefined }
    if (!live(botId, seq)) return
    if (current?.account) patchRow(botId, seq, { stage: 'account', busy: false, error, account: Object.freeze({ ...current.account }) })
    else patchRow(botId, seq, { stage: 'offer', busy: false, error, account: undefined })
  }

  function succeed(provider, view) {
    stopPoll(provider)
    void Promise.resolve().then(() => actions.refreshModels?.()).catch(() => {})
    for (const row of attemptRows(provider)) {
      setRow(row.botId, { ...row, stage: 'done', attempt: null, busy: false, confirm: false, error: null })
      leaveAfter(row.botId, row.seq, DONE_MS)
      if (view?.choice?.state === 'failed') applyFailed(row.botId, row.seq, view.choice)
      else if (view?.choice?.state === 'pending' || view?.choice === undefined) void followChoice(row.botId, provider, row.seq)
    }
  }

  // The model chosen with this Bot's entry is applied by the host on ready (rule 5); its
  // outcome is read back while the row still shows "Done".
  async function followChoice(botId, provider, seq) {
    for (let tries = 0; tries < CHOICE_TRIES; tries++) {
      await new Promise(resolve => timers.setTimeout(resolve, CHOICE_MS))
      if (!live(botId, seq) || rowOf(botId).stage !== 'done') return
      let current
      try { current = await actions.cliLoginCurrent(botId, provider) } catch { return }
      if (!live(botId, seq) || rowOf(botId).stage !== 'done') return
      const choice = current?.choice
      if (choice?.state === 'failed') { applyFailed(botId, seq, choice); return }
      if (choice?.state !== 'pending') {
        if (choice?.state === 'applied') void Promise.resolve().then(() => actions.refreshModels?.()).catch(() => {})
        return
      }
    }
  }

  function applyFailed(botId, seq, choice) {
    patchRow(botId, seq, { stage: 'applyFailed', outcome: Object.freeze({ ref: choice.ref, message: choice.message, kept: choice.kept ?? null }) })
    leaveAfter(botId, seq, APPLY_FAILED_MS)
  }

  function interrupt(provider) {
    stopPoll(provider)
    for (const row of attemptRows(provider)) setRow(row.botId, { ...row, stage: 'interrupted', attempt: null, busy: false, confirm: false })
  }

  // The attempt is gone from the host (its 60 s retention passed, or DSH restarted). The agent's
  // own sign-in decides what the row says, before anything else is shown (rule 4).
  async function ended(provider) {
    const epoch = providerEpochs.get(provider)
    stopPoll(provider)
    let signedIn
    let connection
    try {
      connection = (await actions.cliLoginConnections())?.connections?.[provider]
      signedIn = connection?.signedIn
    } catch { signedIn = undefined }
    if (disposed || providerEpochs.get(provider) !== epoch) return
    // Signed in, but to an account that waits for the person: the account step, never "done".
    if (signedIn === true && connection?.consent === 'needed') {
      for (const row of attemptRows(provider)) void readAccount(row.botId, provider, row.seq, null)
      return
    }
    if (signedIn === true) { succeed(provider, undefined); return }
    const last = attempts[provider]
    if (last?.expiresAt !== undefined && last.expiresAt > now()) interrupt(provider)
    else applyView(provider, { status: 'expired', message: EXPIRED })
  }

  function failedCall(provider, error) {
    if (error?.code === ENDED) { void ended(provider); return true }
    if (error?.code === RESTARTED) { interrupt(provider); return true }
    return false
  }

  async function poll(provider) {
    const state = polls[provider]
    const row = attemptRows(provider)[0]
    const attempt = attempts[provider]
    if (state === undefined || state.controller !== undefined) return
    if (row === undefined || attempt === undefined) { stopPoll(provider); return }
    const controller = new AbortController()
    state.controller = controller
    try {
      const view = await actions.cliLoginStatus(row.botId, provider, attempt.attemptId, controller.signal)
      if (polls[provider] === state && !controller.signal.aborted) applyView(provider, view)
    } catch (error) {
      // A network failure while DSH restarts is read again on the next tick.
      if (polls[provider] === state && !controller.signal.aborted && !/^(NETWORK|HTTP_)/.test(error?.code ?? '')) failedCall(provider, error)
    } finally {
      if (state.controller === controller) delete state.controller
    }
  }

  const api = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },

    /**
     * The explicit entry (rule 2): a chat where the person chose an agent that is signed out,
     * or the Sign in button in Settings or Welcome. A live attempt of that agent is joined, never
     * started again; `ref` (the model the person chose) is kept by the host for this Bot.
     */
    async open({ botId, provider, ref }, valid = () => true, owner) {
      nextIntent()
      if (disposed || !valid() || typeof botId !== 'string' || botId === '' || !known(provider)) return false
      const model = typeof ref === 'string' && ref.startsWith(`${provider}/`) ? ref : undefined
      const existing = rowOf(botId)
      if (existing?.provider === provider && ['offer', 'attempt', 'account'].includes(existing.stage)) {
        setRow(botId, { ...existing, reveal: ++sequence, ...(model ? { ref: model } : {}) })
        // Another model chosen while the sign-in runs is the latest intent (rule 5): the host
        // keeps it in place of the older one. Start joins the live attempt, never opens a second.
        // A cancel or answer in flight (busy) is left alone, so a start never reopens what it ends.
        if (existing.stage === 'attempt' && model && model !== existing.ref && !existing.busy) {
          const seq = existing.seq
          try {
            const view = await actions.cliLoginStart(botId, provider, model)
            if (live(botId, seq) && rowOf(botId).stage === 'attempt') applyView(provider, view)
          } catch (error) {
            if (live(botId, seq)) failedCall(provider, error)
          }
        }
        return true
      }
      const seq = ++sequence
      if (owner) owner.seq = seq
      setRow(botId, { botId, provider, ref: model, stage: 'offer', busy: true, reveal: seq, seq, attempt: null, error: null, confirm: false })
      try {
        const current = await actions.cliLoginCurrent(botId, provider)
        if (!live(botId, seq) || !valid()) return false
        if (current?.attempt && ACTIVE.has(current.attempt.status)) {
          // Joining with a model chosen here keeps that choice for this Bot (start returns the
          // live attempt, it never opens a second one).
          const view = model ? await actions.cliLoginStart(botId, provider, model) : current.attempt
          if (!live(botId, seq) || !valid()) return false
          setRow(botId, { ...rowOf(botId), stage: 'attempt', busy: false })
          applyView(provider, view)
          return true
        }
        // Already signed in on this computer, to an account that waits for the person.
        if (current?.account) {
          setRow(botId, { ...rowOf(botId), stage: 'account', busy: false, account: Object.freeze({ ...current.account }) })
          return true
        }
      } catch {
        // The offer stays: its own Sign in reports what failed.
      }
      if (!valid()) return false
      patchRow(botId, seq, { busy: false })
      return true
    },

    // Settings' confirmed recovery composes the existing owner RPCs. Each RPC retains its
    // own host admission checks; Reset and start are deliberately not an atomic transaction.
    async recover({ botId, provider, ref }) {
      if (disposed || !known(provider) || !botOf?.(botId)) return false
      const model = modelOf?.(botId)
      let operation = nextIntent()
      const current = () => !disposed && intent === operation && Boolean(botOf(botId))
        && modelOf?.(botId) === model
      await actions.cliLoginReset(botId, provider)
      if (!current()) return false
      // Abort old polls and invalidate every provider row before ordinary open can join it.
      stopPoll(provider)
      providerEpochs.set(provider, (providerEpochs.get(provider) ?? 0) + 1)
      delete attempts[provider]
      for (const row of Object.values(snapshot.rows)) if (row.provider === provider) setRow(row.botId, null)
      const owner = { botId, current, seq: undefined }
      recoveries.add(owner)
      try {
        operation = intent + 1
        if (!await api.open({ botId, provider, ref }, current, owner) || !current()) return false
        const row = rowOf(botId)
        if (row?.provider !== provider || row.seq !== owner.seq || row.busy) return false
        // Existing accounts and attempts remain on their ordinary confirmation/join route.
        if (row.stage !== 'offer') return ['account', 'attempt'].includes(row.stage)
        operation = intent + 1
        return await api.start(botId, current)
      } finally {
        if (!current()) retireRecovery(owner)
        recoveries.delete(owner)
      }
    },

    /** Sign in (or Try again): starts the attempt, or joins the one at work. */
    async start(botId, valid = () => true) {
      nextIntent()
      const row = rowOf(botId)
      if (disposed || !valid() || row === undefined || row.busy || !['offer', 'failed', 'interrupted'].includes(row.stage)) return false
      const seq = row.seq
      patchRow(botId, seq, { busy: true, error: null })
      try {
        const view = await actions.cliLoginStart(botId, row.provider, row.ref)
        if (!live(botId, seq) || !valid()) return false
        setRow(botId, { ...rowOf(botId), stage: 'attempt', busy: false, message: undefined })
        applyView(row.provider, view)
        return true
      } catch (error) {
        if (!live(botId, seq) || !valid()) return false
        patchRow(botId, seq, { busy: false, error: messageOf(error) })
        return false
      }
    },

    /** The Claude code, sent once to the host; it is never kept here. */
    async answer(botId, value) {
      nextIntent()
      const row = rowOf(botId)
      const attempt = row?.attempt
      if (disposed || row?.stage !== 'attempt' || row.provider !== 'acp-claude' || row.busy || attempt?.prompt === undefined
        || typeof value !== 'string' || value.trim() === '') return false
      const seq = row.seq
      patchRow(botId, seq, { busy: true, error: null })
      try {
        const view = await actions.cliLoginAnswer(botId, row.provider, attempt.attemptId, value.trim())
        if (!live(botId, seq)) return false
        patchRow(botId, seq, { busy: false })
        applyView(row.provider, view)
        return true
      } catch (error) {
        if (!live(botId, seq)) return false
        patchRow(botId, seq, { busy: false })
        if (!failedCall(row.provider, error)) patchRow(botId, seq, { error: messageOf(error) })
        return false
      }
    },

    /**
     * "Use this account": the person's word for the account the row shows. The host records it
     * and applies the model chosen with the entry; another account signed in meanwhile is
     * shown instead, and nothing is taken for it.
     */
    async confirm(botId) {
      nextIntent()
      const row = rowOf(botId)
      if (disposed || row?.stage !== 'account' || row.busy) return false
      const seq = row.seq
      patchRow(botId, seq, { busy: true, error: null })
      try {
        const view = await actions.cliLoginConfirm(botId, row.provider, row.account?.ref, row.ref)
        if (!live(botId, seq)) return false
        accountTaken(row.provider, botId, view)
        return true
      } catch (error) {
        if (!live(botId, seq)) return false
        if (error?.code === ACCOUNT_CHANGED || error?.code === ACCOUNT_SIGNED_OUT) await readAccount(botId, row.provider, seq, messageOf(error))
        else patchRow(botId, seq, { busy: false, error: messageOf(error) })
        return false
      }
    },

    /**
     * A turn of a Bot was refused because its agent's account needs the person (the host's
     * model state): the account step opens in that Bot's chat, once per refused turn. A turn
     * refused for a missing sign-in opens nothing here, as before.
     * @param {Record<string, { selected?: string | null, lastFailure?: { code?: string, ref?: string, at?: number } }>} [models]
     */
    followFailures(models) {
      if (disposed || models === null || typeof models !== 'object') return
      for (const [botId, state] of Object.entries(models)) {
        const failure = state?.lastFailure
        const provider = providerOf(failure?.ref)
        if (failure?.code !== ACCESS_REQUIRED || failure.ref !== state.selected || !known(provider) || offered.get(botId) === failure.at) continue
        offered.set(botId, failure.at)
        if (rowOf(botId) !== undefined) continue
        void (async () => {
          const epoch = providerEpochs.get(provider)
          let current
          try { current = await actions.cliLoginCurrent(botId, provider) } catch { return }
          if (disposed || providerEpochs.get(provider) !== epoch || rowOf(botId) !== undefined || !current?.account) return
          const seq = ++sequence
          setRow(botId, { botId, provider, ref: undefined, stage: 'account', busy: false, reveal: seq, seq, attempt: null, error: null, confirm: false, account: Object.freeze({ ...current.account }) })
        })()
      }
    },

    askCancel(botId) { const row = rowOf(botId); if (row?.stage === 'attempt') patchRow(botId, row.seq, { confirm: true }) },
    keepAttempt(botId) { const row = rowOf(botId); if (row) patchRow(botId, row.seq, { confirm: false }) },

    /** The person's explicit cancel: the only way a row ends an attempt. */
    async cancel(botId) {
      nextIntent()
      const row = rowOf(botId)
      const attempt = row?.attempt
      if (disposed || row?.stage !== 'attempt' || row.busy || attempt === null || attempt === undefined) return false
      const seq = row.seq
      patchRow(botId, seq, { busy: true, error: null })
      try {
        const view = await actions.cliLoginCancel(botId, row.provider, attempt.attemptId)
        if (!live(botId, seq)) return false
        applyView(row.provider, view?.status === 'cancelled' ? view : { ...attempt, status: 'cancelled' })
        if (live(botId, seq)) setRow(botId, null)
        return true
      } catch (error) {
        if (!live(botId, seq)) return false
        patchRow(botId, seq, { busy: false })
        if (!failedCall(row.provider, error)) patchRow(botId, seq, { error: messageOf(error) })
        return false
      }
    },

    /** Not now, or Close: the row goes; an attempt at work goes on in the host. */
    dismiss(botId) { nextIntent(); if (rowOf(botId)) setRow(botId, null) },

    /**
     * The Bots' selected models moved (a new state answer): a row about a provider its Bot left
     * closes, unless it shows a live attempt or a call of its own is in flight.
     */
    followModels() {
      if (disposed || typeof modelOf !== 'function') return
      retireInvalidRecoveries()
      for (const row of Object.values(snapshot.rows)) {
        const baseline = baselines.get(row.botId)
        const model = modelOf(row.botId)
        if (baseline === undefined || baseline.seq !== row.seq) {
          baselines.set(row.botId, { seq: row.seq, model })
          continue
        }
        if (typeof model !== 'string' || model === baseline.model) continue
        baseline.model = model
        if (providerOf(model) !== row.provider && CLOSES_ON_MOVE.has(row.stage) && row.busy !== true) setRow(row.botId, null)
      }
    },

    /** The reveal of an explicit entry was shown once. */
    revealed(botId, token) { const row = rowOf(botId); if (row?.reveal === token) patchRow(botId, row.seq, { reveal: undefined }) },

    /**
     * Rule 1: in the Bot that opened a live attempt, its row comes back by itself (a reload, a
     * suspended tab). Asked once per Bot per page; other Bots join only by an explicit entry.
     */
    async restore(botId) {
      if (disposed || typeof botId !== 'string' || rowOf(botId) !== undefined || restored.has(botId)) return
      restored.add(botId)
      for (const provider of Object.keys(CLI_NAMES)) {
        const epoch = providerEpochs.get(provider)
        let current
        try { current = await actions.cliLoginCurrent(botId, provider) } catch { continue }
        if (disposed || providerEpochs.get(provider) !== epoch || rowOf(botId) !== undefined) return
        const attempt = current?.attempt
        if (attempt && ACTIVE.has(attempt.status) && attempt.openedBy === botId) {
          setRow(botId, { botId, provider, stage: 'attempt', busy: false, seq: ++sequence, attempt, error: null, confirm: false })
          applyView(provider, attempt)
          return
        }
      }
    },

    dispose() {
      if (disposed) return
      for (const owner of recoveries) retireRecovery(owner)
      recoveries.clear()
      for (const provider of Object.keys(polls)) stopPoll(provider)
      for (const timer of rowTimers.values()) timers.clearTimeout(timer)
      rowTimers.clear()
      disposed = true
      listeners.clear()
    },
  }
  return api
}
