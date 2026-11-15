import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CODEX_RECORD, createCompanionActions } from '../src/host/companion.js'

test('missing and expired image sign-ins direct the person to Codex', async () => {
  for (const expired of [false, true]) {
    const ctx = { credentials: {
      readRecord: async key => expired && key === CODEX_RECORD ? { kind: 'grant', payload: { access: 'test', expires: 1 } } : undefined,
      resolve: async () => undefined,
    }, get: () => ({ authScope: 'shared', generateImage: () => assert.fail('no image run'), imageAccess: async () => ({ ready: false }) }) }
    const actions = createCompanionActions(ctx, { fetch: () => assert.fail('no network'), now: () => 100_000 })
    await assert.rejects(actions['companion-generate']({ description: 'a friendly cloud' }), error => {
      assert.equal(error.message, expired
        ? 'Your earlier ChatGPT sign-in has run out. Sign in to Codex in Connect AI, or pick a companion instead.'
        : 'Sign in to Codex first, or pick a companion instead.')
      assert.doesNotMatch(error.message, /OpenAI key/)
      return true
    })
  }
})

test('the companion note and its pt-BR translation use the new wording', async () => {
  const text = 'Drawing a companion needs Codex signed in. Sign in to Codex in the AI step, then come back from Settings. For now, pick one.'
  const pt = 'Para desenhar uma companhia, é preciso entrar no Codex. Entre no Codex no passo de IA e volte por Configurações. Por enquanto, escolha um personagem.'
  const client = await readFile(new URL('../src/client/companion.js', import.meta.url), 'utf8')
  const locale = await readFile(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
  assert.ok(client.includes(`t('${text}')`))
  assert.ok(locale.includes(`'${text}': '${pt}'`))
  assert.ok(!client.includes('Drawing a companion needs Codex signed in or an OpenAI key'))
  assert.ok(client.includes('Drawn with your OpenAI key (gpt-image-1)'))
})
