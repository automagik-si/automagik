import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { heldText } from '../src/client/stops.js'
import { HELD_LINES } from '../src/shared/held.js'
import { DICTIONARY, hostText, hostTemplateOf, installLocale, language, t } from '../src/client/i18n.js'
import { ACCESS_MESSAGES } from '../src/host/models.js'

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

test('every literal the client translates has a Chinese entry', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const missing = []
  for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8')
    for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = match[2].replace(/\\'/g, "'")
      if (!Object.hasOwn(DICTIONARY.zh, key)) missing.push(`${name}: ${key}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('coding agent access messages name the renamed Settings section in all three languages', () => {
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  assert.equal(ACCESS_MESSAGES.off, 'Turn on {connection} in Settings → Coding agents before using this model.')
  assert.equal(ACCESS_MESSAGES.installing, 'Wait for {connection} to finish installing, or retry it in Settings → Coding agents.')
  for (const key of [ACCESS_MESSAGES.off, ACCESS_MESSAGES.installing]) {
    assert.match(DICTIONARY.zh[key], /设置 → 编程助手/)
    assert.match(pt[key], /Configurações → Agentes de código/)
    assert.equal(hostTemplateOf(key.replace('{connection}', 'Codex')), key)
  }
  const notReady = 'The coding agent is not ready yet. Check its installation in Settings → Claude Code and Codex, then try again.'
  assert.match(DICTIONARY.zh[notReady], /设置 → 编程助手/)
  assert.match(pt[notReady], /Configurações → Agentes de código/)
})

test('Codex Auto confirmation describes unreviewed reads in Chinese and Brazilian Portuguese', () => {
  const key = "On Auto, Codex decides by itself, with its own reviewer, which steps it runs, refuses or asks you about. It may change files outside {name}'s folder without asking you, and Automagik does not review those steps. With its own tools, it may also read any file Automagik itself can open, including files outside that folder, without asking you, and neither its reviewer nor Automagik checks those reads."
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  assert.equal(DICTIONARY.zh[key], "在自动模式下，Codex 通过自己的审查器决定执行哪些步骤、拒绝哪些步骤或询问你。它可能不经询问就修改{name}文件夹之外的文件，Automagik 不会审查这些步骤。它还可能用自有工具不经询问就读取 Automagik 本身能打开的任何文件，包括该文件夹之外的文件，它的审查器和 Automagik 都不会检查这些读取。")
  assert.equal(pt[key], "No Automático, o Codex decide por conta própria, com seu próprio revisor, quais etapas executa, recusa ou pergunta a você. Pode alterar arquivos fora da pasta de {name} sem perguntar, e o Automagik não revisa essas etapas. Com suas próprias ferramentas, também pode ler qualquer arquivo que o próprio Automagik consegue abrir, inclusive fora dessa pasta, sem perguntar, e nem o revisor do Codex nem o Automagik verificam essas leituras.")
})

test('copy follows the DSH language and stays English without a locale service', () => {
  assert.equal(t('Message {name}', { name: 'Omni' }), 'Message Omni')
  assert.equal(language(), 'en')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(language(), 'zh')
    assert.equal(t('Message {name}', { name: 'Omni' }), '给 Omni 发消息')
    assert.equal(t('Model'), '模型')
    assert.equal(hostText('A Bot named Writer already exists'), '已经有叫 Writer 的 Bot 了')
    assert.equal(hostText('The team needs at least one Main Bot'), '团队至少要有一个主 Bot')
    assert.equal(hostText('Something new'), 'Something new')
    // Whole memory messages, not only their first words, become Chinese.
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), '一条记忆最多 300 个字符，这条有 301 个')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), '主记忆会超过 4000 个字符的上限，请先删掉一些')
    assert.equal(hostText('The topic in your memory would have 16205 of its 16000 characters. Put the rest in another topic, or forget old entries.'), '主题会超过 16000 个字符的上限')
    assert.equal(hostText('There is no entry 9.'), '没有第 9 条')
    assert.equal(hostText('There is no such entry.'), '没有这一条')
    assert.equal(hostText('No entry in your memory in that topic matches the text given (25 chars). recall shows what is saved.'), '找不到这条记忆')
    assert.equal(hostText('The text given (6 chars) matches 7 entries in your memory; quote more of the one you mean. recall shows what is saved.'), '对应了 7 条记忆，请说得更具体')
    assert.equal(hostText("Writer's memory has no such topic (7 chars). recall shows what is saved."), '没有这个主题')
    // A Bot on a Session its host runs (parts.js `pinned`).
    assert.equal(hostText('Unfold works in the folder its host gave its conversation, so its folder cannot change here'), 'Unfold 在宿主为它的对话指定的文件夹里工作，这里不能更改它的文件夹')
    assert.equal(hostText('Unfold speaks in the conversation its host runs, so it cannot start a new one here.'), 'Unfold 在宿主运行的对话里说话，这里不能开始新对话')
    assert.equal(hostText('Unfold speaks in the conversation its host runs; that conversation keeps its own compaction controls.'), 'Unfold 在宿主运行的对话里说话，那个对话由宿主自己压缩')
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})


test('D client: host ladder templates translate to Chinese', async () => {
  const { askText, questionText } = await import('../src/host/ladder.js')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(hostTemplateOf(askText('bash: rm -rf x')), 'This step is hard to undo: {step}. Allow it once?')
    assert.equal(hostText(askText('bash: rm -rf x')), '这一步难以撤销：bash: rm -rf x。允许这一次吗？')
    assert.equal(hostTemplateOf(questionText('ada', 4, 'bash')), '{name} was refused {count} times in this turn, the last time on {tool}. Let it keep working?')
    assert.equal(hostText(questionText('ada', 4, 'bash')), 'ada 在本轮被拒绝了 4 次，最近一次是 bash。让它继续工作吗？')
  } finally { off() }
})

test('only whole held replies translate, with Chinese and Portuguese entries for each', () => {
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const off = installLocale(fakeLocale('zh'))
  try {
    for (const key of HELD_LINES) {
      assert.equal(typeof DICTIONARY.zh[key], 'string')
      assert.equal(typeof pt[key], 'string')
      assert.notEqual(DICTIONARY.zh[key], key)
      assert.notEqual(pt[key], key)
      assert.equal(heldText(key), DICTIONARY.zh[key])
      assert.equal(heldText(key + ' x'), key + ' x')
    }
    assert.equal(heldText('Model'), 'Model')
    assert.equal(heldText('x'), 'x')
  } finally { off() }
})

test('package role refusals localize the template and preserve the supplied name literally', () => {
  const template = 'Detach {name} first.'
  const name = '<Fixture>'
  const message = template.replace('{name}', name)
  assert.equal(hostTemplateOf(message), template)
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(hostText(message), `请先移除 ${name}。`)
  } finally {
    off()
  }
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  assert.equal(pt[template].replace('{name}', name), `Remova ${name} primeiro.`)
  for (const key of ['Choose None first.', "This role's source cannot be confirmed right now."]) {
    assert.notEqual(DICTIONARY.zh[key], key)
    assert.notEqual(pt[key], key)
    assert.ok(DICTIONARY.zh[key] && pt[key])
  }
})

test('Voice / Mouth card and recovery copy has Chinese and Brazilian Portuguese entries', () => {
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  for (const key of ['Active tools', 'Allow speech', 'Saved voice unavailable', 'ACP coding agents do not receive this role’s prompt.',
    'The signed role install evidence is missing or unreadable.', 'The installed role files differ from the signed package.']) {
    assert.ok(DICTIONARY.zh[key] && pt[key], key)
    assert.notEqual(DICTIONARY.zh[key], key)
    assert.notEqual(pt[key], key)
  }
})

test('rfc0039 [P] I1 Chinese withdrawn and stale texts', async () => {
  const clientApprovals = await import('../src/client/approvals.js')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(clientApprovals.withdrawnText?.('task'), '这一步已撤回：它的任务结束了')
    assert.equal(t('The task ended with an approval unanswered'), '任务结束时还有一个审批没有回答')
    assert.equal(hostText('This approval is no longer open'), '这个审批已经关闭了')
  } finally {
    off()
  }
})

test('rfc0039 D3b [P] I2 Chinese and Brazilian Portuguese group withdrawn text', async () => {
  const { withdrawnText } = await import('../src/client/approvals.js')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(withdrawnText?.('group'), '这一步已撤回：它的群会话结束了', 'D3B-I2')
    assert.equal(withdrawnText?.('bot'), '')
    assert.equal(withdrawnText?.('part'), '')
  } finally { off() }
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  assert.equal(pt['This step was withdrawn: its group Session ended'], 'Esta etapa foi retirada: a sessão do grupo terminou')
})

test('rollback messages and every failed check are translated with the same parameters', () => {
  const about = readFileSync(new URL('../src/client/about.js', import.meta.url), 'utf8')
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  const rollback = about.slice(about.indexOf('function failedHealthCheck'), about.indexOf('const failedCheck'))
  const params = text => [...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort()
  const keys = [...rollback.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]).concat('Failed check: {check}')
  for (const key of keys) {
    assert.notEqual(DICTIONARY.zh[key], key)
    assert.notEqual(pt[key], key)
    assert.deepEqual(params(DICTIONARY.zh[key]), params(key))
    assert.deepEqual(params(pt[key]), params(key))
  }
})
