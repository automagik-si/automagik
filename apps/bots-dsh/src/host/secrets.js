// Secrets: keys the user types into a card for a Bot. A value lives only in
// secrets.json (mode 600) and in this process; Bots use it as $DSH_SECRET_<NAME> in
// their shell, tool results lose it before they are saved, and every model request
// has it replaced by [secret:<NAME>] before it leaves.
import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { refusal } from './refusal.js'
import { chmodSync, constants, copyFileSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { chmod, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { GITHUB_TOKEN_DAYS, GITHUB_WORK, cleanGitHubWork, githubPermissions, isGitHubTokenName } from '../shared/github-token.js'
import { replaceFile } from './files.js'
import { output } from './tools.js'
import { envSecretOf } from './connectors/catalog.js'
import { credentialParts } from './connectors/credential-fields.js'
import {
  hashicorp, hashicorpCloud, hashicorpItem, hashicorpItems, hashicorpMismatch,
  validHashicorpConnection, validHashicorpField, validHashicorpMount, validHashicorpPath,
} from './vault-hashicorp.js'
import {
  GNOME_PROVIDER_ID, secretServiceItem, secretServiceHandle, secretServiceRows, secretServiceMessage,
} from './vault-secret-service.js'
import {
  protonPass, protonCloud, protonItems, PROTON_FIELDS, validProtonConnection, validProtonItem, validProtonToken,
} from './vault-proton.js'
import { keychain as macosKeychain, keychainConnection, keychainItem, keychainItems, keychainLookup, keychainReason } from './vault-keychain.js'
import { mentionsWindowsTarget, windowsConnection, windowsCredential, windowsItems, windowsReason, windowsTarget } from './vault-wincred.js'

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
export const ENV_PREFIX = 'DSH_SECRET_'
// A short value (a PIN, a short password) would also hit ordinary words if it were
// replaced wherever it appears, so below WHOLE_VALUE it is replaced only where it
// stands alone: no letter or digit right before or after it.
export const MIN_VALUE = 4
export const WHOLE_VALUE = 8
// A piece of a secret left at a cut edge: shorter pieces (a path segment, a host
// name) are too short to tell from ordinary text.
export const EDGE_MIN = 12
// DSH keeps the last 64,000 bytes of a long tool output, which hold at least 16,000
// UTF-16 units: a string that long may be such a kept tail, so a value piece that opens
// it (of at least MIN_VALUE characters) is replaced even without a truncation notice.
const TAIL_FLOOR = 64_000 / 4
const STDERR = '[stderr]\n'
const TRUNCATED = '\n[output truncated'
export const MAX_VALUE = 16384
const MAX_REQUESTS = 20
const USED_SAVE_MS = 5000
const VAULT_STATUS_MS = 5000
const VAULT_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OP_ITEM_ID = /^[a-z0-9]{26}\/[a-z0-9]{26}$/
const OP_FIELD_ID = /^(?:[A-Za-z0-9_-]{1,128}\/)?[A-Za-z0-9_-]{1,128}$/
const GRANT_MS = 10 * 60_000
const AUDIT_LIMIT = 1024 * 1024

export const envName = name => `${ENV_PREFIX}${name}`
// A secret scoped to one Session (`session`, set by a Session mount, capabilities.js
// mountCapability) is never a Bot's, whatever its Bot list says.
export const canUse = (secret, botId) => secret !== undefined && botId !== undefined && secret.session === undefined
  && (secret.scope === 'all' || (Array.isArray(secret.scope) && secret.scope.includes(botId)))
export const canUseInSession = (secret, sessionId) => secret !== undefined && typeof sessionId === 'string'
  && sessionId !== '' && secret.session === sessionId
// A secret no Bot may use, which a Session mount may scope to its Session.
const forNoBot = secret => Array.isArray(secret?.scope) && secret.scope.length === 0

// A value below the write floor can only reach the store by hand-editing secrets.json, and
// nothing can use it safely: the redactor cannot match a 1-3 character value (it sits inside
// ordinary words), so it would leak wherever it appeared. Such an entry is held instead of
// dropped: it stays in the file and in the list (with a warning naming the floor) and no path
// hands it out, so a hand-edited secret cannot ride along unredactable. Trimming matches the
// write path, which stores the trimmed value.
const held = secret => secret !== undefined && typeof secret.value === 'string' && secret.value.trim().length < MIN_VALUE
const heldReason = name => `Secret ${name} is held: its saved value is shorter than ${MIN_VALUE} characters, so it is never used. Save a new value with at least ${MIN_VALUE} characters.`
const brokenSources = 'The vault mapping file could not be read; no secret can be used until it is fixed.'
const dualSource = name => `${name} is defined both in secrets.json and in vault-sources.json, so it cannot be used. The user must delete one of them in Settings › Secrets.`
const mappedWrite = name => `The name ${name} is mapped to a vault item. A typed value cannot share it; delete the mapping first or use another name.`
const secondConnection = "The first cut supports one vault connection. Remove the other vault's mappings first."
const legacyConnection = 'The first cut supports one Bitwarden connection.'
const cloudVault = '1Password is unavailable in Automagik Cloud.'
const secretsManager = 'bitwarden-secrets'
const cloudSecretsManager = 'Bitwarden Secrets Manager is unavailable in Automagik Cloud.'
const managerChanged = 'The vault connection changed. Check it and try again.'
const managerSetFailed = 'The Bitwarden Secrets Manager access token could not be set.'
const secretsManagerReasons = new Map([
  ['cloud', cloudSecretsManager],
  ['keychain', 'No system keychain.'],
  ['not-saved', 'No saved token for this connection.'],
  ['version', 'Install Bitwarden Secrets Manager CLI 2.x.'],
])
const validReference = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const vaultProviders = ['bitwarden', 'onepassword', hashicorp, GNOME_PROVIDER_ID, protonPass, secretsManager, macosKeychain, windowsCredential]
const typedGateProvider = provider => provider === macosKeychain || provider === windowsCredential
const gateBoundProvider = provider => typedGateProvider(provider) || provider === GNOME_PROVIDER_ID
const typedGateConnection = provider => provider === windowsCredential ? windowsConnection : keychainConnection
const typedGateReason = (provider, code) => provider === windowsCredential ? windowsReason(code)
  : provider === macosKeychain ? keychainReason(code) : undefined
const fencedProvider = provider => provider === hashicorp || provider === protonPass
const protonSetFailed = 'The Proton Pass token could not be set.'
const validProvider = provider => vaultProviders.includes(provider)
const validVaultReference = ({ provider, connection, item, field }) =>
  validProvider(provider) && [connection, item, field].every(validReference)
  && (provider !== 'onepassword' || (OP_ITEM_ID.test(item) && OP_FIELD_ID.test(field)))
  && (provider !== hashicorp || (validHashicorpConnection(connection) && hashicorpItem(item) !== undefined && validHashicorpField(field)))
  && (provider !== GNOME_PROVIDER_ID || (connection === GNOME_PROVIDER_ID && field === 'secret' && secretServiceItem(item) !== undefined))
  && (provider !== protonPass || (connection === protonPass && validProtonItem(item) && PROTON_FIELDS.has(field)))
  && (provider !== secretsManager || (VAULT_ITEM_ID.test(item) && field === 'value'))
  && (provider !== macosKeychain || (connection === keychainConnection && field === 'password' && keychainItem(item) !== undefined))
  && (provider !== windowsCredential || (connection === windowsConnection && field === 'password' && windowsTarget(item)))
const sameConnection = (a, b) => a.provider === b.provider && a.connection === b.connection
const matchesLiveConnection = (service, mapping) => {
  const active = service.activeConnection?.()
  return active === undefined || sameConnection(active, mapping)
}
const supportedProvider = (service, provider) => Array.isArray(service?.providers)
  ? service.providers.includes(provider) : provider === 'bitwarden'
const managerActivationOf = service => service?.activationId?.({ provider: secretsManager })
const matchesManagerActivation = (service, activation) =>
  activation?.id !== undefined && activation.service === service && managerActivationOf(service) === activation.id
const validScope = scope => scope === 'all' || (Array.isArray(scope) && scope.every(id => typeof id === 'string'))
const plainObject = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
const purposeOf = purpose => typeof purpose === 'string' ? purpose.trim().slice(0, 300) : ''
function windowsTargets(rows) {
  const targets = new Set()
  for (const row of rows.values()) if (row.provider === windowsCredential) targets.add(row.item)
  return targets
}
function privateMappingMetadata(rows, editedName, editedPurpose) {
  const targets = windowsTargets(rows)
  for (const [name, row] of rows) {
    const purpose = name === editedName ? editedPurpose : row.purpose
    for (const target of targets) {
      if (mentionsWindowsTarget(name, target) || (typeof purpose === 'string' && mentionsWindowsTarget(purpose, target))) return true
    }
  }
  return false
}
const privateReference = 'PRIVATE_REFERENCE'
const vaultUnavailable = 'The vault did not answer; nothing was read. Ask again when it is available.'
const vaultLocked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const earlierChat = 'This card belongs to an earlier chat; ask again.'
const approvalFailed = 'The approval could not be recorded; nothing was granted. Ask again.'
const groupCard = 'Secret cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_secret there.'
const ownChatCard = 'Secret cards only work in your current own chat.'
const changedMapping = name => `The vault mapping for ${name} changed; ask again.`
const outsideScope = name => `You may not ask for ${name}; the user did not let you ask for it.`
const hash = data => createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex')
const commandDigestOf = (tool, workdir, command) => hash({ v: 1, tool, workdir, command })
const fingerprintOf = ({ provider, connection, item, field, scope }) => hash({ provider, connection, item, field, scope })
const shellTool = name => name === 'bash' || name === 'pwsh'
const grantKey = (botId, sessionId) => JSON.stringify([botId, sessionId])

async function probeVault(service, provider, settings = false) {
  if (!supportedProvider(service, provider)) return undefined
  let timer
  try {
    const answer = await Promise.race([
      new Promise(resolve => { timer = setTimeout(resolve, VAULT_STATUS_MS) }),
      Array.isArray(service.providers) ? service.status({ provider }) : service.status(),
    ])
    if (!plainObject(answer) || Object.keys(answer).some(key => key !== 'state' && key !== 'lastSync')) return undefined
    const { state, lastSync } = answer
    if (lastSync !== undefined && !Number.isFinite(lastSync)) return undefined
    if (state === 'unlocked' || state === 'locked' || state === 'unauthenticated') {
      return { state, ...(lastSync !== undefined ? { lastSync } : {}) }
    }
  } catch (error) {
    if (settings && provider === 'onepassword' && error?.code === 'cloud') {
      return { state: 'unavailable', reason: cloudVault }
    }
    if (settings && provider === hashicorp && error?.code === 'cloud') return { state: 'unavailable', reason: hashicorpCloud }
    if (settings && provider === GNOME_PROVIDER_ID) {
      return { state: 'unavailable', reason: secretServiceMessage(error?.code, 'The vault did not answer.') }
    }
    if (settings && provider === protonPass && error?.code === 'cloud') return { state: 'unavailable', reason: protonCloud }
    const reason = !settings ? undefined : provider === secretsManager ? secretsManagerReasons.get(error?.code)
      : typedGateReason(provider, error?.code)
    if (reason !== undefined) {
      return { state: 'unavailable', reason, ...(provider === windowsCredential && error.code === 'blocked' ? { retry: true } : {}) }
    }
    // The adapter's error may name its account or a vault reference.
  } finally { clearTimeout(timer) }
}
const vaultStatus = async (service, mapping) => {
  if (matchesLiveConnection(service, mapping)) return (await probeVault(service, mapping.provider))?.state
}
const gateOf = service => {
  const gate = service?.providerBinding?.(GNOME_PROVIDER_ID)
  return gate?.provider === GNOME_PROVIDER_ID && Number.isSafeInteger(gate.generation) ? gate : undefined
}
const sameGate = (service, gate) => {
  const current = gateOf(service)
  return gate !== undefined && current === gate
}
const hashicorpConnection = service => {
  const active = service?.activeConnection?.()
  return active?.provider === hashicorp ? active.connection : undefined
}
const defaultVaultProvider = service => {
  const active = service.activeConnection?.()
  return typedGateProvider(active?.provider) || (active?.provider === hashicorp && active.connection !== undefined)
    ? active.provider : 'bitwarden'
}
const wrongHashicorpConnection = (service, mapping) => {
  const active = mapping?.provider === hashicorp ? hashicorpConnection(service) : undefined
  return active !== undefined && active !== mapping.connection
}

function onePasswordPickerFields(rows) {
  const fields = new Map()
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !OP_FIELD_ID.test(row.id) || typeof row.label !== 'string' || !row.label) continue
    fields.set(row.id, { selector: row.id, label: row.label,
      ...(typeof row.section === 'string' && row.section ? { section: row.section } : {}) })
  }
  return [...fields.values()]
}

function pickerField(selector) {
  switch (selector) {
    case 'login.username': return { selector, label: 'Username' }
    case 'login.password': return { selector, label: 'Password' }
    case 'notes': return { selector, label: 'Notes' }
    default:
      if (validReference(selector) && selector.startsWith('field:') && selector.length > 6) {
        return { selector, label: selector.slice(6) }
      }
  }
}

export function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/^\$(env:)?/i, '').replace(/^DSH_SECRET_/i, '').replace(/[\s-]+/g, '_').toUpperCase()
}

// encodeURIComponent leaves ' as is, but new URL() turns it into %27 in a query, so the
// URL sent out would hold a form the redactor does not know. Encoding these characters
// too keeps the sent URL equal to the text the redactor looks for.
export const encodeUrlComponent = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const quotePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Consume escaped backslashes together: \\u is literal text, not a JSON escape.
const formTokens = /%[0-9a-fA-F]{2}|\\(?:u[0-9a-fA-F]{4}|\\)|[\s\S]/g
const hexToken = token => token.length === 3 && token[0] === '%' || token.length === 6 && token.startsWith('\\u')
const hexTokens = /%[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\\\/g
// Lower-cases only the hex digits of %XX and real \uXXXX escapes; the length never changes,
// so an offset in the key is an offset in the text.
const formKey = value => value.replace(hexTokens, token => token === '\\\\' ? token : token.toLowerCase())
const formPattern = value => value.replace(formTokens, token => hexToken(token)
  ? quotePattern(token).replace(/[a-fA-F]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)
  : quotePattern(token))
// A match that opens with a backslash is real only after an even run of backslashes:
// after an odd one, its backslash is the second half of an escaped `\\`.
const escapedAt = (text, index) => {
  let run = 0
  while (index - run > 0 && text[index - run - 1] === '\\') run++
  return run % 2 === 1
}
// The same test for many matches in one text: the backslash runs are counted once, so a
// long run holding many matches stays linear.
const escapedIn = (text) => {
  let runs
  return (index) => {
    if (runs === undefined) {
      runs = new Int32Array(text.length + 1)
      for (let i = 1; i <= text.length; i++) runs[i] = text[i - 1] === '\\' ? runs[i - 1] + 1 : 0
    }
    return runs[index] % 2 === 1
  }
}
// Cut pieces of an encoded form may start or end inside a %XX or \uXXXX token, where
// the token cannot be recognized, so their hex letters are compared in one case.
const foldHex = text => text.replace(/[A-F]/g, c => c.toLowerCase())
// KMP: the longest suffix of `text` that is a proper prefix of `form`, in linear time.
const failure = (form) => {
  const table = new Int32Array(form.length)
  for (let i = 1, k = 0; i < form.length; i++) {
    while (k && form[i] !== form[k]) k = table[k - 1]
    if (form[i] === form[k]) k++
    table[i] = k
  }
  return table
}
const overlap = (form, table, text) => {
  let k = 0
  for (let i = 0; i < text.length; i++) {
    while (k && text[i] !== form[k]) k = table[k - 1]
    if (text[i] === form[k]) k++
    if (k === form.length) k = table[k - 1]
  }
  return k
}
const reverse = text => text.split('').reverse().join('')

// One function that replaces every known value in a string, longest first so a value
// that contains another is replaced whole. JSON-escaped and URL-encoded forms are covered too.
// `wholeWords: false` matches a short value inside a word as well: the global policy keeps the
// lookarounds so a PIN does not hit ordinary words, while a caller that renders only a small,
// already-quoted answer (the capability probe) pays over-redaction instead of leaking an edge.
export function redactor(entries, { wholeWords = true } = {}) {
  const pairs = []
  for (const { name, value } of entries) {
    if (typeof value !== 'string' || value.length < MIN_VALUE) continue
    const label = `[secret:${name}]`
    const short = value.length < WHOLE_VALUE
    const escaped = JSON.stringify(value).slice(1, -1)
    const forms = new Set([value, escaped, escaped.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)])
    // encodeURIComponent throws on a lone surrogate; it cannot sit in a URL anyway.
    if (value.isWellFormed()) {
      forms.add(encodeURIComponent(value))
      forms.add(encodeUrlComponent(value))
    }
    for (const form of forms) pairs.push([form, label, short, form === value])
  }
  pairs.sort((a, b) => b[0].length - a[0].length)
  if (pairs.length === 0) return text => text
  const labels = new Map()
  // An escape-led form (JSON or ASCII JSON starting with `\uXXXX`, `\"`...) is real only
  // after an even run of backslashes; the raw value is taken as it stands.
  const escapeLed = new Set()
  const sources = []
  for (const [value, label, short, raw] of pairs) {
    const key = formKey(value)
    if (!labels.has(key)) labels.set(key, label)
    if (!raw && value.startsWith('\\')) escapeLed.add(key)
    const source = formPattern(value)
    sources.push(short && wholeWords ? `(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])` : source)
  }
  // A form that is another secret's raw value is taken as it stands, whatever precedes it.
  for (const [value, , , raw] of pairs) if (raw) escapeLed.delete(formKey(value))
  // Compiled on first use, so text without a secret never builds it. A pattern too large
  // for the engine falls back to one pattern per form, longest first; its error is never
  // let out, since its message quotes the secrets.
  let patterns
  // V8 compiles a pattern on its first run, so a test run is part of building one.
  const build = (source) => {
    const pattern = new RegExp(source, 'gu')
    pattern.test('')
    return pattern
  }
  const compile = () => {
    if (patterns) return patterns
    try { patterns = [build(sources.join('|'))] } catch {
      // A form whose own pattern is too large is searched literally, in its exact case
      // and with its hex in one case (formKey keeps offsets).
      patterns = sources.map((source, i) => {
        try { return build(source) } catch { return pairs[i][0] }
      })
    }
    return patterns
  }
  const rejected = (escaped, start, match) => match.startsWith('\\') && escapeLed.has(formKey(match)) && escaped(start)
  // Whole matches as [start, end, label]. History also needs overlapping matches.
  const wholeMatches = (text, overlaps = false) => {
    const found = []
    const escaped = escapedIn(text)
    const list = compile()
    const single = list.length === 1 && typeof list[0] !== 'string'
    const take = (start, end, match) => {
      if (!overlaps && !single && found.some(([from, to]) => from < end && start < to)) return
      found.push([start, end, labels.get(formKey(match))])
    }
    let textKey
    for (const pattern of list) {
      if (typeof pattern === 'string') {
        const literal = (source, form) => {
          for (let at = source.indexOf(form); at !== -1; at = source.indexOf(form, at + 1)) {
            const match = text.slice(at, at + form.length)
            if (!rejected(escaped, at, match)) take(at, at + form.length, match)
          }
        }
        literal(text, pattern)
        // Its hex in another case: found with every A-F folded, then kept only where the
        // text differs from the form inside its hex tokens alone.
        textKey ??= foldHex(text)
        const key = formKey(pattern)
        for (let at = textKey.indexOf(foldHex(pattern)); at !== -1; at = textKey.indexOf(foldHex(pattern), at + 1)) {
          const match = text.slice(at, at + pattern.length)
          if (match !== pattern && formKey(match) === key && !rejected(escaped, at, match)) take(at, at + pattern.length, match)
        }
        continue
      }
      pattern.lastIndex = 0
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        // A rejected escape may hide a secret inside it: search again one step on.
        if (rejected(escaped, match.index, match[0])) { pattern.lastIndex = match.index + 1; continue }
        take(match.index, match.index + match[0].length, match[0])
        if (overlaps) pattern.lastIndex = match.index + (text.codePointAt(match.index) > 0xFFFF ? 2 : 1)
      }
    }
    return found.sort((x, y) => x[0] - y[0])
  }
  const rawForms = [...new Set(pairs.map(([form]) => form))]
  const keys = [...labels.keys()]
  // Literal precheck: an exact form, or a form with its hex in another case. Folding
  // every A-F (not only hex tokens, which a stray `%` before a form would misalign) finds
  // a superset of what the pattern matches.
  const foldedForms = [...new Set(keys.map(foldHex))]
  const present = (text) => {
    if (rawForms.some(form => text.includes(form))) return true
    if (!text.includes('%') && !text.includes('\\')) return false
    const folded = foldHex(text)
    return foldedForms.some(form => folded.includes(form))
  }
  // One edge per exact form: two secrets whose forms differ only in case keep both.
  // Every form may open a long kept tail (see TAIL_FLOOR); only a long one (more than
  // EDGE_MIN characters, not short) may leave a piece at a cut edge.
  // A value saved under two names keeps the first name, as whole matches do.
  // A form shared with a longer or raw value keeps that one's cut edges as well.
  const edges = [...pairs.reduce((map, pair) => {
    const known = map.get(pair[0])
    if (known === undefined) return map.set(...edgeOf(pair))
    const [, other] = edgeOf(pair)
    known.short &&= other.short
    known.raw ||= other.raw
    known.cut ||= other.cut
    return map
  }, new Map()).values()]
  function edgeOf([form, label, short, raw]) {
      const folded = formKey(form) !== form || /%[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/.test(form)
      const key = folded ? foldHex(form) : form
      // Hex digits inside the form's %XX and \uXXXX tokens: the only places a cut piece
      // may differ from the form in case.
      const hex = new Uint8Array(form.length)
      for (const token of form.matchAll(/%[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\\\/g)) {
        if (token[0] !== '\\\\') for (let i = token.index + (token[0][0] === '%' ? 1 : 2); i < token.index + token[0].length; i++) hex[i] = 1
      }
      return [form, { key, form, label, raw, short, folded, hex, rev: reverse(key), cut: !short && form.length > EDGE_MIN }]
  }
  const longest = pairs[0][0].length
  const anchors = new Set(edges.filter(edge => edge.cut).flatMap(({ key }) => [key.slice(0, EDGE_MIN), key.slice(-EDGE_MIN)]))
  // Literal anchors, no `u` flag, so an anchor cut inside a surrogate pair still matches.
  const anchorPattern = anchors.size ? new RegExp([...anchors].map(quotePattern).join('|')) : null
  // Every region to replace: whole matches, plus cut pieces at the edges of a cut text.
  // Overlapping regions merge into one, labelled by every secret in it, and text outside
  // them is never reprocessed, so word boundaries stay as they were.
  const regions = (text, cut, overlaps = false) => {
    const found = present(text) ? wholeMatches(text, overlaps) : []
    const long = text.length >= TAIL_FLOOR
    const foldedText = cut || long ? foldHex(text) : ''
    cut = cut && (anchorPattern.test(text) || anchorPattern.test(foldedText))
    if (cut || long) {
      const labelsIn = Array.from(text.matchAll(/\[secret:[^\]\r\n]*\]/g), match => [match.index, match.index + match[0].length])
      // Only where a cut lands: DSH keeps a stream's tail, so a suffix piece opens the
      // text (or the stream after `[stderr]`); a head cut leaves a prefix piece at the
      // end (or before DSH's truncation notice). A byte cut inside a character decodes
      // to up to three U+FFFD first. Pieces elsewhere are ordinary text.
      // Each start is [where the cut lands, where the piece begins]: the replacement
      // characters go with the piece.
      const starts = [0], ends = cut ? [text.length] : []
      if (cut) for (let at = text.indexOf(STDERR); at !== -1; at = text.indexOf(STDERR, at + 1)) starts.push(at + STDERR.length)
      if (cut) for (let at = text.indexOf(TRUNCATED); at !== -1; at = text.indexOf(TRUNCATED, at + 1)) ends.push(at)
      const begins = starts.map((start) => {
        let at = start
        for (let n = 0; n < 3 && text[at] === '\uFFFD'; n++) at++
        return [start, at]
      })
      // Folding matched the piece; outside hex tokens it must match in exact case.
      const exact = (edge, start, size, at) => {
        if (!edge.folded) return true
        for (let i = 0; i < size; i++) {
          if (text[start + i] !== edge.form[at + i] && !edge.hex[at + i]) return false
        }
        return true
      }
      const wholes = found.slice()
      // As in #1237: a whole value that opens a long text is replaced whole; only a longer
      // piece (of another value) may take its place there.
      let openWhole = 0
      if (long) for (const [form] of pairs) if (form.length > openWhole && text.startsWith(form)) openWhole = form.length
      const followed = new Set()
      const offer = (start, end, edge, min = EDGE_MIN, origin = start, opening = false) => {
        if (end - start < min) return
        if (opening) {
          // A whole value that begins inside an opening piece and runs past it would be
          // split by it: the piece stops before it, so the pattern replaces it whole.
          let lo = 0, hi = wholes.length
          while (lo < hi) { const mid = (lo + hi) >> 1; if (wholes[mid][0] <= start) lo = mid + 1; else hi = mid }
          for (let k = lo; k < wholes.length && wholes[k][0] < end; k++) if (wholes[k][1] > end) end = wholes[k][0]
          if (end - start < min) return
        }
        if (!edge.raw && text[start] === '\\' && escapedAt(text, start)) return
        if (labelsIn.some(([from, to]) => from < end && start < to)) return
        found.push([origin, end, edge.label])
        // The text after an opening piece starts where the piece was cut away, as if it
        // began there: a short value right after it stands alone.
        if (opening && !followed.has(end)) {
          followed.add(end)
          // Two more units: the word check after a short value may read a surrogate pair.
          const next = wholeMatches(text.slice(end, end + longest + 2))[0]
          if (next !== undefined && next[0] === 0) found.push([end, end + next[1], next[2]])
        }
      }
      // A short value's piece counts only where it stands alone: a letter or digit right
      // after it is part of a word.
      const word = (edge, end) => !(edge.short && wholeWords && /[\p{L}\p{N}]/u.test(text.charAt(end)))
      for (const edge of edges) {
        if (!edge.cut && !long) continue
        const source = edge.folded ? foldedText : text
        const length = edge.key.length
        for (let i = 0; i < begins.length; i++) {
          const [landed, from] = begins[i]
          // A long text's opening piece may be as short as a value (the tail rule);
          // every other cut edge needs EDGE_MIN characters.
          const opensLong = long && i === 0
          const min = opensLong ? MIN_VALUE : EDGE_MIN
          if (!edge.cut && !opensLong) continue
          const window = source.slice(from, from + length - 1)
          if (window.length < min || !edge.key.includes(window.slice(0, min))) continue
          edge.revTable ??= failure(edge.rev)
          // A border that fails the exact check gives way to the next shorter one.
          let size = overlap(edge.rev, edge.revTable, reverse(window))
          while (size >= min && (!exact(edge, from, size, length - size) || !word(edge, from + size))) size = edge.revTable[size - 1]
          if (opensLong && size <= openWhole) continue
          offer(from, from + size, edge, min, landed, true)
        }
        if (!edge.cut) continue
        for (const to of ends) {
          const window = source.slice(Math.max(0, to - length + 1), to)
          if (!window.includes(edge.key.slice(0, EDGE_MIN))) continue
          edge.table ??= failure(edge.key)
          let size = overlap(edge.key, edge.table, window)
          while (size >= EDGE_MIN && !exact(edge, to - size, size, 0)) size = edge.table[size - 1]
          offer(to - size, to, edge)
        }
      }
    }
    found.sort((x, y) => x[0] - y[0] || y[1] - x[1])
    const merged = []
    for (const [start, end, label] of found) {
      const last = merged.at(-1)
      if (last && start < last[1]) {
        // A region inside another adds nothing; one running past it adds its label.
        if (end > last[1]) {
          last[1] = end
          if (!last[2].includes(label)) last[2].push(label)
        }
      } else merged.push([start, end, [label]])
    }
    return merged
  }
  // Edges count only in text known to be cut: a rendered DSH result carries its notice,
  // and `cut` serves a stream's `{ text, truncated: true }` (see redactDeep).
  const apply = (text, cut) => {
    if (typeof text !== 'string') return text
    const found = regions(text, Boolean(anchorPattern) && (cut || text.includes(TRUNCATED)))
    if (found.length === 0) return text
    const chunks = []
    let cursor = 0
    for (const [start, end, names] of found) {
      chunks.push(text.slice(cursor, start), names.join(''))
      cursor = end
    }
    chunks.push(text.slice(cursor))
    return chunks.join('')
  }
  const redact = text => apply(text, false)
  redact.cut = text => apply(text, true)
  redact.ranges = text => regions(text, Boolean(anchorPattern) && text.includes(TRUNCATED), true)
    .map(([start, end, names]) => [start, end, names.join('')])
  return redact
}

// Maps/sets (including weak), dates, regexps, buffers/views, promises, boxed
// primitives, WeakRefs and functions are opaque, including their subclasses: their
// contents are never walked. JSON still writes an opaque object's own fields (unless it
// has toJSON), so those are redacted, and a String object is written as its text.
const opaquePrototypes = new Set([
  Map, Set, WeakMap, WeakSet, Date, RegExp, ArrayBuffer, SharedArrayBuffer,
  Promise, String, Number, Boolean, BigInt, Symbol, WeakRef, DataView,
].map(type => type.prototype))
opaquePrototypes.add(Object.getPrototypeOf(Uint8Array.prototype))
const opaqueObject = value => types.isMap(value) || types.isSet(value) || types.isWeakMap(value)
  || types.isWeakSet(value) || types.isDate(value) || types.isRegExp(value)
  || types.isAnyArrayBuffer(value) || types.isArrayBufferView(value)
  || types.isPromise(value) || types.isBoxedPrimitive(value)
const builtinToJSON = new Set([Date.prototype.toJSON, Buffer.prototype.toJSON])
const errorFields = new Set(['message', 'stack', 'cause', 'errors'])
const FAST = Object.freeze({ enumerable: true })
const REDACTION_FAILED = '[redacted: redaction failed]'
const arrayIndex = /^(0|[1-9][0-9]{0,9})$/
const isIndex = key => arrayIndex.test(key) && Number(key) < 0xffffffff

// Returns the same reference when nothing changed, so callers can tell cheaply.
export function redactDeep(value, redact) {
  // A redactor that fails must not hand the text back: it may hold a secret.
  const replace = (text, cut = false) => {
    try {
      const result = cut && typeof redact.cut === 'function' ? redact.cut(text) : redact(text)
      return typeof result === 'string' ? result : REDACTION_FAILED
    } catch { return REDACTION_FAILED }
  }
  if (typeof value === 'string') return replace(value)
  const records = new Map()
  const pending = []
  const visit = node => {
    if (node === null || typeof node !== 'object') return null
    if (records.has(node)) return records.get(node)
    const record = { node, parents: [], props: [], dirty: false }
    records.set(node, record)
    pending.push(record)
    return record
  }
  const root = visit(value)
  if (!root) return value
  for (let i = 0; i < pending.length; i++) {
    const record = pending[i]
    const node = record.node
    let props
    try {
      record.proto = Object.getPrototypeOf(node)
      // A URL has no own enumerable field, only its href: a redacted href is rebuilt as a
      // URL where it still parses, and its JSON form (the href string) is redacted either way.
      if (node instanceof URL) {
        const href = node.href
        const replaced = replace(href)
        if (replaced !== href) {
          record.dirty = true
          try { record.replacement = new URL(replaced) } catch { record.replacement = replaced }
        }
        continue
      }
      // A native Error stays an Error whatever its prototype was set to.
      record.error = types.isNativeError(node)
      // A native Map, Date... stays opaque even with a null prototype. Plain objects
      // (most of every payload) skip the check.
      record.opaque = !record.error && record.proto !== Object.prototype && !Array.isArray(node) && opaqueObject(node)
      if (!record.opaque && record.proto !== Object.prototype && record.proto !== Array.prototype && record.proto !== null) {
        const seen = new Set()
        for (let proto = record.proto; proto !== null; proto = Object.getPrototypeOf(proto)) {
          if (seen.has(proto)) throw new TypeError('prototype cycle')
          if (opaquePrototypes.has(proto)) { record.opaque = !record.error; break }
          seen.add(proto)
          if (proto === Error.prototype) record.error = true
        }
      }
      if (record.opaque) {
        if (types.isStringObject(node)) {
          const text = String.prototype.valueOf.call(node)
          const replaced = replace(text)
          if (replaced !== text) { record.dirty = true; record.replacement = new String(replaced) }
          continue
        }
        // A Date or a Buffer writes itself through its built-in toJSON, never its own fields.
        if (types.isBoxedPrimitive(node) && !types.isSymbolObject(node) || builtinToJSON.has(node.toJSON) && !Object.hasOwn(node, 'toJSON')) continue
      }
      record.proxy = types.isProxy(node)
      record.array = Array.isArray(node)
      // Plain data (not a Proxy) is read like JSON: own enumerable keys and their
      // values. Full descriptors are taken only for a node that gets copied.
      if (!record.error && !record.opaque && !record.proxy && (record.proto === Object.prototype || record.proto === Array.prototype || record.proto === null)) {
        record.fast = true
        // Arrays serialize every index, enumerable or not.
        const names = record.array
          ? Object.getOwnPropertyNames(node).filter(key => key !== 'length' && (isIndex(key) || Object.prototype.propertyIsEnumerable.call(node, key)))
          : Object.keys(node)
        props = names.map(key => ({ key, descriptor: FAST }))
      } else if (record.opaque) {
        // Only the own fields JSON writes; a typed array's elements are numbers.
        props = Object.keys(node).filter(key => !(types.isTypedArray(node) && isIndex(key)))
          .map(key => ({ key, descriptor: Object.getOwnPropertyDescriptor(node, key) }))
      } else props = Reflect.ownKeys(node).map(key => ({ key, descriptor: Object.getOwnPropertyDescriptor(node, key) }))
      // A proxy may remove a key between ownKeys and descriptor inspection.
      props = props.filter(prop => prop.descriptor)
      // An Error's message or stack read through its prototype (a subclass getter) is
      // redacted into an own property of the copy, as #1237 reads them directly.
      if (record.error) for (const key of ['message', 'stack']) {
        if (props.some(prop => prop.key === key)) continue
        let item
        try { item = node[key] } catch { continue }
        if (typeof item === 'string') props.push({ key, descriptor: { value: item, enumerable: false, writable: true, configurable: true } })
      }
      if (record.array && !record.fast) {
        record.length = props.find(prop => prop.key === 'length').descriptor
        if (!Number.isInteger(record.length.value) || record.length.value < 0 || record.length.value > 0xffffffff) continue
      }
    } catch { continue }
    record.props = props
    // A DSH output stream `{ text, truncated: true }` was cut, so its text edges count.
    let cut = false
    try { cut = props.some(prop => prop.key === 'truncated') && node.truncated === true } catch {}
    for (const prop of props) {
      const { key, descriptor } = prop
      prop.nextKey = key
      if (typeof key !== 'string' || !(descriptor.enumerable || record.error && errorFields.has(key) || record.array && isIndex(key))) continue
      // Array indices stay: renaming one would drop the element.
      prop.nextKey = record.array && isIndex(key) ? key : replace(key)
      if (prop.nextKey !== key) record.dirty = true
      let item
      // A Proxy is read through its get trap, as JSON reads it.
      try { item = descriptor === FAST || record.proxy ? node[key] : 'value' in descriptor ? descriptor.value : descriptor.get ? Reflect.apply(descriptor.get, node, []) : undefined } catch { continue }
      prop.read = true
      prop.value = typeof item === 'string' ? replace(item, cut && key === 'text') : item
      if (typeof item === 'string' && prop.value !== item) record.dirty = true
      prop.child = visit(item)
      if (prop.child) prop.child.parents.push(record)
    }
  }
  // Propagate through reverse edges before allocating: cycles copy as a unit.
  const dirty = pending.filter(record => record.dirty)
  for (let i = 0; i < dirty.length; i++) {
    for (const parent of dirty[i].parents) {
      if (parent.dirty) continue
      parent.dirty = true
      dirty.push(parent)
    }
  }
  if (!root.dirty) return value
  for (const record of dirty) {
    if (!record.fast) continue
    const node = record.node
    const walked = new Map(record.props.map(prop => [prop.key, prop]))
    record.props = Reflect.ownKeys(node).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      let prop = walked.get(key)
      if (!prop) {
        prop = { key, nextKey: key }
        // A key that appeared after the walk (a getter that caches) is redacted on its own.
        if (typeof key === 'string' && descriptor && 'value' in descriptor && (descriptor.enumerable || record.array && isIndex(key))) {
          prop.nextKey = record.array && isIndex(key) ? key : replace(key)
          prop.read = true
          prop.value = typeof descriptor.value === 'string' ? replace(descriptor.value) : redactDeep(descriptor.value, redact)
        }
      }
      prop.descriptor = descriptor
      return prop
    })
    if (record.array) record.length = Object.getOwnPropertyDescriptor(node, 'length')
  }
  for (const record of dirty) {
    if (record.replacement !== undefined) record.copy = record.replacement
    else if (record.array) {
      record.copy = new Array(record.length.value)
      // An Array subclass keeps its prototype (and so its methods).
      if (record.proto !== Array.prototype) Object.setPrototypeOf(record.copy, record.proto)
    }
    else if (record.error) {
      record.copy = new Error()
      for (const key of Reflect.ownKeys(record.copy)) Reflect.deleteProperty(record.copy, key)
      Object.setPrototypeOf(record.copy, record.proto)
    } else record.copy = Object.create(record.proto)
  }
  // A tool result can arrive deep-frozen: the copy gets fresh writable, configurable
  // properties, so later hooks can still change it. A walked accessor becomes a data
  // property holding the redacted value; any other accessor keeps its getter and setter.
  for (const record of dirty) {
    if (record.replacement !== undefined) continue
    const used = new Set(record.array ? ['length'] : [])
    for (const prop of record.props) {
      if (record.array && prop.key === 'length') continue
      let key = prop.nextKey
      if (typeof key === 'string') {
        let suffix = record.suffixes?.get(prop.nextKey) ?? 2
        const outside = record.array && /^(0|[1-9][0-9]*)$/.test(key)
          && Number(key) < 0xffffffff && Number(key) >= record.length.value
        if (outside) key = `${prop.nextKey}#${suffix++}`
        while (used.has(key)) key = `${prop.nextKey}#${suffix++}`
        // Many keys that redact to one label continue the count instead of starting over.
        if (suffix > 2) (record.suffixes ??= new Map()).set(prop.nextKey, suffix)
      }
      used.add(key)
      const { enumerable, get, set } = prop.descriptor
      const descriptor = prop.read || 'value' in prop.descriptor
        ? { value: prop.read ? (prop.child?.dirty ? prop.child.copy : prop.value) : prop.descriptor.value, enumerable, writable: true, configurable: true }
        : { get, set, enumerable, configurable: true }
      Object.defineProperty(record.copy, key, descriptor)
    }
    if (record.array) Object.defineProperty(record.copy, 'length', { value: record.length.value, writable: true })
  }
  return root.copy
}

// Rebuilt loop requests keep DSH's frozen content and envelope contract.
export function freezeLoopRequest(request) {
  const pending = [request.messages, request.system]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === null || typeof node !== 'object' || Object.isFrozen(node)) continue
    if (node instanceof AbortSignal) continue
    Object.freeze(node)
    for (const child of Object.values(node)) pending.push(child)
  }
  return Object.freeze(request)
}

export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'secrets.json')
  const sourcesPath = join(home, 'vault-sources.json')
  const auditPath = join(home, 'vault-audit.jsonl')

  // `session` is kept beside an empty Bot list, never in `scope`: a version without it reads
  // an unknown scope as every Bot, but reads this entry as no Bot's.
  /** @type {Map<string, {name:string, value:string, purpose:string, scope:'all'|string[], session?:string, requestedBy:string|null, createdAt:number, updatedAt:number, lastUsedAt?:number}>} */
  let secrets = new Map()
  let sources = new Map()
  let sourcesBroken = false
  let sourcesPresent = false
  let secretSources
  let credentialGeneration = new AbortController()
  const typedGateEntries = new Map([macosKeychain, windowsCredential].map(provider => [provider, new AbortController()]))
  let credentialSelection
  let vaultExecutionInstalled = false
  const vaultRequests = new Map()
  const snapshots = new Map()
  const approving = new Set()
  const grants = new Map()
  let sourcesSnapshot
  let typedStamp
  // A value from a dual name may already have reached a consumer. Keep masking it
  // for this process even after either stored definition is removed.
  const dualValues = new Map()
  let loaded = null
  let writing = Promise.resolve()
  let mutations
  let redact = text => text
  let redactAnywhere = text => text
  let savedRedactionEntries = []
  let outputRedaction
  let refreshEnv = () => {}
  let stopped = false

  const redactorForOutput = () => {
    const connectorFields = Object.entries(state.connectors ?? {}).map(([id, saved]) => [id, saved?.custom?.headers, saved?.custom?.env])
    const connectorKey = JSON.stringify(connectorFields)
    if (outputRedaction !== undefined && outputRedaction.connectorKey === connectorKey) return outputRedaction.redact
    // Credential-like connector fields are only used to mask tool and model output.
    const entries = []
    for (const [id, headers, env] of connectorFields) {
      for (const [kind, fields, prefix] of [['headers', headers, 'HEAD_'], ['env', env, '']]) {
        for (const [key, value] of Object.entries(fields ?? {})) {
          const name = envSecretOf(id, `${prefix}${key}`)
          for (const { forms } of credentialParts(kind, key, value)) {
            for (const form of forms ?? []) entries.push({ name, value: form })
          }
        }
      }
    }
    const mask = entries.length > 0 ? redactor([...savedRedactionEntries, ...entries]) : savedRedactionEntries.length > 0 ? redact : undefined
    outputRedaction = { connectorKey, redact: mask }
    return mask
  }

  const changed = () => {
    for (const name of sources.keys()) {
      const entry = secrets.get(name)
      if (entry !== undefined && !dualValues.has(entry.value)) dualValues.set(entry.value, name)
    }
    const entries = [...secrets.values()]
    for (const [value, name] of dualValues) {
      if (secrets.get(name)?.value !== value) entries.push({ name, value })
    }
    redact = redactor(entries)
    redactAnywhere = redactor(entries, { wholeWords: false })
    savedRedactionEntries = entries
    outputRedaction = undefined
    refreshEnv()
    return rt.secretsChanged?.()
  }

  // Error messages from JSON.parse quote the file, so only the code or name is logged.
  const reason = error => error?.code ?? error?.name ?? 'error'
  const unavailable = name => sourcesBroken || sources.has(name)
  const sourceReason = (name) => {
    if (sourcesBroken) return brokenSources
    if (!sources.has(name)) return undefined
    if (secrets.has(name)) return dualSource(name)
    return sourcesPresent
      ? `${name} comes from a vault, and this version of the Bot team cannot use vault secrets yet.`
      : `${name} is unavailable because the vault plugin is off.`
  }
  const secretHeldReason = name => sourceReason(name) ?? (held(secrets.get(name)) ? heldReason(name) : undefined)
  const refuseTypedWrite = (name) => {
    if (unavailable(name)) throw refusal(sourcesBroken ? brokenSources : mappedWrite(name))
  }
  function advanceCredentialGeneration() {
    const previous = credentialGeneration
    credentialGeneration = new AbortController()
    previous.abort()
  }

  function cancelTypedGateEntry(provider) {
    typedGateEntries.get(provider).abort()
    typedGateEntries.set(provider, new AbortController())
  }

  function attachVault(service) {
    if (service === undefined) return
    if (secretSources !== service) {
      cancelTypedGateEntry(windowsCredential)
      advanceCredentialGeneration()
      credentialSelection = service.providerSelection
    }
    secretSources = service
    sourcesPresent = true
    // Keep the handoff on the host once a grant can be issued, even if the adapter
    // later goes away. An existing grant still consumes and refuses the next attempt.
    if (!vaultExecutionInstalled) {
      ctx.on('tools/execute', refuseVaultExecution, { prepend: true })
      vaultExecutionInstalled = true
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['secretSources'], sub => {
      const service = sub.secretSources
      attachVault(service)
      sub.effect(() => () => {
        if (secretSources !== service) return
        cancelTypedGateEntry(windowsCredential)
        advanceCredentialGeneration()
        secretSources = undefined
        sourcesPresent = false
      })
    })
  } else attachVault(ctx.get?.('secretSources'))

  // While another dsh holds the team, that host writes secrets.json, so a reading host
  // reads it again each time; a copy read then is also read again after taking over,
  // before this host saves anything.
  let loadedReadOnly = false
  // An existing secrets file that cannot be read is not an empty one: writing over it
  // would lose every key in it. While `blocked` holds the reason nothing is written,
  // and each load reads the file again (a busy file may only be briefly unreadable).
  let blocked
  // A reading host reloads on every request, so a held value is reported once per change,
  // not once per read.
  let heldWarned = ''
  const blockedWrite = code => refusal(`The secrets file could not be read (${code}). Omni does not change it; fix or move it and reload.`)

  function readSourceFile() {
    let entry
    try { entry = lstatSync(sourcesPath) } catch (error) {
      return error?.code === 'ENOENT' ? {} : { error: reason(error) }
    }
    try {
      if (!(entry.isSymbolicLink() ? statSync(sourcesPath) : entry).isFile()) return { error: 'NOT_FILE' }
      return { bytes: readFileSync(sourcesPath) }
    } catch (error) {
      return { error: reason(error) }
    }
  }

  const sameSourceFile = (a, b) => a !== undefined && a.error === b.error
    && (a.bytes === undefined ? b.bytes === undefined : b.bytes !== undefined && a.bytes.equals(b.bytes))

  function parseSources(file) {
    if (file.error !== undefined) return { error: file.error }
    if (file.bytes === undefined) return { rows: new Map() }
    let parsed
    try { parsed = JSON.parse(file.bytes.toString('utf8')) } catch { return { error: 'INVALID_JSON' } }
    if (parsed?.version !== 1 || !plainObject(parsed.sources)) return { error: 'INVALID_FORMAT' }
    const rows = new Map()
    let first
    for (const [name, row] of Object.entries(parsed.sources)) {
      if (!SECRET_NAME.test(name) || !plainObject(row) || !validVaultReference(row)
        || !validScope(row.scope) || Object.hasOwn(row, 'value')) return { error: 'INVALID_ROW' }
      if (first !== undefined && !sameConnection(first, row)) return { error: 'MULTIPLE_CONNECTIONS' }
      first ??= row
      rows.set(name, {
        provider: row.provider,
        connection: row.connection,
        item: row.item,
        field: row.field,
        scope: row.scope,
        purpose: row.purpose,
        requestedBy: typeof row.requestedBy === 'string' ? row.requestedBy : null,
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
        updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      })
    }
    if (privateMappingMetadata(rows)) return { error: privateReference }
    for (const row of rows.values()) row.purpose = purposeOf(row.purpose)
    return { rows }
  }

  // With mappings, an edited typed file can introduce a collision even when the
  // mapping bytes and the team's revision stay the same.
  function typedFileStamp() {
    try {
      const { dev, ino, size, mtimeNs } = statSync(path, { bigint: true })
      return `${dev}:${ino}:${size}:${mtimeNs}`
    } catch (error) { return reason(error) }
  }

  const loadSecrets = () => {
    const first = readSourceFile()
    if (loaded === null || loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined
      || sourcesBroken || !sameSourceFile(sourcesSnapshot, first)
      || (sources.size > 0 && typedStamp !== typedFileStamp())) loaded = readSecrets(first)
    return loaded
  }

  function readTypedFile() {
    let contents
    try {
      contents = readFileSync(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [] }
      const code = reason(error)
      rt.warn('ds-bot: unreadable secrets file %s (%s)', path, code)
      return { error: code }
    }
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch {
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.secrets)) {
      // A file that is not a secrets file is kept aside, like a broken state.json, then
      // the store goes on with an empty one.
      const backup = `${path}.broken-${Date.now()}`
      try {
        copyFileSync(path, backup)
        rt.warn('ds-bot: unreadable secrets file %s; backed up as %s', path, backup)
        return { entries: [] }
      } catch (error) {
        rt.warn('ds-bot: unreadable secrets file %s; backup failed: %s', path, error)
        return { error: reason(error) }
      }
    }
    return { entries: parsed.secrets, valid: true }
  }

  function collectTyped(entries) {
    const rows = new Map()
    const heldNames = []
    for (const entry of entries) {
      if (!SECRET_NAME.test(entry?.name ?? '') || typeof entry.value !== 'string') continue
      // Named, not silently dropped: the entry stays in the map (and the file) but is used
      // nowhere until a value of at least MIN_VALUE characters is saved.
      if (held(entry)) heldNames.push(entry.name)
      rows.set(entry.name, {
        name: entry.name,
        value: entry.value,
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
        scope: entry.scope === 'all' ? 'all' : Array.isArray(entry.scope) ? entry.scope.filter(id => typeof id === 'string') : 'all',
        ...(typeof entry.session === 'string' && entry.session !== '' ? { session: entry.session } : {}),
        requestedBy: typeof entry.requestedBy === 'string' ? entry.requestedBy : null,
        createdAt: Number(entry.createdAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Date.now(),
        ...(Number.isFinite(entry.lastUsedAt) ? { lastUsedAt: entry.lastUsedAt } : {}),
      })
    }
    return { rows, heldNames }
  }

  // A shell resolves synchronously. Read around the typed file and retry once if
  // another host changes the mapping, before publishing either store.
  const readSecrets = async (first) => {
    const readOnly = rt.readOnly() !== undefined
    let stamp = typedFileStamp()
    let typed = readTypedFile()
    let last = readSourceFile()
    if (!sameSourceFile(first, last)) {
      first = readSourceFile()
      stamp = typedFileStamp()
      typed = readTypedFile()
      last = readSourceFile()
    }
    const mapping = sameSourceFile(first, last) ? parseSources(last) : { error: 'CHANGED_DURING_READ' }
    const next = typed.error === undefined ? collectTyped(typed.entries) : undefined
    if (mapping.error !== undefined && (sourcesBroken !== mapping.error || !sameSourceFile(sourcesSnapshot, last))) {
      rt.warn('ds-bot: unreadable vault mapping file (%s)', mapping.error)
    }
    if (typed.valid && !readOnly) try { chmodSync(path, 0o600) } catch {}
    loadedReadOnly = readOnly
    typedStamp = stamp
    blocked = typed.error
    sourcesSnapshot = last
    sourcesBroken = mapping.error ?? false
    sources = mapping.rows ?? new Map()
    if (next !== undefined) {
      secrets = next.rows
      reportHeld(next.heldNames)
    }
    changed()
  }

  function reportHeld(heldNames) {
    const heldNotice = heldNames.join(',')
    if (heldNotice !== heldWarned) {
      heldWarned = heldNotice
      for (const name of heldNames) rt.warn('ds-bot: secret %s in %s is held: its saved value is shorter than the %d-character minimum; nothing uses it until a longer value is saved', name, path, MIN_VALUE)
    }
  }

  function writeStore(file, snapshot, onWritten, check) {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) return Promise.reject(refusal(readOnly))
    const job = writing.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await chmod(temp, 0o600)
        check?.()
        await replaceFile(temp, file, check)
        onWritten()
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = job.catch(error => rt.warn('ds-bot: secrets write failed (%s)', reason(error)))
    return job
  }
  // Resolves once secrets.json holds the current map; rejects when the write failed.
  const persist = () => blocked !== undefined ? Promise.reject(blockedWrite(blocked))
    : writeStore(path, JSON.stringify({ version: 1, secrets: [...secrets.values()] }, null, 2), () => { typedStamp = typedFileStamp() })
  const persistSources = (rows, check) => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, sources: Object.fromEntries(rows) }, null, 2))
    return writeStore(sourcesPath, bytes, () => { sourcesSnapshot = { bytes } }, check)
  }

  function appendVaultAudit({ name, botId, commandDigest }, decision, result) {
    const anonymousRefusal = name === undefined && commandDigest === undefined && decision === 'refused' && result === 'refused'
    if (!anonymousRefusal && (typeof name !== 'string' || !SECRET_NAME.test(name))) {
      return Promise.reject(new Error('Invalid vault audit name.'))
    }
    const line = JSON.stringify({
      time: Date.now(), name, botId, consumer: 'shell',
      ...(typeof commandDigest === 'string' && /^[0-9a-f]{64}$/.test(commandDigest) ? { commandDigest } : {}),
      decision, result,
    }) + '\n'
    const check = () => {
      if (!rt.holdsLock()) throw refusal(rt.readOnly() ?? 'This host cannot record vault activity.')
    }
    const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
    const job = writing.then(async () => {
      check()
      await mkdir(home, { recursive: true })
      const entry = await lstat(auditPath).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      if (entry !== undefined && !entry.isFile()) throw new Error('The vault audit path is not a file.')
      if (entry?.size && entry.size + Buffer.byteLength(line) > AUDIT_LIMIT) {
        check()
        await chmod(auditPath, 0o600)
        check()
        await replaceFile(auditPath, `${auditPath}.1`, check)
      }
      check()
      const file = await open(auditPath, flags, 0o600)
      try {
        check()
        await file.chmod(0o600)
        check()
        await file.appendFile(line, 'utf8')
      } finally { await file.close() }
    })
    writing = job.catch(() => {
      if (rt.holdsLock()) rt.warn('ds-bot: vault audit write failed')
    })
    return job
  }
  const auditVault = (entry, decision, result) => rt.holdsLock()
    ? appendVaultAudit(entry, decision, result).catch(() => {})
    : Promise.resolve()

  let usedTimer = null
  const noteUsed = () => {
    if (usedTimer !== null) return
    usedTimer = setTimeout(() => {
      usedTimer = null
      if (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined) return
      void persist().then(() => rt.save()).catch(() => {})
    }, USED_SAVE_MS)
    usedTimer.unref?.()
  }

  // A Bot's pending secret cards, keyed by its id. A key that is not a real Bot (and
  // never an inherited name like "__proto__", which a plain assignment would not even
  // set as a key) gets a throwaway list instead of a stored one.
  const requestsOf = (botId) => {
    const requests = (state.secretRequests ??= {})
    if (!Object.hasOwn(requests, botId) && rt.botOf(botId) === undefined) return []
    return (requests[botId] ??= [])
  }
  const findRequest = (id) => {
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      const request = list.find(entry => entry.id === id)
      if (request !== undefined) return { botId, request }
    }
    return undefined
  }
  const trimRequests = (list) => {
    while (list.length > MAX_REQUESTS) {
      const settled = list.findIndex(entry => entry.status !== 'pending' && !approving.has(entry))
      const [removed] = list.splice(settled === -1 ? 0 : settled, 1)
      forgetVaultRequest(removed)
    }
  }
  function forgetVaultRequest(request) {
    const binding = vaultRequests.get(request.id)
    if (binding?.snapshot !== undefined) snapshots.delete(binding.snapshot)
    vaultRequests.delete(request.id)
  }
  const stillListed = (botId, request) => state.secretRequests?.[botId]?.includes(request) === true
  const vaultAuditOf = (botId, request) => vaultRequests.get(request.id) ?? { botId, name: request.name }
  const mappingFor = name => sourcesBroken || secrets.has(name) ? undefined : sources.get(name)
  // Keep the service instance and token captured when the request was made.
  const providerGateOf = (service, provider) => ({ service, provider,
    token: provider === GNOME_PROVIDER_ID ? gateOf(service) : service?.providerBinding?.(provider) })
  const providerGateCurrent = gate => gate?.token != null && gate.service === secretSources
    && gate.token === providerGateOf(gate.service, gate.provider).token
  const sessionFolder = (session) => {
    const folder = session && (ctx.get?.('workingDirectory')?.get?.(session) ?? session.header?.cwd)
    return typeof folder === 'string' && isAbsolute(folder) ? folder : undefined
  }

  const scopeText = (scope) => {
    if (scope === 'all') return 'every Bot'
    const names = scope.map(id => rt.botOf(id)?.name).filter(Boolean)
    return names.length === 0 ? 'no Bot' : names.join(', ')
  }
  const usage = name => `$${envName(name)} in bash, or $env:${envName(name)} in PowerShell`
  const sessionOnly = name => `${name} is scoped to one Session's capability, and no Bot may use it.`

  async function tell(botId, text) {
    if (rt.botOf(botId) === undefined) return
    await rt.deliver({ toId: botId, role: 'secret', text })
      .catch(error => rt.warn('ds-bot: secret note to %s failed: %s', botId, error))
  }
  const savedNote = (name, lead) => [
    `${lead} Use it as ${usage(name)}.`,
    'You cannot see the value. Never print, echo, or log it, and never ask the user to paste it into the chat. Carry on with what you needed it for.',
  ].join(' ')

  function settle(botId, request, status) {
    request.status = status
    request.settledAt = Date.now()
    if (status === 'saved' || status === 'allowed') request.scope = secrets.get(request.name)?.scope ?? 'all'
  }

  function cancelVaultRequest(request, reason) {
    request.status = 'canceled'
    request.settledAt = Date.now()
    if (reason !== undefined) request.reason = reason
    forgetVaultRequest(request)
  }

  async function revokeVault(name, { requireSave = false } = {}) {
    const notes = []
    const audits = []
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      for (const request of list) {
        if (request.name !== name || request.source !== 'vault' || request.status !== 'pending') continue
        const entry = vaultAuditOf(botId, request)
        cancelVaultRequest(request)
        audits.push(auditVault(entry, 'canceled', 'revoked'))
        notes.push(botId)
      }
    }
    for (const [key, grant] of grants) {
      if (grant.name !== name) continue
      grants.delete(key)
      audits.push(auditVault(grant, 'canceled', 'revoked'))
    }
    if (requireSave || notes.length > 0) await rt.save({ required: true })
    await Promise.all(audits)
    for (const botId of notes) await tell(botId, `The user changed the vault mapping for ${name}; ask again if you still need it.`)
  }

  // After any change to `name`, every pending card for it either resolves (its Bot can
  // use the key now) or shows the form that still applies.
  function reconcile(name, notes, except) {
    const secret = unavailable(name) ? undefined : secrets.get(name)
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      for (const request of list) {
        if (request.status !== 'pending' || request.source === 'vault' || request.name !== name || request === except) continue
        if (canUse(secret, botId) && !held(secret)) {
          settle(botId, request, 'saved')
          notes.push([botId, savedNote(name, `The user saved ${name}, and you may use it now.`)])
        } else {
          request.kind = secret ? 'allow' : 'fill'
        }
      }
    }
  }

  async function commit(notes) {
    const learningScrub = changed()
    await persist()
    await rt.save()
    await learningScrub
    for (const [botId, text] of notes) await tell(botId, text)
  }

  const cleanValue = (raw) => {
    if (typeof raw !== 'string') throw refusal('Type the key first')
    const value = raw.trim()
    if (value.length < MIN_VALUE) throw refusal(`A key must have at least ${MIN_VALUE} characters`)
    if (value.length > MAX_VALUE) throw refusal(`A key can have at most ${MAX_VALUE} characters`)
    return value
  }
  const cleanScope = (raw) => {
    if (raw === 'all') return 'all'
    if (!Array.isArray(raw)) throw refusal('Choose every Bot or a list of Bots')
    return [...new Set(raw.filter(id => typeof id === 'string' && rt.botOf(id) !== undefined))]
  }
  const pendingRequest = (id) => {
    const found = findRequest(String(id ?? ''))
    if (found === undefined) throw refusal('This request is gone')
    if (found.request.status !== 'pending') throw refusal('This request was already answered')
    return found
  }

  const secretView = secret => ({
    name: secret.name,
    purpose: secret.purpose,
    scope: secret.scope,
    ...(secret.session !== undefined ? { session: secret.session } : {}),
    requestedBy: secret.requestedBy,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    ...(secret.lastUsedAt !== undefined ? { lastUsedAt: secret.lastUsedAt } : {}),
    ...(held(secret) ? { held: true } : {}),
  })
  const secretsView = () => [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name)).map(secretView)
  const sourceView = (name, row) => ({
    name, purpose: row.purpose, scope: row.scope, requestedBy: row.requestedBy,
    createdAt: row.createdAt, updatedAt: row.updatedAt, definedTwice: secrets.has(name),
  })
  const secretSourcesView = () => ({
    broken: Boolean(sourcesBroken),
    rows: [...sources.keys()].sort().map(name => sourceView(name, sources.get(name))),
  })
  const exactName = (name) => {
    if (typeof name !== 'string' || !SECRET_NAME.test(name)) throw refusal('A name uses capitals, digits, and underscores, and starts with a letter')
    return name
  }
  const checkSourceWrite = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refusal(readOnly)
    if (sourcesBroken) throw refusal(brokenSources)
  }

  function checkVaultBinding(botId, request, status) {
    // The loader reads both files synchronously, even though its callers can await it.
    void loadSecrets()
    const { id, sessionId, name, kind, source, command, shell, workdir, commandDigest } = request
    const binding = vaultRequests.get(id)
    const mapping = mappingFor(name)
    if (!stillListed(botId, request) || request.status !== status || kind !== 'allow' || source !== 'vault'
      || typeof command !== 'string' || !shellTool(shell) || typeof workdir !== 'string' || !isAbsolute(workdir)
      || binding === undefined || binding.botId !== botId || binding.sessionId !== sessionId || binding.name !== name
      || commandDigest !== binding.commandDigest || commandDigestOf(shell, workdir, command) !== binding.commandDigest
      || mapping === undefined || fingerprintOf(mapping) !== binding.fingerprint) throw refusal(changedMapping(name))
    if (typedGateProvider(mapping.provider) && !providerGateCurrent(binding.providerGate)) throw refusal(vaultLocked)
    return { binding, mapping }
  }

  async function allowVault(botId, request, body) {
    const { name, sessionId } = request
    const entry = vaultAuditOf(botId, request)
    const service = secretSources
    const generation = credentialGeneration
    const managerSignal = managerEntry.signal
    const proton = mappingFor(name)?.provider === protonPass
    const session = proton ? service?.sessionOf?.({ provider: protonPass }) : undefined
    const checkSession = () => {
      if (proton && (session === undefined || service?.sessionOf?.({ provider: protonPass }) !== session)) throw refusal(vaultLocked)
    }
    const checkManagerActivation = (mapping, binding) => {
      if (mapping.provider === secretsManager && (managerSignal.aborted
        || !matchesManagerActivation(secretSources, binding.managerActivation))) throw refusal(vaultLocked)
    }
    const check = (status) => {
      const { binding, mapping } = checkVaultBinding(botId, request, status)
      if (binding.commandDigest !== body.commandDigest || snapshots.get(body.snapshot) !== binding) {
        throw refusal(changedMapping(name))
      }
      checkManagerActivation(mapping, binding)
      if (service === undefined || service !== secretSources) throw refusal(`${name} is unavailable because the vault plugin is off.`)
      if (wrongHashicorpConnection(service, mapping)) throw refusal(hashicorpMismatch)
      if ((fencedProvider(mapping.provider) || mapping.provider === secretsManager) && generation !== credentialGeneration) throw refusal(vaultLocked)
      if (mapping.provider === GNOME_PROVIDER_ID && !providerGateCurrent(binding.providerGate)) throw refusal(vaultLocked)
      checkSession()
      if (!canUse(mapping, botId)) throw refusal(outsideScope(name))
      if (!rt.holdsLock()) throw refusal(rt.readOnly() ?? 'This host cannot approve vault requests.')
      if (blocked !== undefined) throw blockedWrite(blocked)
      if (rt.botOf(botId) === undefined || rt.chatOf(botId) !== sessionId) throw refusal(earlierChat)
      if (!matchesLiveConnection(service, mapping)) throw refusal(vaultUnavailable)
      return { binding, mapping }
    }
    let recorded = false
    try {
      if (typeof body.commandDigest !== 'string' || typeof body.snapshot !== 'string') {
        throw refusal('Update the app to approve this request; the card must show the command and the vault item.')
      }
      const { binding, mapping } = check('pending')
      const status = await vaultStatus(service, mapping)
      check('pending')
      if (status === undefined) throw refusal(vaultUnavailable)
      if (status !== 'unlocked' || (mapping.provider === hashicorp && hashicorpConnection(service) === undefined)) throw refusal(vaultLocked)

      approving.add(request)
      request.status = 'allowed'
      request.settledAt = Date.now()
      try {
        await rt.save({ required: true })
      } catch {
        if (stillListed(botId, request) && request.status === 'allowed') {
          request.status = 'pending'
          delete request.settledAt
        }
        checkManagerActivation(mapping, binding)
        throw refusal(approvalFailed)
      }
      recorded = true
      check('allowed')
      const key = grantKey(botId, sessionId)
      try {
        await appendVaultAudit(binding, 'allowed', 'ok')
      } catch {
        checkManagerActivation(mapping, binding)
        throw refusal(approvalFailed)
      }
      check('allowed')
      const previous = grants.get(key)
      if (previous !== undefined) {
        grants.delete(key)
        try {
          await appendVaultAudit(previous, 'canceled', 'revoked')
        } catch {
          checkManagerActivation(mapping, binding)
          throw refusal(approvalFailed)
        }
        check('allowed')
      }
      const issuedAt = Date.now()
      checkSession()
      grants.set(key, {
        name, botId, sessionId, commandDigest: binding.commandDigest, shell: request.shell, workdir: request.workdir,
        ...(mapping.provider === secretsManager ? { managerActivation: binding.managerActivation } : {}),
        fingerprint: binding.fingerprint, issuedAt, expiresAt: issuedAt + GRANT_MS,
        ...(gateBoundProvider(mapping.provider) ? { providerGate: binding.providerGate } : {}),
      })
      forgetVaultRequest(request)
    } catch (error) {
      if (stillListed(botId, request) && ((recorded && request.status === 'allowed')
        || (error.message === earlierChat && request.status === 'pending'))) {
        cancelVaultRequest(request, error.message === approvalFailed ? 'audit' : undefined)
        if (rt.holdsLock()) await rt.save({ required: true }).catch(() => {})
      }
      const locked = error.message === vaultLocked
      await auditVault(entry, locked ? 'locked' : 'refused', locked ? 'locked' : 'refused')
      if (locked) await tell(botId, vaultLocked)
      throw error
    } finally { approving.delete(request) }
    await tell(botId, 'The user approved this exact command once. Vault values cannot reach a shell on this version yet, so running it will be refused; tell the user.')
    return true
  }

  const endpoints = {
    // From a card (requestId) or from the settings page (name).
    async 'secret-set'(body) {
      const now = Date.now()
      const notes = []
      if (sourcesBroken) throw refusal(brokenSources)
      if (body.requestId !== undefined) {
        if (findRequest(String(body.requestId))?.request.source === 'vault') throw refusal('A vault request cannot take a typed value.')
        const { botId, request } = pendingRequest(body.requestId)
        refuseTypedWrite(request.name)
        const value = cleanValue(body.value)
        const existing = secrets.get(request.name)
        if (existing?.session !== undefined) throw refusal(sessionOnly(request.name))
        let scope
        if (existing === undefined || request.kind === 'fill') scope = body.scope === 'bot' ? [botId] : 'all'
        else scope = existing.scope === 'all' ? 'all' : [...new Set([...existing.scope, botId])]
        secrets.set(request.name, {
          name: request.name,
          value,
          purpose: existing?.purpose || request.purpose,
          scope,
          requestedBy: existing?.requestedBy ?? botId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
        })
        settle(botId, request, 'saved')
        notes.push([botId, savedNote(request.name, `The user saved ${request.name} for ${scopeText(scope)}.`)])
        reconcile(request.name, notes, request)
        await commit(notes)
        return secretView(secrets.get(request.name))
      }
      const name = normalizeName(body.name)
      refuseTypedWrite(name)
      const value = cleanValue(body.value)
      if (!SECRET_NAME.test(name)) throw refusal('A name uses capitals, digits, and underscores, and starts with a letter')
      const existing = secrets.get(name)
      const scope = body.scope !== undefined ? cleanScope(body.scope) : existing?.scope ?? 'all'
      // A new value keeps a Session's scope; handing the key to Bots goes through secret-update.
      if (existing?.session !== undefined && !forNoBot({ scope })) throw refusal(`${sessionOnly(name)} Change who may use it under Who may use it.`)
      secrets.set(name, {
        name,
        value,
        purpose: typeof body.purpose === 'string' && body.purpose.trim() !== '' ? body.purpose.trim().slice(0, 300) : existing?.purpose ?? '',
        scope,
        ...(existing?.session !== undefined ? { session: existing.session } : {}),
        requestedBy: existing?.requestedBy ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
      })
      reconcile(name, notes)
      await commit(notes)
      return secretView(secrets.get(name))
    },
    async 'secret-allow'(body) {
      const found = findRequest(String(body.requestId ?? ''))
      const previous = found?.request
      if (previous?.source === 'vault' && previous.status === 'canceled') {
        const mapping = sources.get(previous.name)
        if (wrongHashicorpConnection(secretSources, mapping)) throw refusal(hashicorpMismatch)
        if (mapping?.provider === secretsManager) {
          await auditVault({ botId: found.botId, name: previous.name, commandDigest: previous.commandDigest }, 'refused', 'refused')
        }
      }
      const { botId, request } = pendingRequest(body.requestId)
      if (request.source === 'vault') return allowVault(botId, request, body)
      const unavailableReason = sourceReason(request.name)
      if (unavailableReason !== undefined) throw refusal(unavailableReason)
      const secret = secrets.get(request.name)
      if (secret === undefined) throw refusal(`${request.name} is not saved yet`)
      if (held(secret)) throw refusal(heldReason(request.name))
      if (secret.session !== undefined) throw refusal(sessionOnly(request.name))
      if (!canUse(secret, botId)) secret.scope = [...new Set([...secret.scope, botId])]
      secret.updatedAt = Date.now()
      settle(botId, request, 'allowed')
      const notes = [[botId, savedNote(request.name, `The user let you use ${request.name}.`)]]
      reconcile(request.name, notes, request)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-cancel'(body) {
      const { botId, request } = pendingRequest(body.requestId)
      const entry = request.source === 'vault' ? vaultAuditOf(botId, request) : undefined
      if (entry !== undefined) cancelVaultRequest(request)
      else settle(botId, request, 'canceled')
      await rt.save()
      if (entry !== undefined) await auditVault(entry, 'denied', 'refused')
      await tell(botId, `The user canceled your request for ${request.name}. Do not ask for it again unless the user brings it up; carry on without it, or tell the user what you cannot do without it.`)
      return true
    },
    async 'secret-update'(body) {
      const name = normalizeName(body.name)
      const unavailableReason = sourceReason(name)
      if (unavailableReason !== undefined) throw refusal(unavailableReason)
      const secret = secrets.get(name)
      if (secret === undefined) throw refusal('No such key')
      if (body.scope !== undefined) secret.scope = cleanScope(body.scope)
      // The person who gives the key to Bots ends its Session scope.
      if (!forNoBot(secret)) delete secret.session
      if (typeof body.purpose === 'string') secret.purpose = body.purpose.trim().slice(0, 300)
      secret.updatedAt = Date.now()
      const notes = []
      reconcile(secret.name, notes)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-delete'(body) {
      const name = normalizeName(body.name)
      if (!secrets.delete(name)) throw refusal('No such key')
      const notes = []
      reconcile(name, notes)
      await commit(notes)
      return true
    },
    async 'secret-source-set'(body) {
      checkSourceWrite()
      if (!sourcesPresent) throw refusal('The vault plugin is not on.')
      const name = exactName(body.name)
      if (blocked !== undefined) throw blockedWrite(blocked)
      let { connection, item, field } = body
      const legacy = !Array.isArray(secretSources.providers)
      const provider = legacy && !validProvider(body.provider) ? 'bitwarden' : body.provider ?? 'bitwarden'
      const purpose = purposeOf(body.purpose)
      if (provider === windowsCredential && windowsTarget(item)
        && privateMappingMetadata(new Map(sources).set(name, { provider, item }), name, body.purpose)) {
        throw refusal('Choose a valid vault reference.')
      }
      // A failed typed write can leave the in-memory store different from disk.
      const typed = readTypedFile()
      if (typed.error !== undefined) throw blockedWrite(typed.error)
      if (typed.entries.some(entry => entry?.name === name)) {
        throw refusal(`The name ${name} is already a typed secret. Delete it in Settings › Secrets first, or map the vault item under another name.`)
      }
      if (provider === secretsManager) checkManagerRevision(body)
      if (provider === GNOME_PROVIDER_ID) {
        const service = secretSources
        matchingProvider(provider)
        if (!supportedProvider(service, provider) || !secretServiceHandle(body.handle)) throw refusal('Choose a valid vault reference.')
        const gate = gateOf(service)
        let result
        try { result = await service.resolveHandle({ provider, handle: body.handle }) } catch {}
        if (result?.ok !== true) throw refusal(secretServiceMessage(result?.code, 'Choose a valid vault reference.'))
        if (secretSources !== service || !sameGate(service, gate)) throw refusal(vaultLocked)
        await loadSecrets()
        checkSourceWrite()
        if (secretSources !== service || !sameGate(service, gate)) throw refusal(vaultLocked)
        if (blocked !== undefined) throw blockedWrite(blocked)
        if (secrets.has(name)) throw refusal(mappedWrite(name))
        item = result.item
        connection = GNOME_PROVIDER_ID
        field = 'secret'
      }
      const reference = { provider, connection, item, field }
      if (!validVaultReference(reference) || !supportedProvider(secretSources, provider)) throw refusal('Choose a valid vault reference.')
      if (!matchesLiveConnection(secretSources, reference)) throw refusal(secondConnection)
      for (const [other, row] of sources) {
        if (!sameConnection(row, reference) && (!legacy || other !== name || row.provider !== provider)) {
          throw refusal(legacy && row.provider === provider ? legacyConnection : secondConnection)
        }
      }
      const windowsGate = provider === windowsCredential ? providerGateOf(secretSources, provider) : undefined
      const checkGate = windowsGate === undefined ? undefined : () => {
        if (!providerGateCurrent(windowsGate) || !matchesLiveConnection(windowsGate.service, reference)) throw refusal(vaultLocked)
      }
      checkGate?.()
      if (windowsGate && (await vaultStatus(windowsGate.service, reference) !== 'unlocked' || !providerGateCurrent(windowsGate))) {
        throw refusal(vaultLocked)
      }
      const previous = sources.get(name)
      const now = Date.now()
      const row = {
        ...reference, scope: cleanScope(body.scope),
        purpose, requestedBy: previous?.requestedBy ?? null,
        createdAt: previous?.createdAt ?? now, updatedAt: now,
      }
      const next = new Map(sources).set(name, row)
      if (privateMappingMetadata(next, name, body.purpose)) throw refusal('Choose a valid vault reference.')
      // The checked rename commits the mapping. A subsequent vault lock fences
      // reads and grants through the gate, while the saved reference remains valid.
      await persistSources(next, checkGate)
      sources = next
      changed()
      if (windowsGate === undefined) await revokeVault(name)
      else await revokeVault(name).catch(error => rt.warn('ds-bot: revoking vault approval after mapping save failed (%s)', reason(error)))
      return sourceView(name, row)
    },
    async 'secret-source-clear'(body) {
      checkSourceWrite()
      const name = exactName(body.name)
      if (!sources.has(name)) throw refusal('No such vault mapping')
      const next = new Map(sources)
      next.delete(name)
      await persistSources(next)
      sources.delete(name)
      changed()
      await revokeVault(name)
      return true
    },
    async 'secret-source-detail'(body) {
      const found = findRequest(String(body.requestId ?? ''))
      if (found === undefined) throw refusal('This request is gone')
      const { request, botId } = found
      const { binding, mapping: { provider, item, field } } = checkVaultBinding(botId, request, 'pending')
      if (provider === GNOME_PROVIDER_ID) {
        const service = secretSources
        const check = () => {
          const latest = checkVaultBinding(botId, request, 'pending')
          if (latest.binding !== binding || !canUse(latest.mapping, botId)
            || rt.chatOf(botId) !== request.sessionId) throw refusal(changedMapping(request.name))
          if (service !== secretSources || !providerGateCurrent(binding.providerGate)) throw refusal(vaultLocked)
        }
        check()
        let detail
        try { detail = await service.itemDetail({ provider, item }) } catch {}
        check()
        const [, created] = secretServiceItem(item)
        if (detail?.ok !== true || typeof detail.name !== 'string' || typeof detail.collection !== 'string'
          || detail.created !== created) throw refusal(secretServiceMessage(detail?.code, 'The vault item details could not be loaded.'))
        snapshots.delete(binding.snapshot)
        binding.snapshot = randomUUID()
        snapshots.set(binding.snapshot, binding)
        return { provider, name: detail.name, collection: detail.collection, created, field,
          snapshot: binding.snapshot, commandDigest: binding.commandDigest }
      }
      if (binding.snapshot === undefined) {
        binding.snapshot = randomUUID()
        snapshots.set(binding.snapshot, binding)
      }
      return { provider, item, field, snapshot: binding.snapshot, commandDigest: binding.commandDigest }
    },
  }

  function mutate(task) {
    // An idle endpoint reaches its load await immediately, as conditional cleanup
    // relies on when it compares a value against a concurrent replacement.
    const job = mutations === undefined ? task() : mutations.then(task)
    const clear = () => { if (mutations === settled) mutations = undefined }
    const settled = job.then(clear, clear)
    mutations = settled
    return job
  }
  const secretEndpoint = (endpoint, body) => {
    const dispatch = async () => {
      await loadSecrets()
      return endpoints[endpoint](body ?? {})
    }
    // This lookup waits on the keyring. A cancel or mapping edit may proceed meanwhile.
    return endpoint === 'secret-source-detail' && vaultRequests.get(String(body?.requestId ?? ''))?.providerGate?.provider === GNOME_PROVIDER_ID
      ? dispatch() : mutate(dispatch)
  }

  const knownManagerConnection = active => {
    const mapped = sources.values().next().value
    return mapped?.provider === secretsManager ? mapped.connection
      : active?.provider === secretsManager ? active.connection : undefined
  }
  const connectionOf = (service, provider) => {
    if (typedGateProvider(provider)) return typedGateConnection(provider)
    const mapped = sources.values().next().value
    if (mapped !== undefined) return mapped.connection
    const active = service.activeConnection?.()
    return active?.provider === provider ? active.connection : provider === hashicorp ? undefined : provider
  }
  const entryConnection = (service, provider, connection) => {
    if (provider === protonPass) {
      if (!validProtonConnection(connection)) throw refusal('Choose a valid vault reference.')
      return protonPass
    }
    if (connection === undefined) return connectionOf(service, provider)
    if (!validReference(connection)) throw refusal('Choose a valid vault reference.')
    const mapped = sources.values().next().value
    if (mapped !== undefined && mapped.connection !== connection) throw refusal(secondConnection)
    return connection
  }
  const activeProvider = choice => sources.values().next().value?.provider ?? choice
  const matchingProvider = provider => {
    if (sourcesBroken) throw refusal(brokenSources)
    if (activeProvider(provider) !== provider) throw refusal(secondConnection)
  }
  const providerArgs = (service, provider, options) => Array.isArray(service.providers)
    ? { ...options, provider } : options
  const managerRefusal = (answer, message) => refusal(secretsManagerReasons.get(answer?.code) ?? message)
  const checkManagerRevision = body => {
    if (body.credentialRevision !== managerRevision) throw refusal(managerChanged)
  }

  async function hashicorpPicker(service, body, fields) {
    matchingProvider(hashicorp)
    if (!supportedProvider(service, hashicorp)) throw refusal('The vault did not answer.')
    const { mount, path, folder = '' } = body
    const candidate = fields ? path : folder
    if (!validHashicorpMount(mount) || ((fields || candidate !== '') && !validHashicorpPath(mount, candidate))) {
      throw refusal('Choose a valid vault reference.')
    }
    const mapping = sources.values().next().value
    if (wrongHashicorpConnection(service, mapping)) throw refusal(hashicorpMismatch)
    const connection = connectionOf(service, hashicorp)
    const signal = credentialGeneration.signal
    let result
    try {
      result = fields
        ? await service.listFields({ provider: hashicorp, connection, mount, path, signal })
        : await service.listItems({ provider: hashicorp, connection, mount, folder, signal })
    } catch {}
    if (result?.code === 'cloud') throw refusal(hashicorpCloud)
    if (result?.code === 'connection' || wrongHashicorpConnection(service, sources.values().next().value)) throw refusal(hashicorpMismatch)
    if (signal.aborted || (result?.ok === true && (connection === undefined || hashicorpConnection(service) !== connection))) {
      throw refusal(vaultLocked)
    }
    if (fields) {
      if (result?.ok !== true || !Array.isArray(result.fields)) throw refusal('The vault item details could not be loaded.')
      return { fields: [...new Set(result.fields.slice(0, 50).filter(validHashicorpField))] }
    }
    if (result?.ok !== true || !Array.isArray(result.items)) throw refusal('The vault items could not be listed.')
    return { items: hashicorpItems(mount, folder, result.items) }
  }

  async function keychainPicker(service, { service: name, account }) {
    const id = keychainLookup(name, account)
    if (id === undefined) throw refusal('Choose a valid vault reference.')
    const gate = providerGateOf(service, macosKeychain)
    if (!providerGateCurrent(gate)) throw refusal(vaultLocked)
    let result
    try {
      result = await service.listItems({ provider: macosKeychain, connection: keychainConnection, service: name, account })
    } catch {}
    if (!providerGateCurrent(gate)) throw refusal(vaultLocked)
    matchingProvider(macosKeychain)
    const reason = keychainReason(result?.code)
    if (reason !== undefined) throw refusal(reason)
    if (result?.code === 'locked') throw refusal(vaultLocked)
    const items = keychainItems(result, id, name, account)
    if (items === undefined) throw refusal('The vault items could not be listed.')
    return { items }
  }

  async function windowsPicker(service, { target }) {
    if (!windowsTarget(target)) throw refusal('Choose a valid vault reference.')
    const gate = providerGateOf(service, windowsCredential)
    if (!providerGateCurrent(gate)) throw refusal(vaultLocked)
    let result
    try {
      result = await service.listItems({ provider: windowsCredential, connection: windowsConnection, target })
    } catch {}
    matchingProvider(windowsCredential)
    if (service === secretSources && result?.code === 'blocked') throw refusal(windowsReason('blocked'))
    if (!providerGateCurrent(gate)) throw refusal(vaultLocked)
    const reason = windowsReason(result?.code)
    if (reason !== undefined) throw refusal(reason)
    if (result?.code === 'locked') throw refusal(vaultLocked)
    const items = windowsItems(result, target)
    if (items === undefined) throw refusal('The vault items could not be listed.')
    return { items }
  }

  const vaultRoutes = {
    async 'vault-status'(service, body) {
      const selected = service.providerSelection?.provider === GNOME_PROVIDER_ID ? GNOME_PROVIDER_ID : defaultVaultProvider(service)
      const provider = activeProvider(body.provider ?? selected)
      const connection = connectionOf(service, provider)
      const active = service.activeConnection?.()
      const known = provider === secretsManager ? knownManagerConnection(active) : undefined
      const credentialRevision = provider === secretsManager ? managerRevision : undefined
      const answer = provider === secretsManager && active?.provider === provider && active.connection !== connection
        ? undefined : await probeVault(service, provider, true)
      const mismatch = answer?.state === 'unlocked' && wrongHashicorpConnection(service, sources.values().next().value)
      return {
        present: true, ...(answer ?? { state: 'unavailable' }),
        ...(mismatch ? { reason: hashicorpMismatch, mismatch: true } : {}),
        connection,
        ...(provider === secretsManager ? { connectionKnown: known !== undefined } : {}),
        ...(credentialRevision !== undefined ? { credentialRevision } : {}),
        ...(Array.isArray(service.providers) ? { provider, providers: vaultProviders.filter(choice => supportedProvider(service, choice)) } : {}),
      }
    },
    async 'vault-unlock'(service, body, enter) {
      if (body.provider === GNOME_PROVIDER_ID) {
        matchingProvider(GNOME_PROVIDER_ID)
        if (!supportedProvider(service, GNOME_PROVIDER_ID)) throw refusal('The vault did not answer.')
        let answer
        try { answer = await enter(GNOME_PROVIDER_ID, {}) } catch {}
        if (answer?.ok !== true) throw refusal(secretServiceMessage(answer?.code, 'The vault could not be unlocked.'))
        return true
      }
      if (body.provider === secretsManager) {
        matchingProvider(secretsManager)
        if (!supportedProvider(service, secretsManager)) throw refusal('The vault did not answer.')
        const connection = entryConnection(service, secretsManager, body.connection)
        let answer
        try { answer = await enter(secretsManager, { connection }) } catch {}
        if (answer?.ok !== true) throw managerRefusal(answer, 'The vault could not be unlocked.')
        return true
      }
      if (typedGateProvider(body.provider)) {
        const { provider } = body
        const connection = typedGateConnection(provider)
        matchingProvider(provider)
        if (!supportedProvider(service, provider)) throw refusal('The vault did not answer.')
        if ((body.connection !== undefined && body.connection !== connection)
          || body.password !== undefined || body.token !== undefined) throw refusal('Choose a valid vault reference.')
        let answer
        try { answer = await enter(provider, { connection }) } catch {}
        const reason = typedGateReason(provider, answer?.code)
        if (reason !== undefined) throw refusal(reason)
        if (answer?.ok !== true) throw refusal('The vault could not be unlocked.')
        return true
      }
      matchingProvider('bitwarden')
      if (body.provider !== undefined && body.provider !== 'bitwarden') throw refusal('Choose a vault provider.')
      if (typeof body.password !== 'string' || body.password.length === 0 || body.password.includes('\0')) {
        throw refusal('Enter your Bitwarden master password.')
      }
      // The legacy route ignored a connection sent without a provider.
      const connection = entryConnection(service, 'bitwarden', body.provider === undefined ? undefined : body.connection)
      let answer
      try { answer = await enter('bitwarden', { password: body.password, connection }) } catch {}
      if (answer?.ok !== true) throw refusal('The vault could not be unlocked.')
      return true
    },
    async 'vault-lock'(service, body) {
      if (body.provider === protonPass && !supportedProvider(service, protonPass)) throw refusal('The vault did not answer.')
      if (body.provider === secretsManager && !supportedProvider(service, secretsManager)) throw refusal('The vault did not answer.')
      if (typedGateProvider(body.provider) && !supportedProvider(service, body.provider)) throw refusal('The vault did not answer.')
      let locked
      try {
        const provider = fencedProvider(body.provider) || body.provider === GNOME_PROVIDER_ID
          || body.provider === secretsManager || typedGateProvider(body.provider)
          ? { provider: body.provider } : undefined
        const result = provider === undefined ? await service.lock() : await service.lock(provider)
        locked = result === true || (!Array.isArray(service.providers) && result === undefined)
      } catch {}
      if (!locked) throw refusal('The vault could not be locked.')
      return true
    },
    async 'vault-token-set'(service, body, enter) {
      if (body.provider === hashicorp) {
        matchingProvider(hashicorp)
        if (!supportedProvider(service, hashicorp)) throw refusal('The vault did not answer.')
        if (typeof body.token !== 'string' || body.token === '' || /[\s\u0000-\u001f\u007f]/.test(body.token)) throw refusal('Enter your Vault token.')
        const { address, namespace } = body
        const connection = service.connectionFor?.({ provider: hashicorp, address, namespace })
        if (!validHashicorpConnection(connection)) throw refusal('Enter a valid Vault address and namespace.')
        const mapped = sources.values().next().value
        const previous = hashicorpConnection(service) ?? mapped?.connection
        const [mount] = hashicorpItem(mapped?.item) ?? []
        let answer
        try {
          answer = await enter(hashicorp, { token: body.token, address, namespace, mount },
            { replacing: previous !== undefined && previous !== connection })
        } catch {}
        if (answer?.code === 'cloud') throw refusal(hashicorpCloud)
        if (answer?.code === 'version') throw refusal('Install Vault CLI 2.0, 2.1 or 2.2.')
        if (answer?.ok !== true) throw refusal('The Vault connection could not be set.')
        return true
      }
      if (body.provider === protonPass) {
        matchingProvider(protonPass)
        if (!supportedProvider(service, protonPass)) throw refusal('The vault did not answer.')
        const connection = entryConnection(service, protonPass, body.connection)
        let answer
        try { answer = await enter(protonPass, { token: body.token, connection }) } catch {}
        if (answer?.code === 'cloud') throw refusal(protonCloud)
        if (answer?.code === 'version') throw refusal('Install Proton Pass CLI 2.7.1.')
        if (answer?.ok !== true) throw refusal(protonSetFailed)
        return true
      }
      const machineAccount = body.provider === secretsManager
      if (!machineAccount && body.provider !== 'onepassword') throw refusal('Choose a vault provider.')
      matchingProvider(body.provider)
      if (!supportedProvider(service, body.provider)) throw refusal('The vault did not answer.')
      if (typeof body.token !== 'string' || body.token.length === 0 || /[\s\0]/.test(body.token)) {
        throw refusal(machineAccount ? 'Enter your Bitwarden Secrets Manager access token.' : 'Enter your 1Password service account token.')
      }
      const connection = entryConnection(service, body.provider, body.connection)
      const options = { token: body.token, connection, ...(machineAccount ? { server: body.server } : {}) }
      if (machineAccount && typeof service.checkSetToken === 'function' && !service.checkSetToken(options)) {
        throw refusal(managerSetFailed)
      }
      const replacing = machineAccount && (sources.size > 0 || service.activeConnection?.()?.provider === secretsManager)
      let answer
      try {
        answer = await enter(body.provider, options, { method: machineAccount ? 'setToken' : 'unlock', replacing })
      } catch {}
      if (machineAccount) {
        if (answer?.ok !== true) throw managerRefusal(answer, managerSetFailed)
        return true
      }
      if (answer?.code === 'cloud') throw refusal(cloudVault)
      if (answer?.code === 'version') throw refusal('Install 1Password CLI 2.39.0 or a later 2.x version.')
      if (answer?.ok !== true) throw refusal('The 1Password service account token could not be set.')
      return true
    },
    async 'vault-token-clear'(service, body) {
      if (fencedProvider(body.provider)) {
        if (!supportedProvider(service, body.provider)) throw refusal('The vault did not answer.')
        return vaultRoutes['vault-lock'](service, body)
      }
      if (body.provider === secretsManager) {
        if (!supportedProvider(service, secretsManager)) throw refusal('The vault did not answer.')
        const mapped = sources.values().next().value
        const connection = body.connection === undefined ? knownManagerConnection(service.activeConnection?.()) : body.connection
        if (connection === undefined) throw refusal('Choose a vault connection to clear.')
        if (!validReference(connection)) throw refusal('Choose a valid vault reference.')
        if (mapped?.provider === secretsManager && mapped.connection !== connection) throw refusal(secondConnection)
        cancelManagerEntry()
        let answer
        try { answer = await service.clearToken({ provider: secretsManager, connection }) } catch {}
        if (answer?.ok === true || answer?.attempted === true) managerRevision = randomUUID()
        if (answer?.ok !== true) throw managerRefusal(answer, 'The Bitwarden Secrets Manager access token could not be cleared.')
        return true
      }
      if (body.provider !== 'onepassword') throw refusal('Choose a vault provider.')
      if (!supportedProvider(service, body.provider)) throw refusal('The vault did not answer.')
      let cleared
      try { cleared = await service.lock({ provider: body.provider }) }
      catch { cleared = false }
      if (cleared === false) throw refusal('The 1Password service account token could not be cleared.')
      return true
    },
    async 'vault-items'(service, body) {
      const provider = activeProvider(body.provider ?? 'bitwarden')
      matchingProvider(body.provider ?? provider)
      if (provider === hashicorp) return hashicorpPicker(service, body, false)
      if (!supportedProvider(service, provider)) throw refusal('The vault did not answer.')
      if (provider === macosKeychain) return keychainPicker(service, body)
      if (provider === windowsCredential) return windowsPicker(service, body)
      const search = typeof body.search === 'string' ? body.search.trim().slice(0, 512) : ''
      if (provider === GNOME_PROVIDER_ID) {
        const gate = gateOf(service)
        let result
        try { result = await service.listItems({ provider, search }) } catch {}
        if (result?.ok !== true || !Array.isArray(result.items)) throw refusal(secretServiceMessage(result?.code, 'The vault items could not be listed.'))
        if (service !== secretSources || !sameGate(service, gate)) throw refusal(vaultLocked)
        matchingProvider(provider)
        return { items: secretServiceRows(result.items) }
      }
      if (provider === protonPass) {
        const connection = entryConnection(service, provider, body.connection)
        const signal = credentialGeneration.signal
        const session = service.sessionOf?.({ provider })
        let result
        try { result = await service.listItems({ provider, connection, search, signal }) } catch {}
        if (result?.code === 'cloud') throw refusal(protonCloud)
        if (signal.aborted || session === undefined || service.sessionOf?.({ provider }) !== session) throw refusal(vaultLocked)
        if (result?.ok !== true || !Array.isArray(result.items)) throw refusal('The vault items could not be listed.')
        return { items: protonItems(result.items) }
      }
      const machineAccount = provider === secretsManager
      if (machineAccount && body.project !== undefined && (typeof body.project !== 'string' || !VAULT_ITEM_ID.test(body.project))) {
        throw refusal('Choose a valid vault reference.')
      }
      let result
      try {
        result = await service.listItems(providerArgs(service, provider, { connection: connectionOf(service, provider), search,
          ...(machineAccount && body.project !== undefined ? { project: body.project } : {}) }))
      } catch {}
      if (result?.code === 'cloud' && provider === 'onepassword') throw refusal(cloudVault)
      if (machineAccount && result?.ok !== true) throw managerRefusal(result, 'The vault items could not be listed.')
      if (result?.ok !== true || !Array.isArray(result.items)) throw refusal('The vault items could not be listed.')
      if (machineAccount && body.project === undefined) {
        if (!Array.isArray(result.projects)) throw refusal('The vault items could not be listed.')
        return { projects: result.projects.filter(row => typeof row?.id === 'string' && VAULT_ITEM_ID.test(row.id)
          && typeof row.name === 'string').map(({ id, name }) => ({ id, name })) }
      }
      const items = []
      const onePassword = provider === 'onepassword'
      for (const item of result.items.slice(0, 50)) {
        if (typeof item?.id !== 'string' || !(onePassword ? OP_ITEM_ID : VAULT_ITEM_ID).test(item.id)
          || typeof item.name !== 'string' || !Array.isArray(item.fields)) continue
        const fields = machineAccount ? item.fields.filter(row => row?.id === 'value').slice(0, 1)
          .map(() => ({ selector: 'value', label: 'Value' }))
          : onePassword ? onePasswordPickerFields(item.fields) : [...new Set(item.fields)].map(pickerField).filter(Boolean)
        if (fields.length > 0) items.push({ id: item.id, name: item.name, fields,
          ...((onePassword || machineAccount) && typeof item.vault === 'string' ? { vault: item.vault } : {}) })
      }
      return { items }
    },
    'vault-fields'(service, body) {
      if (body.provider !== hashicorp) throw refusal('Choose a vault provider.')
      return hashicorpPicker(service, body, true)
    },
  }

  // Credential entry and Secrets Manager Clear share the mapping write queue.
  let tokenRevision = 0
  let secretServiceEntry = new AbortController()
  let managerEntry = new AbortController()
  function cancelManagerEntry() {
    managerEntry.abort()
    managerEntry = new AbortController()
  }
  let managerRevision
  let managerReplacing = false
  let providerSwitch
  function vaultEndpoint(endpoint, body = {}, refresh = false) {
    const entry = endpoint === 'vault-unlock' || endpoint === 'vault-token-set'
    const typedGateEntry = endpoint === 'vault-unlock' && typedGateProvider(body.provider)
    const clear = endpoint === 'vault-token-clear'
    const managerMutation = (entry || clear) && body.provider === secretsManager
    const admitted = secretSources
    if (body.provider === protonPass) {
      if (!validProtonConnection(body.connection)) return Promise.reject(refusal('Choose a valid vault reference.'))
      if (endpoint === 'vault-token-set' && !validProtonToken(body.token)) {
        return Promise.reject(refusal('Enter your Proton Pass personal access token.'))
      }
    }
    const locking = endpoint === 'vault-lock' || (clear && (body.provider === 'onepassword' || fencedProvider(body.provider))
      && supportedProvider(admitted, body.provider))
    const secretServiceOnly = body.provider === GNOME_PROVIDER_ID
    const managerOnly = body.provider === secretsManager
    if (locking && secretServiceOnly) {
      secretServiceEntry.abort()
      secretServiceEntry = new AbortController()
    } else if (locking && managerOnly) {
      cancelManagerEntry()
    } else if (locking && typedGateProvider(body.provider)) {
      cancelTypedGateEntry(body.provider)
    } else if (locking) {
      if (body.provider === undefined || body.provider === 'bitwarden' || body.provider === 'onepassword') {
        cancelTypedGateEntry(windowsCredential)
      }
      advanceCredentialGeneration()
    }
    const entrySignal = secretServiceOnly ? secretServiceEntry.signal
      : managerOnly ? managerEntry.signal
      : typedGateEntry ? typedGateEntries.get(body.provider).signal : undefined
    // These locks also outdate a queued credential entry.
    if (locking && fencedProvider(body.provider)) tokenRevision++
    let generation = credentialGeneration
    const revision = endpoint === 'vault-token-set' && !managerMutation ? ++tokenRevision : tokenRevision
    const checkEntry = () => {
      // A newer replacement for the same provider can follow the activation that
      // selected it. An explicit lock, clear or another switch invalidates it.
      if (endpoint === 'vault-token-set' && body.provider === secretsManager && revision === tokenRevision
        && providerSwitch?.provider === secretsManager && providerSwitch.from === generation
        && providerSwitch.to === credentialGeneration) generation = credentialGeneration
      if ((body.provider !== windowsCredential && generation !== credentialGeneration)
        || admitted !== secretSources || entrySignal?.aborted) {
        throw refusal(vaultLocked)
      }
    }
    const dispatch = async () => {
      if (refresh) await rt.refresh()
      await loadSecrets()
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) throw refusal(readOnly, { code: 'bot/read-only' })
      if (managerMutation) checkManagerRevision(body)
      if (entry) checkEntry()
      const service = entry || clear ? admitted : secretSources
      if (service === undefined || service !== secretSources) throw refusal('The vault plugin is not on.')
      if (!Object.hasOwn(vaultRoutes, endpoint)) throw refusal('Unknown vault operation.')
      if (body.provider !== undefined && !validProvider(body.provider)) throw refusal('Choose a vault provider.')
      if (endpoint === 'vault-token-set' && !managerMutation && revision !== tokenRevision) {
        throw refusal(body.provider === hashicorp ? 'The Vault connection could not be set.'
          : body.provider === protonPass ? protonSetFailed : 'The 1Password service account token could not be set.')
      }
      const enter = async (provider, options, { method = 'unlock', replacing = false } = {}) => {
        checkEntry()
        if (provider === secretsManager) {
          const code = service.checkAvailability?.({ provider })
          if (code !== undefined) return { ok: false, code }
        }
        const managerSet = provider === secretsManager && method === 'setToken'
        if (replacing) {
          // Replacing credentials invalidates outstanding requests before the new credentials can be used.
          advanceCredentialGeneration()
          generation = credentialGeneration
          tokenRevision++
        }
        try {
          if (managerSet && replacing) {
            managerReplacing = true
            for (const [name, row] of sources) {
              // A prior failed required save may have already removed the in-memory card.
              if (row.provider === secretsManager) await revokeVault(name, { requireSave: true })
            }
            checkEntry()
          }
          const signal = provider === windowsCredential ? entrySignal
            : entrySignal === undefined ? generation.signal : AbortSignal.any([entrySignal, generation.signal])
          const pending = service[method](providerArgs(service, provider, Array.isArray(service.providers)
            ? { ...options, signal } : options))
          const revocations = replacing && !managerSet
            ? [...sources].filter(([, row]) => row.provider === provider).map(([name]) => revokeVault(name)) : []
          const [answer] = await Promise.all([pending, ...revocations])
          if (provider === secretsManager && (answer?.ok === true || answer?.committed === true)) managerRevision = randomUUID()
          return answer
        } finally {
          if (managerSet) managerReplacing = false
          if (admitted === secretSources) {
            const selection = service.providerSelection
            if (selection?.generation !== credentialSelection?.generation) {
              credentialSelection = selection
              // An explicit lock or clear may already have invalidated this entry.
              if (generation === credentialGeneration) {
                advanceCredentialGeneration()
                providerSwitch = { provider: selection?.provider, from: generation, to: credentialGeneration }
                generation = credentialGeneration
              }
            }
          }
        }
      }
      let answer
      try { answer = await vaultRoutes[endpoint](service, body, enter) }
      finally { if (entry) checkEntry() }
      if (secretSources !== service) throw refusal('The vault plugin is not on.')
      return answer
    }
    return entry || (locking && fencedProvider(body.provider)) || (clear && body.provider === secretsManager) ? mutate(dispatch) : dispatch()
  }

  // Internal cleanup only: the comparison and existing endpoint's map.delete run
  // in one synchronous segment after loading, so a newer value cannot be deleted
  // across secretEndpoint's load await. The existing commit owns durable writes.
  async function deleteSecretIfUnchanged(name, expectedValue) {
    if (stopped || typeof name !== 'string' || !SECRET_NAME.test(name) || typeof expectedValue !== 'string') return false
    try {
      await loadSecrets()
      if (stopped || blocked !== undefined || loadedReadOnly || rt.readOnly() !== undefined) return false
    } catch { return false }
    if (secrets.get(name)?.value !== expectedValue) return false
    return endpoints['secret-delete']({ name })
  }

  // Scopes each named secret to one Session, for a Session mount (capabilities.js). A secret
  // qualifies only while no Bot may use it; one already scoped to this Session stays so, and
  // one scoped to another Session is refused. The scope is saved, so it outlives a restart.
  // Checks and changes run in one synchronous stretch after loading, so two mounts cannot both
  // take one secret.
  async function bindSessionSecrets(names, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw refusal('Name the Session the secrets are for.')
    await loadSecrets()
    const bind = []
    for (const name of new Set(names)) {
      const unavailableReason = secretHeldReason(name)
      if (unavailableReason !== undefined) throw refusal(unavailableReason)
      const secret = secrets.get(name)
      if (secret === undefined) throw refusal(`No secret named ${name}. Save it in Settings → Secrets for no Bot first.`)
      if (secret.session === sessionId) continue
      if (secret.session !== undefined) throw refusal(`${name} is scoped to another Session.`)
      if (!forNoBot(secret)) throw refusal(`${name} is for ${scopeText(secret.scope)}. A Session's secret is one no Bot may use: in Settings → Secrets, choose Chosen Bots with none picked.`)
      bind.push(secret)
    }
    if (bind.length === 0) return
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refusal(readOnly)
    for (const secret of bind) secret.session = sessionId
    try {
      changed()
      await persist()
    } catch (error) {
      for (const secret of bind) if (secret.session === sessionId) delete secret.session
      changed()
      throw error
    }
  }
  async function sessionSecretNames(sessionId, { stored = false } = {}) {
    await loadSecrets()
    return [...secrets.values()].filter(secret => canUseInSession(secret, sessionId)
      && (stored || !unavailable(secret.name))).map(secret => secret.name)
  }
  // Ends the Session scope of each named secret still scoped to that Session: it is no Bot's
  // and no Session's again until a mount scopes it anew.
  async function releaseSessionSecrets(names, sessionId) {
    await loadSecrets()
    const released = []
    for (const name of new Set(names)) {
      const secret = secrets.get(name)
      if (secret?.session !== sessionId) continue
      delete secret.session
      released.push(secret)
    }
    if (released.length === 0) return false
    try {
      changed()
      await persist()
    } catch (error) {
      for (const secret of released) if (secret.session === undefined) secret.session = sessionId
      changed()
      throw error
    }
    return true
  }

  // A deleted Bot leaves every list it was on, and its cards go with it.
  const forgetBotSecrets = botId => mutate(async () => {
    await loadSecrets()
    for (const request of state.secretRequests?.[botId] ?? []) forgetVaultRequest(request)
    if (state.secretRequests !== undefined) delete state.secretRequests[botId]
    for (const [key, grant] of grants) if (grant.botId === botId) grants.delete(key)
    let touched = false
    for (const secret of secrets.values()) {
      if (Array.isArray(secret.scope) && secret.scope.includes(botId)) {
        secret.scope = secret.scope.filter(id => id !== botId)
        touched = true
      }
    }
    if (touched) {
      changed()
      await persist().catch(() => {})
    }
    const next = new Map(sources)
    for (const [name, row] of sources) {
      if (Array.isArray(row.scope) && row.scope.includes(botId)) {
        next.set(name, { ...row, scope: row.scope.filter(id => id !== botId) })
      }
    }
    if ([...next].some(([name, row]) => sources.get(name) !== row)) {
      await persistSources(next).then(() => {
        sources = next
        changed()
      }).catch(() => {})
    }
  })

  // What the card asks GitHub for, so the Bot words the same ask and never a broader one.
  const githubAsk = work => work.length === 0 ? ''
    : ` It shows the steps to make a fine-grained GitHub token with ${githubPermissions(work).map(entry => `${entry.label}: ${entry.access}`).join(', ')}, for ${GITHUB_TOKEN_DAYS} days. Do not ask for other permissions.`

  const callerOf = exec => rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id)

  async function requestVault(name, botId, args, exec) {
    const entry = { name, botId }
    const refuse = async (message, decision = 'refused') => {
      // A failed load leaves no verified mapping names to audit.
      if (sourcesBroken !== privateReference) await auditVault(sourcesBroken ? { botId } : entry, decision, decision)
      return message
    }
    const service = secretSources
    const session = exec.agent?.session
    const sessionId = session?.header?.id ?? exec.agent?.id
    const check = () => {
      if (sourcesBroken || secrets.has(name)) return sourceReason(name)
      if (service === undefined || secretSources !== service) return `${name} is unavailable because the vault plugin is off.`
      const mapping = mappingFor(name)
      if (!canUse(mapping, botId)) return outsideScope(name)
      if (managerReplacing && mapping?.provider === secretsManager) return vaultLocked
      if (rt.groupOwners.has(sessionId)) return groupCard
      if (rt.botOf(botId) === undefined || rt.chatOf(botId) !== sessionId) return ownChatCard
      const readOnly = rt.readOnly()
      if (readOnly !== undefined || !rt.holdsLock()) return `No card can be shown now. ${readOnly ?? 'This host cannot save the Bot team.'}`
    }
    let message = check()
    if (message !== undefined) return refuse(message)
    const { command, shell } = args
    if (typeof command !== 'string' || command.trim() === '' || typeof shell !== 'string' || shell.trim() === '') {
      return refuse(`Name the exact command and shell you will run: ${name} comes from a vault and is approved per command.`)
    }
    if (!shellTool(shell)) return refuse('Name the shell as bash or pwsh.')
    if (command.length > 4000) return refuse('The command is longer than 4,000 characters; shorten it and ask again.')
    const workdir = sessionFolder(session)
    if (workdir === undefined) return refuse('No working folder is set for this chat; nothing was asked.')
    const purpose = String(args.purpose ?? '')
    const hasSecretMaterial = row => {
      const fields = [command, purpose, workdir]
      if (fields.some(text => redactAnywhere(text) !== text)) return true
      if (row.provider !== windowsCredential) return fields.some(text => text.includes(row.item))
      for (const target of windowsTargets(sources)) {
        if (fields.some(text => mentionsWindowsTarget(text, target))) return true
      }
      return false
    }
    const unsafe = 'That request cannot be shown on a card; ask again without secret material in it.'
    const mapping = sources.get(name)
    const providerGate = gateBoundProvider(mapping.provider) ? providerGateOf(service, mapping.provider) : undefined
    const generation = credentialGeneration
    const managerSignal = managerEntry.signal
    const manager = mapping.provider === secretsManager
    const activationId = manager ? managerActivationOf(service) : undefined
    const managerActivationChanged = () => manager
      && (managerSignal.aborted || service !== secretSources || managerActivationOf(service) !== activationId)
    if (mapping.provider === GNOME_PROVIDER_ID && providerGate.token === undefined) return refuse(vaultUnavailable)
    if (wrongHashicorpConnection(service, mapping)) return refuse(vaultUnavailable)
    if (hasSecretMaterial(mapping)) return refuse(unsafe)
    const fingerprint = fingerprintOf(mapping)
    const status = await vaultStatus(service, mapping)
    if (managerActivationChanged()) return refuse(vaultLocked, 'locked')
    void loadSecrets()
    message = check()
    if (message !== undefined) return refuse(message)
    if (fingerprintOf(sources.get(name)) !== fingerprint) return refuse(changedMapping(name))
    if (wrongHashicorpConnection(service, mapping)) return refuse(vaultUnavailable)
    if (((fencedProvider(mapping.provider) || mapping.provider === secretsManager) && generation !== credentialGeneration)
      || (mapping.provider === GNOME_PROVIDER_ID && !providerGateCurrent(providerGate))) return refuse(vaultLocked)
    if (typedGateProvider(mapping.provider) && !providerGateCurrent(providerGate)) return refuse(vaultLocked)
    if (sessionFolder(session) !== workdir) return refuse('No working folder is set for this chat; nothing was asked.')
    if (hasSecretMaterial(sources.get(name))) return refuse(unsafe)
    entry.commandDigest = commandDigestOf(shell, workdir, command)
    if (status === undefined || !matchesLiveConnection(service, mapping)
      || (status === 'unlocked' && mapping.provider === hashicorp && hashicorpConnection(service) === undefined)) {
      return refuse(vaultUnavailable)
    }

    const now = Date.now()
    const pending = status === 'unlocked'
    if (manager && pending && activationId === undefined) return refuse(vaultLocked, 'locked')
    const proton = mapping.provider === protonPass
    const protonSession = proton ? service.sessionOf?.({ provider: protonPass }) : undefined
    if (proton && pending && protonSession === undefined) return refuse(vaultLocked)
    const list = requestsOf(botId)
    const audits = []
    for (const previous of list) {
      const active = previous.status === 'pending' || (previous.status === 'allowed' && approving.has(previous))
      if (previous.name !== name || !active) continue
      if (previous.source === 'vault') {
        const entry = vaultAuditOf(botId, previous)
        cancelVaultRequest(previous)
        audits.push(auditVault(entry, 'canceled', 'revoked'))
      } else settle(botId, previous, 'canceled')
    }
    const request = {
      id: randomUUID(),
      ...(exec.callId ? { callId: exec.callId } : {}),
      sessionId, name, purpose: purposeOf(purpose), kind: 'allow', source: 'vault',
      command, shell, workdir, commandDigest: entry.commandDigest,
      status: pending ? 'pending' : 'locked',
      askedAt: now, ...(!pending ? { settledAt: now } : {}),
    }
    list.push(request)
    if (pending) vaultRequests.set(request.id, { botId, sessionId, name, fingerprint, commandDigest: entry.commandDigest,
      ...(manager ? { managerActivation: { id: activationId, service } } : {}),
      ...(providerGate === undefined ? {} : { providerGate }),
    })
    trimRequests(list)
    audits.push(auditVault(entry, pending ? 'asked' : 'locked', pending ? 'ok' : 'locked'))
    await rt.save()
    const windowsGateClosed = mapping.provider === windowsCredential && !providerGateCurrent(providerGate)
    await Promise.all(audits)
    if (managerActivationChanged()) return refuse(vaultLocked, 'locked')
    if (((mapping.provider === hashicorp || mapping.provider === secretsManager) && generation !== credentialGeneration)
      || (mapping.provider === GNOME_PROVIDER_ID && !providerGateCurrent(providerGate))) {
      if (mapping.provider === GNOME_PROVIDER_ID && request.status === 'pending') {
        cancelVaultRequest(request)
        await rt.save()
      }
      return vaultLocked
    }
    if (proton && (generation !== credentialGeneration || service.sessionOf?.({ provider: protonPass }) !== protonSession)) {
      if (request.status !== 'canceled') {
        cancelVaultRequest(request)
        await auditVault(entry, 'canceled', 'revoked')
        await rt.save()
      }
      return vaultLocked
    }
    if (pending && typedGateProvider(mapping.provider) && (windowsGateClosed || !providerGateCurrent(providerGate))) {
      if (stillListed(botId, request) && request.status === 'pending') {
        cancelVaultRequest(request)
        await rt.save()
      }
      await auditVault(entry, 'locked', 'locked')
      return vaultLocked
    }
    if (!pending) {
      await tell(botId, vaultLocked)
      return vaultLocked
    }
    exec.concludeTurn?.()
    return `The card asking the user to approve the exact command for ${name} is on screen. A note arrives when the user answers.`
  }

  rt.teamTools.push(defineTool({
    name: 'request_secret',
    description: 'Ask the user for a key, token, or password through a secure card in your own chat. The user types it into the card; you never see the value. It reaches your shell as an environment variable. When the key is already saved for you, this only tells you its variable. Showing a card ends your turn; a note arrives when the user saves or cancels.',
    parameters: {
      name: { type: 'string', required: true, description: 'Key name in capitals, digits, and underscores, e.g. GITHUB_TOKEN' },
      purpose: { type: 'string', required: true, description: 'One short line for the user: what you need it for. For GitHub, leave the permissions out: the card lists them' },
      command: { type: 'string', description: 'For a vault key, the exact command to approve' },
      shell: { type: 'string', description: 'For a vault key, the shell that will run the command: bash or pwsh' },
      github: { type: 'array', items: { type: 'string', enum: Object.keys(GITHUB_WORK) }, description: 'For a GitHub token (GITHUB_TOKEN, GH_TOKEN), required: the work you will do with it. edit_code to push commits, open_prs to open or update pull requests, read_code, read_prs, read_issues, edit_issues. The card shows the user how to make a fine-grained token with only the permissions this work needs' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      await loadSecrets()
      const id = exec.agent?.id
      const bot = rt.botOf(callerOf(exec))
      if (bot === undefined) return 'Only Bots on the team can use request_secret.'
      const name = normalizeName(args.name)
      if (!SECRET_NAME.test(name)) return 'Name the key with capitals, digits, and underscores, starting with a letter (for example GITHUB_TOKEN).'
      if (sourcesBroken || sources.has(name)) return requestVault(name, bot.id, args, exec)
      const { work, unknown } = cleanGitHubWork(args.github)
      if (unknown.length > 0) return `Unknown GitHub work: ${unknown.join(', ')}. Pass github with ${Object.keys(GITHUB_WORK).join(', ')}.`
      const stored = secrets.get(name)
      // A Session's secret is never offered to a Bot, not even on a card.
      if (stored?.session !== undefined) return `${sessionOnly(name)} Ask for your key under another name.`
      // A held entry is invisible to a Bot: asking again shows the fill card, so the user
      // can replace the unredactable value.
      const secret = held(stored) ? undefined : stored
      if (canUse(secret, bot.id)) return `${name} is already saved and you may use it: ${usage(name)}. You cannot see the value; never print it.`
      // A new GitHub token is made for declared work only (#316), so the card never asks for a
      // broader one; a saved key is only allowed or replaced.
      if (secret === undefined && work.length === 0 && isGitHubTokenName(name)) return `Say what you will do with ${name}: pass github with ${Object.keys(GITHUB_WORK).join(', ')} (edit_code and open_prs to push commits and open pull requests). The card then asks for only the permissions that work needs.`
      if (rt.groupOwners.has(id)) return groupCard
      if (!rt.chatOwners.has(id)) return ownChatCard
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`
      const list = requestsOf(bot.id)
      const now = Date.now()
      for (const request of list) {
        if (request.status === 'pending' && request.name === name) {
          request.status = 'canceled'
          request.settledAt = now
        }
      }
      list.push({
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        sessionId: id,
        name,
        purpose: String(args.purpose ?? '').trim().slice(0, 300),
        kind: secret ? 'allow' : 'fill',
        ...(work.length > 0 ? { github: work } : {}),
        status: 'pending',
        askedAt: now,
      })
      trimRequests(list)
      await rt.save()
      exec.concludeTurn?.()
      return secret
        ? `The card asking the user to let you use ${name} is on screen. A note arrives when the user answers; you will not see the value.`
        : `The card asking the user for ${name} is on screen.${githubAsk(work)} A note arrives when the user saves or cancels; you will not see the value.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'list_secrets',
    description: 'List the keys the user saved for the team: name, purpose, which Bots may use them, and whether you may. Values are never shown.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      await loadSecrets()
      const self = callerOf(exec)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use list_secrets.'
      if (sourcesBroken) return brokenSources
      // A Session's secret is never offered to a Bot: not listed here, and a Bot that names it
      // in request_secret is only told it cannot have it. A collision is still reported.
      const listed = secretsView().filter(secret => secret.session === undefined || sources.has(secret.name))
      for (const [name, row] of sources) if (!secrets.has(name)) listed.push(sourceView(name, row))
      if (listed.length === 0) return 'No keys are saved yet. Ask for one with request_secret.'
      const service = secretSources
      const mapping = sources.values().next().value
      const status = service !== undefined && [...sources.keys()].some(name => !secrets.has(name))
        ? await vaultStatus(service, mapping) : undefined
      const currentMapping = sources.values().next().value
      const vaultUse = secretSources === undefined ? 'unavailable: it comes from a vault, and the vault plugin is off'
        : secretSources !== service || status === undefined || currentMapping === undefined
          || !sameConnection(mapping, currentMapping) || !matchesLiveConnection(service, currentMapping)
          ? 'unavailable: the vault did not answer'
          : status === 'unlocked' ? 'available: ask with request_secret, naming the exact command and shell'
            : 'locked: the user must unlock the vault'
      return [
        'Saved keys (values are never shown):',
        ...listed.sort((a, b) => a.name.localeCompare(b.name)).map((secret) => {
          const stored = secrets.get(secret.name)
          const use = sources.has(secret.name)
            ? stored !== undefined ? 'unavailable: this name is defined both in secrets.json and in vault-sources.json'
              : vaultUse
            : held(stored)
            ? `held: its saved value is shorter than ${MIN_VALUE} characters, so nothing uses it; save a new value`
            : canUse(stored, self) ? `you may use it as $${envName(secret.name)}` : 'you may not use it; ask with request_secret'
          return `- ${secret.name}${secret.purpose ? ` — ${secret.purpose}` : ''} — for ${scopeText(secret.scope)} — ${use}`
        }),
      ].join('\n')
    },
  }))

  // The next shell attempt that reaches execute uses up the approval. Part 2a
  // always refuses that attempt before either the tool body or an adapter read.
  async function refuseVaultExecution(exec, next) {
    if (!shellTool(exec.name)) return next()
    const session = exec.agent?.session
    const key = grantKey(callerOf(exec), session?.header?.id ?? exec.agent?.id)
    const grant = grants.get(key)
    if (grant === undefined) return next()
    grants.delete(key)
    const args = exec.arguments ?? {}
    const activation = grant.managerActivation
    const staleActivation = activation !== undefined && !matchesManagerActivation(secretSources, activation)
    let message
    if (staleActivation) message = vaultLocked
    else if (Date.now() >= grant.expiresAt) message = `The approval for ${grant.name} expired; ask again.`
    else if (grant.providerGate !== undefined && !providerGateCurrent(grant.providerGate)) message = vaultLocked
    else if (exec.parent !== undefined || Object.hasOwn(args, 'workdir')
      || commandDigestOf(exec.name, sessionFolder(session), args.command) !== grant.commandDigest) {
      message = 'The approved command, shell or folder was different; ask again.'
    } else message = 'Vault values cannot reach a shell on this version; nothing was read.'
    const decision = staleActivation ? 'locked' : 'refused'
    await auditVault(grant, decision, decision)
    return { isError: true, error: { message }, content: [{ type: 'text', text: 'Error: ' + message }] }
  }

  // Tool results lose the values before the registry renders and saves them. Every
  // field is redacted — a wrapper further out in the pipeline still sees a whole
  // result (its `content`, `meta`, and `additionalContexts` too), and the registry
  // re-renders a changed success result from its redacted value.
  ctx.on('tools/execute', async function redactToolResult(exec, next) {
    const result = await next()
    if (result === null || typeof result !== 'object') return result
    const mask = redactorForOutput()
    return mask === undefined ? result : redactDeep(result, mask)
  })

  // Anything that still carries a value (the user pasted it, an earlier part kept it)
  // is replaced before the request leaves. `next` cannot take new options, so the
  // request starts over; it then carries no value and passes through here.
  // A value that is part of its own label would be replaced again on every pass, so a
  // request this listener rewrote passes straight through.
  // The agent loop mark belongs to the request object, so carry it to the copy
  // to keep agent routes accepting the redacted request.
  const redactModelFields = ({ messages, system }) => {
    const mask = redactorForOutput()
    return mask === undefined ? { messages, system }
      : { messages: redactDeep(messages, mask), system: redactDeep(system, mask) }
  }
  const rewritten = new WeakSet()
  ctx.on('llm/stream', function redactModelRequest(options, next) {
    if (rewritten.has(options.messages)) return next()
    const { messages, system } = redactModelFields(options)
    if (messages === options.messages && system === options.system) return next()
    const fresh = [...(messages ?? [])]
    rewritten.add(fresh)
    rt.carryUsageTag(options.messages, fresh)
    const request = { ...options, messages: fresh, ...(system !== undefined ? { system } : {}) }
    if (isAgentLoopRequest(options)) markAgentLoopRequest(freezeLoopRequest(request))
    return ctx.llm.stream(request)
  })

  function resolveEnv(execution) {
    // loadSecrets reads synchronously, including on a host that follows another writer.
    void loadSecrets()
    if (sourcesBroken) return {}
    const botId = rt.selfOf(execution?.agent?.session?.header?.id ?? execution?.agent?.id)
    if (rt.botOf(botId) === undefined) return {}
    const command = typeof execution.arguments?.command === 'string' ? execution.arguments.command : ''
    const values = {}
    let used = false
    for (const secret of secrets.values()) {
      if (unavailable(secret.name) || held(secret) || !canUse(secret, botId)) continue
      values[envName(secret.name)] = secret.value
      if (command.includes(envName(secret.name))) {
        secret.lastUsedAt = Date.now()
        used = true
      }
    }
    if (used) noteUsed()
    return values
  }

  // Keys must be declared up front, so the contribution is registered again whenever
  // the set of names (or a purpose, which describes the key) changes.
  function attachShellEnv(sub) {
    let unregister = null
    let declared = ''
    refreshEnv = () => {
      // A Session's secret reaches no shell, so it is not declared to any.
      const list = [...secrets.values()].filter(secret => !unavailable(secret.name) && !held(secret) && secret.session === undefined).sort((a, b) => a.name.localeCompare(b.name))
      const key = list.map(secret => `${secret.name}\u0000${secret.purpose}`).join('\n')
      if (key === declared) return
      unregister?.()
      unregister = null
      declared = key
      if (list.length === 0) return
      try {
        unregister = sub.shellEnv.register({
          name: 'ds-bot-secrets',
          variables: Object.fromEntries(list.map(secret => [envName(secret.name), { description: `Omni secret ${secret.name}${secret.purpose ? `: ${secret.purpose}` : ''}` }])),
          resolve: resolveEnv,
        })
      } catch (error) {
        declared = ''
        rt.warn('ds-bot: secrets not offered to the shell: %s', error?.message ?? error)
      }
    }
    refreshEnv()
    sub.effect(() => () => {
      unregister?.()
      unregister = null
      declared = ''
      refreshEnv = () => {}
    }, 'ds-bot: secrets shell env')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shellEnv'], sub => attachShellEnv(sub))
  } else if (ctx.get?.('shellEnv') !== undefined) {
    attachShellEnv({ shellEnv: ctx.get('shellEnv'), effect: (execute, label) => ctx.effect(execute, label) })
  }

  ctx.effect(() => {
    void loadSecrets()
    return () => {
      stopped = true
      grants.clear()
      vaultRequests.clear()
      snapshots.clear()
      if (usedTimer !== null) clearTimeout(usedTimer)
    }
  }, 'ds-bot: load secrets')

  Object.assign(rt, {
    secretsView,
    secretSourcesView,
    secretSourcesPresent: () => sourcesPresent,
    secretStored: name => secrets.has(name) && !held(secrets.get(name)),
    secretValue: name => (unavailable(name) || held(secrets.get(name)) ? undefined : secrets.get(name)?.value),
    canUseSecret: (name, botId) => !unavailable(name) && !held(secrets.get(name)) && canUse(secrets.get(name), botId),
    canUseSecretInSession: (name, sessionId) => !unavailable(name) && !held(secrets.get(name)) && canUseInSession(secrets.get(name), sessionId),
    bindSessionSecrets,
    releaseSessionSecrets,
    sessionSecretNames,
    secretHeldReason,
    secretSourceReason: sourceReason,
    secretEndpoint,
    secretServiceDetail: requestId => vaultRequests.get(String(requestId ?? ''))?.providerGate?.provider === GNOME_PROVIDER_ID,
    vaultEndpoint,
    deleteSecretIfUnchanged,
    forgetBotSecrets,
    loadSecrets,
    redactSecrets: text => redact(text),
    connectorDiagnosticRedactor: redactorForOutput,
    redactModelFields,
    redactSecretsAnywhere: text => redactAnywhere(text),
  })
}
