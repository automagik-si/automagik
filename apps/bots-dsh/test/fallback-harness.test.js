import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { format } from 'node:util'
import { DICTIONARY } from '../src/client/i18n.js'
import { install } from '../src/host/fallback.js'

const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' }
const OPENAI = { provider: 'openai', model: 'gpt-5.4-mini' }
const CODEX = { provider: 'acp-codex', model: 'default' }
const CODEX_FALLBACK = { provider: 'acp-codex', model: 'gpt-5' }
const HARNESS_TEXT = 'The model failed and no other model answered in its place: the fallback model runs on another harness, and a conversation never changes harness. Try again, fix or sign in to the model, or start a new conversation on another model.'

function bench({ header, fallback = DEEPSEEK, own = header, wait = false }) {
  const hooks = new Map()
  const calls = { selected: [], followed: [], appended: [], warnings: [] }
  const idle = Promise.withResolvers()
  const rt = {
    ctx: { on: (name, listener) => hooks.set(name, listener) },
    config: { fallbackModel: `${fallback.provider}/${fallback.model}` },
    isBotSession: () => true,
    warn: (...args) => calls.warnings.push(format(...args)),
  }
  install(rt)
  const agent = {
    id: 'bot-1',
    model: {
      current: () => own,
      select: route => { calls.selected.push(route); own = route },
    },
    followup: message => calls.followed.push(message),
    session: {
      id: 'session-1',
      requestHeader: () => ({ config: header }),
      append: (type, { content, source }, options) => calls.appended.push({ type, content, source, options }),
    },
    ...(wait ? { whenIdle: () => idle.promise } : {}),
  }
  return {
    agent, calls,
    failed: () => hooks.get('agent/request-error')({ agent, turn: 3, failure: { code: 'SERVER' } }, async () => undefined),
    armed: () => rt.fallbackArmed(agent.session.id),
    turnEnd: () => hooks.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 4 } }),
    preStep: (payload, next) => hooks.get('agent/pre-step')(payload, next),
    setCurrent: route => { own = route },
    idle: idle.resolve,
  }
}

for (const header of [CODEX, { provider: 'acp-claude', model: 'default' }, { provider: 'acp-gemini', model: 'default' }, { provider: 'claude-code', model: 'opus' }]) {
  const ref = `${header.provider}/${header.model}`
  test(`${ref} cannot fall back to DeepSeek across harnesses`, async () => {
    const b = bench({ header })
    await b.failed()
    b.setCurrent(DEEPSEEK)
    const armed = b.armed()
    b.turnEnd()
    assert.deepEqual({ ...b.calls, armed }, {
      selected: [], followed: [], armed: false,
      warnings: [`ds-bot: bot-1 failed on ${ref} (SERVER); the fallback on deepseek-official/deepseek-flash runs on another harness`],
      appended: [{
        type: 'user/message', content: [{ type: 'text', text: HARNESS_TEXT }], options: { surfaceOp: 'append' },
        source: { kind: 'model-selection', form: 'notice', summary: `${ref} failed; the fallback runs on another harness` },
      }],
    })
  })
}

test('native and ACP fallback models can take over on the same harness', async () => {
  const native = bench({ header: OPENAI })
  const acp = bench({ header: CODEX, fallback: CODEX_FALLBACK })
  const crossing = bench({ header: CODEX, fallback: { provider: 'acp-claude', model: 'default' } })
  const results = []
  for (const b of [native, acp, crossing]) {
    await b.failed()
    results.push([b.calls.selected, b.calls.followed.length, b.calls.appended.length, b.armed()])
  }
  assert.deepEqual(results, [[[DEEPSEEK], 1, 0, true], [[CODEX_FALLBACK], 1, 0, true], [[], 0, 1, false]])
})

test('an intervening selection on another harness is kept without a notice', async () => {
  const b = bench({ header: OPENAI, own: CODEX })
  await b.failed()
  const armed = b.armed()
  b.turnEnd()
  assert.deepEqual({ ...b.calls, armed, current: b.agent.model.current() }, {
    selected: [], followed: [], appended: [], warnings: [], armed: false, current: CODEX,
  })
})

for (const wait of [true, false]) {
  test(`a changed model cancels the ${wait ? 'idle' : 'direct'} fallback wake and restore`, async () => {
    const b = bench({ header: OPENAI, wait })
    if (!wait) b.agent.model.select = route => { b.calls.selected.push(route); b.setCurrent(CODEX) }
    await b.failed()
    if (wait) {
      b.setCurrent(CODEX)
      b.idle()
      await new Promise(resolve => setImmediate(resolve))
    }
    const armed = b.armed()
    // A later pick of the same fallback must never trigger the abandoned restore.
    b.setCurrent(DEEPSEEK)
    b.turnEnd()
    assert.deepEqual({ selected: b.calls.selected, followed: b.calls.followed, armed, warning: b.calls.warnings.at(-1) }, {
      selected: [DEEPSEEK], followed: [], armed: false,
      warning: 'ds-bot: the fallback turn was not woken: the model changed',
    })
  })
}

test('the harness notice text is available in Chinese and Brazilian Portuguese', async () => {
  const b = bench({ header: CODEX })
  await b.failed()
  const text = b.calls.appended[0]?.content[0]?.text
  const ptBR = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  assert.deepEqual([DICTIONARY.zh[text], ptBR[text]].map(wording => typeof wording === 'string' && wording !== text), [true, true])
})

test('a carried local CLI cannot fall back to a DSH model, although both file under DSH', async () => {
  const local = { provider: 'local-codex-cli', model: 'default' }
  const b = bench({ header: local })
  await b.failed()
  assert.deepEqual([b.calls.selected, b.calls.followed, b.armed(), b.calls.appended.map(entry => entry.source.summary)],
    [[], [], false, ['local-codex-cli/default failed; the fallback runs on another harness']])
  const same = bench({ header: local, fallback: { provider: 'local-codex-cli', model: 'gpt-5' } })
  await same.failed()
  assert.deepEqual(same.calls.selected, [{ provider: 'local-codex-cli', model: 'gpt-5' }], 'another model of the same local CLI is taken')
})

for (const [label, selection, kept] of [['another harness', CODEX, false], ['the same harness', OPENAI, true]]) {
  test(`a fallback notice claimed by a step fixed on ${label} ${kept ? 'stays' : 'leaves the step'}`, async () => {
    const b = bench({ header: OPENAI })
    await b.failed()
    assert.equal(b.calls.followed.length, 1)
    const notice = b.calls.followed[0]
    const other = { id: 'm-person', role: 'user', content: [{ type: 'text', text: 'hello' }] }
    const payload = { agent: b.agent, messages: [notice, other], modelSelection: selection }
    let passed = false // selected counts the fallback, then the restore when the fallback stays
    await b.preStep(payload, async () => { passed = true })
    const armed = b.armed()
    b.setCurrent(DEEPSEEK)
    b.turnEnd()
    assert.deepEqual({ ids: payload.messages.map(message => message.id), passed, armed, restored: b.calls.selected.length },
      { ids: kept ? [notice.id, 'm-person'] : ['m-person'], passed: true, armed: kept, restored: kept ? 2 : 1 })
  })
}
