import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { join, resolve } from 'node:path'

const [command, verb, ...options] = process.argv.slice(2)
const profile = process.cwd()
const { SUPERVISOR_FIXTURE: root, SUPERVISOR_TEST_PNPM: realPnpm } = process.env
assert.ok(root && profile.startsWith(root + '/'), 'fixture must use its own pnpm cwd')
assert.ok((command === 'config' && verb === 'list') || (command === 'store' && verb === 'path'))
if (realPnpm && process.env.SUPERVISOR_CONFIG_REAL === '1') {
  const result = spawnSync(process.execPath, [realPnpm, command, verb, ...options], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const read = path => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : ''
const settings = {}
for (const source of [process.env.NPM_CONFIG_USERCONFIG, join(profile, '.npmrc')].filter(Boolean)) {
  for (const [, key, value] of read(source).matchAll(/^([\w-]+)\s*=\s*(.+)$/gm)) settings[key] = value
}
for (const [key, value] of Object.entries(process.env)) {
  if (/^npm_config_/i.test(key)) settings[key.slice(11).toLowerCase().replaceAll('_', '-')] = value
}
for (const [, key, value] of read(join(profile, 'pnpm-workspace.yaml')).matchAll(/^([\w-]+):\s+(.+)$/gm)) settings[key] = value
if (command === 'config') {
  assert.deepEqual(options, ['--json'])
  console.log(JSON.stringify(settings))
} else {
  console.log(resolve(profile, settings.storeDir ?? settings['store-dir'] ?? join(root, 'offline-store'), 'v10'))
}
