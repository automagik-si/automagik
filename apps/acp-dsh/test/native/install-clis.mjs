import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isExecutable } from '../../src/host/agents.js'
import { cliLayout, cliVersion } from '../../src/host/clis.js'

const exec = promisify(execFile)

export function readPins() {
  return JSON.parse(readFileSync(new URL('./clis.json', import.meta.url), 'utf8'))
}

export async function installPinned(dir, pins = readPins()) {
  const root = resolve(dir)
  const binaries = {}
  for (const key of ['claude', 'codex']) {
    const pin = pins[key]
    const url = new URL(pin.tarball)
    assert.ok(url.origin === 'https://registry.npmjs.org', 'Unexpected CLI registry')
    assert.ok(/^\d+\.\d+\.\d+$/.test(pin.version), 'Invalid CLI version pin')
    assert.ok(/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity), 'Invalid CLI integrity pin')
    const layout = cliLayout({ key }, pin.version, { platform: 'darwin', arch: 'arm64', musl: false })
    assert.ok(layout.pkg === pin.package, 'CLI pin does not match the platform package')
    if (key === 'codex') {
      assert.ok(basename(url.pathname) === `codex-${pin.version}-darwin-arm64.tgz`,
        'Codex pin does not match the platform tarball')
    }

    const response = await fetch(url, { redirect: 'error' })
    assert.ok(response.ok, 'CLI archive download failed')
    const buffer = Buffer.from(await response.arrayBuffer())
    const integrity = 'sha512-' + createHash('sha512').update(buffer).digest('base64')
    assert.ok(integrity === pin.integrity, 'CLI archive integrity check failed')

    mkdirSync(root, { recursive: true, mode: 0o700 })
    const archive = join(root, `${key}.tgz`)
    writeFileSync(archive, buffer, { mode: 0o600 })
    const packageDir = join(root, 'node_modules', layout.pkg)
    mkdirSync(packageDir, { recursive: true })
    await exec('/usr/bin/tar', ['-xzf', archive, '-C', packageDir, '--strip-components', '1'])
    const bin = layout.bins.map(path => join(root, path)).find(isExecutable)
    assert.ok(bin && await cliVersion(bin) === pin.version, 'Installed CLI version check failed')
    binaries[key] = bin
  }
  return binaries
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.error('Pinned native CLI installation requires darwin-arm64')
    process.exitCode = 1
    return
  }
  const pins = readPins()
  const { claude, codex } = await installPinned(resolve(process.argv[2]), pins)
  console.log(`ACP_NATIVE_CLAUDE=${claude}\nACP_NATIVE_CODEX=${codex}`)
  console.error(`installed Claude Code ${pins.claude.version}, Codex ${pins.codex.version} (registry integrity verified)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Pinned native CLI installation failed')
    process.exitCode = 1
  })
}
