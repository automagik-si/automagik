import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginNames, releasePlugins, unshipped, tarballOf } from './release-plugins';

const root = join(import.meta.dir, '..');

describe("a release's plugins.json", () => {
  test('lists this repository\'s plugins, and none of Unfold\'s', () => {
    expect(pluginNames()).toEqual(['@automagik/acp-dsh', '@automagik/bots-dsh', '@automagik/locale-pt-br-dsh', '@automagik/vault-dsh', '@automagik/welcome-dsh']);
    // No Unfold folder is left here (RFC 0020): Unfold's own release ships them, and this
    // repository's releases never attach one.
    expect(pluginNames().filter(unshipped)).toEqual([]);
    expect(tarballOf('@automagik/bots-dsh', '3.261024.1')).toBe('automagik-bots-dsh-3.261024.1.tgz');
  });

  test('no Unfold folder is left under apps/, and the name guard keeps one out if it came back', () => {
    expect(readdirSync(join(root, 'apps')).filter((name) => name.startsWith('unfold-'))).toEqual([]);
    expect(unshipped('@automagik/unfold-bridge-dsh')).toBe(true);
    expect(unshipped('@automagik/bots-dsh')).toBe(false);
    const back = mkdtempSync(join(tmpdir(), 'release-plugins-unfold-'));
    try {
      for (const folder of ['bots-dsh', 'unfold-bridge-dsh']) {
        mkdirSync(join(back, 'apps', folder), { recursive: true });
        writeFileSync(join(back, 'apps', folder, 'package.json'), JSON.stringify({ name: `@automagik/${folder}`, version: '1.0.0' }));
      }
      expect(pluginNames(back)).toEqual(['@automagik/bots-dsh']);
    } finally {
      rmSync(back, { recursive: true, force: true });
    }
  });

  test('carries each tarball\'s integrity, as npm computes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automagik-release-'));
    writeFileSync(join(dir, 'automagik-bots-dsh-3.261024.1.tgz'), 'team');
    writeFileSync(join(dir, 'automagik-welcome-dsh-3.261024.1.tgz'), 'welcome');
    const commit = 'a'.repeat(40);
    const plugins = releasePlugins('3.261024.1', commit, dir, ['@automagik/bots-dsh', '@automagik/welcome-dsh']);
    expect(plugins.repository).toBe('https://github.com/automagik-si/automagik');
    expect(plugins.commit).toBe(commit);
    expect(plugins.packages['@automagik/bots-dsh']).toEqual({
      version: '3.261024.1',
      file: 'automagik-bots-dsh-3.261024.1.tgz',
      integrity: `sha512-${createHash('sha512').update('team').digest('base64')}`,
      size: 4,
    });
    expect(() => releasePlugins('3.261024.2', commit, dir, ['@automagik/bots-dsh'])).toThrow(/has no automagik-bots-dsh-3\.261024\.2\.tgz/);
    expect(() => releasePlugins('3.261024.1', 'main', dir, [])).toThrow(/not a commit/);
  });
});
