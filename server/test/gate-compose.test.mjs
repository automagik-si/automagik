import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { dirname } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const FILE = fileURLToPath(new URL('../compose.gate.yml', import.meta.url))

function parseCompose(source, flags = []) {
  return JSON.parse(execFileSync('docker', [
    'compose', '--env-file', devNull, '--project-name', 'automagik-gate-contract',
    '--project-directory', dirname(FILE), '--profile', 'gate', '--file', '-',
    'config', '--format', 'json', ...flags,
  ], {
    input: source,
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOMAGIK_SERVER_IMAGE: 'automagik-server:contract-test',
      AUTOMAGIK_GATE_ENABLED: '1',
      AUTOMAGIK_GATE_ORIGIN: 'https://workspace.invalid',
      AUTOMAGIK_GATE_ACCESS_TEAM_DOMAIN: '',
      AUTOMAGIK_GATE_ACCESS_AUD: '',
      AUTOMAGIK_GATE_ACCESS_EMAILS: '',
      AUTOMAGIK_GATE_CLOUD_ISSUER: '',
      AUTOMAGIK_GATE_CLOUD_IDENTITY_ISSUER: '',
      AUTOMAGIK_GATE_CLOUD_WORKSPACE: '',
      AUTOMAGIK_GATE_CLOUD_KEYS_URL: '',
      AUTOMAGIK_GATE_CLOUD_EXCHANGE_URL: '',
      AUTOMAGIK_GATE_CLOUD_RAIL_ORIGIN: '',
      AUTOMAGIK_GATE_CLOUD_REVOCATION_URL: '',
      // Resolve a pass-through public URL even if the developer's environment has none.
      AUTOMAGIK_PUBLIC_URL: 'https://public.invalid/',
    },
  }))
}

// Named mutants: DSH_PUBLIC_URL_MAP, DSH_PUBLIC_URL_PASSTHROUGH, DSH_TRUSTED_HOST_MAP,
// DSH_TRUSTED_HOST_PASSTHROUGH, DSH_TRUSTED_HOST_COMMAND and DSH_PUBLISHED_PORT.
test('the gated Compose DSH service has no public URL, trusted host or published port', () => {
  const source = readFileSync(FILE, 'utf8')
  // Raw parsing retains even unset list entries. Rendering also catches env_file/merges.
  for (const config of [parseCompose(source, ['--no-interpolate']), parseCompose(source)]) {
    const dsh = config.services?.dsh
    assert.ok(dsh, 'Compose must define the DSH service')
    const environment = dsh.environment ?? {}
    const names = Array.isArray(environment)
      ? environment.map(entry => entry.split('=', 1)[0])
      : Object.keys(environment)
    assert.ok(!names.includes('AUTOMAGIK_PUBLIC_URL'), 'dsh must not receive AUTOMAGIK_PUBLIC_URL')
    assert.ok(!names.some(name => /trustedhosts?/i.test(name.replace(/[^a-z0-9]/gi, ''))),
      'dsh must not receive a trusted-host environment setting')
    assert.ok(!/--trusted[-_]hosts?\b/i.test(JSON.stringify([dsh.command, dsh.entrypoint, environment])),
      'dsh must not receive a trusted-host argument')
    assert.equal(dsh.ports?.length ?? 0, 0, 'dsh must not publish a port')
  }
})
