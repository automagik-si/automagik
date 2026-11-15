// Opt-in, credential-free real codex-acp + Codex. The local SSE peer supplies fixed tool
// calls, never a model. Assert the native image tool's actual bytes in its next model input.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { SessionFiles, sessionFileConfig, FILE_ALLOW } from '../src/host/session-files.js'
import { callArguments, mirrorTool } from '../src/host/tool.js'
const binary = process.env.AUTOMAGIK_TEST_CODEX
const acp = process.env.AUTOMAGIK_TEST_CODEX_ACP
const skip = !['linux', 'darwin'].includes(process.platform) || !binary || !acp
if (process.env.AUTOMAGIK_REQUIRE_SESSION_FILE_TEST === '1') assert.equal(skip, false, 'supply real native Codex and codex-acp paths')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

test('real native image: denied before consent, exact bytes on next user turn, sibling/sentinel denied', { skip, timeout: 60000 }, async t => {
  const root = realpathSync(mkdtempSync(join(process.env.AUTOMAGIK_TEST_SESSION_FILE_ROOT ?? tmpdir(), 'native-session-file-')))
  const runs = []
  t.after(async () => { for (const run of runs) await run.stop(); rmSync(root, { recursive: true, force: true }) })
  for (const dir of ['home', 'codex', 'ws', 'tmp', 'outside']) mkdirSync(join(root, dir))
  const approved = join(root, 'outside/approved.png'), sibling = join(root, 'outside/sibling.png'), sentinel = join(root, 'outside/sentinel.png')
  for (const file of [approved, sibling, sentinel]) writeFileSync(file, PNG)
  let steps = [], sequence = 0
  const inputs = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    let body; try { body = JSON.parse(raw) } catch { res.writeHead(404).end(); return }
    inputs.push(body.input)
    const action = steps.shift(), n = ++sequence, id = `resp_${n}`
    const item = action ? { type: 'custom_tool_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec', namespace: 'functions', input: `text(await tools.${action.name}(${JSON.stringify(action.args)}));`, status: 'completed' }
      : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('response.created', { response: { id, status: 'in_progress', output: [] } })
    emit('response.output_item.added', { output_index: 0, item }); emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const baseConfig = { model: 'gpt-6.1-sol', model_provider: 'isolated', model_providers: { isolated: { name: 'isolated fixed fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', requires_openai_auth: false } }, shell_environment_policy: { inherit: 'none' }, analytics: { enabled: false }, feedback: { enabled: false } }
  const env = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CODEX_PATH: binary,
    AUTOMAGIK_BOT_CLI_HOME: root, AUTOMAGIK_BOT_CLI_VERSION: '', TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'home/config'), XDG_CACHE_HOME: join(root, 'home/cache'), XDG_DATA_HOME: join(root, 'home/data'), NO_COLOR: '1', CODEX_CONFIG: JSON.stringify(baseConfig) }
  const profileModes = ensureChatProfiles(env.CODEX_HOME, { codexPath: binary })
  assert.ok(profileModes)
  const agent = { session: { id: 'native-chat', header: {}, snapshotEvents: () => [] } }
  let live
  let questions = 0
  const grants = new SessionFiles({ agent: () => agent, live: () => live, level: () => ({ sandbox: 'read-only', policy: 'ask' }),
    questions: () => ({ ask: async request => { questions++; return { answers: [{ id: request.questions[0].id, selected: [FILE_ALLOW] }] } } }),
    retire: () => { live.open = false; live.run.dispose(); live = undefined } })
  const owner = grants.owner(agent, 'acp-codex')
  const disk = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8')
  const start = async files => {
    const current = ensureChatProfiles(env.CODEX_HOME, { codexPath: binary })
    assert.deepEqual(current, profileModes)
    const setup = sessionFileConfig(env, { sandbox: 'read-only', files }, current)
    const run = new AgentRun({ command: process.execPath, args: [acp], env: setup.env, cwd: join(root, 'ws'), name: 'Codex', mcpServers: [], startMs: 15000, requestMs: 10000 })
    runs.push(run); await run.start()
    await run.setMode([setup.sessionFileMode ?? current['read-only']], { force: true })
    live = { run, dshAgent: agent, fileOwner: owner, fileSandbox: 'read-only', open: true, own: false, sessionFileEnabled: true, name: 'Codex', calls: new Set(), toolIds: new Map() }
    assert.equal(readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8'), disk, 'starting a process must not change shared config bytes')
    return live
  }
  const image = path => ({ name: 'view_image', args: { path } })
  const drain = async state => {
    for (;;) {
      const event = await state.run.next()
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'end') break
      if (event.type !== 'tool') continue
      const tool = state.run.tools.get(event.id), callId = `mirror-${event.id}`
      state.calls.add(callId); state.toolIds.set(callId, event.id)
      const mirror = mirrorTool({ runOf: () => state, sessionFiles: (...args) => grants.ask(...args), approval: () => ({ effectivePolicy: () => 'ask', request: () => { throw new Error('No generic approval') } }) })
      await mirror.execute(callArguments(tool), { agent, callId })
      if (owner.grant?.staged) return
    }
  }
  const first = await start([])
  steps = [image(approved), { name: 'request_permissions', args: { permissions: { file_system: { read: [approved] } }, reason: 'Read only the exact image for this chat' } }]
  first.run.prompt([{ type: 'text', text: 'Open the outside image.' }]).catch(() => {})
  await drain(first)
  assert.equal(questions, 1, JSON.stringify({ calls: [...first.run.tools.values()].map(tool => ({ id: tool.id, name: tool.structuredName, input: tool.rawInput, locations: tool.locations, result: tool.sessionFileResult })), input: inputs.at(-1)?.filter(row => row.type === 'custom_tool_call_output') }).slice(-7000)); assert.equal(owner.grant.staged, true)
  const before = JSON.stringify(inputs)
  assert.match(before, /ENOENT|not found|No such file/); assert.equal(before.includes(PNG.toString('base64')), false)
  await owner.grant.ready
  assert.equal(runs.length, 1, 'consent never starts a replacement')
  const files = await grants.activate(owner, { role: 'user', source: { kind: 'user' } })
  const next = await start(files)
  const at = inputs.length
  steps = [image(approved), image(sibling), image(sentinel)]
  next.run.prompt([{ type: 'text', text: 'Open only the approved image now.' }]).catch(() => {})
  await drain(next)
  const outputs = new Map(inputs.slice(at).flat().filter(row => row.type === 'custom_tool_call_output').map(row => [row.call_id, JSON.stringify(row.output)]))
  const toolCalls = new Map(inputs.slice(at).flat().filter(row => row.type === 'custom_tool_call').map(row => [row.call_id, row.input]))
  for (const path of [approved, sibling, sentinel]) {
    const call = [...toolCalls].find(([, input]) => input.includes(path))
    assert.ok(call, 'actual tool call for ' + path)
    const output = outputs.get(call[0])
    assert.ok(output, 'actual tool output for ' + path)
    if (path === approved) assert.ok(output.includes(PNG.toString('base64')), 'approved exact bytes')
    else { assert.match(output, /No such file|ENOENT|not found/); assert.equal(output.includes(PNG.toString('base64')), false) }
  }
  const after = JSON.stringify(inputs.slice(at))
  assert.ok(after.includes(PNG.toString('base64')), 'native view_image must return the fixture bytes, not merely acknowledge a profile')
  for (const path of [sibling, sentinel]) {
    assert.ok(after.includes(path)); assert.ok(after.includes(`unable to locate image at`), after.slice(-1800))
  }
  assert.equal(questions, 1)
  assert.equal(readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8'), disk, 'granted process must not change shared config bytes')
  // Same shared home and same offered id, separate live ACP process: no inherited read.
  const other = await start([])
  assert.equal(next.run.alive, true, 'the authorized process is still alive during the other-process control')
  let from = inputs.length
  steps = [image(approved)]
  other.run.prompt([{ type: 'text', text: 'Separate chat without consent.' }]).catch(() => {})
  await drain(other)
  let body = JSON.stringify(inputs.slice(from).flat().filter(row => row.type === 'custom_tool_call_output'))
  assert.match(body, /No such file|ENOENT|not found/); assert.equal(body.includes(PNG.toString('base64')), false)
  await other.run.stop(); await next.run.stop(); grants.clear(agent.session.id)
  const base = await start([])
  from = inputs.length; steps = [image(approved)]
  base.run.prompt([{ type: 'text', text: 'Base process after revocation.' }]).catch(() => {})
  await drain(base)
  body = JSON.stringify(inputs.slice(from).flat().filter(row => row.type === 'custom_tool_call_output'))
  assert.match(body, /No such file|ENOENT|not found/); assert.equal(body.includes(PNG.toString('base64')), false)
  assert.equal(readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8'), disk, 'all phases preserve shared config bytes')
})
