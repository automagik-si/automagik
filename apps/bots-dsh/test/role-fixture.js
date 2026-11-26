import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { bundleDigest } from '../src/host/bundled-roles.js'

export const REPOSITORY = 'https://github.com/automagik-si/automagik'
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const RELEASE = `${REPOSITORY}/releases/download/v${VERSION}/`
export const INDEX = `${RELEASE}roles.json`
export const SIGNATURE = `${INDEX}.sig`
export const SHA256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function solverCutHistory() {
  const source = new URL('../roles/solver/', import.meta.url)
  const files = new Map(['role.json', 'role.mjs', 'prompt.md'].map(name => [name, readFileSync(new URL(name, source))]))
  return { solver: { [VERSION]: bundleDigest(files) } }
}

export function signer(keyId = 'test-key') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    key: { keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) },
    index(roles, fields = {}) {
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, publisher: 'automagik', keyId, version: VERSION, repository: REPOSITORY, roles, ...fields }, null, 2))
      return { bytes, signature: sign(null, bytes, privateKey).toString('base64') }
    },
  }
}

export function tarMember(path, contents = '', { type = '0', size, octal, prefix = '', badChecksum = false } = {}) {
  const bytes = Buffer.from(contents)
  const header = Buffer.alloc(512)
  header.write(path, 0, 100)
  header.write('0000600\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(octal ?? `${(size ?? bytes.length).toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\x0000', 257)
  header.write(prefix, 345, 155)
  const checksum = header.reduce((sum, value) => sum + value, Number(badChecksum))
  header.write(`${checksum.toString(8).padStart(6, '0')}\x00 `, 148)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

export const archive = (members, end = Buffer.alloc(1024)) => gzipSync(Buffer.concat([...members, end]))

export const manifestOf = (fields = {}) => ({
  id: 'sample-role', version: '1.0.0', name: 'Sample role', publisher: 'automagik',
  entry: 'lib/main.mjs', prompt: 'prompt.md', tools: [], capabilities: ['audio-out'],
  settings: [], ui: [], ...fields,
})
export const packageOf = (manifest = manifestOf(), script = 'export {}') => archive([
  tarMember('package/', '', { type: '5' }),
  tarMember('package/role.json', JSON.stringify(manifest)),
  tarMember('package/lib/main.mjs', script),
  tarMember('package/prompt.md', 'Fixture prompt.'),
])

export function entryOf(bytes = packageOf(), fields = {}) {
  const { id = 'sample-role', version = '1.0.0' } = fields
  return {
    name: 'Sample role', publisher: 'automagik', official: true, capabilities: ['audio-out'],
    size: bytes.length, sha256: SHA256(bytes), source: `${RELEASE}automagik-role-${id}-${version}.tgz`,
    ...fields, id, version,
  }
}
