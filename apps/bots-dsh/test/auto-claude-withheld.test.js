import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const WRITE = 'workspace-write'
const CLAUDE = 'acp-claude'
const CODEX = 'acp-codex'
const botOf = (id, name, provider) => ({ id, name, role: '', instructions: '', createdAt: 1, model: `${provider}/default`, appliedModel: `${provider}/default` })

test('withdrawing Claude Auto stops judging and inheritance and clears its saved mark', async t => {
  const home = mkdtempSync(join(tmpdir(), 'bot-claude-withheld-'))
  const path = join(home, 'state.json')
  writeFileSync(path, JSON.stringify({
    version: 1, mainBotIds: ['m1'], revision: 1,
    bots: { m1: botOf('m1', 'Claude', CLAUDE), b2: botOf('b2', 'Codex', CODEX), b3: botOf('b3', 'Fresh Claude', CLAUDE) },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const disk = () => JSON.parse(readFileSync(path, 'utf8')).bots
  const ended = []
  let answer
  const acpAgents = {
    ownMode: fn => { answer = fn; return () => { answer = undefined } },
    ownModeOf: provider => ({ mode: provider === CODEX ? 'agent' : 'auto', bridged: true, answerer: true }),
    ownModeIn: () => true,
    endSession: id => { ended.push(id) },
  }
  const levels = new Map()
  const permissionPresets = {
    catalog: () => ({ options: [{ value: WRITE, name: 'Workspace' }], defaultPreset: WRITE }),
    resolve: name => name === WRITE ? { sandbox: WRITE, approval: 'ask' } : undefined,
    current: session => levels.get(session.id),
    set: (session, name) => levels.set(session.id, name),
  }
  const ctx = fakeContext({ services: { acpAgents, permissionPresets } })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const events = [{ type: 'tool/call', data: { callId: 'x', name: 'bash', arguments: '{"command":"ls"}' } }]
  const sessions = new Map([['m1', CLAUDE], ['b2', CODEX]].map(([id, provider]) => [id, {
    id, requestHeader: () => ({ config: { provider, model: 'default' } }), snapshotEvents: () => events,
  }]))
  let modelCalls = 0
  Object.assign(ctx, {
    sessions: { list: () => [...sessions.values()], flush: async () => {} },
    sessionController: { resolveAgent: async id => ({ agent: { session: sessions.get(id) } }) },
    llm: {
      ...ctx.llm,
      resolveModelInfo: async () => ({}),
      async* stream() {
        modelCalls++
        yield { type: 'text-delta', index: 0, text: '{"decision":"allow","reason":"needed"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  rt.cachedBackground = () => 'deepseek/v4'
  rt.backgroundModel = async () => 'deepseek/v4'

  assert.equal(rt.autoOffer(rt.botOf('m1')).offered, true)
  await rt.setBotAuto('m1', 0)
  await rt.setBotAuto('b2', 0)
  const bot = rt.botOf('m1')
  const codex = rt.botOf('b2')
  const fresh = rt.botOf('b3')
  assert.equal(rt.autoOffer(fresh).offered, true)
  const session = sessions.get(rt.chatOf('m1'))
  const agent = { id: session.id, session }
  const askOwnMode = () => answer({ sessionId: session.id, agent, provider: CLAUDE })
  const opener = () => rt.inToolCall({ name: 'start_task', agent }, () => rt.autoOpener())
  const approve = person => {
    const request = { agent, callId: 'x', toolName: 'bash', reason: 'Run ls', bridgeCall: { agentAsked: false } }
    const hooks = [...ctx.listeners.get('approval/request')].reverse()
    const next = i => () => (i < hooks.length ? hooks[i](request, next(i + 1)) : person())
    return next(0)()
  }
  assert.equal(disk().m1.permissionAuto, CLAUDE)
  const rev = bot.permissionRev
  assert.equal(askOwnMode(), true)
  assert.equal(rt.autoCounts(session), true)
  assert.deepEqual(await opener(), { route: CLAUDE, rev, botId: bot.id })
  const person = t.mock.fn(() => 'rejected')
  assert.equal(await approve(person), 'allowed-once')
  assert.equal(person.mock.callCount(), 0)
  assert.equal(modelCalls, 1)

  acpAgents.ownModeOf = provider => provider === CODEX ? { mode: 'agent', bridged: true, answerer: true } : undefined
  assert.equal(bot.permissionAuto, CLAUDE)
  assert.equal(rt.autoViewOf(bot).permissionFallback, WRITE)
  assert.deepEqual(rt.autoFactsOf(session.id, session), { counts: false, why: 'agent', by: 'claude' })
  assert.equal(rt.autoCounts(session), false)
  assert.equal(askOwnMode(), false)
  assert.equal(await opener(), undefined)
  assert.equal(await approve(person), 'rejected')
  assert.equal(person.mock.callCount(), 1)
  assert.equal(modelCalls, 1)
  assert.equal(rt.autoOffer(codex).offered, true)
  assert.equal(rt.autoCounts(sessions.get(rt.chatOf(codex.id))), true)

  acpAgents.ownModeOf = undefined
  assert.equal(rt.autoWhy(bot, { sessionId: session.id, session, route: bot.appliedModel }), 'agent')
  const get = ctx.get
  ctx.get = name => name === 'acpAgents' ? undefined : get(name)
  assert.equal(rt.autoWhy(bot, { sessionId: session.id, session, route: bot.appliedModel }), 'agent')
  assert.equal(rt.autoOffer(fresh).offered, false)
  ctx.get = get
  acpAgents.ownModeOf = () => { throw new Error('ACP service unavailable') }
  assert.equal(rt.autoWhy(bot, { sessionId: session.id, session, route: bot.appliedModel }), 'agent')
  acpAgents.ownModeOf = provider => provider === CODEX ? { mode: 'agent', bridged: true, answerer: true } : undefined

  ended.length = 0
  await rt.save()
  assert.equal(bot.permissionAuto, undefined)
  assert.equal(bot.permission, WRITE)
  assert.equal(bot.permissionRev, rev + 1)
  assert.deepEqual(rt.autoViewOf(bot), {})
  assert.deepEqual(ended, [session.id])
  assert.equal(disk().m1.permissionAuto, undefined)
  assert.equal(disk().m1.permissionRev, rev + 1)
  assert.equal(rt.autoOffer(fresh).offered, false)
  await assert.rejects(rt.setBotAuto(fresh.id, 0), { code: 'bot/refused', message: 'Auto is not offered for Fresh Claude here.' })
  assert.equal(fresh.permissionAuto, undefined)
  assert.equal(disk().b3.permissionAuto, undefined)

  acpAgents.ownModeOf = () => undefined
  assert.equal(rt.autoWhy(codex, { sessionId: 'b2', session: sessions.get('b2'), route: codex.appliedModel }), undefined)
  await rt.save()
  assert.equal(codex.permissionAuto, CODEX)
  assert.equal(disk().b2.permissionAuto, CODEX)
})
