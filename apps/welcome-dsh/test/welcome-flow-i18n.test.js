// The rest of the welcome in the DSH language (#317): Connect AI, the subscription sign-ins, the
// companion step and the step rail read their copy from welcome.team, as the team step does, so
// with a pt-BR locale they render in Brazilian Portuguese, and with none they stay English.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { VENDORS } from '../src/host/ais.js'
import { fakeLocale } from './fake-locale.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
// The flow files whose copy this test covers (team.js and acp-agents.js: team-i18n.test.js).
const FLOW = ['connect-ai.js', 'subscriptions.js', 'companion.js', 'companion-art.js', 'stage.js', 'api.js', 'migrate.js']

const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/client/connect-ai.js'",
      "export { SUBSCRIPTION_TILES, SubscriptionSignIn } from './src/client/subscriptions.js'",
      "export * from './src/client/companion.js'",
      "export { announceStep } from './src/client/stage.js'",
      "export { MigrateView, TOOLS, MOVE, handoffOf, canMove, answerBots, MIGRATE_CSS } from './src/client/migrate.js'",
      "export { installLocale, PT_BR, t } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@automagik/bots-dsh/client'],
  loader: { '.css': 'text' },
})
const client = { exports: {} }
// A React that renders once: hooks hand back their initial value, and effects never run. The
// step gate's undecided state (useState(undefined)) reads as a host state with no flags, so a
// step draws itself.
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial === undefined ? {} : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(),
}
runInNewContext(bundle.outputFiles[0].text, { module: client, exports: client.exports, URL, setTimeout, clearTimeout, document: { body: null }, require: name => ({ react, 'react-dom': { createPortal: node => node }, '@automagik/bots-dsh/client': {} })[name] })
const flow = client.exports
// Every step on the rail, as the plugins that bring them announce them.
for (const id of ['omni-companion', 'omni-team', 'omni-connect', 'omni-connect-ai']) flow.announceStep?.(id)

function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}
function findAll(node, match, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, match, out))
  else if (node && typeof node === 'object') {
    if (match(node)) out.push(node)
    node.children.forEach(child => findAll(child, match, out))
  }
  return out
}
const textOf = node => (Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.children) : node === null || node === undefined || node === false ? '' : String(node))
const byClass = name => node => String(node?.props?.className ?? '').split(' ').includes(name)
const byType = type => node => node.type === type
const texts = (tree, match) => findAll(tree, match).map(textOf)

// What the host sends for Connect AI (src/host/ais.js): two rows found, the rest to add.
const ROWS = [
  { id: 'claude', name: 'Claude', via: 'Your Claude Pro or Max plan through Claude Code, or an Anthropic API key', kind: 'signin', ready: true, on: true, found: 'Signed in to Claude Code' },
  { id: 'openai', name: 'OpenAI API', via: 'With an API key, billed per use', kind: 'key', ready: true, on: false, found: 'OPENAI_API_KEY found' },
  { id: 'openrouter', name: 'OpenRouter', via: 'One key, hundreds of models', kind: 'key', ready: false, on: false, found: null },
  { id: 'zai', name: 'Z.ai', via: 'GLM models, with an API key', kind: 'key', ready: false, on: false, found: null },
  { id: 'moonshot', name: 'Moonshot', via: 'Kimi models, with an API key', kind: 'key', ready: false, on: false, found: null },
  { id: 'opencode', name: 'OpenCode', via: 'An OpenCode Zen key', kind: 'key', ready: false, on: false, found: null },
  { id: 'cliproxy', name: 'CLIProxyAPI', via: 'Your own gateway', kind: 'gateway', ready: false, on: false, found: null },
  { id: 'ollama', name: 'Ollama', via: 'Models running on this computer', kind: 'local', ready: false, on: false, found: null },
]

function connectAi() {
  const view = flow.ConnectAiView({
    state: { companionName: 'Pip' },
    rows: ROWS,
    subscriptions: { accounts: [{ provider: 'cursor', index: 1 }, { provider: 'cursor', index: 2 }], hidden: [] },
    acp: { view: null },
    open: 'openrouter',
    showAll: false,
    rowProps: () => ({ busy: false, problem: null, onFlip: () => {}, onSaved: () => {}, onClose: () => {}, onDedupe: () => {} }),
    glitching: false,
    onShowAll: () => {}, onSkip: () => {}, onModels: () => {}, onContinue: () => {},
  })
  const tree = render(view)
  return {
    title: textOf(findAll(tree, byType('h1'))[0]),
    speech: textOf(findAll(tree, node => node.props.role === 'status')[0]),
    rail: texts(tree, byType('li')).slice(0, 4),
    headings: texts(tree, byType('h2')),
    via: findAll(tree, byClass('oai-ai-what')).slice(0, 3).map(what => textOf(what.children.find(child => child?.type === 'span'))),
    found: texts(tree, byClass('oai-found')),
    terms: textOf(findAll(tree, byClass('oai-terms'))[0]),
    more: textOf(findAll(tree, byClass('oai-more'))[0]),
    every: textOf(findAll(tree, byClass('oai-every'))[0]),
    keyHint: findAll(tree, node => node.type === 'input')[0]?.props.placeholder,
    actions: texts(findAll(tree, byClass('oai-actions'))[0], node => node.type === 'button' || node.type === 'span'),
  }
}

function signIn() {
  const tile = flow.SUBSCRIPTION_TILES.find(each => each.provider === 'cursor')
  return textOf(render(flow.SubscriptionSignIn({ tile, onBack: () => {}, onSaved: () => {}, glitch: () => {} })))
}

function companion() {
  const tree = render(flow.CompanionStep({ stepId: 'omni-companion', complete: () => {} }))
  return {
    title: textOf(findAll(tree, byType('h1'))[0]),
    speech: textOf(findAll(tree, node => node.props.role === 'status')[0]),
    lede: textOf(findAll(tree, byClass('oai-lede'))[0]),
    tabs: texts(tree, node => node.props.role === 'tab'),
    labels: texts(tree, byType('label')),
    hatch: textOf(findAll(tree, byClass('oai-big'))[0]),
  }
}

const ENGLISH = {
  connectAi: {
    title: 'Turn on your AIs',
    speech: 'Turn on everything you have. More brains, more Pip.',
    rail: ['Your companion', 'Your team', 'Connect Omni', 'Connect AI'],
    headings: ['Found on this computer', 'Add another'],
    via: ['Your Claude Pro or Max plan through Claude Code, or an Anthropic API key', 'With an API key, billed per use', 'Your Cursor plan · dsh-subscriptions'],
    found: ['Signed in to Claude Code', 'OPENAI_API_KEY found', '2 accounts'],
    terms: 'Subscriptions: personal use under the vendor\'s terms.',
    more: 'Show 9 more',
    every: 'Every other provider DSH knows is in Settings → Models.',
    keyHint: 'Paste your OpenRouter key',
    actions: ['Skip for now', '2 on', 'Continue →'],
  },
  signIn: 'Starting the Cursor sign-in…Back',
  companion: {
    title: 'Create your companion',
    speech: 'Hi! I\'m going to be yours. What should I look like?',
    lede: 'Your companion runs your team: it talks with you, hands work to the others and keeps an eye on everything. Make it yours.',
    tabs: ['Describe it', 'Pick one'],
    labels: ['Its name'],
    hatch: 'Hatch',
  },
}

test('with no DSH locale, the welcome flow reads in English', () => {
  assert.equal(flow.t('Turn on your AIs', {}), 'Turn on your AIs')
  assert.deepEqual({ connectAi: connectAi(), signIn: signIn(), companion: companion() }, ENGLISH)
})

const locale = fakeLocale()
let uninstall = () => {}

test('in English, the welcome flow reads as before', () => {
  uninstall = flow.installLocale(locale)
  locale.setLocale('en')
  assert.deepEqual({ connectAi: connectAi(), signIn: signIn(), companion: companion() }, ENGLISH)
})

test('under a pt-BR locale, Connect AI, the sign-ins and the companion step render in Brazilian Portuguese', () => {
  locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
  locale.setLocale('pt-BR')
  try {
    assert.deepEqual({ connectAi: connectAi(), signIn: signIn(), companion: companion() }, {
      connectAi: {
        title: 'Ligue suas IAs',
        speech: 'Ligue tudo o que você tiver. Mais cérebros, mais Pip.',
        rail: ['Sua companhia', 'Sua equipe', 'Conectar o Omni', 'Conectar IA'],
        headings: ['Encontradas neste computador', 'Adicionar outra'],
        via: ['Seu plano Claude Pro ou Max pelo Claude Code, ou uma chave de API da Anthropic', 'Com uma chave de API, cobrada por uso', 'Seu plano do Cursor · dsh-subscriptions'],
        found: ['Login feito no Claude Code', 'OPENAI_API_KEY encontrada', '2 contas'],
        terms: 'Assinaturas: uso pessoal nos termos de cada fornecedor.',
        more: 'Mostrar mais 9',
        every: 'Todos os outros provedores que o DSH conhece estão em Configurações → Modelos.',
        keyHint: 'Cole sua chave de OpenRouter',
        actions: ['Pular por enquanto', 'Ligadas: 2', 'Continuar →'],
      },
      signIn: 'Iniciando o login no Cursor…Voltar',
      companion: {
        title: 'Crie sua companhia',
        speech: 'Oi! Vou ser a sua companhia. Qual vai ser a minha aparência?',
        lede: 'Sua companhia comanda a sua equipe: conversa com você, passa trabalho para o resto da equipe e fica de olho em tudo. Deixe com a sua cara.',
        tabs: ['Descrever', 'Escolher'],
        labels: ['Nome'],
        hatch: 'Fazer nascer',
      },
    })
  } finally {
    locale.setLocale('en')
  }
})

// Claude's and ChatGPT's setup: the CLI's sign-in in a Bot's chat, and Claude's API key.
function cliSetup(id) {
  const cli = { id: id === 'claude' ? 'acp-claude' : 'acp-codex', key: id === 'claude' ? 'claude' : 'codex', name: id === 'claude' ? 'Claude Code' : 'Codex', on: false, cli: { found: true, state: 'ready' }, connector: { state: 'off' }, signedIn: false, listed: false, restartNeeded: false }
  const row = { ...VENDORS.find(vendor => vendor.id === id), ready: false, on: false, found: null, signIn: true, cli }
  const tree = render(flow.Row({ row, acp: { view: null, busy: null, problems: {}, login: () => true }, open: true, busy: false, problem: null, onFlip: () => {}, onSaved: () => {}, onClose: () => {}, onDedupe: () => {} }))
  return findAll(tree, node => node.type === 'button' && node.props.role !== 'switch').map(textOf)
}

test('not-ready tool cards show their names and Em breve in pt-BR', () => {
  locale.setLocale('pt-BR')
  try {
    const tree = render(flow.MigrateView({ phase: 'choosing' }))
    const soon = findAll(tree, byClass('oai-mig-is-soon'))
    const expected = [
      ['OpenClaw', 'OpenClaw'],
      ['Grok bot', 'Grok botxAI'],
      ['Muse', 'MuseMeta'],
    ]
    assert.equal(soon.length, expected.length)
    for (const [index, [name, label]] of expected.entries()) {
      const card = soon[index]
      const who = findAll(card, byClass('oai-mig-who'))
      assert.equal(who.length, 1)
      assert.equal(textOf(who[0]), label)
      const pills = findAll(card, byClass('oai-soon'))
      assert.equal(pills.length, 1)
      assert.equal(textOf(pills[0]), 'Em breve')
      assert.doesNotMatch(textOf(card), /Bot do Telegram|mapeando/)
      assert.equal(card.props['aria-label'], `${name}: em breve`)
    }
    const ready = findAll(tree, byClass('oai-mig-is-ready'))
    assert.equal(ready.length, 1)
    const who = findAll(ready[0], byClass('oai-mig-who'))[0]
    assert.equal(textOf(findAll(who, node => node.type === 'span')[0]), 'Bot do Telegram')
  } finally {
    locale.setLocale('en')
  }
})

test('the move from another tool renders in pt-BR, restart and all', () => {
  locale.setLocale('pt-BR')
  try {
    const choosing = render(flow.MigrateView({ phase: 'choosing' }))
    assert.match(textOf(choosing), /De outra ferramenta/)
    assert.match(textOf(choosing), /Em breve/)
    assert.match(textOf(choosing), /Mova para o Omni o bot do Telegram/)
    const confirm = render(flow.MigrateView({
      phase: 'confirm',
      probe: { hermes: { found: true, where: 'local', channel: 'on', key: 'available', gatewayRunning: true, pendingRestart: false }, omni: { linked: true, attach: true, bots: [], telegram: null } },
    }))
    assert.match(textOf(confirm), /reinicia por alguns segundos/)
    assert.match(textOf(confirm), /Confirmo: o Hermes reinicia/)
  } finally {
    locale.setLocale('en')
  }
})

test('Claude and ChatGPT set up through their CLIs, in English and in pt-BR, and the duplicate reads in the DSH language', () => {
  locale.setLocale('en')
  assert.deepEqual(cliSetup('claude'), ['Sign in to Claude CodeWith your plan, in a Bot\'s chat', 'Use an API keyBilled per use', 'Cancel'])
  assert.deepEqual(cliSetup('chatgpt'), ['Sign in to CodexWith your plan, in a Bot\'s chat', 'Cancel'])
  // Without acp-dsh, Claude's setup is its Anthropic key form as before; ChatGPT has none.
  const keyOnly = id => render(flow.Row({ row: { ...VENDORS.find(vendor => vendor.id === id), ready: false, on: false, found: null, signIn: false }, open: true, busy: false, problem: null, onFlip: () => {}, onSaved: () => {}, onClose: () => {}, onDedupe: () => {} }))
  assert.equal(findAll(keyOnly('claude'), node => node.type === 'input')[0].props.placeholder, 'Paste your Claude key')
  assert.match(textOf(keyOnly('chatgpt')), /This DSH offers no ChatGPT sign-in\./)
  locale.setLocale('pt-BR')
  try {
    assert.deepEqual(cliSetup('claude'), ['Entrar no Claude CodeCom o seu plano, no chat de um Bot', 'Usar uma chave de APICobrado por uso', 'Cancelar'])
    assert.equal(flow.t('DSH sign-in'), 'login do DSH')
  } finally {
    locale.setLocale('en')
  }
})

// Every literal in the flow files that reads as copy (it starts with a capital letter, or has a
// space between words) must be a welcome.team key with its pt-BR text, or be on this list of what
// stays English on purpose. On dev this failed on 'Turn on your AIs' and the rest of Connect AI.
const ENGLISH_ON_PURPOSE = new Set([
  // Product, provider and plugin names; the AI rows' logo letters; the brand mark.
  'AUTOMAGIK', 'OC', 'Omni', 'Ollama', 'Perplexity', 'Perplexity Pro', 'JetBrains AI', 'Cursor', 'Kiro', 'AWS Kiro', 'Zhipu GLM',
  'GLM coding plan', 'Qwen', 'Alibaba Bailian', 'Sourcegraph Cody', 'Cody Pro', 'Replit', 'Replit Core',
  '{} · dsh-subscriptions',
  // The companion's name ideas: names, not words.
  'Pirlim', 'Mestrik', 'Maguito', 'Guizo', 'Trunfo',
  // The tools a person can come from, and their card tags.
  'Hermes', 'OpenClaw', 'Grok bot', 'Muse', 'Meta', 'Telegram', 'TG', 'OC',
  // Code, not copy: a key name, an HTTP method, a status line the subscriptions plugin never words.
  'Enter', 'POST', 'NETWORK', 'HTTP_{}', 'HTTP {}',
])
// Literals, comments set aside; a template's ${…} reads as {}.
function literals(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return [...code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(([, quote, body]) => {
    const plain = body.replace(/\\(['"`\\])/g, '$1')
    return quote === '`' ? plain.replace(/\$\{[^}]*\}/g, '{}') : plain
  })
}
// Markup, CSS and URLs are not copy, nor is a list of class names.
const copyLike = text => /[A-Za-z]{2}/.test(text) && !/^(?:https?:\/\/|<|\.|\(|[a-z-]+\()/.test(text) && !text.includes('${')
  && (/^[A-Z]/.test(text) || (/ /.test(text) && !text.trim().split(/\s+/).every(word => /^oai-[a-z{}-]+$/.test(word))))

test('every string the welcome flow shows has its pt-BR text, or is English on purpose', () => {
  const found = new Set()
  for (const file of FLOW) {
    for (const text of literals(readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'))) if (copyLike(text)) found.add(text)
  }
  assert.ok(found.size > 60, `only ${found.size} strings found`)
  // A template's {} stands for any placeholder name.
  const keys = new Set(Object.keys(flow.PT_BR).map(key => key.replace(/\{\w+\}/g, '{}')))
  const keyed = text => keys.has(text.replace(/\{\w+\}/g, '{}'))
  const missing = [...found].filter(text => !ENGLISH_ON_PURPOSE.has(text) && !keyed(text))
  assert.deepEqual(missing, [])
})

// What the host sends: each row's way in, and what it found (src/host/ais.js, kept English there:
// ais.test.js and the Settings section read them), and the subscription tiles' plans and tokens.
test('every row the host sends for Connect AI has its pt-BR text', () => {
  const rows = [...VENDORS.map(vendor => vendor.via), 'Key saved', 'Gateway saved', 'Running on this computer', 'Signed in']
  for (const tile of flow.SUBSCRIPTION_TILES) rows.push(tile.what, tile.note)
  const missing = [...new Set(rows)].filter(row => row !== undefined && !ENGLISH_ON_PURPOSE.has(row) && !Object.hasOwn(flow.PT_BR, row))
  assert.deepEqual(missing, [])
})

test('a found row with a value in it reads in pt-BR around the value', () => {
  locale.setLocale('pt-BR')
  try {
    assert.equal(flow.aiText('Signed in to DeepSeek'), 'Login feito no DeepSeek')
    assert.equal(flow.aiText('ZAI_API_KEY found'), 'ZAI_API_KEY encontrada')
    assert.equal(flow.aiText('3 accounts'), '3 contas')
    assert.equal(flow.aiText('Kiro token'), 'Token do Kiro')
    assert.equal(flow.aiText('AWS Kiro · dsh-subscriptions'), 'AWS Kiro · dsh-subscriptions')
    assert.equal(flow.aiText(null), null)
  } finally {
    locale.setLocale('en')
  }
})

test('uninstalling the locale puts the flow back in English', () => {
  uninstall()
  assert.equal(flow.t('Turn on your AIs'), 'Turn on your AIs')
})

// The installed-plugins page reads a plugin's description from its package's locale/<lang>.json
// (DSH's readPluginMeta), English from package.json: the welcome ships its pt-BR there.
test('the welcome\'s description on DSH\'s plugin pages has its pt-BR text', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const pt = JSON.parse(readFileSync(new URL('../locale/pt-br.json', import.meta.url), 'utf8'))
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.ok(manifest.files.includes('locale/'))
  // English stays package.json's description: en.json holds none of its own, and no title.
  assert.deepEqual(en, { meta: {} })
  assert.deepEqual(Object.keys(pt.meta), ['description'])
  assert.ok(pt.meta.description.length > 40 && pt.meta.description !== manifest.description)
})
