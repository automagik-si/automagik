// Antigravity in its own home (#2048, isolation amendment): the host passes the sign-in fields
// only with exact values, the isolated terminal command only in its two shapes and never to
// Antigravity's own row, `acp-sign-in`/`acp-sign-out` call acp-dsh through, and the row signs
// in here as Claude Code's and Codex's do (no command, no path), signs out with a confirm, and
// shows the Windows warning in every state (English, pt-BR and Chinese).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install } from '../src/host/endpoint.js'
import { ACP_ENTRY, agentView, isSignInHint, isSignInUrl } from '../src/host/acp.js'
import { needsViewer } from '../src/host/viewer-policy.js'
import { installLocale as installOwnLocale, PT_BR as OWN_PT_BR, ZH as OWN_ZH } from '../src/client/i18n.js'
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
  // r6 (#2048): a Linux without a display signs in from another computer; `signInWhere` is gone.
  assert.equal(view.signInWhere, undefined)
  assert.equal(view.sharedAccount, true)
  for (const word of ['unsupported', 'timeout', 'failed', 'no-browser', 'expired']) assert.equal(agentView(agy({ signInError: word })).signInError, word)
  const odd = agentView(agy({ appSignIn: 'yes', signingIn: 1, signInError: 'aborted', signInWhere: 'settings', sharedAccount: 'true', signInUrl: GOOGLE }))
  for (const field of ['appSignIn', 'signingIn', 'signInError', 'signInWhere', 'sharedAccount', 'signInUrl']) assert.equal(odd[field], undefined, field)
})

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123-abc.apps.googleusercontent.com'
  + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2Foauth2callback&response_type=code&scope=openid&state=s1-state-0001'

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
    GOOGLE.replace('accounts.google.com', 'a!@accounts.google.com'),
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
// The page's globals: W3 (r9) sets `omniDesktop`, `open`, `location` and `window` on it.
const sandbox = { module: client, exports: client.exports, setTimeout, clearTimeout, setInterval, clearInterval, URL, require: name => ({ react, 'react-dom': {} })[name] }
runInNewContext(bundle.outputFiles[0].text, sandbox)
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
    switchAccount: row => acted.push(['switch', row.id]),
    callback: (row, url) => acted.push(['callback', row.id, url]),
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
  // No browser on this computer: the same row.
  for (const row of [agy({ signInWhere: 'terminal' }), agy({ signInWhere: 'terminal' }, { signInHint: undefined })]) {
    const terminal = rowOf(row)
    assert.equal(textOf(SIGNED_OUT_LINE(terminal)[0]), 'Not signed in to Antigravity.Sign in')
    assert.deepEqual(buttons(terminal, 'Check again'), [])
    noCommand(textOf(terminal), 'no browser')
  }
  // A refusal keeps acp-dsh's words.
  const other = []
  const busyAcp = withHooks(() => ui.useAcp(async () => { throw new Error('The Bot account is changing.') }), other)
  await busyAcp.nativeLogin(agy())
  assert.equal(other.at(-1)?.['acp-antigravity'], 'The Bot account is changing.')
})

test('signed in, in Settings: Switch account as Claude Code and Codex; Continue signs out, then signs in at once', async () => {
  const acp = acpOf()
  const tree = rowOf(agy({ signedIn: true }), acp)
  assert.match(textOf(tree), /Signed in to Antigravity\./)
  // Claude Code's and Codex's Settings rows offer Switch account and no Sign out: so does this one.
  const [switchAccount] = buttons(tree, 'Switch account')
  assert.equal(switchAccount.props.className, 'oai-ghost oai-acp-act')
  assert.deepEqual(buttons(tree, 'Sign out'), [])
  switchAccount.props.onClick()
  assert.deepEqual(acp.acted, [['ask-sign-out', 'acp-antigravity']])
  // Their question, their Continue and Cancel.
  const asking = acpOf({ signOutPending: 'acp-antigravity' })
  const confirm = rowOf(agy({ signedIn: true }), asking)
  assert.match(textOf(confirm), /This stops running Bot work for this account\. Continue\?/)
  assert.deepEqual(buttons(confirm, 'Switch account'), [])
  buttons(confirm, 'Continue')[0].props.onClick()
  buttons(confirm, 'Cancel')[0].props.onClick()
  assert.deepEqual(asking.acted, [['switch', 'acp-antigravity'], ['cancel']])
  // Their words in pt-BR too (ZH reads the shared buttons in English, as theirs do).
  assert.equal(inLocale('pt-BR', () => buttons(rowOf(agy({ signedIn: true })), 'Trocar de conta').length), 1)
  // The one action: acp-sign-out, then acp-sign-in at once; the sign-in link shows as before.
  const id = { id: 'acp-antigravity' }
  const calls = []
  const switching = withHooks(() => ui.useAcp(async (endpoint, payload) => { calls.push([endpoint, { ...payload }]); return { available: true, agents: [] } }), [])
  assert.equal(await switching.switchAccount(agy({ signedIn: true })), true)
  assert.deepEqual(calls, [['acp-sign-out', id], ['acp-sign-in', id]])
  // A refused sign-out starts no sign-in, and its words stay on the row.
  const said = []
  const refusedCalls = []
  const refused = withHooks(() => ui.useAcp(async (endpoint, payload) => {
    refusedCalls.push([endpoint, { ...payload }])
    if (endpoint === 'acp-sign-out') throw new Error('The Bot account is changing.')
    return { available: true, agents: [] }
  }), said)
  assert.equal(await refused.switchAccount(agy({ signedIn: true })), false)
  assert.deepEqual(refusedCalls, [['acp-sign-out', id]])
  assert.equal(said.at(-1)?.['acp-antigravity'], 'The Bot account is changing.')
  // A refused sign-in reads in the page's words, as Sign in's do.
  const late = []
  const expired = withHooks(() => ui.useAcp(async (endpoint) => {
    if (endpoint === 'acp-sign-in') throw new Error('This sign-in expired. Start again.')
    return { available: true, agents: [] }
  }), late)
  locale.setLocale('pt-BR')
  try { assert.equal(await expired.switchAccount(agy({ signedIn: true })), false) } finally { locale.setLocale('en') }
  assert.equal(late.at(-1)?.['acp-antigravity'], ui.PT_BR['This sign-in expired. Start again.'])
})

test('signed in, in Connect AI\'s lines: Sign out stays, never Switch account', () => {
  // Connect AI draws the same lines with no Settings row (connect-ai.js): unchanged.
  const lines = ui.agentLines(agentView(agy({ signedIn: true })))
  assert.deepEqual(Array.from(lines.filter(line => line.text.startsWith('Signed in to')), line => line.action), ['native-sign-out'])
  const acp = acpOf()
  const [line] = lines.filter(row => row.action === 'native-sign-out')
  const tree = render(ui.AcpLine({ line, agent: agentView(agy({ signedIn: true })), acp, busy: false }))
  assert.deepEqual(buttons(tree, 'Switch account'), [])
  buttons(tree, 'Sign out')[0].props.onClick()
  const asking = acpOf({ signOutPending: 'acp-antigravity' })
  buttons(render(ui.AcpLine({ line, agent: agentView(agy({ signedIn: true })), acp: asking, busy: false })), 'Continue')[0].props.onClick()
  assert.deepEqual([...acp.acted, ...asking.acted], [['ask-sign-out', 'acp-antigravity'], ['sign-out', 'acp-antigravity']])
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
    // Switch account signs out first: not where the account is shared either.
    assert.deepEqual(buttons(tree, 'Switch account'), [])
  }
  // The off line keeps what is true there: the sign-in is the one this computer already has.
  assert.match(textOf(rowOf(agy({ ...shared, on: false, connector: { state: 'off', native: true }, signedIn: undefined }))), /already has on this computer/)
  // Anywhere else, no warning.
  assert.ok(!textOf(rowOf(agy({ signedIn: true }))).includes(WARNING))
})

// Antigravity's own sign-in lines, in Chinese too (#2048, owner).
const ZH_KEYS = [
  'Not signed in to {name}.',
  'The CLI did not offer a sign-in link in time. Try again.',
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
// Antigravity's Connect AI row and its sign-in from any computer, in Chinese too (#2048, r6).
const R6_ZH_KEYS = [
  'Your Google account, through Antigravity',
  'Installing {name}…',
  'The {cli} CLI is not on this computer. Automagik can install it for you.',
  'The {cli} CLI is not on this computer. Turn {name} on to install it.',
  'Found the {cli} CLI (installed by Automagik as version {version}; it updates itself).',
  'This link is not from this sign-in.',
  'Signed in on another computer? Paste the address the browser ends on:',
  'Finishing the sign-in to {name}…',
  'This sign-in expired. Start again.',
  'Expires at {time}',
]
// The keys of the inline terminal command, gone with it.
const GONE_KEYS = [
  'Not signed in to {name}. Sign in here: your browser opens to finish.',
  'If no browser opens, run {command} in a new terminal window, then check again.',
  '{name} did not offer a Google sign-in. Use the terminal command below.',
  'Not signed in to {name}. This computer has no browser for the sign-in: run {command} in a new terminal window, then check again.',
  'Not signed in to {name}. This computer has no browser for the sign-in.',
  // r9: the no-link end reads the chat's sentence instead (#2048, lead).
  'The browser did not open. Try again.',
]

test('every new line reads in pt-BR; Antigravity\'s sign-in lines and the Windows warning in Chinese', () => {
  for (const key of NEW_KEYS) assert.equal(typeof ui.PT_BR[key], 'string', key)
  for (const key of GONE_KEYS) {
    assert.equal(ui.PT_BR[key], undefined, key)
    assert.equal(ui.ZH[key], undefined, key)
  }
  assert.deepEqual(Object.keys(ui.ZH), [...ZH_KEYS, NEW_KEYS.at(-1), ...R6_ZH_KEYS])
  for (const text of [...NEW_KEYS.map(key => ui.PT_BR[key]), ...Object.values(ui.ZH)]) noCommand(text.replace(/\{(?:name|cli|version|time)\}/g, ''), text)
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

// ---- r5, r9: the sign-in link shows, and nothing opens it without a click (#2048) ------------

const withReturn = (back) => {
  const url = new URL(GOOGLE)
  if (back === undefined) url.searchParams.delete('redirect_uri')
  else url.searchParams.set('redirect_uri', back)
  return url.href
}

test('W1: a sign-in link needs agy\'s loopback return address, with a port', () => {
  for (const back of ['http://localhost:43117/auth/callback', 'http://127.0.0.1:4242/cb', 'http://[::1]:5000/cb']) {
    assert.equal(isSignInUrl(withReturn(back)), true, back)
  }
  for (const back of [undefined, 'https://localhost:43117/cb', 'http://evil.example:41234/cb', 'http://localhost/cb', 'http://127.0.0.1/cb',
    'http://localhost:1023/cb', 'http://localhost:80/cb',
    'http://a@localhost:41234/cb', 'http://localhost:41234/cb#x', 'http://127.0.0.2:41234/cb', 'http://localhost.evil.example:41234/cb', 'not a url']) {
    assert.equal(isSignInUrl(withReturn(back)), false, String(back))
    assert.equal(agentView(agy({ signingIn: true, signInUrl: withReturn(back) })).signInUrl, undefined, String(back))
  }
})

test('W2: no link: the chat\'s "The CLI did not offer a sign-in link in time. Try again.", then the signed-out line and Sign in', () => {
  for (const [id, bad, out, signIn] of [
    ['en', 'The CLI did not offer a sign-in link in time. Try again.', 'Not signed in to Antigravity.', 'Sign in'],
    ['pt-BR', 'O CLI não ofereceu um link de login a tempo. Tente de novo.', 'Sem login no Antigravity.', 'Entrar'],
    ['zh', 'CLI 没有及时给出登录链接，请重试。', '未登录 Antigravity。', 'Sign in'],
  ]) {
    const tree = inLocale(id, () => rowOf(agy({ signInError: 'no-browser' })))
    const lines = findAll(tree, node => node.type === 'p' && /oai-acp-line/.test(node.props.className ?? '')).map(textOf)
    const at = lines.indexOf(bad)
    assert.ok(at >= 0, `${id}: ${lines.join(' | ')}`)
    assert.equal(lines[at + 1], `${out}${signIn}`, id)
    assert.equal(buttons(tree, signIn).length, 1, id)
    noCommand(textOf(tree), `no-browser ${id}`)
  }
  assert.equal(agentView(agy({ signInError: 'no-browser' })).signInError, 'no-browser')
  assert.equal(agentView(agy({ signInError: 'no-display' })).signInError, undefined)
})

test('W3 (r9): nothing opens without a click', () => {
  const second = GOOGLE.replace('state=s1', 'state=s2')
  const views = [GOOGLE, GOOGLE, GOOGLE, second]
    .map(url => ({ available: true, agents: [agentView(agy({ ...PASTING, signInUrl: url }))] }))
  const opened = []
  const cleanups = []
  const saved = { useState: react.useState, useEffect: react.useEffect }
  let pending
  // The first useState of each mount (useAcp's view) takes that mount's own view.
  react.useState = (initial) => {
    if (pending !== undefined) { const view = pending; pending = undefined; return [view, () => {}] }
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  }
  react.useEffect = (fn) => { const done = fn(); if (typeof done === 'function') cleanups.push(done) }
  const location = {
    assign: url => opened.push(['location.assign', url]),
    replace: url => opened.push(['location.replace', url]),
    set href(url) { opened.push(['location.href', url]) },
    get href() { return 'http://localhost/' },
  }
  let tree
  try {
    sandbox.omniDesktop = {}
    sandbox.open = (...args) => opened.push(['open', ...args])
    sandbox.location = location
    sandbox.window = { open: (...args) => opened.push(['window.open', ...args]), location }
    // Settings, Connect AI, a remount, and a poll that brings a second link.
    for (const view of views) {
      pending = view
      ui.useAcp(async () => view)
      assert.equal(pending, undefined, 'the mount took its view')
    }
    assert.deepEqual(opened, [])
    assert.equal(ui.openSignInLinks, undefined)
    // The row: the link, Copy and the paste field, still with nothing opened.
    tree = rowOf(agy(PASTING))
  } finally {
    Object.assign(react, saved)
    for (const done of cleanups) done()
    delete sandbox.omniDesktop
    delete sandbox.open
    delete sandbox.location
    delete sandbox.window
  }
  assert.deepEqual(opened, [])
  const links = findAll(tree, node => node.type === 'a')
  assert.equal(links.length, 1)
  assert.equal(links[0].props.href, GOOGLE)
  assert.equal(links[0].props.target, '_blank')
  assert.equal(links[0].props.rel, 'noreferrer')
  assert.equal(buttons(tree, 'Copy').length, 1)
  assert.equal(findAll(tree, node => node.type === 'form').length, 1)
})

test('W4: the two sign-out words pass only as exact words, only with appSignIn, and draw nothing', () => {
  for (const word of ['yes', 'no']) assert.equal(agentView(agy({ signOutOverAcp: word })).signOutOverAcp, word)
  for (const word of ['done', 'none', 'failed']) assert.equal(agentView(agy({ lastSignOut: word })).lastSignOut, word)
  for (const [field, value] of [['signOutOverAcp', 'maybe'], ['signOutOverAcp', true], ['lastSignOut', 'ok'], ['lastSignOut', 1]]) {
    assert.equal(agentView(agy({ [field]: value }))[field], undefined, `${field} ${value}`)
  }
  const plain = agentView(agy({ appSignIn: undefined, signOutOverAcp: 'yes', lastSignOut: 'done' }))
  assert.equal(plain.signOutOverAcp, undefined)
  assert.equal(plain.lastSignOut, undefined)
  for (const over of [{}, { signedIn: true }, { signingIn: true }, { signInError: 'no-browser' }]) {
    const bare = rowOf(agy(over))
    const words = rowOf(agy({ ...over, signOutOverAcp: 'yes', lastSignOut: 'done' }))
    assert.equal(JSON.stringify(words), JSON.stringify(bare), JSON.stringify(over))
  }
})

// ---- r6 cycle: sign in from any computer, paste back the address (#2048, owner) ------------

const ATTEMPT = '0a1b2c3d-1111-2222-3333-444455556666'
const PASTING = { signingIn: true, signInUrl: GOOGLE, signInAttempt: ATTEMPT, signInPaste: true, signInExpiresAt: Date.UTC(2026, 10, 23, 15, 4) }

test('W5: the paste-back fields pass only as exact values, only with appSignIn, and the first four only while signing in', () => {
  const view = agentView(agy({ ...PASTING, signInChecking: true, signInEnd: 'window' }))
  assert.equal(view.signInAttempt, ATTEMPT)
  assert.equal(view.signInPaste, true)
  assert.equal(view.signInChecking, true)
  assert.equal(view.signInExpiresAt, PASTING.signInExpiresAt)
  assert.equal(view.signInEnd, 'window')
  assert.equal(view.signInWhere, undefined)
  for (const word of ['agent-error', 'agent-exit', 'deadline', 'window', 'checking', 'unreachable']) {
    assert.equal(agentView(agy({ signInEnd: word })).signInEnd, word)
  }
  assert.equal(agentView(agy({ signInError: 'expired' })).signInError, 'expired')
  for (const [field, value] of [['signInAttempt', 'not-a-uuid'], ['signInAttempt', ATTEMPT.toUpperCase()], ['signInPaste', 'true'],
    ['signInChecking', 1], ['signInExpiresAt', 'soon'], ['signInExpiresAt', Infinity], ['signInEnd', 'aborted'], ['signInEnd', true]]) {
    assert.equal(agentView(agy({ ...PASTING, [field]: value }))[field], undefined, `${field} ${value}`)
  }
  // Not while no sign-in runs, and never for a row that does not sign in here.
  const idle = agentView(agy({ ...PASTING, signingIn: undefined, signInChecking: true }))
  for (const field of ['signInAttempt', 'signInPaste', 'signInChecking', 'signInExpiresAt']) assert.equal(idle[field], undefined, field)
  const other = agentView(agy({ ...PASTING, appSignIn: undefined, signInChecking: true, signInEnd: 'window' }))
  for (const field of ['signInAttempt', 'signInPaste', 'signInChecking', 'signInExpiresAt', 'signInEnd']) assert.equal(other[field], undefined, field)
})

test('W6: acp-sign-in-callback calls acp-dsh through with { id, attempt, url }, in its words, and needs the owner viewer', async () => {
  const calls = []
  const rows = [agy(PASTING)]
  const URL_PASTED = 'http://localhost:4242/oauth2callback?code=c&state=s1-state-0001'
  const service = {
    status: async () => ({ agents: rows }),
    signInCallback: async (id, attempt, url) => {
      calls.push([id, attempt, url])
      if (calls.length === 2) throw Object.assign(new Error('This link is not from this sign-in.'), { code: 'acp-sign-in/not-this-sign-in' })
      if (calls.length === 3) throw Object.assign(new Error('This sign-in expired. Start again.'), { code: 'acp-sign-in/expired' })
      if (calls.length === 4) throw new Error(`boom ${url}`)
      return { agents: rows }
    },
  }
  const fake = host(service)
  const send = payload => fake.handle('acp-sign-in-callback', payload)
  const ok = await send({ id: 'acp-antigravity', attempt: ATTEMPT, url: URL_PASTED })
  assert.equal(ok.ok, true)
  assert.doesNotMatch(JSON.stringify(ok), /code=c/)
  assert.deepEqual(calls, [['acp-antigravity', ATTEMPT, URL_PASTED]])
  assert.deepEqual((await send({ id: 'acp-antigravity', attempt: ATTEMPT, url: URL_PASTED })).error, { code: 'omni-ai/refused', message: 'This link is not from this sign-in.' })
  assert.deepEqual((await send({ id: 'acp-antigravity', attempt: ATTEMPT, url: URL_PASTED })).error, { code: 'omni-ai/refused', message: 'This sign-in expired. Start again.' })
  // Anything else acp-dsh throws reads as expired, and never echoes the address.
  const odd = await send({ id: 'acp-antigravity', attempt: ATTEMPT, url: URL_PASTED })
  assert.deepEqual(odd.error, { code: 'omni-ai/refused', message: 'This sign-in expired. Start again.' })
  // A bad payload: not this sign-in; a stale page's attempt id: expired. acp-dsh is not asked.
  for (const payload of [{ id: 'acp-antigravity', attempt: ATTEMPT }, { id: 'acp-gemini', attempt: ATTEMPT, url: 'x' },
    { id: 'acp-antigravity', attempt: ATTEMPT, url: 'a'.repeat(8193) }, { id: 'acp-antigravity', attempt: ATTEMPT, url: 42 }, null]) {
    assert.deepEqual((await send(payload)).error, { code: 'omni-ai/refused', message: 'This link is not from this sign-in.' }, JSON.stringify(payload)?.slice(0, 80))
  }
  for (const attempt of [undefined, 'not-a-uuid', 42]) {
    assert.deepEqual((await send({ id: 'acp-antigravity', attempt, url: URL_PASTED })).error, { code: 'omni-ai/refused', message: 'This sign-in expired. Start again.' }, String(attempt))
  }
  assert.equal(calls.length, 4)
  assert.match((await host({ status: async () => ({ agents: rows }) }).handle('acp-sign-in-callback', { id: 'acp-antigravity', attempt: ATTEMPT, url: URL_PASTED })).error.message, /cannot sign in/)
  assert.equal(needsViewer('acp-sign-in-callback'), true)
})

const pasteForm = tree => findAll(tree, node => node.type === 'form')
const remembered = []
sandbox[Symbol.for('automagik.cli-login')] = { remember: url => remembered.push(url) }

test('W7: signing in shows the link, Copy, the paste field and the expiry; Send empties the field first', async () => {
  const acp = acpOf()
  const tree = rowOf(agy(PASTING), acp)
  const [link] = findAll(tree, node => node.type === 'a')
  assert.equal(link.props.href, GOOGLE)
  assert.equal(buttons(tree, 'Copy').length, 1)
  assert.match(textOf(tree), /Signed in on another computer\? Paste the address the browser ends on:/)
  assert.match(textOf(tree), /Expires at /)
  const [form] = pasteForm(tree)
  const [input] = findAll(form, node => node.type === 'input')
  assert.equal(input.props.type, 'password')
  assert.equal(input.props.autoComplete, 'off')
  assert.equal(input.props.spellCheck, false)
  assert.equal(input.props['data-1p-ignore'], 'true')
  assert.equal(input.props['data-lpignore'], 'true')
  assert.equal(input.props['data-bwignore'], 'true')
  assert.equal(input.props.value, undefined, 'the field is never in the page\'s state')
  assert.equal(buttons(form, 'Send').length, 1)
  // Send: the field is emptied before the request.
  const field = { value: '  http://localhost:4242/oauth2callback?code=c&state=s1-state-0001 ' }
  let seenAtCall
  const sending = acpOf({ callback: (row, url) => { seenAtCall = field.value; sending.acted.push(['callback', row.id, url]) } })
  const [sendForm] = pasteForm(rowOf(agy(PASTING), sending))
  sendForm.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: name => (name === 'sign-in-address' ? field : null) } } })
  assert.equal(seenAtCall, '')
  assert.equal(field.value, '')
  assert.deepEqual(sending.acted, [['callback', 'acp-antigravity', '  http://localhost:4242/oauth2callback?code=c&state=s1-state-0001 ']])
  // The Bot team's chat guard learns the link (its composer refuses the address it ends on).
  assert.ok(remembered.includes(GOOGLE))
  // useAcp sends { id, attempt, url } and reads both refusals in the page's language.
  const requests = []
  const said = []
  const answers = ['This link is not from this sign-in.', 'This sign-in expired. Start again.']
  const live = withHooks(() => ui.useAcp(async (endpoint, payload) => {
    requests.push([endpoint, payload])
    if (endpoint === 'acp-sign-in-callback') throw new Error(answers.shift())
    return { available: true, agents: [] }
  }), said)
  locale.setLocale('pt-BR')
  try {
    await live.callback(agentView(agy(PASTING)), 'http://localhost:4242/x')
    await live.callback(agentView(agy(PASTING)), 'http://localhost:4242/y')
  } finally { locale.setLocale('en') }
  // The payloads come from the bundle's own realm: compared as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(requests.filter(([endpoint]) => endpoint === 'acp-sign-in-callback'))), [
    ['acp-sign-in-callback', { id: 'acp-antigravity', attempt: ATTEMPT, url: 'http://localhost:4242/x' }],
    ['acp-sign-in-callback', { id: 'acp-antigravity', attempt: ATTEMPT, url: 'http://localhost:4242/y' }],
  ])
  assert.deepEqual(said.map(problem => problem['acp-antigravity']).filter(Boolean), ['Este link não é deste login.', 'Este login expirou. Comece de novo.'])
  // Delivered: only "Finishing…", no field and no link.
  const checking = rowOf(agy({ ...PASTING, signInPaste: undefined, signInChecking: true }))
  assert.match(textOf(checking), /Finishing the sign-in to Antigravity…/)
  assert.deepEqual(pasteForm(checking), [])
  assert.deepEqual(findAll(checking, node => node.type === 'a'), [])
  // A link with no paste offered (an older acp-dsh): the link and Copy, no field.
  const linkOnly = rowOf(agy({ signingIn: true, signInUrl: GOOGLE }))
  assert.equal(buttons(linkOnly, 'Copy').length, 1)
  assert.deepEqual(pasteForm(linkOnly), [])
  // Expired: the chat's own sentence, then the signed-out line and Sign in.
  const expired = rowOf(agy({ signInError: 'expired' }))
  const lines = findAll(expired, node => node.type === 'p' && /oai-acp-line/.test(node.props.className ?? '')).map(textOf)
  assert.ok(lines.includes('This sign-in expired. Start again.'), lines.join(' | '))
  assert.equal(buttons(expired, 'Sign in').length, 1)
  // Every state, in every language: no command, no path.
  for (const id of ['en', 'pt-BR', 'zh']) {
    for (const row of [agy(PASTING), agy({ ...PASTING, signInPaste: undefined, signInChecking: true }), agy({ signInError: 'expired' })]) {
      noCommand(inLocale(id, () => textOf(rowOf(row))).replace(/\{/g, ''), id)
    }
  }
  const pt = inLocale('pt-BR', () => textOf(rowOf(agy(PASTING))))
  assert.match(pt, /Entrou em outro computador\? Cole o endereço em que o navegador parou:/)
  assert.match(pt, /Expira às /)
  assert.match(pt, /Copiar/)
  assert.match(inLocale('pt-BR', () => textOf(rowOf(agy({ ...PASTING, signInPaste: undefined, signInChecking: true })))), /Concluindo o login em Antigravity…/)
  assert.match(inLocale('pt-BR', () => textOf(rowOf(agy({ signInError: 'expired' })))), /Este login expirou\. Comece de novo\./)
  const zh = inLocale('zh', () => textOf(rowOf(agy(PASTING))))
  assert.match(zh, /在另一台电脑上登录了？请粘贴浏览器最后停留的地址：/)
  assert.match(zh, /过期/)
  // ZH keeps the buttons in English (Connect AI choice F).
  assert.match(zh, /Copy/)
  assert.match(zh, /Send/)
  assert.match(inLocale('zh', () => textOf(rowOf(agy({ ...PASTING, signInPaste: undefined, signInChecking: true })))), /正在完成 Antigravity 的登录…/)
})

// Kept last: it installs the module's own locale binding and resets it (G8-1).
test('the expired and the no-link sentences are the chat\'s, byte for byte', () => {
  const source = readFileSync(new URL('../../bots-dsh/src/client/i18n.js', import.meta.url), 'utf8')
  const omniUi = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const KEYS = ['This sign-in expired. Start again.', 'The CLI did not offer a sign-in link in time. Try again.']
  for (const KEY of KEYS) {
    const found = source.split('\n').filter(line => line.trimStart().startsWith(`${JSON.stringify(KEY)}:`))
    assert.equal(found.length, 1, KEY)
    const zh = JSON.parse(found[0].trimStart().slice(JSON.stringify(KEY).length + 1).trim().replace(/,$/, ''))
    const pt = omniUi[KEY]
    assert.equal(typeof zh, 'string', KEY)
    assert.ok(zh.length > 0, KEY)
    assert.equal(typeof pt, 'string', KEY)
    assert.ok(pt.length > 0, KEY)
    assert.equal(OWN_ZH[KEY], zh, KEY)
    assert.equal(OWN_PT_BR[KEY], pt, KEY)
  }
  let seen
  const dispose = installOwnLocale({ register(ns, tables) { seen = { ns, tables }; return () => {} }, bind() { return key => key } })
  try {
    assert.equal(seen.ns, 'welcome.team')
    for (const KEY of KEYS) assert.equal(seen.tables.en[KEY], KEY)
  } finally { dispose() }
})
