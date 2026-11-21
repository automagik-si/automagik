import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { omniJobFailure, omniSmokeErrorLines, untrustedOutput } from '../omni-smoke-report.mjs'

test('formats the failed job, step, diagnostic, next action and log', () => {
  assert.deepEqual(omniSmokeErrorLines(omniJobFailure({
    phase: 'failed', step: 'download', error: "GitHub's API rate limit was reached.", next: 'retry',
    mismatch: ['phase', 'report.version'], log: 'Checking the pin\nGit fallback failed',
  })), [
    "OMNI SMOKE FAILED: Omni job failed at download (next: retry): GitHub's API rate limit was reached.",
    'mismatch: phase, report.version',
    'job log:', 'Checking the pin', 'Git fallback failed',
  ])
})

test('reports the mismatch for a done job with no failed step or error', () => {
  assert.deepEqual(omniSmokeErrorLines(omniJobFailure({
    phase: 'done', step: null, error: null, next: null, mismatch: ['report.version'], log: '',
  })), [
    'OMNI SMOKE FAILED: Omni job done at no step (next: none): no error',
    'mismatch: report.version',
  ])
})

test('the container sends complete log lines so the host redacts before capping output', () => {
  const output = Array.from({ length: 19 }, (_, i) => ('output ' + i).padEnd(300, '.'))
  const secret = 'pwd="a SENTINEL' + ' '.repeat(5000) + '"'
  const long = 'x'.repeat(5000)
  const log = [...output, '', secret, '   ', long, ''].join('\r\n')
  const containerReport = runInNewContext(`(${omniJobFailure})`, { TextEncoder })
  const received = JSON.parse(JSON.stringify(containerReport({ phase: 'failed', log })))
  assert.deepEqual(received.lines.slice(1), [...output.slice(1), secret, long])
  assert.deepEqual(omniSmokeErrorLines(received), [
    'OMNI SMOKE FAILED: Omni job failed at no step (next: none): no error',
    'job log:', ...output.slice(1), 'pwd="<redacted>"', 'x'.repeat(299) + '…',
  ])
})

test('redacts unterminated credentials from the emitted job headline and log', () => {
  for (const key of ['private_key', 'pwd']) {
    const cut = key + '="a SENTINEL' + ' '.repeat(700)
    const lines = omniSmokeErrorLines(omniJobFailure({
      phase: 'failed', step: 'build', error: cut, next: 'retry', log: cut,
    }))
    assert.equal(lines[0], 'OMNI SMOKE FAILED: Omni job failed at build (next: retry): ' + key + '=<redacted>')
    assert.equal(lines.at(-1), key + '=<redacted>')
    assert.doesNotMatch(lines.join('\n'), /SENTINEL/)
  }
})

test('discards the first potentially partial line from a near-full legacy job log', () => {
  const containerReport = runInNewContext(`(${omniJobFailure})`, { TextEncoder })
  for (const filler of ['x'.repeat(8189), '界'.repeat(2729) + 'xx']) {
    const log = ['a SENTINEL"', ...Array(6).fill(filler), ''].join('\n')
    const lines = omniSmokeErrorLines(containerReport({ phase: 'failed', log }))
    assert.equal(lines.length, 8)
    assert.doesNotMatch(lines.join('\n'), /SENTINEL/)
  }
})

test('places untrusted diagnostic lines between workflow command stop and resume markers', () => {
  const lines = omniSmokeErrorLines('ordinary diagnostic\n::warning::x')
  const token = randomUUID().replaceAll('-', '')
  const output = untrustedOutput(lines, token)
  assert.match(output[0], /^::stop-commands::[a-f0-9]{32}$/)
  assert.deepEqual(output, [
    '::stop-commands::' + token, 'OMNI SMOKE FAILED: ordinary diagnostic', '::warning::x', '::' + token + '::',
  ])
})
