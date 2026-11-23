// Antigravity in its own home (#2048, isolation amendment): the host passes the sign-in fields
// only with exact values and the isolated terminal command only in its two shapes,
// `acp-sign-in`/`acp-sign-out` call acp-dsh through, and the row signs in here, signs out with
// a confirm, and shows the Windows warning in every state (English, pt-BR and Chinese).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install } from '../src/host/endpoint.js'
import { ACP_ENTRY, agentView, isSignInHint } from '../src/host/acp.js'
import { needsViewer } from '../src/host/viewer-policy.js'
import { fakeContext } from './fake-ctx.js'
import { fakeLocale } from './fake-locale.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const UUID = '1a2b3c4d-1111-2222-3333-444455556666'
const DIGEST = 'ab'.repeat(16)
const posix = (home, agy = '/usr/local/bin/agy') => `env -i PATH="$PATH" TERM="$TERM" LANG="$LANG" HOME='${home}' XDG_CONFIG_HOME='${home}/config' XDG_DATA_HOME='${home}/data' XDG_CACHE_HOME='${home}/cache' XDG_STATE_HOME='${home}/state' '${agy}' acp --login`
const win32 = (home, agy = 'C:\\Users\\a\\AppData\\Local\\agy\\bin\\agy.exe') => `$env:USERPROFILE="${home}"; $env:HOME="${home}"; $env:HOMEPATH="${home}"; $env:APPDATA="${home}\\roaming"; $env:LOCALAPPDATA="${home}\\local"; & "${agy}" acp --login`
const POSIX_HOME = '/srv/a/.automagik/acp/cli-homes/antigravity'
const POSIX_GENERATION = `/srv/a/.automagik/acp/installations/${DIGEST}/cli-homes/homes/antigravity/${UUID}`
const WIN32_HOME = 'C:\\Users\\a\\.automagik\\acp\\cli-homes\\antigravity'
const WIN32_GENERATION = `C:\\Users\\a\\.automagik\\acp\\installations\\${DIGEST}\\cli-homes\\homes\\antigravity\\${UUID}`
const WARNING = 'On Windows, the Antigravity account is shared: Automagik and your own Antigravity on this computer use one sign-in, kept in Windows Credential Manager. Sign out is not available here: sign out in Antigravity itself.'

const agy = (over = {}, cli = {}) => ({
  id: 'acp-antigravity', key: 'antigravity', name: 'Antigravity', on: true,
  cli: { found: true, installUrl: 'https://antigravity.google/docs/getting-started', signInHint: posix(POSIX_HOME), state: 'ready', install: 'manual', managed: true, version: '1.5.15', ...cli },
  connector: { state: 'ready', native: true },
  model: { provider: 'acp-antigravity', id: 'default', name: 'x', listed: true },
  restartNeeded: false, appSignIn: true, signedIn: false,
  ...over,
})

test('the isolated command passes in its two shapes, with a home under cli-homes, and nothing else does', () => {
  for (const hint of [posix(POSIX_HOME), posix(POSIX_GENERATION), posix(POSIX_HOME, `/srv/a/.automagik/acp/clis/agy/1.5.15-${UUID}/bin/agy`),
    win32(WIN32_HOME), win32(WIN32_GENERATION), win32("C:\\Users\\o'hara\\.automagik\\acp\\cli-homes\\antigravity")]) {
    assert.equal(isSignInHint(hint), true, hint)
    assert.equal(agentView(agy({}, { signInHint: hint })).cli.signInHint, hint)
  }
  const bad = [
    posix('/srv/a/.automagik/acp/other/antigravity'),
    posix('/srv/a/.automagik/acp/cli-homes/claude'),
    posix(`/srv/a/.automagik/acp/cli-homes/homes/antigravity/${UUID}x`),
    posix('/srv/a/../b/acp/cli-homes/antigravity'),
    posix('relative/acp/cli-homes/antigravity'),
    posix(POSIX_HOME, '/usr/local/bin/agy.sh'),
    posix(POSIX_HOME, '/srv/../agy'),
    posix(POSIX_HOME).replace("XDG_DATA_HOME='/srv", "XDG_DATA_HOME='/tmp"),
    posix(POSIX_HOME).replace("XDG_STATE_HOME='", "XDG_STATE_HOME='/x"),
    `${posix(POSIX_HOME)} extra`,
    `${posix(POSIX_HOME)}; rm -rf ~`,
    posix("/srv/o'hara/acp/cli-homes/antigravity"),
    posix('/srv/a`b/acp/cli-homes/antigravity'),
    posix('/srv/a\nb/acp/cli-homes/antigravity'),
    posix('/srv/a\u202Eb/acp/cli-homes/antigravity'),
    posix(`/${'a/'.repeat(2100)}acp/cli-homes/antigravity`),
    posix(POSIX_HOME).replace('env -i ', ''),
    win32('C:\\Users\\a\u201Db\\acp\\cli-homes\\antigravity'),
    win32('C:\\Users\\a$b\\acp\\cli-homes\\antigravity'),
    win32('C:\\Users\\a"b\\acp\\cli-homes\\antigravity'),
    win32('C:\\Users\\a\\..\\acp\\cli-homes\\antigravity'),
    win32('C:\\Users\\a\\acp\\cli-homes\\codex'),
    win32(WIN32_HOME, 'C:\\Users\\a\\agy.cmd'),
    win32(WIN32_HOME).replace('\\roaming', '\\other'),
    `${win32(WIN32_HOME)}; calc`,
  ]
  for (const hint of bad) {
    assert.equal(isSignInHint(hint), false, hint)
    assert.equal(agentView(agy({}, { signInHint: hint })).cli.signInHint, undefined, hint)
  }
})

test('the host passes the sign-in fields only with exact values', () => {
  const view = agentView(agy({ signingIn: true, signInError: 'timeout', signInWhere: 'terminal', sharedAccount: true }))
  assert.equal(view.appSignIn, true)
  assert.equal(view.signingIn, true)
  assert.equal(view.signInError, 'timeout')
  assert.equal(view.signInWhere, 'terminal')
  assert.equal(view.sharedAccount, true)
  for (const word of ['unsupported', 'timeout', 'failed']) assert.equal(agentView(agy({ signInError: word })).signInError, word)
  const odd = agentView(agy({ appSignIn: 'yes', signingIn: 1, signInError: 'aborted', signInWhere: 'settings', sharedAccount: 'true' }))
  for (const field of ['appSignIn', 'signingIn', 'signInError', 'signInWhere', 'sharedAccount']) assert.equal(odd[field], undefined, field)
})

function host(service) {
  const fake = fakeContext({ entries: { 'omni-ai': {}, [ACP_ENTRY]: {} }, services: service ? { acpAgents: service } : {} })
  const { handle } = install(fake.ctx)
  return { ...fake, handle }
}

test('acp-sign-in and acp-sign-out call acp-dsh through, refuse other rows and Windows, and need the owner viewer', async () => {
  const calls = []
  let rows = [agy({ signedIn: true })]
  const service = {
    status: async () => ({ agents: rows }),
    signInNative: async (id) => {
      calls.push(['in', id])
      if (calls.length === 2) throw Object.assign(new Error('Turn Antigravity on first.'), { code: 'acp-sign-in/off' })
      return { agents: rows }
    },
    accountSignOutNative: async (id) => { calls.push(['out', id]); return { id, signedIn: false } },
  }
  const fake = host(service)
  assert.equal((await fake.handle('acp-sign-in', { id: 'acp-antigravity' })).ok, true)
  const off = await fake.handle('acp-sign-in', { id: 'acp-antigravity' })
  assert.deepEqual(off.error, { code: 'omni-ai/refused', message: 'Turn Antigravity on first.' })
  assert.equal((await fake.handle('acp-sign-in', { id: 'acp-gemini' })).error.code, 'omni-ai/invalid')
  assert.equal((await fake.handle('acp-sign-out', { id: 'acp-antigravity' })).ok, true)
  assert.deepEqual(calls, [['in', 'acp-antigravity'], ['in', 'acp-antigravity'], ['out', 'acp-antigravity']])
  // A row that does not sign in here, and a Windows row, are refused before acp-dsh is asked.
  rows = [agy({ appSignIn: undefined, signedIn: true }), { ...agy(), id: 'acp-claude', key: 'claude', appSignIn: undefined }]
  assert.equal((await fake.handle('acp-sign-out', { id: 'acp-antigravity' })).error.code, 'omni-ai/refused')
  assert.equal((await fake.handle('acp-sign-out', { id: 'acp-claude' })).error.code, 'omni-ai/refused')
  rows = [agy({ signedIn: true, sharedAccount: true })]
  const windows = await fake.handle('acp-sign-out', { id: 'acp-antigravity' })
  assert.deepEqual(windows.error, { code: 'omni-ai/refused', message: 'Sign out is not available on Windows. Sign out in Antigravity itself.' })
  assert.equal(calls.length, 3)
  // acp-dsh's own refusal goes back in its words; an older acp-dsh and none at all refuse.
  rows = [agy({ signedIn: true })]
  service.accountSignOutNative = async () => { throw Object.assign(new Error('The Bot account is changing.'), { code: 'acp-account/busy' }) }
  assert.deepEqual((await fake.handle('acp-sign-out', { id: 'acp-antigravity' })).error, { code: 'omni-ai/refused', message: 'The Bot account is changing.' })
  const older = host({ status: async () => ({ agents: rows }) })
  assert.match((await older.handle('acp-sign-in', { id: 'acp-antigravity' })).error.message, /cannot sign in/)
  assert.match((await older.handle('acp-sign-out', { id: 'acp-antigravity' })).error.message, /cannot sign out/)
  assert.equal((await host().handle('acp-sign-in', { id: 'acp-antigravity' })).error.code, 'omni-ai/refused')
  assert.equal(needsViewer('acp-sign-in'), true)
  assert.equal(needsViewer('acp-sign-out'), true)
})

// ---- The row --------------------------------------------------------------------------------

const bundle = await build({
  stdin: { contents: "export * from './src/client/acp-agents.js'\nexport { installLocale, PT_BR, ZH } from './src/client/i18n.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn,
}
const client = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module: client, exports: client.exports, setTimeout, clearTimeout, setInterval, clearInterval, require: name => ({ react, 'react-dom': {} })[name] })
const ui = client.exports
const locale = fakeLocale()
locale.addLanguage({ id: 'pt-BR', fallback: 'en' })
ui.installLocale(locale)

function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}
const textOf = node => (Array.isArray(node) ? node.map(textOf).join('') : node === null || node === undefined || node === false ? '' : typeof node === 'object' ? textOf(node.children) : String(node))
function findAll(node, match, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, match, out))
  else if (node && typeof node === 'object') {
    if (match(node)) out.push(node)
    findAll(node.children, match, out)
  }
  return out
}
const acpOf = (over = {}) => {
  const acted = []
  return {
    acted, view: { available: true, agents: [] }, busy: null, problems: {}, isOn: row => row.on,
    flip: row => acted.push(['flip', row.id]), retry: row => acted.push(['retry', row.id]), install: row => acted.push(['install', row.id]),
    check: row => acted.push(['check', row.id]), login: row => acted.push(['login', row.id]),
    nativeLogin: row => acted.push(['sign-in', row.id]), askSignOut: row => acted.push(['ask-sign-out', row.id]),
    nativeSignOut: row => acted.push(['sign-out', row.id]), cancelSignOut: () => acted.push(['cancel']),
    ...over,
  }
}
const rowOf = (row, acp = acpOf()) => render(ui.AcpAgentRow({ agent: agentView(row), acp }))
const buttons = (tree, label) => findAll(tree, node => node.type === 'button' && textOf(node) === label)
const inLocale = (id, work) => { locale.setLocale(id); try { return work() } finally { locale.setLocale('en') } }

test('signed out: Sign in here, with the terminal command as the fallback; no terminal-only line', () => {
  const acp = acpOf()
  const tree = rowOf(agy(), acp)
  const text = textOf(tree)
  assert.match(text, /Not signed in to Antigravity\. Sign in here: your browser opens to finish\./)
  assert.ok(text.includes(`If no browser opens, run ${posix(POSIX_HOME)} in a new terminal window, then check again.`))
  assert.doesNotMatch(text, /in a terminal, then check again\./)
  assert.doesNotMatch(text, /\{/)
  buttons(tree, 'Sign in')[0].props.onClick()
  assert.deepEqual(acp.acted, [['sign-in', 'acp-antigravity']])
  assert.equal(buttons(tree, 'Check again').length, 1)
  // Without a command the row offers Sign in alone.
  const bare = rowOf(agy({}, { signInHint: undefined }))
  assert.equal(buttons(bare, 'Sign in').length, 1)
  assert.doesNotMatch(textOf(bare), /If no browser opens/)
  // Off: nothing to sign in to; the off line says the sign-in is the app's own.
  const off = rowOf(agy({ on: false, connector: { state: 'off', native: true }, signedIn: undefined }))
  assert.deepEqual(buttons(off, 'Sign in'), [])
  assert.match(textOf(off), /Automagik keeps its own Antigravity sign-in, apart from the one in your terminal\./)
  assert.doesNotMatch(textOf(off), /already has on this computer/)
})

test('signing in, each failure, and no browser on this computer', () => {
  const busy = rowOf(agy({ signingIn: true }))
  assert.match(textOf(busy), /Finish the sign-in to Antigravity in your browser…/)
  assert.deepEqual(buttons(busy, 'Sign in'), [])
  for (const [word, line] of [
    ['unsupported', 'Antigravity did not offer a Google sign-in. Use the terminal command below.'],
    ['timeout', 'The sign-in to Antigravity took too long. Try again.'],
    ['failed', 'The sign-in to Antigravity did not finish. Try again.'],
  ]) {
    const tree = rowOf(agy({ signInError: word }))
    assert.ok(textOf(tree).includes(line), word)
    assert.equal(buttons(tree, 'Sign in').length, 1)
  }
  const terminal = rowOf(agy({ signInWhere: 'terminal' }))
  assert.ok(textOf(terminal).includes(`Not signed in to Antigravity. This computer has no browser for the sign-in: run ${posix(POSIX_HOME)} in a new terminal window, then check again.`))
  assert.deepEqual(buttons(terminal, 'Sign in'), [])
  assert.equal(buttons(terminal, 'Check again').length, 1)
  const none = rowOf(agy({ signInWhere: 'terminal' }, { signInHint: undefined }))
  assert.match(textOf(none), /Not signed in to Antigravity\. This computer has no browser for the sign-in\./)
  assert.deepEqual(buttons(none, 'Sign in'), [])
})

test('signed in: Sign out asks first, then signs out; Cancel keeps it', () => {
  const acp = acpOf()
  const tree = rowOf(agy({ signedIn: true }), acp)
  assert.match(textOf(tree), /Signed in to Antigravity\./)
  buttons(tree, 'Sign out')[0].props.onClick()
  assert.deepEqual(acp.acted, [['ask-sign-out', 'acp-antigravity']])
  const asking = acpOf({ signOutPending: 'acp-antigravity' })
  const confirm = rowOf(agy({ signedIn: true }), asking)
  assert.match(textOf(confirm), /This stops running Bot work for this account\. Continue\?/)
  assert.deepEqual(buttons(confirm, 'Sign out'), [])
  buttons(confirm, 'Continue')[0].props.onClick()
  buttons(confirm, 'Cancel')[0].props.onClick()
  assert.deepEqual(asking.acted, [['sign-out', 'acp-antigravity'], ['cancel']])
})

test('Windows: the shared-account warning in every state, and never a Sign out', () => {
  const shared = { sharedAccount: true }
  for (const row of [
    agy({ ...shared, on: false, connector: { state: 'off', native: true }, signedIn: undefined }, { found: false, state: 'missing', signInHint: undefined, managed: false, version: undefined }),
    agy({ ...shared, connector: { state: 'no-cli', native: true }, signedIn: undefined }, { found: false, state: 'missing', signInHint: undefined, managed: false, version: undefined }),
    agy({ ...shared, signedIn: undefined }, { state: 'installing', found: false, signInHint: undefined }),
    agy({ ...shared, on: false, connector: { state: 'off', native: true }, signedIn: undefined }),
    agy({ ...shared }),
    agy({ ...shared, signedIn: true }),
    agy({ ...shared, signingIn: true }),
  ]) {
    const tree = rowOf(row)
    assert.ok(textOf(tree).includes(WARNING), JSON.stringify(row))
    assert.doesNotMatch(textOf(tree), /Settings stay separate/)
    assert.deepEqual(buttons(tree, 'Sign out'), [])
  }
  // The off line keeps what is true there: the sign-in is the one this computer already has.
  assert.match(textOf(rowOf(agy({ ...shared, on: false, connector: { state: 'off', native: true }, signedIn: undefined }))), /already has on this computer/)
  // Anywhere else, no warning.
  assert.ok(!textOf(rowOf(agy({ signedIn: true }))).includes(WARNING))
})

const NEW_KEYS = [
  'Not signed in to {name}. Sign in here: your browser opens to finish.',
  'If no browser opens, run {command} in a new terminal window, then check again.',
  'Finish the sign-in to {name} in your browser…',
  '{name} did not offer a Google sign-in. Use the terminal command below.',
  'The sign-in to {name} took too long. Try again.',
  'The sign-in to {name} did not finish. Try again.',
  'Automagik keeps its own {name} sign-in, apart from the one in your terminal.',
  'Not signed in to {name}. This computer has no browser for the sign-in: run {command} in a new terminal window, then check again.',
  'Not signed in to {name}. This computer has no browser for the sign-in.',
  'Sign out',
  'On Windows, the {name} account is shared: Automagik and your own {name} on this computer use one sign-in, kept in Windows Credential Manager. Sign out is not available here: sign out in {name} itself.',
]

test('every new line reads in pt-BR; the Windows warning in Chinese, with the rest in English', () => {
  for (const key of NEW_KEYS) assert.equal(typeof ui.PT_BR[key], 'string', key)
  assert.deepEqual(Object.keys(ui.ZH), [NEW_KEYS.at(-1)])
  const pt = inLocale('pt-BR', () => textOf(rowOf(agy({ signedIn: true, sharedAccount: true }))))
  assert.match(pt, /No Windows, a conta do Antigravity é compartilhada: .*Sair não está disponível aqui: saia pelo próprio Antigravity\./)
  assert.doesNotMatch(pt, /\{/)
  const ptOut = inLocale('pt-BR', () => textOf(rowOf(agy())))
  assert.match(ptOut, /Sem login no Antigravity\. Entre por aqui: o navegador abre para concluir o login\./)
  // DSH's Chinese id is `zh`: the warning reads in Chinese, its neighbour line in English.
  const zh = inLocale('zh', () => textOf(rowOf(agy({ signedIn: true, sharedAccount: true }))))
  assert.ok(zh.includes('在 Windows 上，Antigravity 的账号是共享的：Automagik 和你在这台电脑上自己的 Antigravity 使用同一个登录，保存在 Windows 凭据管理器中。这里无法退出登录：请在 Antigravity 中退出。'))
  assert.ok(zh.includes('Signed in to Antigravity.'))
  assert.ok(!zh.includes(WARNING))
  assert.doesNotMatch(zh, /\{/)
})
