#!/usr/bin/env node
// A fake codex-acp for the image tests (image.js): it offers Codex's modes and answers a prompt
// the way codex-acp reports Codex's built-in image tool, an `other` call titled "Image
// generation" whose finished update carries the PNG as an ACP image block, its raw output and
// a saved path under a Codex home that must never be opened. No network, no real Codex.
//
// FAKE_IMAGE_MODE picks the answer:
//   ok (default)  the image in the call's content
//   raw           the image only in rawOutput.result
//   ask           a shell call asking permission first (must be cancelled, and the draw
//                 refused), then the image
//   asktitle      a permission asked under the image tool's title for a call never reported
//                 (must be cancelled, and the draw refused), then the image
//   askimage      the image call, then a permission asked for it (must be cancelled: the turn
//                 then ends with no image)
//   limit         no image: a usage-limit notice, then the turn fails
//   auth          `session/new` refuses with ACP's auth_required
//   failed        the image call fails
//   hang          the image call starts and never ends (until cancelled)
//   peek          a read command that runs without asking (as Codex's read-only mode lets it),
//                 then the image call: the draw must refuse, and the image must not come back
//   late          the image, then, in a later write, a read: the draw must refuse all the same
//   twice         two image calls: the draw must refuse
//   big           an image past the size the caller keeps
//   nothing       the turn ends with no call
// `cli …` is codex-acp's passthrough to Codex, answered here as Codex 0.167 does:
// - `mcp list --json` prints FAKE_MCP_LIST (default `[]`); FAKE_MCP_LIST=fail exits 1 with
//   nothing printed, FAKE_MCP_LIST=broken exits 1 as Codex does on a config it cannot load;
// - `features list` prints one row per feature (`name  stage  true|false`), with the `-c
//   features={…}` overrides applied. FAKE_FEATURES changes the answer: `fail` (exit 1), `garbage`
//   (text that is no row), `hang` (never answers), or JSON { drop: [names not listed], stuck:
//   [names whose override is not taken], set: { name: [stage, on] } };
// - `debug prompt-input` prints the model-visible input: one `additional_tools` item whose
//   tools follow the features (commands unless shell_tool is off, and so on) and a skills
//   message. FAKE_TOOLS changes it: `fail`, `garbage`, or JSON { extra: [names offered whatever
//   the switches say, `ns.name` or a bare name], nested: [names `exec` reaches], hosted: [types
//   of nameless tools], missing: true (no tool block), item: 'a kind of item', skills: [the
//   person's skills], sticky: true (a skill turned off by name stays listed) }.
// FAKE_IMAGE_PROFILE=offer|reject|delay|hang offers the selected image profile only from the home.
// FAKE_PROFILE_RESOLVED=wider|write|missing|odd changes the resolved profile in prompt-input.
// FAKE_INVALID_CONFIG=mcp|features|debug emits a config warning on that successful check;
// `profile` warns only when default_permissions is passed in the check arguments.
// FAKE_IMAGE_HOLD=1 keeps the turn open after the image, until it is cancelled.
// FAKE_IMAGE_TRACE names a file the agent appends what it was asked to (cli arguments, cwd,
// servers, mode, CODEX_CONFIG, CODEX_HOME, permission answers, cancel, close) as JSON lines.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { serveAgent } from './serve-agent.mjs'

const MODE = process.env.FAKE_IMAGE_MODE ?? 'ok'
const TRACE = process.env.FAKE_IMAGE_TRACE
// A 1x1 PNG.
const SMALL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
// `big`: a PNG header and enough bytes after it to pass 12 MiB decoded. Never built for a
// `cli` call: under load, building it there has made a check outlast its time.
const PNG = MODE === 'big' && process.argv[2] !== 'cli' ? Buffer.concat([Buffer.from(SMALL, 'base64'), Buffer.alloc(12 * 1024 * 1024)]).toString('base64') : SMALL
const trace = (entry) => {
  if (TRACE === undefined) return
  try { appendFileSync(TRACE, `${JSON.stringify(entry)}\n`) } catch {}
}
// Codex 0.167's features that matter here, as `features list` shows them: [stage, default].
const FEATURES = {
  apply_patch_freeform: ['removed', false],
  apps: ['stable', true],
  browser_use: ['stable', true],
  code_mode: ['under development', false],
  collaboration_modes: ['removed', true],
  'guardianv2.thread_context': ['removed', false],
  image_generation: ['stable', true],
  js_repl: ['removed', false],
  multi_agent: ['stable', true],
  multi_agent_v2: ['stable', false],
  plugins: ['stable', true],
  shell_tool: ['stable', true],
  sleep_tool: ['stable', true],
  unified_exec: ['stable', true],
  view_image: ['stable', true],
}
const json = (text, fallback) => { try { return JSON.parse(text) } catch { return fallback } }
/** The features after the `-c features={ name = bool, … }` overrides, as { name: [stage, on] }. */
function featuresOf(args) {
  const changes = json(process.env.FAKE_FEATURES, {}) ?? {}
  const table = { ...FEATURES, ...changes.set }
  for (const name of changes.drop ?? []) delete table[name]
  const override = args.find((arg, index) => args[index - 1] === '-c' && arg.startsWith('features='))
  for (const [, name, value] of (override ?? '').matchAll(/([A-Za-z0-9_.-]+) = (true|false)/g)) {
    if (table[name] !== undefined && !(changes.stuck ?? []).includes(name)) table[name] = [table[name][0], value === 'true']
  }
  return table
}
function promptInput(args) {
  const changes = json(process.env.FAKE_TOOLS, {}) ?? {}
  const features = featuresOf(args)
  const on = name => features[name]?.[1] === true
  const nested = ['apply_patch', 'clock__curr_time', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', ...(on('shell_tool') ? ['exec_command', 'write_stdin'] : []), ...(on('view_image') ? ['view_image'] : []), ...(changes.nested ?? [])]
  const fn = name => ({ type: 'function', name, description: `The ${name} tool.`, strict: false, parameters: {} })
  const spaces = new Map([
    ['functions', [{ type: 'custom', name: 'exec', description: `Run JavaScript code.\n${nested.map(name => `### \`${name}\`\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${name}(args: {}): Promise<unknown>; };\n\`\`\``).join('\n')}`, format: {} }, fn('wait'), fn('request_user_input'), fn('request_user_input_async')]],
    ...(on('sleep_tool') ? [['clock', [fn('sleep')]]] : []),
    ['collaboration', ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'].map(fn)],
    ...(on('image_generation') ? [['image_gen', [fn('imagegen')]]] : []),
  ])
  const bare = []
  for (const name of changes.extra ?? []) {
    const [space, tool] = name.includes('.') ? name.split('.') : [undefined, name]
    if (space === undefined) bare.push(fn(tool))
    else spaces.set(space, [...(spaces.get(space) ?? []), fn(tool)])
  }
  const skillsArg = args.find((arg, index) => args[index - 1] === '-c' && arg.startsWith('skills=')) ?? ''
  const skills = [...(/bundled = \{ enabled = false \}/.test(skillsArg) ? [] : ['imagegen']), ...(changes.skills ?? []).filter(name => changes.sticky === true || !skillsArg.includes(`name = '${name}'`))]
  const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] })
  return JSON.stringify([
    ...(changes.missing === true ? [] : [{ type: 'additional_tools', role: 'developer', tools: [...[...spaces].map(([name, tools]) => ({ type: 'namespace', name, description: '', tools })), ...bare, ...(changes.hosted ?? []).map(type => ({ type }))] }]),
    ...(changes.item === undefined ? [] : [{ type: changes.item }]),
    message('developer', 'You are Codex.'),
    ...(skills.length === 0 ? [] : [message('developer', `<skills_instructions>\n## Skills\n### Skill roots\n- \`r0\` = \`/fake-codex-home/skills\`\n### Available skills\n${skills.map(name => `- ${name}: A skill to read. (file: r0/${name}/SKILL.md)`).join('\n')}\n</skills_instructions>`)]),
    message('user', `<environment_context>\n  <cwd>/fake</cwd>\n${resolvedProfile(args)}</environment_context>`),
  ])
}
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const profileArg = args => args.find((arg, index) => args[index - 1] === '-c' && arg.startsWith('default_permissions='))
function resolvedProfile(args) {
  const how = process.env.FAKE_PROFILE_RESOLVED
  if (!profileArg(args) || !args.some((arg, index) => args[index - 1] === '-c' && arg.startsWith('permissions=')) || how === 'missing') return ''
  const scratch = xml(realpathSync(process.cwd()))
  const home = xml(realpathSync(process.env.CODEX_HOME))
  return `<permission_profile type="managed"><file_system type="restricted"><entry access="deny" escalatable="false"><special>:root</special></entry><entry access="${how === 'write' ? 'write' : 'read'}"><path>${scratch}</path></entry><entry access="read"><path>${home}/tmp/arg0-linux/codex-arg0FAKE01</path></entry>${how === 'wider' ? '<entry access="read"><path>/fake-outside</path></entry>' : ''}${how === 'odd' ? '<unknown />' : ''}</file_system></permission_profile>`
}
function homeProfiles() {
  try {
    return [...readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8').matchAll(/^\[permissions\.(automagik-image-[a-f0-9]{32})\]$/gm)].map(match => match[1])
  } catch { return [] }
}
if (process.argv[2] === 'cli') {
  const args = process.argv.slice(3)
  trace({ event: 'cli', args, cwd: process.cwd(), homeProfiles: homeProfiles() })
  if (process.env.FAKE_INVALID_CONFIG === args[0] || (process.env.FAKE_INVALID_CONFIG === 'profile' && profileArg(args))) process.stderr.write('Invalid configuration; using defaults\n')
  if (args[0] === 'features' && args[1] === 'list') {
    const how = process.env.FAKE_FEATURES
    if (how === 'fail') process.exit(1)
    if (how === 'hang') await new Promise(() => { setInterval(() => {}, 1 << 30) })
    if (how === 'garbage') process.stdout.write('Usage: codex [OPTIONS] <COMMAND>\n')
    else process.stdout.write(Object.entries(featuresOf(args)).sort(([a], [b]) => a.localeCompare(b)).map(([name, [stage, value]]) => `${name.padEnd(40)} ${stage.padEnd(18)} ${value}\n`).join(''))
    process.exit(0)
  }
  if (args[0] === 'debug' && args[1] === 'prompt-input') {
    const how = process.env.FAKE_TOOLS
    if (how === 'fail') process.exit(1)
    process.stdout.write(how === 'garbage' ? 'not json' : promptInput(args))
    process.exit(0)
  }
  const listed = process.env.FAKE_MCP_LIST ?? '[]'
  if (listed === 'fail') process.exit(1)
  if (listed === 'broken') {
    process.stderr.write('Error: failed to load bootstrap configuration\n')
    process.exit(1)
  }
  process.stdout.write(listed)
  process.exit(0)
}
trace({ event: 'start', codexConfig: process.env.CODEX_CONFIG ?? null, codexHome: process.env.CODEX_HOME ?? null, codexPath: process.env.CODEX_PATH ?? null })

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
const sessions = new Map()
let created = 0
const MODES = { currentModeId: 'workspace-write', availableModes: [{ id: 'read-only', name: 'Read-only' }, { id: 'workspace-write', name: 'Workspace access' }, { id: 'agent-full-access', name: 'Full access' }] }

const implementation = {
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, authMethods: [] }
  },
  async newSession(params) {
    if (MODE === 'auth') throw RequestError.authRequired(undefined, 'run codex login first')
    const sessionId = `img-${++created}`
    const profileId = json(process.env.CODEX_CONFIG, {})?.default_permissions
    const profiles = homeProfiles()
    const mode = profiles.includes(profileId) && process.env.FAKE_IMAGE_PROFILE ? { id: `permission-profile:${profileId}`, name: 'Image scratch' } : undefined
    sessions.set(sessionId, { cancelled: false, wake: undefined, modeId: MODES.currentModeId })
    trace({ event: 'new-session', cwd: params.cwd, servers: (params.mcpServers ?? []).length, profileId, homeProfiles: profiles, codexConfig: process.env.CODEX_CONFIG ?? null })
    return { sessionId, modes: { ...MODES, availableModes: [...MODES.availableModes, ...(mode ? [mode] : [])] } }
  },
  async setSessionMode({ sessionId, modeId }) {
    trace({ event: 'mode', modeId })
    if (modeId.startsWith('permission-profile:')) {
      if (process.env.FAKE_IMAGE_PROFILE === 'reject') throw RequestError.invalidParams({ reason: '/home/ada/private prompt account' })
      if (process.env.FAKE_IMAGE_PROFILE === 'delay') await new Promise(resolve => setTimeout(resolve, 150))
      if (process.env.FAKE_IMAGE_PROFILE === 'hang') await new Promise(() => {})
    }
    sessions.get(sessionId).modeId = modeId
    trace({ event: 'mode-ack', modeId })
    return {}
  },
  async closeSession({ sessionId }) {
    trace({ event: 'close', sessionId })
    return {}
  },
  async cancel({ sessionId }) {
    trace({ event: 'cancel' })
    const session = sessions.get(sessionId)
    if (session) {
      session.cancelled = true
      session.wake?.()
    }
  },
  async prompt({ sessionId, prompt }) {
    const session = sessions.get(sessionId)
    const text = prompt.map(block => block.text ?? '').join('')
    trace({ event: 'prompt', modeId: session.modeId, mentionsTool: /image generation tool/i.test(text) })
    const update = body => conn.sessionUpdate({ sessionId, update: body })
    if (MODE === 'nothing') {
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I would rather not.' } })
      return { stopReason: 'end_turn' }
    }
    if (MODE === 'limit') {
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You\'ve hit your usage limit. Try again later.' } })
      throw RequestError.internalError({ codexErrorInfo: 'usageLimitExceeded' })
    }
    if (MODE === 'ask') {
      const shell = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'shell-1', title: 'Run ls ~', kind: 'execute' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      })
      trace({ event: 'answer', call: 'shell', outcome: shell.outcome })
    }
    if (MODE === 'asktitle') {
      const titled = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'other-1', title: 'Image generation', kind: 'other' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      })
      trace({ event: 'answer', call: 'titled', outcome: titled.outcome })
    }
    if (MODE === 'peek') {
      await update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read id_rsa', kind: 'read', status: 'in_progress', rawInput: { command: ['cat', '~/.ssh/id_rsa'] } })
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' })
      trace({ event: 'peeked' })
      if (session.cancelled) return { stopReason: 'cancelled' }
    }
    const toolCallId = 'ig-1'
    await update({ sessionUpdate: 'tool_call', toolCallId, title: 'Image generation', kind: 'other', status: 'in_progress', rawInput: { id: toolCallId } })
    if (MODE === 'askimage') {
      const image = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId, title: 'Allow image generation?', kind: 'other' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      })
      trace({ event: 'answer', call: 'image', outcome: image.outcome })
      if (image.outcome.outcome !== 'selected') return { stopReason: 'cancelled' }
    }
    if (MODE === 'hang') {
      await new Promise((resolve) => { session.wake = resolve })
      return { stopReason: 'cancelled' }
    }
    if (MODE === 'failed') {
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { status: 'failed' } })
      return { stopReason: 'end_turn' }
    }
    const savedPath = '/fake-codex-home/generated_images/never-open-me.png'
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: MODE === 'raw' ? [] : [{ type: 'content', content: { type: 'text', text: 'Revised prompt: a fox' } }, { type: 'content', content: { type: 'image', data: PNG, mimeType: 'image/png', uri: savedPath } }],
      rawOutput: { status: 'completed', revisedPrompt: 'a fox', result: PNG, savedPath },
    })
    if (process.env.FAKE_IMAGE_HOLD === '1') {
      // The image is out and the turn stays open until it is cancelled.
      await new Promise((resolve) => { session.wake = resolve })
      return { stopReason: 'cancelled' }
    }
    if (MODE === 'late') {
      // A separate, later write: the image is already out when this call is reported.
      await new Promise(resolve => setTimeout(resolve, 150))
      await update({ sessionUpdate: 'tool_call', toolCallId: 'read-late', title: 'Read notes', kind: 'read', status: 'completed' })
      trace({ event: 'late-read' })
    }
    if (MODE === 'twice') {
      await update({ sessionUpdate: 'tool_call', toolCallId: 'ig-2', title: 'Image generation', kind: 'other', status: 'completed', content: [{ type: 'content', content: { type: 'image', data: PNG, mimeType: 'image/png' } }], rawOutput: { status: 'completed', result: PNG } })
    }
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
    return { stopReason: 'end_turn' }
  },
}

const conn = serveAgent(implementation, stream)
