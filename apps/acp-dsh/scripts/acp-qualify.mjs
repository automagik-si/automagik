#!/usr/bin/env node
// Qualifies one exact connector tuple for native cold continuity (src/host/qualification.js):
// runs the real connector and CLI end to end on the loopback model stub (test/real-backend.test.js)
// in a throwaway home, reads the receipts that run wrote, and records the tuple only when every
// required phase passed. Nothing is installed, signed in or sent off this machine.
//
//   node scripts/acp-qualify.mjs qualify --route acp-claude --adapter <dist/index.js> --cli <claude>
//   node scripts/acp-qualify.mjs revoke --route acp-claude [--adapter-version 0.113.0]
//   node scripts/acp-qualify.mjs list
//
// The record is <AUTOMAGIK_HOME>/acp-continuity.json (`--home` names another folder). The app
// reads it only while its `continuity` setting is `qualified`; `revoke`, or that setting back
// to `off`, restores the fresh-session restart at the next start of each agent.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { readReceipts } from './acp-receipts.mjs'
import { qualificationOf, qualificationPath, readQualification, recordQualification, revokeQualification } from '../src/host/qualification.js'

const PLUGIN = join(import.meta.dirname, '..')
const ENV = { 'acp-claude': ['AUTOMAGIK_TEST_CLAUDE_ACP', 'AUTOMAGIK_TEST_CLAUDE', 'Claude'], 'acp-codex': ['AUTOMAGIK_TEST_CODEX_ACP', 'AUTOMAGIK_TEST_CODEX', 'Codex'] }

export function qualify({ route, adapter, cli, home, run = spawnSync, log = console.log }) {
  const names = ENV[route]
  if (names === undefined) throw new Error(`no qualification scenario for ${route}`)
  const receipts = mkdtempSync(join(tmpdir(), 'acp-qualify-'))
  try {
    const result = run(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', '--test-name-pattern', names[2], 'test/real-backend.test.js'], {
      cwd: PLUGIN, encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, [names[0]]: adapter, [names[1]]: cli, ACP_RECEIPT_DIR: receipts, AUTOMAGIK_TEST_CLAUDE_ACP: route === 'acp-claude' ? adapter : '', AUTOMAGIK_TEST_CODEX_ACP: route === 'acp-codex' ? adapter : '' },
    })
    const read = readReceipts(receipts).filter(item => item.problems.length === 0).map(item => item.receipt)
    const outcome = result.status === 0 ? qualificationOf(read, { route, backend: 'loopback-stub' }) : { refused: [`the scenario failed (exit ${result.status})`] }
    if (outcome.refused) {
      log(`${route}: not qualified: ${outcome.refused.join(', ')}`)
      if (result.status !== 0) log(String(result.stdout ?? '').split('\n').filter(line => /^(not ok|✖|#|ℹ)/.test(line.trim())).slice(0, 20).join('\n'))
      return { qualified: false, refused: outcome.refused }
    }
    recordQualification(qualificationPath(home), outcome.entry)
    log(`${route}: qualified ${outcome.entry.adapter.name} ${outcome.entry.adapter.version} with CLI ${outcome.entry.cli.version} on ${outcome.entry.platform} (backend ${outcome.entry.backend})`)
    return { qualified: true, entry: outcome.entry }
  } finally {
    rmSync(receipts, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { route: { type: 'string' }, adapter: { type: 'string' }, cli: { type: 'string' }, home: { type: 'string' }, 'adapter-version': { type: 'string' } } })
  const home = values.home ?? process.env.AUTOMAGIK_HOME ?? join(homedir(), '.automagik')
  const [command] = positionals
  if (command === 'qualify') {
    if (!values.route || !values.adapter || !values.cli) throw new Error('qualify needs --route, --adapter and --cli')
    process.exitCode = qualify({ route: values.route, adapter: values.adapter, cli: values.cli, home }).qualified ? 0 : 1
  } else if (command === 'revoke') {
    if (!values.route) throw new Error('revoke needs --route')
    console.log(`${values.route}: ${revokeQualification(qualificationPath(home), { route: values.route, adapterVersion: values['adapter-version'] })} entr(ies) revoked`)
  } else if (command === 'list') {
    for (const entry of readQualification(qualificationPath(home))) console.log(`${entry.route} ${entry.adapter.name} ${entry.adapter.version} CLI ${entry.cli.version} ${entry.platform} ${entry.backend} ${entry.qualifiedAt}`)
  } else {
    console.error('usage: acp-qualify.mjs qualify|revoke|list (see the header)')
    process.exitCode = 2
  }
}
