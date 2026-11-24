import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, hostTemplateOf, hostText, installLocale } from '../src/client/i18n.js'

const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))

test('crossing confirmation and recovery guidance are worded in zh and pt-BR', () => {
  for (const key of [
    'Change route?',
    'Change agent?',
    'Changing the route requires a new conversation if this one has history.',
    'Changing the agent requires a new conversation if this one has history.',
    // The question a crossing asks while a reply runs (RFC 0030, Handoff note, 2026-11-23).
    'This stops the current reply and continues on {agent}.',
    'Switch',
    'Cancel',
  ]) {
    assert.ok(DICTIONARY.zh[key], key)
    assert.ok(pt[key], key)
  }
})

test('both versions of the refusal are host-text templates with translated guidance', () => {
  for (const goal of [false, true]) {
    const template = "{name}'s conversation has history, so changing to {route} needs a new conversation. Use New conversation, then pick {route}"
      + (goal ? ' (pause an active goal first).' : '.')
    const message = template.replace('{name}', 'Test Bot').replaceAll('{route}', 'ACP')
    assert.equal(hostTemplateOf(message), template)
    for (const [active, dictionary, action, pause] of [
      ['zh', DICTIONARY.zh, /新对话/, /暂停/],
      ['pt-BR', pt, /Nova conversa/, /pause/],
    ]) {
      const dispose = installLocale({
        register: () => () => {},
        getLocale: () => ({ active }),
        bind: () => (key, params) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? _),
      })
      try {
        const localized = hostText(message)
        assert.match(localized, action)
        assert.equal(pause.test(localized), goal)
        assert.match(localized, /Test Bot/)
        assert.match(localized, /ACP/)
      } finally {
        dispose()
      }
    }
  }
})

test('RFC 0030 quotes the original Decided 6 and dates the refusal amendment below it', () => {
  const rfc = readFileSync(new URL('../../../docs/rfcs/0030-code-mode-in-the-app.md', import.meta.url), 'utf8')
  const decided = rfc.slice(rfc.indexOf('6. **'), rfc.indexOf('7. **'))
  assert.equal(decided.split('\n')[0],
    '6. **Harness change = new conversation with a handoff note.** No history is carried across harnesses.')
  assert.match(decided, /\n\n {3}\*\*2026-11-20, Q7a B-min amendment\.\*\*[^]*refuses[^]*history[^]*New conversation/)
})

test('RFC 0030 scopes the history reason and retains the earlier hookless refusal', () => {
  const rfc = readFileSync(new URL('../../../docs/rfcs/0030-code-mode-in-the-app.md', import.meta.url), 'utf8')
  const handoff = rfc.slice(rfc.indexOf('### Handoff note'), rfc.indexOf('### Mod by mod')).replaceAll(/\s+/g, ' ')
  assert.match(handoff, /picks that reach the history decision[^.]*`needs-new-conversation`/i)
  assert.match(handoff, /a hookless host keeps its earlier `handoff unavailable` refusal for ordinary history/i)
})

test('RFC 0030 attributes the Decided 10 crossing amendment to November 20', () => {
  const rfc = readFileSync(new URL('../../../docs/rfcs/0030-code-mode-in-the-app.md', import.meta.url), 'utf8')
  const decided = rfc.slice(rfc.indexOf('\n10. **The selector'), rfc.indexOf('\n## Words')).trim()
  const [original, amendment] = decided.split('\n\n')
  assert.match(original, /starts a new conversation with a handoff note \(Decided 6\)/)
  assert.match(amendment ?? '', /2026-11-20 Q7a B-min amendment[^]*Decided 10/)
})

test('RFC 0003 puts the remaining threshold rules alongside the explicit pick refusal', () => {
  const rfc = readFileSync(new URL('../../../docs/rfcs/0003-model-routes-and-acp.md', import.meta.url), 'utf8')
  const rules = rfc.slice(rfc.indexOf('**Explicit harness changes'), rfc.indexOf('**A switch that fails goes back.**'))
    .replaceAll(/\s+/g, ' ')
  assert.match(rules, /switchRoute` refuses a pick for a chat with history/)
  assert.match(rules, /route writers that remain[^]*destination's own switch threshold/)
  assert.match(rules, /checkpoint only when the team chose a background model in Settings \(`prefs\.backgroundModel`\) and the chat fits that model/)
  assert.match(rules, /new part that carries the latest messages that fit, with no handoff note and no model call/)
  assert.match(rules, /archived only after the new part's first answer/)
})
