// Secret cards: a Bot's request_secret shows a card where the user types a key the
// Bot never sees, or lets the Bot use a key that is already saved. The settings page
// lists the saved keys and who may use them. Values only ever travel from these
// inputs to the host; nothing here reads one back.
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { CheckIcon, CloseIcon, TrashIcon } from './icons.js'
import { BotAvatar, BotMark } from './mark.js'
import { contentText, currentPart } from './text.js'
import { dateLocale, t } from './i18n.js'
import { SPRING_POP, SPRING_SHAPE, spring } from './motion.js'
import { useDockHold } from './card-hold.js'
import { heldCardKey } from './sources.js'
import { CellEmpty } from './cell-empty.js'
import { GITHUB_FIELDS, githubPermissions, githubTokenUrl } from '../shared/github-token.js'

const MIN_VALUE = 4
const NONE = {}
const typedKeyName = /^[A-Za-z][\w-]{0,63}$/

export const KeyIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M7 9.5a3.5 3.5 0 1 1 0 .01z' }), h('path', { d: 'M10.4 10.6L17 10.6M14.5 10.6v2.4M16.6 10.6v1.8' }))
const LockIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M6.5 9V7a3.5 3.5 0 0 1 7 0v2' }), h('rect', { x: 4.5, y: 9, width: 11, height: 8, rx: 2 }))
const WarnIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M10 3.5l7 12.5H3z' }), h('path', { d: 'M10 8.5v3.5M10 14.2h.01' }))

// Password managers ignore a text field masked by CSS, so it never offers to save the
// key; browsers without that CSS fall back to a new-password field.
const MASK_BY_CSS = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')

// RFC 0034 Q10: only a page on this computer unlocks; Pocket and remote pages may approve only.
const insecure = () => typeof location !== 'undefined'
  && !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(location.hostname)

const scopeLabel = (scope, roster) => {
  if (scope === 'all') return t('All Bots')
  const names = (scope ?? []).map(id => roster.byId[id]?.name).filter(Boolean)
  return names.length === 0 ? t('No Bot') : names.join(t(' and '))
}
const when = time => (Number.isFinite(time) ? new Date(time).toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

export function MaskedInput({ value, onChange, onEnter, label, inputRef, autoFocus = false, disabled = false, passwordType = false }) {
  const maskByCss = MASK_BY_CSS && !passwordType
  return h('input', {
    className: 'bt-secret-input',
    type: maskByCss ? 'text' : 'password',
    disabled,
    'data-masked': maskByCss ? '' : undefined,
    value,
    ref: inputRef,
    autoFocus,
    autoComplete: maskByCss ? 'off' : 'new-password',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    spellCheck: false,
    'data-1p-ignore': '',
    'data-lpignore': 'true',
    'data-bwignore': '',
    'data-form-type': 'other',
    'aria-label': label,
    placeholder: label ?? t('Paste or type the key'),
    onChange: onChange === undefined ? undefined : event => onChange(event.target.value),
    onKeyDown: (event) => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
      event.preventDefault()
      onEnter?.()
    },
  })
}

function ScopeSwitch({ value, onChange, bot }) {
  const options = [['all', t('All Bots')], ['bot', t('Only {name}', { name: bot.name })]]
  return h('div', { className: 'bt-secret-scope', role: 'radiogroup', 'aria-label': t('Who may use it') },
    h('span', { className: 'bt-secret-glide', 'data-at': value === 'all' ? 0 : 1, 'aria-hidden': true }),
    options.map(([id, text]) => h('button', {
      key: id, type: 'button', role: 'radio', 'aria-checked': value === id, className: 'bt-secret-seg', onClick: () => onChange(id),
    }, text)))
}

function SecretHead({ bot, title, detail, name, onClose }) {
  return h('div', { className: 'bt-q-head bt-secret-head' },
    h('span', { className: 'bt-secret-who' }, h(BotMark, { bot, size: 28 }), h('span', { className: 'bt-secret-lock' }, h(LockIcon))),
    h('div', { className: 'bt-q-text' },
      h('p', { className: 'bt-q-title' }, title),
      h('div', { className: 'bt-q-detail' }, h('code', { className: 'bt-secret-name' }, name), detail ? ` · ${detail}` : '')),
    onClose ? h('button', { type: 'button', className: 'bt-q-x', 'aria-label': t('Cancel the request'), title: t('Cancel'), onClick: onClose }, h(CloseIcon)) : null)
}

// How to make the GitHub token a Bot asked for (#316): GitHub's new fine-grained token page,
// pre-filled with the expiration and the permissions of the declared work, and the fields to
// check there. GitHub's field names stay as GitHub shows them; the sentences are translated.
export function GitHubSteps({ bot, work }) {
  return h('div', { className: 'bt-secret-steps', role: 'note' },
    h('ol', null,
      h('li', null, h('a', { href: githubTokenUrl(work), target: '_blank', rel: 'noopener noreferrer' }, t("Open GitHub's new fine-grained token page."))),
      h('li', null, t('Under “{field}”, choose “{value}”.', { field: GITHUB_FIELDS.expiration, value: GITHUB_FIELDS.days })),
      h('li', null, t('Under “{field}”, choose “{value}” and pick the ones {bot} works on.', { field: GITHUB_FIELDS.repositoryAccess, value: GITHUB_FIELDS.onlySelected, bot: bot.name })),
      h('li', null, t('Under “{field}”, set only these:', { field: GITHUB_FIELDS.permissions }),
        h('ul', null, githubPermissions(work).map(entry => h('li', { key: entry.name }, h('code', null, `${entry.label}: ${entry.access}`))))),
      h('li', null, t('Click “{button}”, copy it and paste it below.', { button: GITHUB_FIELDS.generate }))))
}

const vaultLocked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const vaultDetailUnavailable = 'The vault item details could not be loaded.'

const GNOME_PROVIDER_ID = 'secret-service'
const GNOME_PROVIDER_LABEL = 'Secret Service (GNOME Keyring)'
const createdLabel = created => {
  const time = new Date(Number(created) * 1000)
  return t('Created: {time}', { time: Number.isFinite(time.getTime()) ? time.toISOString() : created })
}

function VaultRequestContext({ request }) {
  return h('div', { className: 'bt-secret-body' },
    h('div', { className: 'bt-secret-saved' }, h(KeyIcon), t('From a vault')),
    h('div', { className: 'bt-secret-note' }, t('Shell: {shell}', { shell: request.shell })),
    h('div', { className: 'bt-secret-note' }, t('Folder: {folder}', { folder: request.workdir })),
    h('pre', { className: 'bt-aa-pre', tabIndex: 0, 'aria-label': t('Command') }, h('code', null, request.command)))
}

export function SecretCard({ sessionId, bot, request, roster, actions, inline = false }) {
  const [value, setValue] = useState('')
  const [scope, setScope] = useState('all')
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [vaultDetail, setVaultDetail] = useState(null)
  const busyRef = useRef(false)
  const hold = useDockHold(sessionId, 'secret', request.id, actions, inline)
  const noteId = useId()
  const vault = request.source === 'vault'
  const detailKey = vault ? JSON.stringify([request.id, request.name, request.sessionId, request.commandDigest, request.shell, request.workdir, request.command]) : null
  const detail = vaultDetail?.key === detailKey ? vaultDetail : null
  const displayed = useRef({ id: request.id, key: detailKey, digest: request.commandDigest })
  const fetchDetail = actions.secretSourceDetail
  useEffect(() => {
    const { id, key, digest } = displayed.current
    if (key === null) return
    let active = true
    Promise.resolve().then(() => fetchDetail(id)).then(value => {
      if (!active) return
      const { commandDigest, snapshot, provider, item, field, name, collection, created } = value ?? {}
      let verified = commandDigest === digest && [commandDigest, snapshot, provider, field].every(part => typeof part === 'string')
      let displayItem = item
      if (provider === GNOME_PROVIDER_ID) {
        verified &&= field === 'secret' && [name, collection, created].every(part => typeof part === 'string')
        displayItem = name
      } else verified &&= typeof item === 'string'
      if (verified && provider === 'hashicorp-vault') {
        try {
          const parts = JSON.parse(item)
          verified = Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string' && part !== '')
          if (verified) displayItem = parts.join('/')
        } catch { verified = false }
      }
      setVaultDetail(verified ? { key, value: { commandDigest, snapshot, provider, item: displayItem, field, collection, created } } : { key, error: vaultDetailUnavailable })
    }, () => {
      if (active) setVaultDetail({ key, error: vaultDetailUnavailable })
    })
    return () => { active = false }
  }, [fetchDetail])
  const secret = (roster.secrets ?? []).find(entry => entry.name === request.name)
  const run = (make) => {
    if (busyRef.current) return undefined
    hold()
    busyRef.current = true
    setBusy(true)
    setError('')
    return Promise.resolve().then(make).then(() => setValue(''), failure => setError(failure?.message ?? String(failure))).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }
  const cancel = () => run(() => actions.secretCancel(request.id))
  if (vault) {
    const item = detail?.value
    const hashicorp = item?.provider === 'hashicorp-vault'
    const keyring = item?.provider === GNOME_PROVIDER_ID
    const proton = item?.provider === 'proton-pass'
    const allow = () => {
      if (item && !busy) void run(() => actions.secretAllow(request.id, { commandDigest: item.commandDigest, snapshot: item.snapshot }))
    }
    return h('div', { className: 'bt-q bt-secret', role: 'group', onFocusCapture: hold, onPointerDownCapture: hold },
      h(SecretHead, {
        bot, title: t('Let {bot} use {name}?', { bot: bot.name, name: request.name }),
        name: request.name, detail: request.purpose, onClose: busy ? undefined : cancel,
      }),
      h(VaultRequestContext, { request }),
      item ? h('div', { className: 'bt-secret-note' },
        h('div', null, t('Provider: {provider}', { provider: keyring ? t(GNOME_PROVIDER_LABEL) : hashicorp ? t('HashiCorp Vault') : proton ? t('Proton Pass') : item.provider })),
        h('div', null, t('Item: {item}', { item: item.item })),
        keyring ? h('div', null, t('Collection: {collection}', { collection: item.collection })) : null,
        keyring ? h('div', null, createdLabel(item.created)) : null,
        h('div', null, t('Field: {field}', { field: keyring ? t('Secret') : item.field }))) : null,
      error || detail?.error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error || t(detail.error)) : null,
      h('div', { className: 'bt-q-actions' },
        h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: cancel }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-q-submit', disabled: busy || !item, onClick: allow }, busy ? t('Allowing…') : t('Allow'))))
  }
  const long = value.trim().length >= MIN_VALUE
  const save = () => { if (long && !busy) void run(() => actions.secretSet({ requestId: request.id, value, scope })) }
  const allow = () => { if (!busy) void run(() => actions.secretAllow(request.id)) }
  const filling = request.kind === 'fill' || replacing
  const warn = insecure() ? h('div', { className: 'bt-secret-warn', role: 'note' }, h(WarnIcon), t('This page is not on HTTPS: the key crosses the network unencrypted.')) : null
  return h('div', { className: 'bt-q bt-secret', role: 'group', 'aria-describedby': noteId, 'data-kind': request.kind, onFocusCapture: hold, onPointerDownCapture: hold },
    h(SecretHead, {
      bot,
      title: request.kind === 'allow' ? t('Let {bot} use {name}?', { bot: bot.name, name: request.name }) : t('{name} needs a key', { name: bot.name }),
      detail: request.purpose,
      name: request.name,
      onClose: busy ? undefined : cancel,
    }),
    filling && Array.isArray(request.github) && request.github.length > 0 ? h(GitHubSteps, { bot, work: request.github }) : null,
    request.kind === 'allow' ? h('div', { className: 'bt-secret-saved' }, h(KeyIcon), t('Saved for {scope}', { scope: scopeLabel(secret?.scope, roster) })) : null,
    filling ? h('div', { className: 'bt-secret-body' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: next => { hold(); setValue(next) }, onEnter: save, label: t('Value of {name}', { name: request.name }), autoFocus: replacing })),
      request.kind === 'fill' ? h(ScopeSwitch, { value: scope, onChange: next => { hold(); setScope(next) }, bot }) : null) : null,
    h('div', { className: 'bt-secret-note', id: noteId },
      t("{bot} never sees the value. It reaches {bot}'s shell as ", { bot: bot.name }), h('code', null, `$DSH_SECRET_${request.name}`), '.',
      filling && value !== '' && !long ? t(' At least {count} characters.', { count: MIN_VALUE }) : ''),
    warn,
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      request.kind === 'allow' && !replacing ? h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => { hold(); setReplacing(true) } }, t('Replace value')) : null,
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: cancel }, t('Cancel')),
      filling
        ? h('button', { type: 'button', className: 'bt-q-submit', disabled: !long || busy, onClick: save }, busy ? t('Saving…') : t('Save'))
        : h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: allow }, busy ? t('Allowing…') : t('Allow'))))
}

function SettledSecret({ bot, request, roster }) {
  if (request.source === 'vault') {
    const title = request.status === 'allowed' ? t('Allowed once')
      : request.status === 'locked' ? t(vaultLocked) : t('Canceled')
    return h('div', { className: 'bt-q bt-q-settled bt-secret bt-secret-done', role: 'group', 'data-status': request.status },
      h(SecretHead, { bot, title, name: request.name, detail: request.purpose }),
      h(VaultRequestContext, { request }))
  }
  const canceled = request.status === 'canceled'
  const text = canceled ? t('{bot} asked for {name}', { bot: bot.name, name: request.name })
    : request.status === 'allowed' ? t('Allowed {bot} to use {name}', { bot: bot.name, name: request.name })
      : t('Saved {name}', { name: request.name })
  return h('div', { className: 'bt-q bt-q-settled bt-secret bt-secret-done', role: 'group', 'aria-label': text, 'data-status': request.status },
    h('div', { className: 'bt-q-head' },
      h('span', { className: 'bt-secret-who' }, h(BotMark, { bot, size: 22 })),
      h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, text,
        canceled ? null : h('span', { className: 'bt-secret-scope-tag' }, ` · ${scopeLabel(request.scope, roster)}`))),
      canceled ? h('span', { className: 'bt-q-badge' }, t('Canceled')) : h('span', { className: 'bt-q-check bt-secret-check', title: t('Done') }, h(CheckIcon))))
}

function RequestView({ sessionId, bot, request, roster, actions }) {
  return request.status === 'pending'
    ? h(SecretCard, { key: JSON.stringify([sessionId, request.id, request.kind]), sessionId, bot, request, roster, actions, inline: true })
    : h(SettledSecret, { bot, request, roster })
}

// The card at its request_secret call; a key that was already there gets one line.
export function SecretToolCell({ sessionId, callId, name, done, content, roster, actions, heldCards = NONE }) {
  const bot = roster.byId[sessionId]
  if (!bot) return h(CellEmpty)
  // Call ids repeat across a Bot's chat parts.
  const request = (roster.secretRequests?.[bot.id] ?? []).find(entry => entry.callId === callId && (entry.sessionId ?? sessionId) === sessionId)
  if (request?.status === 'pending' && heldCards[heldCardKey('secret', request.id)] > 0) return h(CellEmpty)
  if (request) return h('div', { className: 'bt-q-inline' }, h(RequestView, { sessionId, bot, request, roster, actions }))
  if (done && /already saved/.test(contentText(content))) {
    return h('div', { className: 'bt-event' }, h('span', { className: 'bt-secret-event' }, h(KeyIcon), t('{bot} is using {name}', { bot: bot.name, name: name ?? t('a saved key') })))
  }
  // A read-only window shows no card, so the refusal is said in one line, or the Bot
  // just trails off with nothing on screen.
  if (done && contentText(content).startsWith('No card can be shown now')) {
    return h('div', { className: 'bt-event' }, h('span', { className: 'bt-secret-event' }, h(KeyIcon), t('{bot} could not ask for a key: this window can only view the team', { bot: bot.name })))
  }
  return h(CellEmpty)
}

// A card whose call the transcript does not draw (an earlier part of the chat, a
// hidden turn, a call outside the loaded history) waits above the composer instead.
// Once editing starts it keeps that component until completion or cancellation.
export function SecretDock({ sessionId, useRoster, useCards, useHeldCards, actions }) {
  const roster = useRoster(value => value)
  const shown = useCards?.(state => state[sessionId]) ?? NONE
  const held = useHeldCards?.(state => state[sessionId]) ?? NONE
  const bot = roster.byId[sessionId]
  if (!bot || currentPart(bot) !== sessionId) return null
  const drawn = entry => entry.callId && entry.sessionId === sessionId && shown[entry.callId] > 0 && !(held[heldCardKey('secret', entry.id)] > 0)
  const waiting = (roster.secretRequests?.[bot.id] ?? []).filter(entry => entry.status === 'pending' && !drawn(entry))
  if (waiting.length === 0) return null
  return h('div', { className: 'bt-q-dock bt-secret-dock' }, waiting.map(request => h(SecretCard, { key: JSON.stringify([sessionId, request.id, request.kind]), sessionId, bot, request, roster, actions })))
}

// -------------------------------------------------------------------------
// Settings page

function ScopeEditor({ secret, roster, onSave, onChange }) {
  const [mode, setMode] = useState(secret.scope === 'all' ? 'all' : 'some')
  const [picked, setPicked] = useState(secret.scope === 'all' ? [] : secret.scope)
  const id = useId()
  const toggle = botId => {
    const next = picked.includes(botId) ? picked.filter(item => item !== botId) : [...picked, botId]
    setPicked(next)
    onChange?.(next)
  }
  const choose = next => {
    setMode(next)
    onChange?.(next === 'all' ? 'all' : picked)
  }
  const same = mode === 'all' ? secret.scope === 'all' : secret.scope !== 'all' && [...picked].sort().join() === [...secret.scope].sort().join()
  const label = onChange ? t('Who may ask') : t('Who may use it')
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, label),
    h('div', { className: 'bt-secret-radios', role: 'radiogroup', 'aria-label': onChange ? label : t('Who may use {name}', { name: secret.name }) },
      [['all', t('All Bots')], ['some', t('Chosen Bots')]].map(([choice, text]) => h('label', { key: choice, className: 'bt-secret-radio' },
        h('input', { type: 'radio', name: `scope-${id}`, checked: mode === choice, onChange: () => choose(choice) }), text))),
    mode === 'some' ? h('div', { className: 'bt-secret-bots' }, roster.bots.map(bot => h('button', {
      key: bot.id, type: 'button', className: 'bt-secret-bot', 'aria-pressed': picked.includes(bot.id), onClick: () => toggle(bot.id),
    }, h(BotAvatar, { bot, size: 20, badge: false, live: false }), bot.name, picked.includes(bot.id) ? h(CheckIcon) : null))) : null,
    onSave ? h('div', { className: 'bt-secret-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: same, onClick: () => onSave(mode === 'all' ? 'all' : picked) }, t('Save access'))) : null)
}

function PurposeEditor({ secret, onSave }) {
  const [purpose, setPurpose] = useState(secret.purpose ?? '')
  const same = purpose.trim() === (secret.purpose ?? '')
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, t('What it is for')),
    h('div', { className: 'bt-secret-inline' },
      h('input', { className: 'bt-input', 'aria-label': t('What it is for'), placeholder: t('What it is for'), value: purpose, spellCheck: false, autoComplete: 'off', onChange: event => setPurpose(event.target.value) }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: same, onClick: () => onSave(purpose.trim()) }, t('Save'))))
}

function ValueEditor({ secret, onSave }) {
  const [value, setValue] = useState('')
  const [replaced, setReplaced] = useState(false)
  const long = value.trim().length >= MIN_VALUE
  const save = () => {
    if (!long) return
    void Promise.resolve(onSave(value)).then(ok => { if (ok) { setValue(''); setReplaced(true) } })
  }
  const edit = next => { setValue(next); setReplaced(false) }
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, t('Replace the value')),
    h('div', { className: 'bt-secret-inline' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: edit, onEnter: save, label: t('New value of {name}', { name: secret.name }) })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !long, onClick: save }, t('Replace'))),
    value !== '' && !long ? h('div', { className: 'bt-set-hint' }, t('At least {count} characters.', { count: MIN_VALUE }))
      : replaced ? h('div', { className: 'bt-set-hint bt-secret-ok', role: 'status' }, h(CheckIcon), t('Replaced. Bots get the new value from their next command.')) : null)
}

export function SecretRow({ secret, roster, actions, run, open, onToggle }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { if (!open) setConfirm(false) }, [open])
  const asker = secret.requestedBy ? roster.byId[secret.requestedBy]?.name ?? t('a deleted Bot') : t('you')
  const allowed = secret.scope === 'all' ? [] : secret.scope.map(id => roster.byId[id]).filter(Boolean)
  // A held key is in the list but used nowhere (the loader holds a hand-edited value below
  // the write floor), so the row says why instead of claiming it is merely unused.
  const held = secret.held === true
  const heldLine = t('Held: the saved value is shorter than {count} characters',
    { count: MIN_VALUE })
  const state = held ? heldLine
    : secret.lastUsedAt ? t('last used {time}', { time: when(secret.lastUsedAt) })
      : t('not used yet')
  const meta = [t('Asked by {name}', { name: asker }),
    t('added {time}', { time: when(secret.createdAt) }), state].join(' · ')
  return h('div', { className: 'bt-secret-item', 'data-open': open ? '' : undefined },
    h('button', { type: 'button', className: 'bt-set-row bt-secret-summary', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-secret-title' }, h(KeyIcon), h('code', { className: 'bt-secret-name' }, secret.name), secret.purpose ? h('span', { className: 'bt-secret-purpose' }, secret.purpose) : null),
        h('span', { className: 'bt-set-hint' }, meta)),
      h('span', { className: 'bt-set-control' },
        secret.scope === 'all' ? h('span', { className: 'bt-tag' }, t('All Bots'))
          : allowed.length === 0 ? h('span', { className: 'bt-tag' }, t('No Bot'))
            : h('span', { className: 'bt-secret-faces', title: allowed.map(bot => bot.name).join(', ') }, allowed.slice(0, 5).map(bot => h(BotAvatar, { key: bot.id, bot, size: 20, badge: false, live: false }))))),
    open ? h('div', { className: 'bt-secret-edit' },
      h(ScopeEditor, { key: JSON.stringify(secret.scope), secret, roster, onSave: scope => run(actions.secretUpdate(secret.name, { scope })) }),
      h(PurposeEditor, { key: secret.purpose ?? '', secret, onSave: purpose => run(actions.secretUpdate(secret.name, { purpose })) }),
      held ? h('div', { className: 'bt-secret-warn', role: 'note' }, h(WarnIcon),
        t('Held: nothing uses this key until you save a value of at least {count} characters.',
          { count: MIN_VALUE })) : null,
      h(ValueEditor, { secret, onSave: value => run(actions.secretSet({ name: secret.name, value })) }),
      h('div', { className: 'bt-secret-row-actions' },
        confirm
          ? [
              h('span', { key: 'q', className: 'bt-set-hint' }, t('Delete {name}? Bots lose it at once.', { name: secret.name })),
              h('button', { key: 'no', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(false) }, t('Keep')),
              h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => run(actions.secretDelete(secret.name)) }, t('Delete')),
            ]
          : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => setConfirm(true) }, h(TrashIcon), t('Delete')))) : null)
}

function VaultSourceRow({ source, present, actions, run, open, onToggle }) {
  const [confirm, setConfirm] = useState(null)
  const { name, purpose, definedTwice } = source
  useEffect(() => { setConfirm(null) }, [open, definedTwice])
  const remove = () => run(confirm === 'clear' ? actions.secretSourceClear(name) : actions.secretDelete(name))
    .then(ok => { if (ok) setConfirm(null) })
  return h('div', { className: 'bt-secret-item', 'data-open': open ? '' : undefined },
    h('button', { type: 'button', className: 'bt-set-row bt-secret-summary', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-secret-title' }, h(KeyIcon), h('code', { className: 'bt-secret-name' }, name),
          purpose ? h('span', { className: 'bt-secret-purpose' }, purpose) : null),
        h('span', { className: 'bt-set-hint' }, definedTwice ? t('Defined twice') : present
          ? t("Each use asks you first, in the Bot's chat.") : t('Unavailable: the vault plugin cannot serve it yet'))),
      h('span', { className: 'bt-set-control' }, h('span', { className: 'bt-tag' }, t('From a vault')))),
    open ? h('div', { className: 'bt-secret-edit' },
      definedTwice ? h('div', { className: 'bt-secret-warn', role: 'note' }, h(WarnIcon),
        t('Defined twice: this name is also mapped to a vault item, so no Bot can use it. Delete one of them.')) : null,
      h('div', { className: 'bt-secret-row-actions' },
        confirm === null ? [
          h('button', { key: 'clear', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm('clear') },
            definedTwice ? t('Remove the vault mapping') : t('Remove the mapping')),
          definedTwice ? h('button', { key: 'delete', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => setConfirm('delete') },
            h(TrashIcon), t('Delete the typed key')) : null,
        ] : [
          h('span', { key: 'q', className: 'bt-set-hint' }, confirm === 'clear'
            ? t('Remove the mapping for {name}?', { name }) : t('Delete {name}? Bots lose it at once.', { name })),
          h('button', { key: 'no', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(null) }, t('Keep')),
          h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: remove },
            confirm === 'clear' ? t('Remove the mapping') : t('Delete')),
        ])) : null)
}

function AddSecret({ actions, run, onDone }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [value, setValue] = useState('')
  const ready = typedKeyName.test(name.trim()) && value.trim().length >= MIN_VALUE
  const save = () => {
    if (!ready) return
    void run(actions.secretSet({ name, purpose, value, scope: 'all' })).then(ok => { if (ok) { setValue(''); onDone() } })
  }
  return h('div', { className: 'bt-set-row bt-set-paste bt-secret-add' },
    h('input', { className: 'bt-input', 'aria-label': t('Key name'), placeholder: t('NAME, e.g. GITHUB_TOKEN'), value: name, spellCheck: false, autoComplete: 'off', autoFocus: true, onChange: event => setName(event.target.value.toUpperCase()) }),
    h('input', { className: 'bt-input', 'aria-label': t('What it is for'), placeholder: t('What it is for'), value: purpose, autoComplete: 'off', onChange: event => setPurpose(event.target.value) }),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: setValue, onEnter: save, label: t('Value') })),
    h('div', { className: 'bt-secret-row-actions' },
      h('span', { className: 'bt-set-hint' }, t('New keys are for all Bots; narrow it down afterwards.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !ready, onClick: save }, t('Save key'))))
}

const protonFieldLabels = {
  username: 'Username', email: 'Email', password: 'Password', note: 'Note', cardholder_name: 'Cardholder name',
  number: 'Card number', verification_number: 'Security code', expiration_date: 'Expiration date',
  pin: 'PIN', ssid: 'Wi-Fi name', private_key: 'Private key',
}

function AddVaultKey({ actions, provider, connection, credentialRevision, roster, run, onDone }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState(null)
  const [itemId, setItemId] = useState('')
  const [field, setField] = useState('')
  const [scope, setScope] = useState('all')
  const [busy, setBusy] = useState(false)
  const [mount, setMount] = useState('')
  const [folder, setFolder] = useState('')
  const [fields, setFields] = useState([])
  const [projects, setProjects] = useState(null)
  const [project, setProject] = useState('')
  const keyring = provider === GNOME_PROVIDER_ID
  const item = items?.find(row => itemId !== '' && (keyring ? row.handle : row.id) === itemId && !row.folder)
  const onePassword = provider === 'onepassword'
  const proton = provider === 'proton-pass'
  const hashicorp = provider === 'hashicorp-vault'
  const machineAccount = provider === 'bitwarden-secrets'
  // Providers whose picker search names the provider explicitly (Bitwarden keeps the legacy call).
  const namedSearch = provider === 'onepassword' || provider === GNOME_PROVIDER_ID
  const optionId = row => hashicorp && row.folder ? row.id + '/' : row.id
  const itemOption = (row, index) => {
    if (!keyring) return h('option', { key: optionId(row), value: optionId(row) }, row.name)
    if (row.locked) return h('option', { key: index, disabled: true, value: '' },
      t('{collection} (locked)', { collection: row.collection }))
    const label = t('{item} · {collection}', { item: row.name, collection: row.collection })
    return h('option', { key: row.handle, value: row.handle },
      row.created === undefined ? label : label + ' · ' + createdLabel(row.created))
  }
  const vaults = new Map()
  if (onePassword || proton) for (const row of items ?? []) {
    const id = row.id.split('/')[0]
    if (!vaults.has(id)) vaults.set(id, { name: row.vault, options: [] })
    vaults.get(id).options.push(itemOption(row))
  }
  const fieldLabel = row => {
    if (proton) return t(protonFieldLabels[row.selector])
    if (!onePassword) return row.selector.startsWith('field:') ? row.label : t(row.label)
    if (!item.fields.some(other => other !== row && other.label === row.label)) return row.label
    const section = row.section ?? row.selector
    const suffix = item.fields.some(other => other !== row && other.label === row.label && other.section === section)
      ? row.selector : section
    return t('{label} ({section})', { label: row.label, section: suffix })
  }
  const ready = !busy && typedKeyName.test(name.trim()) && (keyring ? item?.field === 'secret' : hashicorp ? fields.includes(field) : item?.fields.some(row => row.selector === field))
  const resetItems = () => {
    setItems(null)
    setItemId('')
    setField('')
    setFields([])
  }
  const find = async (next = hashicorp ? folder : project) => {
    if (busy) return
    setBusy(true)
    resetItems()
    try {
      // A HashiCorp folder or a Secrets Manager project ('' lists the projects).
      const listed = hashicorp ? actions.vaultItems({ mount, folder: next }, provider)
        : machineAccount ? actions.vaultItems(search, provider, next || undefined)
          : (namedSearch || proton) ? actions.vaultItems(search, provider) : actions.vaultItems(search)
      await run(listed.then(answer => {
        if (machineAccount && !next) setProjects(answer.projects)
        else setItems(answer.items)
      }))
    } finally { setBusy(false) }
  }
  const selectItem = async event => {
    const id = event.target.value
    setItemId(id)
    setField('')
    if (!hashicorp) return
    setFields([])
    const row = items.find(item => optionId(item) === id)
    if (!row) return
    if (row.folder) {
      setFolder(row.id)
      await find(row.id)
      return
    }
    setBusy(true)
    try { await run(actions.vaultFields(provider, mount, id).then(answer => setFields(answer.fields))) }
    finally { setBusy(false) }
  }
  const save = async () => {
    if (!ready) return
    setBusy(true)
    try {
      const key = name.trim().replace(/-/g, '_')
      const mapping = keyring ? { name: key, purpose, scope, provider, handle: itemId }
        : { name: key, purpose, connection, item: hashicorp ? JSON.stringify([mount, itemId]) : itemId, field, scope }
      if (onePassword || hashicorp || proton || machineAccount) mapping.provider = provider
      if (machineAccount) mapping.credentialRevision = credentialRevision
      if (await run(actions.secretSourceSet(mapping))) onDone()
    } finally { setBusy(false) }
  }
  return h('div', { className: 'bt-set-row bt-set-paste bt-secret-add' },
    h('input', { className: 'bt-input', 'aria-label': t('Key name'), placeholder: t('NAME, e.g. GITHUB_TOKEN'), value: name, spellCheck: false, autoComplete: 'off', autoFocus: true, onChange: event => setName(event.target.value.toUpperCase()) }),
    h('input', { className: 'bt-input', 'aria-label': t('What it is for'), placeholder: t('What it is for'), value: purpose, autoComplete: 'off', onChange: event => setPurpose(event.target.value) }),
    machineAccount && projects === null ? h('button', {
      type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => find(''),
    }, t('List projects')) : null,
    machineAccount && projects !== null ? h('select', {
      className: 'bt-input', 'aria-label': t('Vault project'), value: project, disabled: busy,
      onChange: event => { const selected = event.target.value; setProject(selected); void find(selected) },
    }, h('option', { value: '' }, t('Choose a project')), projects.map(row => h('option', { key: row.id, value: row.id }, row.name))) : null,
    (!machineAccount || project) ? h('form', { className: 'bt-secret-inline', onSubmit: event => { event.preventDefault(); return find() } },
      hashicorp ? [
        h('input', { key: 'mount', className: 'bt-input', 'aria-label': t('Vault mount'), placeholder: t('Vault mount'), value: mount,
          disabled: busy, spellCheck: false, autoComplete: 'off', onChange: event => { setMount(event.target.value); setFolder(''); resetItems() } }),
        h('input', { key: 'folder', className: 'bt-input', 'aria-label': t('Vault folder (optional)'), placeholder: t('Vault folder (optional)'), value: folder,
          disabled: busy, spellCheck: false, autoComplete: 'off', onChange: event => { setFolder(event.target.value); resetItems() } }),
      ] : h('input', { className: 'bt-input', type: 'search', 'aria-label': t('Search the vault'), placeholder: t('Search the vault'), value: search, autoComplete: 'off', onChange: event => setSearch(event.target.value) }),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy || (hashicorp && !mount) }, t(hashicorp ? 'Browse' : 'Search'))) : null,
    items?.length === 0 ? h('span', { className: 'bt-set-hint', role: 'status' }, t('No matching vault items.')) : null,
    items?.length > 0 ? h('select', {
      className: 'bt-input', 'aria-label': t('Vault item'), value: itemId,
      disabled: hashicorp ? busy : undefined, onChange: selectItem,
    }, h('option', { value: '' }, t('Choose an item')),
    (onePassword || proton) ? [...vaults].map(([id, { name, options }]) => h('optgroup', { key: id, label: name }, options))
      : items.map(itemOption)) : null,
    item && !keyring ? h('select', {
      className: 'bt-input', 'aria-label': t('Vault field'), value: field, onChange: event => setField(event.target.value),
    }, h('option', { value: '' }, t('Choose a field')),
    hashicorp ? fields.map(id => h('option', { key: id, value: id },
      /^\s|\s$|[\t\r\n]| {2}/.test(id) ? JSON.stringify(id).replace(/ /g, '\u00a0') : id))
      : item.fields.map(row => h('option', { key: row.selector, value: row.selector }, fieldLabel(row)))) : null,
    h(ScopeEditor, { secret: { scope: 'all' }, roster, onChange: setScope }),
    h('div', { className: 'bt-secret-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !ready, onClick: save }, t('Save key'))))
}

const vaultStates = {
  unlocked: 'Unlocked',
  locked: 'Locked',
  unauthenticated: 'Not signed in to Bitwarden CLI',
  unavailable: 'The vault did not answer.',
}
// Built from [id, label] pairs so no provider id reads as a credential key in the bundle.
const vaultProviders = Object.fromEntries([
  ['bitwarden', 'Bitwarden'], ['onepassword', '1Password'], ['hashicorp-vault', 'HashiCorp Vault'],
  [GNOME_PROVIDER_ID, GNOME_PROVIDER_LABEL], ['proton-pass', 'Proton Pass'], ['bitwarden-secrets', 'Bitwarden Secrets Manager'],
])

function VaultSection({ roster, actions, run, Section }) {
  const [status, setStatus] = useState(null)
  const [choice, setChoice] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [server, setServer] = useState('us')
  const [connectionLabel, setConnectionLabel] = useState(undefined)
  const password = useRef(null)
  const address = useRef(null)
  const namespace = useRef(null)
  const readOnly = roster.readOnly != null
  const state = readOnly ? 'unavailable' : status?.state
  const connection = status?.connection
  const provider = status?.provider ?? choice ?? 'bitwarden'
  const keyring = provider === GNOME_PROVIDER_ID
  const onePassword = provider === 'onepassword'
  const proton = provider === 'proton-pass'
  const hashicorp = provider === 'hashicorp-vault'
  const machineAccount = provider === 'bitwarden-secrets'
  const connectionKnown = status?.connectionKnown === true
  const target = connectionKnown ? connection : connectionLabel ?? connection
  const credentialRevision = status?.credentialRevision
  const managerStatusKey = machineAccount ? JSON.stringify([state, provider, connection, credentialRevision]) : undefined
  const credentialKey = JSON.stringify(machineAccount ? [managerStatusKey, target, server] : [provider, connection])
  const local = !insecure()
  useEffect(() => {
    if (readOnly || busy || typeof actions.vaultStatus !== 'function') return
    const control = new AbortController()
    let timer
    const refresh = async () => {
      try {
        const answer = await actions.vaultStatus(control.signal, choice)
        if (!control.signal.aborted) setStatus(answer)
      } catch {
        if (!control.signal.aborted) setStatus(previous => ({ ...previous, state: 'unavailable', reason: undefined }))
      }
      if (!control.signal.aborted) timer = setTimeout(refresh, 5000)
    }
    void refresh()
    return () => { control.abort(); clearTimeout(timer) }
  }, [actions, busy, readOnly, refreshKey, choice])
  useEffect(() => { if (state !== 'unlocked' || status?.mismatch) setAdding(false) }, [state, status?.mismatch])
  useEffect(() => {
    if (machineAccount) setAdding(false)
  }, [managerStatusKey, machineAccount])
  useEffect(() => { setServer('us') }, [provider, connection, credentialRevision])
  const changed = () => {
    setStatus(previous => ({ ...previous, state: undefined }))
    setBusy(false)
    setRefreshKey(key => key + 1)
  }
  const clearCredential = () => { if (password.current) password.current.value = '' }
  const choose = event => {
    const next = event.target.value
    clearCredential()
    setAdding(false)
    setConnectionLabel(undefined)
    setStatus(previous => ({ ...previous, provider: next, state: undefined, reason: undefined }))
    setChoice(next)
  }
  const unlock = async () => {
    const input = password.current
    if (busy || (!keyring && !input?.value) || (hashicorp && !address.current?.value) || (machineAccount && !target)) return
    setBusy(true)
    const credential = input?.value
    if (input) input.value = ''
    try {
      if (keyring) await run(actions.vaultUnlockSecretService())
      else if (hashicorp) {
        const endpoint = { address: address.current.value, namespace: namespace.current.value }
        address.current.value = ''
        namespace.current.value = ''
        await run(actions.vaultTokenSet(provider, credential, endpoint))
      } else {
        await run(machineAccount ? actions.vaultTokenSet(provider, credential, target, server, credentialRevision)
          : (onePassword || proton) ? actions.vaultTokenSet(provider, credential, connection) : actions.vaultUnlock(credential, connection))
      }
    } finally { changed() }
  }
  const savedToken = async clear => {
    if (busy || !target) return
    clearCredential()
    setBusy(true)
    setAdding(false)
    try {
      await run(clear ? actions.vaultTokenClear(provider, target, credentialRevision)
        : actions.vaultUnlockSaved(provider, target, credentialRevision))
    } finally { changed() }
  }
  const credentialControls = !readOnly && (state === 'locked' || ((onePassword || hashicorp || proton || machineAccount) && state === 'unlocked')
    || (machineAccount && state === 'unavailable' && status?.reason !== 'Bitwarden Secrets Manager is unavailable in Automagik Cloud.'))
  const lock = async () => {
    if (busy) return
    setBusy(true)
    setAdding(false)
    try { await run(onePassword ? actions.vaultTokenClear(provider) : hashicorp || keyring || proton || machineAccount ? actions.vaultLock(provider) : actions.vaultLock()) }
    finally { changed() }
  }
  return h(Section, { title: t('Vault') },
    status?.providers?.length > 1 ? h('div', { className: 'bt-set-row' },
      h('select', { className: 'bt-input', 'aria-label': t('Vault provider'), value: provider,
        disabled: readOnly || busy || (roster.secretSources?.rows?.length ?? 0) > 0, onChange: choose },
      status.providers.map(id => h('option', { key: id, value: id }, t(vaultProviders[id]))))) : null,
    h('div', { className: 'bt-set-row', role: 'status' },
      h('span', { className: 'bt-tag' }, t(status?.reason ?? vaultStates[state] ?? 'Checking vault status…')),
      h('span', { className: 'bt-set-hint' }, t(keyring
        ? 'Locking here closes Automagik’s access. Manage the keyring lock in GNOME.'
        : hashicorp ? 'The address, namespace and token are cleared when the vault locks or the app quits.'
        : proton ? 'The token is used once to sign in and needs read access to a vault; items shared on their own are not listed. The session ends when the vault locks, after at most 110 minutes, or when the app quits.'
        : onePassword ? 'The token is cleared when the vault locks or the app quits.' : 'The vault locks after the idle time set in the plugin’s settings.')),
      state === 'unlocked' && (!onePassword || local)
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: lock }, t(onePassword ? 'Clear token' : 'Lock')) : null),
    credentialControls && !local ? h('div', { className: 'bt-secret-warn', role: 'note' },
      h(WarnIcon), t('Unlock the vault in Settings on this computer.')) : null,
    machineAccount && credentialControls && local ? h('div', { className: 'bt-set-row' },
      connectionKnown ? h('span', { className: 'bt-set-hint' }, t('Vault connection · {connection}', { connection }))
        : h('input', { className: 'bt-input', 'aria-label': t('Vault connection label'),
          placeholder: t('Vault connection label'), value: target ?? '', disabled: busy, maxLength: 512,
          spellCheck: false, autoComplete: 'off',
          onChange: event => { clearCredential(); setConnectionLabel(event.target.value) } }),
      state !== 'unlocked' && !roster.secretSources?.broken
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !target, onClick: () => savedToken(false) }, t('Unlock')) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !target, onClick: () => savedToken(true) }, t('Clear token'))) : null,
    credentialControls && local && !roster.secretSources?.broken
      ? h('div', { className: 'bt-set-row bt-set-paste', key: hashicorp ? JSON.stringify([provider, connection]) : undefined },
        hashicorp ? [
          h('input', { key: 'address', ref: address, className: 'bt-input', 'aria-label': t('Vault address'), placeholder: t('Vault address'),
            disabled: busy, autoComplete: 'off', spellCheck: false }),
          h('input', { key: 'namespace', ref: namespace, className: 'bt-input', 'aria-label': t('Vault namespace (optional)'),
            placeholder: t('Vault namespace (optional)'), disabled: busy, autoComplete: 'off', spellCheck: false }),
        ] : null,
        machineAccount ? h('input', {
          className: 'bt-input', 'aria-label': t('Server (us, eu, or HTTPS URL)'), placeholder: t('Server (us, eu, or HTTPS URL)'),
          value: server, disabled: busy, spellCheck: false, autoComplete: 'off',
          onChange: event => { clearCredential(); setServer(event.target.value) },
        }) : null,
        keyring ? null : h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, {
          key: credentialKey,
          inputRef: password, disabled: busy, onEnter: unlock, passwordType: hashicorp || proton,
          label: t(hashicorp ? 'Vault token' : proton ? 'Proton Pass personal access token' : machineAccount ? 'Bitwarden Secrets Manager access token'
            : onePassword ? '1Password service account token' : 'Bitwarden master password') })),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || (machineAccount && !target), onClick: unlock },
          t(hashicorp ? 'Connect' : (onePassword || proton || machineAccount) ? (state === 'unlocked' ? 'Replace token' : 'Set token') : 'Unlock'))) : null,
    state === 'unlocked' && !status?.mismatch && !roster.secretSources?.broken
      ? adding ? h(AddVaultKey, { key: managerStatusKey ?? provider + '/' + connection, actions, provider, connection, credentialRevision, roster, run, onDone: () => setAdding(false) })
        : h('div', { className: 'bt-set-row' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setAdding(true) }, t('Add a vault key')))
      : null)
}

export function SecretsPage({ roster, actions, run, Section }) {
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  const sources = roster.secretSources?.rows ?? []
  const mapped = new Set(sources.map(source => source.name))
  const secrets = (roster.secrets ?? []).filter(secret => !mapped.has(secret.name))
  const count = secrets.length + sources.length
  const toggle = name => () => setOpen(open === name ? null : name)
  return [
    h('p', { key: 'about', className: 'bt-secret-about' },
      t('Keys your Bots asked for. Bots never see the values: they use them as '), h('code', null, '$DSH_SECRET_NAME'),
      t(' in their shell, and every value is replaced by '), h('code', null, '[secret:NAME]'), t(' before anything goes to a model.')),
    h(Section, { key: 'list', title: t('Secrets · {count}', { count }) },
      roster.secretSources?.broken ? h('div', { className: 'bt-secret-warn', role: 'note' }, h(WarnIcon),
        t('The vault mapping file could not be read; no secret can be used until it is fixed.')) : null,
      count === 0 && !adding ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No keys yet. When a Bot needs one, it shows a card in its chat.'))) : null,
      secrets.map(secret => h(SecretRow, { key: secret.name, secret, roster, actions, run, open: open === secret.name, onToggle: toggle(secret.name) })),
      sources.map(source => h(VaultSourceRow, { key: source.name, source, present: roster.secretSourcesPresent, actions, run, open: open === source.name, onToggle: toggle(source.name) })),
      adding ? h(AddSecret, { actions, run, onDone: () => setAdding(false) }) : null),
    adding ? null : h('div', { key: 'add', className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setAdding(true) }, t('Add a key'))),
    roster.secretSourcesPresent ? h(VaultSection, { key: 'vault', roster, actions, run, Section }) : null,
  ]
}

export const SECRET_CSS = `
.bt-secret-head{align-items:center;gap:10px}
.bt-secret-who{position:relative;flex:none;display:inline-flex}
.bt-secret-lock{position:absolute;right:-5px;bottom:-4px;width:16px;height:16px;border-radius:50%;background:var(--bt-main);color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px var(--bt-bubble)}
.bt-secret-lock svg{width:11px;height:11px}
.bt-secret-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:16px;padding:1px 6px;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink)}
.bt-secret-body{display:flex;flex-direction:column;gap:8px}
.bt-secret-field{align-items:center;min-height:36px}
.bt-secret-input{flex:1;width:100%;min-width:0;margin:0;padding:0;border:0;outline:none;background:transparent;color:var(--bt-ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;line-height:20px;letter-spacing:.04em}
.bt-secret-input[data-masked]{-webkit-text-security:disc}
.bt-secret-input::placeholder{color:var(--bt-ink-3);font-family:var(--bt-font);letter-spacing:0}
.bt-secret-scope{position:relative;display:inline-grid;grid-template-columns:1fr 1fr;align-self:flex-start;padding:2px;border-radius:999px;background:var(--bt-hover)}
.bt-secret-glide{position:absolute;top:2px;bottom:2px;left:2px;width:calc(50% - 2px);border-radius:999px;background:var(--bt-main);box-shadow:0 1px 3px rgba(20,20,20,.08),inset 0 0 0 .5px color-mix(in srgb,var(--bt-ink) 6%,transparent);transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-secret-glide[data-at="1"]{transform:translateX(100%)}
.bt-secret-seg{position:relative;z-index:1;height:28px;padding:0 14px;border:0;border-radius:999px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer;transition:color .16s ease}
.bt-secret-seg[aria-checked=true]{color:var(--bt-ink);font-weight:500}
.bt-secret-seg:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
/* A key card asks the user to act, so the process group carrying it stays open in every
   work-details mode (same override as .bt-group-replies in styles.js). */
[data-step-process]:has(.bt-secret)>div:first-child{display:none!important}
[data-step-process]:has(.bt-secret)>[data-step-process-body]{display:block!important;content-visibility:visible!important;max-height:none!important;overflow:visible!important;mask-image:none!important;scrollbar-gutter:auto!important}
.bt-secret-ok{display:flex;align-items:center;gap:4px;margin-top:6px;animation:bt-secret-in .22s cubic-bezier(.22,1,.36,1)}
.bt-secret-ok svg{width:13px;height:13px;color:#16a34a}
@keyframes bt-secret-in{from{opacity:0;transform:translateY(-2px)}}
.bt-secret-saved{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-secret-note{font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-secret-steps{font-size:12.5px;line-height:18px;color:var(--bt-ink-2)}
.bt-secret-steps ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:3px}
.bt-secret-steps ul{margin:2px 0 0;padding-left:16px}
.bt-secret-steps a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.bt-secret-steps code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.bt-secret-note code,.bt-secret-about code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.bt-secret-warn{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;font-size:12px;line-height:16px;color:#b25e09;background:color-mix(in srgb,#f59e0b 12%,transparent)}
.bt-secret-error{font-size:12px;line-height:16px;color:var(--st-bad-strong,var(--bt-danger))}
.bt-secret .bt-q-btn:disabled{opacity:.5;cursor:default}
.bt-secret-done .bt-q-head{align-items:center}
.bt-secret-done .bt-q-title{font-size:13px;line-height:18px;color:var(--bt-ink-2);font-weight:500}
.bt-secret-scope-tag{font-weight:400;color:var(--bt-ink-3)}
.bt-secret-check{color:var(--bt-green,#22a06b);animation:bt-secret-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
.bt-secret-done{animation:bt-secret-settle .32s cubic-bezier(.22,1,.36,1) backwards}
@keyframes bt-secret-pop{from{opacity:0;transform:scale(.4)}}
@keyframes bt-secret-settle{from{opacity:.4;transform:scale(.985)}}
.bt-secret-event{display:inline-flex;align-items:center;gap:5px}
.bt-secret-dock{flex-direction:column;align-items:center}
.bt-secret-dock .bt-q{max-width:min(550px,calc(100% - 32px))}
.bt-secret-about{margin:0 0 12px;padding:0 4px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-secret-title{display:flex;align-items:center;gap:6px;min-width:0;color:var(--bt-ink)}
.bt-secret-title svg{flex:none;color:var(--bt-ink-2)}
.bt-secret-purpose{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2)}
.bt-secret-faces{display:inline-flex}
.bt-secret-faces>*+*{margin-left:-6px}
.bt-secret-edit{display:flex;flex-direction:column;gap:14px;padding:4px 12px 14px;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
.bt-secret-edit-block{display:flex;flex-direction:column;gap:8px}
.bt-secret-edit-label{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-secret-radios{display:flex;gap:16px;font-size:13px}
.bt-secret-radio{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.bt-secret-bots{display:flex;flex-wrap:wrap;gap:6px}
.bt-secret-bot{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px 0 5px;border-radius:999px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.bt-secret-bot[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink);border-color:var(--bt-line-2)}
.bt-secret-bot svg{width:13px;height:13px}
.bt-secret-inline{display:flex;gap:8px;align-items:center}
.bt-secret-inline .bt-input{flex:1;height:34px}
.bt-secret-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.bt-secret-row-actions .bt-set-hint{flex:1}
.bt-secret-danger{color:var(--st-bad-strong,var(--bt-danger));display:inline-flex;align-items:center;gap:4px}
.bt-secret-danger svg{width:13px;height:13px}
.bt-secret-add .bt-input{height:34px}
@media (prefers-reduced-motion:reduce){.bt-secret-glide{transition:none}.bt-secret-check,.bt-secret-done,.bt-secret-ok,.bt-secret-edit{animation:none}}
`
