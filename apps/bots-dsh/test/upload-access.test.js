import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  const rt = { ctx, state, home: join(folder, 'home'), dshHome: join(folder, 'dsh'), statePath: join(folder, 'state.json'), teamTools: [], live: new Map(), groupOwners: owners,
    botOf: id => bots[id], selfOf: id => bots[id]?.id ?? owners.get(id)?.botId,
    botOfSession: id => bots[id] ?? bots[owners.get(id)?.botId], chatOf: id => bots[id]?.sessionId,
    roomOf: id => rooms[id], findBot: name => Object.values(bots).find(bot => bot.name === name),
    workDirOf: ({ botId }) => bots[botId]?.workDir, teamFolder: () => folder, defaultTeamFolder: () => folder,
    sessionFolder: session => bots[session?.id]?.workDir ?? folder, realBeyond: async path => resolve(path),
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
      await assert.rejects(f.guard('b', name, args), /not sent to the test Bot b/)
      assert.equal(await f.guard('a', name, args), 'ran')
    }
  }
  for (const name of ['read', 'write', 'edit', 'read_image']) await assert.rejects(f.guard('b', name, { file_path: path }), /not sent/)
  await assert.rejects(f.guard('b', 'str_replace_editor', { path }), /not sent/)
  for (const name of ['glob', 'grep']) {
    await assert.rejects(f.guard('b', name, { path: join(f.folder, '.automagik/bots/a') }), /not sent/)
    await assert.rejects(f.guard('b', name, { path: join(f.folder, '.automagik/bots'), pattern: `${path}*` }), /not sent/)
    assert.equal(await f.guard('b', name, { path: join(f.folder, '.automagik/bots') }), 'ran')
  }
  for (const name of ['bash', 'pwsh', 'terminal_open', 'terminal_send']) await assert.rejects(f.guard('b', name, { command: `cat .automagik/bots/a/uploads/${hex}/picture.png` }), /not sent/)
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
  assert.match(await f.call('a', 'message_bot', { ...args, request_id: 'absent', images: ['never-given.png'] }), /"never-given.png".*No picture the user attached in this chat matches that/)
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
  assert.equal(await f.call('ga', 'message_bot', { to: f.bots.b.name, message: 'picture', images: [f.ref.name] }), 'Not sent: forward pictures from your own chat.')
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
  assert.match(await f.call('a', 'message_bot', { to: f.bots.b.name, message: 'pictures', images: Array(5).fill(f.ref.name) }), /at most 4 pictures/)
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
  assert.match(await f.call('b', 'message_bot', { to: f.bots.outside.name, message: 'Edit this', images: [saved.path] }), /No picture the user attached in this chat matches that/)
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
  assert.match(await f.call('a', 'message_bot', { to: f.bots.b.name, message: 'Both pictures', images: [f.ref.name, f.other.name] }), /No picture the user attached in this chat matches that/)
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
  assert.match(await f.call('a', 'message_bot', { ...args, images: [f.ref.name] }), /More than one picture matches/)
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
  await assert.rejects(f.guard('b', 'read', { file_path: path }), /not sent/)
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
      await assert.rejects(f.guard('b', 'bash', { command }), /not sent/)
      assert.equal(await f.guard('a', 'bash', { command }), 'ran')
    }
    // A longer id cannot be mistaken for the caller's id.
    for (const suffix of ['-other', '.other', '_other']) await assert.rejects(f.guard('a', 'bash', { command: `cp -r ${spelling}${suffix} /tmp/x` }), /not sent/)
  })
}

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
      await assert.rejects(f.guard('b', 'bash', { command }), /not sent/)
      assert.equal(await f.guard('a', 'bash', { command }), 'ran')
    }
  })
}

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
