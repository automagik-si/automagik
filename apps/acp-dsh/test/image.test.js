// Images through the Codex CLI (image.js, owner decision D-g), against a fake codex-acp
// (dev/fake-image-agent.mjs) that reports Codex's image tool the way the real adapter does. No
// real Codex runs, nothing reaches a network, and no Codex home or config is read or written.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chatProfilesConfig, ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { apply } from '../index.js'
import { checkFeatures, checkOffered, configArgs, drawImage, FAILED, IMAGE_CHECKS_TIMEOUT_MS, IMAGE_CONFIG, IMAGE_FEATURES_ALSO_OFF, IMAGE_FEATURES_OFF, IMAGE_NESTED_ALLOWED, IMAGE_TITLE, IMAGE_TOOLS_ALLOWED, imageConfig, imageOf, imageOverrides, IMAGE_PROFILE_GRANTS, imageProfileFor, imagePrompt, imageSetup, imageSupport, isPng, mcpServerNames, nestedTools, readFeatures, readOffered, REFUSED, SIGNED_OUT, STOPPED, TIMED_OUT, toToml, UNAVAILABLE, USAGE_LIMIT } from '../src/host/image.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-image-agent.mjs')
// The also-off features the fake Codex lists and has not removed (dev/fake-image-agent.mjs).
const EXTRAS = ['unified_exec', 'code_mode', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'browser_use', 'sleep_tool']
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
// The debug renders of one draw: the session's config, and one proof per required switch with
// only that switch on (the effect the run requires; see image.js `takesEffect`).
const debugCalls = trace => trace.filter(entry => entry.event === 'cli' && entry.args[0] === 'debug')
const sameArgs = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const sessionArgs = config => ['debug', 'prompt-input', ...configArgs(config)]
const effectArgs = (config, name) => ['debug', 'prompt-input', ...configArgs({ ...config, features: { ...config.features, [name]: true } })]

function setup(mode, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'acp-image-test-'))
  const traceFile = join(home, 'trace.jsonl')
  const scratches = []
  const scratch = async () => {
    // The product's own scratch is resolved before checks and session; model that here.
    const dir = realpathSync(mkdtempSync(join(home, 'scratch-')))
    scratches.push(dir)
    return dir
  }
  const spawn = () => ({ command: process.execPath, args: [FAKE], env: { FAKE_IMAGE_MODE: mode, FAKE_IMAGE_TRACE: traceFile, CODEX_PATH: '/fake/codex', ...env } })
  const trace = () => (existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  return { home, scratch, scratches, spawn, trace, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('the image call\'s PNG comes from its content or raw output, never its saved file', () => {
  const content = [{ type: 'content', content: { type: 'image', data: PNG, mimeType: 'image/png', uri: '/home/x/.codex/generated_images/a.png' } }]
  assert.equal(imageOf({ title: IMAGE_TITLE, content }), PNG)
  assert.equal(imageOf({ title: IMAGE_TITLE, content: [], rawOutput: { result: PNG, savedPath: '/home/x/.codex/a.png' } }), PNG)
  assert.equal(imageOf({ title: IMAGE_TITLE, content: [{ type: 'content', content: { type: 'resource_link', uri: '/home/x/.codex/a.png' } }], rawOutput: { savedPath: '/home/x/.codex/a.png' } }), undefined)
  assert.equal(imageOf({ title: 'Run ls', content }), undefined)
  assert.equal(isPng(PNG), true)
  assert.equal(isPng(Buffer.from('not a png').toString('base64')), false)
})

test('the prompt asks for one image-tool call and says the size and background in words', () => {
  const text = imagePrompt({ prompt: 'a red fox', size: '1536x1024', quality: 'high', background: 'transparent' })
  assert.match(text, /image generation tool exactly once/)
  assert.match(text, /landscape \(1536x1024\)/)
  assert.match(text, /transparent/)
  assert.match(text, /high detail/)
  assert.match(text, /a red fox$/)
  assert.doesNotMatch(imagePrompt({ prompt: 'x', size: 'auto', background: 'auto' }), /Size:|Background:/)
})

test('one image: an empty read-only scratch session, the feature on for this run only, no servers, all cleaned up', async (t) => {
  const run = setup('ok')
  t.after(run.cleanup)
  const made = await drawImage({ spawn: run.spawn, prompt: 'a red fox', size: '1024x1024', scratch: run.scratch })
  assert.deepEqual(made, { base64: PNG, mimeType: 'image/png' })
  const trace = run.trace()
  const start = trace.find(entry => entry.event === 'start')
  assert.equal(start.codexConfig, imageConfig([], EXTRAS, [], run.scratches[0]))
  const config = JSON.parse(start.codexConfig)
  assert.deepEqual(config.projects, { [run.scratches[0]]: { trust_level: 'trusted' } }, 'the scratch folder is trusted in the checks as codex-acp trusts it in the session')
  assert.equal(config.features.image_generation, true)
  for (const feature of ['shell_tool', 'view_image', ...EXTRAS]) assert.equal(config.features[feature], false, `${feature} is off`)
  for (const feature of ['js_repl', 'apply_patch_freeform', 'remote_plugin']) assert.equal(feature in config.features, false, `${feature} (removed, or not listed by this Codex) is never sent`)
  assert.equal(config.web_search, 'disabled')
  assert.deepEqual(config.mcp_servers, {})
  assert.deepEqual(config.skills, { bundled: { enabled: false }, config: [] })
  // The checks come first, each through the `cli` passthrough and in the folder the session
  // then gets; the tools are read under the very config the session then gets. The last two
  // renders prove each required switch's effect with only that switch on.
  const clis = trace.filter(entry => entry.event === 'cli')
  assert.deepEqual(clis.map(entry => entry.cwd), Array(6).fill(run.scratches[0].replace(run.home, realpathSync(run.home))))
  assert.deepEqual(clis[0].args, ['mcp', 'list', '--json', '-c', `projects={ '${run.scratches[0]}' = { trust_level = 'trusted' } }`], 'the person\'s MCP servers are listed first')
  assert.deepEqual(clis[1].args, ['features', 'list', '-c', 'features={ image_generation = true, shell_tool = false, view_image = false }'])
  assert.deepEqual(clis[2].args, sessionArgs(config))
  assert.deepEqual(clis[3].args, ['features', 'list', ...configArgs(config)], 'the switches are read again under the session\'s config')
  assert.deepEqual(clis[4].args, effectArgs(config, 'shell_tool'), 'shell_tool turned on offers a command tool')
  assert.deepEqual(clis[5].args, effectArgs(config, 'view_image'), 'view_image turned on offers the picture tool')
  assert.equal(clis.length, 6)
  assert.ok(trace.indexOf(clis[5]) < trace.indexOf(start), 'the checks end before the session starts')
  assert.equal(start.codexHome, process.env.CODEX_HOME ?? null, 'CODEX_HOME is never set by the run')
  assert.equal(start.codexPath, '/fake/codex')
  const session = trace.find(entry => entry.event === 'new-session')
  assert.equal(session.cwd, run.scratches[0])
  assert.equal(session.servers, 0)
  assert.deepEqual(trace.filter(entry => entry.event === 'mode').map(entry => entry.modeId), ['read-only'])
  assert.equal(trace.find(entry => entry.event === 'prompt').mentionsTool, true)
  assert.ok(trace.some(entry => entry.event === 'close'), 'the session is closed')
  assert.equal(existsSync(run.scratches[0]), false, 'the scratch folder is removed')
})

test('the default scratch folder is the resolved folder the session gets', async (t) => {
  const run = setup('ok')
  t.after(run.cleanup)
  await drawImage({ spawn: run.spawn, prompt: 'a red fox' })
  const trace = run.trace()
  const session = trace.find(entry => entry.event === 'new-session')
  const first = trace.find(entry => entry.event === 'cli')
  assert.equal(session.cwd, first.cwd, 'the scratch folder is resolved before the session starts')
})

test('the config turns command execution off, not only refuses it afterwards', () => {
  const config = JSON.parse(imageConfig())
  assert.deepEqual(Object.keys(config.features).filter(feature => config.features[feature] === true), ['image_generation'])
  for (const feature of IMAGE_FEATURES_OFF) assert.equal(config.features[feature], false)
  assert.ok(IMAGE_FEATURES_OFF.includes('shell_tool') && IMAGE_FEATURES_OFF.includes('view_image'))
  assert.equal(config.web_search, 'disabled')
  assert.equal(imageConfig(), IMAGE_CONFIG)
  assert.equal(IMAGE_FEATURES_ALSO_OFF.some(name => IMAGE_FEATURES_OFF.includes(name)), false)
})

test('the session config and the checks\' -c arguments are one object', () => {
  const overrides = imageOverrides({ servers: ['github', 'docs.search'], extras: ['apps'], skills: ['my-notes', 'visualize:visualize'] })
  assert.equal(imageConfig(['github', 'docs.search'], ['apps'], ['my-notes', 'visualize:visualize']), JSON.stringify(overrides))
  assert.deepEqual(configArgs(overrides), [
    '-c', 'features={ image_generation = true, shell_tool = false, view_image = false, apps = false }',
    '-c', 'web_search=\'disabled\'',
    '-c', 'mcp_servers={ github = { enabled = false }, \'docs.search\' = { enabled = false } }',
    '-c', 'skills={ bundled = { enabled = false }, config = [{ name = \'my-notes\', enabled = false }, { name = \'visualize:visualize\', enabled = false }] }',
  ])
  assert.deepEqual(configArgs(imageOverrides({ project: 'C:\\Users\\a b\\scratch' })).at(-1), 'projects={ \'C:\\Users\\a b\\scratch\' = { trust_level = \'trusted\' } }')
  assert.equal('projects' in imageOverrides(), false)
  // Every top-level key of the config is an argument, so nothing reaches the session unchecked.
  assert.deepEqual(configArgs(overrides).filter(arg => arg !== '-c').map(arg => arg.slice(0, arg.indexOf('='))), Object.keys(JSON.parse(JSON.stringify(overrides))))
  assert.equal(toToml({ a: 'it\'s', b: [1, true], c: {} }), '{ a = "it\'s", b = [1, true], c = {} }')
  assert.throws(() => toToml({ a: null }))
})

test('feature rows: a stage with spaces, a name with a dot, a removed feature that reads true', () => {
  const rows = readFeatures('guardianv2.thread_context                removed            false\ncode_mode   under development  false\r\ncollaboration_modes  removed  true\n\nshell_tool stable false\nview_image stable false\nimage_generation stable true\napps stable true\njs_repl removed false\n')
  assert.deepEqual(rows.get('guardianv2.thread_context'), { stage: 'removed', on: false })
  assert.deepEqual(rows.get('code_mode'), { stage: 'under development', on: false })
  assert.deepEqual(rows.get('collaboration_modes'), { stage: 'removed', on: true })
  // The also-off names sent: listed and not removed. A removed switch protects nothing.
  assert.deepEqual(checkFeatures(rows), ['code_mode', 'apps'])
  assert.throws(() => readFeatures('Usage: codex features <COMMAND>\n'), error => error.kind === 'unsupported')
  assert.throws(() => readFeatures('\n'), error => error.kind === 'unsupported')
  const without = (name, row) => new Map([...rows].filter(([key]) => key !== name).concat(row ? [[name, row]] : []))
  assert.throws(() => checkFeatures(without('view_image')), /does not know the feature view_image/)
  assert.throws(() => checkFeatures(without('shell_tool', { stage: 'stable', on: true })), /did not turn the feature shell_tool off/)
  assert.throws(() => checkFeatures(without('shell_tool', { stage: 'removed', on: false })), /does not know the feature shell_tool/, 'a removed required feature is not protection')
  assert.throws(() => checkFeatures(without('image_generation')), /image_generation on/)
  assert.throws(() => checkFeatures(without('image_generation', { stage: 'stable', on: false })), /image_generation on/)
})

test('offered tools: only the fixed list and the image tool pass; anything else, or no tool block, does not', () => {
  const fn = name => ({ type: 'function', name, description: '' })
  const input = ({ top = [], spaces = {}, nested = ['apply_patch'], more = [] } = {}) => JSON.stringify([
    { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: nested.map(name => `declare const tools: { ${name}(args: {}): Promise<unknown>; };`).join('\n') }, fn('wait')] }, ...Object.entries(spaces).map(([name, tools]) => ({ type: 'namespace', name, tools: tools.map(fn) })), ...top] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>\n### Available skills\n- my-notes: Read notes. (file: r0/a/SKILL.md)\n- visualize:visualize: Draw: charts. (file: r1/b/SKILL.md)\n- bad name here\n</skills_instructions>' }] },
    ...more,
  ])
  const fine = readOffered(input({ spaces: { image_gen: ['imagegen'], clock: ['sleep'], collaboration: ['spawn_agent'] }, top: [{ type: 'image_generation' }], nested: IMAGE_NESTED_ALLOWED.concat('image_gen__imagegen') }))
  assert.deepEqual(fine.tools, ['functions.exec', 'functions.wait', 'image_gen.imagegen', 'clock.sleep', 'collaboration.spawn_agent', 'type:image_generation'])
  assert.deepEqual(fine.skills, ['my-notes', 'visualize:visualize'])
  checkOffered(fine)
  checkOffered({ tools: [...IMAGE_TOOLS_ALLOWED], nested: [...IMAGE_NESTED_ALLOWED] })
  for (const [label, text] of [
    ['a command tool inside exec', input({ nested: ['apply_patch', 'exec_command'] })],
    ['command input inside exec', input({ nested: ['write_stdin'] })],
    ['image viewing inside exec', input({ nested: ['view_image'] })],
    ['an MCP tool inside exec', input({ nested: ['mcp__github__get_file'] })],
    ['an MCP tool', input({ top: [fn('mcp__github__get_file')] })],
    ['a namespaced MCP tool', input({ spaces: { mcp__github: ['get_file'] } })],
    ['a tool this version does not know', input({ spaces: { functions2: ['read_file'] } })],
    ['a new tool in a known namespace', input({ spaces: { collaboration: ['read_file'] } })],
    ['a hosted tool that is not the image tool', input({ top: [{ type: 'web_search' }] })],
  ]) {
    assert.throws(() => checkOffered(readOffered(text)), error => error.kind === 'unsupported' && /does not allow/.test(error.message), label)
  }
  for (const [label, text] of [
    ['no tool block', JSON.stringify([{ type: 'message', role: 'user', content: [] }])],
    ['an item of an unknown kind', input({ more: [{ type: 'tool_search_output', tools: [fn('read_file')] }] })],
    ['a tool with no name in a namespace', JSON.stringify([{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'x', tools: [{ type: 'function' }] }] }])],
    ['a nested declaration it cannot read', input({ top: [{ type: 'function', name: 'wait2', description: 'declare const tools: Record<string, unknown>' }] })],
    ['text that is not JSON', 'Error: unrecognized subcommand'],
    ['an answer that is no list', '{}'],
    ['an exec that names no tool it reaches', input({ nested: [] })],
    ['a tool with a field this code does not know', input({ top: [{ ...fn('wait'), nested_tools: [fn('exec_command')] }] })],
    ['a tool of a kind this code does not know', input({ top: [{ type: 'local_shell', name: 'wait' }] })],
    ['a function that holds tools', input({ top: [{ ...fn('wait'), tools: [fn('exec_command')] }] })],
    ['a namespace inside a namespace', JSON.stringify([{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'a', tools: [{ type: 'namespace', name: 'b', tools: [] }] }] }])],
  ]) {
    assert.throws(() => readOffered(text), error => error.kind === 'unsupported', label)
  }
})

test('nested tools: one declaration per tool in the one form Codex writes; any other form is refused', () => {
  const one = name => `### \`${name}\`\nWhat it does.\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${name}(args: {\n  // It's a comment with a { brace and a "quote.\n  path?: string; kind: "a" | 'b';\n  each?: Array<{ at: number }>;\n}): Promise<{\n  output: string;\n}>; };\n\`\`\``
  assert.deepEqual(nestedTools(`Run JavaScript code, for example \`await tools.exec_command(...)\`.\n${one('apply_patch')}\n## clock\n${one('clock__curr_time')}`), ['apply_patch', 'clock__curr_time'])
  assert.deepEqual(nestedTools('declare const tools: { apply_patch(input: string): Promise<string>; };'), ['apply_patch'])
  assert.deepEqual(nestedTools('A tool with no nested tools.'), [])
  assert.deepEqual(nestedTools(undefined), [])
  for (const [label, text] of [
    ['two tools in one block', 'declare const tools: { apply_patch(input: string): Promise<string>; exec_command(args: {}): Promise<string>; };'],
    ['two tools in one block, the second under another argument name', 'declare const tools: { apply_patch(input: string): Promise<string>; exec_command(options: {}): Promise<string>; };'],
    ['two tools in one block, split by a comma', 'declare const tools: { apply_patch(input: string): Promise<string>, exec_command: Run };'],
    ['a namespace', `${one('apply_patch')}\ndeclare namespace tools { function exec_command(args: {}): Promise<string> }`],
    ['an interface', `${one('apply_patch')}\ninterface Tools { exec_command(args: {}): Promise<string> }`],
    ['another kind of declaration', `${one('apply_patch')}\ndeclare let tools: { exec_command: Run };`],
    ['a declaration of another shape', 'declare const tools: Record<string, unknown>'],
    ['a quoted name', 'declare const tools: { "exec_command"(args: {}): Promise<string>; };'],
    ['a block that does not close', 'declare const tools: { apply_patch(input: string): Promise<string>;'],
    ['an empty block', 'declare const tools: { apply_patch(input: string) }; declare const tools: { };'],
    ['the same tool twice', `${one('apply_patch')}\n${one('apply_patch')}`],
    ['a signature with no declaration', `${one('apply_patch')}\nAlso: exec_command(args: { cmd: string }) runs a command.`],
    ['a heading with no declaration', `${one('apply_patch')}\n### \`exec_command\`\nRuns a command. Takes cmd.`],
  ]) {
    assert.throws(() => nestedTools(text), error => error.kind === 'unsupported' && /nested tool/.test(error.message), label)
  }
})

// What stops a draw before Codex starts: the check, the trace of what did not happen, the text.
async function refusedBeforeStart(t, env, message, label, options = {}) {
  const run = setup('ok', env)
  t.after(run.cleanup)
  const logged = []
  let caught
  await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch, ...options, log: line => logged.push(line) }), (error) => {
    caught = error.message
    assert.equal(error.code, UNAVAILABLE, label)
    assert.match(error.message, message, label)
    return true
  })
  const trace = run.trace()
  assert.equal(trace.some(entry => entry.event === 'start' || entry.event === 'new-session'), false, `${label}: no session is started`)
  assert.equal(run.scratches.length, 1, label)
  assert.equal(existsSync(run.scratches[0]), false, `${label}: the scratch folder of the checks is removed`)
  return { trace, logged, message: caught }
}

test('a feature the run relies on that Codex does not list, or leaves on, stops the draw before Codex starts', async (t) => {
  const unsupported = /could not turn off.*Update Automagik and try again/
  const renamed = await refusedBeforeStart(t, { FAKE_FEATURES: JSON.stringify({ drop: ['view_image'] }) }, unsupported, 'a renamed feature')
  assert.match(renamed.logged[0], /unsupported.*view_image/, 'one log line names the feature')
  assert.doesNotMatch(renamed.message, /view_image/, 'the refusal shown does not')
  await refusedBeforeStart(t, { FAKE_FEATURES: JSON.stringify({ stuck: ['shell_tool'] }) }, unsupported, 'an override not taken')
  await refusedBeforeStart(t, { FAKE_FEATURES: JSON.stringify({ set: { shell_tool: ['removed', false] } }) }, unsupported, 'a removed feature')
  await refusedBeforeStart(t, { FAKE_FEATURES: JSON.stringify({ drop: ['image_generation'] }) }, unsupported, 'no image feature')
  await refusedBeforeStart(t, { FAKE_FEATURES: JSON.stringify({ stuck: ['image_generation'], set: { image_generation: ['stable', false] } }) }, unsupported, 'the image feature off')
  await refusedBeforeStart(t, { FAKE_FEATURES: 'fail' }, unsupported, 'a refused feature list')
  await refusedBeforeStart(t, { FAKE_FEATURES: 'garbage' }, unsupported, 'an unreadable feature list')
  const slow = await refusedBeforeStart(t, { FAKE_FEATURES: 'hang' }, /could not be checked.*Try again/, 'a feature list that never answers', { checkTimeoutMs: 1500 })
  assert.match(slow.logged[0], /unreadable/)
})

test('a tool Codex still offers that is not on the list stops the draw, whatever the feature names say', async (t) => {
  const unsupported = /could not turn off.*Update Automagik/
  // Every feature name is known and off, and the tool is offered all the same.
  const kept = await refusedBeforeStart(t, { FAKE_TOOLS: JSON.stringify({ nested: ['exec_command'] }) }, unsupported, 'a command tool the switches left on')
  assert.match(kept.logged[0], /exec_command/)
  await refusedBeforeStart(t, { FAKE_TOOLS: JSON.stringify({ nested: ['view_image'] }) }, unsupported, 'image viewing left on')
  await refusedBeforeStart(t, { FAKE_TOOLS: JSON.stringify({ extra: ['mcp__github__get_file'] }) }, unsupported, 'an MCP tool')
  await refusedBeforeStart(t, { FAKE_TOOLS: JSON.stringify({ extra: ['functions.read_file'] }) }, unsupported, 'a tool a later Codex adds')
  await refusedBeforeStart(t, { FAKE_TOOLS: JSON.stringify({ hosted: ['web_search'] }) }, unsupported, 'a hosted tool')
  await refusedBeforeStart(t, { FAKE_TOOLS: JSON.stringify({ missing: true }) }, unsupported, 'no tool block')
  await refusedBeforeStart(t, { FAKE_TOOLS: JSON.stringify({ item: 'tool_search_output' }) }, unsupported, 'an unknown item')
  await refusedBeforeStart(t, { FAKE_TOOLS: 'fail' }, unsupported, 'a Codex without the command')
  await refusedBeforeStart(t, { FAKE_TOOLS: 'garbage' }, unsupported, 'an unreadable answer')
  // The hosted image tool, with no name, is the one nameless tool allowed.
  const hosted = setup('ok', { FAKE_TOOLS: JSON.stringify({ hosted: ['image_generation'] }) })
  t.after(hosted.cleanup)
  assert.equal((await drawImage({ spawn: hosted.spawn, prompt: 'a fox', scratch: hosted.scratch })).base64, PNG)
})

test('a required switch Codex lists but does not act on stops the draw', async (t) => {
  const unsupported = /could not turn off.*Update Automagik and try again/
  for (const feature of ['shell_tool', 'view_image']) {
    const run = setup('ok', { FAKE_TOOLS: JSON.stringify({ inert: [feature] }) })
    t.after(run.cleanup)
    const logged = []
    let caught
    await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch, log: line => logged.push(line) }), (error) => {
      caught = error.message
      assert.equal(error.code, UNAVAILABLE, feature)
      assert.match(error.message, unsupported, feature)
      return true
    }, `${feature}: the switch is reported off, but turning it on offers no tool`)
    assert.match(logged[0], new RegExp(`unsupported.*${feature}`), `${feature}: the log names the switch`)
    assert.doesNotMatch(caught, new RegExp(feature), `${feature}: the refusal shown does not`)
    const trace = run.trace()
    assert.equal(trace.some(entry => entry.event === 'start' || entry.event === 'new-session'), false, `${feature}: no session is started`)
    assert.equal(existsSync(run.scratches[0]), false, `${feature}: the scratch folder of the checks is removed`)
  }
})

test('a Codex config that cannot be loaded says so', async (t) => {
  const broken = await refusedBeforeStart(t, { FAKE_MCP_LIST: 'broken' }, /could not load its own configuration/, 'a broken config')
  assert.match(broken.logged[0], /config/)
})

test('the person\'s own skills are turned off by name, and the tools read again under that config', async (t) => {
  const run = setup('ok', { FAKE_TOOLS: JSON.stringify({ skills: ['my-notes', 'visualize:visualize'] }) })
  t.after(run.cleanup)
  await drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch })
  const trace = run.trace()
  const config = JSON.parse(trace.find(entry => entry.event === 'start').codexConfig)
  assert.deepEqual(config.skills, { bundled: { enabled: false }, config: [{ name: 'my-notes', enabled: false }, { name: 'visualize:visualize', enabled: false }] })
  const renders = debugCalls(trace)
  assert.equal(renders.length, 4)
  assert.deepEqual(renders[1].args, sessionArgs(config), 'the second skill pass is the session\'s config')
  // A skill that stays listed is not a tool: the draw goes on (a read it invites is refused).
  const sticky = setup('ok', { FAKE_TOOLS: JSON.stringify({ skills: ['my-notes'], sticky: true }) })
  t.after(sticky.cleanup)
  assert.equal((await drawImage({ spawn: sticky.spawn, prompt: 'a fox', scratch: sticky.scratch })).base64, PNG)
  assert.equal(debugCalls(sticky.trace()).length, 4, 'two skill renders at most, plus the two effects')
})

test('imageSetup runs every check outside a project and keeps names only', async (t) => {
  const calls = []
  const run = (file, args, options, done) => {
    calls.push({ args: args.slice(args.indexOf('cli') + 1), cwd: options.cwd })
    const [first] = calls.at(-1).args
    if (first === 'mcp') return done(null, '[{"name":"github","env":{"KEY":"x"}}]', '')
    if (first === 'features') return done(null, 'shell_tool stable false\nview_image stable false\nimage_generation stable true\napps stable true\n', '')
    done(null, JSON.stringify([{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: 'declare const tools: { apply_patch(input: string): Promise<string>; };' }] }] }, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'The person\'s global instructions.' }] }]), '')
  }
  const made = await imageSetup({ command: '/node', args: ['/adapter.js'], env: { CODEX_PATH: '/codex' } }, { run })
  assert.deepEqual(made, { servers: ['github'], extras: ['apps'], skills: [], overrides: imageOverrides({ servers: ['github'], extras: ['apps'] }) })
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['mcp', 'list'], ['features', 'list'], ['debug', 'prompt-input'], ['features', 'list']])
  assert.equal(new Set(calls.map(call => call.cwd)).size, 1)
  assert.equal(calls[0].cwd, tmpdir())
  // In the run's folder when there is one, trusted as the session will trust it.
  calls.length = 0
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'acp-image-folder-')))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const inside = await imageSetup({ command: '/node' }, { run, cwd: folder })
  assert.deepEqual(calls.map(call => call.cwd), [folder, folder, folder, folder])
  assert.deepEqual(inside.overrides.projects, { [folder]: { trust_level: 'trusted' } })
  assert.equal(calls[2].args.at(-1), `projects={ '${folder}' = { trust_level = 'trusted' } }`)
  // An exit code is Codex's own no (an update is needed); a timeout or a spawn failure is not.
  const failing = error => (file, args, options, done) => (args.includes('features') ? done(error, '', '') : run(file, args, options, done))
  await assert.rejects(imageSetup({ command: '/node' }, { run: failing(Object.assign(new Error('exit'), { code: 2 })) }), error => error.kind === 'unsupported')
  await assert.rejects(imageSetup({ command: '/node' }, { run: failing(Object.assign(new Error('timeout'), { killed: true, code: null })) }), error => error.kind === 'unreadable' && error.passing === true)
  await assert.rejects(imageSetup({ command: '/node' }, { run: failing(Object.assign(new Error('spawn'), { code: 'ENOENT' })) }), error => error.kind === 'unreadable' && error.passing !== true)
})

test('the checks share one deadline, stop when the draw is stopped, and do not wait for a command that hangs', async () => {
  assert.ok(IMAGE_CHECKS_TIMEOUT_MS < 60_000)
  const answer = (args, done) => {
    if (args.includes('mcp')) return done(null, '[]', '')
    if (args.includes('features')) return done(null, 'shell_tool stable false\nview_image stable false\nimage_generation stable true\n', '')
    done(null, JSON.stringify([{ type: 'additional_tools', tools: [] }]), '')
  }
  // A clock that passes the deadline after the first check: the second is never started.
  let clock = 0
  const calls = []
  const timed = (file, args, options, done) => { calls.push(args); clock += 30_000; answer(args, done) }
  await assert.rejects(imageSetup({ command: '/node' }, { run: timed, now: () => clock, deadlineMs: 20_000 }), error => error.kind === 'unreadable' && error.passing === true && /in time/.test(error.message))
  assert.equal(calls.length, 1)
  // A stop between two checks, and a stop while one is running (it is killed, not waited for).
  const controller = new AbortController()
  const stopping = (file, args, options, done) => { controller.abort(); answer(args, done) }
  await assert.rejects(imageSetup({ command: '/node' }, { run: stopping, signal: controller.signal }), error => error.stopped === true)
  const midway = new AbortController()
  const killed = []
  const hanging = () => { setTimeout(() => midway.abort(), 20); return { pid: undefined, kill: signal => killed.push(signal) } }
  await assert.rejects(imageSetup({ command: '/node' }, { run: hanging, signal: midway.signal }), error => error.stopped === true && error.passing === true)
  assert.deepEqual(killed, ['SIGKILL'])
  // A command that never answers is killed at its own time, and the answer does not wait.
  const late = []
  const from = Date.now()
  await assert.rejects(imageSetup({ command: '/node' }, { run: () => ({ kill: signal => late.push(signal) }), timeoutMs: 50 }), error => error.kind === 'unreadable' && error.passing === true)
  assert.deepEqual(late, ['SIGKILL'])
  assert.ok(Date.now() - from < 5000)
})

test('imageSupport remembers a yes or a no per Codex, with its reason, and never a check that ran out of time', async () => {
  let answer = 'yes'
  let runs = 0
  let clock = 0
  const logged = []
  const setup = async () => {
    runs += 1
    if (answer === 'no') throw Object.assign(new Error('Codex offers a tool the image run does not allow (exec_command)'), { kind: 'unsupported' })
    if (answer === 'slow') throw Object.assign(new Error('timeout'), { kind: 'unreadable', passing: true })
    if (answer === 'broken') throw Object.assign(new Error('the MCP server list was not JSON'), { kind: 'unreadable' })
    if (answer === 'config') throw Object.assign(new Error('Codex could not load its configuration'), { kind: 'config' })
  }
  const supported = imageSupport({ setup, ttlMs: 1000, now: () => clock, log: line => logged.push(line) })
  const launch = { command: '/no/node', args: ['/no/adapter.js'], env: { CODEX_PATH: '/no/codex' } }
  assert.deepEqual(await Promise.all([supported(launch), supported(launch)]), [{ ok: true }, { ok: true }])
  assert.equal(runs, 1, 'one check for two askers')
  answer = 'no'
  assert.deepEqual(await supported(launch), { ok: true }, 'remembered')
  assert.deepEqual(await supported({ ...launch, env: { CODEX_PATH: '/no/other-codex' } }), { ok: false, reason: 'unsupported' }, 'another Codex is asked')
  assert.match(logged[0], /unsupported.*exec_command/)
  clock = 2000
  answer = 'slow'
  assert.deepEqual(await supported(launch), { ok: undefined })
  answer = 'yes'
  assert.deepEqual(await supported(launch), { ok: true }, 'a check that ran out of time is not remembered')
  assert.equal(runs, 4)
  // A check that fails for another reason is a no as well, remembered for the same time.
  for (const [how, reason] of [['broken', 'unreadable'], ['config', 'config']]) {
    clock += 2000
    answer = how
    assert.deepEqual(await supported(launch), { ok: false, reason })
    answer = 'yes'
    assert.deepEqual(await supported(launch), { ok: false, reason }, 'remembered')
  }
  assert.equal(runs, 6)
})

test('the person\'s own MCP servers are each turned off by name, never left to an empty table', async (t) => {
  const run = setup('ok', { FAKE_MCP_LIST: JSON.stringify([{ name: 'github', transport: { type: 'stdio', command: 'gh-mcp', env: { TOKEN: '<redacted>' } } }, { name: 'docs.search', enabled: true }]) })
  t.after(run.cleanup)
  await drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch })
  const start = run.trace().find(entry => entry.event === 'start')
  assert.deepEqual(JSON.parse(start.codexConfig).mcp_servers, { github: { enabled: false }, 'docs.search': { enabled: false } })
  assert.doesNotMatch(start.codexConfig, /gh-mcp|TOKEN|redacted/, 'nothing but the names is kept')
  // The tools were read with those servers off: the session's own render carries them all.
  const config = JSON.parse(start.codexConfig)
  const render = debugCalls(run.trace()).find(entry => sameArgs(entry.args, sessionArgs(config)))
  assert.ok(render, 'the session config is rendered')
  assert.ok(render.args.some(arg => arg.startsWith('mcp_servers={ github = { enabled = false }')))
})

test('a server list that cannot be read stops the draw before Codex starts', async (t) => {
  for (const listed of ['fail', 'not json', '{"servers":"x"}', '[{"name":"a b"}]']) {
    const run = setup('ok', { FAKE_MCP_LIST: listed })
    t.after(run.cleanup)
    await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch }), error => error.code === UNAVAILABLE && /MCP servers could not be listed/.test(error.message), listed)
    assert.equal(run.trace().some(entry => entry.event === 'start'), false, `${listed}: no session is started`)
    assert.equal(existsSync(run.scratches[0]), false, `${listed}: the scratch folder of the checks is removed`)
  }
})

test('mcpServerNames reads names only, through codex-acp\'s cli passthrough', async () => {
  const calls = []
  const run = (file, args, options, done) => { calls.push({ file, args, env: options.env }); done(null, JSON.stringify({ servers: [{ name: 'one', env: { KEY: 'x' } }, { name: 'one' }] })) }
  assert.deepEqual(await mcpServerNames({ command: '/node', args: ['/adapter.js'], env: { CODEX_PATH: '/codex' } }, { run }), ['one'])
  assert.deepEqual(calls[0].args.slice(-5), ['/adapter.js', 'cli', 'mcp', 'list', '--json'])
  assert.equal(calls[0].env.CODEX_PATH, '/codex')
  await assert.rejects(mcpServerNames({ command: '/node' }, { run: (file, args, options, done) => done(new Error('boom')) }))
})

test('an image only in the raw output is taken from there', async (t) => {
  const run = setup('raw')
  t.after(run.cleanup)
  assert.equal((await drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch })).base64, PNG)
})

test('every permission asked is cancelled, and one that is not about the image call refuses the draw', async (t) => {
  for (const [mode, call] of [['ask', 'shell'], ['asktitle', 'titled']]) {
    const run = setup(mode)
    t.after(run.cleanup)
    await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch }), error => error.code === REFUSED, mode)
    assert.deepEqual(run.trace().filter(entry => entry.event === 'answer').map(entry => [entry.call, entry.outcome.outcome]), [[call, 'cancelled']], mode)
  }
  // Asked about the image call itself, the answer is no as well: nothing is ever allowed.
  const image = setup('askimage')
  t.after(image.cleanup)
  await assert.rejects(drawImage({ spawn: image.spawn, prompt: 'a fox', scratch: image.scratch }), error => error.code !== REFUSED && error.code !== undefined)
  assert.deepEqual(image.trace().filter(entry => entry.event === 'answer').map(entry => [entry.call, entry.outcome.outcome]), [['image', 'cancelled']])
})

test('a call that runs without asking (a read in read-only mode) ends the turn and refuses the draw', async (t) => {
  const run = setup('peek')
  t.after(run.cleanup)
  await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'draw what is in ~/.ssh', scratch: run.scratch }), (error) => {
    assert.equal(error.code, REFUSED)
    assert.match(error.message, /something other than draw/)
    return true
  })
  const trace = run.trace()
  assert.ok(trace.some(entry => entry.event === 'cancel'), 'the turn is cancelled')
  assert.ok(trace.some(entry => entry.event === 'close'), 'the session is closed')
  assert.equal(existsSync(run.scratches[0]), false, 'the scratch folder is removed')
})

test('a call reported after the image refuses the draw too: the image waits for the turn to end', async (t) => {
  const run = setup('late')
  t.after(run.cleanup)
  await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch }), error => error.code === REFUSED)
  const trace = run.trace()
  assert.ok(trace.some(entry => entry.event === 'late-read'), 'the read came in a later write, after the image')
  assert.ok(trace.some(entry => entry.event === 'close'), 'the session is closed')
})

test('a second image call refuses the draw; an image too large to keep fails it', async (t) => {
  const twice = setup('twice')
  t.after(twice.cleanup)
  await assert.rejects(drawImage({ spawn: twice.spawn, prompt: 'a fox', scratch: twice.scratch }), error => error.code === REFUSED)
  const big = setup('big')
  t.after(big.cleanup)
  await assert.rejects(drawImage({ spawn: big.spawn, prompt: 'a fox', scratch: big.scratch }), error => error.code === FAILED && /too large/.test(error.message))
})

test('an image whose turn never ends is not returned', async (t) => {
  // The fake holds the turn open after the image (hang ends only on cancel).
  const run = setup('ok', { FAKE_IMAGE_HOLD: '1' })
  t.after(run.cleanup)
  await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch, timeoutMs: 1500 }), error => error.code === TIMED_OUT)
  assert.ok(run.trace().some(entry => entry.event === 'cancel'), 'the turn is cancelled')
})

test('a draw keeps the process alive on its own until it is cleaned up', async () => {
  const script = `import { drawImage } from ${JSON.stringify(new URL('../src/host/image.js', import.meta.url).href)}
const made = await drawImage({ spawn: () => ({ command: process.execPath, args: [${JSON.stringify(FAKE)}], env: { FAKE_IMAGE_MODE: 'ok' } }), prompt: 'a fox' })
process.stdout.write(made.mimeType)`
  const { execFileSync } = await import('node:child_process')
  const harness = join(import.meta.dirname, 'harness-resolve.mjs')
  const out = execFileSync(process.execPath, ['--import', harness, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(out, 'image/png')
})

test('clear refusals: signed out, usage limit, a failed call, no image, a connector still installing', async (t) => {
  for (const [mode, code, message] of [
    ['auth', SIGNED_OUT, /not signed in/],
    ['limit', USAGE_LIMIT, /usage limit/],
    ['failed', FAILED, /could not draw/],
    ['nothing', FAILED, /without drawing/],
  ]) {
    const run = setup(mode)
    t.after(run.cleanup)
    await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch }), (error) => {
      assert.equal(error.code, code, mode)
      assert.match(error.message, message)
      return true
    })
    assert.equal(existsSync(run.scratches[0]), false, `${mode}: the scratch folder is removed`)
  }
  await assert.rejects(drawImage({ spawn: () => { throw new Error('its ACP adapter is still being installed') }, prompt: 'x' }), error => error.code === UNAVAILABLE && /still being installed/.test(error.message))
})

test('a run past its time is cancelled and refused; a stopped one says so', async (t) => {
  const slow = setup('hang')
  t.after(slow.cleanup)
  await assert.rejects(drawImage({ spawn: slow.spawn, prompt: 'a fox', scratch: slow.scratch, timeoutMs: 1500 }), error => error.code === TIMED_OUT)
  assert.ok(slow.trace().some(entry => entry.event === 'cancel'), 'the turn is cancelled')
  assert.equal(existsSync(slow.scratches[0]), false)

  const stopped = setup('hang')
  t.after(stopped.cleanup)
  const controller = new AbortController()
  const drawing = drawImage({ spawn: stopped.spawn, prompt: 'a fox', scratch: stopped.scratch, signal: controller.signal })
  setTimeout(() => controller.abort(), 800)
  await assert.rejects(drawing, error => error.code === STOPPED)
})

// The service: images only when Codex is on, found, its connector installed and signed in.
function service({ signedIn = true, bins = true, codex = true, imageSetup: check } = {}) {
  const services = {}
  const ctx = {
    logger: { warn() {}, info() {} },
    llm: { registerAdapter: () => Object.assign(() => {}, { replace() {} }), listProviders: () => [], listModels: () => [] },
    agents: { get: () => undefined },
    get: () => undefined,
    provide: (name, value) => { services[name] = value },
    on() {},
    effect() {},
    emit() {},
  }
  const probes = []
  const store = { binOf: pkg => (bins && pkg === '@agentclientprotocol/codex-acp' ? { path: FAKE, version: '1' } : undefined), busy: () => false, lastError: () => undefined, lastFailure: () => undefined, update: async () => {}, dispose() {} }
  apply(ctx, { claude: false, codex }, {
    store,
    cliStore: undefined,
    find: name => (name === 'codex' ? '/fake/bin/codex' : undefined),
    signedIn: async (spec) => { probes.push(spec.key); return signedIn ?? undefined },
    ...(check ? { imageSetup: check } : {}),
  })
  return { acp: services.acpAgents, probes }
}

test('imageAccess: ready only for an installed, enabled, signed-in Codex; the sign-in is asked once', async () => {
  const ready = service()
  assert.deepEqual(await ready.acp.imageAccess(), { ready: true, signedIn: true })
  await ready.acp.imageAccess()
  assert.deepEqual(ready.probes, ['codex'])
  assert.deepEqual(await service({ signedIn: false }).acp.imageAccess(), { ready: false, signedIn: false })
  assert.deepEqual(await service({ signedIn: null }).acp.imageAccess(), { ready: false })
  assert.deepEqual(await service({ bins: false }).acp.imageAccess(), { ready: false })
  assert.deepEqual(await service({ codex: false }).acp.imageAccess(), { ready: false })
})

test('imageAccess: a Codex that does not take the lockdown is not ready, so the caller goes on to its next source', async () => {
  let checks = 0
  const refusing = service({ imageSetup: async () => { checks += 1; throw Object.assign(new Error('Codex does not know the feature view_image'), { kind: 'unsupported' }) } })
  assert.deepEqual(await refusing.acp.imageAccess(), { ready: false, signedIn: true, reason: 'unsupported', unsupported: true })
  await assert.rejects(refusing.acp.generateImage({ prompt: 'a fox' }), error => error.code === UNAVAILABLE && /could not turn off.*Update Automagik/.test(error.message))
  assert.equal(checks, 1, 'asked once, then remembered')
  // A check that ran out of time leaves Codex ready: the draw makes its own and says why.
  const slow = service({ imageSetup: async () => { throw Object.assign(new Error('timeout'), { kind: 'unreadable', passing: true }) } })
  assert.deepEqual(await slow.acp.imageAccess(), { ready: true, signedIn: true })
  // A check that fails another way is not ready either, with its reason; a draw asked for
  // all the same makes its own check, which answers for it.
  for (const kind of ['config', 'unreadable']) {
    const failing = service({ imageSetup: async () => { throw Object.assign(new Error('no'), { kind }) } })
    assert.deepEqual(await failing.acp.imageAccess(), { ready: false, signedIn: true, reason: kind })
  }
  // A signed-out Codex is never asked.
  const out = service({ signedIn: false, imageSetup: async () => { checks += 1 } })
  assert.deepEqual(await out.acp.imageAccess(), { ready: false, signedIn: false })
  assert.equal(checks, 1)
})

test('generateImage refuses a signed-out or missing Codex before it starts anything', async () => {
  await assert.rejects(service({ signedIn: false }).acp.generateImage({ prompt: 'a fox' }), error => error.code === SIGNED_OUT)
  await assert.rejects(service({ codex: false }).acp.generateImage({ prompt: 'a fox' }), error => error.code === UNAVAILABLE)
})

test('generateImage draws through the installed connector with the run\'s own config', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'acp-image-service-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const traceFile = join(home, 'trace.jsonl')
  const before = { mode: process.env.FAKE_IMAGE_MODE, trace: process.env.FAKE_IMAGE_TRACE }
  process.env.FAKE_IMAGE_MODE = 'ok'
  process.env.FAKE_IMAGE_TRACE = traceFile
  t.after(() => {
    for (const [key, value] of [['FAKE_IMAGE_MODE', before.mode], ['FAKE_IMAGE_TRACE', before.trace]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const made = await service().acp.generateImage({ prompt: 'a fox', size: '1024x1024' })
  assert.equal(made.base64, PNG)
  const start = readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.event === 'start')
  assert.equal(start.codexPath, '/fake/bin/codex')
  const { projects, ...config } = JSON.parse(start.codexConfig)
  assert.deepEqual(config, JSON.parse(imageConfig([], EXTRAS)))
  assert.deepEqual(Object.values(projects), [{ trust_level: 'trusted' }])
})


test('the home image table holds exactly the two filesystem grants', () => {
  const hex = 'a'.repeat(32)
  const config = chatProfilesConfig('/h', hex)
  assert.equal(config.split(`[permissions.automagik-image-${hex}.filesystem]\n`)[1], "':root' = 'deny'\n':workspace_roots' = 'read'\n")
  assert.deepEqual(IMAGE_PROFILE_GRANTS, { ':root': 'deny', ':workspace_roots': 'read' })
})

function homeProfile(run) {
  const profileModes = ensureChatProfiles(run.home, { platform: 'linux' })
  const spawn = run.spawn
  run.spawn = () => { const launch = spawn(); return { ...launch, profileModes, env: { ...launch.env, CODEX_HOME: run.home } } }
  return imageProfileFor(profileModes)
}

function observeScratchConfigs(t) {
  const observations = []
  const execFile = childProcess.execFile
  const mock = t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (args[0] === FAKE && args[1] === 'cli') {
      observations.push({ cwd: options.cwd, scratch: existsSync(options.cwd), project: lstatSync(join(options.cwd, '.codex'), { throwIfNoEntry: false }) !== undefined })
    }
    return execFile(command, args, options, callback)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  return observations
}

test('each draw uses the home profile before checks and waits for its mode acknowledgement', async (t) => {
  const observations = observeScratchConfigs(t)
  const run = setup('ok', { FAKE_IMAGE_PROFILE: 'delay' })
  const profile = homeProfile(run)
  t.after(run.cleanup)
  const logged = []
  const made = await drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch, log: line => logged.push(line) })
  assert.equal(made.isolated, true)
  assert.deepEqual(logged, [])
  const trace = run.trace()
  const session = trace.find(entry => entry.event === 'new-session')
  assert.match(session.profileId, /^automagik-image-[a-f0-9]{32}$/)
  assert.equal(session.profileId, profile.id)
  const config = JSON.parse(session.codexConfig)
  assert.equal(config.default_permissions, profile.id)
  assert.deepEqual(config.permissions[profile.id].filesystem, IMAGE_PROFILE_GRANTS)
  assert.ok(observations.length > 0)
  assert.deepEqual(observations, trace.filter(entry => entry.event === 'cli').map(entry => ({ cwd: entry.cwd, scratch: true, project: false })))
  for (const check of debugCalls(trace)) {
    assert.equal(check.cwd, session.cwd)
    assert.ok([sessionArgs(config), effectArgs(config, 'shell_tool'), effectArgs(config, 'view_image')]
      .some(candidate => sameArgs(candidate, check.args)), 'a debug check is the session config or a feature-effect proof')
  }
  const mode = `permission-profile:${session.profileId}`
  assert.deepEqual(trace.filter(entry => entry.event === 'mode').map(entry => entry.modeId), [mode])
  const ack = trace.find(entry => entry.event === 'mode-ack')
  const prompt = trace.find(entry => entry.event === 'prompt')
  assert.equal(ack.modeId, mode)
  assert.equal(prompt.modeId, mode)
  assert.ok(trace.indexOf(ack) < trace.indexOf(prompt))
  assert.equal(existsSync(join(session.cwd, '.codex')), false)
  assert.equal(existsSync(session.cwd), false)
})

test('sequential and concurrent draws share the home id and have fresh scratch folders', async (t) => {
  const run = setup('ok', { FAKE_IMAGE_PROFILE: 'offer' })
  homeProfile(run)
  t.after(run.cleanup)
  const draw = () => drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch })
  await draw()
  await Promise.all([draw(), draw()])
  const sessions = run.trace().filter(entry => entry.event === 'new-session')
  assert.equal(sessions.length, 3)
  assert.equal(new Set(sessions.map(entry => entry.profileId)).size, 1)
  assert.equal(new Set(sessions.map(entry => entry.cwd)).size, 3)
  for (const session of sessions) assert.equal(existsSync(session.cwd), false)
})

test('a missing or rejected profile falls back to read-only with one private warning and internal status', async (t) => {
  for (const [profile, reason] of [['', 'not offered'], ['reject', 'selection rejected']]) {
    const run = setup('ok', { FAKE_IMAGE_PROFILE: profile })
    homeProfile(run)
    t.after(run.cleanup)
    const logged = []
    const made = await drawImage({ spawn: run.spawn, prompt: 'private prompt', scratch: run.scratch, log: line => logged.push(line) })
    assert.equal(made.isolated, false)
    assert.deepEqual(Object.keys(made), ['base64', 'mimeType'])
    assert.equal(logged.length, 1)
    assert.ok(logged[0].includes(reason))
    assert.match(logged[0], /not isolated.*falling back to read-only/)
    assert.doesNotMatch(logged[0], /private|prompt|account|\/|automagik-image-/)
    const trace = run.trace()
    assert.equal(trace.filter(entry => entry.event === 'mode').at(-1).modeId, 'read-only')
    assert.equal(trace.find(entry => entry.event === 'prompt').modeId, 'read-only')
    assert.ok(trace.indexOf(trace.filter(entry => entry.event === 'mode-ack').at(-1)) < trace.indexOf(trace.find(entry => entry.event === 'prompt')))
  }
})

test('Invalid configuration on any successful check refuses the draw and removes its profile', async (t) => {
  const observations = observeScratchConfigs(t)
  for (const command of ['mcp', 'features', 'debug']) {
    observations.length = 0
    const run = setup('ok', { FAKE_INVALID_CONFIG: command })
    t.after(run.cleanup)
    await assert.rejects(drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch }), error => error.code === UNAVAILABLE && /configuration/.test(error.message))
    assert.ok(observations.length > 0)
    assert.deepEqual(observations, run.trace().filter(entry => entry.event === 'cli').map(entry => ({ cwd: entry.cwd, scratch: true, project: false })))
    assert.equal(run.trace().some(entry => entry.event === 'start'), false)
    assert.equal(existsSync(join(run.scratches[0], '.codex')), false)
    assert.equal(existsSync(run.scratches[0]), false)
  }
})

test('a failed or aborted profile draw removes the scratch config', async (t) => {
  for (const mode of ['failed', 'hang']) {
    const run = setup(mode, { FAKE_IMAGE_PROFILE: 'offer' })
    homeProfile(run)
    t.after(run.cleanup)
    const controller = new AbortController()
    const drawing = drawImage({ spawn: run.spawn, prompt: 'a fox', scratch: run.scratch, signal: controller.signal })
    let timer
    if (mode === 'hang') timer = setInterval(() => {
      if (run.trace().some(entry => entry.event === 'prompt')) controller.abort()
    }, 20)
    try {
      await assert.rejects(drawing, error => error.code === (mode === 'hang' ? STOPPED : FAILED))
    } finally { clearInterval(timer) }
    assert.ok(JSON.parse(run.trace().find(entry => entry.event === 'new-session').codexConfig).default_permissions)
    assert.equal(existsSync(join(run.scratches[0], '.codex')), false)
    assert.equal(existsSync(run.scratches[0]), false)
  }
})
