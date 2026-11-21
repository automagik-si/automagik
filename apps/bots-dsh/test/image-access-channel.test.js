import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install as installChannel } from '../src/host/channel.js'

const api = (state) => {
  let route
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on: () => () => {},
    effect: execute => { execute() },
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register(r) { route = r; return () => {} } } },
    llm: { listProviders: () => [] },
  }
  const rt = {
    ctx,
    state: { revision: 0, bots: {}, rooms: {}, exchanges: [], questions: {}, agents: {}, secretRequests: {}, prefs: {} },
    save: async () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    load: async () => {},
    bootstrap: async () => {},
    catalog: async () => {},
    loadSecrets: async () => {},
    cachedCatalog: () => [],
    cachedDefault: () => undefined,
    reasoningOf: () => undefined,
    providersView: async () => ({}),
    secretsView: () => ({}),
    capabilityLibraryView: () => ({}),
    activityView: () => ({}),
    workView: () => ({}),
    roomWorkView: () => ({}),
    approvalsView: () => ({}),
    waitingView: () => ({}),
    turnsView: () => ({}),
    memoryNews: () => ({}),
    memoryReviews: () => ({}),
    connectorsView: () => ({}),
    capabilityStatusesView: () => ({}),
    images: { access: async () => state.access, accessDetail: async () => state.detail },
    // Omni's extension registry (extend.js): no other plugin adds endpoints here.
    extended: { endpointOf: () => undefined, view: () => ({}), live: () => ({}) },
    warn() {},
  }
  installChannel(rt)
  const post = async (endpoint, payload) => {
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return response.json()
  }
  return { post }
}

test('image-access answers the plain view without detail and the reason with it', async () => {
  const state = { access: null, detail: { access: null, environmentKey: 'ignored' } }
  const { post } = api(state)
  assert.deepEqual(await post('image-access'), { ok: true, value: null })
  assert.deepEqual(await post('image-access', { detail: true }), { ok: true, value: { access: null, environmentKey: 'ignored' } })
  assert.deepEqual(await post('image-access', { detail: 'yes' }), { ok: true, value: null })

  state.access = { kind: 'codex' }
  state.detail = { access: { kind: 'codex' } }
  assert.deepEqual(await post('image-access'), { ok: true, value: { kind: 'codex' } })
  assert.deepEqual(await post('image-access', { detail: true }), { ok: true, value: { access: { kind: 'codex' } } })
})
