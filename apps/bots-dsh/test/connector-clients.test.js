// A build with no Automagik sign-in client configured. No service's own client is built in: no GitHub sign-in
// app id, no published OAuth client document, no Google client. A connector that needs one says NOT SET UP and
// never signs in through another product's app. No network leaves the test process.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT_SETTINGS = [
  'AUTOMAGIK_GITHUB_OAUTH_CLIENT_ID', 'AUTOMAGIK_OAUTH_CLIENT_METADATA_URL',
  'AUTOMAGIK_GOOGLE_OAUTH_CLIENT_ID', 'AUTOMAGIK_GOOGLE_OAUTH_CLIENT_SECRET',
]
// The modules read these as they load, so they go before the imports.
for (const name of CLIENT_SETTINGS) delete process.env[name]

const { createRuntime } = await import('../index.js')
const { fakeContext } = await import('./fake-ctx.js')
const oauth = await import('../src/host/connectors/oauth.js')
const { GITHUB_CLIENT_ID, CATALOG } = await import('../src/host/connectors/catalog.js')

const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: '', instructions: '', createdAt: 1 } },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}
function team(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-clients-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, ...config })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return rt
}
// Any request here is a fault: the test fails instead of reaching a service.
const noNetwork = async (url) => { throw new Error(`a request left for ${String(url?.url ?? url)}`) }

test('no sign-in client is built in', () => {
  assert.equal(GITHUB_CLIENT_ID, '')
  assert.equal(oauth.CIMD_CLIENT_ID, undefined)
  for (const entry of CATALOG) assert.ok(!entry.auth?.client?.id, `${entry.id} carries a client id`)
})

test('with no client document configured, a server that takes one is never given another product\'s', async () => {
  const discovery = { authorizationServerUrl: 'https://as.test', metadata: { authorization_endpoint: 'https://as.test/auth', token_endpoint: 'https://as.test/token', client_id_metadata_document_supported: true }, scope: 's', resource: 'r' }
  const entry = { auth: { kind: 'oauth' } }
  // On the fixed port, where a configured document would be used: nothing, so the row asks for a client.
  assert.equal(await oauth.resolveClient(entry, discovery, `http://127.0.0.1:${oauth.FIXED_CALLBACK_PORT}/callback`, true, undefined, { fetch: noNetwork }), null)
  // A client document saved by an earlier build is not used again either.
  const stored = { via: 'cimd', clientId: 'https://other.test/oauth/client.json', redirectUris: [] }
  assert.equal(await oauth.resolveClient(entry, discovery, `http://127.0.0.1:${oauth.FIXED_CALLBACK_PORT}/callback`, true, stored, { fetch: noNetwork }), null)
})

test('GitHub with no sign-in app says NOT SET UP, and its device sign-in asks nothing of GitHub', async (t) => {
  const real = globalThis.fetch
  globalThis.fetch = noNetwork
  t.after(() => { globalThis.fetch = real })
  const rt = team(t)
  await rt.load()
  const row = rt.connectorsView().connectors.find(entry => entry.id === 'github')
  assert.equal(row.state, 'needs-client')
  assert.match(row.error, /^NOT SET UP/)
  await assert.rejects(oauth.deviceBegin(GITHUB_CLIENT_ID, 'repo', { fetch: noNetwork }), error => error.code === 'bot/refused' && /^NOT SET UP/.test(error.message))
})

test('Google mail with no client says NOT SET UP and opens no sign-in', async (t) => {
  const rt = team(t, { github: false, mail: { fetch: noNetwork } })
  await rt.load()
  await assert.rejects(rt.connectorEndpoint('mail-account-add', { google: true }), error => error.code === 'bot/refused' && /^NOT SET UP/.test(error.message))
})

test('the connector sources name no other product\'s sign-in app, client document or relay', () => {
  const folder = fileURLToPath(new URL('../src/host/connectors/', import.meta.url))
  const files = readdirSync(folder, { recursive: true }).filter(name => String(name).endsWith('.js'))
  assert.ok(files.length >= 5)
  for (const name of files) {
    const source = readFileSync(join(folder, String(name)), 'utf8')
    // A GitHub OAuth or GitHub App client id written into the source.
    assert.doesNotMatch(source, /\b(?:Ov23|Iv1\.|Iv23)[A-Za-z0-9]{12,}/, `${name} holds a GitHub client id`)
    // A Google OAuth client id written into the source.
    assert.doesNotMatch(source, /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/, `${name} holds a Google client id`)
    assert.doesNotMatch(source, /dsbot\.app|oauth\/client\.json/, `${name} names a published client document`)
  }
})
