// The team step in the DSH language: its copy is the welcome.team namespace, registered in English
// and in Brazilian Portuguese, and it renders in Portuguese once pt-BR is the active language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { OMNI_PLUGINS, OMNI_TOOLS } from '../src/host/bot-types.js'
import { whereOf } from '../src/client/where.js'
import { fakeLocale } from './fake-locale.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// team.js and i18n.js in one bundle, so the team step reads the locale installed here.
const bundle = await build({
  stdin: { contents: "export * from './src/client/team.js'\nexport { installLocale, NAMESPACE, PT_BR } from './src/client/i18n.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
})
const client = { exports: {} }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn,
}
runInNewContext(bundle.outputFiles[0].text, { module: client, exports: client.exports, URL, setTimeout, clearTimeout, require: name => ({ react, 'react-dom': { createPortal: node => node } })[name] })
const team = client.exports

const plain = value => JSON.parse(JSON.stringify(value))
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

// The team step's copy, rendered: Unfold's and Genie's cards, Omni's statuses and choices, the button.
function sample() {
  const unfold = render(team.UnfoldCard({ power: { phase: 'ready', detail: null, toggle: () => {} }, host: 'unfold' }))
  const genie = render(team.GenieCard({ power: { phase: 'asleep', detail: null, toggle: () => {} } }))
  const omniType = { type: 'omni', groups: [
    { id: 'tools', label: 'Tools', rows: [{ id: 'read', label: 'Read channels and chats', on: true, locked: true }] },
    { id: 'setup', label: 'Setup', rows: [{ id: 'permission', label: 'Permissions', detail: 'Ask first (DSH\'s default)' }] },
  ] }
  const caps = render(team.Capabilities({ type: omniType }))
  return {
    unfoldTeam: textOf(findAll(unfold, byClass('oai-team-line'))[0]),
    unfoldAbout: textOf(findAll(unfold, byClass('oai-about'))[0]),
    unfoldStarts: textOf(findAll(unfold, node => node.type === 'summary')[0]),
    unfoldRow: textOf(findAll(unfold, node => node.type === 'li' && node.props['data-cap'] === 'bridge')[0]),
    genieStatus: textOf(findAll(genie, byClass('oai-status'))[0]),
    genieAbout: textOf(findAll(genie, byClass('oai-about'))[0]),
    capsGroup: textOf(findAll(caps, node => node.type === 'h3')[0]),
    capsLocked: textOf(findAll(caps, byClass('oai-core'))[0]),
    capsRow: textOf(findAll(caps, node => node.type === 'strong')[0]),
    capsDefault: textOf(findAll(caps, node => node.type === 'small')[0]),
    omniStatus: team.statusOf('asleep', { removed: true }),
    tiles: plain(team.destinyOf([]).tiles.map(tile => tile.title)),
    joined: team.joinedLabel({ omni: true, genie: false, unfold: true }, 'Pip'),
    alone: team.joinedLabel({ omni: false, genie: false }, 'Pip'),
    lede: textOf(render(team.TeamLede({ name: 'Pip' }))),
    rule: textOf(findAll(render(team.TeamLede({ name: 'Pip' })), byClass('oai-lede-rule'))[0]),
  }
}

const locale = fakeLocale()
locale.addLanguage({ id: 'pt', label: 'Português', fallback: 'en' })
const uninstall = team.installLocale(locale)

test('the team step registers its copy as welcome.team, in English, Portuguese and Brazilian Portuguese', () => {
  assert.equal(team.NAMESPACE, 'welcome.team')
  assert.deepEqual(plain(locale.calls), [['welcome.team', ['en', 'pt', 'pt-BR']]])
  assert.ok(Object.keys(team.PT_BR).length > 150)
})

test('in English, the team step reads as before', () => {
  locale.setLocale('en')
  assert.deepEqual(sample(), {
    unfoldTeam: 'On your team',
    unfoldAbout: 'Unfold itself, working inside DSH.',
    unfoldStarts: 'What it starts with',
    unfoldRow: 'Unfold bridgeUnfold watches this DSH · Comes with this DSH',
    genieStatus: 'Powered off',
    genieAbout: 'Give it a wish, get one delivery.',
    capsGroup: 'Tools',
    capsLocked: 'Always on',
    capsRow: 'Read channels and chats',
    capsDefault: 'Ask first (DSH\'s default)',
    omniStatus: 'Powered off · not on your team',
    tiles: ['Install Omni here', 'An Omni somewhere else'],
    joined: 'Continue with Omni and Unfold',
    alone: 'Continue with just Pip',
    lede: 'Pip leads. Who comes along?Code work goes to a Bot with Computer.',
    rule: 'Code work goes to a Bot with Computer.',
  })
})

// Each location's whole sentences, including the new tile's subtitle.
const MAC_COPY = [
  ['Your Omni on this Mac', 'Omni on this Mac', 'Already on this Mac', 'On this Mac'],
  ['Seu Omni neste Mac', 'Omni neste Mac', 'Já está neste Mac', 'Neste Mac'],
]
const PC_COPY = [
  ['Your Omni on this PC', 'Omni on this PC', 'Already on this PC', 'On this PC'],
  ['Seu Omni neste PC', 'Omni neste PC', 'Já está neste PC', 'Neste PC'],
]
const COMPUTER_COPY = [
  ['Your Omni on this computer', 'Omni on this computer',
    'Already on this computer', 'On this computer'],
  ['Seu Omni neste computador', 'Omni neste computador',
    'Já está neste computador', 'Neste computador'],
]
const WORKSPACE_COPY = [
  ['Your Omni on the computer this workspace runs on',
    'Omni on the computer this workspace runs on',
    'Already on the computer this workspace runs on', 'On the computer this workspace runs on'],
  ['Seu Omni no computador onde este workspace funciona',
    'Omni no computador onde este workspace funciona',
    'Já está no computador onde este workspace funciona',
    'No computador onde este workspace funciona'],
]
const PLACES = [
  [{ at: 'here', os: 'macos' }, MAC_COPY],
  [{ at: 'here', os: 'windows' }, PC_COPY],
  [{ at: 'here', os: 'linux' }, COMPUTER_COPY],
  [{ at: 'here', os: 'other' }, COMPUTER_COPY],
  ...['linux', 'macos', 'windows', 'other'].map(os => [{ at: 'remote', os }, WORKSPACE_COPY]),
  [{ at: 'unknown' }, WORKSPACE_COPY],
  [undefined, WORKSPACE_COPY],
]
// What the choices show for one place: a found Omni of its own and a found local one (as their
// titles, and inside "Use …"), the line under the local one, and the new tile.
function choicesAt(where) {
  const sandbox = { id: 'sandbox', source: 'sandbox', url: 'http://127.0.0.1:8882', local: true, hasKey: true }
  const local = { id: 'local', url: 'http://127.0.0.1:8883', local: true, hasKey: true }
  const { tiles } = team.destinyOf([sandbox, local], { where })
  const bare = team.destinyOf([], { where }).tiles
  return {
    titles: [team.foundChoice(sandbox, { where }).title, team.foundChoice(local, { where }).title],
    tiles: plain(tiles.map(tile => tile.title)),
    already: team.destinyOf([{ ...local, url: 'http://127.0.0.1' }], { where }).tiles[0].sub,
    run: bare[0].title,
    on: bare[0].sub,
  }
}

function assertChoices(where, [sandbox, local, already, on], language) {
  const shown = choicesAt(where)
  const use = language === 'en' ? 'Use' : 'Usar'
  const lower = text => text.charAt(0).toLowerCase() + text.slice(1)
  assert.deepEqual(shown.titles, [sandbox, local], `${language} ${JSON.stringify(where)}`)
  assert.deepEqual(shown.tiles.slice(0, 2), [`${use} ${lower(sandbox)}`, `${use} ${local}`])
  assert.equal(shown.already, already)
  assert.equal(shown.run, language === 'en' ? 'Install Omni here' : 'Instalar o Omni aqui')
  assert.equal(shown.on, on)
  const place = team.placeOf(where)
  assert.deepEqual(plain(place), { sandbox, local, already, run: shown.run, on })
}

// DSH's Portuguese plugin uses pt; pt-BR is registered as an alias of the same dictionary.
const LANGUAGES = ['en', 'pt', 'pt-BR']
test('placeOf and the choices name only a known local machine, in en, pt and pt-BR', () => {
  locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
  for (const [where, copy] of PLACES) {
    for (const language of LANGUAGES) {
      locale.setLocale(language)
      try {
        assertChoices(where, copy[language === 'en' ? 0 : 1], language)
      } finally {
        locale.setLocale('en')
      }
    }
  }
})

test('whereOf reaches placeOf without naming a remote viewer, in en, pt and pt-BR', () => {
  const macBrowser = { platform: 'MacIntel', userAgentData: { platform: 'macOS' } }
  const page = hostname => ({ location: { hostname }, navigator: macBrowser })
  const cases = [
    [{ machine: { os: 'linux' }, scope: page('workspace.example') }, WORKSPACE_COPY],
    [{ machine: { os: 'macos' }, scope: page('workspace.example') }, WORKSPACE_COPY],
    [{ scope: page('workspace.example') }, WORKSPACE_COPY],
    [{ machine: { os: 'linux' }, scope: page('localhost') }, WORKSPACE_COPY],
    [{ machine: { os: 'macos', remoteHint: true }, scope: page('localhost') }, WORKSPACE_COPY],
    [{ machine: { os: 'macos' }, scope: page('localhost') }, MAC_COPY],
    [{ machine: { os: 'linux' }, scope: {
      location: { hostname: 'localhost' }, navigator: { platform: 'Linux x86_64' },
    } }, COMPUTER_COPY],
    [{ scope: page('localhost') }, WORKSPACE_COPY],
    [{ machine: { os: 'linux' }, scope: {
      ...page('localhost'), omniDesktop: { platform: 'darwin' },
    } }, MAC_COPY],
    [{ machine: { os: 'linux' }, scope: {
      ...page('localhost'), omniDesktop: { platform: 'win32' },
    } }, PC_COPY],
    [{ scope: {} }, WORKSPACE_COPY],
  ]
  for (const [input, copy] of cases) {
    for (const language of LANGUAGES) {
      locale.setLocale(language)
      try {
        assertChoices(whereOf(input), copy[language === 'en' ? 0 : 1], language)
      } finally {
        locale.setLocale('en')
      }
    }
  }
})

test('under a pt-BR locale, the team step renders in Brazilian Portuguese', () => {
  locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
  locale.setLocale('pt-BR')
  try {
    assert.deepEqual(sample(), {
      unfoldTeam: 'Na sua equipe',
      unfoldAbout: 'Unfold em pessoa, trabalhando dentro do DSH.',
      unfoldStarts: 'Com o que começa',
      unfoldRow: 'Ponte UnfoldUnfold acompanha este DSH · Vem com este DSH',
      genieStatus: 'Energia desligada',
      genieAbout: 'Faça um desejo, receba uma entrega.',
      capsGroup: 'Ferramentas',
      capsLocked: 'Sempre ligado',
      capsRow: 'Ler canais e chats',
      capsDefault: 'Ask first (padrão do DSH)',
      omniStatus: 'Energia desligada · fora da sua equipe',
      tiles: ['Instalar o Omni aqui', 'Um Omni em outro lugar'],
      joined: 'Continuar com Omni e Unfold',
      alone: 'Continuar só com Pip',
      lede: 'Pip lidera. Quem vem junto?Trabalho de código vai para um Bot com Computador.',
      rule: 'Trabalho de código vai para um Bot com Computador.',
    })
  } finally {
    locale.setLocale('en')
  }
})

// Every literal the team step passes to t() has its Portuguese text, with the same placeholders.
// The team step, the Claude Code and Codex rows and the rest of the welcome share the namespace
// (welcome-flow-i18n.test.js renders the rest).
const read = file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
const FLOW = ['connect-ai.js', 'subscriptions.js', 'companion.js', 'companion-art.js', 'stage.js', 'api.js', 'migrate.js']
const source = ['team.js', 'acp-agents.js', 'power-shortcut.js', ...FLOW].map(read).join('\n')
const keysOf = text => [...text.matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(match => match[2].replace(/\\(['"`\\])/g, '$1'))
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',')

test('every string the team step looks up has its pt-BR text, with the same placeholders', () => {
  const keys = new Set(keysOf(source))
  assert.ok(keys.size > 100, `only ${keys.size} t() keys found`)
  const missing = [...keys].filter(key => !Object.hasOwn(team.PT_BR, key))
  assert.deepEqual(missing, [])
  const drift = Object.entries(team.PT_BR).filter(([key, text]) => placeholders(key) !== placeholders(text)).map(([key]) => key)
  assert.deepEqual(drift, [])
})

// The rows a card shows are English keys too: Genie's and Unfold's, and what the host sends for
// Omni (its plugins, its tools, and the fixed rows of omniType in src/host/bot-types.js).
const hostSource = readFileSync(new URL('../src/host/bot-types.js', import.meta.url), 'utf8')
// omniType's body, between its two markers; a marker that moved fails the test rather than
// leaving it nothing to check.
function omniTypeRows() {
  const from = 'async function omniType()'
  const to = "'omni-plugins': () =>"
  const start = hostSource.indexOf(from)
  const end = hostSource.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `src/host/bot-types.js has no ${from} before ${to}`)
  const rows = literalRows(hostSource.slice(start, end))
  assert.ok(rows.length >= 10, `only ${rows.length} rows found in omniType`)
  return rows
}
// Its English literals: the quoted texts that start with a capital (ids and keys are lower case),
// template literals set aside (their rows are the ones rowText reads around a value).
const literalRows = text => [...text.replace(/`[^`]*`/g, '').matchAll(/'((?:\\'|[^'])*)'/g)].map(match => match[1].replace(/\\'/g, "'")).filter(text => /^[A-Z]/.test(text))

test('every row a card shows has its pt-BR text', () => {
  const rows = []
  for (const type of [team.GENIE_TYPE, team.genieTypeOf('unfold'), team.unfoldTypeOf(null), team.unfoldTypeOf('unfold')]) {
    for (const group of type.groups) {
      rows.push(group.label)
      for (const row of group.rows) rows.push(row.label, ...String(row.detail).split(' · '))
    }
  }
  for (const plugin of OMNI_PLUGINS) rows.push(plugin.title, plugin.what, plugin.title.replace(/^Omni /, ''))
  for (const tool of OMNI_TOOLS) rows.push(tool.label, ...(tool.detail ? [tool.detail] : []))
  rows.push(...omniTypeRows())
  assert.ok(rows.length > 40)
  const missing = [...new Set(rows)].filter(row => !Object.hasOwn(team.PT_BR, row))
  assert.deepEqual(missing, [])
})

test('the host\'s rows with a value in them read in pt-BR around the value', () => {
  locale.setLocale('pt-BR')
  try {
    assert.equal(team.rowText('deepseek/v4-flash · you confirm it in Omni\'s first chat'), 'deepseek/v4-flash · você confirma no primeiro chat do Omni')
    assert.equal(team.rowText('~/work/omni'), '~/work/omni')
  } finally {
    locale.setLocale('en')
  }
})

test('the pt-BR dictionary holds no key the team step no longer uses', () => {
  const used = new Set(keysOf(source))
  for (const type of [team.GENIE_TYPE, team.unfoldTypeOf(null), team.unfoldTypeOf('unfold')]) {
    for (const group of type.groups) {
      used.add(group.label)
      for (const row of group.rows) { used.add(row.label); for (const part of String(row.detail).split(' · ')) used.add(part) }
    }
  }
  for (const plugin of OMNI_PLUGINS) { used.add(plugin.title); used.add(plugin.what); used.add(plugin.title.replace(/^Omni /, '')) }
  for (const tool of OMNI_TOOLS) { used.add(tool.label); if (tool.detail) used.add(tool.detail) }
  for (const row of omniTypeRows()) used.add(row)
  for (const id of ['power', 'plugins', 'link', 'team']) used.add(id)
  used.add('Comes with this DSH')
  // The rest of the welcome looks some keys up from data: the rail's labels, the companion's
  // ideas, the subscription tiles, and what src/host/ais.js says about each AI.
  const quoted = text => [...text.matchAll(/'((?:\\'|[^'\n])*)'/g)].map(match => match[1].replace(/\\'/g, "'"))
  for (const text of [...FLOW.map(read), readFileSync(new URL('../src/host/ais.js', import.meta.url), 'utf8')]) for (const literal of quoted(text)) used.add(literal)
  assert.deepEqual(Object.keys(team.PT_BR).filter(key => !used.has(key)), [])
})

test('placeholders stay the same in every pt-BR text', () => {
  const drift = Object.entries(team.PT_BR).filter(([key, text]) => placeholders(key) !== placeholders(text)).map(([key]) => key)
  assert.deepEqual(drift, [])
})

// The copy rules for pt-BR: no article before Unfold and no gendered word after it, no gendered
// pronoun or word for the person, "clique" and never "toque", never "sandbox", no European Portuguese.
const ARTICLE = '(?:o|a|os|as|do|da|dos|das|no|na|nos|nas|ao|à|aos|às|pelo|pela|num|numa|dum|duma|um|uma)'
const RULES = [
  ['puts an article before Unfold', new RegExp(`(?<![\\p{L}-])${ARTICLE}\\s+Unfold\\b`, 'iu')],
  ['genders Unfold', /\bUnfold\s+(?:está|estava|esteve|ficou|fica|foi|é|era|será|estará)\s+(?:pront|conectad|desconectad|ocupad|sozinh|ligad|desligad|atualizad|parad|preparad|cansad|instalad|acordad)[oa]s?\b/iu],
  ['uses a gendered pronoun', /(?<![\p{L}-])(?:ele|ela|eles|elas|dele|dela|deles|delas|nele|nela|neles|nelas)(?![\p{L}-])/iu],
  ['uses a gendered word for the person', /(?<![\p{L}-])(?:bem-vind[oa]s?|obrigad[oa]s?|usuári[oa]s?|sozinh[oa]s?)(?![\p{L}-])|(?<![\p{L}-])(?:você|vocês)\s+(?:está|estão|esteja|estiver|é|seja|fica|ficou)\s+(?:\p{L}+(?:ad|id)[oa]s?|pront[oa]s?|cert[oa]s?)(?![\p{L}-])/iu],
  ['says tap', /(?<![\p{L}-])(?:tap|taps|tapped|toque|toques|tocar|tocou)(?![\p{L}-])/iu],
  ['says sandbox', /sandbox/iu],
  ['is European Portuguese', /(?<![\p{L}-])(?:ecrã|ecrãs|utilizador|utilizadores|ficheiro|ficheiros|telemóvel|registo|equipa|equipas|palavra-passe|secção|contacto|facto|actual|aceder|partilh\p{L}*|premir)(?![\p{L}-])|(?<![\p{L}-])(?:está|estão|estou|estamos)\s+a\s+\p{L}+(?:ar|er|ir)(?![\p{L}-])/iu],
]

test('the pt-BR team copy keeps the copy rules', () => {
  const findings = []
  for (const [key, text] of Object.entries(team.PT_BR)) {
    for (const [rule, pattern] of RULES) if (pattern.test(text)) findings.push(`${key}: ${rule}: ${text}`)
  }
  assert.deepEqual(findings, [])
})

test('the English team copy says click, never tap', () => {
  assert.doesNotMatch(source, /\btap\b/i)
})

test('uninstalling the locale takes both dictionaries back', () => {
  uninstall()
  assert.equal(team.statusOf('asleep'), 'Powered off')
})
