import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applyAllowlist, BILLING_RULES, configHits, DATA_DIRS, hitOf, LABELS, loadAllowlist,
  nameHits, ownCode, scanRepo, scanTree, sha256,
  sha256Bytes, walk,
} from '../secrecy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-secrecy-test-'))
  temps.push(dir)
  return dir
}

/** An image's empty /data tree, as the Dockerfile's tools stage creates it. */
function rootfs(dir = temp()) {
  for (const path of DATA_DIRS) mkdirSync(join(dir, path), { recursive: true })
  return dir
}

const write = (dir, path, content) => {
  mkdirSync(join(dir, dirname(path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}
// Built, not written as a literal where the repository's privacy grep would see a person or a secret.
const home = (name) => ['', 'home', name, 'project'].join('/')
const shortName = ['g', '9'].join('')
const key = `sk-${'a'.repeat(32)}`
const providerKey = `ghp_${'b'.repeat(30)}`
const token = 'c'.repeat(32)

test('names alone: dotenv, launch-url, data state, credentials and archives', () => {
  assert.deepEqual(nameHits('opt/automagik/.env', 'file').map((hit) => hit.rule), ['dotenv'])
  assert.deepEqual(nameHits('opt/automagik/.env.example', 'file'), [])
  assert.deepEqual(nameHits('data/dsh/launch-url', 'file').map((hit) => hit.rule), ['launch-url', 'data-state'])
  assert.deepEqual(nameHits('data', 'dir'), [])
  assert.deepEqual(nameHits('data/dsh', 'dir'), [])
  assert.deepEqual(nameHits('data/dsh/profiles/automagik-web', 'dir').map((hit) => hit.rule), ['data-state'])
  assert.deepEqual(nameHits('opt/automagik/.git-credentials', 'file').map((hit) => hit.rule), ['git-credentials'])
  assert.deepEqual(nameHits('opt/automagik/netrc', 'file').map((hit) => hit.rule), ['git-credentials'])
  assert.deepEqual(nameHits('opt/automagik/bundle.tgz', 'file').map((hit) => hit.rule), ['archive'])
})

test('a clean rootfs: the profile code and the empty /data tree pass', () => {
  const dir = rootfs()
  cpSync(join(HERE, '..', 'lib.mjs'), join(dir, 'opt/automagik/lib.mjs'))
  cpSync(join(HERE, '..', 'entrypoint.mjs'), join(dir, 'opt/automagik/entrypoint.mjs'))
  cpSync(join(HERE, '..', 'healthcheck.mjs'), join(dir, 'opt/automagik/healthcheck.mjs'))
  write(dir, 'opt/automagik/versions.json', '{"automagik":"3.93.0","dsh":"0.2.2-rc.2"}\n')
  write(dir, 'etc/passwd', 'root:x:0:0:root:/root:/sbin/nologin\nautomagik:x:1000:1000::/data:/sbin/nologin\n')
  const { hits: findings } = scanTree(dir, undefined, [])
  assert.deepEqual(findings, [])
})

test('the 17 negative probes all stay failures', () => {
  const cases = [
    ['key', `DEEPSEEK_API_KEY=${key}\n`, 'key'],
    ['provider key', `GITHUB_TOKEN=${providerKey}\n`, 'key'],
    ['token=', `url?token=${token}\n`, 'token'],
    ['token-url', `http://127.0.0.1:3081/?token=${token}\n`, 'token-url'],
    ['token-json', `{"token": "${'a1'.repeat(16)}"}\n`, 'token-json'],
    ['private-key', `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----\n`, 'private-key'],
    ['private-path', 'workspace at /mnt/ai/bots\n', 'private-path'],
    ['home-path text', `workspace at ${home('alice')}\n`, 'home-path'],
    ['home-path binary', Buffer.concat([Buffer.from([0]), Buffer.from(`${home('bob')}\0`)]), 'home-path'],
    ['private-name', `${shortName}\n`, 'private-name'],
    ['git-credentials', 'https://user:password@example.com/x.git\n', 'git-credentials'],
    ['git-credentials file', 'nothing\n', 'git-credentials', 'opt/leak/.git-credentials'],
    ['.env', 'DEEPSEEK_API_KEY=not-a-key\n', 'dotenv', 'opt/leak/.env'],
    ['launch-url', 'nothing\n', 'launch-url', 'data/dsh/launch-url'],
    ['data state', '{}\n', 'data-state', 'data/bots/team.json'],
    ['archive', 'nothing\n', 'archive', 'opt/leak/bundle.tgz'],
    ['archive inside a package', 'nothing\n', 'archive', 'opt/leak/node_modules/x/cache.zip'],
  ]
  assert.equal(cases.length, 17)
  for (const [label, content, rule, path = 'opt/leak/probe.txt'] of cases) {
    const dir = rootfs()
    write(dir, path, content)
    const { hits: findings } = scanTree(dir, undefined, [])
    assert.ok(findings.some((hit) => hit.rule === rule), `${label}: expected ${rule}, got ${JSON.stringify(findings)}`)
  }
})

test('the file digest hashes bytes, not a lossy string', () => {
  const a = Buffer.from([0x80, 0x00, 0x41])
  const b = Buffer.from([0xfe, 0x00, 0x41])
  assert.notEqual(sha256Bytes(a), sha256Bytes(b))
  // The old path hashed String(buffer): both decode to the same replacement characters.
  assert.equal(sha256(a.toString('utf8')), sha256(b.toString('utf8')))
  assert.notEqual(sha256Bytes(Buffer.from('a')), sha256Bytes(Buffer.from('b')))
})

test('a bare PEM label constant is not a key; a real body, short last line and header are', () => {
  const dir = rootfs()
  write(dir, 'opt/leak/label.txt', '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n')
  // The repository's privacy grep still reports a bare header as `secret`; the key rule does not.
  assert.deepEqual(scanTree(dir, undefined, []).hits.filter((hit) => hit.rule === 'private-key'), [])
  const bodies = [
    `${'A'.repeat(64)}\n`,
    `${'A'.repeat(64)}\nAAAA\n`,
    `Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\nAAAAAA\n`,
    'AAAAAA\n',
  ]
  bodies.forEach((body, index) => {
    const file = `opt/leak/real-${index}.txt`
    write(dir, file, `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`)
    assert.ok(scanTree(dir, undefined, []).hits.some((hit) => hit.rule === 'private-key' && hit.file === file), `body ${index}`)
  })
})

test('a private-key entry is allowed only for the gnutls library', () => {
  const file = join(temp(), 'allowlist.json')
  writeFileSync(file, JSON.stringify([{
    file: 'opt/automagik/runtime/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.wasm',
    rule: 'private-key',
    sha256: 'a'.repeat(64),
    reason: 'not the gnutls library',
  }]))
  assert.throws(() => loadAllowlist(file), /private-key may not be allowlisted here/)
})

test('the node build account is excused only for the pinned binary hash', () => {
  const pin = 'e237a2839d0cbdc9a9a2adda1a184afc0f5b20306ffbe923af5686550472d8a8'
  const hit = { file: 'nodejs/bin/node', rule: 'home-path', raw: '/home/iojs', match: '/home/iojs', fileSha256: pin }
  const entry = { file: 'nodejs/bin/node', rule: 'home-path', match: '/home/iojs', fileSha256: pin, reason: 'pinned' }
  assert.equal(applyAllowlist([hit], [entry]).kept.length, 0)
  assert.equal(applyAllowlist([hit], [{ ...entry, fileSha256: '0'.repeat(64) }]).kept.length, 1)
})

test('an exact allowlist entry excuses one path, and a key may never be allowlisted', () => {
  const dir = rootfs()
  write(dir, 'opt/vendor/example.txt', `workspace at ${home('example')}\n`)
  const entry = { file: 'opt/vendor/example.txt', rule: 'home-path', match: home('example').replace(/\/project$/, ''), reason: 'a documented example' }
  const { hits: findings, allowed } = scanTree(dir, undefined, [entry])
  assert.deepEqual(findings, [])
  assert.equal(allowed.length, 1)

  const file = join(temp(), 'allowlist.json')
  writeFileSync(file, JSON.stringify([{ file: 'opt/leak/key.txt', rule: 'key', match: key, reason: 'never' }]))
  assert.throws(() => loadAllowlist(file), /key may not be allowlisted/)
  const hit = { file: 'opt/leak/key.txt', rule: 'key', raw: key, match: 'sk-***' }
  assert.equal(applyAllowlist([hit], []).kept.length, 1)
  assert.equal(applyAllowlist([hit], [{ file: 'opt/leak/key.txt', rule: 'key', match: key, reason: 'never' }]).kept.length, 1)
})

test('the ACP SDK example home paths have one exact entry each, and each is necessary', () => {
  const sdk = 'opt/automagik/profile/node_modules/@agentclientprotocol/sdk'
  const unixHome = ['', 'home', 'user'].join('/')
  const winHome = ['C:', 'Users', 'user'].join('\\')
  const zodFile = ` * such as ${home('user')},\n * ${winHome}\\project\n`
  const jsonFile = `{"description": "such as ${home('user')}"}\n`
  const expected = [
    [`${sdk}/dist/v2/schema/zod.gen.js`, zodFile, unixHome],
    [`${sdk}/dist/v2/schema/zod.gen.js`, zodFile, winHome],
    [`${sdk}/dist/v2/unstable/schema/zod.gen.js`, zodFile, unixHome],
    [`${sdk}/dist/v2/unstable/schema/zod.gen.js`, zodFile, winHome],
    [`${sdk}/schema/v2/schema.json`, jsonFile, unixHome],
    [`${sdk}/schema/v2/schema.unstable.json`, jsonFile, unixHome],
  ]
  const dir = rootfs()
  for (const [file, content] of expected) write(dir, file, content)
  const entries = loadAllowlist()
  assert.deepEqual(scanTree(dir, undefined, entries).hits, [])
  for (const [file, , match] of expected) {
    const found = entries.filter((entry) => entry.file === file && entry.rule === 'home-path' && entry.match === match)
    assert.equal(found.length, 1, `${file}: expected one exact entry for ${match}`)
    assert.match(found[0].reason, /ACP SDK/)
    assert.match(found[0].reason, /not a host account/)
    const kept = scanTree(dir, undefined, entries.filter((entry) => entry !== found[0])).hits
    assert.deepEqual(kept.map((hit) => [hit.file, hit.rule, hit.raw, hit.match]), [[file, 'home-path', match, LABELS['home-path']]])
  }
})

test('the redaction regex in the image code is not mistaken for a token', () => {
  const dir = rootfs()
  cpSync(join(HERE, '..', 'lib.mjs'), join(dir, 'opt/automagik/lib.mjs'))
  assert.deepEqual(scanTree(dir, undefined, []).hits, [])
})

// CACHE_HOME_UNPINNED: an example-path exception must not cover changed cache bytes.
test('ACP offline-cache examples require the exact cache path, match and complete file digest', () => {
  const entries = loadAllowlist().filter(entry => entry.file.startsWith('opt/automagik/offline-store/') && /ACP SDK/.test(entry.reason))
  assert.equal(entries.length, 14) // Six each for ACP SDK 2.8.0 and 2.9.0 (2.9.1 shares the four 2.9.0 zod.gen.js entries), two for 2.9.1.
  const examples = [['', 'home', 'user'].join('/'), ['C:', 'Users', 'user'].join('\\')]
  for (const entry of entries) {
    const raw = examples.find(value => sha256(value) === entry.sha256)
    assert.ok(raw, 'only the reviewed schema example strings are exempted')
    const hit = { file: entry.file, rule: 'home-path', raw, match: raw, fileSha256: entry.fileSha256 }
    assert.equal(applyAllowlist([hit], [entry]).kept.length, 0)
    assert.equal(applyAllowlist([{ ...hit, fileSha256: '0'.repeat(64) }], [entry]).kept.length, 1, 'changed file bytes are refused')
    assert.equal(applyAllowlist([{ ...hit, file: `${hit.file}-other` }], [entry]).kept.length, 1, 'another cache path is refused')
    assert.equal(applyAllowlist([{ ...hit, raw: `${raw}/private` }], [entry]).kept.length, 1, 'another home path is refused')
  }
})

test('the CLI scans a rootfs, writes the inventory, and exits 1 on a hit', () => {
  const clean = rootfs()
  const cleanInventory = join(clean, 'inventory')
  const cleanRun = execFileSync(process.execPath, [join(HERE, '..', 'secrecy.mjs'), '--rootfs', clean, '--inventory', cleanInventory], { encoding: 'utf8' })
  assert.match(cleanRun, /\[secrecy\] clean/)
  assert.equal(readFileSync(join(cleanInventory, 'secrecy.txt'), 'utf8'), 'clean\n')
  assert.ok(readFileSync(join(cleanInventory, 'image-files.txt'), 'utf8').includes('data/dsh'))

  const bad = rootfs()
  write(bad, 'opt/leak/key.txt', `${key}\n`)
  const badRun = (() => {
    try {
      execFileSync(process.execPath, [join(HERE, '..', 'secrecy.mjs'), '--rootfs', bad, '--inventory', join(bad, 'inventory')], { encoding: 'utf8', stdio: 'pipe' })
      return { status: 0 }
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) }
    }
  })()
  assert.equal(badRun.status, 1)
  assert.match(badRun.stderr, /key: sk-\*\*\*/)
  assert.match(readFileSync(join(bad, 'inventory', 'secrecy.txt'), 'utf8'), /: key: sk-\*\*\*/)
})

// Billing (RFC 0025 Decided 12, issue #910). Every Stripe-shaped value is built here, never
// written: the repository holds no key, price or account id, and `--repo` would refuse one.
const stripeKey = (kind = 'sk', mode = 'test') => [kind, mode, `4eC39Hq${'a1B2'.repeat(5)}`].join('_')
const stripeId = (prefix) => [prefix, `1MoBy5${'Lk9d'.repeat(4)}`].join('_')
const ownHost = ['automagik', 'si'].join('.')
const PLUGIN = 'opt/automagik/profile/node_modules/@automagik/bots-dsh'
const THIRD = 'opt/automagik/profile/node_modules/some-dependency'
const rulesAt = (path, content, allowlist = []) => {
  const dir = rootfs()
  write(dir, path, content)
  return scanTree(dir, undefined, allowlist).hits.map((hit) => hit.rule)
}

test('own code is the image scripts, the profile and @automagik packages; a dependency is not', () => {
  assert.equal(ownCode('opt/automagik/entrypoint.mjs'), true)
  assert.equal(ownCode('opt/automagik/profile/package.json'), true)
  assert.equal(ownCode('opt/am/runner/locks.mjs'), true)
  assert.equal(ownCode('opt/am/runner/proto.mjs'), true)
  assert.equal(ownCode(`${PLUGIN}/index.js`), true)
  assert.equal(ownCode('opt/automagik/profile/node_modules/.pnpm/@automagik+bots-dsh@3.0.0/node_modules/@automagik/bots-dsh/index.js'), true)
  assert.equal(ownCode('image-config'), true)
  assert.equal(ownCode(`${THIRD}/index.js`), false)
  assert.equal(ownCode(`${PLUGIN}/node_modules/dep/index.js`), false)
  assert.equal(ownCode('opt/automagik/runtime/node_modules/@deepseek-ai/dsh-api-gateway/index.js'), false)
  assert.equal(ownCode('usr/lib/x.js'), false)
})

test('the Stripe SDK is refused as a folder, a package, a dependency and an import, anywhere', () => {
  assert.deepEqual(nameHits('opt/automagik/profile/node_modules/stripe', 'dir').map((hit) => hit.rule), ['stripe-sdk'])
  assert.deepEqual(nameHits('opt/x/node_modules/.pnpm/stripe@1.0.0/node_modules/stripe', 'symlink').map((hit) => hit.rule), ['stripe-sdk'])
  assert.deepEqual(nameHits('opt/x/node_modules/@stripe', 'dir').map((hit) => hit.rule), ['stripe-sdk'])
  assert.deepEqual(nameHits('opt/x/node_modules/stripe-ansi', 'dir'), [])
  assert.deepEqual(nameHits('opt/x/node_modules/y/stripe', 'dir'), [])
  const cases = [
    ['a package named stripe', `${THIRD}/package.json`, '{"name":"stripe","version":"1.0.0"}'],
    ['a scoped package', `${THIRD}/package.json`, '{"name":"@stripe/stripe-js"}'],
    ['a dependency', `${PLUGIN}/package.json`, '{"name":"@automagik/bots-dsh","dependencies":{"stripe":"^1"}}'],
    ['a peer dependency', `${THIRD}/package.json`, '{"name":"x","peerDependencies":{"@stripe/stripe-js":"*"}}'],
    ['a bundled dependency', `${THIRD}/package.json`, '{"name":"x","bundledDependencies":["stripe"]}'],
    ['an import', `${THIRD}/index.mjs`, "import Stripe from 'stripe'\n"],
    ['a minified import', `${PLUGIN}/client.js`, 'import{loadStripe as a}from"@stripe/stripe-js";a()\n'],
    ['a subpath import', `${THIRD}/index.js`, "import x from 'stripe/lib/x.js'\n"],
    ['a require', `${THIRD}/index.cjs`, "const Stripe = require('stripe')\n"],
    ['a dynamic import', `${THIRD}/index.ts`, "const { default: Stripe } = await import('stripe')\n"],
  ]
  for (const [label, path, content] of cases) assert.ok(rulesAt(path, content).includes('stripe-sdk'), label)
  // Not the SDK: a package whose name only starts the same, a development dependency, prose.
  assert.deepEqual(rulesAt(`${THIRD}/package.json`, '{"name":"stripe-ansi","devDependencies":{"stripe":"1"},"dependencies":{"strip-ansi":"1"}}'), [])
  assert.deepEqual(rulesAt(`${THIRD}/index.js`, "import strip from 'strip-ansi'\nconst from = 'stripe'\n// a stripe of paint\n"), [])
})

test('a Stripe host, key or object id is refused, and the log never carries the value', () => {
  assert.ok(rulesAt(`${THIRD}/index.js`, `fetch('https://${['api', 'stripe', 'com'].join('.')}/v1/charges')\n`).includes('stripe-client'))
  for (const value of [stripeKey('sk', 'test'), stripeKey('sk', 'live'), stripeKey('rk', 'live'), ['whsec', 'a1B2'.repeat(8)].join('_')]) {
    const dir = rootfs()
    write(dir, `${THIRD}/config.js`, `export const k = '${value}'\n`)
    const found = scanTree(dir, undefined, []).hits.filter((hit) => hit.rule === 'stripe-key')
    assert.equal(found.length, 1, value.slice(0, 8))
    assert.ok(!found[0].match.includes(value.slice(-12)))
  }
  for (const prefix of ['price', 'prod', 'acct', 'cus', 'sub', 'plan', 'pk_live', 'pk_test']) {
    const dir = rootfs()
    write(dir, `${PLUGIN}/plans.json`, `{"id":"${stripeId(prefix)}"}\n`)
    const found = scanTree(dir, undefined, []).hits.filter((hit) => hit.rule === 'stripe-id')
    assert.equal(found.length, 1, prefix)
    assert.equal(found[0].match, `${prefix}_***`)
  }
  // An ordinary identifier is not an id: no digit, no capital, or too short.
  assert.deepEqual(rulesAt(`${PLUGIN}/meter.js`, 'const price_version_identifier = 1\nconst sub_total_amount_due1 = 2\nconst plan_A1 = 3\n'), [])
})

test('our own code holds no billing or ledger import and no billing route; a dependency may name its own', () => {
  const imports = [
    "import { charge } from './billing.mjs'\n",
    "import { write } from '../ledger/writer.js'\n",
    "const billing = require('@automagik/cloud-billing')\n",
    "const m = await import('./cloud/billing-adapter/index.js')\n",
  ]
  for (const content of imports) {
    assert.deepEqual(rulesAt(`${PLUGIN}/index.js`, content), ['billing-import'], content)
    assert.deepEqual(rulesAt(`${THIRD}/index.js`, content), [], content)
  }
  assert.deepEqual(rulesAt('opt/automagik/entrypoint.mjs', "import './billing.mjs'\n"), ['billing-import'])
  assert.deepEqual(rulesAt(`${PLUGIN}/index.js`, "import { x } from './rebilling.js'\nimport y from './ledgers.js'\n"), [])
  for (const route of ["'/billing'", '"/api/billing/portal"', '`/cloud/ledger/events`', "'/v1/billing/:tenant'"]) {
    assert.deepEqual(rulesAt(`${PLUGIN}/routes.js`, `ctx.server.get(${route}, handler)\n`), ['billing-route'], route)
    assert.deepEqual(rulesAt(`${THIRD}/routes.js`, `ctx.server.get(${route}, handler)\n`), [], route)
  }
  assert.deepEqual(rulesAt(`${PLUGIN}/routes.js`, "ctx.server.get('/bots/billingham', handler)\nconst note = 'no billing here'\n"), [])
})

test('a built-in gateway address or credential is refused; a provider preset and a placeholder are not', () => {
  const address = `https://models.${ownHost}/v1`
  const defaults = [
    `const gatewayUrl = '${address}'\n`,
    `const url = process.env.AUTOMAGIK_GATEWAY_URL ?? '${address}'\n`,
    `const url = env.GATEWAY_ADDRESS || "${address}"\n`,
    `{ "gateway": "${address}" }\n`,
    `export default { cloudGatewayEndpoint: 'wss://203.0.113.7:8443/stream' }\n`,
  ]
  for (const content of defaults) {
    assert.deepEqual(rulesAt(`${PLUGIN}/models.js`, content), ['gateway-address'], content)
    assert.deepEqual(rulesAt(`${THIRD}/models.js`, content), [], content)
  }
  // One of our own hosts that names a gateway is refused wherever it is, whatever its key.
  for (const url of [`https://gateway.${ownHost}/v1`, `https://api.${ownHost}/gateway/quote`, `wss://eu.gateway-a.cloud.${ownHost}`]) {
    assert.deepEqual(rulesAt(`${THIRD}/data.json`, `{"endpoint":"${url}"}\n`), ['gateway-address'], url)
  }
  assert.deepEqual(rulesAt(`${THIRD}/data.json`, `{"site":"https://${ownHost}/docs"}\n`), [])
  // What the Bot team ships today: a third-party provider preset, a placeholder, a setting with no default.
  const clean = [
    "const PRESETS = { 'vercel-ai-gateway': ['anthropic-messages', 'https://ai-gateway.vercel.sh', 'AI_GATEWAY_API_KEY'] }\n",
    "const ENDPOINT_HINTS = { 'anthropic-messages': 'https://gateway.example' }\n",
    "const gatewayUrl = 'https://gateway.example/v1'\n",
    'const gatewayUrl = process.env.AUTOMAGIK_GATEWAY_URL\nif (!gatewayUrl) return\n',
    "const error = { code: 'gateway/internal' }\n",
  ]
  for (const content of clean) assert.deepEqual(rulesAt(`${PLUGIN}/models.js`, content), [], content)

  const secret = `gw${'a1B2'.repeat(6)}`
  for (const content of [`const gatewayToken = '${secret}'\n`, `{"gateway_api_key": "${secret}"}\n`, `const t = env.GATEWAY_TOKEN ?? '${secret}'\n`]) {
    const dir = rootfs()
    write(dir, `${PLUGIN}/models.js`, content)
    const found = scanTree(dir, undefined, []).hits.filter((hit) => hit.rule === 'gateway-credential')
    assert.equal(found.length, 1, content)
    assert.ok(!found[0].match.includes(secret))
  }
  assert.deepEqual(rulesAt(`${PLUGIN}/models.js`, "const gatewayTokenName = 'AUTOMAGIK_GATEWAY_TOKEN'\nconst gatewayToken = process.env[gatewayTokenName]\n"), [])
})

test('the image config sets no gateway, Stripe or billing variable', () => {
  const list = { deny: [], allow: [] }
  const config = (env) => JSON.stringify({ Env: env, Labels: { 'org.opencontainers.image.version': '3.93.0' } })
  assert.deepEqual(configHits(config(['PATH=/usr/bin', 'NODE_ENV=production', 'AUTOMAGIK_GATEWAY_URL=']), list), [])
  const rules = (env) => configHits(config(env), list).map((hit) => hit.rule)
  assert.ok(rules([`AUTOMAGIK_GATEWAY_URL=https://models.${ownHost}`]).includes('gateway-address'))
  assert.deepEqual(rules(['AUTOMAGIK_GATEWAY=on']), ['gateway-address'])
  assert.deepEqual(rules(['STRIPE_ACCOUNT=x']), ['billing-config'])
  assert.deepEqual(rules(['CLOUD_BILLING_MODE=test']), ['billing-config'])
  assert.deepEqual(rules(['AUTOMAGIK_GATEWAY_TOKEN=abc']), ['env-secret', 'gateway-address'])
})

test('a billing hit in our own code may never be allowlisted; a dependency one needs an exact entry', () => {
  const file = join(temp(), 'allowlist.json')
  const entry = (path, rule) => [{ file: path, rule, match: 'x', reason: 'never' }]
  for (const rule of ['billing-import', 'billing-route', 'gateway-address', 'stripe-client', 'stripe-id', 'stripe-key']) {
    writeFileSync(file, JSON.stringify(entry(`${PLUGIN}/index.js`, rule)))
    assert.throws(() => loadAllowlist(file), /may not be allowlisted here/, rule)
  }
  // Own code the older path rule does not name: a pnpm-store copy of a plugin, a new profile folder.
  const STORE = 'opt/automagik/profile/node_modules/.pnpm/@automagik+bots-dsh@3.0.0/node_modules/@automagik/bots-dsh/index.js'
  for (const path of [STORE, 'opt/automagik/profile/cloud/index.js']) {
    writeFileSync(file, JSON.stringify(entry(path, 'gateway-address')))
    assert.throws(() => loadAllowlist(file), /may not be allowlisted here/, path)
    writeFileSync(file, JSON.stringify(entry(path, 'home-path')))
    assert.equal(loadAllowlist(file).length, 1, path)
    const hit = { file: path, rule: 'gateway-address', raw: 'x', match: 'x' }
    assert.equal(applyAllowlist([hit], entry(path, 'gateway-address')).kept.length, 1, path)
  }
  for (const rule of ['stripe-sdk', 'gateway-credential', 'billing-config']) {
    writeFileSync(file, JSON.stringify(entry(`${THIRD}/index.js`, rule)))
    assert.throws(() => loadAllowlist(file), /may not be allowlisted here/, rule)
  }
  const host = ['js', 'stripe', 'com'].join('.')
  const reviewed = [{ file: `${THIRD}/csp.js`, rule: 'stripe-client', match: host, reason: 'a reviewed host list' }]
  assert.deepEqual(rulesAt(`${THIRD}/csp.js`, `const hosts = ['${host}']\n`, reviewed), [])
  assert.deepEqual(rulesAt(`${PLUGIN}/csp.js`, `const hosts = ['${host}']\n`, [{ ...reviewed[0], file: `${PLUGIN}/csp.js` }]), ['stripe-client'])
})

test('the image scripts and the shipped allowlist pass the billing rules', () => {
  const dir = rootfs()
  for (const name of ['lib.mjs', 'entrypoint.mjs', 'healthcheck.mjs']) cpSync(join(HERE, '..', name), join(dir, 'opt/automagik', name))
  cpSync(join(HERE, '..', 'profile'), join(dir, 'opt/automagik/profile'), { recursive: true })
  assert.deepEqual(scanTree(dir, undefined, []).hits, [])
  assert.ok(loadAllowlist().every((item) => !BILLING_RULES.has(item.rule)))
})

test('--repo refuses a Stripe key, price or account id in a tracked file, and this repository has none', () => {
  const dir = temp()
  write(dir, 'apps/x/plans.json', `{"price":"${stripeId('price')}","account":"${stripeId('acct')}"}\n`)
  write(dir, 'apps/x/env.md', `STRIPE_SECRET=${stripeKey('sk', 'live')}\n`)
  write(dir, 'apps/x/clean.md', 'the price version is an immutable id\n')
  write(dir, 'apps/x/blob.bin', Buffer.concat([Buffer.from([0]), Buffer.from(stripeId('price'))]))
  const { hits: found, checked } = scanRepo(dir, ['apps/x/plans.json', 'apps/x/env.md', 'apps/x/clean.md', 'apps/x/blob.bin', 'apps/x/gone.md'])
  assert.equal(checked, 3)
  assert.deepEqual(found.map((hit) => `${hit.file}: ${hit.rule}: ${hit.match}`), [
    'apps/x/plans.json: stripe-id: price_***',
    'apps/x/plans.json: stripe-id: acct_***',
    'apps/x/env.md: stripe-key: sk_live_***',
  ])

  const root = join(HERE, '..', '..')
  let tracked
  try {
    tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean)
  } catch {
    // An exported tree (no git): every file that is there, bar install and build folders.
    tracked = walk(root).filter((item) => item.kind === 'file' && !/(?:^|\/)(?:node_modules|target|dist|\.git)\//.test(item.file)).map((item) => item.file)
  }
  const repo = scanRepo(root, tracked)
  assert.ok(repo.checked > 100)
  assert.deepEqual(repo.hits.map((hit) => `${hit.file}:${hit.line}: ${hit.rule}`), [])
})

// PR 976 review (RAW_INPUT_IN_PUBLIC_MATCH and its earlier cases MASK_RAW_URL, MASK_GREEDY_ROUTE,
// TOKEN_URL_KEEPS_URL): a finding once showed text taken from what it scanned, so a credential in
// a URL, a route, a package or a variable name reached stderr and the uploaded inventory. Every
// finding's public text is now one constant of LABELS. This plants a per-run synthetic secret in
// every field each finding kind reads and runs the real CLI, on a rootfs and on an image.
test('no finding prints what it scanned: every field, through the real CLI, in both modes', () => {
  const made = []
  // A unique per-run value over an alphabet, never written in this file.
  const synth = (length, alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') => {
    let value = ''
    for (const byte of randomBytes(length)) value += alphabet[byte % alphabet.length]
    // The id rules need a digit and a capital; the suffix keeps the value unique enough.
    value = `${value.slice(0, length - 2)}${alphabet.includes('A') ? 'Q' : 'q'}7`
    made.push(value)
    return value
  }
  const lower = 'abcdefghijkmnpqrstuvwxyz23456789'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const vendor = ['gateway', 'vendor', 'net'].join('.')
  const stripe = ['stripe', 'com'].join('.')
  // Built, not written: the repository's privacy grep reads this file too.
  const dashes = '-'.repeat(5)
  const pin = String(1000 + (randomBytes(2).readUInt16BE() % 9000))
  const pem = (body) => [`${dashes}BEGIN PRIVATE ${'KEY'}${dashes}`, body, `${dashes}END PRIVATE ${'KEY'}${dashes}`, ''].join('\n')

  // [what is planted, the file, its content, the rules it must raise]
  const OWN = `${PLUGIN}/planted`
  const DEP = `${THIRD}/planted`
  const rows = [
    ['a provider key', `${DEP}/key-sk.txt`, `K=sk-${synth(40)}\n`, ['key', 'secret']],
    ['a GitHub token', `${DEP}/key-gh.txt`, `K=ghp_${synth(36)}\n`, ['key', 'secret']],
    ['a GitHub fine-grained token', `${DEP}/key-pat.txt`, `K=github_pat_${synth(44)}\n`, ['key', 'secret']],
    ['an AWS key id', `${DEP}/key-akia.txt`, `K=AKIA${synth(16, upper)}\n`, ['key', 'secret']],
    ['a Slack token', `${DEP}/key-xox.txt`, `K=xoxb-${synth(24)}\n`, ['key', 'secret']],
    ['a private-key body', `${DEP}/key-pem.txt`, pem(synth(64)), ['private-key', 'secret']],
    ['a private path', `${DEP}/path.txt`, `at /mnt/ai/${synth(24)}/x\n`, ['private-path']],
    ['a home path', `${DEP}/home.txt`, `at ${['', 'home', synth(24)].join('/')}/x\n`, ['home-path']],
    ['a home path in a binary', `${DEP}/home.bin`, Buffer.concat([Buffer.from([0]), Buffer.from(`${['', 'home', synth(24)].join('/')}\0`)]), ['home-path']],
    ['a token=', `${DEP}/token.txt`, `x?token=${synth(32)}\n`, ['token']],
    ['a token URL: userinfo, host, path, query, fragment', `${DEP}/token-url.txt`, `https://${synth(12)}:${synth(24)}@${synth(12, lower)}.host.invalid/${synth(24)}?a=${synth(24)}&token=${synth(32)}#${synth(24)}\n`, ['token-url', 'git-credentials']],
    ['a JSON token field', `${DEP}/token.json`, `{"api_token": "${synth(40)}"}\n`, ['token-json']],
    ['a credential URL', `${DEP}/cred.txt`, `ssh://${synth(12)}:${synth(24)}@host.invalid/x.git\n`, ['git-credentials']],
    ['a Stripe secret key', `${DEP}/stripe-sk.txt`, `${['sk', 'live', synth(28)].join('_')}\n`, ['stripe-key']],
    ['a Stripe restricted key', `${DEP}/stripe-rk.txt`, `${['rk', 'test', synth(28)].join('_')}\n`, ['stripe-key']],
    ['a Stripe webhook secret', `${DEP}/stripe-wh.txt`, `${['whsec', synth(32)].join('_')}\n`, ['stripe-key']],
    ...['price', 'prod', 'acct', 'cus', 'sub', 'plan', 'pk_live', 'pk_test'].map((prefix) => [`a Stripe ${prefix} id`, `${DEP}/stripe-${prefix}.json`, `{"id":"${[prefix, synth(24)].join('_')}"}\n`, ['stripe-id']]),
    ['a Stripe host label and path', `${DEP}/stripe-host.js`, `fetch('https://${synth(16, lower)}.${stripe}/v1/${synth(24)}')\nfetch('https://api.${stripe}/v1/${synth(24)}')\n`, ['stripe-client']],
    ['a Stripe package name', `${DEP}/a/package.json`, JSON.stringify({ name: `@stripe/${synth(24)}` }), ['stripe-sdk']],
    ['a Stripe dependency name', `${OWN}/b/package.json`, JSON.stringify({ name: 'x', dependencies: { [`@stripe/${synth(24)}`]: synth(24) }, bundledDependencies: [`stripe/${synth(24)}`] }), ['stripe-sdk']],
    ['a Stripe import path', `${DEP}/stripe-import.js`, `import a from 'stripe/${synth(24)}/x.js'\nimport b from '@stripe/${synth(24)}'\nconst c = require("@stripe/x/${synth(24)}")\n`, ['stripe-sdk']],
    ['a billing import: before, in, between, after, query', `${OWN}/imports.js`, [
      `import a from './${synth(24)}/billing/${synth(24)}/ledger/${synth(24)}.js?t=${synth(24)}'`,
      `import b from './x/billing-${synth(24)}.mjs'`,
      `const c = await import('./ledger/${synth(24)}/billing/index.js#${synth(24)}')`,
      '',
    ].join('\n'), ['billing-import']],
    ['a billing route: before, between, after, query', `${OWN}/routes.js`, [
      `r.get('/${synth(24)}/billing/${synth(24)}/ledger/${synth(24)}/billing/${synth(24)}?k=${synth(24)}', h)`,
      `r.get('/api/billing/${synth(24)}/ledger/events', h)`,
      `r.get('/api/ledger/${synth(24)}/billing', h)`,
      `r.get('/billing/${synth(24)}/billing', h)`,
      `r.get('/${synth(24)}/ledger', h)`,
      '',
    ].join('\n'), ['billing-route']],
    ['a gateway default: key, userinfo, host, path, query, fragment', `${OWN}/gateway.js`, [
      `const gateway_${synth(20)} = 'https://${synth(12)}:${synth(24)}@${synth(12, lower)}.${vendor}:8443/${synth(24)}?k=${synth(24)}#${synth(24)}'`,
      `const url = env.GATEWAY_${synth(20, upper)} ?? "wss://${synth(12, lower)}.${vendor}/${synth(24)}"`,
      '',
    ].join('\n'), ['gateway-address']],
    ['a gateway credential: key and value', `${OWN}/gateway-credential.js`, `const gateway_${synth(12)}_token = '${synth(32)}'\n`, ['gateway-credential']],
    ['an own gateway host: label, path, query', `${DEP}/own.json`, [
      `{"a":"https://${synth(12, lower)}.gateway.${ownHost}/${synth(24)}?k=${synth(24)}",`,
      ` "b":"wss://api.${ownHost}/${synth(24)}/gateway/${synth(24)}"}`,
      '',
    ].join('\n'), ['gateway-address']],
    ['a private name', `${DEP}/name.txt`, `${shortName}\n`, ['private-name']],
    // Low entropy: four digits. A hash of the match, or of this small file, is guessable offline.
    ['a four-digit token in a URL', `${DEP}/pin.txt`, `https://host.invalid/x?token=${pin}\n`, ['token-url']],
    ['a four-digit gateway default', `${OWN}/pin.js`, `const gatewayUrl = 'https://${vendor}/${pin}'\n`, ['gateway-address']],
  ]
  const dir = rootfs()
  for (const [, file, content] of rows) write(dir, file, content)
  // The image config: a secret in a variable's name and in its value, and in a label.
  const config = JSON.stringify({
    Env: [
      'PATH=/usr/bin',
      `GATEWAY_${synth(20, upper)}=enabled`,
      `GATEWAY_PIN=${pin}`,
      `BILLING_${synth(20, upper)}=enabled`,
      `STRIPE_${synth(20, upper)}=${synth(24)}`,
      `LEDGER_MODE_${synth(20, upper)}=${synth(24)}`,
      `GATEWAY_TOKEN_${synth(20, upper)}=enabled`,
      `API_SECRET_${synth(20, upper)}=${synth(24)}`,
      `MODELS=https://${synth(12)}:${synth(24)}@${synth(12, lower)}.gateway.${ownHost}/${synth(24)}?token=${synth(32)}`,
    ],
    Labels: { note: ['sk', 'test', synth(28)].join('_') },
  })
  const configRules = ['env-secret', 'gateway-address', 'billing-config', 'token-url', 'git-credentials', 'stripe-key']

  // A stand-in docker: it answers the inspect, create, export and rm the scan makes, from this
  // rootfs and config. `save` fails, as the scan allows. Nothing is built or run.
  const bin = temp()
  const fake = join(bin, 'docker')
  writeFileSync(join(bin, 'config.json'), config)
  // Its own package.json: the stand-in is an ES module wherever the temp folder is, a checkout
  // whose package.json says otherwise included.
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}\n')
  writeFileSync(fake, [
    `#!${process.execPath}`,
    "import { execFileSync } from 'node:child_process'",
    "import { readFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "const format = args[args.indexOf('--format') + 1] ?? ''",
    "if (args[0] === 'image' && args[1] === 'inspect') {",
    `  if (format.includes('.Config')) process.stdout.write(readFileSync(${JSON.stringify(join(bin, 'config.json'))}, 'utf8'))`,
    "  else if (format.includes('.RootFS')) process.stdout.write('[\"sha256:layer\"]')",
    "  else process.stdout.write('sha256:image')",
    "} else if (args[0] === 'export') {",
    `  execFileSync('tar', ['-cf', args[args.indexOf('--output') + 1], '-C', ${JSON.stringify(dir)}, '.'])`,
    "} else if (args[0] === 'save') process.exit(1)",
    '',
  ].join('\n'), { mode: 0o755 })

  const labels = new Set(Object.values(LABELS))
  // Every digest a hit carries, taken here in memory: of each raw match, of each flagged file's
  // bytes, of every planted file and of the config's bytes. None may be written anywhere.
  const list = { deny: [shortName], allow: [] }
  const hitsHere = [...scanTree(dir, undefined, []).hits, ...configHits(config, list)]
  const digests = new Set([
    ...hitsHere.map((hit) => sha256(hit.raw ?? '')),
    ...hitsHere.map((hit) => hit.fileSha256).filter(Boolean),
    ...rows.map(([, , content]) => sha256Bytes(Buffer.from(content))),
    sha256Bytes(Buffer.from(config)), sha256(config), sha256(pin), sha256(`token=${pin}`),
  ])
  assert.ok(digests.size > 100, String(digests.size))
  assert.ok(digests.has(sha256(`https://host.invalid/x?token=${pin}`)) && digests.has(sha256Bytes(Buffer.from(`https://host.invalid/x?token=${pin}\n`))))
  assert.ok(digests.has(sha256('GATEWAY_PIN')))
  const parts = made.flatMap((value) => [value, value.slice(0, 8), value.slice(-8), value.slice(4, 12)])
  assert.ok(made.length > 80, String(made.length))
  assert.equal(new Set(made).size, made.length)
  const script = join(HERE, '..', 'secrecy.mjs')
  const modes = [
    ['rootfs', ['--rootfs', dir], []],
    ['image', ['automagik-fake:test'], configRules],
  ]
  for (const [mode, args, extra] of modes) {
    const inventory = join(temp(), 'inventory')
    const run = spawnSync(process.execPath, [script, ...args, '--inventory', inventory], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: join(bin, `summary-${mode}.md`) },
    })
    assert.equal(run.status, 1, `${mode}: ${run.stderr.slice(-400)}`)
    const names = readdirSync(inventory)
    for (const name of ['secrecy.txt', 'secrecy-hits.json', 'image-files.txt', 'image-layers.txt', 'image.txt']) assert.ok(names.includes(name), `${mode}: ${name}`)
    const written = [...names.map((name) => readFileSync(join(inventory, name), 'utf8')), readFileSync(join(bin, `summary-${mode}.md`), 'utf8')].join('\n')
    for (const part of parts) {
      assert.ok(!run.stderr.includes(part), `${mode}: stderr holds part of a planted value`)
      assert.ok(!run.stdout.includes(part), `${mode}: stdout holds part of a planted value`)
      assert.ok(!written.includes(part), `${mode}: the inventory holds part of a planted value`)
    }
    // UNKEYED_HASH_IN_OUTPUT: no digest of a match or of a flagged file, in full or cut short.
    for (const digest of digests) {
      for (const [where, text] of [['stderr', run.stderr], ['stdout', run.stdout], ['the inventory', written]]) {
        assert.ok(!text.includes(digest) && !text.includes(digest.slice(0, 16)) && !text.includes(digest.slice(-16)), `${mode}: ${where} holds a digest of a match or a file`)
      }
    }
    const hitsJson = JSON.parse(readFileSync(join(inventory, 'secrecy-hits.json'), 'utf8'))
    assert.ok(hitsJson.length > 0)
    for (const item of hitsJson) {
      assert.deepEqual(Object.keys(item), ['file', 'line', 'rule', 'match'])
      assert.ok(labels.has(item.match))
    }
    assert.ok(!/[0-9a-f]{64}/.test(run.stderr) && !/[0-9a-f]{64}/.test(readFileSync(join(inventory, 'secrecy.txt'), 'utf8')), `${mode}: a 64-hex value is printed`)
    // Every finding line, as written and as printed, ends in a constant of the table.
    const lines = readFileSync(join(inventory, 'secrecy.txt'), 'utf8').trim().split('\n')
    const findings = lines.map((line) => /^(.+?):(\d+): ([a-z-]+): (.*)$/.exec(line))
    for (const [index, found] of findings.entries()) assert.ok(found && labels.has(found[4]), `${mode}: ${lines[index]}`)
    const printed = run.stderr.trim().split('\n').filter((line) => !line.startsWith('[secrecy]'))
    assert.equal(printed.length, lines.length, mode)
    for (const line of printed) {
      const found = /^(.+?):(\d+): ([a-z-]+): (.*)$/.exec(line)
      assert.ok(found && labels.has(found[4]), `${mode}: a printed finding is not a table label`)
    }
    // Every planted field was read: each row raised its rules, in its own file.
    for (const [label, file, , rules] of rows) {
      for (const rule of rules) assert.ok(findings.some((found) => found[1] === file && found[3] === rule), `${mode}: ${label}: no ${rule}`)
    }
    for (const rule of extra) assert.ok(findings.some((found) => found[1] === 'image-config' && found[3] === rule), `${mode}: image-config: no ${rule}`)
    assert.equal(findings.some((found) => found[1] === 'image-config'), extra.length > 0, mode)
  }

  // --repo, the third way in: the same table.
  const repo = temp()
  write(repo, 'a.md', `${['sk', 'live', synth(28)].join('_')} ${['price', synth(24)].join('_')}\n`)
  const repoRun = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8', env: { ...process.env, GIT_DIR: join(repo, 'none') } })
  assert.equal(repoRun.status, 1)
  for (const value of made.slice(-2)) assert.ok(!repoRun.stderr.includes(value.slice(0, 8)) && !repoRun.stdout.includes(value.slice(0, 8)))
})

test('a finding takes its text from the label table or is refused', () => {
  for (const text of Object.values(LABELS)) assert.equal(typeof text, 'string')
  assert.ok(Object.isFrozen(LABELS))
  // The one constructor refuses a text that is not a key of the table, and does not repeat it.
  const planted = `tk${'4Lm2'.repeat(8)}`
  assert.deepEqual(hitOf('f', 1, 'key', planted, 'key-sk'), { file: 'f', line: 1, rule: 'key', raw: planted, match: 'sk-***' })
  for (const label of [planted, undefined, 'toString', 'constructor', LABELS['key-sk'], () => 'key-sk']) {
    assert.throws(() => hitOf('f', 1, 'key', planted, label), (error) => error.message === 'a key finding has no label in the table')
  }
  // Every hit of a scan is a table constant, and the raw text is kept beside it.
  const dir = rootfs()
  const value = `tk${'9xQ7'.repeat(8)}`
  write(dir, `${PLUGIN}/x.js`, `const gatewayUrl = 'ftp-not://x'\nconst gatewayUrl2 = 'https://h.invalid.${['vendor', 'net'].join('.')}/${value}'\n`)
  const found = scanTree(dir, undefined, []).hits
  assert.deepEqual(found.map((hit) => [hit.rule, hit.match]), [['gateway-address', 'gateway default https://***']])
  assert.ok(found[0].raw.includes(value))
  // An image config that is not JSON: the parser's message, which quotes its input, is not passed on.
  assert.throws(() => configHits(`{"Env": [${value}`, { deny: [], allow: [] }), (error) => error.message === 'the image config is not JSON')
})
