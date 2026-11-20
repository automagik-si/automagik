import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { kindOf, manifest } from './lane';
import { releasePlugins, tarballOf } from './release-plugins';
import { CHECKOUT_PACKAGES, CHECKOUT_REPOSITORY, sha256, verifyCheckoutDirectory } from '../server/checkout-input.mjs';
import { DEFAULT_PACKAGES } from '../server/fetch-plugins.mjs';

const root = resolve(import.meta.dir, '..');
const vault = '@automagik/vault-dsh';
const revision = 'a'.repeat(40);

test('Vault ships an archive, appears in the desktop lane and is verified without becoming a server default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-release-'));
  try {
    const folder = CHECKOUT_PACKAGES[vault];
    const pkg = JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8'));
    const version = pkg.version;
    const file = tarballOf(vault, version);
    execFileSync(process.execPath, ['pm', 'pack', '--destination', dir], { cwd: join(root, folder), stdio: 'pipe' });
    const archive = readFileSync(join(dir, file));
    const packed = execFileSync('tar', ['-tzf', join(dir, file)], { encoding: 'utf8' });
    expect(packed).toContain('package/src/bw/adapter.js');
    expect(packed).not.toContain('package/test/');
    expect(kindOf([folder + '/package.json'], () => true)).toBe('full');
    const names = Object.keys(CHECKOUT_PACKAGES);
    for (const name of names) if (name !== vault) copyFileSync(join(dir, file), join(dir, tarballOf(name, version)));
    const plugins = releasePlugins(version, revision, dir, names);
    const lane = manifest(plugins, { base: version, issuedAt: '2026-11-19T00:00:00Z', dir, engines: () => pkg.engines.dsh });
    expect(lane.plugins.find(entry => entry.name === vault)).toMatchObject({
      sha256: sha256(archive), size: archive.length, engines: { dsh: pkg.engines.dsh },
    });
    const raw = JSON.stringify(plugins, null, 2) + '\n';
    const digest = sha256(raw);
    writeFileSync(join(dir, 'plugins.json'), raw);
    writeFileSync(join(dir, 'PLUGINS.SHA256SUMS'), [
      `${digest}  plugins.json`,
      ...names.map(name => `${sha256(archive)}  ${tarballOf(name, version)}`),
    ].join('\n') + '\n');
    const options = { kind: 'checkout', event: 'pull_request', revision, version, manifest: digest, repository: CHECKOUT_REPOSITORY };
    const verified = verifyCheckoutDirectory(dir, options);
    expect(verified.assets.has(file)).toBe(true);
    expect(Object.keys(verified.plugins).sort()).toEqual([...DEFAULT_PACKAGES].sort());
    expect(verified.plugins).not.toHaveProperty(vault);
    writeFileSync(join(dir, file), Buffer.alloc(archive.length));
    expect(() => verifyCheckoutDirectory(dir, options)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
