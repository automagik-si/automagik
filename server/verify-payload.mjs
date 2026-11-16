#!/usr/bin/env node
// Build-time proof that the vendored session-absorption payload is exactly the reviewed bytes.
// Runs in the builder stage before assemble; the in-image smoke checks the same constants again
// against the installed copies.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGISTRY_SEED_SHA256, REGISTRY_SEED_VENDOR, SKILL_NAME, SKILL_SHA256 } from './toolchain.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))

function verify({ root = join(ROOT, 'skills', SKILL_NAME), name = SKILL_NAME, hashes = SKILL_SHA256 } = {}) {
  for (const [relative, expected] of Object.entries(hashes)) {
    const actual = createHash('sha256').update(readFileSync(join(root, relative))).digest('hex')
    if (actual !== expected) throw new Error(`${name}/${relative}: sha256 ${actual}, not the pinned ${expected}`)
  }
  return Object.keys(hashes)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const files = verify()
    const seed = verify({ root: join(ROOT, 'vendor', 'registry-seed'), name: 'registry-seed', hashes: REGISTRY_SEED_SHA256 })
    console.log(`[payload] ${SKILL_NAME}: ${files.length} files match their pinned sha256`)
    console.log(`[payload] registry-seed: ${seed.length} files match ${REGISTRY_SEED_VENDOR}`)
  } catch (error) {
    console.error(`[payload] ${error?.message ?? error}`)
    process.exit(1)
  }
}

export { verify }
