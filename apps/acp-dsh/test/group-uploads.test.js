import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, fileHandleText, projectFilesToText } from '@deepseek-ai/dsh-llm'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter, promptOf } from '../src/host/adapter.js'
import { replayBlocks } from '../src/host/switch.js'
import { admission, receiptPng } from './support/upload-admission.js'

const text = text => ({ type: 'text', text })
const png = receiptPng()
const txt = Buffer.from('ada group TXT marker\n')

// The upload-content host pattern, with distinct member and group Sessions.
async function host(t, name = 'x.txt') {
  const home = mkdtempSync(join(tmpdir(), 'acp-group-upload-'))
  const session = Session.create('member')
  session.header = { ...session.header, cwd: home }
  const group = Session.create('group')
  const agent = (session, rows = []) => ({
    id: session.id, session, rows,
    model: { current: () => ({ provider: 'acp-upload', model: 'default' }) },
    ctx: { tools: { register: () => () => {} } },
    followup: row => {
      rows.push(row)
      session.append('user/message', row, { surfaceOp: 'append' })
    },
  })
  const member = agent(session)
  const person = agent(group)
  const agents = new Map([[session.id, member], [group.id, person]])
  const owners = new Map([[session.id, { roomId: group.id, botId: 'a' }]])
  const room = { id: group.id, members: ['a'], sessions: { a: session.id } }
  const rooms = new Map([[room.id, room]])
  const { store, uploads, controller } = admission(home, person)
  const file = await store.saveFile({ data: txt, mediaType: 'text/plain', name })
  const image = await store.saveImage({ data: png, mediaType: 'image/png' })
  const content = [text('Read the markers'), ...[file, image].map((attachment, i) => ({
    type: 'file',
    receiptId: uploads.stage(person, {
      type: i === 0 ? 'file' : 'image', attachment,
      ...(i === 1 ? { encodedBytes: png.length } : {}),
    }),
  }))]
  await controller.prompt({ sessionId: group.id, requestId: randomUUID(), content,
    mode: 'queue' }, { kind: 'user' })
  const items = [file, image].map((ref, i) => ({ messageId: person.rows[0].id,
    blockIndex: i + 1, attachmentId: ref.attachmentId, kind: i === 0 ? 'file' : 'image' }))
  const relay = structuredClone(createUserMessage({
    source: { kind: 'bot', role: 'room', form: 'relay', roomId: group.id,
      uploads: { v: 1, roomId: group.id, items } },
    content: [text('Group OCR marker'), { type: 'file', attachment: file }],
  }))
  const services = { attachments: store,
    omniTeam: { groupOwners: owners, roomOf: id => rooms.get(id) } }
  const ctx = { agents: { get: id => agents.get(id) }, get: key => services[key] }
  const provider = { name: 'Upload test', spawn: () => assert.fail('No native process') }
  const adapter = new AcpAdapter(ctx, new Map([['acp-upload', provider]]))
  const run = new AgentRun({ name: 'Upload test' })
  run.child = {}
  run.sessionId = 'native-group-upload'
  run.init = { agentCapabilities: { promptCapabilities: { image: true } } }
  run.gone = new Promise(() => {})
  const sent = []
  run.conn = { prompt: async params => {
    sent.push(structuredClone(params))
    return { stopReason: 'end_turn' }
  } }
  run.dispose = () => run.letGo(true)
  const live = { run, provider: 'acp-upload', name: provider.name, dshAgent: member,
    asks: false, calls: new Set(), open: false }
  adapter.live.set(session.id, live)
  t.after(() => {
    adapter.dispose()
    run.letGo(true)
    rmSync(home, { recursive: true, force: true })
  })
  const step = async messages => Array.fromAsync(adapter.stream({ provider: 'acp-upload',
    model: 'default', sessionId: session.id, messages }))
  const project = () => structuredClone(projectFilesToText([relay], () => '/store/x.txt'))
  const save = () => member.followup(structuredClone(relay))
  const copyRoot = join(realpathSync(home), '.automagik', 'uploads')
  const path = (ref, leaf) => join(copyRoot, ref.attachmentId.slice(7), leaf)
  return { home, session, group, member, person, agents, owners, room, rooms, file, image,
    relay, services, sent, live, adapter, step, project, save, path, store }
}

function imageLine(h) {
  return text('[Image "image.png" (622x251px, image/png): read-only copy saved at ' +
    `${JSON.stringify(h.path(h.image, 'image.png'))}. ` +
    'Read that path with your file tools when you need the file itself.]')
}

for (const sameFile of [true, false]) {
  test(`verified group uploads copy exact bytes; existing file block ${sameFile}`, async t => {
    const h = await host(t)
    if (!sameFile) h.relay.content.pop()
    // The copy reference must come from the person's row, not relay metadata.
    if (sameFile) h.relay.content[1].attachment = { ...h.file, name: 'forged.txt' }
    h.save()
    const projected = h.project()
    const before = structuredClone(projected)
    assert.equal((await h.step(projected)).at(-1).reason.kind, 'stop')
    assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'),
      ...(sameFile ? [text('\n'), projected[0].content[1]] : []),
      text(fileHandleText(h.file, h.path(h.file, 'x.txt'))), imageLine(h)])
    assert.deepEqual(projected, before)
    for (const [ref, leaf, bytes] of [[h.file, 'x.txt', txt], [h.image, 'image.png', png]]) {
      const path = h.path(ref, leaf)
      assert.deepEqual(readFileSync(path), bytes)
      assert.equal(statSync(path).mode & 0o777, 0o444)
    }
    assert.equal(h.sent[0].prompt.some(block => block.type === 'image'), false)
  })
}

const faults = [
  'no person row', 'other attachment', 'other room', 'wrong owner', 'no owner',
  'deleted room', 'member removed', 'wrong session', 'no sessions', 'no members',
  'no room lookup', 'room lookup throws',
  'no team', 'no group', 'relay mismatch', 'no durable relay', 'durable relay not bot',
  'no uploads', 'wrong version', 'wrong role', 'retry', 'handoff', 'resumed', 'retried',
  'durable handoff', 'durable resumed', 'person bot', 'person handoff', 'offloaded image',
  'history', 'replay',
  'wrong block index', 'out of range block index', 'negative block index',
  'fractional block index', 'string block index', 'missing block index',
]
for (const fault of faults) {
  test(`group upload refuses ${fault} with unchanged text`, async t => {
    const h = await host(t)
    const original = h.person.rows[0]
    const indices = { 'wrong block index': 0, 'out of range block index': 3,
      'negative block index': -1, 'fractional block index': 1.5,
      'string block index': '1', 'missing block index': undefined }
    if (Object.hasOwn(indices, fault)) {
      for (const item of h.relay.source.uploads.items) {
        if (fault === 'missing block index') delete item.blockIndex
        else item.blockIndex = indices[fault]
      }
    }
    if (fault === 'no person row') h.group.deriveMessages = () => []
    if (fault === 'other attachment') {
      for (const item of h.relay.source.uploads.items) {
        item.attachmentId = `sha256:${'a'.repeat(64)}`
      }
    }
    if (fault === 'other room') h.relay.source.uploads.roomId = 'other'
    if (fault === 'wrong owner') h.owners.set(h.session.id, { roomId: 'other' })
    if (fault === 'no owner') h.owners.delete(h.session.id)
    if (fault === 'deleted room') h.rooms.delete(h.group.id)
    if (fault === 'member removed') h.room.members = []
    if (fault === 'wrong session') h.room.sessions.a = 'other'
    if (fault === 'no sessions') delete h.room.sessions
    if (fault === 'no members') delete h.room.members
    if (fault === 'no room lookup') delete h.services.omniTeam.roomOf
    if (fault === 'room lookup throws') {
      h.services.omniTeam.roomOf = () => { throw new Error('No room available') }
    }
    if (fault === 'no team') delete h.services.omniTeam
    if (fault === 'no group') h.agents.delete(h.group.id)
    if (fault === 'no uploads') delete h.relay.source.uploads
    if (fault === 'wrong version') h.relay.source.uploads.v = 2
    if (fault === 'wrong role') h.relay.source.role = 'post'
    if (['handoff', 'resumed', 'retried'].includes(fault)) h.relay.source[fault] = true
    if (fault.startsWith('person ')) {
      const source = fault === 'person bot' ? { kind: 'bot' } : { kind: 'user', handoff: true }
      h.group.deriveMessages = () => [{ ...original, source }]
    }
    if (fault === 'offloaded image') {
      h.relay.source.uploads.items.shift()
      h.group.deriveMessages = () => [{ ...original, content: original.content.map(block =>
        block.type === 'image' ? { ...block, offloaded: true } : block) }]
    }
    if (fault !== 'no durable relay') h.save()
    const projected = h.project()
    if (fault === 'relay mismatch') projected[0].source.uploads.items.reverse()
    if (fault.startsWith('durable ')) {
      const saved = h.session.deriveMessages()[0]
      const source = { ...saved.source }
      if (fault === 'durable relay not bot') source.kind = 'user'
      if (fault === 'durable handoff') source.handoff = true
      if (fault === 'durable resumed') source.resumed = true
      h.session.deriveMessages = () => [{ ...saved, source }]
    }
    let messages = projected
    if (fault === 'retry') {
      messages = [...projected, createUserMessage({ source: { kind: 'retry' }, content: [] })]
    }
    const next = createUserMessage({ source: { kind: 'user' }, content: [text('next')] })
    if (fault === 'history') {
      messages = [...projected, { role: 'assistant', content: [text('done')] }, next]
    }
    let replay = []
    if (fault === 'replay') {
      replay = replayBlocks(projected, { redact: value => value, from: 'native', to: 'ACP' })
      h.live.replay = replay
      messages = [next]
    }
    let reads = 0
    h.services.attachments = {
      readImage: () => { reads++; throw new Error('No image read allowed') },
      readFileStream: () => { reads++; throw new Error('No file read allowed') },
    }
    assert.equal((await h.step(messages)).at(-1).reason.kind, 'stop')
    assert.deepEqual(h.sent[0].prompt, [...replay, ...promptOf(messages)])
    assert.equal(reads, 0)
    assert.equal(readdirSync(h.home).includes('.automagik'), false)
  })
}

test('one invalid pointer does not grant a copy or suppress a verified item', async t => {
  const h = await host(t)
  h.relay.source.uploads.items[0].attachmentId = `sha256:${'a'.repeat(64)}`
  h.save()
  const projected = h.project()
  await h.step(projected)
  assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'), text('\n'),
    projected[0].content[1], imageLine(h)])
  assert.deepEqual(readFileSync(h.path(h.image, 'image.png')), png)
  assert.deepEqual(readdirSync(join(h.home, '.automagik', 'uploads')).sort(),
    ['.gitignore', h.image.attachmentId.slice(7)].sort())
})


test('a changed projection keeps its text and appends the verified file handle', async t => {
  const h = await host(t)
  h.save()
  const projected = h.project()
  projected[0].content.push(text('extra context'))
  await h.step(projected)
  assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'), text('\n'),
    projected[0].content[1], text('\n'), text('extra context'),
    text(fileHandleText(h.file, h.path(h.file, 'x.txt'))), imageLine(h)])
})

test('an equal-length projection keeps unrelated text and appends the copy', async t => {
  const h = await host(t)
  h.save()
  const projected = h.project()
  projected[0].content[1] = text('unrelated context')
  await h.step(projected)
  assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'), text('\n'),
    text('unrelated context'), text(fileHandleText(h.file, h.path(h.file, 'x.txt'))),
    imageLine(h)])
})

test('a projected handle without a path is replaced by its copy', async t => {
  const h = await host(t)
  h.save()
  const projected = h.project()
  projected[0].content[1] = text(fileHandleText(h.file, undefined))
  await h.step(projected)
  assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'),
    text(fileHandleText(h.file, h.path(h.file, 'x.txt'))), imageLine(h)])
})

for (const suffix of ['\nKEEP THIS CONTEXT', '']) {
  test(`a handle with extra context is preserved; trailing context ${!!suffix}`, async t => {
    const h = await host(t)
    h.save()
    const projected = h.project()
    const handle = projected[0].content[1].text
    projected[0].content[1] = text(suffix ? handle + suffix : handle.replace(
      JSON.stringify('/store/x.txt'), '"/store/x.txt" KEEP THIS CONTEXT'))
    await h.step(projected)
    assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'), text('\n'),
      projected[0].content[1], text(fileHandleText(h.file, h.path(h.file, 'x.txt'))),
      imageLine(h)])
  })
}

for (const name of ['report was uploaded.txt', 'report "quoted".txt']) {
  test(`the complete handle for ${name} is replaced exactly once`, async t => {
    const h = await host(t, name)
    h.save()
    const projected = h.project()
    projected[0].content[1] = text(fileHandleText(h.file, '/store/"quoted".txt'))
    await h.step(projected)
    const prompt = h.sent[0].prompt
    assert.equal(prompt.length, 3)
    assert.deepEqual(prompt[0], text('Group OCR marker'))
    assert.match(prompt[1].text, /verbatim read-only copy saved at/)
    const folder = join(h.home, '.automagik', 'uploads', h.file.attachmentId.slice(7))
    const [leaf] = readdirSync(folder)
    const path = h.path(h.file, leaf)
    assert.deepEqual(prompt[1], text(fileHandleText(h.file, path)))
    assert.deepEqual(readFileSync(path), txt)
    assert.deepEqual(prompt[2], imageLine(h))
  })
}

test('identical bytes with different names keep both occurrences and paths', async t => {
  const h = await host(t, 'a.txt')
  const second = await h.store.saveFile({ data: txt, mediaType: 'text/plain', name: 'b.txt' })
  assert.equal(second.attachmentId, h.file.attachmentId)
  const original = h.person.rows[0]
  h.group.deriveMessages = () => [{ ...original,
    content: [...original.content, { type: 'file', attachment: second }] }]
  const first = h.relay.source.uploads.items[0]
  h.relay.source.uploads.items = [first, { ...first, blockIndex: original.content.length }]
  // Reverse the relay order so a hash alone cannot identify the replacement slot.
  h.relay.content = [text('Group OCR marker'),
    { type: 'file', attachment: second }, { type: 'file', attachment: h.file }]
  h.save()
  await h.step(h.project())
  assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'),
    text(fileHandleText(second, h.path(second, 'b.txt'))),
    text(fileHandleText(h.file, h.path(h.file, 'a.txt')))])
  for (const ref of [h.file, second]) {
    assert.deepEqual(readFileSync(h.path(ref, ref.name)), txt)
  }
})

for (const separate of [false, true]) {
  test(`repeated file handles are each replaced once; separate group rows ${separate}`, async t => {
    const h = await host(t)
    const original = h.person.rows[0]
    const next = { ...structuredClone(original), id: randomUUID() }
    if (separate) h.group.append('user/message', next, { surfaceOp: 'append' })
    else h.group.deriveMessages = () => [{ ...original,
      content: [...original.content, { type: 'file', attachment: h.file }] }]
    const first = h.relay.source.uploads.items[0]
    h.relay.source.uploads.items = [first,
      { ...first, messageId: separate ? next.id : original.id,
        blockIndex: separate ? first.blockIndex : original.content.length }]
    if (separate) h.relay.content.push(text('Second group message'))
    h.relay.content.push({ type: 'file', attachment: h.file })
    h.save()
    await h.step(h.project())
    const copy = text(fileHandleText(h.file, h.path(h.file, 'x.txt')))
    assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'), copy,
      ...(separate ? [text('Second group message')] : []), copy])
  })
}

test('a pointer without another projected handle appends its copy once', async t => {
  const h = await host(t)
  const first = h.relay.source.uploads.items[0]
  h.relay.source.uploads.items = [first, { ...first }]
  h.save()
  await h.step(h.project())
  const copy = text(fileHandleText(h.file, h.path(h.file, 'x.txt')))
  assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'), copy, copy])
})

for (const change of ['member removed', 'deleted room']) {
  for (const during of ['copy', 'final gate']) {
    test(`${change} during ${during} stops the upload prompt`, async t => {
      const h = await host(t)
      h.save()
      const remove = () => {
        if (change === 'member removed') h.room.members = []
        else h.rooms.delete(h.group.id)
      }
      let changed = false
      if (during === 'copy') {
        h.services.attachments = { async *readFileStream() {
          yield txt.subarray(0, 1)
          remove()
          changed = true
          yield txt.subarray(1)
        } }
      } else {
        h.adapter.heldBack = async () => {
          if (readdirSync(h.home).includes('.automagik')) {
            remove()
            changed = true
          }
        }
      }
      const result = (await h.step(h.project())).at(-1)
      assert.equal(changed, true)
      assert.equal(result.reason.kind, 'error')
      assert.equal(result.reason.failure.code, 'acp_upload_content')
      assert.match(result.reason.failure.message, /turn changed before the prompt/)
      assert.equal(h.sent.length, 0)
    })
  }
}

async function movedHost(t) {
  const h = await host(t)
  const first = Session.create('group-first-part')
  h.agents.set(first.id, { id: first.id, session: first })
  h.rooms.delete(h.room.id)
  h.room.id = first.id
  h.room.sessionId = h.group.id
  h.room.parts = [{ sessionId: first.id }]
  h.rooms.set(h.room.id, h.room)
  h.owners.set(h.session.id, { roomId: h.room.id, botId: 'a' })
  h.relay.source.roomId = h.room.id
  h.relay.source.uploads.roomId = h.room.id
  h.services.omniTeam.sessionOfRoom = room => {
    assert.equal(room, h.room)
    return room.sessionId
  }
  return { ...h, first }
}

function loadedEarlierPart(h, row) {
  const earlier = Session.create('group-earlier-part')
  earlier.append('user/message', row, { surfaceOp: 'append' })
  h.agents.set(earlier.id, { id: earlier.id, session: earlier })
  h.room.parts.push({ sessionId: earlier.id })
  return earlier
}

async function assertMovedCopies(h, preserveHandle = false) {
  h.save()
  const projected = h.project()
  const before = structuredClone(projected)
  assert.equal((await h.step(projected)).at(-1).reason.kind, 'stop')
  assert.deepEqual(h.sent[0].prompt, [text('Group OCR marker'),
    ...(preserveHandle ? [text('\n'), projected[0].content[1]] : []),
    text(fileHandleText(h.file, h.path(h.file, 'x.txt'))), imageLine(h)])
  assert.deepEqual(projected, before)
  for (const [ref, leaf, bytes] of [[h.file, 'x.txt', txt], [h.image, 'image.png', png]]) {
    const path = h.path(ref, leaf)
    assert.deepEqual(readFileSync(path), bytes)
    assert.equal(statSync(path).mode & 0o777, 0o444)
  }
  assert.equal(h.sent[0].prompt.some(block => block.type === 'image'), false)
}

async function assertMovedTextOnly(h) {
  h.save()
  const projected = h.project()
  const before = structuredClone(projected)
  let reads = 0
  h.services.attachments = {
    readImage: () => { reads++; throw new Error('No image read allowed') },
    readFileStream: () => { reads++; throw new Error('No file read allowed') },
  }
  assert.equal((await h.step(projected)).at(-1).reason.kind, 'stop')
  assert.deepEqual(h.sent[0].prompt, promptOf(projected))
  assert.deepEqual(projected, before)
  assert.equal(reads, 0)
  assert.equal(readdirSync(h.home).includes('.automagik'), false)
}

test('after a move current-part uploads copy exact bytes and read-only paths', async t => {
  const h = await movedHost(t)
  h.relay.content[1].attachment = { ...h.file, name: 'forged.txt' }
  await assertMovedCopies(h, true)
})

test('after a move uploads copy using room.sessionId without sessionOfRoom', async t => {
  const h = await movedHost(t)
  delete h.services.omniTeam.sessionOfRoom
  await assertMovedCopies(h)
})

test('after a move uploads copy from a loaded earlier part distinct from room.id', async t => {
  const h = await movedHost(t)
  const earlier = loadedEarlierPart(h, structuredClone(h.person.rows[0]))
  h.group.deriveMessages = () => []
  assert.notEqual(earlier.id, h.room.id)
  assert.equal(h.first.deriveMessages().length, 0)
  await assertMovedCopies(h)
})

test('after a move one relay copies uploads from current and loaded earlier parts', async t => {
  const h = await movedHost(t)
  const original = h.person.rows[0]
  const earlierRow = { ...structuredClone(original), id: randomUUID(),
    content: [text('Earlier upload marker'), structuredClone(original.content[2])] }
  loadedEarlierPart(h, earlierRow)
  h.group.deriveMessages = () => [{ ...original, content: original.content.slice(0, 2) }]
  h.relay.source.uploads.items[1] = { ...h.relay.source.uploads.items[1],
    messageId: earlierRow.id, blockIndex: 1 }
  await assertMovedCopies(h)
})

test('after a move an unloaded earlier part keeps text unchanged without copying', async t => {
  const h = await movedHost(t)
  const earlier = loadedEarlierPart(h, structuredClone(h.person.rows[0]))
  h.group.deriveMessages = () => []
  h.agents.delete(earlier.id)
  await assertMovedTextOnly(h)
})

for (const fault of ['offloaded image', 'kind mismatch']) {
  test(`after a move first matching current row wins despite ${fault}`, async t => {
    const h = await movedHost(t)
    const original = h.person.rows[0]
    loadedEarlierPart(h, structuredClone(original))
    h.relay.source.uploads.items = [h.relay.source.uploads.items[1]]
    h.group.deriveMessages = () => [{ ...original, content: original.content.map(block =>
      block.type === 'image' ? { ...block,
        ...(fault === 'offloaded image' ? { offloaded: true } : { type: 'file' }) } : block) }]
    await assertMovedTextOnly(h)
  })
}

for (const fault of ['member removed', 'wrong session', 'deleted room']) {
  test(`after a move ownership loss from ${fault} keeps text unchanged`, async t => {
    const h = await movedHost(t)
    if (fault === 'member removed') h.room.members = []
    if (fault === 'wrong session') h.room.sessions.a = 'other-session'
    if (fault === 'deleted room') h.rooms.delete(h.room.id)
    await assertMovedTextOnly(h)
  })
}

test('after a move uploads cannot come from a loaded Session outside the room record', async t => {
  const h = await movedHost(t)
  const outside = Session.create('outside-group')
  const row = { ...structuredClone(h.person.rows[0]), id: randomUUID() }
  outside.append('user/message', row, { surfaceOp: 'append' })
  h.agents.set(outside.id, { id: outside.id, session: outside })
  for (const item of h.relay.source.uploads.items) item.messageId = row.id
  await assertMovedTextOnly(h)
})
