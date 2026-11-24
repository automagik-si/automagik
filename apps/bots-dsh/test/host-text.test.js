// A host message in the interface language: a language pack's entry for it wins, in any
// language (the pt-BR pack, or a plugin's words); Chinese also has its patterns.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { hostText, installLocale } from '../src/client/i18n.js'

function locale(active, words) {
  return {
    register: () => () => {},
    bind: () => key => words[key] ?? key,
    getLocale: () => ({ active }),
  }
}

test('a pack\'s entry for a host message words it in that language; anything else stays as sent', () => {
  const off = installLocale(locale('pt-BR', { 'Unfold is not reachable from here right now': 'Não dá para falar com Unfold daqui agora' }))
  try {
    assert.equal(hostText('Unfold is not reachable from here right now'), 'Não dá para falar com Unfold daqui agora')
    assert.equal(hostText('Model x is not available. Available: y'), 'Model x is not available. Available: y')
  } finally { off() }
  const zh = installLocale(locale('zh-CN', {}))
  try {
    assert.equal(hostText('Model x is not available. Available: y'), '模型 x 不可用。可用的：y')
  } finally { zh() }
  assert.equal(hostText('Unfold is not reachable from here right now'), 'Unfold is not reachable from here right now')
})

test('a model access refusal and a switch DSH turned down are worded with the values they carry', () => {
  const words = {
    'Sign in to {connection} before using this model.': 'Faça login em {connection} antes de usar este modelo.',
    '{name} could not switch to {model}. It stays on {kept}.': '{name} não conseguiu mudar para {model}. Continua em {kept}.',
  }
  const fill = (key, params) => (words[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match)
  const off = installLocale({ register: () => () => {}, bind: () => fill, getLocale: () => ({ active: 'pt' }) })
  try {
    assert.equal(hostText('Sign in to Codex (acp-codex) before using this model.'), 'Faça login em Codex (acp-codex) antes de usar este modelo.')
    assert.equal(hostText('Omni could not switch to acp-codex/default. It stays on deepseek/v4.'), 'Omni não conseguiu mudar para acp-codex/default. Continua em deepseek/v4.')
    assert.equal(hostText('Something else.'), 'Something else.')
  } finally { off() }
  // Without a language pack the message stays as sent.
  assert.equal(hostText('Sign in to Codex (acp-codex) before using this model.'), 'Sign in to Codex (acp-codex) before using this model.')
})

// #877: the adopt refusals that carry values (a Session id, a Bot, a preset, the store's own
// read-only reason) are worded with them, in a pack's language and in Chinese.
test('#877: an adopt refused read-only or after its preset selection is worded with its values', () => {
  const reason = 'The Bot team in /team is open in another dsh (Web or Desktop, pid 7). This window shows the team but cannot change it; close the other one and reload.'
  const session = 'session-d203042b-3ccf-4bf2-b67e-3c4e2079774f'
  const readOnly = `Session ${session} cannot join Bot "Brain" because this window cannot change the Bot team now. ${reason}`
  const joining = `Bot "Brain" changed while Session ${session} was joining it (another window or an edit). For the Bot team: Nothing was changed; try again. The native preset of Session ${session} was set to "cordis" before this refusal.`
  const saving = `Bot "Brain" changed while Session ${session} was being saved. For the Bot team: Nothing was changed; try again. The native preset of Session ${session} was set to "cordis" before this refusal.`
  // Without a language pack each stays as sent.
  for (const message of [readOnly, joining, saving]) assert.equal(hostText(message), message)

  const dicts = {}
  const zh = installLocale({
    register: (ns, lang, dict) => { if (lang.startsWith('zh')) dicts.zh = dict; return () => {} },
    bind: () => (key, params) => (dicts.zh?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match),
    getLocale: () => ({ active: 'zh-CN' }),
  })
  try {
    // The reason inside keeps its own Chinese wording.
    const worded = hostText(reason)
    assert.notEqual(worded, reason)
    assert.equal(hostText(readOnly), `会话 ${session} 无法加入 Bot "Brain"，因为这个窗口现在不能修改 Bot 团队。${worded}`)
    assert.equal(hostText(joining), `Bot "Brain" 在会话 ${session} 加入时发生了变化（另一个窗口或一次编辑）。Bot 团队没有任何改动，请重试。在这次拒绝之前，会话 ${session} 的原生预设已被设为「cordis」。`)
    assert.equal(hostText(saving), `Bot "Brain" 在保存会话 ${session} 时发生了变化。Bot 团队没有任何改动，请重试。在这次拒绝之前，会话 ${session} 的原生预设已被设为「cordis」。`)
    // The refusals that name no preset are as they were: no pattern, sent as they are.
    const plain = `Bot "Brain" changed while Session ${session} was being saved. Nothing was changed; try again.`
    assert.equal(hostText(plain), plain)
  } finally { zh() }

  const words = {
    'Session {session} cannot join {bot} because this window cannot change the Bot team now. {reason}': 'A Sessão {session} não pode entrar em {bot}. {reason}',
    '{bot} changed while Session {session} was being saved. For the Bot team: Nothing was changed; try again. The native preset of Session {session} was set to "{preset}" before this refusal.': '{bot} mudou; Sessão {session}; predefinição "{preset}".',
  }
  const fill = (key, params) => (words[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match)
  const pt = installLocale({ register: () => () => {}, bind: () => fill, getLocale: () => ({ active: 'pt-BR' }) })
  try {
    // The pack words the sentence; the reason it has no entry for stays as sent.
    assert.equal(hostText(readOnly), `A Sessão ${session} não pode entrar em Bot "Brain". ${reason}`)
    assert.equal(hostText(saving), `Bot "Brain" mudou; Sessão ${session}; predefinição "cordis".`)
    assert.equal(hostText(joining), joining)
  } finally { pt() }
})

test('#877: only a value a template marks as a host message is worded in turn', () => {
  const dicts = {}
  const zh = installLocale({
    register: (ns, lang, dict) => { if (lang.startsWith('zh')) dicts.zh = dict; return () => {} },
    bind: () => (key, params) => (dicts.zh?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match),
    getLocale: () => ({ active: 'zh-CN' }),
  })
  try {
    // "Model" has a Chinese entry of its own; as a Bot's name in a refusal it stays a name.
    assert.equal(hostText('Model'), '模型')
    assert.equal(hostText('Model could not switch to acp-codex/default. It stays on deepseek/v4.'), 'Model 无法切换到 acp-codex/default，仍使用 deepseek/v4。')
    // Nor is a Session id beside a marked value: only the reason is read as a host message.
    assert.equal(hostText('Session Model cannot join Bot "Model" because this window cannot change the Bot team now. Model'), '会话 Model 无法加入 Bot "Model"，因为这个窗口现在不能修改 Bot 团队。模型')
  } finally { zh() }
})

test('Auto\'s refusals are worded with the Bot\'s name in Chinese and in the pt-BR pack', () => {
  const stale = "Ada's permissions changed meanwhile, so nothing was saved. Look again and choose."
  const offered = 'Auto is not offered for Ada here.'
  const host = 'This host cannot save the Bot team.'
  const person = "Only the person turns Auto on, from the Bot's permission choice."
  // Without a language pack each stays as sent.
  for (const message of [stale, offered, host, person]) assert.equal(hostText(message), message)
  const dicts = {}
  const zh = installLocale({
    register: (ns, lang, dict) => { if (lang.startsWith('zh')) dicts.zh = dict; return () => {} },
    bind: () => (key, params) => (dicts.zh?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match),
    getLocale: () => ({ active: 'zh-CN' }),
  })
  try {
    assert.equal(hostText(stale), 'Ada 的权限在此期间已经改变，因此没有保存任何内容。请重新查看后再选择。')
    assert.equal(hostText(offered), '这里不为 Ada 提供自动模式。')
    assert.equal(hostText(host), '这台主机无法保存 Bot 团队。')
    assert.equal(hostText(person), '只有用户本人能在 Bot 的权限选择中开启自动模式。')
  } finally { zh() }
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const fill = (key, params) => (pt[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match)
  const off = installLocale({ register: () => () => {}, bind: () => fill, getLocale: () => ({ active: 'pt-BR' }) })
  try {
    assert.equal(hostText(stale), 'As permissões de Ada mudaram nesse meio-tempo, então nada foi salvo. Confira de novo e escolha.')
    assert.equal(hostText(offered), 'O Automático não é oferecido para Ada aqui.')
    assert.equal(hostText(host), 'Este host não pode salvar a equipe de Bots.')
    assert.equal(hostText(person), 'Só a pessoa ativa o Automático, na escolha de permissão do Bot.')
  } finally { off() }
})

test('route policy refusals translate the route and preserve the Bot name in zh and pt-BR', () => {
  const message = 'Model cannot use the Native route.'
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  for (const [active, words, expected] of [
    ['zh-CN', undefined, 'Model 无法使用“原生”路线。'],
    ['pt-BR', pt, 'Model não pode usar a rota “Nativo”.'],
  ]) {
    let dictionary = words
    const off = installLocale({
      register: (_ns, locale, entries) => { if (locale === 'zh') dictionary ??= entries; return () => {} },
      bind: () => (key, params) => (dictionary?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match),
      getLocale: () => ({ active }),
    })
    try {
      assert.equal(hostText(message), expected)
    } finally { off() }
  }
})

test('hostText words all four Solver look refusals in Chinese', () => {
  const dicts = new Map()
  const off = installLocale({
    register: (namespace, language, words) => { dicts.set(`${namespace}:${language}`, words); return () => {} },
    bind: namespace => key => dicts.get(`${namespace}:zh`)?.[key] ?? key,
    getLocale: () => ({ active: 'zh-CN' }),
  })
  try {
    for (const [message, translated] of [
      ['Only a Solver wears the Solver characters. Choose another character.', '只有 Solver 才能使用 Solver 角色。请选择其他角色。'],
      ['A Solver wears one of the Solver characters. Choose one of those characters.', 'Solver 只能使用 Solver 角色。请从这些角色中选择一个。'],
      ['Only the person can make a Bot a Solver.', '只有本人才能把 Bot 设为 Solver。'],
      ['That look is not valid. Choose another character.', '这个形象无效。请选择其他角色。'],
    ]) assert.equal(hostText(message), translated)
  } finally { off() }
})
