import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const LEGACY_CONTRACT = Object.freeze({
  version: 1, holdRun: true, stateFormats: Object.freeze([0, 1, 2, 3]),
})
export const CONTRACT_PATH = 'src/host/update-contract.json'
const W1_FORMATS = [0, 1, 2, 3, 4, 5]
const activationId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function readFormatContract(plugin) {
  const contract = JSON.parse(fs.readFileSync(join(plugin, CONTRACT_PATH)))
  assert.equal(contract?.version, 1)
  assert.equal(contract.holdRun, true)
  assert.ok(Array.isArray(contract.stateFormats), 'stateFormats must be an array')
  const formats = [...contract.stateFormats].sort((a, b) => a - b)
  if (formats.length === LEGACY_CONTRACT.stateFormats.length) {
    assert.deepEqual(formats, LEGACY_CONTRACT.stateFormats)
    if (contract.activations !== undefined) assert.deepEqual(contract.activations, [])
    return { contract, legacy: true }
  }
  assert.deepEqual(formats, W1_FORMATS, 'formats 4 and 5 must activate together')
  const { activations } = contract
  assert.ok(Array.isArray(activations) && activations.length > 0
    && activations.every(id => typeof id === 'string' && activationId.test(id))
    && new Set(activations).size === activations.length, '4/5 must advertise valid, unique activation IDs')
  return { contract, legacy: false }
}

const attachedAt = '2026-11-01T00:00:00.000Z'
export const activationIds = Object.freeze({ registry: 'w1-registry-pin-v1', stack: 'w1-role-stack-v1' })
const orchestrator = Object.freeze({ id: 'orchestrator', version: '1.0.0', attachedAt, grants: Object.freeze(['task-start']) })
export const pins = Object.freeze({
  registry: Object.freeze({ ...orchestrator, source: 'registry' }),
  catalogOrchestrator: orchestrator,
  solver: Object.freeze({ id: 'solver', version: '1.0.0', attachedAt, grants: Object.freeze(['task-start']) }),
  voice: Object.freeze({ id: 'voice-mouth', version: '1.0.0', attachedAt, grants: Object.freeze(['audio-out']) }),
})

function encryptedConnector() {
  // Authenticate the legacy envelope independently. The fixture home has no connector key.
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const aad = Buffer.from(JSON.stringify(['v1', 'service', 'env', 'TOKEN', [null]]))
  const plaintext = Buffer.from(JSON.stringify(['disposable-fixture-value']))
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad)
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    const check = createDecipheriv('aes-256-gcm', key, iv)
    check.setAAD(aad)
    check.setAuthTag(tag)
    assert.deepEqual(Buffer.concat([check.update(data), check.final()]), plaintext)
    return { service: { custom: { command: 'fixture-never-exec', env: { TOKEN: {
      enc: 'v1', kid: sha256(key).slice(0, 16), parts: [null],
      iv: iv.toString('base64'), data: data.toString('base64'), tag: tag.toString('base64'),
    } } } } }
  } finally {
    key.fill(0)
    plaintext.fill(0)
  }
}

export function rosterBytes(format, {
  revision = 7, roles = [pins.solver], stateActivations, connectors, catalogControl = false,
} = {}) {
  assert.ok(W1_FORMATS.includes(format))
  const state = {
    ...(format === 0 ? {} : { version: format }),
    revision, autoStamp: revision, capabilities: { items: {} }, rooms: {}, mainBotIds: ['a', 'b'],
    reviewGuardMigrated: true, guardGroupMigrated: true,
    whaleStored: true, octopusStored: true, genieClayStored: true, claudeCodeMoved: true,
    bots: {
      a: { id: 'a', name: 'Fixture A', color: 'deepseek', capabilities: [], reviewGuard: true, reviewerId: 'b', roles },
      b: { id: 'b', name: 'Fixture B', color: 'deepseek', capabilities: [], kind: 'genie' },
      ...(catalogControl ? { c: {
        id: 'c', name: 'Fixture Catalog', color: 'deepseek', capabilities: [], roles: [pins.catalogOrchestrator],
      } } : {}),
    },
    ...(stateActivations === undefined ? {} : { stateActivations }),
    ...(format === 3 || format === 5 ? { connectors: connectors ?? encryptedConnector() } : {}),
  }
  return Buffer.from(' \n' + JSON.stringify(state, null, 2) + '\n')
}

export function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'w1-format-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
