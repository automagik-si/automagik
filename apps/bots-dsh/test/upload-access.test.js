import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { install as uploads } from '../src/host/shared-uploads.js'
import { install as tools } from '../src/host/tools.js'
import { install as delivery } from '../src/host/delivery.js'
import { install as requests } from '../src/host/requests.js'
import { install as privacy } from '../src/host/private-bots.js'
import { install as imagegen } from '../src/host/imagegen.js'
import { install as turns } from '../src/host/turns.js'
import { fakeApproval } from './fake-ctx.js'
import { createEditInput } from '../src/host/image-input.js'

async function fixture(t, { withTools = true } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'upload-access-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const bots = Object.fromEntries(['a', 'b', 'test-private-bot', 'outside'].map(id => [id, { id, sessionId: id, name: `the test Bot ${id}`, createdAt: 1, ...(id === 'test-private-bot' ? { private: true, workDir: join(folder, 'private') } : {}) }]))
  await mkdir(bots['test-private-bot'].workDir)
  const rooms = { g: { id: 'g', name: 'test group', members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } } }
  const state = { bots, rooms, works: {}, exchanges: [], requests: {}, prefs: {} }
  const histories = new Map(), agents = new Map(), listeners = new Map(), books = new Map()
  const data = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const second = Buffer.concat([data, Buffer.from('another')])
  const refFor = (bytes, name) => ({ attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length, mediaType: 'image/png', width: 1, height: 1, name })
  const ref = refFor(data, 'picture.png'), other = refFor(second, 'other.png')
  const bytes = new Map([[ref.attachmentId, data], [other.attachmentId, second]])
  const storePath = ref => join(folder, 'store/objects', ref.attachmentId.slice(7, 9), ref.attachmentId.slice(7))
  const append = (id, row) => { const all = histories.get(id) ?? []; all.push(row); histories.set(id, all) }
  const agentOf = id => {
    if (!agents.has(id)) {
      const inbox = { nextStep: [], nextTurn: [], remove(key) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const i = list.findIndex(row => row.id === key)
          if (i >= 0) { list.splice(i, 1); return true }
        }
        return false
      } }
      agents.set(id, { id, session: { id }, inbox, ctx: { tools: { restrict: () => () => {} } },
        steer: row => { append(id, row); inbox.nextStep.push(row) }, followup: row => { append(id, row); inbox.nextTurn.push(row) } })
    }
    return agents.get(id)
  }
  const approval = fakeApproval()
  const opened = []
  let edits = 0
  const ctx = { on: (event, fn) => listeners.set(event, [...listeners.get(event) ?? [], fn]), effect() {}, inject() {},
    tools: { guard() {}, schemas: () => [] }, sessions: { flush: async () => {} },
    sessionController: { resolveAgent: async id => ({ agent: agentOf(id) }) },
    get: name => ({
      attachments: { readImage: async typed => { assert.equal(typed.name, undefined); return { ref: typed, data: bytes.get(typed.attachmentId) } }, imageHostPath: storePath },
      fs: { processPathFromHostPath: path => path },
      credentials: { readRecord: async () => undefined, resolve: async () => undefined },
      acpAgents: { imageAccess: async () => ({ ready: true }), generateImage: () => assert.fail('no draw'), editImage: async () => { edits++; return { base64: data.toString('base64') } } },
      approval,
    })[name] }
  const owners = new Map([['ga', { roomId: 'g', botId: 'a' }], ['gb', { roomId: 'g', botId: 'b' }]])
  // The real path of the deepest part that exists, with the rest after it, as folders.js does.
  const realBeyond = async path => {
    const rest = []
    for (let at = resolve(path); ; at = dirname(at)) {
      const found = await realpath(at).catch(() => undefined)
      if (found !== undefined) return join(found, ...rest)
      if (dirname(at) === at) return resolve(path)
      rest.unshift(basename(at))
    }
  }
  const rt = { ctx, state, home: join(folder, 'home'), dshHome: join(folder, 'dsh'), statePath: join(folder, 'state.json'), teamTools: [], live: new Map(), groupOwners: owners,
    botOf: id => bots[id], selfOf: id => bots[id]?.id ?? owners.get(id)?.botId,
    botOfSession: id => bots[id] ?? bots[owners.get(id)?.botId], chatOf: id => bots[id]?.sessionId,
    roomOf: id => rooms[id], findBot: name => Object.values(bots).find(bot => bot.name === name),
    workDirOf: ({ botId }) => bots[botId]?.workDir, teamFolder: () => folder, defaultTeamFolder: () => folder,
    sessionFolder: session => bots[session?.id]?.workDir ?? folder, realBeyond,
    groupSessionsOf: id => id === 'a' ? ['ga'] : id === 'b' ? ['gb'] : [], isMain: () => false,
    own: (value, key) => Object.hasOwn(value, key) ? value[key] : undefined,
    load: async () => {}, save: async () => {}, readOnly: () => undefined, warn() {},
    partsOf: id => typeof id === 'string' && bots[id] ? [{ sessionId: id }] : [],
    async *eventsBackwards(id) { for (const row of [...histories.get(id) ?? []].reverse()) yield { type: 'user/message', data: row } },
    ledger: { importer() {}, records: key => books.get(key) ?? [], append(key, row) { books.set(key, [...books.get(key) ?? [], row]) }, written: async () => {} },
    ensureCapabilities: async () => {}, statusOf: () => 'idle', workOf: () => undefined, upstreamOf: () => new Set(),
    sameWork: () => true, openWork: (...args) => opened.push(args), ownsWork: () => false, activeSessions: () => ({ running: [] }),
  }
  delivery(rt); requests(rt); privacy(rt)
  if (withTools) tools(rt)
  rt.hideBotUnusedTools = () => {} // Tool visibility is outside this forwarding fixture.
  uploads(rt); imagegen(rt)
  const guard = async (id, name, args, next = async () => 'ran', signal) => {
    const exec = { agent: agentOf(id), name, arguments: args, callId: 'test-call', signal }
    const handlers = listeners.get('tools/execute')
    const dispatch = i => i < handlers.length ? handlers[i](exec, () => dispatch(i + 1)) : next(exec)
    return dispatch(0)
  }
  const call = (id, name, args, signal) => guard(id, name, args, exec => rt.teamTools.find(tool => tool.name === name).execute(args, exec), signal)
  const rows = id => (histories.get(id) ?? []).map(row => ({ ...row, role: 'user' }))
  const person = (id, ref) => append(id, { source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] })
  const show = id => rt.sharedUploads.withPaths(rows(id), id, 'native')
  return { rt, bots, ref, other, folder, books, approval, opened, person, show, rows, guard, call, agentOf, append, storePath, edits: () => edits }
}

test('a name under the bots root that is no Bot folder is not refused', async t => {
  const f = await fixture(t, { withTools: false })
  // The bots root holds the team's own files and the shared working folders beside the Bots'
  // own folders, and a Bot's workspace is one of them: naming one of those is not opening a
  // picture. Only a Bot's own folder is another Bot's to keep out.
  for (const leaf of ['bots/workspace', 'bots/workspace/omni', 'bots/state.json', 'bots/bots.json', 'bots/learning/state.json']) {
    const candidate = join(f.folder, '.automagik', leaf)
    assert.equal(await f.guard('b', 'read', { file_path: candidate }), 'ran', leaf)
    assert.equal(await f.guard('b', 'bash', { command: `ls ${candidate}` }), 'ran', leaf)
    assert.equal(await f.guard('b', 'grep', { path: candidate, pattern: 'x' }), 'ran', leaf)
  }
  const own = join('.automagik', 'bots', 'a', 'uploads')
  await assert.rejects(f.guard('b', 'read', { file_path: join(f.folder, own, 'x.png') }), /another Bot's own folder/)
  await assert.rejects(f.guard('b', 'bash', { command: `ls ${own}` }), /another Bot's own folder/)
  assert.equal(await f.guard('a', 'bash', { command: `ls ${own}` }), 'ran')
})

test('a picture belongs only to its recipient; all direct tools and shell spellings enforce it', async t => {
  const f = await fixture(t, { withTools: false })
  f.person('a', f.ref)
  const shown = await f.show('a')
  const path = JSON.parse(shown[0].content[1].text.match(/ at (".*")\. Your/)[1])
  const hex = f.ref.attachmentId.slice(7)
  assert.equal(await f.rt.sharedUploads.holds('a', hex), true)
  assert.equal(await f.rt.sharedUploads.holds('b', hex), false)
  for (const candidate of [path, join(f.folder, '.automagik/uploads', hex, f.ref.name), f.storePath(f.ref)]) {
    for (const [name, args] of [['read', { file_path: candidate }], ['bash', { command: `cat ${JSON.stringify(candidate)}` }], ['custom_tool', { text: candidate }]]) {
      await assert.rejects(f.guard('b', name, args), /not sent to the test Bot b|another Bot's own folder/)
      assert.equal(await f.guard('a', name, args), 'ran')
    }
  }
  for (const name of ['read', 'write', 'edit', 'read_image']) await assert.rejects(f.guard('b', name, { file_path: path }), /not sent to the test Bot b|another Bot's own folder/)
  await assert.rejects(f.guard('b', 'str_replace_editor', { path }), /not sent to the test Bot b|another Bot's own folder/)
  for (const name of ['glob', 'grep']) {
    await assert.rejects(f.guard('b', name, { path: join(f.folder, '.automagik', 'bots', 'a') }), /another Bot's own folder/)
    await assert.rejects(f.guard('b', name, { path: join(f.folder, '.automagik/bots'), pattern: `${path}*` }), /not sent to the test Bot b|another Bot's own folder/)
    assert.equal(await f.guard('b', name, { path: join(f.folder, '.automagik/bots') }), 'ran')
  }
  for (const name of ['bash', 'pwsh', 'terminal_open', 'terminal_send']) await assert.rejects(f.guard('b', name, { command: `cat .automagik/bots/a/uploads/${hex}/picture.png` }), /not sent to the test Bot b|another Bot's own folder/)
  uploads(f.rt) // fresh in-memory grants; the own-chat directory is the durable holding.
  assert.equal(f.rt.sharedUploads.grantedTo('a').size, 0)
  assert.equal(await f.rt.sharedUploads.holds('a', hex), true)
  assert.equal(await f.rt.sharedUploads.holds('b', hex), false)
})

test('explicit forwards deliver the stored refs, merge unread pictures and bind replay identity', async t => {
  const f = await fixture(t)
  f.person('a', f.ref); f.person('a', f.other)
  const args = { to: f.bots.b.name, message: 'Describe this picture', images: [f.ref.name], request_id: 'forward' }
  assert.match(await f.call('a', 'message_bot', args), /with 1 picture\(s\)/)
  assert.match(await f.call('a', 'message_bot', args), /with 1 picture\(s\)/)
  assert.equal(f.rows('b').length, 1)
  const row = f.rows('b')[0]
  assert.equal(row.source.forwarded.v, 1)
  assert.deepEqual(row.content.find(block => block.type === 'image').attachment, f.ref)
  assert.match((await f.show('b'))[0].content.at(-1).text, /bots\/b\/uploads/)
  const resolved = await createEditInput({ rt: f.rt, ctx: f.rt.ctx }).resolve({ agent: f.agentOf('b') }, f.ref.name)
  assert.equal(resolved.name, f.ref.name)
  assert.equal(await f.rt.sharedUploads.holds('b', f.ref.attachmentId.slice(7)), true)
  await assert.rejects(f.call('a', 'message_bot', { ...args, images: [f.other.name] }), /already used for a different request/)
  assert.match(await f.call('a', 'message_bot', { ...args, request_id: 'merge', images: [f.other.name] }), /with 2 picture\(s\)/)
  const merged = f.rows('b').at(-1)
  assert.deepEqual(merged.content.filter(block => block.type === 'image').map(block => block.attachment.name).sort(), [f.other.name, f.ref.name].sort())
  assert.equal(merged.source.forwarded.v, 1)
  const count = f.rows('b').length
  assert.match((await f.call('a', 'message_bot', { ...args, request_id: 'absent', images: ['never-given.png'] })).text, /"never-given.png".*No picture the user attached in this chat matches that/)
  assert.equal(f.rows('b').length, count)
})

test('B cannot edit A’s picture until asking A and receiving an explicit forward', async t => {
  const f = await fixture(t)
  f.person('a', f.ref)
  assert.match(await f.call('b', 'generate_image', { image: f.ref.name, prompt: 'Make it blue' }), /No picture the user attached in this chat matches that/)
  assert.equal(f.edits(), 0)
  assert.equal(await f.rt.sharedUploads.holds('b', f.ref.attachmentId.slice(7)), false)
  await f.call('b', 'message_bot', { to: f.bots.a.name, message: 'Please forward the picture the person asked me to edit.', reply_to: 'user' })
  await f.call('a', 'message_bot', { to: f.bots.b.name, message: 'Here is the picture.', images: [f.ref.name] })
  await f.show('b')
  assert.match(await f.call('b', 'generate_image', { image: f.ref.name, prompt: 'Make it blue' }), /^Edited the image/)
  assert.equal(f.edits(), 1)
})

test('private pictures stay closed; only a deliberate image forward reaches a private Bot', async t => {
  const f = await fixture(t)
  f.person('test-private-bot', f.ref)
  const shown = await f.show('test-private-bot')
  assert.match(shown[0].content[1].text, /private\/\.automagik\/bots\/test-private-bot\/uploads/)
  const path = join(f.bots['test-private-bot'].workDir, '.automagik/bots/test-private-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  for (const id of ['a', 'b']) await assert.rejects(f.guard(id, 'read', { file_path: path }), /private Bot|not sent/)
  f.person('a', f.other)
  await assert.rejects(f.call('a', 'message_bot', { to: f.bots['test-private-bot'].name, message: 'ordinary message' }), /private Bot/)
  assert.match(await f.call('a', 'message_bot', { to: f.bots['test-private-bot'].name, message: 'Edit this picture', images: [f.other.name] }), /with 1 picture/)
  await f.show('test-private-bot')
  await assert.rejects(f.call('test-private-bot', 'message_bot', { to: f.bots.a.name, message: 'picture', images: [f.ref.name] }), /there is no Main Bot/)
  assert.equal(await f.rt.sharedUploads.holds('test-private-bot', f.other.attachmentId.slice(7)), true)
  assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), false)
  assert.equal((await createEditInput({ rt: f.rt, ctx: f.rt.ctx }).resolve({ agent: f.agentOf('test-private-bot') }, f.other.name)).ref.attachmentId, f.other.attachmentId)
})

test('group lines grant only shown members; channel relays, tool rows and handoffs grant nothing', async t => {
  const f = await fixture(t)
  for (const id of ['ga', 'gb']) {
    f.append(id, { source: { kind: 'bot', form: 'relay', role: 'room', roomId: 'g' }, content: [{ type: 'image', attachment: f.ref }] })
    assert.match((await f.show(id))[0].content[1].text, new RegExp(`bots/${id.slice(1)}/uploads`))
  }
  for (const id of ['a', 'b']) assert.equal(await f.rt.sharedUploads.holds(id, f.ref.attachmentId.slice(7)), true)
  assert.equal(await f.rt.sharedUploads.holds('outside', f.ref.attachmentId.slice(7)), false)
  await assert.rejects(f.guard('outside', 'read', { file_path: f.storePath(f.ref) }), /not sent/)
  assert.match(await f.call('ga', 'generate_image', { image: f.ref.name, prompt: 'edit' }), /group chat is not available/)
  const forwarded = await f.call('ga', 'message_bot', { to: f.bots.b.name, message: 'picture', images: [f.ref.name] })
  assert.deepEqual(forwarded, { text: 'Not sent: forward pictures from your own chat.', sent: false, reason: 'Not sent: forward pictures from your own chat.' })
  for (const row of [
    { role: 'user', source: { kind: 'bot', form: 'relay', role: 'request', senderSessionId: 'a' } },
    { role: 'user', source: { kind: 'user', handoff: true } },
    { role: 'tool', source: { kind: 'user' } },
    { role: 'user', source: { kind: 'bot', form: 'relay', forwarded: { v: 1 }, senderSessionId: 'missing' } },
  ]) {
    const rows = [{ ...row, content: [{ type: 'image', attachment: f.other }] }]
    assert.equal(await f.rt.sharedUploads.withPaths(rows, 'outside', 'native'), rows)
  }
  assert.equal(await f.rt.sharedUploads.holds('outside', f.other.attachmentId.slice(7)), false)
})

test('message_bot refuses more than four pictures without delivering anything', async t => {
  const f = await fixture(t)
  f.person('a', f.ref)
  assert.match((await f.call('a', 'message_bot', { to: f.bots.b.name, message: 'pictures', images: Array(5).fill(f.ref.name) })).text, /at most 4 pictures/)
  assert.equal(f.rows('b').length, 0)
})

test('a real Bot object resolves an earlier part by its saved picture path', async t => {
  const f = await fixture(t)
  f.person('earlier-part', f.ref)
  f.rt.partsOf = id => { assert.equal(id, 'a'); return [{ sessionId: 'earlier-part' }, { sessionId: 'a' }] }
  const path = join(f.folder, '.automagik/bots/a/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  const input = await createEditInput({ rt: f.rt, ctx: f.rt.ctx }).resolve({ agent: f.agentOf('a') }, path)
  assert.equal(input.ref.attachmentId, f.ref.attachmentId)
  await assert.rejects(createEditInput({ rt: { ...f.rt, partsOf: () => [{ sessionId: 'b' }] }, ctx: f.rt.ctx }).resolve({ agent: f.agentOf('b') }, path), /No picture the user attached in this chat matches that/)
})

test('a private forward records automatic Main Bot image authority without any Main Bot message', async t => {
  const f = await fixture(t)
  f.rt.isMain = id => id === 'outside'
  f.person('test-private-bot', f.ref); f.person('test-private-bot', f.other)
  const before = Date.now()
  assert.match(await f.call('test-private-bot', 'message_bot', { to: f.bots.a.name, message: 'Describe this one', images: [f.ref.name] }), /with 1 picture/)
  const records = f.books.get('pair-a-test-private-bot').filter(row => row.event === 'picture-forward-authorised')
  assert.equal(records.length, 1)
  const record = records[0]
  assert.deepEqual({ ...record, id: undefined, time: undefined }, {
    event: 'picture-forward-authorised', id: undefined, time: undefined,
    by: 'outside', from: 'test-private-bot', to: 'a', images: [f.ref.attachmentId], automatic: true,
  })
  assert.ok(record.time >= before && record.time <= Date.now())
  assert.equal(f.rows('outside').length, 0)
  assert.equal(f.rt.answerPictureForward, undefined)
  assert.equal(f.opened.length, 1, 'only the recipient work is opened')
  assert.equal(f.opened[0][1].to, 'a')
  assert.equal(f.approval.requests.length, 1, 'outbound text still requires the person’s approval')
  assert.match(f.approval.requests[0].reason, /Describe this one/)
  await f.show('a')
  assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), true)
  assert.equal(await f.rt.sharedUploads.holds('a', f.other.attachmentId.slice(7)), false)
})

for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
  test(`private forward text approval ${outcome} prevents delivery and image authorisation`, async t => {
    const f = await fixture(t)
    f.rt.isMain = id => id === 'outside'
    f.person('test-private-bot', f.ref)
    f.approval.request = async () => outcome
    await assert.rejects(f.call('test-private-bot', 'message_bot', { to: f.bots.a.name, message: 'Private words', images: [f.ref.name] }), /not done/)
    assert.equal(f.rows('a').length, 0)
    assert.equal(f.rows('outside').length, 0)
    assert.equal(f.books.size, 0)
  })
}

test('private recipient forces user audience even when reply_to asks for me', async t => {
  const f = await fixture(t)
  f.person('a', f.ref)
  const args = { to: f.bots['test-private-bot'].name, message: 'Edit this picture', images: [f.ref.name], reply_to: 'me', request_id: 'private-edit' }
  assert.match(await f.call('a', 'message_bot', args), /answer the user in its own chat; nothing comes back/)
  assert.equal(f.rows('test-private-bot')[0].source.audience, 'user')
  assert.equal(f.opened.length, 0, 'no work is opened to route the private reply back')
  assert.equal(f.agentOf('test-private-bot').inbox.nextStep.length, 0)
  assert.equal(f.agentOf('test-private-bot').inbox.nextTurn.length, 1)
  // Both spellings describe the same effective request.
  assert.match(await f.call('a', 'message_bot', { ...args, reply_to: 'user' }), /answer the user in its own chat/)
  assert.equal(f.rows('test-private-bot').length, 1)
  let listener
  const delivered = []
  const turnHost = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    isBotSession: () => true, roomOf: () => undefined,
    groupOwners: new Map(), chatOwners: new Map(),
    botOf: id => f.bots[id], selfOf: id => id, save: async () => {},
    deliver: async args => delivered.push(args), noteFailure() {}, warn() {}, switchJobs: () => [], userWrote() {},
  }
  turns(turnHost)
  let seq = 0
  const emit = (type, data) => listener({ id: 'test-private-bot' }, { type, seq: ++seq, data })
  emit('turn/start', { turn: 1 })
  emit('user/message', f.rows('test-private-bot')[0])
  emit('assistant/message', { message: { content: [{ type: 'text', text: 'The private answer' }] } })
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(delivered, [], 'the real turn handler never routes the private answer back')
  await assert.rejects(f.call('a', 'message_bot', { to: args.to, message: 'No pictures' }), /private Bot/)
})

test('group and ordinary relay rows never grant a private Bot pictures', async t => {
  const f = await fixture(t)
  for (const source of [
    { kind: 'bot', form: 'relay', role: 'room', roomId: 'g', forwarded: { v: 1 }, senderSessionId: 'a' },
    { kind: 'bot', form: 'relay', role: 'request', senderSessionId: 'a' },
    { kind: 'user', handoff: true },
    { kind: 'channel' },
  ]) {
    f.append('test-private-bot', { source, content: [{ type: 'image', attachment: f.other }] })
  }
  const rows = f.rows('test-private-bot')
  assert.equal(await f.rt.sharedUploads.withPaths(rows, 'test-private-bot', 'native'), rows)
  assert.equal(await f.rt.sharedUploads.holds('test-private-bot', f.other.attachmentId.slice(7)), false)
  await assert.rejects(lstat(join(f.bots['test-private-bot'].workDir, '.automagik')), { code: 'ENOENT' })
  assert.match(await f.call('test-private-bot', 'generate_image', { image: f.other.name, prompt: 'edit this' }), /No picture the user attached in this chat matches that/)
})

for (const target of ['b', 'test-private-bot']) test(`an explicit edit request grants ${target} exactly the selected picture`, async t => {
  const f = await fixture(t)
  f.person('a', f.ref); f.person('a', f.other)
  await f.show('a')
  for (const ref of [f.ref, f.other]) {
    assert.equal(await f.rt.sharedUploads.holds(target, ref.attachmentId.slice(7)), false)
    await assert.rejects(f.guard(target, 'read', { file_path: f.storePath(ref) }), /not sent/)
  }
  const path = join(f.folder, '.automagik/bots/a/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.match(await f.call('a', 'message_bot', { to: f.bots[target].name, message: 'The person asked you to edit this picture.', images: [path] }), /with 1 picture/)
  const shown = await f.show(target)
  const own = join(f.bots[target].workDir ?? f.folder, '.automagik/bots', target, 'uploads')
  assert.ok(shown.at(-1).content.at(-1).text.includes(JSON.stringify(join(own, f.ref.attachmentId.slice(7), f.ref.name))))
  assert.equal(await f.rt.sharedUploads.holds(target, f.ref.attachmentId.slice(7)), true)
  assert.equal(await f.rt.sharedUploads.holds(target, f.other.attachmentId.slice(7)), false)
  await assert.rejects(lstat(join(own, f.other.attachmentId.slice(7))), { code: 'ENOENT' })
  await assert.rejects(f.guard(target, 'read', { file_path: f.storePath(f.other) }), /not sent/)
  assert.match(await f.call(target, 'generate_image', { image: f.ref.name, prompt: 'Make it blue' }), /^Edited the image/)
  assert.match(await f.call(target, 'generate_image', { image: f.other.name, prompt: 'Make it blue' }), /No picture the user attached in this chat matches that/)
  assert.equal(f.edits(), 1)
})

test('no Main Bot means no outgoing private delivery, grant or disk copy', async t => {
  const f = await fixture(t)
  f.person('test-private-bot', f.ref)
  await f.show('test-private-bot')
  await assert.rejects(f.call('test-private-bot', 'message_bot', { to: f.bots.a.name, message: 'Forward this one', images: [f.ref.name] }), /there is no Main Bot/)
  assert.equal(f.rows('a').length, 0)
  assert.equal(f.rows('outside').length, 0)
  assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), false)
  await assert.rejects(lstat(join(f.folder, '.automagik/bots/a')), { code: 'ENOENT' })
})

test('paths and copied files alone cannot authorise an edit or a forward', async t => {
  const f = await fixture(t)
  f.person('a', f.ref)
  await f.show('a')
  // Even a disk copy made by the plugin is not a durable chat image block.
  const saved = await f.rt.sharedUploads.save(f.ref, { sessionId: 'b' })
  f.append('b', { source: { kind: 'user' }, content: [{ type: 'text', text: `Please edit ${saved.path}` }] })
  const input = createEditInput({ rt: f.rt, ctx: f.rt.ctx })
  await assert.rejects(input.resolve({ agent: f.agentOf('b') }, saved.path), /No picture the user attached in this chat matches that/)
  assert.match((await f.call('b', 'message_bot', { to: f.bots.outside.name, message: 'Edit this', images: [saved.path] })).text, /No picture the user attached in this chat matches that/)
  assert.equal(f.rows('outside').length, 0)
  assert.equal(f.edits(), 0)
})

test('a model switch keeps the earlier image only in its owning Bot’s parts', async t => {
  const f = await fixture(t)
  f.person('a', f.ref)
  await f.show('a')
  const originalOwner = f.rt.botOfSession
  f.rt.botOfSession = id => id === 'new-model-part' ? f.bots.a : originalOwner(id)
  f.rt.partsOf = id => id === 'a' ? [{ sessionId: 'a' }, { sessionId: 'new-model-part' }] : [{ sessionId: id }]
  const tool = f.rt.teamTools.find(tool => tool.name === 'generate_image')
  assert.match(await tool.execute({ image: f.ref.name, prompt: 'Make it blue' }, { agent: f.agentOf('new-model-part'), callId: 'after-model-switch' }), /^Edited the image/)
  assert.match(await f.call('b', 'generate_image', { image: f.ref.name, prompt: 'Make it blue' }), /No picture the user attached in this chat matches that/)
  assert.equal(f.edits(), 1)
})

test('unselected or unresolvable pictures make an entire forward unsent', async t => {
  const f = await fixture(t)
  f.person('a', f.ref)
  assert.match((await f.call('a', 'message_bot', { to: f.bots.b.name, message: 'Both pictures', images: [f.ref.name, f.other.name] })).text, /No picture the user attached in this chat matches that/)
  assert.equal(f.rows('b').length, 0)
  assert.equal(await f.rt.sharedUploads.holds('b', f.ref.attachmentId.slice(7)), false)
  await assert.rejects(lstat(join(f.folder, '.automagik/bots/b')), { code: 'ENOENT' })
})

test('saving, forwarding and refusing access never change permissions or read roots', async t => {
  const f = await fixture(t)
  f.bots.a.permission = 'read-only'
  f.bots.b.permission = 'read-only'
  f.rt.state.prefs.permission = 'read-only'
  const before = structuredClone({ bots: f.rt.state.bots, prefs: f.rt.state.prefs })
  const get = f.rt.ctx.get
  f.rt.ctx.get = name => {
    assert.ok(!['permissionPresets', 'sandboxPolicy', 'workingDirectory'].includes(name), 'upload access must not request a wider root or permission')
    return get(name)
  }
  f.person('a', f.ref)
  await f.show('a')
  await assert.rejects(f.guard('b', 'read', { file_path: f.storePath(f.ref) }), /not sent/)
  await f.call('a', 'message_bot', { to: f.bots.b.name, message: 'Describe this', images: [f.ref.name] })
  await f.show('b')
  assert.deepEqual({ bots: f.rt.state.bots, prefs: f.rt.state.prefs }, before)
})

test('forward selectors keep history ambiguity checks and accept sha256 without edit-type checks', async t => {
  const f = await fixture(t)
  f.person('a', f.ref)
  f.person('a', { ...f.other, name: f.ref.name, mediaType: 'image/gif' })
  const args = { to: f.bots.b.name, message: 'Describe the selected picture' }
  assert.match((await f.call('a', 'message_bot', { ...args, images: [f.ref.name] })).text, /More than one picture matches/)
  assert.equal(f.rows('b').length, 0)
  assert.match(await f.call('a', 'message_bot', { ...args, images: [f.other.attachmentId] }), /with 1 picture/)
  assert.deepEqual(f.rows('b').at(-1).content.filter(block => block.type === 'image').map(block => block.attachment.attachmentId), [f.other.attachmentId])
  assert.match(await f.call('b', 'generate_image', { image: f.other.attachmentId, prompt: 'Make it blue' }), /convert it to PNG or JPEG/)
  assert.equal(f.edits(), 0)
})

test('a child task’s upload and tool access belong to its owner Bot', async t => {
  const f = await fixture(t)
  const botOfSession = f.rt.botOfSession
  f.rt.botOfSession = id => id === 'test-subagent' ? f.bots.a : botOfSession(id)
  f.person('test-subagent', f.ref)
  const shown = await f.show('test-subagent')
  const path = join(f.folder, '.automagik/bots/a/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.ok(shown[0].content[1].text.includes(JSON.stringify(path)))
  assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), true)
  assert.equal(await f.rt.sharedUploads.holds('b', f.ref.attachmentId.slice(7)), false)
  assert.equal(await f.guard('test-subagent', 'read', { file_path: path }), 'ran')
  await assert.rejects(f.guard('b', 'read', { file_path: path }), /not sent to the test Bot b|another Bot's own folder/)
})

test('private senders retain unread request merging and each image forward has its own authority record', async t => {
  const f = await fixture(t)
  f.rt.isMain = id => id === 'outside'
  f.person('test-private-bot', f.ref); f.person('test-private-bot', f.other)
  let count = 0
  for (const ref of [f.ref, f.other]) {
    const args = { to: f.bots.a.name, message: 'Describe this picture', images: [ref.name], request_id: ref.name }
    count++
    assert.match(await f.call('test-private-bot', 'message_bot', args), new RegExp(`with ${count} picture`))
    const records = f.books.get('pair-a-test-private-bot').filter(row => row.event === 'picture-forward-authorised')
    assert.equal(records.length, count)
    assert.deepEqual(records.at(-1).images, [ref.attachmentId])
    assert.match(await f.call('test-private-bot', 'message_bot', args), new RegExp(`with ${count} picture`))
    assert.equal(f.books.get('pair-a-test-private-bot').filter(row => row.event === 'picture-forward-authorised').length, count)
  }
  assert.deepEqual(f.rows('a').at(-1).content.filter(block => block.type === 'image').map(block => block.attachment.attachmentId).sort(), [f.ref.attachmentId, f.other.attachmentId].sort())
  assert.equal(f.agentOf('a').inbox.nextStep.length, 1)
  assert.equal(f.rows('outside').length, 0)
})

for (const spelling of ['.automagik/bots/a', '.Automagik/Bots/a', '.AUTOMAGIK/BOTS/a']) {
  test(`guard ends Bot ids at shell punctuation and whitespace: ${spelling}`, async t => {
    const f = await fixture(t, { withTools: false })
    for (const command of [`cp -r ${spelling} /tmp/x`, `cp -r "${spelling}" /tmp/x`, `cat ${spelling}; true`, `cat ${spelling}|cat`, `cat ${spelling}\ntrue`]) {
      await assert.rejects(f.guard('b', 'bash', { command }), /not sent to the test Bot b|another Bot's own folder/)
      assert.equal(await f.guard('a', 'bash', { command }), 'ran')
    }
    // A longer id cannot be mistaken for the caller's id.
    // A name no Bot has is not a Bot folder: the guard ends the id exactly.
    for (const suffix of ['-other', '.other', '_other']) assert.equal(await f.guard('a', 'bash', { command: `cp -r ${spelling}${suffix} /tmp/x` }), 'ran')
  })
}

test('Bot ids fold like the file system off linux', async t => {
  const f = await fixture(t, { withTools: false })
  const candidate = join(f.folder, '.automagik', 'bots', 'Outside', 'uploads', 'notes.txt')
  // On linux the folder name is exact, so another case is not this Bot's folder.
  if (process.platform === 'linux') assert.equal(await f.guard('b', 'read', { file_path: candidate }), 'ran')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await assert.rejects(f.guard('b', 'read', { file_path: candidate }), /another Bot's own folder/)
    assert.equal(await f.guard('outside', 'read', { file_path: candidate }), 'ran')
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

for (const kind of ['tool-result', 'channel', 'handoff']) {
  test(`own-history ${kind} stored files remain readable before and after prompt projection`, async t => {
    const f = await fixture(t, { withTools: false })
    const content = [{ type: 'image', offloaded: true, attachment: f.ref }]
    const row = kind === 'tool-result' ? { role: 'tool', content }
      : { role: 'user', source: kind === 'channel' ? { kind: 'channel' } : { kind: 'user', handoff: true }, content }
    f.rt.partsOf = id => id === 'a' ? [{ sessionId: 'earlier-a' }, { sessionId: 'a' }] : [{ sessionId: id }]
    f.rt.eventsBackwards = async function* (id) {
      if (id === 'earlier-a') yield kind === 'tool-result' ? { type: 'tool/result', data: { message: row } } : { type: 'user/message', data: row }
    }
    assert.equal(await f.guard('a', 'read_image', { file_path: f.storePath(f.ref) }), 'ran')
    await assert.rejects(f.guard('b', 'read_image', { file_path: f.storePath(f.ref) }), /not sent/)
    assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), false)
    const rows = [row]
    assert.equal(await f.rt.sharedUploads.withPaths(rows, 'a', 'native'), rows)
    f.rt.eventsBackwards = async function* () {}
    assert.equal(await f.guard('a', 'read', { file_path: f.storePath(f.ref) }), 'ran')
    await assert.rejects(f.guard('b', 'read', { file_path: f.storePath(f.ref) }), /not sent/)
    assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), false, 'reading history grants no copy or edit access')
  })
}

test('making an empty own hash directory cannot unlock another Bot’s stored or ACP picture', async t => {
  const f = await fixture(t, { withTools: false })
  f.person('a', f.ref)
  await f.show('a')
  const hex = f.ref.attachmentId.slice(7)
  await mkdir(join(f.folder, '.automagik/bots/b/uploads', hex), { recursive: true })
  for (const path of [f.storePath(f.ref), join(f.folder, '.Automagik/Uploads', hex, f.ref.name)]) {
    await assert.rejects(f.guard('b', 'read', { file_path: path }), /not sent/)
  }
})

for (const spelling of [
  '.automagik/bots//a', '.automagik//bots/a', '.automagik/./bots/./a',
  '.automagik//././bots///./a', '.automagik/bots/"a"', ".automagik/'bots'/'a'",
]) {
  test(`shell guard normalizes Bot path segments: ${spelling}`, async t => {
    const f = await fixture(t, { withTools: false })
    for (const command of [`cat ${spelling}/uploads/picture.png`, `cp -r ${spelling} /tmp/test-copy`]) {
      await assert.rejects(f.guard('b', 'bash', { command }), /not sent to the test Bot b|another Bot's own folder/)
      assert.equal(await f.guard('a', 'bash', { command }), 'ran')
    }
  })
}

test('shell text collapses parent segments under the bots root', async t => {
  const f = await fixture(t, { withTools: false })
  const command = 'cat .automagik/bots/learning/../outside/notes.txt'
  for (const name of ['bash', 'pwsh', 'terminal_open', 'terminal_send']) {
    await assert.rejects(f.guard('b', name, { command }), /another Bot's own folder/)
    assert.equal(await f.guard('outside', name, { command }), 'ran')
  }
})

test('a later parent segment cannot erase an earlier protected path', async t => {
  const f = await fixture(t, { withTools: false })
  f.person('a', f.ref)
  await f.show('a')
  const hex = f.ref.attachmentId.slice(7)
  for (const command of [
    'cat .automagik/bots/outside/draft.md /../../scratch/dump',
    'cat .automagik/bots/outside/cache/draft.md # /../../..',
    'cat .automagik/bots/outside/draft.md; echo /../../..',
  ]) await assert.rejects(f.guard('b', 'bash', { command }), /another Bot's own folder/)
  for (const command of [
    `cat .automagik/uploads/${hex}/picture.png # /../..`,
    `cat objects/${hex.slice(0, 2)}/${hex} # /..`,
  ]) {
    await assert.rejects(f.guard('b', 'bash', { command }), /not sent to the test Bot b/)
    assert.equal(await f.guard('a', 'bash', { command }), 'ran')
  }
})

test('a link outside the bots root into another Bot folder is refused', async t => {
  const f = await fixture(t, { withTools: false })
  const target = join(f.folder, '.automagik', 'bots', 'outside')
  await mkdir(target, { recursive: true })
  const link = join(f.folder, 'outside-shortcut')
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const path = join(link, 'uploads', 'notes.txt')
  await assert.rejects(f.guard('b', 'read', { file_path: path }), /another Bot's own folder/)
  await assert.rejects(f.guard('b', 'grep', { path: link, pattern: 'notes' }), /another Bot's own folder/)
  assert.equal(await f.guard('outside', 'read', { file_path: path }), 'ran')
})

test('a relative glob pattern through a link outside the bots root is refused', async t => {
  const f = await fixture(t, { withTools: false })
  const working = join(f.folder, 'working')
  await mkdir(working)
  const target = join(f.folder, '.automagik', 'bots', 'outside')
  await mkdir(target, { recursive: true })
  const link = join(working, 'bot-folder-link')
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const pattern = 'bot-folder-link/cache/*.md'
  await assert.rejects(f.guard('b', 'glob', { path: working, pattern }), /another Bot's own folder/)
  assert.equal(await f.guard('outside', 'glob', { path: working, pattern }), 'ran')
  // The pattern alone names the folder too; with no private Bot to close the whole walk,
  // the link's target is what refuses it.
  delete f.rt.state.bots['test-private-bot']
  await assert.rejects(f.guard('b', 'glob', { pattern: 'working/bot-folder-link/cache/*.md' }), /another Bot's own folder/)
  assert.equal(await f.guard('outside', 'glob', { pattern: 'working/bot-folder-link/cache/*.md' }), 'ran')
})

test('shell store guards match object ids in home-relative, quoted and cd-relative paths', async t => {
  const f = await fixture(t, { withTools: false })
  f.person('a', f.ref)
  const hex = f.ref.attachmentId.slice(7), prefix = hex.slice(0, 2)
  const commands = [
    `cat ~/test-store/objects/${prefix}/${hex}`,
    `cd ${join(f.folder, 'store')} && cat objects/${prefix}/${hex}`,
    `cat objects/${prefix}/"${hex}"`,
    `cat 'objects'/'${prefix}'/'${hex}'`,
    `cat objects//${prefix}//././${hex}`,
    `cat .automagik/uploads/"${hex}"/picture.png`,
  ]
  for (const command of commands) await assert.rejects(f.guard('b', 'bash', { command }), /not sent/)
  await f.show('a')
  for (const command of commands) assert.equal(await f.guard('a', 'bash', { command }), 'ran')
})

// A link the Bot can make outside the team folder can lead into another Bot's own folder.
// The shell path check resolves the words a command spells out from the folder it runs in;
// it is best effort, not a fence, and the rows below keep both its refusals and its misses
// tested. `link` points at another Bot's folder, `mine` at this Bot's own, and `shared` and
// `team` at shared folders.
async function shellLinks(t) {
  const f = await fixture(t, { withTools: false })
  const work = await mkdtemp(join(tmpdir(), 'upload-access-work-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  f.bots.b.workDir = work
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  const other = join(f.folder, '.automagik', 'bots', 'a', 'uploads')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, 'notes.txt'), 'another Bot’s note')
  const own = join(f.folder, '.automagik', 'bots', 'b', 'uploads')
  await mkdir(own, { recursive: true })
  await writeFile(join(own, 'notes.txt'), 'this Bot’s note')
  const shared = join(f.folder, '.automagik', 'bots', 'workspace')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'notes.txt'), 'a shared note')
  // A path with spaces in both a parent segment and the link itself.
  const spaced = join(work, 'dir with spaces')
  await mkdir(spaced)
  const spacedLink = join(spaced, 'link with spaces')
  await writeFile(join(f.folder, 'team-notes.txt'), 'a team note')
  await symlink(other, join(work, 'link'), kind)
  await symlink(other, join(work, 'link with spaces'), kind)
  await symlink(other, join(spaced, 'plain-link'), kind)
  await symlink(other, spacedLink, kind)
  await symlink(own, join(work, 'mine'), kind)
  await symlink(shared, join(work, 'shared'), kind)
  await symlink(f.folder, join(work, 'team'), kind)
  // Links inside the shared workspace and inside the caller's own folder.
  const workspaceLink = join(shared, 'workspace-link')
  const ownRoot = join(f.folder, '.automagik', 'bots', 'b')
  const ownLink = join(ownRoot, 'own-link')
  await symlink(other, workspaceLink, kind)
  await symlink(other, ownLink, kind)
  return { f, work, spaced, spacedLink, shared, ownRoot, workspaceLink, ownLink }
}

test("a shell path word through a link into another Bot's folder is refused as best effort", async t => {
  const { f, work } = await shellLinks(t)
  for (const name of ['bash', 'pwsh', 'terminal_open', 'terminal_send']) {
    for (const command of ['cat link/x', 'cp link/x y', 'ls link/', `cat ${join(work, 'link/x')}`]) {
      await assert.rejects(f.guard('b', name, { command }), /another Bot's own folder/, `${name}: ${command}`)
    }
  }
  // The refusal keeps the guard's folder words and says what this check is not.
  await assert.rejects(f.guard('b', 'bash', { command: 'cat link/x' }), error => {
    assert.match(error.message, /^That is another Bot's own folder, which the test Bot b does not open\./)
    assert.match(error.message, /best-effort path check, not a fence/)
    return true
  })
})

test('the shell path check leaves the own folder, shared folders and parent walks open', async t => {
  const { f } = await shellLinks(t)
  for (const command of [
    'cat mine/notes.txt', 'cat shared/notes.txt', 'cat team/team-notes.txt',
    'cat sub/../notes.txt', 'cat ./notes/../notes.txt', 'ls ../',
  ]) assert.equal(await f.guard('b', 'bash', { command }), 'ran', command)
  // The owner's own folder, and a path that walks out of it harmlessly, stay open.
  assert.equal(await f.guard('a', 'bash', { command: 'cat .automagik/bots/a/uploads/notes.txt' }), 'ran')
  assert.equal(await f.guard('b', 'bash', { command: 'cat .automagik/bots/b/uploads/notes.txt' }), 'ran')
})

test('the shell path check misses what it documents, and the rows say so', async t => {
  const { f, work } = await shellLinks(t)
  await writeFile(join(work, 'open-link.sh'), 'cat link/x\n')
  // Known limits: the shell builds or expands these paths, the command changes folder
  // before it reads, or a script opens them on its own. Asserted so the limit is tested
  // rather than accidental, and so no change here starts claiming to be a fence.
  for (const command of [
    'cat "$LINK/x"',
    'cat "$(printf \'link/x\')"',
    'cd link && cat x',
    'cat link/*',
    'sh ./open-link.sh',
  ]) assert.equal(await f.guard('b', 'bash', { command }), 'ran', command)
})


test('quoted and escaped shell paths, paths with spaces and flag values are refused', async t => {
  const { f, spaced } = await shellLinks(t)
  const spacedTarget = join(spaced, 'link with spaces')
  const commands = [
    'cat "link/x"', "cat 'link/x'",
    'cat "link with spaces/x"', "cat 'link with spaces/x'",
    'cat "dir with spaces/plain-link/x"', "cat 'dir with spaces/plain-link/x'",
    'cat "dir with spaces/link with spaces/x"', "cat 'dir with spaces/link with spaces/x'",
    'cat "dir with spaces/link with spaces/file with spaces.txt"',
    'ls "link with spaces/"', 'ls "dir with spaces/link with spaces/"',
    'cat dir\\ with\\ spaces/link\\ with\\ spaces/x',
    `cat "${join(spacedTarget, 'x')}"`,
    'git --file=link/x', 'git --file="link with spaces/x"',
    'git --file="dir with spaces/link with spaces/x"',
    `git --file="${join(spacedTarget, 'x')}"`,
  ]
  for (const command of commands) {
    await assert.rejects(f.guard('b', 'bash', { command }), /another Bot's own folder/, command)
  }
})

test("a link inside the shared workspace or the caller's own folder is refused", async t => {
  const { f, workspaceLink, ownRoot, ownLink } = await shellLinks(t)
  for (const command of [`cat ${join(workspaceLink, 'x')}`, `cat ${join(ownLink, 'x')}`]) {
    await assert.rejects(f.guard('b', 'bash', { command }), /another Bot's own folder/, command)
  }
  // Relative to a command's own working folder inside each place.
  for (const [folder, link] of [[dirname(workspaceLink), workspaceLink], [ownRoot, ownLink]]) {
    f.bots.b.workDir = folder
    for (const command of [`cat ${basename(link)}/x`, `ls ${basename(link)}/`]) {
      await assert.rejects(f.guard('b', 'bash', { command }), /another Bot's own folder/, command)
    }
  }
})

test('a shell path word relative to the folder the command runs in is refused', async t => {
  const { f, work } = await shellLinks(t)
  const sub = join(work, 'sub')
  await mkdir(sub)
  f.bots.b.workDir = sub
  for (const command of ['cat ../link/x', 'ls ../link/', 'cat "../link/x"']) {
    await assert.rejects(f.guard('b', 'bash', { command }), /another Bot's own folder/, command)
  }
})
