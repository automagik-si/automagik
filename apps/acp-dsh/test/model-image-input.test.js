import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply as applyFs, Config as FsConfig } from '@deepseek-ai/dsh-tool-fs'
import { apply } from '../index.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'

const model = {
  id: 'haiku', name: 'Haiku', description: 'A test model',
  reasoning: { efforts: [{ id: 'low', name: 'Low' }] },
}

function adapterOf(t) {
  const catalog = {
    model: async id => id === model.id ? model : undefined,
    models: async () => [{ ...model, inputModalities: ['text', 'image'] }],
    dispose() {},
  }
  const agents = new Map(Object.entries(AGENTS).map(([id, spec]) => [id, { ...spec, catalog }]))
  const adapter = new AcpAdapter({}, agents)
  t.after(() => adapter.dispose())
  return adapter
}

for (const id of ['haiku', 'unknown']) {
  test(`Claude resolves ${id} with image input and a fresh modalities array`, async t => {
    const adapter = adapterOf(t)
    const first = await adapter.resolveModel('acp-claude', id)
    const second = await adapter.resolveModel('acp-claude', id)
    assert.deepEqual(first, {
      provider: 'acp-claude',
      ...(id === model.id ? model : { id, name: id }),
      inputModalities: ['text', 'image'],
    })
    assert.deepEqual(second, first)
    assert.notEqual(first.inputModalities, second.inputModalities)
    first.inputModalities.push('audio')
    assert.deepEqual(second.inputModalities, ['text', 'image'])
  })
}

test('other agents and an unknown provider omit image input', async t => {
  const adapter = adapterOf(t)
  const providers = [...Object.keys(AGENTS).filter(id => id !== 'acp-claude'), 'unknown']
  for (const provider of providers) {
    assert.equal(Object.hasOwn(AGENTS[provider] ?? {}, 'imageInput'), false)
    for (const id of ['haiku', 'unknown']) {
      const resolved = await adapter.resolveModel(provider, id)
      assert.equal(Object.hasOwn(resolved, 'inputModalities'), false)
    }
  }
  adapter.agents.set('acp-test', { ...adapter.agents.get('acp-claude'), imageInput: 'true' })
  const resolved = await adapter.resolveModel('acp-test', 'haiku')
  assert.equal(Object.hasOwn(resolved, 'inputModalities'), false)
})

test('listed models omit modalities even when the catalog declares them', async t => {
  const adapter = adapterOf(t)
  for (const provider of Object.keys(AGENTS)) {
    assert.deepEqual(await adapter.listModels(provider), [{
      provider, id: model.id, name: model.name, description: model.description,
    }])
  }
  assert.deepEqual(await adapter.listModels('unknown'), [])
})

test('index passes imageInput through agentOf for Claude only', t => {
  const home = mkdtempSync(join(tmpdir(), 'acp-image-model-'))
  const cleanups = []
  let adapter
  t.after(() => {
    for (const cleanup of cleanups) cleanup()
    rmSync(home, { recursive: true, force: true })
  })
  const ctx = {
    llm: { registerAdapter(_ids, value) { adapter = value; return () => {} } },
    get() {}, on() {},
    effect(setup) { cleanups.push(setup()) },
  }
  apply(ctx, { hermes: true, antigravity: true, omp: true }, {
    store: { binOf: () => undefined, update: async () => {}, dispose() {} },
    cliStore: null,
    catalogHome: home,
    find: name => join(home, name),
    signedIn: async () => false,
    account: async () => undefined,
  })
  assert.deepEqual([...adapter.agents.keys()].sort(), Object.keys(AGENTS).sort())
  for (const [id, agent] of adapter.agents) {
    if (id === 'acp-claude') assert.equal(agent.imageInput, true)
    else assert.equal(Object.hasOwn(agent, 'imageInput'), false)
  }
})

for (const provider of ['acp-claude', 'acp-codex']) {
  test(`DSH read_image gates ${provider} through the real model runtime`, async t => {
    const home = mkdtempSync(join(tmpdir(), 'acp-read-image-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const path = join(home, 'image.png')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC'
        + 'AAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(path, png)
    const ctx = new Context()
    ctx.provide('logger', { warn() {}, info() {}, error() {}, debug() {} })
    const runtime = ctx.plugin(LlmRuntime)
    await runtime
    t.after(() => runtime.dispose())
    ctx.llm.registerAdapter(Object.keys(AGENTS), adapterOf(t))
    const calls = []
    const image = {
      attachmentId: 'test-image', mediaType: 'image/png',
      bytes: png.length, width: 1, height: 1, name: 'image.png',
    }
    const attachments = {
      imageLimits: {
        mediaTypes: ['image/png'], maxImageBytes: 1024, maxMessageImageBytes: 1024,
      },
      saveImage: async value => {
        calls.push('saveImage')
        assert.deepEqual(value, { data: png, mediaType: 'image/png', name: 'image.png' })
        return image
      },
      readImage: () => assert.fail('read_image must not read from the attachment store'),
    }
    const registered = new Map()
    const toolCtx = {
      get: name => name === 'attachments' ? attachments : ctx.get(name),
      inject: (_names, setup) => setup(toolCtx),
      tools: { register: tool => registered.set(tool.name, tool) },
      workingDirectory: { ensure: async () => { calls.push('cwd'); return home } },
      fs: {
        resolve: async file => {
          calls.push('resolve')
          assert.equal(file, path)
          return { displayPath: path }
        },
        stat: async target => {
          calls.push('stat')
          assert.equal(statSync(target.displayPath).isFile(), true)
          return { type: 'file', version: '1' }
        },
        readBytes: async target => {
          calls.push('readBytes')
          return readFileSync(target.displayPath)
        },
        processPath: target => target.displayPath,
      },
      emit() {},
    }
    applyFs(toolCtx, new FsConfig({ read: false, write: false, edit: false, applyPatch: false }))
    const tool = registered.get('read_image')
    assert.ok(tool)
    const exec = {
      signal: new AbortController().signal,
      agent: {
        options: { provider, model: 'haiku' },
        session: { requestHeader: () => ({ config: { provider, model: 'haiku' } }) },
      },
    }
    const read = () => tool.execute({ file_path: path }, exec)
    if (provider === 'acp-claude') {
      const value = await read()
      assert.deepEqual(value, { path, image })
      assert.deepEqual(calls, ['cwd', 'resolve', 'stat', 'readBytes', 'saveImage'])
      assert.deepEqual(tool.output.render({ file_path: path }, value)[1], {
        type: 'image', attachment: image,
      })
    } else {
      await assert.rejects(read, { code: 'IMAGE_UNSUPPORTED_MODEL' })
      assert.deepEqual(calls, [])
    }
  })
}
