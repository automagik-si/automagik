import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileHandleText, projectFilesToText } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { Backchannel } from '../src/host/backchannel.js'
import { levelOf } from '../src/host/tool.js'
import { admission, receiptPng } from './support/upload-admission.js'

const text = text => ({ type: 'text', text })
const png = receiptPng()
const txt = Buffer.from('Upload matrix: exact TXT bytes.\n')
const kinds = [
  { name: 'Codex', provider: 'acp-codex', sessionFiles: true },
  { name: 'Claude', provider: 'acp-claude', disableBuiltInTools: true },
  { name: 'Native', provider: 'acp-hermes', bridge: false },
]
const levels = [
  { name: 'Read only', preset: 'read-only', sandbox: 'read-only', policy: 'ask' },
  { name: 'Workspace', preset: 'workspace-write', sandbox: 'workspace-write', policy: 'ask' },
  { name: 'Auto', preset: 'auto', sandbox: 'danger-full-access', policy: 'ask' },
  { name: 'Full', preset: 'danger-full-access', sandbox: 'danger-full-access', policy: 'never' },
]
const sets = [
  { name: 'TXT', types: ['file'] },
  { name: 'PNG', types: ['image'] },
  { name: 'PNG + TXT', types: ['image', 'file'] },
]

// As in upload-content.test.js, keep admission, the adapter and AgentRun dispatch real.
// Substitute process startup and the bridge listener; no CLI or network service starts.
function host(t, kind, level, image) {
  const home = mkdtempSync(join(tmpdir(), 'acp-upload-matrix-'))
  const cwd = join(home, 'workspace')
  mkdirSync(cwd)
  const session = Session.create('upload-matrix')
  session.header = { ...session.header, cwd }
  const rows = []
  const dshAgent = {
    id: session.id, session,
    model: { current: () => ({ provider: kind.provider, model: 'default' }) },
    ctx: { tools: { register: () => () => {} } },
    followup: row => {
      rows.push(row)
      session.append('user/message', row, { surfaceOp: 'append' })
    },
  }
  // The same permission services as session-file-lifecycle.test.js drive levelOf.
  const approvals = []
  const questions = []
  const services = {
    approval: {
      effectivePolicy: () => level.policy,
      request: async request => { approvals.push(request); return 'denied' },
    },
    permissionPresets: { current: () => level.preset },
    sandboxPolicy: { resolve: () => ({ mode: level.sandbox }) },
    userQuestions: {
      ask: async request => { questions.push(request); return { answers: [] } },
    },
  }
  const ctx = { agents: { get: () => dshAgent }, get: key => services[key] }
  const launches = []
  const spec = {
    ...kind,
    modeFor: AGENTS[kind.provider].modeFor,
    ownMode: AGENTS[kind.provider].ownMode,
    spawn: context => {
      launches.push(context)
      // Model the launcher's feature acknowledgement, without a real Codex home.
      return { sessionFileEnabled: Boolean(context?.sessionFiles) }
    },
  }
  const backchannel = new Backchannel({ ctx })
  t.mock.method(backchannel, 'listen', async () => backchannel)
  t.mock.method(backchannel, 'urlFor', () => 'http://invalid/upload-matrix')
  const adapter = new AcpAdapter(ctx, new Map([[kind.provider, spec]]), {
    backchannel, dshTools: () => undefined,
  })
  const fileAsk = t.mock.method(adapter.sessionFiles, 'ask')
  const sent = []
  const modes = []
  const runs = []
  t.mock.method(AgentRun.prototype, 'start', async function () {
    this.child = {}
    this.sessionId = 'native-upload-matrix'
    this.init = { agentCapabilities: { promptCapabilities: { image } } }
    this.gone = new Promise(() => {})
    const available = ['read-only', 'workspace-write', 'agent', 'agent-full-access',
      'default', 'auto', 'bypassPermissions']
    this.modes = { availableModes: available.map(id => ({ id })) }
    this.conn = {
      prompt: async params => {
        sent.push(structuredClone(params))
        return { stopReason: 'end_turn' }
      },
      setSessionMode: async () => ({}),
    }
    const setMode = this.setMode.bind(this)
    this.setMode = async (ids, options) => {
      modes.push({ ids: structuredClone(ids), force: options?.force === true })
      return setMode(ids, options)
    }
    this.dispose = () => { this.disposed = true; this.letGo(true) }
    runs.push(this)
  })
  const { store, uploads, controller } = admission(home, dshAgent)
  services.attachments = store
  t.after(() => {
    adapter.dispose()
    backchannel.dispose()
    for (const run of runs) run.letGo(true)
    rmSync(home, { recursive: true, force: true })
  })
  const currentLevel = () => levelOf(services.approval, session,
    services.sandboxPolicy, services.permissionPresets)
  const step = messages => Array.fromAsync(adapter.stream({
    provider: kind.provider, model: 'default', sessionId: session.id, messages,
  }))
  const admit = async (types, wording) => {
    const attachments = []
    const content = []
    for (const type of types) {
      const ref = type === 'image'
        ? await store.saveImage({ data: png, mediaType: 'image/png' })
        : await store.saveFile({ data: txt, mediaType: 'text/plain', name: 'x.txt' })
      attachments.push({ type, ref })
      const receiptId = uploads.stage(dshAgent, { type, attachment: ref,
        ...(type === 'image' ? { encodedBytes: png.length } : {}) })
      content.push({ type: 'file', receiptId })
    }
    if (wording) content.push(text(wording))
    assert.deepEqual(await controller.prompt({ sessionId: session.id,
      requestId: randomUUID(), content, mode: 'queue' }, { kind: 'user' }), { accepted: true })
    return { attachments, messages: projectFilesToText(rows, ref => store.fileHostPath(ref)) }
  }
  return { cwd, session, adapter, spec, launches, sent, modes, approvals, questions,
    fileAsk, step, admit, currentLevel }
}

function assertTurn(h, chunks) {
  assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1)))
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.approvals, [])
  assert.deepEqual(h.questions, [])
  assert.equal(h.fileAsk.mock.callCount(), 0)
  assert.equal(chunks.some(chunk => chunk.block?.type === 'tool-call'), false)
  assert.equal(h.session.snapshotEvents().some(event => event.type === 'tool/call'), false)
}

function assertCopies(h, attachments, image, wording) {
  const expected = []
  for (const { type, ref } of attachments) {
    const leaf = type === 'file' ? ref.name : 'image.png'
    const path = join(h.cwd, '.automagik', 'uploads', ref.attachmentId.slice(7), leaf)
    assert.deepEqual(readFileSync(path), type === 'file' ? txt : png)
    assert.equal(statSync(path).mode & 0o777, 0o444)
    if (type === 'file') expected.push(text(fileHandleText(ref, path)))
    else {
      if (image) {
        expected.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
      }
      expected.push(text(`[Image "image.png" (${ref.width}x${ref.height}px, image/png): ` +
        `read-only copy saved at ${JSON.stringify(path)}. Read that path with your file tools ` +
        'when you need the file itself.]'))
    }
  }
  if (wording) expected.push(text(wording))
  assert.deepEqual(h.sent[0].prompt, expected)
  const ignore = join(h.cwd, '.automagik', 'uploads', '.gitignore')
  assert.equal(readFileSync(ignore, 'utf8'), '*\n')
}

for (const kind of kinds) {
  for (const level of levels) {
    for (const set of sets) {
      for (const image of [true, false]) {
        const label = `${kind.name} / ${level.name} / ${set.name} / image=${image}`
        test(`upload matrix: ${label}`, async t => {
          const h = host(t, kind, level, image)
          assert.deepEqual(h.currentLevel(), { sandbox: level.sandbox, policy: level.policy,
            auto: level.name === 'Auto', full: level.name === 'Full' })
          const { attachments, messages } = await h.admit(set.types)
          assertTurn(h, await h.step(messages))
          assertCopies(h, attachments, image)
          assert.equal(h.launches.length, 1)
          const live = h.adapter.live.get(h.session.id)
          assert.equal(Boolean(live.bridge), kind.disableBuiltInTools === true)
          assert.equal(live.run.spec.sessionMeta?.disableBuiltInTools,
            kind.disableBuiltInTools)
          const strict = kind.sessionFiles === true &&
            ['Read only', 'Workspace'].includes(level.name)
          const owner = h.adapter.sessionFiles.owners.get(h.session.id)
          assert.equal(Boolean(owner), strict,
            'exact-file consent belongs to strict Codex chats')
          if (strict) {
            assert.equal(live.fileOwner, owner)
            assert.equal(h.adapter.sessionFiles.valid(owner), true)
            assert.equal(owner.grant, undefined)
            assert.equal(owner.pending, undefined)
            assert.deepEqual(h.launches[0].sessionFiles, { sandbox: level.sandbox, files: [] })
          } else assert.equal(h.launches[0], undefined)
        })
      }
    }
  }
}

for (const kind of kinds) {
  for (const level of levels.filter(level => ['Auto', 'Full'].includes(level.name))) {
    for (const set of sets) {
      test(`${kind.name} / ${level.name}: ${set.name} preserves the plain turn mode`, async t => {
        const h = host(t, kind, level, true)
        const before = h.currentLevel()
        assertTurn(h, await h.step([{ role: 'user', source: { kind: 'user' },
          content: [text('Read the attachment.')] }]))
        const plainModes = structuredClone(h.modes)
        const plainMode = h.adapter.live.get(h.session.id).run.modes.currentModeId
        assert.equal(plainModes.length, 1)
        assert.equal(plainMode, h.spec.modeFor(before)[0])
        h.adapter.endSession(h.session.id)
        h.sent.length = 0
        h.modes.length = 0
        const { attachments, messages } = await h.admit(set.types, 'Read the attachment.')
        assertTurn(h, await h.step(messages))
        assertCopies(h, attachments, true, 'Read the attachment.')
        assert.deepEqual(h.modes, plainModes)
        assert.equal(h.adapter.live.get(h.session.id).run.modes.currentModeId, plainMode)
        assert.deepEqual(h.currentLevel(), before)
      })
    }
  }
}
