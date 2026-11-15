#!/usr/bin/env node
// CI evidence from an owned, stopped container of the exact candidate image ID.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKOUT_REPOSITORY, CHILD, sha256, validateInput } from './checkout-input.mjs'
import { DEFAULT_PACKAGES } from './fetch-plugins.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLED_CHILD = '/opt/automagik/profile/node_modules/@automagik/bots-dsh/src/host/browser/script-child.js'
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function assertPublish(event, kind) {
  if (!['release', 'workflow_dispatch'].includes(event) || kind !== 'release') throw new Error('publication requires release/dispatch and release inputs')
}

export function proveImage({ image, kind, event, revision, version, manifest = '', child = '' }, run = docker) {
  const source = validateInput({ kind, event, revision, version, manifest, repository: CHECKOUT_REPOSITORY })
  if (kind === 'release') assertPublish(event, kind)
  if (!/^[0-9a-f]{40}$/.test(revision) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid image identity')
  if (kind === 'checkout' && !/^[0-9a-f]{64}$/.test(child)) throw new Error('independent child digest required')
  const inspected = JSON.parse(run(['image', 'inspect', image]))
  if (inspected.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(inspected[0]?.Id)) throw new Error('invalid candidate image ID')
  const { Id: imageId, Config: config } = inspected[0]
  const labels = config?.Labels ?? {}
  if (labels['ai.automagik.input.kind'] !== kind || (labels['ai.automagik.input.manifest'] ?? '') !== manifest ||
      labels['org.opencontainers.image.revision'] !== revision ||
      labels['org.opencontainers.image.version'] !== (kind === 'checkout' ? `checkout-${revision}` : version)) throw new Error('candidate image source labels mismatch')
  const temp = mkdtempSync(join(tmpdir(), 'automagik-image-source-'))
  const container = `automagik-source-${randomUUID()}`
  let created = false
  try {
    run(['create', '--name', container, imageId])
    created = true
    if (run(['inspect', container, '--format', '{{.Image}}']) !== imageId) throw new Error('container is not the inspected image')
    run(['cp', `${container}:/opt/automagik/versions.json`, join(temp, 'versions.json')])
    const versions = JSON.parse(readFileSync(join(temp, 'versions.json'), 'utf8'))
    if (versions.automagik !== version || versions.revision !== revision ||
        JSON.stringify(versions.source) !== JSON.stringify(source) ||
        DEFAULT_PACKAGES.some((name) => versions.plugins?.[name] !== version)) throw new Error('loaded image source metadata mismatch')
    let installedChild
    if (kind === 'checkout') {
      run(['cp', `${container}:${INSTALLED_CHILD}`, join(temp, 'child.js')])
      installedChild = sha256(readFileSync(join(temp, 'child.js')))
      if (installedChild !== child) throw new Error('installed child differs from committed checkout')
    }
    return { schema: 1, image, imageId, revision, version, source,
      ...(kind === 'checkout' ? { path: INSTALLED_CHILD, checkoutChild: child, installedChild } : {}) }
  } finally {
    try { if (created) run(['rm', container]) } finally { rmSync(temp, { recursive: true, force: true }) }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2)
  const { EVENT: event, INPUT_KIND: kind, REVISION: revision, CONTENT: version, TAG: tag,
    INPUT_MANIFEST: manifest = '', CHILD_SHA: child = '' } = process.env
  if (command === 'check-publish') assertPublish(event, kind)
  else if (command === 'checkout' || command === 'release') {
    if (kind !== command) throw new Error('proof command and input kind differ')
    if (kind === 'checkout') {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
      const committed = execFileSync('git', ['show', `${revision}:${CHILD}`], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })
      if (head !== revision || sha256(committed) !== child || sha256(readFileSync(join(ROOT, CHILD))) !== child) throw new Error('proof is not bound to committed workflow checkout')
    }
    const proof = proveImage({ image: `automagik-server:${tag}`, kind, event, revision, version, manifest, child })
    writeFileSync(`${command}-image-proof.json`, `${JSON.stringify(proof, null, 2)}\n`)
    console.log(`${command} source verified: ${proof.imageId}`)
  } else throw new Error('expected check-publish, checkout or release')
}
