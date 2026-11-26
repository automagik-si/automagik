import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RULES, checkCopy, omniKeys } from '../scripts/copy-check.mjs'
import { loadDictionaries } from '../scripts/dictionaries.mjs'
import { hostText, installLocale } from '../../bots-dsh/src/client/i18n.js'

test('the copy check is green', async () => {
  assert.deepEqual(await checkCopy(), [])
})

test('the omni-ui keys the pack translates are still the Bot team\'s', async () => {
  const keys = await omniKeys()
  assert.ok(keys.size > 1000, `only ${keys.size} omni-ui keys found`)
})

// A pack with one of each fault, against a two-key reference.
test('the copy check finds each kind of fault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-br-copy-'))
  mkdirSync(join(dir, 'pt-BR'))
  const reference = join(dir, 'en.json')
  writeFileSync(reference, JSON.stringify({ sidebar: { a: 'Open {name}', b: 'Close', c: 'Saved', d: 'Done' } }))
  const fault = {
    a: 'Abra o Unfold', b: 'Toque para fechar', c: 'Bem-vindo de volta', d: 'O ficheiro na sandbox', extra: 'Sobra',
  }
  writeFileSync(join(dir, 'pt-BR', 'sidebar.json'), JSON.stringify(fault))
  const findings = await checkCopy({ folder: join(dir, 'pt-BR'), reference, omni: new Set() })
  const has = (pattern) => assert.ok(findings.some((line) => pattern.test(line)), `no finding matches ${pattern}:\n${findings.join('\n')}`)
  has(/sidebar:a: drops or adds a placeholder/)
  has(/sidebar:a: puts an article before Unfold/)
  has(/sidebar:b: says tap/)
  has(/sidebar:c: uses a gendered word for the person/)
  has(/sidebar:d: is European Portuguese/)
  has(/sidebar:d: says sandbox/)
  has(/sidebar:extra: not an en key/)
})

// European Portuguese forms are refused; their Brazilian counterparts, and words that only contain
// one of them, pass.
test('the copy check tells European from Brazilian Portuguese', () => {
  const european = RULES.filter(([rule]) => rule === 'is European Portuguese').map(([, pattern]) => pattern)
  const refused = (text) => european.some((pattern) => pattern.test(text))
  for (const text of ['Não foi possível aceder à pasta', 'Partilhar o link', 'Partilhe esta sessão', 'Premir Enter para enviar',
    'Carregue em Enviar', 'Carregue no botão Enviar', 'A carregar…', 'Está a carregar', 'O ecrã principal']) {
    assert.ok(refused(text), `"${text}" should be refused`)
  }
  for (const text of ['Guardar uma cópia', 'Guarde as credenciais em ~/.npmrc', 'Comprima e tente de novo', 'Copiado para a área de transferência',
    'Compartilhar o link', 'Carregando…', 'Clique em Enviar', 'Gerenciar plugins', 'A partir de hoje', 'A seguir, escolha um modelo', 'A seguir…',
    'A mulher', 'A colher', 'Carregue em segundo plano', 'Transferir a sessão para outro espaço de trabalho', 'Gerir', 'Rato', 'A prima dela',
    'Matéria-prima']) {
    assert.ok(!refused(text), `"${text}" is Brazilian Portuguese`)
  }
})

test('the Solver look refusals pass the copy check and hostText words them in pt-BR', async () => {
  const pack = loadDictionaries()['omni-ui']
  const findings = await checkCopy()
  const off = installLocale({
    register: () => () => {},
    bind: () => key => pack[key] ?? key,
    getLocale: () => ({ active: 'pt' }),
  })
  try {
    for (const key of [
      'Only a Solver wears the Solver characters. Choose another character.',
      'A Solver wears one of the Solver characters. Choose one of those characters.',
      'Only the person can make a Bot a Solver.',
      'That look is not valid. Choose another character.',
    ]) {
      assert.ok(pack[key], key)
      assert.ok(!findings.some(finding => finding.includes(key)), key)
      assert.equal(hostText(key), pack[key])
    }
  } finally { off() }
})

test('AN-6 hostText words the Solver agent refusal in pt-BR', () => {
  const pack = loadDictionaries()['omni-ui']
  const off = installLocale({
    register: () => () => {},
    bind: () => key => pack[key] ?? key,
    getLocale: () => ({ active: 'pt' }),
  })
  try {
    assert.equal(hostText('Antigravity cannot be a Solver yet. Choose another agent for the Solver.'),
      'O Antigravity ainda não pode ser um Solver. Escolha outro agente para o Solver.')
  } finally { off() }
})
