import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  BOT_CLI_POINTER_ENV,
  NATIVE_WORKER_LOGIN_ENV,
  NATIVE_WORKER_LOGIN_REQUIRED,
  nativeWorkerEnv,
} from '../native-worker-login.mjs'
import { generationAt } from '../../apps/acp-dsh/src/host/cli-generations.js'

const VENDORS = ['claude', 'codex']
const READ_ENV = 'process.stdout.write(JSON.stringify({pointer:process.env.AUTOMAGIK_BOT_CLI_POINTER,marker:process.env.AUTOMAGIK_NATIVE_WORKER_LOGIN,home:process.env.HOME}))'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-worker-login-'))
  const root = join(home, 'acp', 'cli-homes')
  const pointers = {}
  for (const vendor of VENDORS) {
    const generation = randomUUID()
    pointers[vendor] = generation
    mkdirSync(join(root, 'homes', vendor, generation), { recursive: true })
    mkdirSync(join(root, 'current'), { recursive: true })
    writeFileSync(join(root, 'current', vendor), generation, { mode: 0o600 })
  }
  return { home, root, pointers }
}

test('one export locates current/, and the same export launches both vendors on their recorded homes', () => {
  const { home, root, pointers } = fixture()
  try {
    const exported = nativeWorkerEnv({ AUTOMAGIK_HOME: home })
    assert.equal(exported[BOT_CLI_POINTER_ENV], join(root, 'current', 'claude'))
    assert.equal(exported[NATIVE_WORKER_LOGIN_ENV], NATIVE_WORKER_LOGIN_REQUIRED)
    assert.equal(exported.DEEPSEEK_API_KEY, undefined)
    assert.deepEqual(Object.keys(exported).filter((key) => key.startsWith('AUTOMAGIK_BOT_CLI_POINTER_')), [])
    for (const vendor of VENDORS) {
      const pointer = join(dirname(exported[BOT_CLI_POINTER_ENV]), vendor)
      const generation = generationAt(pointer)
      assert.equal(generation, pointers[vendor])
      const recordedHome = join(root, 'homes', vendor, generation)
      assert.ok(existsSync(recordedHome))
      const launch = spawnSync(process.execPath, ['-e', READ_ENV], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...exported,
          [BOT_CLI_POINTER_ENV]: pointer,
          AUTOMAGIK_BOT_CLI_HOME: recordedHome,
          HOME: recordedHome,
          ...(vendor === 'codex' ? { CODEX_HOME: join(recordedHome, '.codex') } : { CLAUDE_CONFIG_DIR: join(recordedHome, '.claude') }),
        },
      })
      assert.equal(launch.status, 0, launch.stderr)
      const seen = JSON.parse(launch.stdout)
      assert.equal(seen.pointer, pointer)
      assert.equal(seen.marker, NATIVE_WORKER_LOGIN_REQUIRED)
      assert.equal(seen.home, recordedHome)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the export reaches the core and a pane it spawns; the reader carries it into the env -i re-run', () => {
  const { home, root, pointers } = fixture()
  try {
    const exported = nativeWorkerEnv({ AUTOMAGIK_HOME: home })
    const core = spawnSync(process.execPath, ['-e', `
      const { spawnSync } = require('node:child_process')
      const pane = spawnSync(process.execPath, ['-e', ${JSON.stringify(READ_ENV)}], { encoding: 'utf8' })
      if (pane.status !== 0) { process.stderr.write(pane.stderr); process.exit(1) }
      process.stdout.write(pane.stdout)
    `], { encoding: 'utf8', env: { ...process.env, ...exported } })
    assert.equal(core.status, 0, core.stderr)
    const pane = JSON.parse(core.stdout)
    assert.equal(pane.pointer, exported[BOT_CLI_POINTER_ENV])
    assert.equal(pane.marker, NATIVE_WORKER_LOGIN_REQUIRED)

    const allow = {
      USER: process.env.USER || 'bot',
      LOGNAME: process.env.LOGNAME || 'bot',
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: home,
      HERDR_APP_HOME: home,
      TMPDIR: tmpdir(),
      XDG_RUNTIME_DIR: tmpdir(),
      HERMES_HOME: home,
      VIRTUAL_ENV: home,
      AUTOMAGIK_HERDR_SESSION: 'test',
    }
    const stripped = spawnSync('env', ['-i', ...Object.entries(allow).map(([key, value]) => `${key}=${value}`), process.execPath, '-e', READ_ENV], { encoding: 'utf8' })
    assert.equal(stripped.status, 0, stripped.stderr)
    const without = JSON.parse(stripped.stdout)
    assert.equal(without.pointer, undefined)
    assert.equal(without.marker, undefined)

    const readerAllow = {
      ...allow,
      [BOT_CLI_POINTER_ENV]: exported[BOT_CLI_POINTER_ENV],
      [NATIVE_WORKER_LOGIN_ENV]: exported[NATIVE_WORKER_LOGIN_ENV],
    }
    const carried = spawnSync('env', ['-i', ...Object.entries(readerAllow).map(([key, value]) => `${key}=${value}`), process.execPath, '-e', READ_ENV], { encoding: 'utf8' })
    assert.equal(carried.status, 0, carried.stderr)
    const rerun = JSON.parse(carried.stdout)
    assert.equal(rerun.pointer, exported[BOT_CLI_POINTER_ENV])
    assert.equal(rerun.marker, NATIVE_WORKER_LOGIN_REQUIRED)

    for (const vendor of VENDORS) {
      const pointer = join(dirname(exported[BOT_CLI_POINTER_ENV]), vendor)
      assert.equal(generationAt(pointer), pointers[vendor])
      assert.ok(existsSync(join(root, 'homes', vendor, pointers[vendor])))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the marker is set, not auth, and a damaged pointer leaves the record unverified', () => {
  const { home, root } = fixture()
  try {
    const exported = nativeWorkerEnv({ AUTOMAGIK_HOME: home })
    assert.equal(exported[NATIVE_WORKER_LOGIN_ENV], 'required')
    assert.equal(exported.DEEPSEEK_API_KEY, undefined)
    const damaged = join(dirname(exported[BOT_CLI_POINTER_ENV]), 'claude')
    writeFileSync(damaged, 'not-a-generation', { mode: 0o600 })
    assert.throws(() => generationAt(damaged), /account|sign|again/i)
    const missing = join(dirname(exported[BOT_CLI_POINTER_ENV]), 'other')
    assert.equal(generationAt(missing), 'legacy')
    assert.ok(!existsSync(join(root, 'other')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
