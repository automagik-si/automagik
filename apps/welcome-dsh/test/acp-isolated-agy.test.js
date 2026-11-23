// Antigravity in its own home (#2048, isolation amendment): the host passes the sign-in fields
// only with exact values, the isolated terminal command only in its two shapes and never to
// Antigravity's own row, `acp-sign-in`/`acp-sign-out` call acp-dsh through, and the row signs
// in here as Claude Code's and Codex's do (no command, no path), signs out with a confirm, and
// shows the Windows warning in every state (English, pt-BR and Chinese).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install } from '../src/host/endpoint.js'
import { ACP_ENTRY, agentView, isSignInHint, isSignInUrl } from '../src/host/acp.js'
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
    // Owner decision (#2048): a row that signs in here never carries a command to the page.
    assert.equal(agentView(agy({}, { signInHint: hint })).cli.signInHint, undefined)
    assert.equal(agentView(agy({ appSignIn: undefined }, { signInHint: hint })).cli.signInHint, hint)
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
  const odd = agentView(agy({ appSignIn: 'yes', signingIn: 1, signInError: 'aborted', signInWhere: 'settings', sharedAccount: 'true', signInUrl: GOOGLE }))
  for (const field of ['appSignIn', 'signingIn', 'signInError', 'signInWhere', 'sharedAccount', 'signInUrl']) assert.equal(odd[field], undefined, field)
})

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123-abc.apps.googleusercontent.com'
  + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2Foauth2callback&response_type=code&scope=openid&state=s1'

test('a sign-in link reaches the row only while signing in, and only Google\'s own entry points', () => {
  assert.equal(agentView(agy({ signingIn: true, signInUrl: GOOGLE })).signInUrl, GOOGLE)
  assert.equal(isSignInUrl(GOOGLE.replace('/v2/auth', '/auth')), true)
  // Not while no sign-in runs, and never for a row that does not sign in here.
  assert.equal(agentView(agy({ signInUrl: GOOGLE })).signInUrl, undefined)
  assert.equal(agentView(agy({ appSignIn: undefined, signingIn: true, signInUrl: GOOGLE })).signInUrl, undefined)
  for (const bad of [
    GOOGLE.replace('https:', 'http:'),
    GOOGLE.replace('accounts.google.com', 'accounts.google.com.evil.example'),
    GOOGLE.replace('accounts.google.com', 'evil.example'),
    GOOGLE.replace('accounts.google.com', 'a@accounts.google.com'),
    GOOGLE.replace('accounts.google.com', 'accounts.google.com:8443'),
    GOOGLE.replace('/o/oauth2/v2/auth', '/o/oauth2/v2/other'),
    GOOGLE.replace('response_type=code', 'response_type=token'),
    GOOGLE.replace('client_id=123-abc.apps.googleusercontent.com', 'client_id='),
    `${GOOGLE}#x`,
    `${GOOGLE} x`,
    `${GOOGLE}\n`,
    'javascript:alert(1)',
    `${GOOGLE}&pad=${'a'.repeat(8200)}`,
    42,
  ]) {
    assert.equal(isSignInUrl(bad), false, String(bad).slice(0, 120))
    assert.equal(agentView(agy({ signingIn: true, signInUrl: bad })).signInUrl, undefined)
  }
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
// useAcp under the stand-in react, with each problem the row would show recorded in `said`.
function withHooks(make, said) {
  const saved = react.useState
  react.useState = (initial) => {
    let value = typeof initial === 'function' ? initial() : initial
    return [value, (next) => {
      value = typeof next === 'function' ? next(value) : next
      if (value && typeof value === 'object' && Object.hasOwn(value, 'acp-antigravity')) said.push(value)
    }]
  }
  try { return make() } finally { react.useState = saved }
}

// No command, no path and no terminal in any of Antigravity's sign-in lines (#2048, owner).
const noCommand = (text, what) => {
  for (const pattern of [/acp --login/, /env -i/, /\$env:/, /cli-homes/, /\/srv\//, /C:\\/, /\/bin\/agy/, /agy\.exe/, /Run /, /\{/]) {
    assert.doesNotMatch(text, pattern, what)
  }
}
const SIGNED_OUT_LINE = (tree) => findAll(tree, node => node.type === 'p' && /oai-acp-line/.test(node.props.className ?? '')
  && textOf(node).startsWith('Not signed in to Antigravity.'))

test('signed out: only "Not signed in to Antigravity." and Sign in, as Claude Code and Codex read', () => {
  const acp = acpOf()
  // The host drops the command; the row would not show one if it came anyway.
  for (const tree of [rowOf(agy(), acp), render(ui.AcpAgentRow({ agent: agy(), acp }))]) {
    const [line] = SIGNED_OUT_LINE(tree)
    assert.ok(line)
    assert.equal(textOf(line), 'Not signed in to Antigravity.Sign in')
    noCommand(textOf(tree), 'signed out')
    assert.deepEqual(findAll(tree, node => node.type === 'details' || node.type === 'code'), [])
    assert.deepEqual(buttons(tree, 'Copy'), [])
    assert.deepEqual(buttons(tree, 'Check again'), [])
  }
  const tree = rowOf(agy(), acp)
  buttons(tree, 'Sign in')[0].props.onClick()
  assert.deepEqual(acp.acted, [['sign-in', 'acp-antigravity']])
  // Without a command the row reads the same.
  const bare = rowOf(agy({}, { signInHint: undefined }))
  assert.equal(buttons(bare, 'Sign in').length, 1)
  assert.equal(textOf(SIGNED_OUT_LINE(bare)[0]), 'Not signed in to Antigravity.Sign in')
  // Off: nothing to sign in to; the off line says the sign-in is the app's own.
  const off = rowOf(agy({ on: false, connector: { state: 'off', native: true }, signedIn: undefined }))
  assert.deepEqual(buttons(off, 'Sign in'), [])
  assert.match(textOf(off), /Automagik keeps its own Antigravity sign-in, apart from the one in your terminal\./)
  assert.doesNotMatch(textOf(off), /already has on this computer/)
})

test('signing in, with agy\'s sign-in link as a link; each failure; and no browser on this computer', async () => {
  const busy = rowOf(agy({ signingIn: true }))
  assert.match(textOf(busy), /Finish the sign-in to Antigravity in your browser…/)
  assert.deepEqual(buttons(busy, 'Sign in'), [])
  assert.deepEqual(findAll(busy, node => node.type === 'a'), [])
  // A link agy printed: the row's link, worded as Claude's link flow (Sign in with {name}).
  const linked = rowOf(agy({ signingIn: true, signInUrl: GOOGLE }))
  const [link] = findAll(linked, node => node.type === 'a')
  assert.equal(link.props.href, GOOGLE)
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noreferrer')
  assert.equal(link.props.className, 'oai-link')
  assert.equal(textOf(link), 'Sign in with Antigravity')
  noCommand(textOf(linked), 'signing in')
  for (const [word, line] of [
    ['unsupported', 'Antigravity did not offer a Google sign-in. Try again.'],
    ['timeout', 'The sign-in to Antigravity took too long. Try again.'],
    ['failed', 'The sign-in to Antigravity did not finish. Try again.'],
  ]) {
    const tree = rowOf(agy({ signInError: word }))
    assert.ok(textOf(tree).includes(line), word)
    assert.equal(buttons(tree, 'Sign in').length, 1)
    noCommand(textOf(tree), word)
  }
  // No browser on this computer: the same row, and Sign in answers that the browser did not open.
  for (const row of [agy({ signInWhere: 'terminal' }), agy({ signInWhere: 'terminal' }, { signInHint: undefined })]) {
    const terminal = rowOf(row)
    assert.equal(textOf(SIGNED_OUT_LINE(terminal)[0]), 'Not signed in to Antigravity.Sign in')
    assert.deepEqual(buttons(terminal, 'Check again'), [])
    noCommand(textOf(terminal), 'no browser')
  }
  const said = []
  const refusing = async () => { throw new Error('The browser did not open. Try again.') }
  const acp = withHooks(() => ui.useAcp(refusing), said)
  assert.equal(await acp.nativeLogin(agy({ signInWhere: 'terminal' })), false)
  assert.equal(said.at(-1)?.['acp-antigravity'], 'The browser did not open. Try again.')
  const ptSaid = []
  const ptAcp = withHooks(() => ui.useAcp(refusing), ptSaid)
  locale.setLocale('pt-BR')
  try { await ptAcp.nativeLogin(agy({ signInWhere: 'terminal' })) } finally { locale.setLocale('en') }
  assert.equal(ptSaid.at(-1)?.['acp-antigravity'], 'O navegador não abriu. Tente de novo.')
  // Any other refusal keeps acp-dsh's words.
  const other = []
  const busyAcp = withHooks(() => ui.useAcp(async () => { throw new Error('The Bot account is changing.') }), other)
  await busyAcp.nativeLogin(agy())
  assert.equal(other.at(-1)?.['acp-antigravity'], 'The Bot account is changing.')
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

// Antigravity's own sign-in lines, in Chinese too (#2048, owner).
const ZH_KEYS = [
  'Not signed in to {name}.',
  'The browser did not open. Try again.',
  'Finish the sign-in to {name} in your browser…',
  '{name} did not offer a Google sign-in. Try again.',
  'The sign-in to {name} took too long. Try again.',
  'The sign-in to {name} did not finish. Try again.',
]
const NEW_KEYS = [
  ...ZH_KEYS,
  'Sign in with {name}',
  'Automagik keeps its own {name} sign-in, apart from the one in your terminal.',
  'Sign out',
  'On Windows, the {name} account is shared: Automagik and your own {name} on this computer use one sign-in, kept in Windows Credential Manager. Sign out is not available here: sign out in {name} itself.',
]
// The keys of the inline terminal command, gone with it.
const GONE_KEYS = [
  'Not signed in to {name}. Sign in here: your browser opens to finish.',
  'If no browser opens, run {command} in a new terminal window, then check again.',
  '{name} did not offer a Google sign-in. Use the terminal command below.',
  'Not signed in to {name}. This computer has no browser for the sign-in: run {command} in a new terminal window, then check again.',
  'Not signed in to {name}. This computer has no browser for the sign-in.',
]

test('every new line reads in pt-BR; Antigravity\'s sign-in lines and the Windows warning in Chinese', () => {
  for (const key of NEW_KEYS) assert.equal(typeof ui.PT_BR[key], 'string', key)
  for (const key of GONE_KEYS) assert.equal(ui.PT_BR[key], undefined, key)
  assert.deepEqual(Object.keys(ui.ZH), [...ZH_KEYS, NEW_KEYS.at(-1)])
  for (const text of [...NEW_KEYS.map(key => ui.PT_BR[key]), ...Object.values(ui.ZH)]) noCommand(text.replace(/\{name\}/g, ''), text)
  for (const key of ZH_KEYS) for (const text of [key, ui.PT_BR[key], ui.ZH[key]]) assert.doesNotMatch(text, /terminal|终端|command|comando|命令/i, text)
  const pt = inLocale('pt-BR', () => textOf(rowOf(agy({ signedIn: true, sharedAccount: true }))))
  assert.match(pt, /No Windows, a conta do Antigravity é compartilhada: .*Sair não está disponível aqui: saia pelo próprio Antigravity\./)
  assert.doesNotMatch(pt, /\{/)
  const ptOut = inLocale('pt-BR', () => rowOf(agy()))
  assert.equal(textOf(findAll(ptOut, node => node.type === 'p' && textOf(node).startsWith('Sem login'))[0]), 'Sem login no Antigravity.Entrar')
  noCommand(textOf(ptOut), 'pt-BR')
  const ptLink = inLocale('pt-BR', () => rowOf(agy({ signingIn: true, signInUrl: GOOGLE })))
  assert.equal(textOf(findAll(ptLink, node => node.type === 'a')[0]), 'Entrar com Antigravity')
  assert.match(textOf(ptLink), /Conclua o login no Antigravity pelo navegador…/)
  // Chinese: the signed-out line, the wait line and each failure.
  const zhOut = inLocale('zh', () => rowOf(agy()))
  assert.equal(textOf(findAll(zhOut, node => node.type === 'p' && textOf(node).startsWith('未登录'))[0]), '未登录 Antigravity。Sign in')
  noCommand(textOf(zhOut), 'zh')
  assert.match(inLocale('zh', () => textOf(rowOf(agy({ signingIn: true })))), /请在浏览器中完成 Antigravity 的登录…/)
  for (const [word, line] of [['unsupported', 'Antigravity 没有提供 Google 登录。请重试。'], ['timeout', 'Antigravity 的登录用时过长。请重试。'], ['failed', 'Antigravity 的登录没有完成。请重试。']]) {
    assert.ok(inLocale('zh', () => textOf(rowOf(agy({ signInError: word })))).includes(line), word)
  }
  // DSH's Chinese id is `zh`: the warning reads in Chinese, its neighbour line in English.
  const zh = inLocale('zh', () => textOf(rowOf(agy({ signedIn: true, sharedAccount: true }))))
  assert.ok(zh.includes('在 Windows 上，Antigravity 的账号是共享的：Automagik 和你在这台电脑上自己的 Antigravity 使用同一个登录，保存在 Windows 凭据管理器中。这里无法退出登录：请在 Antigravity 中退出。'))
  assert.ok(zh.includes('Signed in to Antigravity.'))
  assert.ok(!zh.includes(WARNING))
  assert.doesNotMatch(zh, /\{/)
})
