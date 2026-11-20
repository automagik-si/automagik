import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareStore } from '../../src/host/supervisor/store.js'
import { downloadPath, stagePaths, VENDOR } from '../../src/host/supervisor/stage.js'

export const BOTS = '@automagik/bots-dsh'
export const WELCOME = '@automagik/welcome-dsh'
export const FROM = '3.160.2'
export const TO = '3.160.3'
export const RUN_ID = 'test-run-001'
export const REGISTRY = 'https://registry.example.invalid/npm/'
export const HOST = fileURLToPath(new URL('../../src/host', import.meta.url))
export const MAIN = join(HOST, 'supervisor/main.js')
export const digest = (algorithm, bytes, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
export const read = path => JSON.parse(fs.readFileSync(path))
export const write = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

export function fixture(t, { plugins = [BOTS], mode } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'bots-supervisor-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'dsh')
  const profile = 'web'
  const profileDir = join(home, 'profiles', profile)
  const botsHome = join(root, 'bots-home')
  const dshPackage = join(root, 'runtime/node_modules/@deepseek-ai/dsh')
  const dshBin = join(dshPackage, 'lib/bin.js')
  const events = join(root, 'events.jsonl')
  const bin = join(root, 'bin')
  fs.mkdirSync(bin)
  const fakePnpm = fileURLToPath(new URL('./supervisor-pnpm.mjs', import.meta.url))
  fs.writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexec "' + process.execPath + '" "' + fakePnpm + '" "$@"\n', { mode: 0o700 })
  fs.mkdirSync(dirname(dshBin), { recursive: true })
  write(join(dshPackage, 'package.json'), { type: 'module', version: '0.2.2-rc.2' })
  fs.copyFileSync(fileURLToPath(new URL('./supervisor-dsh.mjs', import.meta.url)), dshBin)
  fs.copyFileSync(fileURLToPath(new URL('./supervisor-lock.mjs', import.meta.url)), join(dirname(dshBin), 'supervisor-lock.mjs'))
  fs.mkdirSync(botsHome)
  write(join(botsHome, 'state.json'), { version: 2, note: 'preserve me' })
  fs.mkdirSync(join(profileDir, VENDOR), { recursive: true })
  const oldArchive = `${'a'.repeat(64)}.tgz`
  const archive = join(profileDir, VENDOR, oldArchive)
  fs.writeFileSync(archive, 'an older updater-owned archive')
  fs.writeFileSync(join(profileDir, 'vendor/owner.tgz'), 'owner archive')
  const manifest = {
    name: 'fixture', private: true,
    dependencies: Object.fromEntries([...plugins.map(name => [name, `file:${VENDOR}/${oldArchive}`]), ['custom-plugin', '^1.0.0']]),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', ...plugins, 'custom-plugin'] } },
  }
  write(join(profileDir, 'package.json'), manifest)
  fs.writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `before: file:${VENDOR}/${oldArchive}\n`)
  fs.writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: [.]\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: /shared/pnpm-store\n')
  write(join(profileDir, 'compatibility.json'), { version: 1, exemptions: [] })
  fs.writeFileSync(join(profileDir, 'cordis.patch.yml'), '- secret: owner-value\n')
  fs.writeFileSync(join(profileDir, '.npmrc'), `registry=${REGISTRY}\n`)
  for (const name of plugins) {
    const dir = join(profileDir, 'node_modules', name)
    fs.mkdirSync(dir, { recursive: true })
    write(join(dir, 'package.json'), { name, version: FROM })
  }
  const tarballs = new Map()
  const release = plugins.map(name => {
    const bytes = Buffer.from(`test archive for ${name}`)
    const url = `https://github.com/example/fixture/releases/download/v${TO}/${name.split('/')[1]}.tgz`
    tarballs.set(url, bytes)
    return {
      name, version: TO, url, engines: { dsh: '>=0.2.2-rc.1' },
      size: bytes.length, sha256: digest('sha256', bytes), integrity: `sha512-${digest('sha512', bytes, 'base64')}`,
    }
  })
  const testEnv = { ...process.env }
  for (const key of ['NODE_OPTIONS', 'NPM_CONFIG_REGISTRY', 'npm_config_registry', 'AUTOMAGIK_SUPERVISOR_BOOT', 'AUTOMAGIK_SUPERVISOR_VERSION']) {
    delete testEnv[key]
  }
  const env = {
    ...testEnv, PATH: bin + ':' + testEnv.PATH, AUTOMAGIK_BOTS_HOME: botsHome, SUPERVISOR_FIXTURE: root, SUPERVISOR_MODE: mode ?? '',
    SUPERVISOR_HOST_SOURCE: HOST,
    XDG_CONFIG_HOME: join(root, 'config'), NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'),
    SUPERVISOR_PACKAGES: JSON.stringify(Object.fromEntries(release.map(plugin => [plugin.sha256, { name: plugin.name, version: plugin.version }]))),
  }
  const command = [process.execPath, dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0', 'verbatim value']
  const store = prepareStore(profileDir)
  const config = { profileDir, profile, home, store, env, command }
  const staging = stagePaths(store, RUN_ID, profile)
  const versions = new Map(plugins.map(name => [name, FROM]))
  return { ...config, config, staging, root, botsHome, events, release, tarballs, archive, manifest, versions }
}

export function putDownloads(f) {
  fs.mkdirSync(f.staging.root, { mode: 0o700 })
  for (const plugin of f.release) fs.writeFileSync(downloadPath(f.staging, plugin), f.tarballs.get(plugin.url))
  return { plugins: f.release, registry: REGISTRY }
}

export function lane(f, edit = () => {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keys = [{ keyId: 'supervisor-test', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }]
  const pointer = { schemaVersion: 1, keyId: keys[0].keyId, version: TO, sequence: 42, plugins: f.release }
  edit(pointer)
  const bytes = Buffer.from(JSON.stringify(pointer))
  const path = join(f.root, 'lane.json')
  fs.writeFileSync(path, bytes)
  fs.writeFileSync(path + '.sig', sign(null, bytes, privateKey).toString('base64'))
  return { laneUrl: pathToFileURL(path).href, keys, path }
}

export function eventsOf(f) {
  if (!fs.existsSync(f.events)) return []
  return fs.readFileSync(f.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
