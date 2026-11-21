import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { fakeLocale } from './fake-locale.js'

const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/client/team.js'",
      "export * from './src/client/power-shortcut.js'",
      "export * from './src/client/power-store.js'",
      "export { installLocale, t } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: dirname(dirname(fileURLToPath(import.meta.url))),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@automagik/bots-dsh/client'],
  loader: { '.css': 'text' },
})

const V = '2.261112.5'
const P = '2.261112.6'
const fallback = { version: P, tag: `v${P}`, commit: 'pinned' }
const npm = { version: V, latest: V, exitCode: null }
const id = 'job-1'
const terminal = 'install-1'
const base = 'http://127.0.0.1:18882'
const sandbox = { id: 'right', source: 'sandbox', reachable: true, version: P, url: 'http://localhost:18882' }
const ready = (version = V) => ({ state: 'ready', command: `bun x --bun @automagik/omni@${version} install --sandbox --at-login` })
const running = {
  id, acknowledged: false, source: 'github', reason: 'behind', npm, release: { version: P, tag: fallback.tag },
  step: 'download', steps: [{ id: 'check', state: 'done' }, { id: 'download', state: 'now' },
    { id: 'build', state: 'skipped' }, { id: 'install', state: 'next' }],
  phase: 'running', log: 'download output', fellBack: false, cancelRequested: false, error: null, next: null, report: null,
}
const done = {
  ...running, phase: 'done', step: null, steps: running.steps.map(step => ({ ...step, state: 'done' })),
  report: { version: P, apiUrl: `${base}/api/v2/`, home: '/fake/omni' },
}
const job = job => ({ job })
const claim = (job, claimed = true) => ({ job, claimed })
const plain = value => JSON.parse(JSON.stringify(value))
const noWait = async () => {}
const settle = () => new Promise(resolve => setImmediate(resolve))
const paired = { status: 'paired', origin: base }
const deferred = () => Promise.withResolvers()

function client(answers = {}) {
  const requests = []
  const shown = []
  const request = async (endpoint, payload) => {
    requests.push([endpoint, plain(payload ?? null)])
    assert.ok(endpoint in answers, `unexpected request ${endpoint}`)
    const answer = answers[endpoint]
    return typeof answer === 'function' ? answer(payload) : answer
  }
  const fetch = async (_route, options) => {
    const { endpoint, payload } = JSON.parse(options.body)
    let result
    try {
      result = { ok: true, value: await request(endpoint, payload) }
    } catch (error) {
      result = { ok: false, error: { code: error.code, message: error.message } }
    }
    return { ok: true, json: async () => result }
  }

  const slots = []
  let slot = 0
  let effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = slot++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(value) {
      const index = slot++
      return slots[index] ?? (slots[index] = { current: value })
    },
    useEffect(effect, deps) {
      const prior = slots[slot++]
      slots[slot - 1] = deps
      if (!prior || deps.some((value, index) => value !== prior[index])) effects.push(effect)
    },
    useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, URL, setTimeout, clearTimeout, AbortController, matchMedia: () => ({ matches: true }), fetch,
    require: name => ({ react, 'react-dom': { createPortal: node => node } })[name],
  })
  const ui = module.exports
  const show = (phase, detail = null) => shown.push([phase, plain(detail)])
  const options = { omniAi: request, omniUi: request, show, wait: noWait }
  const github = overrides => ui.githubInstall({ ...options, start: { version: V, reason: 'behind' }, npm, ...overrides })
  const power = () => ui.powerOn({ ...options, quick: true })
  const sandboxInstall = () => ui.sandboxInstall({
    ...options, check: version => request('omni-server-check', { version, fallback: true }),
  })
  const mount = props => {
    const render = () => {
      slot = 0
      effects = []
      const tree = ui.TeamStep({ stepId: 'omni-team', complete() {}, ...props })
      for (const effect of effects) effect()
      return tree
    }
    return { render }
  }
  return { ui, options, requests, shown, request, github, power, sandboxInstall, mount,
    names: () => requests.map(([endpoint]) => endpoint),
    last: () => shown.at(-1),
  }
}

function findAll(node, match) {
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, match))]
}

function inside(ui, phase, detail) {
  const machine = ui.Machine({ phase, detail, power: {} })
  const [node] = findAll(machine, node => node.type.name === 'Inside')
  return node.type(node.props)
}

const paragraphs = tree => findAll(tree, node => node.type === 'p').map(node => node.children[0])
const logOf = tree => {
  const [log] = findAll(tree, node => node.type.name === 'InstallLog')
  return log && plain(log.props)
}
const stepsOf = tree => findAll(tree, node => node.type === 'li').map(node => [node.children[1], node.props.className])

const terminalAnswers = {
  'omni-terminal-open': { terminal, ...ready() },
  'omni-terminal-close': {},
  'omni-terminal-write': { ok: true },
}
const connectAnswers = {
  'omni-discover': { omnis: [sandbox] },
  'omni-link': { linked: false },
  'omni-discover-use': paired,
  'omni-github-ack': claim({ ...done, acknowledged: true }),
}

test('behind closes the terminal and uses only the reachable sandbox with the reported address and version', async () => {
  const c = client({
    ...terminalAnswers, ...connectAnswers,
    'omni-server-check': { ok: false, reason: 'behind', npm: '2.261112.4', fallback },
    'omni-github-install': job({ ...running, npm: { ...npm, latest: '2.261112.4' } }),
    'omni-github-status': job(done),
    'omni-discover': { omnis: [
      { ...sandbox, id: 'unreachable', reachable: false }, { ...sandbox, id: 'cli', source: 'cli' },
      { ...sandbox, id: 'port', url: 'http://localhost:18883' }, { ...sandbox, id: 'version', version: V },
      { ...sandbox, id: 'scheme', url: 'https://localhost:18882' },
      { ...sandbox, id: 'path', url: 'http://localhost:18882/elsewhere' }, sandbox,
    ] },
  })
  assert.equal(await c.sandboxInstall(), 'linked')
  assert.deepEqual(c.requests, [
    ['omni-terminal-open', { kind: 'install', cols: 72, rows: 8 }],
    ['omni-server-check', { version: V, fallback: true }],
    ['omni-terminal-close', { terminal }],
    ['omni-github-install', { version: V, reason: 'behind' }],
    ['omni-github-status', { id }],
    ['omni-discover', null], ['omni-link', null], ['omni-github-ack', { id }], ['omni-discover-use', { id: 'right' }],
  ])
  assert.deepEqual(c.shown[0], ['sandbox', { terminal: null, log: '', step: null }])
  const [, detail] = c.shown.find(([, detail]) => detail?.job === id && detail.step === 'download')
  assert.deepEqual(detail.steps, running.steps)
  const tree = inside(c.ui, 'sandbox', detail)
  assert.deepEqual(paragraphs(tree), [
    `npm's newest Omni is 2.261112.4, older than Omni ${P}, which this Automagik installs.`,
    `Installing Omni ${P} from GitHub instead.`,
  ])
  assert.deepEqual(stepsOf(tree), [
    ['Check', 'oai-install-done'], ['Download', 'oai-install-now'], ['Install', 'oai-install-next'], ['Connect', 'oai-install-next'],
  ])
  assert.equal(findAll(inside(c.ui, ...c.shown.at(-2)), node => node.type === 'li').at(-1).props.className, 'oai-install-now')
  assert.deepEqual(c.last(), ['linked', { origin: base }])
})

test('unpublished installs with a fallback and keeps the old refusal without one', async () => {
  const refusal = { ok: false, reason: 'unpublished', npm: '2.261112.4', github: fallback.tag }
  const c = client({
    ...terminalAnswers, ...connectAnswers,
    'omni-server-check': { ...refusal, fallback },
    'omni-github-install': job({ ...running, reason: 'unpublished' }),
    'omni-github-status': job(done),
  })
  assert.equal(await c.sandboxInstall(), 'linked')
  assert.deepEqual(c.requests[3], ['omni-github-install', { version: V, reason: 'unpublished' }])
  const old = client({ ...terminalAnswers, 'omni-server-check': { ...refusal, fallback: null } })
  assert.equal(await old.sandboxInstall(), 'failed')
  assert.deepEqual(old.names(), ['omni-terminal-open', 'omni-server-check', 'omni-terminal-close'])
  assert.deepEqual(old.last(), ['failed', { message:
    `Omni ${V} is not on npm, where Omni's installer gets it. The newest there is 2.261112.4. Omni v${P} is out on GitHub and not on npm yet. Power Omni off and on again to take the Omni plugins that work with it, or use an Omni on another computer.`,
  }])
})

test('no systemd can use npm, then report a GitHub fallback on the same job with a fresh log', async () => {
  const fromNpm = {
    ...running, reason: 'no-systemd', source: 'npm', release: { version: V, tag: null }, step: 'install',
    steps: running.steps.map(step => ({ ...step, state: ['download', 'build'].includes(step.id) ? 'skipped' : step.state })),
    log: 'npm output',
  }
  const fromGitHub = { ...running, reason: 'no-systemd', fellBack: true, log: 'GitHub output' }
  for (const offered of [fallback, null]) {
    const statuses = [fromGitHub, done]
    const c = client({
      ...terminalAnswers, ...connectAnswers,
      'omni-server-check': { ok: false, reason: 'no-systemd', npmHas: true, fallback: offered },
      'omni-github-install': job(fromNpm),
      'omni-github-status': () => job(statuses.shift()),
    })
    assert.equal(await c.sandboxInstall(), 'linked')
    assert.deepEqual(c.requests.slice(2, 6), [
      ['omni-terminal-close', { terminal }], ['omni-github-install', { version: V, reason: 'no-systemd' }],
      ['omni-github-status', { id }], ['omni-github-status', { id }],
    ])
    assert.equal(c.names().includes('omni-terminal-write'), false)
    const [usingNpm, usingGitHub] = c.shown.filter(([, detail]) => detail?.job === id).map(entry => inside(c.ui, ...entry))
    const reason = "Omni's npm installer needs systemd, and this computer has none."
    assert.deepEqual(paragraphs(usingNpm), [reason, `Installing Omni ${V} from npm.`])
    assert.deepEqual(stepsOf(usingNpm).map(([label]) => label), ['Check', 'Install', 'Connect'])
    // The box has room for the reason, the source and the steps; the log shows on a failure.
    assert.equal(logOf(usingNpm), undefined)
    assert.deepEqual(c.shown.filter(([, detail]) => detail?.job === id).map(([, detail]) => detail.log).slice(0, 2), ['npm output', 'GitHub output'])
    assert.deepEqual(paragraphs(usingGitHub), [reason, `npm could not install it either. Installing Omni ${P} from GitHub instead.`])
    assert.equal(logOf(usingGitHub), undefined)
  }
  const old = client({ ...terminalAnswers, 'omni-server-check': { ok: false, reason: 'no-systemd' } })
  assert.equal(await old.sandboxInstall(), 'failed')
  assert.deepEqual(old.names(), ['omni-terminal-open', 'omni-server-check', 'omni-terminal-close'])
})

test('an npm exit of 1 uses the checked ready version after Enter is retried', async () => {
  const reads = [ready(), ready(P), { state: 'exited', exitCode: 1, data: 'terminal output' }]
  let writes = 0
  const c = client({
    ...terminalAnswers, ...connectAnswers,
    'omni-terminal-open': { terminal, ...ready('2.261112.3'), state: 'preparing' },
    'omni-terminal-read': () => reads.shift(),
    'omni-terminal-write': () => ({ ok: ++writes > 1 }),
    'omni-server-check': { ok: true, fallback },
    'omni-github-install': job({ ...running, reason: 'npm-failed', npm: { version: V, latest: null, exitCode: 1 } }),
    'omni-github-status': job(done),
  })
  assert.equal(await c.sandboxInstall(), 'linked')
  assert.deepEqual(c.requests.slice(1, 10), [
    ['omni-terminal-read', { terminal, from: 0 }], ['omni-server-check', { version: V, fallback: true }],
    ['omni-terminal-write', { terminal, data: '\r' }], ['omni-terminal-read', { terminal, from: 0 }],
    ['omni-terminal-write', { terminal, data: '\r' }], ['omni-terminal-read', { terminal, from: 0 }],
    ['omni-terminal-close', { terminal }], ['omni-github-install', { version: V, reason: 'npm-failed', exitCode: 1 }],
    ['omni-github-status', { id }],
  ])
  const progress = c.shown.find(([, detail]) => detail?.job === id)
  const tree = inside(c.ui, ...progress)
  assert.deepEqual(paragraphs(tree), ['Installing Omni from npm failed (exit code 1).', `Installing Omni ${P} from GitHub instead.`])
  assert.equal(logOf(tree), undefined)
  assert.equal(progress[1].log, running.log)
})

test('the terminal retains cancellation, preparation failures, and failures without a fallback', async () => {
  for (const [read, answer, message] of [
    [{ state: 'exited', exitCode: 130 }, { ok: true, fallback }, 'The install was cancelled.'],
    [{ state: 'exited', exitCode: 1 }, { ok: true }, "Omni's installer stopped (exit code 1). What it printed is above."],
    [{ state: 'failed', error: 'Could not prepare Bun.' }, { ok: true, fallback }, 'Could not prepare Bun.'],
  ]) {
    const c = client({
      ...terminalAnswers, 'omni-server-check': answer,
      'omni-terminal-read': { ...read, data: 'terminal output' },
    })
    assert.equal(await c.sandboxInstall(), 'failed')
    assert.deepEqual(c.last(), ['failed', { message, log: 'terminal output' }])
    assert.deepEqual(c.names(), ['omni-terminal-open', 'omni-server-check', 'omni-terminal-write', 'omni-terminal-read', 'omni-terminal-close'])
  }
  for (const answer of [{ ok: true, unchecked: true }, () => { throw new Error('lookup unavailable') }]) {
    const c = client({ ...terminalAnswers, 'omni-server-check': answer, 'omni-terminal-read': { exitCode: 0 } })
    assert.equal(await c.sandboxInstall(), 'linked')
    assert.deepEqual(c.names(), ['omni-terminal-open', 'omni-server-check', 'omni-terminal-write', 'omni-terminal-read', 'omni-terminal-close'])
  }
})

test('a zero exit while the terminal links waits for pairing or the later link error', async () => {
  for (const result of [{ state: 'done', result: paired }, { state: 'failed', exitCode: 0, error: 'Link failed.' }]) {
    const reads = [{ state: 'linking', exitCode: 0 }, result]
    const c = client({
      ...terminalAnswers, 'omni-server-check': { ok: true, fallback }, 'omni-terminal-read': () => reads.shift(),
    })
    assert.equal(await c.sandboxInstall(), result.error ? 'failed' : 'linked')
    assert.deepEqual(c.names().slice(-3), ['omni-terminal-read', 'omni-terminal-read', 'omni-terminal-close'])
    assert.deepEqual(c.last()[1], result.error ? { message: result.error, log: '' } : { origin: base })
  }
})

test('job failures render the host message, translated failed step, log and each next action', async () => {
  for (const [next, advice] of [
    ['retry', 'Power Omni on to try again.'], ['update', 'Update Automagik, then power Omni on again.'],
    ['other-omni', 'Use an Omni on another computer.'], [null, null],
  ]) {
    const error = 'The build could not find a dependency.'
    const failed = { ...running, phase: 'failed', error, next, steps: [{ id: 'build', state: 'failed' }] }
    const c = client({ 'omni-github-install': job(running), 'omni-github-status': job(failed) })
    assert.equal(await c.github(), 'failed')
    const tree = inside(c.ui, ...c.last())
    // The host's words, where it stopped and what to do next, each in its note (no room for the log too).
    const reasonLine = paragraphs(inside(c.ui, 'sandbox', { ...running, job: id }))[0]
    assert.deepEqual(paragraphs(tree), [reasonLine, `It stopped at the Build step. ${error}`, ...(advice ? [advice] : [])])
    assert.equal(logOf(tree), undefined)
    assert.equal(c.last()[1].log, running.log)
    // A failure with no words from the host shows its log, with one note under it.
    const quiet = inside(c.ui, 'failed', { ...c.last()[1], message: 'Omni could not be installed from GitHub.', github: { ...c.last()[1].github, error: null } })
    const words = ['It stopped at the Build step.', 'Omni could not be installed from GitHub.', ...(advice ? [advice] : [])].join(' ')
    assert.deepEqual(paragraphs(quiet), [words])
    assert.deepEqual(logOf(quiet), { text: running.log, label: 'What the GitHub install printed' })
    const [note] = findAll(quiet, node => node.type === 'p')
    assert.equal(note.props.title, `${reasonLine} ${words}`)
    const [phase, detail] = c.last()
    assert.equal(c.ui.powerRow('omni', { phase, detail }).alert, error)
  }
})

test('job cancellation, refused POST, lost status and repeated status errors have their own messages', async () => {
  const lost = "The install's progress was lost (Automagik may have restarted). Power Omni on to try again."
  for (const [answers, message, polls] of [
    [{ 'omni-github-install': job({ ...running, phase: 'cancelled' }) }, 'The install was cancelled.', 0],
    [{ 'omni-github-install': () => { throw new Error('An image sandbox is already installed.') } }, 'An image sandbox is already installed.', 0],
    [{ 'omni-github-status': job(null) }, lost, 1],
    [{ 'omni-github-status': () => { throw new Error('Status unavailable.') } }, 'Status unavailable.', 5],
  ]) {
    const c = client({ 'omni-github-install': job(running), ...answers })
    assert.equal(await c.github(), 'failed')
    assert.equal(c.last()[1].message, message)
    assert.deepEqual(c.requests.slice(1), Array.from({ length: polls }, () => ['omni-github-status', { id }]))
    if (polls) assert.equal(c.last()[1].github.job, id)
  }
  let polls = 0
  const c = client({
    ...connectAnswers, 'omni-github-install': job(running),
    'omni-github-status': () => {
      if (++polls <= 4 || (polls >= 6 && polls <= 9)) throw new Error('Status unavailable.')
      return job(polls === 5 ? running : done)
    },
  })
  assert.equal(await c.github(), 'linked')
  assert.equal(polls, 10)
})

test('connect stops at its deadline for misses, thrown errors, or a stalled discovery', async () => {
  for (const stalled of [false, true]) {
    let clock = 0
    let misses = 0
    const c = client({
      'omni-github-install': job(done),
      'omni-discover': () => {
        if (stalled) return deferred().promise
        if (++misses === 1) throw new Error('Discovery unavailable.')
        return { omnis: [] }
      },
    })
    const flow = stalled
      ? { connectMs: 15, now: () => 0 }
      : { now: () => clock, connectMs: 10, connectPoll: 5, wait: async ms => { clock += ms } }
    assert.equal(await c.github(flow), 'failed')
    assert.equal(c.last()[1].message, `Omni is installed but did not answer at ${base}. Power Omni on to try again.`)
    assert.deepEqual(c.names(), [
      'omni-github-install', 'omni-discover', ...(!stalled ? ['omni-discover'] : []),
    ])
  }
})

test('a missing or invalid address fails live and resumed connects before discovery or claim', async () => {
  for (const report of [null, { ...done.report, apiUrl: 'ftp://localhost:18882/api/v2/' }]) {
    for (const resume of [false, true]) {
      const jobView = { ...done, report }
      const c = client({ 'omni-github-install': job(jobView), 'omni-link': { linked: false } })
      assert.equal(await c.github(resume ? { resume: jobView } : {}), 'failed')
      assert.equal(c.last()[1].message, 'Omni is installed, but its address is unknown. Power Omni on to try again.')
      assert.deepEqual(c.names(), [resume ? 'omni-link' : 'omni-github-install'])
    }
  }
})

test('winning the claim allows discover-use to return pairing or show its failure verbatim', async () => {
  const pairing = { code: 'ABCD' }
  for (const answer of [{ pairing }, { message: 'Pairing was refused.' }, () => { throw new Error('Pairing was refused.') }]) {
    const c = client({ ...connectAnswers, 'omni-github-install': job(done), 'omni-discover-use': answer })
    assert.equal(await c.github(), answer.pairing ? 'pairing' : 'failed')
    assert.equal(c.last()[1].pairing?.code ?? c.last()[1].message, answer.pairing ? 'ABCD' : 'Pairing was refused.')
    assert.deepEqual(c.requests.slice(1), [
      ['omni-discover', null], ['omni-link', null], ['omni-github-ack', { id }], ['omni-discover-use', { id: sandbox.id }],
    ])
  }
})

test('a lost claim polls only the link until the other card connects or the deadline passes', async () => {
  for (const connects of [true, false]) {
    let clock = 0
    const waits = []
    const c = client({
      ...connectAnswers, 'omni-github-install': job(done),
      'omni-github-ack': claim({ ...done, acknowledged: true }, false),
      'omni-link': () => connects && clock >= 10 ? { configured: true, origin: base } : { linked: false },
    })
    assert.equal(await c.github({
      now: () => clock, connectMs: 15, connectPoll: 5, wait: async ms => { waits.push(ms); clock += ms },
    }), connects ? 'linked' : 'failed')
    assert.deepEqual(c.requests.slice(1), [
      ['omni-discover', null], ['omni-link', null], ['omni-github-ack', { id }], ['omni-link', null], ['omni-link', null],
    ])
    assert.deepEqual(waits, connects ? [5, 5] : [5, 5, 5])
    if (connects) assert.deepEqual(c.last(), ['linked', { origin: base }])
    else assert.equal(c.last()[1].message, `Omni is installed but did not answer at ${base}. Power Omni on to try again.`)
  }
})

test('a link chosen before the claim wins over the discovered sandbox', async () => {
  const origin = 'https://my.omni.example'
  for (const flag of ['linked', 'configured']) {
    const c = client({
      'omni-github-install': job(done), 'omni-discover': connectAnswers['omni-discover'], 'omni-link': { [flag]: true, origin },
    })
    assert.equal(await c.github(), 'linked')
    assert.deepEqual(c.last(), ['linked', { origin }])
    assert.deepEqual(c.names(), ['omni-github-install', 'omni-discover', 'omni-link'])
  }
})

test('a refused claim shows the host message without using the discovery entry', async () => {
  const message = 'This view is read-only.'
  const c = client({
    ...connectAnswers, 'omni-github-install': job(done),
    'omni-github-ack': () => { throw new Error(message) },
  })
  assert.equal(await c.github(), 'failed')
  assert.deepEqual(c.last(), ['failed', { message }])
  assert.deepEqual(c.names(), ['omni-github-install', 'omni-discover', 'omni-link', 'omni-github-ack'])
})

test('power off before the install reply cancels the returned ID once and acknowledges the finished job', async () => {
  const install = deferred()
  const c = client({
    'omni-github-install': () => install.promise,
    'omni-github-cancel': job({ ...running, phase: 'cancelled' }),
    'omni-github-ack': claim({ ...running, phase: 'cancelled' }, false),
  })
  let run
  c.ui.runPower('omni', args => (run = c.github(args)))
  assert.equal(c.ui.powerOf('omni').detail.job, null)
  c.ui.powerOff('omni', undefined, c.request, c.request)
  install.resolve(job(running))
  await assert.rejects(run, { name: 'AbortError' })
  await settle()
  assert.deepEqual(c.requests, [
    ['omni-github-install', { version: V, reason: 'behind' }],
    ['omni-github-cancel', { id }], ['omni-github-ack', { id }],
  ])
  assert.deepEqual(plain(c.ui.powerOf('omni')), { phase: 'asleep', detail: { removed: true } })
})

test('power off during status cancels by ID, and power off during connect only acknowledges', async () => {
  for (const connecting of [false, true]) {
    const pending = deferred()
    const c = client({
      'omni-github-install': job(connecting ? done : running),
      'omni-github-status': () => pending.promise,
      'omni-discover': () => pending.promise,
      'omni-github-cancel': job(done),
      'omni-github-ack': connectAnswers['omni-github-ack'],
    })
    let run
    c.ui.runPower('omni', args => (run = c.github(args)))
    await settle()
    assert.equal(c.ui.powerOf('omni').detail.step, connecting ? 'connect' : running.step)
    c.ui.powerOff('omni', undefined, c.request, c.request)
    pending.resolve(connecting ? { omnis: [sandbox] } : job(done))
    await assert.rejects(run, { name: 'AbortError' })
    await settle()
    assert.deepEqual(c.requests.slice(1), connecting
      ? [['omni-discover', null], ['omni-github-ack', { id }]]
      : [['omni-github-status', { id }], ['omni-github-cancel', { id }], ['omni-github-ack', { id }]])
  }
})

test('power off acknowledges a finished job during link lookup and does not acknowledge twice after a failed connect', async () => {
  const link = deferred()
  const c = client({
    'omni-plugins': { ready: true, server: done }, 'omni-link': () => link.promise,
    'omni-github-ack': connectAnswers['omni-github-ack'],
  })
  let run
  c.ui.runPower('omni', args => (run = c.ui.powerOn({ ...c.options, ...args, quick: true })))
  await settle()
  c.ui.powerOff('omni', undefined, c.request, c.request)
  link.resolve({ linked: false })
  await assert.rejects(run, { name: 'AbortError' })
  assert.deepEqual(c.requests, [['omni-plugins', null], ['omni-link', null], ['omni-github-ack', { id }]])

  const failed = client({
    ...connectAnswers, 'omni-github-install': job(done), 'omni-discover-use': { message: 'Pairing was refused.' },
  })
  failed.ui.runPower('omni', args => (run = failed.github(args)))
  assert.equal(await run, 'failed')
  failed.ui.powerOff('omni', undefined, failed.request, failed.request)
  assert.deepEqual(failed.requests.filter(([name]) => name === 'omni-github-ack'), [['omni-github-ack', { id }]])
})

test('power off while claiming stops the connect without a second claim or a use', async () => {
  const pending = deferred()
  const c = client({ ...connectAnswers, 'omni-github-install': job(done), 'omni-github-ack': () => pending.promise })
  let run
  c.ui.runPower('omni', args => (run = c.github(args)))
  await settle()
  c.ui.powerOff('omni', undefined, c.request, c.request)
  pending.resolve(claim(done))
  await assert.rejects(run, { name: 'AbortError' })
  assert.deepEqual(c.names(), ['omni-github-install', 'omni-discover', 'omni-link', 'omni-github-ack'])
})

test('a cancellation request replaces the source note while running and leaves the final outcome to the host', async () => {
  for (const outcome of [done, { ...running, phase: 'failed', error: 'Install failed.' }, { ...running, phase: 'cancelled' }]) {
    const c = client({
      ...connectAnswers, 'omni-github-install': job(running),
      'omni-github-status': (() => {
        const replies = [{ ...running, step: 'install', cancelRequested: true }, { ...outcome, cancelRequested: true }]
        return () => job(replies.shift())
      })(),
    })
    assert.equal(await c.github(), outcome === done ? 'linked' : 'failed')
    const [, detail] = c.shown.find(([, detail]) => detail?.phase === 'running' && detail.cancelRequested)
    assert.equal(c.ui.statusOf('sandbox', detail), `Installing Omni ${P}…`)
    assert.deepEqual(paragraphs(inside(c.ui, 'sandbox', detail)), [
      `npm's newest Omni is ${V}, older than Omni ${P}, which this Automagik installs.`, 'Stopping after this step…',
    ])
    if (outcome !== done) assert.equal(c.last()[1].message, outcome.error ?? 'The install was cancelled.')
    else assert.equal(paragraphs(inside(c.ui, ...c.shown.at(-2)))[1], `Installing Omni ${P} from GitHub instead.`)
  }
})

test('power off closes a late terminal open reply and sends Ctrl-C to a running terminal without installing from GitHub', async () => {
  for (const duringOpen of [false, true]) {
    const pending = deferred()
    const c = client({
      ...terminalAnswers,
      'omni-terminal-open': duringOpen ? () => pending.promise : terminalAnswers['omni-terminal-open'],
      'omni-terminal-read': () => pending.promise,
    })
    let run
    c.ui.runPower('omni', args => (run = c.ui.sandboxInstall({
      ...c.options, ...args, check: async () => ({ ok: true, fallback }),
    })))
    await settle()
    assert.equal(c.ui.powerOf('omni').detail.terminal, duringOpen ? null : terminal)
    assert.equal(c.ui.resumeServer({ server: running }), null)
    c.ui.powerOff('omni', undefined, c.request, c.request)
    pending.resolve(duringOpen ? terminalAnswers['omni-terminal-open'] : { state: 'exited', exitCode: 1 })
    await assert.rejects(run, { name: 'AbortError' })
    assert.deepEqual(c.requests.slice(1), duringOpen
      ? [['omni-terminal-close', { terminal }]]
      : [['omni-terminal-write', { terminal, data: '\r' }], ['omni-terminal-read', { terminal, from: 0 }], ['omni-terminal-write', { terminal, data: '\x03' }]])
  }
})

test('power on resumes running and done jobs and rechecks the link before claiming a matching discovery', async () => {
  for (const [server, link, expected] of [
    [running, { linked: false }, ['omni-github-status', 'omni-discover', 'omni-link', 'omni-github-ack', 'omni-discover-use']],
    [done, { linked: false }, ['omni-link', 'omni-discover', 'omni-link', 'omni-github-ack', 'omni-discover-use']],
    [done, { linked: true, origin: base }, ['omni-link', 'omni-github-ack']],
    [done, { configured: true, origin: base }, ['omni-link', 'omni-github-ack']],
  ]) {
    const c = client({
      ...connectAnswers, 'omni-plugins': { ready: true, server },
      'omni-github-status': job(done), 'omni-link': link,
    })
    assert.equal(await c.power(), 'linked')
    assert.deepEqual(c.names(), ['omni-plugins', ...expected])
    assert.deepEqual(c.last(), ['linked', { origin: base }])
  }
})

test('passive done checks link state first, acknowledges a linked job, and leaves an unknown link alone', async () => {
  for (const link of [{ configured: true }, () => { throw new Error('Link state unavailable.') }]) {
    const c = client({ 'omni-link': link, 'omni-github-ack': connectAnswers['omni-github-ack'] })
    let completed
    const run = c.ui.resumeServer({ server: done }, (kind, resume) => {
      assert.equal(kind, 'omni')
      completed = resume(c.options)
      return completed
    })
    assert.equal(run, completed)
    assert.equal(await run, link.configured ? 'linked' : 'asleep')
    assert.deepEqual(c.names(), link.configured ? ['omni-link', 'omni-github-ack'] : ['omni-link'])
  }
})

test('null, absent and acknowledged jobs leave the older power-on sequence exactly as it was', async () => {
  for (const server of [{ server: null }, {}, { server: { ...done, acknowledged: true } }]) {
    const c = client({ 'omni-plugins': { ready: true, ...server }, 'omni-link': { linked: false }, 'omni-discover': { omnis: [sandbox] } })
    assert.equal(await c.power(), 'found')
    assert.deepEqual(c.names(), ['omni-plugins', 'omni-link', 'omni-discover'])
  }
})

function registerApps(c, ask, start) {
  let entry
  const officialInstall = {
    register(value) {
      entry = value
      return () => {}
    },
  }
  const stop = kind => c.ui.powerOff(kind, undefined, c.request, c.request)
  const dispose = c.ui.installOfficialInstall(() => ({ omni: { officialInstall } }), { ask, start, stop })
  return { entry, dispose }
}

test('Apps refresh follows a running job once, reports step and failure text, and sends only its two reads', async () => {
  const status = deferred()
  const c = client({ 'omni-github-status': () => status.promise })
  const reads = []
  let starts = 0
  const { entry, dispose } = registerApps(c, async endpoint => {
    reads.push(endpoint)
    return endpoint === 'omni-plugins' ? { ready: true, server: { ...running, step: 'check' } } : { ready: true }
  }, (kind, run) => {
    starts += 1
    return c.ui.startPower(kind, args => run({ ...c.options, ...args }))
  })
  try {
    await entry.refresh()
    await entry.refresh()
    assert.deepEqual(reads, ['omni-plugins', 'genie-plugin', 'omni-plugins', 'genie-plugin'])
    assert.equal(starts, 1)
    assert.deepEqual(c.requests, [['omni-github-status', { id }]])
    const ctx = { roster: { bots: [] }, actions: {} }
    assert.equal(entry.row('omni', ctx).text, `Checking Omni ${P}…`)
    const { detail } = c.ui.powerOf('omni')
    for (const [step, text] of [['build', `Building Omni ${P}…`], ['connect', 'Connecting to your Omni…']]) {
      c.ui.showPower('omni', 'sandbox', { ...detail, step })
      assert.equal(entry.row('omni', ctx).text, text)
    }
    status.resolve(job({ ...running, phase: 'failed', error: 'Build failed.' }))
    await settle()
    assert.equal(entry.row('omni', ctx).text, 'Could not install Omni')
    assert.equal(entry.row('omni', ctx).alert, 'Build failed.')
  } finally {
    dispose()
    c.ui.resetPower()
  }
})

test('Apps follows running to asleep, ignores unclaimed done on refresh, and connects on a power press', async () => {
  const status = deferred()
  const c = client({
    ...connectAnswers, 'omni-github-status': () => status.promise, 'omni-plugins': { ready: true, server: done },
  })
  const reads = []
  let server = running
  let starts = 0
  const { entry, dispose } = registerApps(c, async endpoint => {
    reads.push(endpoint)
    return endpoint === 'omni-plugins' ? { ready: true, server } : { ready: true }
  }, (kind, run) => {
    starts += 1
    return c.ui.startPower(kind, args => run({ ...c.options, ...args, quick: true }))
  })
  try {
    await entry.refresh()
    assert.deepEqual(reads, ['omni-plugins', 'genie-plugin'])
    assert.deepEqual(c.requests, [['omni-github-status', { id }]])
    status.resolve(job(done))
    await settle()
    assert.deepEqual(plain(c.ui.powerOf('omni')), { phase: 'asleep', detail: null })
    assert.deepEqual(c.requests, [['omni-github-status', { id }]])

    server = done
    await entry.refresh()
    assert.deepEqual(reads, ['omni-plugins', 'genie-plugin', 'omni-plugins', 'genie-plugin'])
    assert.equal(starts, 1)
    assert.deepEqual(c.requests, [['omni-github-status', { id }]])
    const ctx = { roster: { bots: [] }, actions: {} }
    assert.equal(entry.row('omni', ctx).label, 'Power Omni on')
    assert.ok(entry.act('omni', ctx))
    await settle()
    assert.equal(c.ui.powerOf('omni').phase, 'linked')
    assert.deepEqual(c.names(), ['omni-github-status', 'omni-plugins', 'omni-link', 'omni-discover', 'omni-link', 'omni-github-ack', 'omni-discover-use'])
  } finally {
    dispose()
    c.ui.resetPower()
  }
})

test('Apps power off explicitly cancels the followed job and shows a cancel refusal verbatim', async () => {
  for (const refused of [false, true]) {
    const status = deferred()
    const message = 'This view is read-only.'
    const c = client({
      'omni-github-status': () => status.promise,
      'omni-github-cancel': () => {
        if (refused) throw new Error(message)
        return job({ ...running, step: 'install', cancelRequested: true })
      },
    })
    const { entry, dispose } = registerApps(c, async endpoint => (
      endpoint === 'omni-plugins' ? { ready: true, server: running } : { ready: true }
    ), (kind, run) => c.ui.startPower(kind, args => run({ ...c.options, ...args })))
    try {
      await entry.refresh()
      const ctx = { roster: { bots: [] }, actions: {} }
      assert.equal(entry.row('omni', ctx).label, 'Power Omni off')
      assert.equal(entry.row('omni', { ...ctx, roster: { readOnly: true } }).action, null)
      entry.act('omni', ctx)
      status.resolve(job(done))
      await settle()
      assert.deepEqual(c.requests, [['omni-github-status', { id }], ['omni-github-cancel', { id }]])
      assert.equal(c.ui.powerOf('omni').phase, refused ? 'failed' : 'asleep')
      assert.equal(entry.row('omni', ctx).alert, refused ? message : null)
    } finally {
      dispose()
      c.ui.resetPower()
    }
  }
})

test('Apps plugin resume also leaves server connection to a power press', async () => {
  for (const server of [running, done]) {
    const c = client({ 'omni-plugins': { ready: true, server }, 'omni-github-status': job(done) })
    const { entry, dispose } = registerApps(c, async endpoint => endpoint === 'omni-plugins'
      ? { ready: false, install: { phase: 'installing' } }
      : { ready: true }, (kind, run) => c.ui.startPower(kind, args => run({ ...c.options, ...args, quick: true })))
    try {
      await entry.refresh()
      await settle()
      assert.deepEqual(plain(c.ui.powerOf('omni')), { phase: 'asleep', detail: null })
      assert.deepEqual(c.names(), server === running ? ['omni-plugins', 'omni-github-status'] : ['omni-plugins'])
    } finally {
      dispose()
      c.ui.resetPower()
    }
  }
})

test('Apps ignores a refresh returned after Remove, acknowledged and failed jobs, and concurrent plugin installs', async () => {
  const delayed = deferred()
  const c = client()
  const start = () => assert.fail('started a passive install')
  const { entry, dispose } = registerApps(c, async endpoint => endpoint === 'omni-plugins' ? delayed.promise : {}, start)
  try {
    const refresh = entry.refresh()
    c.ui.powerOff('omni')
    delayed.resolve({ ready: true, server: running })
    await refresh
    assert.deepEqual(c.requests, [])
  } finally {
    dispose()
    c.ui.resetPower()
  }
  for (const server of [{ ...done, acknowledged: true }, { ...running, phase: 'failed' }, { ...running, phase: 'cancelled' }, null]) {
    assert.equal(c.ui.resumeServer({ server }, start), null)
  }
  assert.equal(c.ui.resumeServer({ server: running, install: { phase: 'installing' } }, start), null)
})

test('explicit team mount and Omni preload each read plugins once and resume the server', async () => {
  for (const explicit of [true, false]) {
    const c = client({
      state: { preload: 'omni' }, 'bot-type': {}, 'omni-overview': {},
      'genie-plugin': {}, 'unfold-plugin': {},
      'omni-plugins': { ready: true, server: running },
    })
    const view = c.mount({ explicit })
    view.render()
    await settle()
    assert.ok(view.render())
    await settle()
    assert.equal(c.ui.powerOf('omni').detail.job, id)
    assert.deepEqual(c.names().filter(endpoint => endpoint.startsWith('omni-') && endpoint !== 'omni-overview'), ['omni-plugins'])
    c.ui.resetPower()
  }
})

async function clickInstallTile(answers) {
  const c = client({
    ...terminalAnswers, state: { preload: null }, 'bot-type': {}, 'omni-overview': {},
    'genie-plugin': {}, 'unfold-plugin': {}, 'omni-plugins': { ready: true }, ...answers,
  })
  c.ui.showPower('omni', 'none')
  const view = c.mount({ explicit: true })
  view.render()
  await settle()
  const [card] = findAll(view.render(), node => node.type === c.ui.OmniCard)
  const [box] = findAll(card.type(card.props), node => node.type === c.ui.Machine)
  const [inner] = findAll(box.type(box.props), node => node.type.name === 'Inside')
  const choice = inner.type(inner.props)
  const [tile] = findAll(choice.type(choice.props), node => node.type === 'button' && node.children.some(child => child?.children?.includes('Install Omni here')))
  tile.props.onClick()
  await settle()
  return c
}

test('the real Install Omni tile sends the fallback capability with the terminal version', async () => {
  const c = await clickInstallTile({ 'omni-server-check': { ok: false, reason: 'no-systemd' } })
  assert.deepEqual(c.requests.slice(-3), [
    ['omni-terminal-open', { kind: 'install', cols: 72, rows: 8 }],
    ['omni-server-check', { version: V, fallback: true }], ['omni-terminal-close', { terminal }],
  ])
})

test('an older host rejecting the fallback field gets one legacy check and its refusal prevents Enter', async () => {
  const c = await clickInstallTile({
    'omni-server-check': payload => {
      if (payload.fallback) throw Object.assign(new Error('Unknown field.'), { code: 'omni-ai/invalid' })
      return { ok: false, reason: 'unpublished', npm: V }
    },
  })
  assert.deepEqual(c.requests.slice(c.names().indexOf('omni-terminal-open')), [
    ['omni-terminal-open', { kind: 'install', cols: 72, rows: 8 }],
    ['omni-server-check', { version: V, fallback: true }], ['omni-server-check', { version: V }], ['omni-terminal-close', { terminal }],
  ])
  assert.equal(c.ui.powerOf('omni').phase, 'failed')
  assert.match(c.ui.powerOf('omni').detail.message, /is not on npm/)
})

test('the local install tile appears for unreachable sandbox leftovers and hides for a reachable sandbox', () => {
  const { ui } = client()
  const unreachable = { ...sandbox, reachable: false }
  assert.ok(ui.destinyOf([unreachable]).tiles.some(tile => tile.id === 'local' && tile.title === 'Install Omni here'))
  assert.ok(!ui.destinyOf([unreachable, sandbox]).tiles.some(tile => tile.id === 'local'))
})

const statusWords = [
  ['check', 'github', `Checking Omni ${P}…`, `Verificando o Omni ${P}…`],
  ['download', 'github', `Downloading Omni ${P} from GitHub…`, `Baixando o Omni ${P} do GitHub…`],
  ['build', 'github', `Building Omni ${P}…`, `Compilando o Omni ${P}…`],
  ['install', 'npm', `Installing Omni ${P} from npm…`, `Instalando o Omni ${P} pelo npm…`],
  ['install', 'github', `Installing Omni ${P}…`, `Instalando o Omni ${P}…`],
  ['connect', 'github', 'Connecting to your Omni…', 'Conectando ao seu Omni…'],
  [null, 'github', 'Setting up your Omni…', 'Configurando seu Omni…'],
]

test('sandbox status uses the release version and each step and source has its own words', () => {
  const c = client()
  for (const [step, source, english] of statusWords) {
    const detail = { job: id, step, source, release: running.release, npm }
    assert.equal(c.ui.statusOf('sandbox', detail), english)
    assert.equal(c.ui.workingText('omni', 'sandbox', detail), english)
  }
  assert.equal(c.ui.statusOf('sandbox', { job: null, step: 'check', npm }), `Checking Omni ${V}…`)
  assert.equal(c.ui.statusOf('sandbox', { step: 'download-bun' }), 'Downloading Bun for Omni…')
})

test('all job words and aria labels render through both Portuguese locale IDs', () => {
  const c = client()
  const locale = fakeLocale()
  locale.addLanguage({ id: 'pt', fallback: 'en' })
  locale.addLanguage({ id: 'pt-BR', fallback: 'pt' })
  const uninstall = c.ui.installLocale(locale)
  const detail = { ...running, job: id, steps: running.steps.map(step => ({ ...step, state: 'done' })) }
  try {
    for (const language of ['pt-BR', 'pt']) {
      locale.setLocale(language)
      for (const [step, source, , portuguese] of statusWords) {
        assert.equal(c.ui.statusOf('sandbox', { ...detail, step, source }), portuguese)
      }
      const tree = inside(c.ui, 'sandbox', detail)
      assert.deepEqual(stepsOf(tree).map(([label]) => label), ['Verificar', 'Baixar', 'Compilar', 'Instalar', 'Conectar'])
      const [list] = findAll(tree, node => node.type === 'ol')
      assert.equal(list.props['aria-label'], 'As etapas da instalação')
      assert.equal(logOf(tree), undefined)
      const failedWith = source => inside(c.ui, 'failed', { message: 'x', log: 'printed', github: { ...detail, source } })
      assert.equal(logOf(failedWith('github')).label, 'A saída da instalação pelo GitHub')
      assert.equal(logOf(failedWith('npm')).label, 'A saída do instalador do Omni')
      assert.equal(paragraphs(inside(c.ui, 'sandbox', { ...detail, cancelRequested: true }))[1], 'Parando após esta etapa…')
      for (const [key, params] of [
        ["npm's newest Omni is {npm}, older than Omni {version}, which this Automagik installs.", { npm: V, version: P }],
        ['Omni {version} is not on npm (the newest there is {npm}).', { version: V, npm: P }],
        ['Installing Omni from npm failed (exit code {code}).', { code: 1 }],
        ['Installing Omni from npm failed.'],
        ["Omni's npm installer needs systemd, and this computer has none."],
        ['Installing Omni {version} from GitHub instead.', { version: P }],
        ['Installing Omni from GitHub instead.'],
        ['Installing Omni {version} from npm.', { version: V }],
        ['npm could not install it either. Installing Omni {version} from GitHub instead.', { version: P }],
        ['It stopped at the {step} step.', { step: 'Compilar' }],
        ['Power Omni on to try again.'],
        ['Update Automagik, then power Omni on again.'],
        ['Use an Omni on another computer.'],
        ["The install's progress was lost (Automagik may have restarted). Power Omni on to try again."],
        ['Omni could not be installed from GitHub.'],
        ['Omni is installed, but its address is unknown. Power Omni on to try again.'],
        ['Omni is installed but did not answer at {url}. Power Omni on to try again.', { url: base }],
      ]) {
        const translated = c.ui.t(key, params)
        const english = key.replace(/\{(\w+)\}/g, (_, name) => params[name])
        assert.notEqual(translated, english, key)
        assert.doesNotMatch(translated, /\{\w+\}/, key)
      }
    }
  } finally {
    uninstall()
  }
})
