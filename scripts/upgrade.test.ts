import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  backupDirName,
  compareVersions,
  DEFAULTS,
  deepEqual,
  deepSubset,
  handEditViolations,
  normalizeVersion,
  parseChecksums,
  pluginsLeftAlone,
  pluginsToInstall,
  resultLine,
  runtimeAssetName,
  subscriptionsDisabled,
  subscriptionsPatchPresent,
  tagOf,
  utcStamp,
} from './upgrade';

const PATCH = `# the user layer: hand edits that an upgrade must never drop
- insert:
    - id: web-search-auto
      name: '@automagik/bots-dsh/web-search'
- id: web
  config:
    searchProvider: auto
- id: dsh-subscriptions
  disabled: true
- id: omni-ai
  name: "@automagik/welcome-dsh"
  config:
    teamDone: true
- id: plugin-market
  config:
    indexes:
      - https://one.example/index.json
      - https://two.example/index.json
`;

const COMPOSED = `# == @deepseek-ai/dsh-base
- id: web-search-auto
  name: '@automagik/bots-dsh/web-search'
  disabled: true
- id: web
  name: '@deepseek-ai/dsh-web-app'
  config:
    searchProvider: auto
    fetchProvider: http
- id: dsh-subscriptions
  name: '@goodandready/dsh-subscriptions'
  config: {}
  disabled: true
- id: omni-ai
  name: "@automagik/welcome-dsh"
  config:
    teamDone: true
    companionDone: true
- id: plugin-market
  config:
    indexes:
      - https://one.example/index.json
      - https://two.example/index.json
`;

describe('release version handling', () => {
  test('normalizes a v3.N.P tag and refuses anything else', () => {
    expect(normalizeVersion('v3.49.0')).toBe('3.49.0');
    expect(normalizeVersion('3.49.0')).toBe('3.49.0');
    expect(tagOf('3.49.0')).toBe('v3.49.0');
    expect(() => normalizeVersion('v3.49')).toThrow(/not a release version/);
  });

  test('orders releases so a downgrade is refused', () => {
    expect(compareVersions('3.48.0', '3.49.0')).toBeLessThan(0);
    expect(compareVersions('3.49.0', '3.49.0')).toBe(0);
    expect(compareVersions('3.50.0', '3.49.0')).toBeGreaterThan(0);
    expect(compareVersions('3.49.1', '3.49.0')).toBeGreaterThan(0);
  });

  test('names a timestamped backup directory without ever reusing it', () => {
    expect(backupDirName('3.49.0', utcStamp(new Date('2026-10-30T01:05:09Z')))).toBe('upgrade-3.49.0-20261030-010509Z');
  });
});

describe('host defaults', () => {
  test('start at the home directory and keep every folder relative to it', () => {
    const home = homedir();
    expect(DEFAULTS.automagikHome).toBe(join(home, 'prod', 'automagik'));
    expect(DEFAULTS.dshHome).toBe(join(home, '.automagik', 'web', 'dsh'));
    expect(DEFAULTS.backupRoot).toBe(join(home, 'prod', 'automagik', 'backups'));
    expect(relative(home, DEFAULTS.automagikHome).split(sep)).toEqual(['prod', 'automagik']);
    expect(relative(home, DEFAULTS.dshHome).split(sep)).toEqual(['.automagik', 'web', 'dsh']);
    expect(relative(home, DEFAULTS.backupRoot).split(sep)).toEqual(['prod', 'automagik', 'backups']);
  });
});

describe('PLUGINS.SHA256SUMS', () => {
  test('maps a file to its sha256 and ignores comments and blanks', () => {
    const sums = parseChecksums([
      '# release 3.49.0',
      `${'a'.repeat(64)}  automagik-bots-dsh-3.49.0.tgz`,
      `${'b'.repeat(64)} *automagik-welcome-dsh-3.49.0.tgz`,
      '',
    ].join('\n'));
    expect(sums.get('automagik-bots-dsh-3.49.0.tgz')).toBe('a'.repeat(64));
    expect(sums.get('automagik-welcome-dsh-3.49.0.tgz')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
  });
});

describe("a release's tarballs", () => {
  const release = {
    repository: 'https://github.com/automagik-si/automagik',
    version: '3.49.0',
    commit: 'c'.repeat(40),
    packages: {
      '@automagik/bots-dsh': { version: '3.49.0', file: 'automagik-bots-dsh-3.49.0.tgz', integrity: 'sha512-a', size: 1 },
      '@automagik/locale-pt-br-dsh': { version: '3.49.0', file: 'automagik-locale-pt-br-dsh-3.49.0.tgz', integrity: 'sha512-b', size: 1 },
      '@automagik/acp-dsh': { version: '3.49.0', file: 'automagik-acp-dsh-3.49.0.tgz', integrity: 'sha512-c', size: 1 },
    },
  };

  test('re-adds exactly the release tarballs this profile already installs', () => {
    const dependencies = {
      '@automagik/bots-dsh': 'file:/old/automagik-bots-dsh-3.41.0.tgz',
      '@automagik/locale-pt-br-dsh': 'github:automagik-dev/automagik#abc&path:/apps/locale-pt-br-dsh',
      '@goodandready/dsh-subscriptions': 'github:automagik-genie/dsh-subscriptions#def',
    };
    expect(pluginsToInstall(release, dependencies).map((plugin) => plugin.name)).toEqual(['@automagik/bots-dsh', '@automagik/locale-pt-br-dsh']);
    expect(pluginsLeftAlone(release, dependencies)).toEqual(['@automagik/acp-dsh']);
  });

  test('re-adds the installed desktop plugin and leaves server adapter upgrades to the image', () => {
    const adapter = '@automagik/multiuser-dsh';
    const incoming = { ...release, packages: {
      ...release.packages,
      [adapter]: { version: release.version, file: 'automagik-multiuser-dsh.tgz', integrity: 'sha512-d', size: 1 },
    } };
    expect(pluginsToInstall(incoming, { [adapter]: 'file:adapter.tgz', '@automagik/bots-dsh': 'file:bots.tgz' })
      .map(plugin => plugin.name)).toEqual(['@automagik/bots-dsh']);
  });

  test('finds a runtime asset only when a release really carries one', () => {
    expect(runtimeAssetName([{ name: 'automagik-runtime-3.50.0.tgz', size: 1 }])).toBe('automagik-runtime-3.50.0.tgz');
    expect(runtimeAssetName([{ name: 'Automagik-3.49.0-linux-x86_64.AppImage', size: 1 }])).toBeUndefined();
    expect(runtimeAssetName([])).toBeUndefined();
  });
});

describe('patch subset checks', () => {
  test('objects merge, arrays replace', () => {
    expect(deepSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(deepSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepSubset({ list: [1, 2] }, { list: [1, 2] })).toBe(true);
    expect(deepSubset({ list: [1] }, { list: [1, 2] })).toBe(false);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  });
});

describe('hand edits in cordis.patch.yml', () => {
  test('a composed tree that keeps every edit has no violations', () => {
    expect(handEditViolations(PATCH, COMPOSED)).toEqual([]);
  });

  test('fails loudly when the subscriptions disable block is lost', () => {
    const lost = COMPOSED.replace('  config: {}\n  disabled: true', '  config: {}');
    const violations = handEditViolations(PATCH, lost);
    expect(violations.join('\n')).toMatch(/dsh-subscriptions/);
    expect(subscriptionsDisabled(lost)).toBe(false);
  });

  test('fails loudly when any other hand edit is lost', () => {
    const omitted = COMPOSED.replace(/- id: omni-ai[\s\S]*?companionDone: true\n/, '');
    expect(handEditViolations(PATCH, omitted).join('\n')).toMatch(/omni-ai is missing/);
    const reordered = COMPOSED.replace('      - https://one.example/index.json\n      - https://two.example/index.json', '      - https://two.example/index.json\n      - https://one.example/index.json');
    expect(handEditViolations(PATCH, reordered).join('\n')).toMatch(/plugin-market/);
    const droppedInsert = COMPOSED.replace(/- id: web-search-auto[\s\S]*?disabled: true\n/, '');
    expect(handEditViolations(PATCH, droppedInsert).join('\n')).toMatch(/insert web-search-auto is missing/);
  });

  test('recognizes the disabled block in the patch itself', () => {
    expect(subscriptionsPatchPresent(PATCH)).toBe(true);
    expect(subscriptionsPatchPresent(PATCH.replace(/  disabled: true\n/, ''))).toBe(false);
    expect(subscriptionsDisabled(COMPOSED)).toBe(true);
  });
});

describe('the RESULT line', () => {
  test('is one line and keeps the error greppable', () => {
    const line = resultLine('FAILED', { target: '3.49.0', error: 'pnpm add failed', backup: '/backups/upgrade-3.49.0-20261030-010509Z' });
    expect(line).toBe('RESULT: FAILED target=3.49.0 error=pnpm_add_failed backup=/backups/upgrade-3.49.0-20261030-010509Z');
    expect(line.split('\n')).toHaveLength(1);
  });
});
