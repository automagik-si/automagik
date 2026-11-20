import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { safeDshLine } from '../entrypoint.mjs'
import { installVendorClis } from '../first-boot.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))

const profileOf = (root) => {
  const profile = join(root, 'profile')
  const host = join(profile, 'node_modules', '@automagik', 'acp-dsh', 'src', 'host')
  mkdirSync(host, { recursive: true })
  writeFileSync(join(host, 'clis.js'), `export class CliStore {
    binOf(pkg) {
      const claude = pkg.includes('claude')
      const present = claude ? process.env.TEST_CLAUDE_PRESENT === '1' : process.env.TEST_CODEX_PRESENT === '1'
      return present ? { path: process.env[claude ? 'TEST_CLAUDE_PATH' : 'TEST_CODEX_PATH'], version: '1.0.0', managed: true } : undefined
    }
    dispose() {}
  }
`)
  writeFileSync(join(host, 'agents.js'), `export const AGENTS = {
    'acp-claude': { key: 'claude', cliPackage: '@anthropic-ai/claude-code', defaultName: 'Claude Code' },
    'acp-codex': { key: 'codex', cliPackage: '@openai/codex', defaultName: 'Codex' },
  }
`)
  return profile
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'automagik-vendor-observer-'))
  const profile = profileOf(root)
  const home = join(root, 'home')
  const appHome = join(home, 'herdr-app')
  const claudePath = join(home, 'acp', 'clis', 'anthropic-ai__claude-code', '1.0.0', 'claude')
  const codexPath = join(home, 'acp', 'clis', 'openai__codex', '1.0.0', 'codex')
  mkdirSync(dirname(claudePath), { recursive: true })
  mkdirSync(dirname(codexPath), { recursive: true })
  writeFileSync(claudePath, '')
  writeFileSync(codexPath, '')
  Object.assign(process.env, {
    TEST_CLAUDE_PATH: claudePath, TEST_CODEX_PATH: codexPath,
    TEST_CLAUDE_PRESENT: '1', TEST_CODEX_PRESENT: '1',
  })
  return { root, profile, home, appHome, claudePath, codexPath, env: { ...process.env, HERDR_APP_HOME: appHome, AUTOMAGIK_PNPM: '/bin/true' } }
}

test('an update warning with both CLIs present leaves both ready and bridged', async () => {
  const ctx = setup()
  try {
    const result = await installVendorClis({
      home: ctx.home, profile: ctx.profile, env: ctx.env,
      failureFor: () => 'Claude Code update check failed: offline',
      log: () => {}, warn: () => {},
    })
    assert.equal(result.state, 'ready')
    assert.equal(result.results['acp-claude'].state, 'ready')
    assert.equal(result.results['acp-codex'].state, 'ready')
    const programs = JSON.parse(readFileSync(join(ctx.appHome, 'programs.json'), 'utf8'))
    assert.equal(programs.programs.claude.run[0], ctx.claudePath)
    assert.equal(programs.programs.codex.run[0], ctx.codexPath)
  } finally {
    rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('a real failure of one vendor fails only that vendor', async () => {
  const ctx = setup()
  process.env.TEST_CLAUDE_PRESENT = '0'
  try {
    const warning = safeDshLine(`Claude Code update check failed token=SECRET-${'z'.repeat(5000)}`)
    const result = await installVendorClis({
      home: ctx.home, profile: ctx.profile, env: ctx.env,
      failureFor: (spec) => (spec.key === 'claude' ? warning : undefined),
      log: () => {}, warn: () => {},
    })
    assert.equal(result.state, 'failed')
    assert.equal(result.results['acp-claude'].state, 'failed')
    assert.equal(result.results['acp-codex'].state, 'ready')
    assert.ok(result.results['acp-claude'].error.includes('Claude Code update check failed'))
    assert.ok(!JSON.stringify(result.results).includes('SECRET-'), 'the failure state carried the token')
    const state = JSON.parse(readFileSync(join(ctx.home, 'vendor-clis-state.json'), 'utf8'))
    assert.ok(!JSON.stringify(state).includes('SECRET-'), 'the state file carried the token')
    const programs = JSON.parse(readFileSync(join(ctx.appHome, 'programs.json'), 'utf8'))
    assert.equal(programs.programs.codex.run[0], ctx.codexPath)
    assert.equal(programs.programs.claude, undefined)
  } finally {
    process.env.TEST_CLAUDE_PRESENT = '1'
    rmSync(ctx.root, { recursive: true, force: true })
  }
})
