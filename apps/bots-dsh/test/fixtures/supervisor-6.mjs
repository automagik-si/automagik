import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const root = new URL('./supervisor-6/', import.meta.url)
const digests = JSON.parse(readFileSync(new URL('sha256.json', root)))

export function frozen6Bytes(file, bytes = readFileSync(new URL(file, root))) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digests[file], 'delivery 6 fixture: ' + file)
  return bytes
}
