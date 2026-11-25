// The sign-in row in a Bot's chat (plan v3, 2.3): a transient row at the end of the transcript,
// shown only after an explicit entry (or, in the Bot that opened it, to restore a live attempt),
// gone by itself once the agent confirms the sign-in, and leaving nothing behind.
//
// Seat: DSH 0.2.2 declares no slot for a client row in the transcript, so this one leans on its
// rendered attributes (the risk is recorded in the plan; a slot is in the upstream proposal). One
// element, owned here, moves between parents, so the portal's container never changes and the
// code field keeps its value and focus while a turn starts and ends around it:
//   - with history: in the outermost flow of the exact conversation occurrence shown, before its
//     text interaction surface (never inside a running row or a group's inner flow);
//   - a blank conversation (the hero): in that occurrence's scroller, before the composer seat;
//   - another View on top (files and the like): not mounted; the attempt goes on in the host.
// The row's state lives in cli-login-state.js, above the portal: a remount loses nothing.
//
// The composer and its model menu stay as they are. While Claude's code step (or Antigravity's
// paste step, #2048) is shown, the native editor takes no edit (D18): its draft stays untouched,
// the code or the address goes only through the field here. Afterwards a paste, a drop or a send
// that carries `#<state>` of a Claude state, or `state=<state>` of an Antigravity link's state,
// this page showed is refused (installKnownStateGuard).
//
// Antigravity (#2048, parity) signs in here as Claude Code does, through its app sign-in in
// acp-dsh: the link with Copy link and its expiry, then a field for the address the browser
// ends on after the person signs in, on this computer or any other. Only this page's states: after a reload or in another
// window the host's step guard is what remains, and DSH has recorded the prompt by then (the
// residual risk in host/cli-login.js's header and RFC 0023).
import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { currentPart } from './text.js'
import { dateLocale, hostText, t } from './i18n.js'
import { CLI_NAMES, SIGN_IN_NAMES, carriesKnownState, cliLoginBotOf, knowsStates, rememberCallbackState } from './cli-login-model.js'

export const CLI_LOGIN_BRIDGE = Symbol.for('automagik.cli-login')
const noSubscribe = () => () => {}
const safeLink = value => { try { return new URL(value).protocol === 'https:' ? value : undefined } catch { return undefined } }
const occurrenceOf = sessionId => [...document.querySelectorAll('[data-conversation-content][data-conversation-session]')]
  .find(node => node.dataset.conversationSession === sessionId)

// The agents whose attempt asks for something pasted back: Claude's code, Antigravity's address.
const PASTES = new Set(['acp-claude', 'acp-antigravity'])
/** Whether a row is at a paste step (Claude's code, Antigravity's address), the one that locks the native editor (D18). */
const codeStep = row => row?.stage === 'attempt' && PASTES.has(row.provider) && row.attempt?.status === 'waiting'
  && row.attempt.prompt !== undefined && row.attempt.checking !== true

// Welcome (and anything else outside the chat) opens the row in the selected Bot, else the Main
// Bot, through this bridge: it only opens the chat and the offer, never starts a sign-in. A page
// that shows an Antigravity sign-in link elsewhere (Settings, Connect AI) hands it here
// (`remember`), so this page's composers refuse the address it ends on too. A Switch account
// made there hands its own attempt over (`attemptId`, #2064), so the row reads that attempt.
export function installCliLoginBridge({ scope = globalThis, selectedBot, mainBot, openLogin }) {
  const bridge = {
    open(provider, { attemptId } = {}) {
      if (!Object.hasOwn(SIGN_IN_NAMES, provider)) return false
      const bot = selectedBot() ?? mainBot()
      if (!bot) return false
      return openLogin(bot.id, provider, attemptId)
    },
    remember(url) { return rememberCallbackState(url) },
  }
  scope[CLI_LOGIN_BRIDGE] = bridge
  return () => { if (scope[CLI_LOGIN_BRIDGE] === bridge) delete scope[CLI_LOGIN_BRIDGE] }
}

const EDITOR = '[data-composer-seat] [data-composer-input]'
const editorOf = node => (node instanceof Element ? node.closest(EDITOR) : null)
const inField = node => node instanceof Element && node.closest('[data-cli-login-field]') !== null
const stop = event => { event.preventDefault(); event.stopImmediatePropagation() }

/**
 * The permanent guard (rule 3): a paste, a drop or a send from a composer whose text carries
 * `#<state>` of a Claude state this page showed is refused. It reads only pasted or dropped text
 * and the editor's text on Enter or the send button; it matches only the exact states seen.
 */
export function installKnownStateGuard({ target = window, onRefused = () => {} } = {}) {
  const check = (event, text) => {
    if (!knowsStates() || inField(event.target) || !carriesKnownState(text)) return
    stop(event)
    onRefused()
  }
  const composerOf = node => (node instanceof Element ? node.closest('[data-composer-card]') : null)
  const handlers = {
    paste: event => { if (composerOf(event.target)) check(event, event.clipboardData?.getData('text/plain')) },
    drop: event => { if (composerOf(event.target)) check(event, event.dataTransfer?.getData('text/plain')) },
    beforeinput: (event) => {
      if (!/^insertFrom/.test(event.inputType ?? '') || !editorOf(event.target)) return
      check(event, event.dataTransfer?.getData('text/plain') ?? event.data)
    },
    keydown: (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      const editor = editorOf(event.target)
      if (editor) check(event, editor.innerText)
    },
    // The send button is the composer card's busy-aware primary button.
    click: (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-composer-card] button[aria-busy]') : null
      if (button) check(event, composerOf(button)?.querySelector('[data-composer-input]')?.innerText)
    },
  }
  for (const [type, handler] of Object.entries(handlers)) target.addEventListener(type, handler, true)
  return () => { for (const [type, handler] of Object.entries(handlers)) target.removeEventListener(type, handler, true) }
}

// D18: the native editor of one conversation takes no edit while Claude's code step is shown.
const EDITS = /^(insert|delete|historyUndo|historyRedo)/
const MOVES = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta'])
function lockEditor(occurrence, { onFocus = () => {}, target = window } = {}) {
  const mine = node => {
    const editor = editorOf(node)
    return editor !== null && occurrence.contains(editor) ? editor : null
  }
  const handlers = {
    beforeinput: event => { if (mine(event.target) && EDITS.test(event.inputType ?? '')) stop(event) },
    keydown: event => { if (mine(event.target) && (!MOVES.has(event.key) || ((event.ctrlKey || event.metaKey) && /^[zyxv]$/i.test(event.key)))) stop(event) },
    paste: event => { if (mine(event.target)) stop(event) },
    cut: event => { if (mine(event.target)) stop(event) },
    drop: event => { if (mine(event.target)) stop(event) },
    dragover: event => { if (mine(event.target)) stop(event) },
    compositionstart: (event) => { const editor = mine(event.target); if (editor) { stop(event); editor.blur() } },
    // The editor cannot hold focus at all, so no key, IME or shortcut reaches it.
    focusin: (event) => { const editor = mine(event.target); if (editor) { editor.blur(); onFocus() } },
  }
  for (const [type, handler] of Object.entries(handlers)) target.addEventListener(type, handler, true)
  const focused = mine(document.activeElement)
  if (focused) focused.blur()
  return () => { for (const [type, handler] of Object.entries(handlers)) target.removeEventListener(type, handler, true) }
}

// Every event the code field gets stays in it: none reaches a listener on the document, the
// composer's keyboard handling or a shortcut. The value lives only in the DOM input.
const FIELD_EVENTS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut', 'drop', 'dragover',
  'compositionstart', 'compositionupdate', 'compositionend', 'select', 'focusin', 'focusout']
const BLOCKED = new Set(['copy', 'cut', 'drop', 'dragover'])

function CodeField({ disabled, busy, onSubmit, fieldRef, label = 'Authorization code' }) {
  const wrap = useRef(null)
  const input = useRef(null)
  const [filled, setFilled] = useState(false)
  const submit = () => {
    const node = input.current
    if (!node || disabled || busy || node.value.trim() === '') return
    const value = node.value
    node.value = ''
    setFilled(false)
    onSubmit(value)
  }
  const submitRef = useRef(submit)
  submitRef.current = submit
  useLayoutEffect(() => {
    const node = wrap.current
    const field = input.current
    fieldRef.current = field
    const handle = (event) => {
      event.stopPropagation()
      if (BLOCKED.has(event.type)) event.preventDefault()
      if (event.type === 'input') setFilled(field.value.trim() !== '')
      if (event.type === 'keydown' && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submitRef.current() }
    }
    for (const type of FIELD_EVENTS) node.addEventListener(type, handle)
    return () => {
      for (const type of FIELD_EVENTS) node.removeEventListener(type, handle)
      // Late events find nothing: readOnly and empty before the field goes.
      field.readOnly = true
      field.value = ''
      if (document.activeElement === field) field.blur()
      if (fieldRef.current === field) fieldRef.current = null
    }
  }, [])
  return h('div', { className: 'bt-cli-code' },
    h('span', { ref: wrap, className: 'bt-cli-code-wrap', 'data-cli-login-field': '' },
      h('input', {
        ref: input, type: 'password', className: 'bt-input bt-cli-code-input', disabled, autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'off',
        spellCheck: false, 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '', 'data-form-type': 'other', 'aria-label': t(label),
      })),
    h('button', { type: 'button', className: 'bt-q-submit', disabled: disabled || busy || !filled, onClick: submit }, t('Send')))
}

const timeOf = at => new Date(at).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })

function CopyLink({ url }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { setCopied(false) }, [url])
  const copy = () => { void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false)) }
  return h(Fragment, null,
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copy }, t('Copy link')),
    copied ? h('span', { className: 'bt-cli-subtle', role: 'status' }, t('Copied')) : null)
}

function Attempt({ bot, row, roster, manager, secretPending, fieldRef }) {
  const name = SIGN_IN_NAMES[row.provider]
  const agy = row.provider === 'acp-antigravity'
  const attempt = row.attempt
  const url = safeLink(attempt?.url)
  const opener = attempt?.openedBy && attempt.openedBy !== bot.id ? roster.byId?.[attempt.openedBy]?.name : undefined
  const step = codeStep(row)
  if (row.confirm) {
    return h(Fragment, null,
      h('p', null, opener ? t('Cancel the {name} sign-in opened in {bot}?', { name, bot: opener }) : t('Cancel the {name} sign-in?', { name })),
      h('div', { className: 'bt-cli-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: row.busy, onClick: () => void manager.cancel(bot.id) }, t('Yes, cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: row.busy, onClick: () => manager.keepAttempt(bot.id) }, t('Keep it'))))
  }
  return h(Fragment, null,
    url ? h(Fragment, null,
      h('p', null, t('Open this link on any device:')),
      h('p', { className: 'bt-cli-link-line' }, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', className: 'bt-cli-link' }, url))) : h('p', null, t('Preparing your sign-in…')),
    url ? h('div', { className: 'bt-cli-actions' }, h(CopyLink, { url }),
      attempt?.expiresAt ? h('span', { className: 'bt-cli-subtle' }, t('Expires at {time}', { time: timeOf(attempt.expiresAt) })) : null) : null,
    row.provider === 'acp-codex' && attempt?.userCode ? h(Fragment, null,
      h('p', null, t('Enter this code on that page:'), ' ', h('code', { className: 'bt-cli-code-text' }, attempt.userCode)),
      h('p', { className: 'bt-cli-subtle' }, t('Waiting for {name} to confirm…', { name }))) : null,
    row.provider === 'acp-claude' && attempt?.checking ? h('p', { className: 'bt-cli-subtle' }, t('Checking the code…')) : null,
    agy && attempt?.checking ? h('p', { className: 'bt-cli-subtle' }, t('Finishing the sign-in to {name}…', { name })) : null,
    step ? h(Fragment, null,
      h('p', null, agy ? t('Paste here the address your browser ends on after you sign in:') : t('Paste here the code shown after you authorize:')),
      h(CodeField, {
        disabled: secretPending, busy: row.busy, fieldRef, onSubmit: value => void manager.answer(bot.id, value),
        ...(typeof attempt.prompt?.label === 'string' ? { label: attempt.prompt.label } : {}),
      }),
      h('p', { className: 'bt-cli-subtle' }, secretPending ? t('Finish the secret requested first.') : t('The message field comes back as soon as you send the code or cancel.'))) : null,
    row.error ? h('p', { className: 'bt-cli-error', role: 'alert' }, hostText(row.error)) : null,
    h('div', { className: 'bt-cli-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: row.busy, onClick: () => manager.askCancel(bot.id) }, t('Cancel sign-in'))))
}

// Who a CLI is signed in as, in one line: the email (or the organisation), then what else the
// CLI says of it. Undefined when the CLI does not show the account.
export function accountLabel(account) {
  const who = account?.email ?? account?.org
  if (typeof who !== 'string' || who === '') return undefined
  const more = [account.email ? account.org : undefined, account.plan].filter(value => typeof value === 'string' && value !== '').join(', ')
  return more === '' ? who : `${who} (${more})`
}

// The first line of the account step (#869): the account, an API key, or that this CLI version
// does not show which account.
function accountLine(name, account) {
  if (account?.kind === 'key') return t('{name} on this computer uses an API key.', { name })
  const label = accountLabel(account)
  return label === undefined
    ? t('{name} on this computer is already signed in. This version does not show which account.', { name })
    : t('{name} on this computer is signed in as {account}.', { name, account: label })
}

/**
 * The one-time notice of a vendor whose sign-in was already used by Bots before this version
 * (carried through the upgrade): which sign-in the Bots use, and that the terminal shares it.
 * Shown once, then acknowledged to the host.
 */
export async function announceCarried({ actions }) {
  let accounts
  try { accounts = (await actions.cliLoginAccounts?.())?.accounts } catch { return false }
  const due = Object.entries(accounts ?? {}).filter(([provider, entry]) => Object.hasOwn(CLI_NAMES, provider) && entry?.notice === true)
  if (due.length === 0) return false
  actions.showNotice?.(due.map(([provider, entry]) => {
    const label = entry.account?.kind === 'key' ? undefined : accountLabel(entry.account)
    return label === undefined
      ? t('Your Bots use the {name} sign-in on this computer. It is shared with your terminal.', { name: CLI_NAMES[provider] })
      : t('Your Bots use the {name} sign-in on this computer: {account}. It is shared with your terminal.', { name: CLI_NAMES[provider], account: label })
  }).join(' '))
  for (const [provider] of due) void Promise.resolve().then(() => actions.cliLoginNoticed?.(provider)).catch(() => {})
  return true
}

const modelName = (roster, ref) => (typeof ref === 'string' ? roster.models?.find(model => model.ref === ref)?.name ?? (ref.split('/').slice(1).join('/') || ref) : '')

function CliLoginRow({ bot, row, roster, manager, secretPending, seat, fieldRef }) {
  const name = SIGN_IN_NAMES[row.provider]
  // An explicit entry brings the row into view once; nothing scrolls after that.
  useLayoutEffect(() => {
    if (row.reveal === undefined) return
    seat.scrollIntoView?.({ block: 'nearest' })
    manager.revealed(bot.id, row.reveal)
  }, [row.reveal])
  const body = (() => {
    switch (row.stage) {
      case 'offer': return h(Fragment, null,
        h('p', null, t('To use {name} in this Bot, sign in to your account.', { name })),
        row.error ? h('p', { className: 'bt-cli-error', role: 'alert' }, hostText(row.error)) : null,
        h('div', { className: 'bt-cli-actions' },
          h('button', { type: 'button', className: 'bt-q-submit', disabled: row.busy, onClick: () => void manager.start(bot.id) }, t('Sign in')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: row.busy, onClick: () => manager.dismiss(bot.id) }, t('Not now'))))
      case 'account': return h(Fragment, null,
        h('p', null, accountLine(name, row.account)),
        h('p', null, row.account?.authScope === 'isolated'
          ? t('Bots will use and bill this account. Your terminal login is separate.')
          : t('Bots will use and bill this account. It is the same sign-in your terminal uses.')),
        row.error ? h('p', { className: 'bt-cli-error', role: 'alert' }, hostText(row.error)) : null,
        h('div', { className: 'bt-cli-actions' },
          h('button', { type: 'button', className: 'bt-q-submit', disabled: row.busy, onClick: () => void manager.confirm(bot.id) }, t('Use this account')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: row.busy, onClick: () => manager.dismiss(bot.id) }, t('Not now'))))
      case 'attempt': return h(Attempt, { bot, row, roster, manager, secretPending, fieldRef })
      case 'done': {
        if (row.taken) return h('p', null, t('Done: Bots will use this {name} account.', { name }))
        // A Switch that ended on the account it signed out of (#2064); a key names no account.
        if (row.sameAccount) {
          const same = row.signedInAs?.kind === 'key' ? undefined : accountLabel(row.signedInAs)
          return h('p', null, same
            ? t('The account did not change: {name} is still signed in as {account}.', { name, account: same })
            : t('The account did not change: {name} is still signed in to the same account.', { name }))
        }
        if (row.signedInAs?.kind === 'key') return h('p', null, t('Done: {name} uses an API key.', { name }))
        const account = accountLabel(row.signedInAs)
        return h('p', null, account
          ? t('Done: signed in to {name} as {account}.', { name, account })
          : t('Done: signed in to {name}.', { name }))
      }
      case 'applyFailed': return h('p', null, t('Signed in, but {model} could not be used: {reason} This Bot stays on {kept}.', {
        model: modelName(roster, row.outcome?.ref) || name, reason: hostText(row.outcome?.message ?? ''), kept: modelName(roster, row.outcome?.kept) || t('its model'),
      }))
      case 'failed':
      case 'interrupted': {
        const message = h('p', { className: 'bt-cli-error' }, row.stage === 'interrupted' ? t('The sign-in was interrupted by a restart. Get a new link.') : hostText(row.message ?? 'Sign-in did not finish. Try again.'))
        const error = row.error ? h('p', { className: 'bt-cli-error', role: 'alert' }, hostText(row.error)) : null
        const close = h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: row.busy, onClick: () => manager.dismiss(bot.id) }, t('Close'))
        // A failed Switch account (#2064). Still signed in: Try again asks, then switches again.
        if (row.switched && row.stillSignedIn && row.confirm) {
          return h(Fragment, null,
            h('p', null, t('This stops running Bot work for this account. Continue?')),
            error,
            h('div', { className: 'bt-cli-actions' },
              h('button', { type: 'button', className: 'bt-q-submit', disabled: row.busy, onClick: () => void manager.switchAgain(bot.id) }, t('Continue')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: row.busy, onClick: () => manager.keepAttempt(bot.id) }, t('Cancel'))))
        }
        if (row.switched && row.stillSignedIn) {
          return h(Fragment, null, message, error,
            h('div', { className: 'bt-cli-actions' },
              h('button', { type: 'button', className: 'bt-q-submit', disabled: row.busy, onClick: () => manager.askSwitch(bot.id) }, t('Try again')), close))
        }
        // Signed out: its home stays paused until a sign-in, which is what the row offers.
        if (row.switched) {
          return h(Fragment, null, message,
            h('p', null, t('To use {name} in this Bot, sign in to your account.', { name })),
            error,
            h('div', { className: 'bt-cli-actions' },
              h('button', { type: 'button', className: 'bt-q-submit', disabled: row.busy, onClick: () => void manager.start(bot.id) }, t('Sign in')), close))
        }
        return h(Fragment, null, message, error,
          h('div', { className: 'bt-cli-actions' },
            h('button', { type: 'button', className: 'bt-q-submit', disabled: row.busy, onClick: () => void manager.start(bot.id) }, t('Try again')), close))
      }
      default: return null
    }
  })()
  return h('div', { className: 'bt-cli-row', 'data-cli-login': row.provider, 'data-stage': row.stage, role: 'group', 'aria-label': t('Sign in to {name}', { name }) },
    h('div', { className: 'bt-cli-row-title' }, name),
    h('div', { 'aria-live': 'polite' }, body))
}

/**
 * The input dock entry of a Bot's chat: it draws nothing in the dock. While this Bot has a row,
 * it lends the exact conversation occurrence a seat in the transcript and portals the row there.
 */
export function CliLoginConversation({ sessionId, useRoster, useSession, inputActions, actions }) {
  const roster = useRoster(value => value)
  const blank = useSession?.(value => value?.blank) === true
  const manager = actions.cliLogin
  const bot = cliLoginBotOf(roster, sessionId)
  const eligible = Boolean(bot) && roster.ready !== false && currentPart(bot) === sessionId && manager !== undefined
  const row = useSyncExternalStore(manager?.subscribe ?? noSubscribe, () => (eligible ? manager.getSnapshot().rows[bot.id] : undefined))
  const secretPending = eligible && (roster.secretRequests?.[bot.id] ?? []).some(entry => entry.status === 'pending')
  const anchor = useRef(null)
  const fieldRef = useRef(null)
  const [seat, setSeat] = useState(null)
  const locked = codeStep(row)
  const wasCode = useRef(false)

  // Rule 1: the Bot that opened a live attempt gets its row back (a reload, a suspended tab).
  useEffect(() => { if (eligible) void manager.restore(bot.id) }, [eligible, bot?.id])

  // D18, and the end of Claude's code step: a draft that holds a state this page showed is cleared.
  useEffect(() => {
    if (!locked) {
      if (wasCode.current) {
        wasCode.current = false
        const editor = occurrenceOf(sessionId)?.querySelector(EDITOR)
        const draftActions = inputActions ?? actions.inputActionsOf?.(sessionId)
        if (editor && carriesKnownState(editor.innerText)) draftActions?.setDraft?.('')
      }
      return undefined
    }
    wasCode.current = true
    const occurrence = occurrenceOf(sessionId)
    if (!occurrence) return undefined
    return lockEditor(occurrence, { onFocus: () => fieldRef.current?.focus() })
  }, [locked, sessionId])

  useLayoutEffect(() => {
    if (!eligible || row === undefined || !anchor.current) return undefined
    const occurrence = anchor.current.closest('[data-conversation-content][data-conversation-session]')
    if (!occurrence || occurrence.dataset.conversationSession !== sessionId) return undefined
    const owned = node => node?.closest('[data-conversation-content]') === occurrence
    const node = document.createElement('div')
    node.className = 'bt-cli-seat'
    node.dataset.cliLoginSeat = sessionId
    const sync = () => {
      const scroll = [...occurrence.querySelectorAll('[data-conversation-scroll]')].find(owned)
      const composer = [...occurrence.querySelectorAll('[data-composer-seat]')].find(owned)
      const flow = [...occurrence.querySelectorAll('[data-chat-flow]')]
        .find(item => owned(item) && !item.parentElement?.closest('[data-chat-flow]') && !item.closest('[data-chat-running]'))
      const view = [...occurrence.querySelectorAll('[data-slot="conversation.view"]')].find(owned)
      const elsewhere = view !== undefined && view.dataset.viewId !== undefined && view.dataset.viewId !== 'chat'
      const parent = elsewhere ? null : flow ?? (blank && scroll && composer ? scroll : null)
      if (parent === null) {
        if (node.isConnected) { node.remove(); setSeat(null) }
        return
      }
      const before = flow ? flow.querySelector(':scope > [data-text-interaction-surface]') : composer
      if (node.parentElement === parent && node.nextElementSibling === before) return
      node.dataset.blank = flow ? 'false' : 'true'
      parent.insertBefore(node, before)
      setSeat(node)
    }
    const observer = new MutationObserver(sync)
    observer.observe(occurrence, { childList: true, subtree: true })
    sync()
    return () => { observer.disconnect(); node.remove(); setSeat(null) }
  }, [eligible, row === undefined, sessionId, blank])

  if (!eligible || row === undefined) return null
  return h('span', { ref: anchor, hidden: true, 'data-cli-login-anchor': sessionId },
    seat ? createPortal(h(CliLoginRow, { bot, row, roster, manager, secretPending, seat, fieldRef }), seat) : null)
}

// New layout rules, declared here: the row wraps its sentence, a long link, the code, the field
// and two or three buttons at 420px. Colors, radii and controls come from the theme tokens and
// the existing primitives (bt-input, bt-soft, bt-q-submit); no existing rule is changed.
export const CLI_LOGIN_CSS = `
.bt-cli-seat{box-sizing:border-box;min-width:0}
.bt-cli-seat[data-blank=true]{width:100%;max-width:calc(var(--dsh-chat-content-width,760px) + 32px);margin:0 auto;padding:16px}
.bt-cli-row{box-sizing:border-box;min-width:0;max-width:100%;margin:12px 0 4px;padding:12px 14px;border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);font-size:var(--dsh-content-font-size,14px);line-height:calc(var(--dsh-content-font-size,14px) + 8px);overflow-wrap:anywhere}
.bt-cli-row p{margin:0}.bt-cli-row p+p,.bt-cli-row p+.bt-cli-actions,.bt-cli-row .bt-cli-actions+p,.bt-cli-row .bt-cli-code+p,.bt-cli-row p+.bt-cli-code{margin-top:8px}
.bt-cli-row-title{font-size:12px;font-weight:600;color:var(--bt-ink-2);margin-bottom:4px}
.bt-cli-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.bt-cli-link{color:var(--bt-accent);overflow-wrap:anywhere;word-break:break-all}
.bt-cli-code-text{font-family:var(--dsw-font-family-mono,monospace);font-weight:600;overflow-wrap:anywhere}
.bt-cli-subtle{font-size:12px;color:var(--bt-ink-2)}
.bt-cli-error{color:var(--dsw-alias-state-error-primary,var(--bt-ink))}
.bt-cli-code{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.bt-cli-code-wrap{display:flex;flex:1 1 200px;min-width:0}
.bt-cli-code-input{box-sizing:border-box;width:100%;min-width:0}
`
