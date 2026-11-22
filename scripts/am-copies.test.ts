import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, WRITE, POCKET_SOURCE, POCKET_TARGET, copies, problems, write } from './am-copies.mjs';

// am/ carries byte-equal copies of the pack's CLI and briefing (RFC 0012); herdr PRs keep changing
// them, so a drift must say how to resync.
describe("am's copies of the pack's CLI and briefing", () => {
  test('match herdr/mods/am-sidebar byte for byte', () => {
    const found = problems();
    if (found.length) throw new Error(`${found.join('\n')}\nRun \`${WRITE}\` and commit am/.`);
    expect(found).toEqual([]);
  });

  test('cover the CLI, the briefing, run.sh and the trust anchors', () => {
    const to = copies().map(([, target]) => target);
    for (const file of ['am/bin/automagik-herdr.mjs', 'am/bin/automagik-herdr', 'am/bin/run.sh', 'am/briefing.mjs', 'am/briefingEntry.mjs',
      'am/model.js', 'am/update.mjs', 'am/pack-keys.json', 'am/plugin-lane-keys.json']) expect(to).toContain(file);
  });

  test('a drifted, missing or stale copy is named, and --write repairs it', () => {
    const root = mkdtempSync(join(tmpdir(), 'am-copies-'));
    try {
      for (const dir of ['am', 'herdr/mods/am-sidebar', POCKET_SOURCE, 'plugin-lane']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
      writeFileSync(join(root, 'am', 'model.js'), '// drifted\n');
      rmSync(join(root, 'am', 'tidy.js'));
      // A copy --write once made that nothing imports now (the CLI dropped it): stale.
      const record = JSON.parse(readFileSync(join(root, 'am', 'copies.json'), 'utf8'));
      record.files.push({ from: 'herdr/mods/am-sidebar/gone.js', to: 'am/gone.js' });
      writeFileSync(join(root, 'am', 'copies.json'), `${JSON.stringify(record, null, 2)}\n`);
      writeFileSync(join(root, 'am', 'gone.js'), '// gone\n');
      writeFileSync(join(root, POCKET_TARGET, 'bridge', 'bridge.mjs'), '// drifted\n');
      rmSync(join(root, POCKET_TARGET, 'chat', 'package.json'));
      const stale = `${POCKET_TARGET}/bridge/gone.mjs`;
      record.files.push({ from: `${POCKET_SOURCE}/bridge/gone.mjs`, to: stale });
      writeFileSync(join(root, 'am', 'copies.json'), `${JSON.stringify(record, null, 2)}\n`);
      writeFileSync(join(root, stale), '// gone\n');
      const found = problems(root);
      expect(found).toContain(`${POCKET_TARGET}/bridge/bridge.mjs differs from ${POCKET_SOURCE}/bridge/bridge.mjs`);
      expect(found).toContain(`${POCKET_TARGET}/chat/package.json is missing (a copy of ${POCKET_SOURCE}/chat/package.json)`);
      expect(found).toContain(`${stale} is a stale copy: nothing am copies imports it now`);
      expect(found).toContain('am/model.js differs from herdr/mods/am-sidebar/model.js');
      expect(found).toContain('am/tidy.js is missing (a copy of herdr/mods/am-sidebar/tidy.js)');
      expect(found).toContain('am/gone.js is a stale copy: nothing am copies imports it now');
      write(root);
      expect(problems(root)).toEqual([]);
      expect(existsSync(join(root, 'am', 'gone.js'))).toBe(false);
      expect(existsSync(join(root, stale))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
