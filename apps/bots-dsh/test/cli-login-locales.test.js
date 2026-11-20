// The sign-in row shows a host sentence through hostText() (src/client/api.js), which words it from
// the Chinese copy (src/client/i18n.js ZH) and from a registered language pack (the pt-BR pack's
// omni-ui.json) by its exact English key. A sentence this host adds without both entries falls back
// to English in both languages, which the reviewer of #1436 and #1437 found (FIX-FIRST, both PRs).
// The keys are literal here on purpose: a rename in the host must be re-worded in the packs anyway.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DICTIONARY, hostText, hostTemplateOf, installLocale } from '../src/client/i18n.js'

const here = dirname(fileURLToPath(import.meta.url))
const ptBR = JSON.parse(readFileSync(join(here, '..', '..', 'locale-pt-br-dsh', 'src', 'client', 'locales', 'pt-BR', 'omni-ui.json'), 'utf8'))

// Every sentence the sign-in path can put in a Bot's chat: the refusal codes, the attempt's fixed
// causes, and the ones that name another Automagik session.
const SENTENCES = [
  'This coding agent signs in from its own terminal. Run its sign-in command there, then try again.',
  'The CLI did not offer a sign-in link in time. Try again.',
  'The CLI could not be started. Run it once in a terminal, then try again.',
  'The CLI returned an old sign-in link. Update it, then try again.',
  'The CLI did not confirm the sign-in. Try again.',
  'The CLI exited before the sign-in finished. Try again.',
  'Another Automagik session on this computer is using the Bot account. Close it, then press Sign in again.',
  'The Bot account is busy in another Automagik session on this computer. Close it, then press Sign in again.',
  'The Bot account is already changing. Try again when it finishes.',
  'The Bot account changed. Sign in again.',
  'This coding agent is not signed in any more. Press Sign in again.',
  'Automagik is restarting. Try again in a moment.',
  'This installation keeps no record of the Bot account. Sign in again; if it keeps happening, the instance needs its profile repaired.',
  'The Bot account cannot be changed from this session. Use the app on this computer.',
  'Install the coding agent before signing in.',
  'Signing out of the Bot account did not finish. Try again.',
  'Signing out of the Bot account could not be verified. Try again.',
  'The Bot account was reset. Press Sign in again.',
  'This sign-in is not available for this Bot.',
  // Whose sign-in is whose (#1399): the account card names this installation and says the Bot
  // sign-in may be shared with another one on this computer.
  'This installation: {installation}',
  'Other Automagik installations on this computer may use this same Bot sign-in. A change here changes it for all of them.',
]

// The two sentences that carry a failure class: the host words them with the class in them, so the
// pack translates the template and hostText() fills it.
const TEMPLATES = [
  ['Could not continue this sign-in (acp-net/unreachable). Try again.', 'Could not continue this sign-in ({kind}). Try again.'],
  ['The account could not be confirmed (acp-account/mismatch). Try again.', 'The account could not be confirmed ({kind}). Try again.'],
]

test('every sign-in sentence this host words is translated in zh and in pt-BR', () => {
  for (const sentence of SENTENCES) {
    assert.equal(typeof DICTIONARY.zh[sentence], 'string', `zh: ${sentence}`)
    assert.equal(typeof ptBR[sentence], 'string', `pt-BR: ${sentence}`)
    assert.notEqual(ptBR[sentence], '', `pt-BR: ${sentence}`)
    assert.notEqual(ptBR[sentence], sentence, `pt-BR still English: ${sentence}`)
  }
})

// The same check the row makes: with the interface in Chinese, hostText() words the sentence from
// the dictionary, and the class-carrying one from its template with the class filled in.
function fakeLocale(active) {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

test('the row words the new sentences in Chinese instead of falling back to English', () => {
  const off = installLocale(fakeLocale('zh'))
  try {
    for (const sentence of SENTENCES) assert.notEqual(hostText(sentence), sentence, sentence)
    for (const [message, template] of TEMPLATES) {
      const filled = hostText(message)
      assert.notEqual(filled, message, message)
      // The class travels into the sentence unchanged.
      assert.ok(filled.includes(message.slice(message.indexOf('(') + 1, message.indexOf(')'))), filled)
      assert.equal(hostTemplateOf(message), template)
    }
  } finally {
    off()
  }
})

test('the failure-class sentences are templates in both languages', () => {
  for (const [message, template] of TEMPLATES) {
    assert.equal(hostTemplateOf(message), template, message)
    assert.equal(typeof DICTIONARY.zh[template], 'string', `zh: ${template}`)
    assert.equal(typeof ptBR[template], 'string', `pt-BR: ${template}`)
    // The class is an identifier, so the template keeps it unchanged in both languages.
    assert.match(DICTIONARY.zh[template], /\{kind\}/, template)
    assert.match(ptBR[template], /\{kind\}/, template)
  }
})

test('a sentence from this list that the packs do not know would fall back to English', () => {
  // The guard against a stale pack: the count both sides carry is the list above, so a new sentence
  // added to the host without its two entries fails the first test, not the interface.
  for (const sentence of SENTENCES) assert.notEqual(DICTIONARY.zh[sentence], undefined, sentence)
})

const RESERVATION_SENTENCES = [
  'The reservation record cannot be read here; nothing was changed.',
  'The reservation record has unsafe permissions.',
  'This installation has no instance id; reservations are off.',
  'This version cannot read the account evidence needed for reservations.',
  'Sign in to reserve this account.',
  'The sign-in could not be read; reservations wait.',
  'Recover the Bot sign-in before reserving this account.',
  'This reservation changed. Look again.',
  'The account could not be read for reservations. Try again.',
  'This account cannot be reserved.',
  'Update Claude Code: this version does not name the organisation.',
  'This Codex plan is not known to this version.',
  'Only a subscription sign-in can be reserved.',
  'The CLI did not show an email for this account.',
  'Give the project a name, up to 60 characters.',
  'This reservation request is no longer valid. Look again.',
  'The reservation could not be saved. Try again.',
  'This window cannot change the Bot team.',
]
const FOREIGN_RESERVATION = 'This account is reserved for {label} by another installation that shares this team.'

test('reservation refusals and states have zh and pt-BR host copy', () => {
  const off = installLocale(fakeLocale('zh'))
  try {
    for (const sentence of RESERVATION_SENTENCES) {
      for (const dictionary of [DICTIONARY.zh, ptBR]) {
        assert.ok(dictionary[sentence]?.trim(), sentence)
        assert.notEqual(dictionary[sentence], sentence, sentence)
      }
      assert.equal(hostText(sentence), DICTIONARY.zh[sentence])
    }
    const label = 'Example {project}'
    const message = FOREIGN_RESERVATION.replace('{label}', label)
    assert.equal(hostTemplateOf(message), FOREIGN_RESERVATION)
    assert.equal(hostText(message), DICTIONARY.zh[FOREIGN_RESERVATION].replace('{label}', label))
    assert.match(ptBR[FOREIGN_RESERVATION], /\{label\}/)
  } finally {
    off()
  }
})
