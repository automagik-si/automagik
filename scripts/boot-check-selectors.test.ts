import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// boot-check.mjs waits for parts of the page to show (the welcome's stage, the Bot team's rows,
// the Connect AI list). A part renamed in a client would leave it waiting for something no client
// draws: it fails CI's boot, or worse, passes through a stale alternative while the part it meant
// is gone. So every class it waits on must be drawn by a client source, as a className.
const ROOT = join(import.meta.dir, '..');
const APPS = join(ROOT, 'apps');
const script = readFileSync(join(ROOT, 'scripts', 'boot-check.mjs'), 'utf8');

const waited = [...script.matchAll(/locator\('([^']+)'\)(?:\.first\(\))?\.waitFor/g)].map((match) => match[1]);
const classes = [...new Set(waited.flatMap((selector) => [...selector.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1])))].sort();

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'vendor' || name === 'node_modules') return [];
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.js') ? [path] : [];
  });
}
const clients = readdirSync(APPS)
  .map((app) => join(APPS, app, 'src', 'client'))
  .filter((dir) => existsSync(dir))
  .flatMap(sources)
  .map((path) => readFileSync(path, 'utf8'));
// Drawn means set as a className (a string, a template or classes(...)), not only styled.
const drawn = (name: string) => clients.some((text) => new RegExp(`className:[^,}]*['\`(\\s]${name}(?![a-z0-9-])`).test(text));

describe('boot-check waits only for what a client draws', () => {
  test('it waits for the welcome, the team rows and the Connect AI list', () => {
    expect(waited.length).toBeGreaterThanOrEqual(4);
    expect(classes).toEqual(expect.arrayContaining(['oai-stage', 'lb-row', 'oai-acp']));
  });

  test('every onboarding step it marks done is one the welcome knows', () => {
    const steps = JSON.parse(script.match(/const DONE_STEPS = (\[[^\]]*\])/)![1].replaceAll("'", '"'));
    const host = readFileSync(join(APPS, 'welcome-dsh', 'src', 'host', 'endpoint.js'), 'utf8');
    const flags = Object.keys(JSON.parse(host.match(/export const FLAGS = (\{[^}]*\})/)![1].replaceAll("'", '"')));
    expect([...steps].sort()).toEqual([...flags].sort());
  });

  for (const name of classes) {
    test(`.${name} is drawn by a client`, () => {
      expect(drawn(name)).toBe(true);
    });
  }

  test('a class no client draws is caught', () => {
    expect(drawn('oa-stage')).toBe(false);
    expect(drawn('bt-tile')).toBe(false);
  });
});
