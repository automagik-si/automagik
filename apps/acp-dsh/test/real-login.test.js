// The daily link-start check uses the app's isolated homes and ends before any sign-in completes.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { AGENTS, signedInOf } from '../src/host/agents.js'
import { CliHomes } from '../src/host/cli-homes.js'
import { CliLogins, STARTUP_MS, isLoginUrl } from '../src/host/login.js'

async function linkStart(logins, id, cli, env) {
  const signedIn = await signedInOf(AGENTS[id], cli, { env })
  if (signedIn !== false) return {
    status: 'precondition', cause: signedIn === true ? 'isolated CLI was already signed in' : 'isolated CLI sign-in status was unreadable',
  }

  try {
    const deadline = performance.now() + STARTUP_MS + 1000
    let view = logins.start(id)
    while (view.status === 'starting' && performance.now() < deadline) {
      await wait(100)
      view = logins.status(id, view.attemptId)
    }
    if (view.status === 'ready') return { status: 'precondition', cause: 'sign-in became ready without a link' }
    if (view.status !== 'waiting') return {
      status: view.status, cause: view.cause ?? (view.status === 'starting' ? 'no sign-in link in time' : 'sign-in ended before the link'), retry: true,
    }

    const validUrl = isLoginUrl(id, view.url)
    const hasCode = typeof view.userCode === 'string' && view.userCode.length > 0
    const passed = validUrl && (id !== 'acp-codex' || hasCode)
    return {
      status: view.status, cause: !validUrl ? 'unsupported sign-in link' : passed ? 'link reached' : 'device code missing',
      validUrl, hasCode, retry: !passed,
    }
  } finally {
    // Stop cancels the attempt and waits for the whole process tree before we reuse the home.
    await logins.stop(id)
  }
}

for (const [id, name, cli] of [
  ['acp-claude', 'Claude Code', process.env.AUTOMAGIK_TEST_CLAUDE],
  ['acp-codex', 'Codex', process.env.AUTOMAGIK_TEST_CODEX],
]) {
  const skip = !['linux', 'darwin'].includes(process.platform) || process.env.AUTOMAGIK_TEST_LIVE_LOGIN !== '1' || !cli
  test(`real ${name}: sign-in reaches its link (link-start check)`, { skip, timeout: 135_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'acp-real-login-'))
    let homes
    let logins
    let result
    try {
      homes = new CliHomes(root)
      const env = { ...homes.environment(AGENTS[id].key), PATH: process.env.PATH }
      logins = new CliLogins({ resolve: () => ({ cli, env }) })
      result = await linkStart(logins, id, cli, env)
      if (result.retry) result = await linkStart(logins, id, cli, env)
    } catch {
      result = { status: 'error', cause: 'could not run the isolated sign-in' }
    } finally {
      try {
        logins?.dispose()
        await logins?.drain(id)
        homes?.dispose()
        rmSync(root, { recursive: true, force: true })
      } catch {
        result = { status: 'error', cause: 'could not clean up the isolated sign-in' }
      }
    }
    // The workflow reads these fixed fields. Never pass the CLI's output or the attempt view to TAP.
    t.diagnostic(`real ${name} link-start: status=${result.status}, cause=${result.cause}`)
    assert.equal(result.validUrl === true, true, result.cause)
    if (id === 'acp-codex') assert.equal(result.hasCode === true, true, result.cause)
  })
}
