// Run under the same exclusive gate lock as the tests: each mutant is always restored.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const accessSource = new URL('../src/host/agent-access.js', import.meta.url)
const mutants = [
  {
    name: 'accept a revoked token',
    from: " || identity.revokedAt !== undefined",
    to: '',
    alsoFrom: 'current.revokedAt !== undefined',
    alsoTo: 'false',
    test: 'token create stores only hash; revoke immediately refuses the token',
  },
  {
    name: 'skip the audit on refusal',
    from: "await audit({ ...entry, outcome: 'refused', reason })",
    to: '// mutant: refusal is not audited',
    test: 'refusal audit records missing, wrong, revoked, unknown and invalid calls',
  },
  {
    name: 'log the raw token',
    from: 'const hash = digest(candidate)',
    to: `await appendFile(auditPath(), JSON.stringify({ rawToken: candidate }) + '\\n')
    const hash = digest(candidate)`,
    test: 'no raw token or secret values in responses or audit, including pasted config',
  },
  {
    name: 'redactor ignores provider keys',
    source: '../src/host/agent-redaction.js',
    from: 'if (credentials?.resolve) {',
    to: 'if (false && credentials?.resolve) {',
    file: 'test/agent-redaction.test.js',
    test: 'provider credentials in chat, configuration, arguments and audit are redacted',
  },
  {
    name: 'cursor falls back to offset',
    source: '../src/host/agent-space.js',
    from: `next = Number.isSafeInteger(seq) ? { ...window, afterSeq: seq,
        offset: text.slice(0, offset + limit).filter(item => item.seq === seq).length }
        : { ...window, offset: offset + limit }`,
    to: 'next = { ...underlying, offset: offset + limit }',
    file: 'test/agent-paging.test.js',
    test: 'Bot subpages retain their sequence window when a new message arrives',
  },
  {
    name: 'drop the URL-password rule',
    source: '../src/host/agent-redaction.js',
    from: 'const password = urlPassword(value)',
    to: 'const password = undefined',
    file: 'test/agent-redaction.test.js',
    test: 'environment AUTOMAGIK_REVIEW_ENDPOINT is redacted across SDK reads, arguments and audit',
  },
  {
    name: 'require a boundary before full credential words',
    source: '../src/host/agent-redaction.js',
    from: 'longSecretEnv.test(name)',
    to: 'false',
    file: 'test/agent-redaction.test.js',
    test: 'environment PGPASSWORD is redacted across SDK reads, arguments and audit',
  },
]
for (const mutant of mutants) {
  const source = new URL(mutant.source ?? accessSource.href, import.meta.url)
  const original = readFileSync(source, 'utf8')
  try {
    assert.ok(original.includes(mutant.from), `${mutant.name}: mutation site missing`)
    let changed = original.replace(mutant.from, mutant.to)
    if (mutant.alsoFrom) changed = changed.replaceAll(mutant.alsoFrom, mutant.alsoTo)
    writeFileSync(source, changed)
    const result = spawnSync(process.execPath, ['--import', './test/harness-resolve.mjs',
      '--test', '--test-reporter=tap', `--test-name-pattern=${mutant.test}`,
      mutant.file ?? 'test/agent-access.test.js'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      timeout: 60000 })
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    assert.ok(result.status !== null && result.status !== 0 && /not ok/.test(output)
      && /AssertionError/.test(output), `${mutant.name}: no assertion killed mutant`)
    console.log(output)
    console.log(`KILLED: ${mutant.name} — ${mutant.test}`)
  } finally {
    writeFileSync(source, original)
  }
}
