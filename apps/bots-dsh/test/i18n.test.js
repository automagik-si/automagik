import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { heldText } from '../src/client/stops.js'
import { HELD_LINES } from '../src/shared/held.js'
import { DICTIONARY, hostText, hostTemplateOf, installLocale, language, t } from '../src/client/i18n.js'

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


test('the four not-installed reasons are worded in Chinese and Portuguese', () => {
  const GENIE = '@automagik/genie-dsh'
  const reasons = [
    `the ${GENIE} plugin is missing from this DSH`,
    `the ${GENIE} plugin is switched off in this DSH`,
    `the ${GENIE} plugin did not load in this DSH`,
    `the ${GENIE} plugin did not load in this DSH (incompatible-version)`,
  ]
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.deepEqual(reasons.map(hostText), [
      `这个 DSH 里没有 ${GENIE} 插件`,
      `这个 DSH 里已关闭 ${GENIE} 插件`,
      `${GENIE} 插件在这个 DSH 里没有加载`,
      `${GENIE} 插件在这个 DSH 里没有加载（incompatible-version）`,
    ])
  } finally { off() }
  // The pt-BR pack words the same templates; hostText goes through its binding.
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const offPack = installLocale({
    register: () => () => {},
    bind: () => (key, params) => {
      const text = pt[key] ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active: 'pt' }),
  })
  try {
    assert.deepEqual(reasons.map(hostText), [
      `o plugin ${GENIE} não está instalado neste DSH`,
      `o plugin ${GENIE} está desativado neste DSH`,
      `o plugin ${GENIE} não carregou neste DSH`,
      `o plugin ${GENIE} não carregou neste DSH (incompatible-version)`,
    ])
  } finally { offPack() }
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
