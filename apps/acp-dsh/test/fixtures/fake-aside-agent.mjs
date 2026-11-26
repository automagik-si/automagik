import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { serveAgent } from '../../dev/serve-agent.mjs'
import { AGY_SETTINGS_FAILED, agyOffPaths } from '../../src/host/agy-off.js'

const [traceFile, replyFile, version, mode, startModel, systemCapability, provider, ...args] =
  process.argv.slice(2)
const trace = (event, fields = {}) => appendFileSync(traceFile,
  JSON.stringify({ event, pid: process.pid, ...fields }) + '\n')
const modelOption = () => [{ id: 'model', name: 'Model', type: 'select', category: 'model',
  currentValue: model, options: ['gpt-6.2-sol', 'gpt-5.5'].map(value => ({ value, name: value })) }]
let model = startModel
let finish
trace('start', { cwd: process.cwd(), args })
const wire = serveAgent({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'Fixture', version },
      agentCapabilities: systemCapability === 'on'
        ? { sessionCapabilities: { systemPrompt: {} } } : {},
    }
  },
  async newSession({ cwd, mcpServers, systemPrompt, _meta }) {
    trace('new', { cwd, mcpServers, systemPrompt, meta: _meta })
    const reply = JSON.parse(readFileSync(replyFile, 'utf8'))
    const codex = provider === 'acp-codex'
    // codex-acp 2.12.0 uses ModelId strings in models and bare slugs in configOptions.
    const modelId = slug => codex ? slug + '[high]' : slug
    const profileArg = args.indexOf('--cli_dir_name')
    if (profileArg >= 0) {
      const { agentFile, settingsFile, logDir } = agyOffPaths(process.env.HOME, args[profileArg + 1])
      trace('agy-off', {
        agent: readFileSync(agentFile, 'utf8'),
        settings: JSON.parse(readFileSync(settingsFile, 'utf8')),
      })
      mkdirSync(logDir, { recursive: true })
      const failure = reply.agySettingsFailed
      writeFileSync(join(logDir, `acp-server-20261125_120000-${process.pid}.log`),
        failure ? AGY_SETTINGS_FAILED + ' fixture failure' : 'fixture settings loaded')
    }
    return { sessionId: 'aside-fixture', configOptions: modelOption(),
      ...(codex || reply.sessionModel !== undefined ? {
        models: { currentModelId: reply.sessionModel ?? modelId(model),
          availableModels: modelOption()[0].options.map(({ value, name }) => ({ modelId: modelId(value), name })) },
      } : {}),
      modes: { currentModeId: 'other',
        availableModes: ['other', mode].map(id => ({ id, name: id })) },
    }
  },
  async setSessionMode({ modeId }) { trace('mode', { modeId }) },
  async setSessionConfigOption({ value }) {
    model = value
    return { configOptions: modelOption() }
  },
  async closeSession() { trace('close') },
  async cancel() { finish?.() },
  async prompt({ sessionId, prompt }) {
    trace('prompt', { prompt, model })
    const update = update => wire.sessionUpdate({ sessionId, update })
    const reply = JSON.parse(readFileSync(replyFile, 'utf8'))
    if (reply.quota) {
      throw RequestError.internalError({ codexErrorInfo: { usageLimitExceeded: {} } },
        'Fictitious private detail')
    }
    if (reply.hang) await new Promise(resolve => { finish = resolve })
    if (reply.ask) {
      const answer = await wire.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'fake', title: 'Make a fixture change', kind: 'execute' },
        options: [{ kind: 'allow_once', optionId: 'yes', name: 'Allow' },
          { kind: 'reject_once', optionId: 'no', name: 'Reject' }],
      })
      trace('permission', { answer: answer.outcome })
      if (answer.outcome.optionId === 'yes') trace('tool-ran')
    }
    if (reply.drift) await update({
      sessionUpdate: 'tool_call', toolCallId: 'drift', status: 'pending', title: 'Fixture tool',
    })
    for (const text of reply.chunks ?? [reply.text ?? 'Fixture response.']) {
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    }
    return { stopReason: reply.stopReason ?? 'end_turn' }
  },
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
