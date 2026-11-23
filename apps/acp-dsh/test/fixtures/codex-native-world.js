// #1564 PR B: Codex with its own tools off, in tests. A fake `codex` for codex-native.js's checks
// (answers each `cli` call from the codex-0.171 captures by its `-c` overrides, records the call
// order, overlap and kills) and a Codex row on PR A's managed world (managed-native-world.js).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { AGENTS } from '../../src/host/agents.js'
import { CODEX, nativeWorld } from './managed-native-world.js'

const FIXTURES = join(import.meta.dirname, 'codex-0.171')
export const fixture = name => readFileSync(join(FIXTURES, name), 'utf8')
export const CHECKED = Object.freeze(['gpt-6.2-sol', 'gpt-5.6-luna'])
export const KEPT = 'gpt-5.5'

/**
 * A fake `run` (execFile's shape) for codexCli. `answers` overrides any reply:
 * `features`, `models`, `servers` (stdout strings), `prompt(config)` (stdout or undefined for
 * the capture; it also gets `calls`, every call so far), `hang` (a predicate on the call: never
 * answers until killed), `exit(call)` (an exit code: Codex answers and says no). `homeDefault` names the Codex home's own default model: a prompt read
 * that names no model answers that model's capture (`gpt-5.5` shows no tool block, as the real
 * one does); unset, such a read answers the full capture.
 */
export function fakeCodex({ answers = {}, delayMs = 1, homeDefault } = {}) {
  const calls = []
  const kills = []
  let active = 0
  let overlap = false
  const run = (command, args, options, callback) => {
    const at = args.indexOf('cli')
    const rest = args.slice(at + 1)
    const words = []
    const config = []
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '-c') { config.push(rest[i + 1]); i += 1 } else words.push(rest[i])
    }
    const what = words.join(' ')
    const has = text => config.some(entry => entry.includes(text))
    const model = config.find(entry => entry.startsWith('model='))?.slice(6).replace(/^'|'$/g, '')
    const call = { what, model, cwd: options.cwd, home: options.env?.CODEX_HOME, config }
    calls.push(call)
    const child = { pid: undefined, kill: signal => { kills.push({ what, signal }) } }
    if (answers.hang?.(call)) return child
    active += 1
    if (active > 1) overlap = true
    const code = answers.exit?.(call)
    if (typeof code === 'number') {
      setTimeout(() => {
        active -= 1
        callback(Object.assign(new Error(`exit ${code}`), { code }), '', 'refused')
      }, delayMs)
      return child
    }
    let stdout
    if (what === 'mcp list --json') stdout = answers.servers ?? '[]'
    else if (what === 'features list') stdout = answers.features ?? fixture('features.txt')
    else if (what === 'debug models') stdout = answers.models ?? fixture('models.json')
    else if (what === 'debug prompt-input') {
      const undone = has('shell_tool = true') ? 'shell_tool' : has('view_image = true') ? 'view_image'
        : !has('model_catalog_json=') ? 'catalog' : has('disable_native_tools = false') ? 'collaboration'
          : has('experimental_request_user_input = { enabled = true }') ? 'user_input' : undefined
      stdout = answers.prompt?.({ undone, model, config, calls: calls.slice(0, -1) })
        ?? (model === undefined && homeDefault !== undefined ? fixture(`prompt-model-${homeDefault}.json`)
          : undone !== undefined ? fixture(`prompt-undo-${undone}.json`)
          : model !== undefined ? fixture(`prompt-model-${model}.json`) : fixture('prompt-full.json'))
    } else stdout = ''
    setTimeout(() => {
      active -= 1
      callback(null, stdout, '')
    }, delayMs)
    return child
  }
  return { run, calls, kills, overlapped: () => overlap }
}

/** A prompt input whose tool block also offers `extra` (a function tool, or a namespace). */
export function withTool(extra) {
  const items = JSON.parse(fixture('prompt-full.json'))
  const block = items.find(item => item.type === 'additional_tools')
  block.tools.push(extra)
  return JSON.stringify(items)
}

/** A prompt input whose `functions` namespace also offers a function named `name`. */
export function withFunction(name) {
  const items = JSON.parse(fixture('prompt-full.json'))
  const functions = items.find(item => item.type === 'additional_tools').tools.find(tool => tool.name === 'functions')
  functions.tools.push({ type: 'function', name, description: name, parameters: { type: 'object', properties: {} }, strict: false })
  return JSON.stringify(items)
}

const row = AGENTS[CODEX]

/**
 * PR A's managed world with its Codex agent made a Codex row: the switch, the kept list, fork
 * refresh and Codex's modes. Its spawn stands in for index.js: under `nativeOff` it answers what
 * a passed check returns (or `offSpawn(context)`'s answer) and records every context.
 */
export function codexWorld(t, { identity, managed = true, env = {}, offSpawn, models = [...CHECKED, KEPT], start, dshTools } = {}) {
  const w = nativeWorld(t, {
    identity, managed,
    env: {
      FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
      FAKE_ACP_MODELS: models.join(','),
      ...(start === undefined ? {} : { FAKE_ACP_START_MODEL: start }),
      FAKE_ACP_NO_DEFAULT_EFFORT: '1',
      ...env,
    },
  })
  const codex = w.adapter.agents.get(CODEX)
  const contexts = []
  const base = codex.spawn
  let catalogDir
  Object.assign(codex, {
    name: row.name, key: 'codex', nativeSwitch: row.nativeSwitch, nativeKeptModels: row.nativeKeptModels,
    refresh: 'fork', modeFor: row.modeFor, ownMode: row.ownMode,
    catalog: { ...codex.catalog, ownModel: () => undefined },
    spawn: context => {
      contexts.push(context)
      const launch = base(context)
      if (context?.nativeOff !== true) return launch
      if (offSpawn) return offSpawn(context, launch)
      catalogDir ??= context.cwd === undefined ? undefined : join(context.cwd, '.codex-native-off')
      const bytes = '{"models":[]}\n'
      let catalog
      if (catalogDir !== undefined) {
        mkdirSync(catalogDir, { recursive: true })
        catalog = { path: join(catalogDir, 'models-test.json'), bytes, sha256: '' }
        writeFileSync(catalog.path, bytes, { mode: 0o600 })
      }
      return Promise.resolve({
        ...launch, env: { ...launch.env, CODEX_CONFIG: '{}' },
        nativeOff: true, checkedCwd: context.cwd, models: [...CHECKED], offCatalog: catalog,
      })
    },
  })
  if (dshTools !== undefined) w.adapter.dshTools = () => dshTools
  return { ...w, codex, contexts }
}

// A text the fake agent only answers ("plain"), unless it names one of its triggers.
const said = text => /^(codex-|mcp-|hang)/.test(text) ? text : `plain ${text}`
export const scheduled = text => createUserMessage({ content: [{ type: 'text', text: said(text) }], source: { kind: 'schedule' } })
export const owner = text => createUserMessage({ content: [{ type: 'text', text: said(text) }], source: { kind: 'user' } })

/** One turn on a model of the caller's choice (managed-native-world.js's turn runs `default`). */
export async function turnOn(w, chat, message, { provider = CODEX, model = 'default', signal } = {}) {
  chat.history.push(message)
  const agent = w.adapter.ctx.agents.get(chat.session.id)
  for (let step = 0; step < 4; step++) {
    const chunks = []
    for await (const chunk of w.adapter.stream(markAgentLoopRequest({ provider, model, sessionId: chat.session.id, messages: [...chat.history], signal }))) chunks.push(chunk)
    const content = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    chat.history.push({ role: 'assistant', source: { kind: 'model', provider, model }, content })
    const calls = content.filter(block => block.type === 'tool-call')
    if (calls.length === 0) return chunks
    for (const call of calls) {
      const result = await w.adapter.tool.execute(JSON.parse(call.arguments), { agent, callId: call.id, signal: new AbortController().signal })
      chat.history.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: result.text }] })
    }
  }
  throw new Error('the fake agent did not finish its turn')
}

export const textOf = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').map(chunk => chunk.block.text)
export const finishOf = chunks => chunks.at(-1)?.reason
